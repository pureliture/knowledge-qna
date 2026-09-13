/**
 * Empirical Adversarial Test Suite for M1 Discovery, Fetching & Deletion Pipeline
 * Gates T-02, T-03, T-05
 * Author: challenger_m1_1
 *
 * Adversarial Attack Vectors Tested:
 * 1. Sitemap Adversarial Inputs (Gate T-02):
 *    - Deep recursion (depth 6, 10, 20) with graceful stopping and DEPTH_LIMIT_EXCEEDED
 *    - Circular references (A -> B -> C -> A, self loops A -> A, diamond cycles)
 *    - Massive sitemaps (>10 MiB payload rejection, >1000 items capped at 1000, multi-sitemap 1000 cap)
 *    - Malformed XML and corrupt sitemaps handled without process crash
 * 2. SSRF Evasion Attacks (Gates T-02 & T-03):
 *    - IPv6-mapped IPv4 loopback (::ffff:127.0.0.1) and hex (::ffff:7f00:1)
 *    - Decimal representations (2130706433 for 127.0.0.1, 2852039166 for 169.254.169.254)
 *    - Octal and hex IPv4 representations (017700000001, 0x7f000001)
 *    - AWS link-local metadata (169.254.169.254)
 *    - DNS rebinding / host resolving to private IP (127.0.0.1, 10.0.0.1, 169.254.169.254, ::1, fe80::1)
 *    - Mixed DNS responses (public IP + private IP)
 * 3. Redirect Attacks (Gates T-02 & T-03):
 *    - Infinite redirect loops (>5 hops) and ping-pong cycles
 *    - Protocol downgrade: HTTPS redirecting to HTTP
 *    - Redirect to private IP (127.0.0.1, 169.254.169.254, decimal IP, IPv6-mapped IP)
 *    - Redirect to domain resolving to private IP
 *    - Redirect to disallowed path outside includePaths
 *    - Malformed redirect responses (missing location, invalid location syntax)
 * 4. Deletion Resilience & Fault Isolation (Gate T-05):
 *    - Intermittent network timeout/error does NOT cause document deletion (preserves previous revision)
 *    - Incomplete discovery (e.g. timeout or depth limit) preserves documents and does not increment absence counter
 *    - 1st complete absence preserves document as missingPending with consecutiveAbsences = 1
 *    - 2nd consecutive complete absence confirms deletion (excluded from revision)
 *    - Temporary absence followed by reappearance resets absence counter to 0
 *    - Explicit 404/410 immediately deletes document without waiting for 2nd run
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { SitemapSourceProvider } from '../../src/infrastructure/source/SitemapSourceProvider.js';
import { SsrfValidator } from '../../src/infrastructure/fetch/SsrfValidator.js';
import { HttpDocumentFetcher } from '../../src/infrastructure/fetch/HttpDocumentFetcher.js';
import { SyncUseCase } from '../../src/application/sync/SyncUseCase.js';
import { FilesystemCorpusStore } from '../../src/infrastructure/storage/FilesystemCorpusStore.js';
import { SqliteManifestStore } from '../../src/infrastructure/storage/SqliteManifestStore.js';
import { HtmlDocumentNormalizer } from '../../src/infrastructure/parsing/HtmlDocumentNormalizer.js';
import { MarkdownAstChunker } from '../../src/infrastructure/parsing/MarkdownAstChunker.js';
import { TiktokenCounter } from '../../src/infrastructure/tokens/TiktokenCounter.js';
import { computeDocumentId } from '../../src/domain/identity.js';
import { CliOperationError } from '../../src/domain/errors.js';
import type { LibraryRegistry } from '../../src/application/ports/LibraryRegistry.js';
import type { LibraryDefinition } from '../../src/domain/models/index.js';

class InMemoryLibraryRegistry implements LibraryRegistry {
  private readonly libs = new Map<string, LibraryDefinition>();

  register(lib: LibraryDefinition): void {
    this.libs.set(lib.id, lib);
  }

  async getLibrary(id: string): Promise<LibraryDefinition | null> {
    return this.libs.get(id) ?? null;
  }

  async listLibraries(): Promise<LibraryDefinition[]> {
    return Array.from(this.libs.values());
  }

  async resolveLibrary() {
    throw new Error('Not implemented in mock');
  }
}

describe('M1 Pipeline Adversarial Stress Harness (Gates T-02, T-03, T-05)', () => {
  const publicDns = async () => ['93.184.216.34'];

  // ===========================================================================
  // 1. SITEMAP ADVERSARIAL ATTACKS (Gate T-02)
  // ===========================================================================
  describe('1. Sitemap Adversarial Attacks (Gate T-02)', () => {
    it('stops deep recursion at depth 5 without stack overflow (depth 10 & 20)', async () => {
      // Construct 20 levels of nested sitemaps
      const sitemaps: Record<string, string> = {};
      for (let d = 0; d < 20; d++) {
        const curr = `https://example.com/sitemap-${d}.xml`;
        const next = `https://example.com/sitemap-${d + 1}.xml`;
        sitemaps[curr] = `<?xml version="1.0" encoding="UTF-8"?>
          <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
            <sitemap><loc>${next}</loc></sitemap>
          </sitemapindex>`;
      }
      sitemaps['https://example.com/sitemap-20.xml'] = `<?xml version="1.0" encoding="UTF-8"?>
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>https://example.com/docs/unreachable-leaf</loc></url>
        </urlset>`;

      const provider = new SitemapSourceProvider({
        fetchFn: async (url) => sitemaps[url] ?? '',
      });

      const result = await provider.discover({
        type: 'sitemap',
        sitemapUrls: ['https://example.com/sitemap-0.xml'],
        allowedHosts: ['example.com'],
        includePaths: ['/docs/**'],
        collectionAllowed: true,
      });

      expect(result.summary.complete).toBe(false);
      expect(result.summary.incompleteReason).toBe('DEPTH_LIMIT_EXCEEDED');
      expect(result.summary.depthReached).toBeGreaterThanOrEqual(5);
      // Unreachable leaf beyond depth 5 must not be discovered
      expect(result.urls.some((u) => u.url.includes('unreachable-leaf'))).toBe(false);
    });

    it('handles direct self-referencing sitemap (A -> A) without infinite loop', async () => {
      const sitemaps: Record<string, string> = {
        'https://example.com/self.xml': `<?xml version="1.0" encoding="UTF-8"?>
          <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
            <sitemap><loc>https://example.com/self.xml</loc></sitemap>
            <sitemap><loc>https://example.com/leaf.xml</loc></sitemap>
          </sitemapindex>`,
        'https://example.com/leaf.xml': `<?xml version="1.0" encoding="UTF-8"?>
          <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
            <url><loc>https://example.com/docs/valid-page</loc></url>
          </urlset>`,
      };

      const provider = new SitemapSourceProvider({
        fetchFn: async (url) => sitemaps[url] ?? '',
      });

      const result = await provider.discover({
        type: 'sitemap',
        sitemapUrls: ['https://example.com/self.xml'],
        allowedHosts: ['example.com'],
        includePaths: ['/docs/**'],
        collectionAllowed: true,
      });

      expect(result.summary.complete).toBe(true);
      expect(result.summary.sitemapsProcessed).toBe(2);
      expect(result.urls.length).toBe(1);
      expect(result.urls[0]?.url).toBe('https://example.com/docs/valid-page');
    });

    it('handles complex 4-node circular cycle (A -> B -> C -> D -> B) with multiple leaves', async () => {
      const sitemaps: Record<string, string> = {
        'https://example.com/a.xml': `<?xml version="1.0"?>
          <sitemapindex><sitemap><loc>https://example.com/b.xml</loc></sitemap></sitemapindex>`,
        'https://example.com/b.xml': `<?xml version="1.0"?>
          <sitemapindex>
            <sitemap><loc>https://example.com/c.xml</loc></sitemap>
            <sitemap><loc>https://example.com/leaf1.xml</loc></sitemap>
          </sitemapindex>`,
        'https://example.com/c.xml': `<?xml version="1.0"?>
          <sitemapindex><sitemap><loc>https://example.com/d.xml</loc></sitemap></sitemapindex>`,
        'https://example.com/d.xml': `<?xml version="1.0"?>
          <sitemapindex>
            <sitemap><loc>https://example.com/b.xml</loc></sitemap>
            <sitemap><loc>https://example.com/leaf2.xml</loc></sitemap>
          </sitemapindex>`,
        'https://example.com/leaf1.xml': `<?xml version="1.0"?>
          <urlset><url><loc>https://example.com/docs/page-1</loc></url></urlset>`,
        'https://example.com/leaf2.xml': `<?xml version="1.0"?>
          <urlset><url><loc>https://example.com/docs/page-2</loc></url></urlset>`,
      };

      const provider = new SitemapSourceProvider({
        fetchFn: async (url) => sitemaps[url] ?? '',
      });

      const result = await provider.discover({
        type: 'sitemap',
        sitemapUrls: ['https://example.com/a.xml'],
        allowedHosts: ['example.com'],
        includePaths: ['/docs/**'],
        collectionAllowed: true,
      });

      expect(result.summary.complete).toBe(true);
      expect(result.summary.sitemapsProcessed).toBe(6);
      expect(result.urls.length).toBe(2);
    });

    it('rejects massive sitemap exceeding 10 MiB limit safely without memory exhaustion', async () => {
      const tenMibPlus = 10 * 1024 * 1024 + 1024;
      const hugeXml = '<?xml version="1.0"?><urlset>' + '<!-- padding -->'.repeat(tenMibPlus / 16) + '</urlset>';

      const provider = new SitemapSourceProvider({
        fetchFn: async () => hugeXml,
      });

      const result = await provider.discover({
        type: 'sitemap',
        sitemapUrls: ['https://example.com/huge.xml'],
        allowedHosts: ['example.com'],
        includePaths: ['/docs/**'],
        collectionAllowed: true,
      });

      expect(result.summary.complete).toBe(false);
      expect(result.summary.incompleteReason).toBe('SITEMAP_PARSE_ERROR');
      expect(result.summary.errors?.some((e) => e.message.includes('10 MiB'))).toBe(true);
    });

    it('enforces 1,000 document limit across multi-sitemap index fan-out', async () => {
      // 3 child sitemaps, each with 500 URLs = 1,500 total
      const chunk1 = Array.from({ length: 500 }, (_, i) => `<url><loc>https://example.com/docs/c1-${i}</loc></url>`).join('');
      const chunk2 = Array.from({ length: 500 }, (_, i) => `<url><loc>https://example.com/docs/c2-${i}</loc></url>`).join('');
      const chunk3 = Array.from({ length: 500 }, (_, i) => `<url><loc>https://example.com/docs/c3-${i}</loc></url>`).join('');

      const sitemaps: Record<string, string> = {
        'https://example.com/main.xml': `<?xml version="1.0"?>
          <sitemapindex>
            <sitemap><loc>https://example.com/s1.xml</loc></sitemap>
            <sitemap><loc>https://example.com/s2.xml</loc></sitemap>
            <sitemap><loc>https://example.com/s3.xml</loc></sitemap>
          </sitemapindex>`,
        'https://example.com/s1.xml': `<?xml version="1.0"?><urlset>${chunk1}</urlset>`,
        'https://example.com/s2.xml': `<?xml version="1.0"?><urlset>${chunk2}</urlset>`,
        'https://example.com/s3.xml': `<?xml version="1.0"?><urlset>${chunk3}</urlset>`,
      };

      const provider = new SitemapSourceProvider({
        fetchFn: async (url) => sitemaps[url] ?? '',
      });

      const result = await provider.discover({
        type: 'sitemap',
        sitemapUrls: ['https://example.com/main.xml'],
        allowedHosts: ['example.com'],
        includePaths: ['/docs/**'],
        collectionAllowed: true,
      });

      expect(result.summary.complete).toBe(false);
      expect(result.summary.incompleteReason).toBe('DOCUMENT_LIMIT_EXCEEDED');
      expect(result.urls.length).toBe(1000);
    });

    it('handles malformed / truncated XML safely and rejects with SOURCE_EMPTY when 0 valid URLs', async () => {
      const provider = new SitemapSourceProvider({
        fetchFn: async () => '<?xml version="1.0"?><sitemapindex><sitemap><loc>https://example.com/docs/unclosed',
      });

      await expect(
        provider.discover({
          type: 'sitemap',
          sitemapUrls: ['https://example.com/broken.xml'],
          allowedHosts: ['example.com'],
          includePaths: ['/docs/**'],
          collectionAllowed: true,
        }),
      ).rejects.toThrowError(/No valid URLs discovered in sitemap/);
    });

    it('rejects non-standard ports on initial sitemap URLs', async () => {
      const provider = new SitemapSourceProvider({
        fetchFn: async () => '<?xml version="1.0"?><urlset></urlset>',
      });

      await expect(
        provider.discover({
          type: 'sitemap',
          sitemapUrls: ['https://example.com:8443/sitemap.xml'],
          allowedHosts: ['example.com'],
          includePaths: ['/docs/**'],
          collectionAllowed: true,
        }),
      ).rejects.toThrowError(/No valid URLs discovered in sitemap/);
    });

    it('blocks sitemaps hosted on private or restricted IP addresses (Gate T-02)', async () => {
      const validator = new SsrfValidator(async () => ['127.0.0.1']);
      const provider = new SitemapSourceProvider({ ssrfValidator: validator });

      const res = await provider.discover({
        type: 'sitemap',
        sitemapUrls: ['https://127.0.0.1/sitemap.xml'],
        allowedHosts: ['127.0.0.1'],
        includePaths: ['/docs/**'],
        collectionAllowed: true,
      });

      expect(res.summary.complete).toBe(false);
      expect(res.summary.incompleteReason).toBe('SITEMAP_PARSE_ERROR');
      expect(res.summary.errors?.[0]?.message).toMatch(/SSRF blocked/);
      expect(res.urls.length).toBe(0);
    });
  });

  // ===========================================================================
  // 2. SSRF EVASION ATTACKS (Gates T-02 & T-03)
  // ===========================================================================
  describe('2. SSRF Evasion Attacks (Gates T-02 & T-03)', () => {
    it('blocks IPv6-mapped IPv4 evasion attacks', async () => {
      const validator = new SsrfValidator(publicDns);

      const maliciousUrls = [
        'https://[::ffff:127.0.0.1]/docs/page',
        'https://[::ffff:169.254.169.254]/latest/meta-data',
        'https://[::ffff:10.0.0.1]/admin',
        'https://[::ffff:192.168.1.1]/settings',
        'https://[::ffff:172.16.0.1]/internal',
        'https://[::ffff:7f00:1]/docs/page', // hex mapped
      ];

      for (const url of maliciousUrls) {
        await expect(validator.validate(url)).rejects.toThrowError(CliOperationError);
      }
    });

    it('blocks decimal, octal, and hex representations of IPv4 loopback & private addresses', async () => {
      const validator = new SsrfValidator(publicDns);

      const obfuscatedUrls = [
        'https://2130706433/docs',           // Decimal 127.0.0.1
        'https://2852039166/latest',         // Decimal 169.254.169.254
        'https://0x7f000001/docs',           // Hex 127.0.0.1
        'https://017700000001/docs',         // Octal 127.0.0.1
        'http://169.254.169.254/metadata',   // Raw AWS metadata IP
        'https://127.0.0.1/admin',           // Raw loopback
        'https://10.254.254.254/secret',     // RFC 1918 10.x
        'https://192.168.100.1/router',      // RFC 1918 192.168.x
        'https://172.31.255.255/intranet',   // RFC 1918 172.16-31
      ];

      for (const url of obfuscatedUrls) {
        await expect(validator.validate(url, { allowHttp: true })).rejects.toThrowError(CliOperationError);
      }
    });

    it('blocks IPv6 loopback, link-local, and unique-local address variants', async () => {
      const validator = new SsrfValidator(publicDns);

      const ipv6Urls = [
        'https://[::1]/secret',
        'https://[::]/secret',
        'https://[fe80::1]/local',
        'https://[fc00::1]/private',
        'https://[fd00::1]/private',
        'https://[0:0:0:0:0:0:0:1]/secret',
      ];

      for (const url of ipv6Urls) {
        await expect(validator.validate(url)).rejects.toThrowError(CliOperationError);
      }
    });

    it('blocks hostnames pointing to private IPs via DNS (DNS rebinding / private DNS)', async () => {
      const dnsMockTable: Record<string, string[]> = {
        'dns-loopback.example.com': ['127.0.0.1'],
        'dns-aws-meta.example.com': ['169.254.169.254'],
        'dns-internal-10.example.com': ['10.0.0.1'],
        'dns-internal-192.example.com': ['192.168.1.50'],
        'dns-v6-loopback.example.com': ['::1'],
        'dns-v6-linklocal.example.com': ['fe80::dead:beef'],
        'dns-v6-mapped.example.com': ['::ffff:127.0.0.1'],
        'dns-mixed.example.com': ['93.184.216.34', '10.0.0.1'], // Mixed public + private
        'dns-zero-ip.example.com': [],                          // Zero IP response
      };

      const mockLookup = async (host: string) => dnsMockTable[host] ?? ['93.184.216.34'];
      const validator = new SsrfValidator(mockLookup);

      for (const host of Object.keys(dnsMockTable)) {
        await expect(
          validator.validate(`https://${host}/docs`, { allowedHosts: [host] }),
        ).rejects.toThrowError(CliOperationError);
      }
    });
  });

  // ===========================================================================
  // 3. REDIRECT ATTACKS (Gates T-02 & T-03)
  // ===========================================================================
  describe('3. Redirect Attacks (Gates T-02 & T-03)', () => {
    it('blocks infinite redirect loops exceeding 5 hops', async () => {
      let hopCount = 0;
      const mockFetch: typeof fetch = async () => {
        hopCount++;
        return new Response(null, {
          status: 302,
          headers: { Location: `/docs/hop-${hopCount}` },
        });
      };

      const fetcher = new HttpDocumentFetcher({
        ssrfValidator: new SsrfValidator(publicDns),
        customFetch: mockFetch,
      });

      await expect(
        fetcher.fetch({
          url: 'https://example.com/docs/start',
          security: { allowedHosts: ['example.com'], includePaths: ['/docs/**'] },
        }),
      ).rejects.toThrowError(/Maximum redirect limit of 5 exceeded/);

      expect(hopCount).toBe(6); // Fails precisely when hop 6 is attempted
    });

    it('blocks circular ping-pong redirect (A <-> B)', async () => {
      let current = 'a';
      const mockFetch: typeof fetch = async () => {
        current = current === 'a' ? 'b' : 'a';
        return new Response(null, {
          status: 302,
          headers: { Location: `/docs/${current}` },
        });
      };

      const fetcher = new HttpDocumentFetcher({
        ssrfValidator: new SsrfValidator(publicDns),
        customFetch: mockFetch,
      });

      await expect(
        fetcher.fetch({
          url: 'https://example.com/docs/a',
          security: { allowedHosts: ['example.com'], includePaths: ['/docs/**'] },
        }),
      ).rejects.toThrowError(/Maximum redirect limit of 5 exceeded/);
    });

    it('blocks protocol downgrade redirect from HTTPS to HTTP when allowHttp is false', async () => {
      const mockFetch: typeof fetch = async () =>
        new Response(null, {
          status: 302,
          headers: { Location: 'http://example.com/docs/downgraded' },
        });

      const fetcher = new HttpDocumentFetcher({
        ssrfValidator: new SsrfValidator(publicDns),
        customFetch: mockFetch,
      });

      await expect(
        fetcher.fetch({
          url: 'https://example.com/docs/secure-start',
          security: { allowedHosts: ['example.com'], includePaths: ['/docs/**'], allowHttp: false },
        }),
      ).rejects.toThrowError(CliOperationError);
    });

    it('blocks redirect from public domain to internal IP address or metadata endpoint', async () => {
      const maliciousRedirects = [
        'https://127.0.0.1/admin',
        'http://169.254.169.254/latest/meta-data',
        'https://2130706433/docs',
        'https://[::ffff:127.0.0.1]/docs',
      ];

      for (const target of maliciousRedirects) {
        const mockFetch: typeof fetch = async () =>
          new Response(null, {
            status: 302,
            headers: { Location: target },
          });

        const fetcher = new HttpDocumentFetcher({
          ssrfValidator: new SsrfValidator(publicDns),
          customFetch: mockFetch,
        });

        await expect(
          fetcher.fetch({
            url: 'https://example.com/docs/start',
            security: {
              allowedHosts: ['example.com', '127.0.0.1', '169.254.169.254', '2130706433'],
              includePaths: ['/docs/**', '/admin/**', '/latest/**'],
              allowHttp: true,
            },
          }),
        ).rejects.toThrowError(CliOperationError);
      }
    });

    it('blocks redirect to private domain resolving to internal IP via DNS', async () => {
      const mockLookup = async (host: string) => {
        if (host === 'evil-internal.example.com') return ['10.0.0.1'];
        return ['93.184.216.34'];
      };

      const mockFetch: typeof fetch = async () =>
        new Response(null, {
          status: 302,
          headers: { Location: 'https://evil-internal.example.com/docs/target' },
        });

      const fetcher = new HttpDocumentFetcher({
        ssrfValidator: new SsrfValidator(mockLookup),
        customFetch: mockFetch,
      });

      await expect(
        fetcher.fetch({
          url: 'https://example.com/docs/start',
          security: {
            allowedHosts: ['example.com', 'evil-internal.example.com'],
            includePaths: ['/docs/**'],
          },
        }),
      ).rejects.toThrowError(/SSRF blocked: Host 'evil-internal.example.com' resolves to restricted IP/);
    });

    it('blocks redirect to path outside allowed includePaths', async () => {
      const mockFetch: typeof fetch = async () =>
        new Response(null, {
          status: 302,
          headers: { Location: 'https://example.com/secret/unauthorized' },
        });

      const fetcher = new HttpDocumentFetcher({
        ssrfValidator: new SsrfValidator(publicDns),
        customFetch: mockFetch,
      });

      await expect(
        fetcher.fetch({
          url: 'https://example.com/docs/start',
          security: {
            allowedHosts: ['example.com'],
            includePaths: ['/docs/**'],
          },
        }),
      ).rejects.toThrowError(/outside allowed paths/);
    });

    it('rejects redirect response missing Location header or with invalid URL', async () => {
      // 1. Missing Location header
      const mockFetchNoLoc: typeof fetch = async () =>
        new Response(null, { status: 302, headers: {} });

      const fetcher1 = new HttpDocumentFetcher({
        ssrfValidator: new SsrfValidator(publicDns),
        customFetch: mockFetchNoLoc,
      });

      await expect(
        fetcher1.fetch({
          url: 'https://example.com/docs/start',
          security: { allowedHosts: ['example.com'], includePaths: ['/docs/**'] },
        }),
      ).rejects.toThrowError(/missing Location header/);

      // 2. Invalid Location syntax
      const mockFetchBadLoc: typeof fetch = async () =>
        new Response(null, { status: 302, headers: { Location: 'http://[invalid-ipv6' } });

      const fetcher2 = new HttpDocumentFetcher({
        ssrfValidator: new SsrfValidator(publicDns),
        customFetch: mockFetchBadLoc,
      });

      await expect(
        fetcher2.fetch({
          url: 'https://example.com/docs/start',
          security: { allowedHosts: ['example.com'], includePaths: ['/docs/**'] },
        }),
      ).rejects.toThrowError(CliOperationError);
    });
  });

  // ===========================================================================
  // 4. DELETION RESILIENCE & FAULT ISOLATION (Gate T-05)
  // ===========================================================================
  describe('4. Deletion Resilience & Fault Isolation (Gate T-05)', () => {
    let tmpDir: string;
    let corpusStore: FilesystemCorpusStore;
    let manifestStore: SqliteManifestStore;
    let normalizer: HtmlDocumentNormalizer;
    let chunker: MarkdownAstChunker;
    let registry: InMemoryLibraryRegistry;

    const libraryId = 'resilience-lib';
    const versionKey = 'current';

    function buildLibConfig(urls: string[]): LibraryDefinition {
      return {
        schemaVersion: 1,
        id: libraryId,
        name: 'Resilience Test Library',
        defaultVersionKey: versionKey,
        versions: [
          {
            versionKey,
            strategy: 'rolling',
            source: {
              type: 'static',
              urls,
              allowedHosts: ['example.com'],
              includePaths: ['/docs/**'],
              collectionAllowed: true,
            },
            parser: {
              contentSelectors: ['main'],
              removeSelectors: ['nav', 'footer'],
            },
            chunking: {
              minTokens: 50,
              targetTokens: 200,
              maxTokens: 500,
              maxAtomicTokens: 16000,
            },
            freshness: {
              staleAfterHours: 24,
            },
          },
        ],
      };
    }

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resilience-test-'));
      corpusStore = new FilesystemCorpusStore(tmpDir);
      manifestStore = new SqliteManifestStore(path.join(tmpDir, 'manifest/catalog.sqlite'));
      normalizer = new HtmlDocumentNormalizer();
      chunker = new MarkdownAstChunker(new TiktokenCounter());
      registry = new InMemoryLibraryRegistry();
    });

    afterEach(() => {
      manifestStore.close();
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('intermittent fetch network timeout/failure does NOT delete documents or corrupt revision', async () => {
      const docA = 'https://example.com/docs/a';
      const docB = 'https://example.com/docs/b';
      registry.register(buildLibConfig([docA, docB]));

      let fetchFailsForB = false;
      const mockFetch: typeof fetch = async (input) => {
        const url = input.toString();
        if (url === docB && fetchFailsForB) {
          throw new TypeError('fetch failed: network timeout / ETIMEDOUT');
        }
        return new Response(`<main><h1>Page</h1><p>Content of ${url}</p></main>`, {
          status: 200,
          headers: { ETag: '"v1"' },
        });
      };

      const ssrfValidator = new SsrfValidator(publicDns);
      const documentFetcher = new HttpDocumentFetcher({ ssrfValidator, customFetch: mockFetch });
      const sourceProvider = new SitemapSourceProvider({ ssrfValidator });

      const syncUseCase = new SyncUseCase(
        registry,
        manifestStore,
        corpusStore,
        sourceProvider,
        documentFetcher,
        normalizer,
        chunker,
      );

      // Run 1: Initial successful sync -> Revision 1 contains Doc A and Doc B
      const run1 = await syncUseCase.execute({ libraryId });
      expect(run1.storedCount).toBe(2);
      const rev1 = await corpusStore.getRevision(run1.corpusRevisionId);
      expect(rev1!.documents.length).toBe(2);

      // Run 2: Network timeout on doc B -> sync execution fails!
      fetchFailsForB = true;
      await expect(syncUseCase.execute({ libraryId })).rejects.toThrowError(CliOperationError);

      // Verify that after failed sync, Revision 1 is completely intact and neither Doc A nor Doc B was deleted!
      const latestRevMeta = await manifestStore.getLatestCorpusRevision(libraryId, versionKey);
      expect(latestRevMeta?.corpusRevisionId).toBe(run1.corpusRevisionId);

      const revAfterCrash = await corpusStore.getRevision(run1.corpusRevisionId);
      expect(revAfterCrash!.documents.length).toBe(2);

      // Run 3: Network recovers -> sync succeeds and documents remain
      fetchFailsForB = false;
      const run3 = await syncUseCase.execute({ libraryId });
      expect(run3.status).toBe('complete');
      const rev3 = await corpusStore.getRevision(run3.corpusRevisionId);
      expect(rev3!.documents.length).toBe(2);
    });

    it('incomplete discovery preserves documents and does not increment consecutive absences', async () => {
      const docA = 'https://example.com/docs/a';
      const docB = 'https://example.com/docs/b';
      registry.register(buildLibConfig([docA, docB]));

      const mockFetch: typeof fetch = async (input) =>
        new Response(`<main><h1>Doc</h1><p>${input.toString()}</p></main>`, { status: 200 });

      const ssrfValidator = new SsrfValidator(publicDns);
      const documentFetcher = new HttpDocumentFetcher({ ssrfValidator, customFetch: mockFetch });

      // Run 1: Complete initial sync
      const completeSourceProvider = new SitemapSourceProvider({ ssrfValidator });
      const syncUseCase1 = new SyncUseCase(
        registry,
        manifestStore,
        corpusStore,
        completeSourceProvider,
        documentFetcher,
        normalizer,
        chunker,
      );
      const run1 = await syncUseCase1.execute({ libraryId });
      expect(run1.storedCount).toBe(2);

      // Run 2: Incomplete discovery where Doc B was not discovered due to timeout/depth limit
      const incompleteProvider = {
        discover: async () => ({
          urls: [{ url: docA }],
          summary: {
            complete: false, // Incomplete discovery!
            totalDiscovered: 1,
            sitemapsProcessed: 1,
            depthReached: 5,
            aborted: false,
            incompleteReason: 'DEPTH_LIMIT_EXCEEDED' as const,
          },
        }),
      };

      const syncUseCase2 = new SyncUseCase(
        registry,
        manifestStore,
        corpusStore,
        incompleteProvider,
        documentFetcher,
        normalizer,
        chunker,
      );

      const run2 = await syncUseCase2.execute({ libraryId });
      expect(run2.deletedCount).toBe(0);
      const rev2 = await corpusStore.getRevision(run2.corpusRevisionId);
      expect(rev2!.documents.length).toBe(2); // Doc B preserved!

      const docIdB = computeDocumentId(libraryId, versionKey, docB);
      const obsB = await manifestStore.getObservation(docIdB);
      // consecutiveAbsences must remain 0! Incomplete discovery does NOT count as absence.
      expect(obsB?.consecutiveAbsences ?? 0).toBe(0);
    });

    it('requires exactly 2 consecutive complete discovery absences to delete a document', async () => {
      const docA = 'https://example.com/docs/a';
      const docB = 'https://example.com/docs/b';

      const mockFetch: typeof fetch = async (input) =>
        new Response(`<main><h1>Doc</h1><p>${input.toString()}</p></main>`, { status: 200 });

      const ssrfValidator = new SsrfValidator(publicDns);
      const documentFetcher = new HttpDocumentFetcher({ ssrfValidator, customFetch: mockFetch });
      const sourceProvider = new SitemapSourceProvider({ ssrfValidator });

      const syncUseCase = new SyncUseCase(
        registry,
        manifestStore,
        corpusStore,
        sourceProvider,
        documentFetcher,
        normalizer,
        chunker,
      );

      const docIdB = computeDocumentId(libraryId, versionKey, docB);

      // Run 1: Docs A and B present
      registry.register(buildLibConfig([docA, docB]));
      const run1 = await syncUseCase.execute({ libraryId });
      expect(run1.storedCount).toBe(2);

      // Run 2: Doc B missing (1st complete absence) -> PRESERVED
      registry.register(buildLibConfig([docA]));
      const run2 = await syncUseCase.execute({ libraryId });
      expect(run2.deletedCount).toBe(0);
      const rev2 = await corpusStore.getRevision(run2.corpusRevisionId);
      expect(rev2!.documents.some((d) => d.documentId === docIdB)).toBe(true);

      const obs1 = await manifestStore.getObservation(docIdB);
      expect(obs1!.consecutiveAbsences).toBe(1);

      // Run 3: Doc B missing again (2nd consecutive complete absence) -> DELETED
      const run3 = await syncUseCase.execute({ libraryId });
      expect(run3.deletedCount).toBe(1);
      const rev3 = await corpusStore.getRevision(run3.corpusRevisionId);
      expect(rev3!.documents.some((d) => d.documentId === docIdB)).toBe(false);

      const obs2 = await manifestStore.getObservation(docIdB);
      expect(obs2!.consecutiveAbsences).toBe(2);
      expect(obs2!.status).toBe(404);
    });

    it('resets consecutive absence counter to 0 when document reappears before 2nd absence', async () => {
      const docA = 'https://example.com/docs/a';
      const docB = 'https://example.com/docs/b';

      const mockFetch: typeof fetch = async (input) =>
        new Response(`<main><h1>Doc</h1><p>${input.toString()}</p></main>`, { status: 200 });

      const ssrfValidator = new SsrfValidator(publicDns);
      const documentFetcher = new HttpDocumentFetcher({ ssrfValidator, customFetch: mockFetch });
      const sourceProvider = new SitemapSourceProvider({ ssrfValidator });

      const syncUseCase = new SyncUseCase(
        registry,
        manifestStore,
        corpusStore,
        sourceProvider,
        documentFetcher,
        normalizer,
        chunker,
      );

      const docIdB = computeDocumentId(libraryId, versionKey, docB);

      // Run 1: Both A and B present
      registry.register(buildLibConfig([docA, docB]));
      await syncUseCase.execute({ libraryId });

      // Run 2: Doc B absent (1st absence)
      registry.register(buildLibConfig([docA]));
      await syncUseCase.execute({ libraryId });
      const obsAfter1st = await manifestStore.getObservation(docIdB);
      expect(obsAfter1st!.consecutiveAbsences).toBe(1);

      // Run 3: Doc B reappears!
      registry.register(buildLibConfig([docA, docB]));
      await syncUseCase.execute({ libraryId });
      const obsAfterReappear = await manifestStore.getObservation(docIdB);
      // Consecutive absences must be reset to 0!
      expect(obsAfterReappear!.consecutiveAbsences).toBe(0);

      // Run 4: Doc B absent again (this is 1st absence again, NOT 2nd!)
      registry.register(buildLibConfig([docA]));
      const run4 = await syncUseCase.execute({ libraryId });
      // Must NOT be deleted because counter was reset!
      expect(run4.deletedCount).toBe(0);
      const rev4 = await corpusStore.getRevision(run4.corpusRevisionId);
      expect(rev4!.documents.some((d) => d.documentId === docIdB)).toBe(true);
      const obsAfterResetAbsence = await manifestStore.getObservation(docIdB);
      expect(obsAfterResetAbsence!.consecutiveAbsences).toBe(1);

      // Run 5: Doc B absent again (now 2nd consecutive absence)
      const run5 = await syncUseCase.execute({ libraryId });
      expect(run5.deletedCount).toBe(1);
      const rev5 = await corpusStore.getRevision(run5.corpusRevisionId);
      expect(rev5!.documents.some((d) => d.documentId === docIdB)).toBe(false);
    });

    it('explicit 404 or 410 response deletes document immediately without waiting for 2nd run', async () => {
      const docA = 'https://example.com/docs/a';
      const docB = 'https://example.com/docs/b';
      registry.register(buildLibConfig([docA, docB]));

      let return410ForB = false;
      const mockFetch: typeof fetch = async (input) => {
        const url = input.toString();
        if (url === docB && return410ForB) {
          return new Response(null, { status: 410 });
        }
        return new Response(`<main><h1>Doc</h1><p>${url}</p></main>`, { status: 200 });
      };

      const ssrfValidator = new SsrfValidator(publicDns);
      const documentFetcher = new HttpDocumentFetcher({ ssrfValidator, customFetch: mockFetch });
      const sourceProvider = new SitemapSourceProvider({ ssrfValidator });

      const syncUseCase = new SyncUseCase(
        registry,
        manifestStore,
        corpusStore,
        sourceProvider,
        documentFetcher,
        normalizer,
        chunker,
      );

      const docIdB = computeDocumentId(libraryId, versionKey, docB);

      // Run 1: Docs A and B present
      await syncUseCase.execute({ libraryId });

      // Run 2: Doc B returns explicit 410 Gone
      return410ForB = true;
      const run2 = await syncUseCase.execute({ libraryId });
      expect(run2.deletedCount).toBe(1);
      const rev2 = await corpusStore.getRevision(run2.corpusRevisionId);
      expect(rev2!.documents.some((d) => d.documentId === docIdB)).toBe(false);

      const obs = await manifestStore.getObservation(docIdB);
      expect(obs!.status).toBe(410);
      expect(obs!.consecutiveAbsences).toBe(2);
    });
  });
});
