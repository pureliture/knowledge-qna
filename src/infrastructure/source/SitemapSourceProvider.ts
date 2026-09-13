/**
 * SitemapSourceProvider
 * Infrastructure implementation of SourceProvider port for sitemap and static sources.
 * Adheres to Gate T-02: sitemap index recursion (depth limit 5), cycle detection,
 * 1,000 document limit, 10 MiB sitemap size limit, and allowed hosts/paths enforcement.
 * Strict Layer Boundary: Infrastructure imports only domain and application/ports.
 */

import * as cheerio from 'cheerio';
import type {
  SourceProvider,
  DiscoveredUrl,
  DiscoveryResult,
  DiscoverySummary,
} from '../../application/ports/SourceProvider.js';
import type { VersionSource } from '../../domain/models/index.js';
import { CliOperationError } from '../../domain/errors.js';
import { UrlNormalizer } from './UrlNormalizer.js';
import { SsrfValidator } from '../fetch/SsrfValidator.js';
import { RobotsParser } from './RobotsParser.js';

export type SitemapFetchFn = (url: string, signal?: AbortSignal) => Promise<string>;

export interface SitemapSourceProviderConfig {
  ssrfValidator?: SsrfValidator;
  fetchFn?: SitemapFetchFn;
  customFetch?: typeof fetch;
}

const MAX_RECURSION_DEPTH = 5;
const MAX_DOCUMENT_LIMIT = 1000;
const MAX_SITEMAP_SIZE_BYTES = 10 * 1024 * 1024; // 10 MiB

export class SitemapSourceProvider implements SourceProvider {
  private readonly ssrfValidator: SsrfValidator;
  private readonly fetchFn?: SitemapFetchFn;
  private readonly customFetch?: typeof fetch;
  private readonly robotsCache = new Map<string, RobotsParser>();

  constructor(config: SitemapSourceProviderConfig = {}) {
    this.ssrfValidator = config.ssrfValidator ?? new SsrfValidator();
    this.fetchFn = config.fetchFn;
    this.customFetch = config.customFetch;
  }

  async discover(source: VersionSource, signal?: AbortSignal): Promise<DiscoveryResult> {
    if (source.type === 'static') {
      return this.discoverStatic(source, signal);
    }

    if (source.type === 'sitemap') {
      return this.discoverSitemap(source, signal);
    }

    throw new CliOperationError({
      code: 'UNSUPPORTED_SOURCE',
      message: `Unsupported source type: '${(source as { type: string }).type}'`,
    });
  }

  private async getRobotsParser(
    origin: string,
    source: VersionSource,
    signal?: AbortSignal,
  ): Promise<RobotsParser> {
    if (this.robotsCache.has(origin)) {
      return this.robotsCache.get(origin)!;
    }

    const robotsUrl = `${origin}/robots.txt`;
    let content = '';

    try {
      if (this.fetchFn) {
        content = await this.fetchFn(robotsUrl, signal);
      } else {
        content = await this.fetchSitemapXml(robotsUrl, source, signal);
      }
    } catch {
      // RFC 9309: When robots.txt is 404 or inaccessible, assume full access allowed
      content = '';
    }

    const parser = RobotsParser.parse(content);
    this.robotsCache.set(origin, parser);
    return parser;
  }

  /**
   * Discovers URLs from static source configuration.
   */
  private async discoverStatic(
    source: VersionSource,
    signal?: AbortSignal,
  ): Promise<DiscoveryResult> {
    if (signal?.aborted) {
      return {
        urls: [],
        summary: {
          complete: false,
          totalDiscovered: 0,
          sitemapsProcessed: 0,
          depthReached: 0,
          aborted: true,
          incompleteReason: 'ABORTED',
        },
      };
    }

    const rawUrls = source.urls ?? [];
    const discoveredMap = new Map<string, DiscoveredUrl>();
    const errors: Array<{ url: string; message: string }> = [];

    for (const rawUrl of rawUrls) {
      if (signal?.aborted) break;

      try {
        const normalized = UrlNormalizer.normalize(rawUrl, {
          canonicalQueryKeys: source.canonicalQueryKeys,
          allowedHosts: source.allowedHosts,
          allowHttp: source.allowHttp,
        });

        const parsed = new URL(normalized);
        const pathAllowed = UrlNormalizer.isPathAllowed(
          parsed.pathname,
          source.includePaths,
          source.excludePaths,
        );

        if (!pathAllowed) {
          continue;
        }

        const robots = await this.getRobotsParser(parsed.origin, source, signal);
        const robotsAllowed = robots.isAllowed(normalized);

        if (!robotsAllowed) {
          errors.push({ url: normalized, message: 'Disallowed by robots.txt' });
          continue;
        }

        if (!discoveredMap.has(normalized)) {
          discoveredMap.set(normalized, { url: normalized });
        }
      } catch {
        // Skip invalid or disallowed URLs in static list
        continue;
      }
    }

    const urls = Array.from(discoveredMap.values());

    if (urls.length === 0) {
      throw new CliOperationError({
        code: 'SOURCE_EMPTY',
        message: 'No valid URLs discovered in static source.',
      });
    }

    return {
      urls,
      summary: {
        complete: true,
        totalDiscovered: urls.length,
        sitemapsProcessed: 0,
        depthReached: 0,
        aborted: false,
        errors: errors.length > 0 ? errors : undefined,
      },
    };
  }

