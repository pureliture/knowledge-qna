/**
 * HttpDocumentFetcher
 * Infrastructure implementation of DocumentFetcher port with conditional GET (304),
 * redirect loop & security checks on every hop up to 5 hops, and rawHash calculation.
 * Adheres to Gate T-02 and Gate T-03.
 * Strict Layer Boundary: Infrastructure imports only domain and application/ports.
 */

import type {
  DocumentFetcher,
  FetchRequest,
  FetchResponse,
} from '../../application/ports/DocumentFetcher.js';
import { sha256Hex } from '../../domain/identity.js';
import { CliOperationError } from '../../domain/errors.js';
import { UrlNormalizer } from '../source/UrlNormalizer.js';
import { SsrfValidator } from './SsrfValidator.js';

export interface HttpDocumentFetcherConfig {
  ssrfValidator?: SsrfValidator;
  customFetch?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5 MiB

export class HttpDocumentFetcher implements DocumentFetcher {
  private readonly ssrfValidator: SsrfValidator;
  private readonly fetchImpl: typeof fetch;

  constructor(config: HttpDocumentFetcherConfig = {}) {
    this.ssrfValidator = config.ssrfValidator ?? new SsrfValidator();
    this.fetchImpl = config.customFetch ?? globalThis.fetch;
  }

