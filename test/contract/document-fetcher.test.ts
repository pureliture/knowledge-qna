import { describe, it, expect } from 'vitest';
import { HttpDocumentFetcher } from '../../src/infrastructure/fetch/HttpDocumentFetcher.js';
import { SsrfValidator } from '../../src/infrastructure/fetch/SsrfValidator.js';
import { CliOperationError } from '../../src/domain/errors.js';
import { sha256Hex } from '../../src/domain/identity.js';

describe('HttpDocumentFetcher Contract Tests (Gate T-03)', () => {
  const publicDns = async () => ['93.184.216.34'];
  const ssrfValidator = new SsrfValidator(publicDns);

  it('handles 200 OK and computes SHA-256 rawHash', async () => {
    const html = '<html><body><h1>Hello World</h1></body></html>';
    const mockFetch: typeof fetch = async () =>
      new Response(html, {
        status: 200,
        headers: {
          'Content-Type': 'text/html',
          ETag: '"etag-123"',
          'Last-Modified': 'Mon, 01 Sep 2026 12:00:00 GMT',
        },
      });

    const fetcher = new HttpDocumentFetcher({ ssrfValidator, customFetch: mockFetch });
    const response = await fetcher.fetch({
      url: 'https://example.com/docs/intro',
      security: {
        allowedHosts: ['example.com'],
        includePaths: ['/docs/**'],
      },
    });

    expect(response.status).toBe(200);
    if (response.status === 200) {
      expect(response.rawBody).toBe(html);
      expect(response.rawHash).toBe(sha256Hex(html));
      expect(response.eTag).toBe('"etag-123"');
      expect(response.lastModified).toBe('Mon, 01 Sep 2026 12:00:00 GMT');
      expect(response.fetchedUrl).toBe('https://example.com/docs/intro');
    }
  });

  it('handles conditional GET 304 Not Modified when ETag matches', async () => {
    const mockFetch: typeof fetch = async (input, init) => {
      const headers = init?.headers as Record<string, string>;
      if (headers['If-None-Match'] === '"etag-123"') {
        return new Response(null, {
          status: 304,
          headers: { ETag: '"etag-123"' },
        });
      }
      return new Response('<html>New Content</html>', { status: 200 });
    };

    const fetcher = new HttpDocumentFetcher({ ssrfValidator, customFetch: mockFetch });
    const response = await fetcher.fetch({
      url: 'https://example.com/docs/intro',
      eTag: '"etag-123"',
      security: {
        allowedHosts: ['example.com'],
        includePaths: ['/docs/**'],
      },
    });

    expect(response.status).toBe(304);
    if (response.status === 304) {
      expect(response.requestedUrl).toBe('https://example.com/docs/intro');
      expect(response.fetchedUrl).toBe('https://example.com/docs/intro');
      expect(response.eTag).toBe('"etag-123"');
      expect(response.checkedAt).toBeDefined();
    }
  });

  it('handles explicit 404 and 410 deletions', async () => {
    const mockFetch404: typeof fetch = async () => new Response(null, { status: 404 });
    const fetcher404 = new HttpDocumentFetcher({ ssrfValidator, customFetch: mockFetch404 });
    const res404 = await fetcher404.fetch({
      url: 'https://example.com/docs/deleted-page',
      security: { allowedHosts: ['example.com'], includePaths: ['/docs/**'] },
    });
    expect(res404.status).toBe(404);

    const mockFetch410: typeof fetch = async () => new Response(null, { status: 410 });
    const fetcher410 = new HttpDocumentFetcher({ ssrfValidator, customFetch: mockFetch410 });
    const res410 = await fetcher410.fetch({
      url: 'https://example.com/docs/gone-page',
      security: { allowedHosts: ['example.com'], includePaths: ['/docs/**'] },
    });
    expect(res410.status).toBe(410);
  });

  it('tracks redirects up to 5 hops and updates fetchedUrl', async () => {
    let hop = 0;
    const mockFetch: typeof fetch = async () => {
      hop++;
      if (hop === 1) {
        return new Response(null, {
          status: 301,
          headers: { Location: '/docs/redirected-1' },
        });
      }
      if (hop === 2) {
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://example.com/docs/final' },
        });
      }
      return new Response('<html>Final Page</html>', { status: 200 });
    };

    const fetcher = new HttpDocumentFetcher({ ssrfValidator, customFetch: mockFetch });
    const response = await fetcher.fetch({
      url: 'https://example.com/docs/start',
      security: { allowedHosts: ['example.com'], includePaths: ['/docs/**'] },
    });

    expect(response.status).toBe(200);
    if (response.status === 200) {
      expect(response.requestedUrl).toBe('https://example.com/docs/start');
      expect(response.fetchedUrl).toBe('https://example.com/docs/final');
      expect(response.rawBody).toBe('<html>Final Page</html>');
    }
  });

  it('blocks redirect to disallowed host or private IP (Gate T-02)', async () => {
    // 1. Redirect to external disallowed host
    const mockFetchExternal: typeof fetch = async () =>
      new Response(null, {
        status: 302,
        headers: { Location: 'https://malicious-external.com/docs/steal' },
      });

    const fetcherExternal = new HttpDocumentFetcher({ ssrfValidator, customFetch: mockFetchExternal });
    await expect(
      fetcherExternal.fetch({
        url: 'https://example.com/docs/start',
        security: { allowedHosts: ['example.com'], includePaths: ['/docs/**'] },
      }),
    ).rejects.toThrowError(CliOperationError);

    // 2. Redirect to private IP (SSRF)
    const mockFetchSsrf: typeof fetch = async () =>
      new Response(null, {
        status: 302,
        headers: { Location: 'https://192.168.1.1/admin' },
      });

    const fetcherSsrf = new HttpDocumentFetcher({ ssrfValidator, customFetch: mockFetchSsrf });
    await expect(
      fetcherSsrf.fetch({
        url: 'https://example.com/docs/start',
        security: { allowedHosts: ['example.com', '192.168.1.1'], includePaths: ['/docs/**', '/admin/**'] },
      }),
    ).rejects.toThrowError(CliOperationError);
  });

  it('throws error when redirect loop exceeds 5 hops', async () => {
    const mockFetchLoop: typeof fetch = async () =>
      new Response(null, {
        status: 302,
        headers: { Location: '/docs/loop' },
      });

    const fetcher = new HttpDocumentFetcher({ ssrfValidator, customFetch: mockFetchLoop });
    await expect(
      fetcher.fetch({
        url: 'https://example.com/docs/loop',
        security: { allowedHosts: ['example.com'], includePaths: ['/docs/**'] },
      }),
    ).rejects.toThrowError(CliOperationError);
  });

  it('throws non-retryable error on 401 and 403', async () => {
    const mockFetch403: typeof fetch = async () => new Response('Forbidden', { status: 403 });
    const fetcher = new HttpDocumentFetcher({ ssrfValidator, customFetch: mockFetch403 });

    await expect(
      fetcher.fetch({
        url: 'https://example.com/docs/protected',
        security: { allowedHosts: ['example.com'], includePaths: ['/docs/**'] },
      }),
    ).rejects.toThrowError(CliOperationError);
  });
});