  /**
   * Discovers URLs from sitemap sources with nested sitemap index recursion,
   * cycle detection, depth limit 5, and 1,000 document limit (Gate T-02).
   */
  private async discoverSitemap(
    source: VersionSource,
    signal?: AbortSignal,
  ): Promise<DiscoveryResult> {
    const sitemapQueue: Array<{ url: string; depth: number }> = [];
    const visitedSitemaps = new Set<string>();
    const discoveredDocs = new Map<string, DiscoveredUrl>();
    const errors: Array<{ url: string; message: string }> = [];

    let depthReached = 0;
    let sitemapsProcessed = 0;
    let complete = true;
    let incompleteReason: DiscoverySummary['incompleteReason'];

    // Enqueue initial sitemaps
    const initialUrls = source.sitemapUrls ?? [];
    if (initialUrls.length === 0) {
      throw new CliOperationError({
        code: 'SOURCE_EMPTY',
        message: 'No sitemap URLs specified in source configuration.',
      });
    }

    for (const rawSitemapUrl of initialUrls) {
      try {
        const normalized = UrlNormalizer.normalize(rawSitemapUrl, {
          allowHttp: source.allowHttp,
          allowedHosts: source.allowedHosts,
        });
        sitemapQueue.push({ url: normalized, depth: 0 });
      } catch (err) {
        errors.push({
          url: rawSitemapUrl,
          message: `Invalid initial sitemap URL: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    while (sitemapQueue.length > 0) {
      if (signal?.aborted) {
        complete = false;
        incompleteReason = 'ABORTED';
        break;
      }

      const item = sitemapQueue.shift()!;
      depthReached = Math.max(depthReached, item.depth);

      // Cycle detection
      if (visitedSitemaps.has(item.url)) {
        continue;
      }
      visitedSitemaps.add(item.url);

      // Fetch sitemap XML content
      let xmlContent: string;
      try {
        xmlContent = await this.fetchSitemapXml(item.url, source, signal);
        sitemapsProcessed++;
      } catch (err) {
        errors.push({
          url: item.url,
          message: `Failed to fetch sitemap: ${err instanceof Error ? err.message : String(err)}`,
        });
        complete = false;
        incompleteReason = 'SITEMAP_PARSE_ERROR';
        continue;
      }

      // Check sitemap size
      if (Buffer.byteLength(xmlContent, 'utf-8') > MAX_SITEMAP_SIZE_BYTES) {
        errors.push({
          url: item.url,
          message: `Sitemap exceeded maximum allowable size of 10 MiB (${MAX_SITEMAP_SIZE_BYTES} bytes).`,
        });
        complete = false;
        incompleteReason = 'SITEMAP_PARSE_ERROR';
        continue;
      }

      // Parse with Cheerio in XML mode
      let $: cheerio.CheerioAPI;
      try {
        $ = cheerio.load(xmlContent, { xmlMode: true });
      } catch (err) {
        errors.push({
          url: item.url,
          message: `XML parse failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        complete = false;
        incompleteReason = 'SITEMAP_PARSE_ERROR';
        continue;
      }

      // 1. Check if <sitemapindex>
      const sitemapElements = $('sitemapindex > sitemap');
      if (sitemapElements.length > 0) {
        for (const el of sitemapElements.toArray()) {
          const loc = $(el).find('loc').text().trim();
          if (!loc) continue;

          try {
            const childUrl = UrlNormalizer.normalize(loc, {
              allowHttp: source.allowHttp,
              allowedHosts: source.allowedHosts,
            });

            const nextDepth = item.depth + 1;
            depthReached = Math.max(depthReached, nextDepth);

            if (nextDepth > MAX_RECURSION_DEPTH) {
              complete = false;
              incompleteReason = 'DEPTH_LIMIT_EXCEEDED';
              continue;
            }

            if (!visitedSitemaps.has(childUrl)) {
              sitemapQueue.push({ url: childUrl, depth: nextDepth });
            }
          } catch {
            // Ignore invalid child sitemap URLs or add to errors
          }
        }
      }

      // 2. Check if <urlset>
      const urlElements = $('urlset > url');
      if (urlElements.length > 0) {
        for (const el of urlElements.toArray()) {
          if (discoveredDocs.size >= MAX_DOCUMENT_LIMIT) {
            complete = false;
            incompleteReason = 'DOCUMENT_LIMIT_EXCEEDED';
            break;
          }

          const loc = $(el).find('loc').text().trim();
          if (!loc) continue;

          try {
            const normalizedDocUrl = UrlNormalizer.normalize(loc, {
              canonicalQueryKeys: source.canonicalQueryKeys,
              allowedHosts: source.allowedHosts,
              allowHttp: source.allowHttp,
            });

            const parsed = new URL(normalizedDocUrl);
            const pathAllowed = UrlNormalizer.isPathAllowed(
              parsed.pathname,
              source.includePaths,
              source.excludePaths,
            );

            if (!pathAllowed) {
              continue;
            }

            const robots = await this.getRobotsParser(parsed.origin, source, signal);
            const robotsAllowed = robots.isAllowed(normalizedDocUrl);

            if (!robotsAllowed) {
              errors.push({ url: normalizedDocUrl, message: 'Disallowed by robots.txt' });
              continue;
            }

            if (!discoveredDocs.has(normalizedDocUrl)) {
              const lastmod = $(el).find('lastmod').text().trim() || undefined;
              const changefreq = $(el).find('changefreq').text().trim() || undefined;
              const priorityStr = $(el).find('priority').text().trim();
              const priority = priorityStr ? parseFloat(priorityStr) : undefined;

              discoveredDocs.set(normalizedDocUrl, {
                url: normalizedDocUrl,
                lastModified: lastmod,
                changeFreq: changefreq,
                priority: isNaN(priority as number) ? undefined : priority,
              });
            }
          } catch {
            // Disallowed or invalid document URL in sitemap
          }
        }
      }

      if (discoveredDocs.size >= MAX_DOCUMENT_LIMIT) {
        complete = false;
        incompleteReason = 'DOCUMENT_LIMIT_EXCEEDED';
        break;
      }
    }

    const urls = Array.from(discoveredDocs.values());

    if (urls.length === 0 && complete) {
      throw new CliOperationError({
        code: 'SOURCE_EMPTY',
        message: 'No valid URLs discovered in sitemap.',
      });
    }

    return {
      urls,
      summary: {
        complete,
        totalDiscovered: urls.length,
        sitemapsProcessed,
        depthReached,
        aborted: signal?.aborted ?? false,
        incompleteReason,
        errors: errors.length > 0 ? errors : undefined,
      },
    };
  }

  private async fetchSitemapXml(
    sitemapUrl: string,
    source: VersionSource,
    signal?: AbortSignal,
  ): Promise<string> {
    if (this.fetchFn) {
      return this.fetchFn(sitemapUrl, signal);
    }

    let currentUrl = sitemapUrl;
    let redirectCount = 0;
    const maxRedirects = 5;
    const fetchImpl = this.customFetch ?? fetch;

    while (true) {
      // Validate SSRF for current URL
      await this.ssrfValidator.validate(currentUrl, {
        allowedHosts: source.allowedHosts,
        allowHttp: source.allowHttp,
      });

      const res = await fetchImpl(currentUrl, {
        signal,
        headers: {
          'User-Agent': 'docsctx/0.1.0',
          Accept: 'application/xml, text/xml, */*',
        },
        redirect: 'manual',
      });

      // Handle redirects (301, 302, 303, 307, 308)
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        redirectCount++;
        if (redirectCount > maxRedirects) {
          throw new CliOperationError({
            code: 'SOURCE_FETCH_FAILED',
            message: `Maximum redirect limit of ${maxRedirects} exceeded for sitemap '${sitemapUrl}'.`,
          });
        }

        const locationHeader = res.headers.get('location');
        if (!locationHeader) {
          throw new CliOperationError({
            code: 'SOURCE_FETCH_FAILED',
            message: `Redirect response missing Location header from '${currentUrl}'.`,
          });
        }

        let nextUrl: string;
        try {
          const resolved = new URL(locationHeader, currentUrl);
          nextUrl = UrlNormalizer.normalize(resolved.toString(), {
            allowHttp: source.allowHttp,
            allowedHosts: source.allowedHosts,
          });
        } catch (err) {
          throw new CliOperationError({
            code: 'SOURCE_FETCH_FAILED',
            message: `Invalid redirect location '${locationHeader}' from '${currentUrl}': ${err instanceof Error ? err.message : String(err)}`,
          });
        }

        currentUrl = nextUrl;
        continue;
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      const rawText = await res.text();
      const byteLength = Buffer.byteLength(rawText, 'utf-8');
      if (byteLength > MAX_SITEMAP_SIZE_BYTES) {
        throw new CliOperationError({
          code: 'DOCUMENT_TOO_LARGE',
          message: `Sitemap size (${byteLength} bytes) exceeds maximum limit of ${MAX_SITEMAP_SIZE_BYTES} bytes.`,
        });
      }

      return rawText;
    }
  }
}
