import { describe, it, expect } from 'vitest';
import { SitemapSourceProvider } from '../../src/infrastructure/source/SitemapSourceProvider.js';
import type { VersionSource } from '../../src/domain/models/index.js';
import { CliOperationError } from '../../src/domain/errors.js';

describe('SitemapSourceProvider Unit Tests (Gate T-02)', () => {
  it('discovers documents from static source and filters paths', async () => {
    const provider = new SitemapSourceProvider();
    const source: VersionSource = {
      type: 'static',
      urls: [
        'https://example.com/docs/intro',
        'https://example.com/docs/getting-started',
        'https://example.com/docs/archive/v1',
        'https://other.com/docs/intro',
      ],
      allowedHosts: ['example.com'],
      includePaths: ['/docs/**'],
      excludePaths: ['/docs/archive/**'],
      collectionAllowed: true,
    };

    const result = await provider.discover(source);
    expect(result.summary.complete).toBe(true);
    expect(result.summary.totalDiscovered).toBe(2);
    expect(result.urls.map((u) => u.url)).toEqual([
      'https://example.com/docs/intro',
      'https://example.com/docs/getting-started',
    ]);
  });

  it('throws SOURCE_EMPTY when static source has zero matching URLs', async () => {
    const provider = new SitemapSourceProvider();
    const source: VersionSource = {
      type: 'static',
      urls: ['https://example.com/other/page'],
      allowedHosts: ['example.com'],
      includePaths: ['/docs/**'],
      collectionAllowed: true,
    };

    await expect(provider.discover(source)).rejects.toThrowError(CliOperationError);
  });

  it('parses sitemapindex and recurses into child sitemaps', async () => {
    const sitemaps: Record<string, string> = {
      'https://example.com/sitemap.xml': `<?xml version="1.0" encoding="UTF-8"?>
        <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <sitemap><loc>https://example.com/child-sitemap.xml</loc></sitemap>
        </sitemapindex>`,
      'https://example.com/child-sitemap.xml': `<?xml version="1.0" encoding="UTF-8"?>
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url>
            <loc>https://example.com/docs/page-1</loc>
            <lastmod>2026-09-01T12:00:00Z</lastmod>
          </url>
          <url>
            <loc>https://example.com/docs/page-2</loc>
          </url>
        </urlset>`,
    };

    const provider = new SitemapSourceProvider({
      fetchFn: async (url) => {
        const content = sitemaps[url];
        if (!content) throw new Error(`Not found: ${url}`);
        return content;
      },
    });

    const source: VersionSource = {
      type: 'sitemap',
      sitemapUrls: ['https://example.com/sitemap.xml'],
      allowedHosts: ['example.com'],
      includePaths: ['/docs/**'],
      collectionAllowed: true,
    };

    const result = await provider.discover(source);
    expect(result.summary.complete).toBe(true);
    expect(result.summary.sitemapsProcessed).toBe(2);
    expect(result.summary.totalDiscovered).toBe(2);
    expect(result.urls[0]?.url).toBe('https://example.com/docs/page-1');
    expect(result.urls[0]?.lastModified).toBe('2026-09-01T12:00:00Z');
  });

  it('detects cycles between sitemaps without infinite recursion', async () => {
    // Sitemap A points to B, B points back to A
    const sitemaps: Record<string, string> = {
      'https://example.com/sitemap-a.xml': `<?xml version="1.0" encoding="UTF-8"?>
        <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <sitemap><loc>https://example.com/sitemap-b.xml</loc></sitemap>
        </sitemapindex>`,
      'https://example.com/sitemap-b.xml': `<?xml version="1.0" encoding="UTF-8"?>
        <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <sitemap><loc>https://example.com/sitemap-a.xml</loc></sitemap>
          <sitemap><loc>https://example.com/sitemap-leaf.xml</loc></sitemap>
        </sitemapindex>`,
      'https://example.com/sitemap-leaf.xml': `<?xml version="1.0" encoding="UTF-8"?>
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>https://example.com/docs/cyclic-test</loc></url>
        </urlset>`,
    };

    const provider = new SitemapSourceProvider({
      fetchFn: async (url) => sitemaps[url] ?? '',
    });

    const source: VersionSource = {
      type: 'sitemap',
      sitemapUrls: ['https://example.com/sitemap-a.xml'],
      allowedHosts: ['example.com'],
      includePaths: ['/docs/**'],
      collectionAllowed: true,
    };

    const result = await provider.discover(source);
    expect(result.summary.sitemapsProcessed).toBe(3);
    expect(result.summary.totalDiscovered).toBe(1);
    expect(result.urls[0]?.url).toBe('https://example.com/docs/cyclic-test');
  });

  it('enforces recursion depth limit of 5', async () => {
    // Generate 7 levels of nested sitemaps
    const sitemaps: Record<string, string> = {};
    for (let depth = 0; depth < 7; depth++) {
      const currentUrl = `https://example.com/sitemap-level-${depth}.xml`;
      const nextUrl = `https://example.com/sitemap-level-${depth + 1}.xml`;
      sitemaps[currentUrl] = `<?xml version="1.0" encoding="UTF-8"?>
        <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <sitemap><loc>${nextUrl}</loc></sitemap>
        </sitemapindex>`;
    }

    const provider = new SitemapSourceProvider({
      fetchFn: async (url) => sitemaps[url] ?? '',
    });

    const source: VersionSource = {
      type: 'sitemap',
      sitemapUrls: ['https://example.com/sitemap-level-0.xml'],
      allowedHosts: ['example.com'],
      includePaths: ['/docs/**'],
      collectionAllowed: true,
    };

    const result = await provider.discover(source);
    expect(result.summary.complete).toBe(false);
    expect(result.summary.incompleteReason).toBe('DEPTH_LIMIT_EXCEEDED');
    expect(result.summary.depthReached).toBeGreaterThanOrEqual(5);
  });

  it('enforces 1,000 document limit', async () => {
    // Sitemap with 1,200 URLs
    const urlEntries = Array.from({ length: 1200 }, (_, i) => `
      <url><loc>https://example.com/docs/doc-${i}</loc></url>
    `).join('\n');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        ${urlEntries}
      </urlset>`;

    const provider = new SitemapSourceProvider({
      fetchFn: async () => xml,
    });

    const source: VersionSource = {
      type: 'sitemap',
      sitemapUrls: ['https://example.com/sitemap.xml'],
      allowedHosts: ['example.com'],
      includePaths: ['/docs/**'],
      collectionAllowed: true,
    };

    const result = await provider.discover(source);
    expect(result.summary.complete).toBe(false);
    expect(result.summary.incompleteReason).toBe('DOCUMENT_LIMIT_EXCEEDED');
    expect(result.urls.length).toBe(1000);
  });

  it('rejects sitemap exceeding 10 MiB limit', async () => {
    // Generate sitemap > 10 MiB
    const largeXml = '<?xml version="1.0" encoding="UTF-8"?><urlset>' + ' '.repeat(10 * 1024 * 1024 + 100) + '</urlset>';

    const provider = new SitemapSourceProvider({
      fetchFn: async () => largeXml,
    });

    const source: VersionSource = {
      type: 'sitemap',
      sitemapUrls: ['https://example.com/huge-sitemap.xml'],
      allowedHosts: ['example.com'],
      includePaths: ['/docs/**'],
      collectionAllowed: true,
    };

    const result = await provider.discover(source);
    expect(result.summary.complete).toBe(false);
    expect(result.summary.incompleteReason).toBe('SITEMAP_PARSE_ERROR');
    expect(result.summary.errors?.some((e) => e.message.includes('10 MiB'))).toBe(true);
  });

  it('rejects redirect to private IP during sitemap fetch (SSRF on redirect)', async () => {
    const customFetch: typeof fetch = async (input: string | URL | Request) => {
      const urlStr = typeof input === 'string' ? input : input.toString();
      if (urlStr === 'https://example.com/sitemap.xml') {
        return new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data' },
        });
      }
      return new Response('ok', { status: 200 });
    };

    const provider = new SitemapSourceProvider({ customFetch });
    const source: VersionSource = {
      type: 'sitemap',
      sitemapUrls: ['https://example.com/sitemap.xml'],
      allowedHosts: ['example.com'],
      collectionAllowed: true,
    };

    const result = await provider.discover(source);
    expect(result.summary.complete).toBe(false);
    expect(result.summary.incompleteReason).toBe('SITEMAP_PARSE_ERROR');
    expect(result.summary.errors?.[0]?.message).toMatch(/SSRF_VIOLATION|Disallowed host|Invalid redirect location/);
  });

  it('filters out URLs disallowed by robots.txt in sitemap discovery', async () => {
    const sitemaps: Record<string, string> = {
      'https://example.com/sitemap.xml': `<?xml version="1.0" encoding="UTF-8"?>
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>https://example.com/docs/allowed</loc></url>
          <url><loc>https://example.com/docs/secret</loc></url>
        </urlset>`,
      'https://example.com/robots.txt': `User-agent: *\nDisallow: /docs/secret\n`,
    };

    const provider = new SitemapSourceProvider({
      fetchFn: async (url) => {
        const content = sitemaps[url];
        if (!content) throw new Error(`Not found: ${url}`);
        return content;
      },
    });

    const source: VersionSource = {
      type: 'sitemap',
      sitemapUrls: ['https://example.com/sitemap.xml'],
      allowedHosts: ['example.com'],
      collectionAllowed: true,
    };

    const result = await provider.discover(source);
    expect(result.summary.complete).toBe(true);
    expect(result.urls.map((u) => u.url)).toEqual(['https://example.com/docs/allowed']);
    expect(result.summary.errors?.some((e) => e.url.includes('/docs/secret'))).toBe(true);
  });

  it('filters out URLs disallowed by robots.txt in static source discovery', async () => {
    const sitemaps: Record<string, string> = {
      'https://example.com/robots.txt': `User-agent: docsctx\nDisallow: /docs/private\n`,
    };

    const provider = new SitemapSourceProvider({
      fetchFn: async (url) => {
        const content = sitemaps[url];
        if (!content) throw new Error(`Not found: ${url}`);
        return content;
      },
    });

    const source: VersionSource = {
      type: 'static',
      urls: [
        'https://example.com/docs/public',
        'https://example.com/docs/private',
      ],
      allowedHosts: ['example.com'],
      collectionAllowed: true,
    };

    const result = await provider.discover(source);
    expect(result.summary.complete).toBe(true);
    expect(result.urls.map((u) => u.url)).toEqual(['https://example.com/docs/public']);
    expect(result.summary.errors?.some((e) => e.url.includes('/docs/private'))).toBe(true);
  });
});