  async fetch(request: FetchRequest, signal?: AbortSignal): Promise<FetchResponse> {
    const sec = request.security;
    const maxRedirects = sec?.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    const maxSizeBytes = sec?.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    let currentUrl = UrlNormalizer.normalize(request.url, {
      allowHttp: sec?.allowHttp,
      allowedHosts: sec?.allowedHosts,
    });

    // Check initial path
    const parsedInitial = new URL(currentUrl);
    if (sec?.includePaths && !UrlNormalizer.isPathAllowed(parsedInitial.pathname, sec.includePaths, sec.excludePaths)) {
      throw new CliOperationError({
        code: 'SOURCE_FETCH_FAILED',
        message: `URL path '${parsedInitial.pathname}' is not in included paths.`,
      });
    }

    // Check SSRF for initial URL
    await this.ssrfValidator.validate(currentUrl, {
      allowedHosts: sec?.allowedHosts,
      allowHttp: sec?.allowHttp,
    });

    let redirectCount = 0;

    while (true) {
      if (signal?.aborted) {
        throw new CliOperationError({
          code: 'SOURCE_FETCH_FAILED',
          message: 'Fetch aborted by signal.',
        });
      }

      // Build abort controller combining timeout and parent signal
      const timeoutController = new AbortController();
      const timer = setTimeout(() => timeoutController.abort(), timeoutMs);

      const abortHandler = () => timeoutController.abort();
      if (signal) {
        signal.addEventListener('abort', abortHandler, { once: true });
      }

      const headers: Record<string, string> = {
        'User-Agent': 'docsctx/0.1.0',
        Accept: 'text/html, application/xhtml+xml, */*',
      };

      // Only send conditional headers on the first hop (matching requestedUrl)
      if (redirectCount === 0) {
        if (request.eTag) {
          headers['If-None-Match'] = request.eTag;
        }
        if (request.lastModified) {
          headers['If-Modified-Since'] = request.lastModified;
        }
      }

      let res: Response;
      try {
        res = await this.executeFetchWithRetry(
          currentUrl,
          headers,
          timeoutController.signal,
        );
      } finally {
        clearTimeout(timer);
        if (signal) {
          signal.removeEventListener('abort', abortHandler);
        }
      }

      // Handle Redirects (301, 302, 303, 307, 308)
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        redirectCount++;
        if (redirectCount > maxRedirects) {
          throw new CliOperationError({
            code: 'SOURCE_FETCH_FAILED',
            message: `Maximum redirect limit of ${maxRedirects} exceeded for URL '${request.url}'.`,
          });
        }

        const locationHeader = res.headers.get('location');
        if (!locationHeader) {
          throw new CliOperationError({
            code: 'SOURCE_FETCH_FAILED',
            message: `Redirect response missing Location header from '${currentUrl}'.`,
          });
        }

        // Resolve relative location against current URL
        let nextUrl: string;
        try {
          const resolved = new URL(locationHeader, currentUrl);
          nextUrl = UrlNormalizer.normalize(resolved.toString(), {
            allowHttp: sec?.allowHttp,
            allowedHosts: sec?.allowedHosts,
          });
        } catch (err) {
          throw new CliOperationError({
            code: 'SOURCE_FETCH_FAILED',
            message: `Invalid redirect location '${locationHeader}' from '${currentUrl}': ${err instanceof Error ? err.message : String(err)}`,
          });
        }

        // Validate redirected path against include/exclude paths
        const parsedNext = new URL(nextUrl);
        if (sec?.includePaths && !UrlNormalizer.isPathAllowed(parsedNext.pathname, sec.includePaths, sec.excludePaths)) {
          throw new CliOperationError({
            code: 'SOURCE_FETCH_FAILED',
            message: `Redirect to '${nextUrl}' forbidden: path '${parsedNext.pathname}' outside allowed paths.`,
          });
        }

        // Validate SSRF for next hop (allowedHosts, DNS, private IP blocking)
        await this.ssrfValidator.validate(nextUrl, {
          allowedHosts: sec?.allowedHosts,
          allowHttp: sec?.allowHttp,
        });

        currentUrl = nextUrl;
        continue;
      }

      // Handle 304 Not Modified
      if (res.status === 304) {
        return {
          status: 304,
          requestedUrl: request.url,
          fetchedUrl: currentUrl,
          eTag: res.headers.get('etag') ?? request.eTag,
          lastModified: res.headers.get('last-modified') ?? request.lastModified,
          checkedAt: new Date().toISOString(),
        };
      }

      // Handle 404 / 410 (Explicit deletion / not found)
      if (res.status === 404 || res.status === 410) {
        return {
          status: res.status as 404 | 410,
          requestedUrl: request.url,
          fetchedUrl: currentUrl,
          checkedAt: new Date().toISOString(),
        };
      }

      // Handle 401 / 403 (Non-retryable authorization failure)
      if (res.status === 401 || res.status === 403) {
        throw new CliOperationError({
          code: 'SOURCE_FETCH_FAILED',
          retryable: false,
          message: `Access denied (HTTP ${res.status}) for URL '${currentUrl}'.`,
        });
      }

      // Handle 200 OK
      if (res.status === 200) {
        // Check Content-Length header if present
        const clHeader = res.headers.get('content-length');
        if (clHeader) {
          const cl = parseInt(clHeader, 10);
          if (!isNaN(cl) && cl > maxSizeBytes) {
            throw new CliOperationError({
              code: 'DOCUMENT_TOO_LARGE',
              message: `Document size (${cl} bytes) exceeds maximum limit of ${maxSizeBytes} bytes for '${currentUrl}'.`,
            });
          }
        }

        const rawBody = await res.text();
        const byteLength = Buffer.byteLength(rawBody, 'utf-8');
        if (byteLength > maxSizeBytes) {
          throw new CliOperationError({
            code: 'DOCUMENT_TOO_LARGE',
            message: `Document size (${byteLength} bytes) exceeds maximum limit of ${maxSizeBytes} bytes for '${currentUrl}'.`,
          });
        }

        const rawHash = sha256Hex(rawBody);

        return {
          status: 200,
          requestedUrl: request.url,
          fetchedUrl: currentUrl,
          rawBody,
          rawHash,
          contentType: res.headers.get('content-type') ?? undefined,
          eTag: res.headers.get('etag') ?? undefined,
          lastModified: res.headers.get('last-modified') ?? undefined,
          fetchedAt: new Date().toISOString(),
        };
      }

      // Any other unexpected status code
      throw new CliOperationError({
        code: 'SOURCE_FETCH_FAILED',
        message: `HTTP request failed with status ${res.status} (${res.statusText}) for URL '${currentUrl}'.`,
      });
    }
  }

  private async executeFetchWithRetry(
    url: string,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<Response> {
    const maxAttempts = 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await this.fetchImpl(url, {
          method: 'GET',
          headers,
          redirect: 'manual',
          signal,
        });

        // If 429 or 503, retry if attempts remain
        if ((res.status === 429 || res.status === 503) && attempt < maxAttempts) {
          const retryAfter = res.headers.get('retry-after');
          let delayMs = attempt * 100;
          if (retryAfter) {
            const sec = parseInt(retryAfter, 10);
            if (!isNaN(sec) && sec > 0 && sec <= 5) {
              delayMs = sec * 1000;
            }
          }
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        // If 5xx server error, retry if attempts remain
        if (res.status >= 500 && attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 100));
          continue;
        }

        return res;
      } catch (err) {
        lastError = err;
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 100));
        }
      }
    }

    throw new CliOperationError({
      code: 'SOURCE_FETCH_FAILED',
      retryable: true,
      message: `Failed to fetch '${url}' after ${maxAttempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    });
  }
}
