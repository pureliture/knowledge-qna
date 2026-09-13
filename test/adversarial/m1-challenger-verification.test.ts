/**
 * Adversarial Empirical Verification Test Suite for Milestone M1
 * Challenger: challenger_m1_g2_1
 *
 * Empirical verification of:
 * 1. Sitemap redirect SSRF leak remediation (per-hop SSRF validation, private IP / AWS metadata blocking, probe recorder oracle).
 * 2. Robots.txt RFC 9309 filtering (docsctx agent precedence, longest prefix matching, allow vs disallow, multi-origin caching, safe fallback on error, malicious redirect blocking).
 * 3. Deletion resilience under network drops, 5xx errors, incomplete discovery, and 2-consecutive-absence rules.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { SitemapSourceProvider } from '../../src/infrastructure/source/SitemapSourceProvider.js';
import { SsrfValidator } from '../../src/infrastructure/fetch/SsrfValidator.js';
import { HttpDocumentFetcher } from '../../src/infrastructure/fetch/HttpDocumentFetcher.js';
import { RobotsParser } from '../../src/infrastructure/source/RobotsParser.js';
import { SyncUseCase } from '../../src/application/sync/SyncUseCase.js';
import { FilesystemCorpusStore } from '../../src/infrastructure/storage/FilesystemCorpusStore.js';
import { SqliteManifestStore } from '../../src/infrastructure/storage/SqliteManifestStore.js';
import { HtmlDocumentNormalizer } from '../../src/infrastructure/parsing/HtmlDocumentNormalizer.js';
import { MarkdownAstChunker } from '../../src/infrastructure/parsing/MarkdownAstChunker.js';
import { TiktokenCounter } from '../../src/infrastructure/tokens/TiktokenCounter.js';
import { computeDocumentId } from '../../src/domain/identity.js';
import { CliOperationError } from '../../src/domain/errors.js';
import type { LibraryRegistry } from '../../src/application/ports/LibraryRegistry.js';
import type { LibraryDefinition, VersionSource } from '../../src/domain/models/index.js';

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
    throw new Error('Not implemented in test mock');
  }
}

describe('Milestone M1 Challenger Empirical Verification (Gates T-02, T-03, T-05)', () => {
  const publicDns = async () => ['93.184.216.34'];

  // ===========================================================================
  // Section 1: Sitemap Redirect SSRF Hardening & Probe Recording
  // ===========================================================================
  describe('1. Sitemap Redirect SSRF Leak Hardening', () => {
    it('blocks 1-hop redirect from public sitemap to AWS metadata endpoint and NEVER invokes fetch on metadata IP', async () => {
      const fetchedTargets: string[] = [];
      const customFetch: typeof fetch = async (input: string | URL | Request) => {
        const urlStr = typeof input === 'string' ? input : input.toString();
        fetchedTargets.push(urlStr);

        if (urlStr === 'https://example.com/sitemap.xml') {
          return new Response(null, {
            status: 302,
            headers: { location: 'http://169.254.169.254/latest/meta-data' },
          });
        }
        return new Response('<urlset></urlset>', { status: 200 });
      };

      const ssrfValidator = new SsrfValidator(publicDns);
      const provider = new SitemapSourceProvider({ customFetch, ssrfValidator });

      const source: VersionSource = {
        type: 'sitemap',
        sitemapUrls: ['https://example.com/sitemap.xml'],
        allowedHosts: ['example.com'],
        collectionAllowed: true,
      };

      const result = await provider.discover(source);
      expect(result.summary.complete).toBe(false);
      expect(result.summary.incompleteReason).toBe('SITEMAP_PARSE_ERROR');

      // CRITICAL ORACLE: Verify fetch was NEVER called with the malicious metadata IP!
      expect(fetchedTargets).toContain('https://example.com/sitemap.xml');
      expect(fetchedTargets).not.toContain('http://169.254.169.254/latest/meta-data');
      expect(fetchedTargets.some((u) => u.includes('169.254.169.254'))).toBe(false);
    });

    it('blocks multi-hop redirect: hop 1 allowed -> hop 2 redirected to loopback 127.0.0.1', async () => {
      const fetchedTargets: string[] = [];
      const customFetch: typeof fetch = async (input: string | URL | Request) => {
        const urlStr = typeof input === 'string' ? input : input.toString();
        fetchedTargets.push(urlStr);

        if (urlStr === 'https://example.com/sitemap.xml') {
          return new Response(null, {
            status: 301,
            headers: { location: 'https://example.com/intermediate-sitemap.xml' },
          });
        }
        if (urlStr === 'https://example.com/intermediate-sitemap.xml') {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://127.0.0.1/admin/sitemap.xml' },
          });
        }
        return new Response('<urlset></urlset>', { status: 200 });
      };

      const ssrfValidator = new SsrfValidator(publicDns);
      const provider = new SitemapSourceProvider({ customFetch, ssrfValidator });

      const source: VersionSource = {
        type: 'sitemap',
        sitemapUrls: ['https://example.com/sitemap.xml'],
        allowedHosts: ['example.com', '127.0.0.1'],
        collectionAllowed: true,
      };

      const result = await provider.discover(source);
      expect(result.summary.complete).toBe(false);
      expect(result.summary.incompleteReason).toBe('SITEMAP_PARSE_ERROR');

      // Oracle: verify fetch was called for hop 1 and intermediate hop, but NOT for loopback target
      expect(fetchedTargets).toEqual([
        'https://example.com/sitemap.xml',
        'https://example.com/intermediate-sitemap.xml',
      ]);
      expect(fetchedTargets.some((u) => u.includes('127.0.0.1'))).toBe(false);
    });

    it('blocks redirect to obfuscated IPv4 decimal and IPv6-mapped addresses', async () => {
      const maliciousTargets = [
        'https://2130706433/sitemap.xml',              // Decimal 127.0.0.1
        'https://2852039166/sitemap.xml',              // Decimal 169.254.169.254
        'https://[::ffff:127.0.0.1]/sitemap.xml',      // IPv6-mapped IPv4 loopback
        'https://[::ffff:a00:1]/sitemap.xml',          // IPv6-mapped 10.0.0.1
        'https://[::1]/sitemap.xml',                   // IPv6 loopback
        'https://[fe80::1]/sitemap.xml',               // IPv6 link-local
      ];

      for (const target of maliciousTargets) {
        const fetchedTargets: string[] = [];
        const customFetch: typeof fetch = async (input: string | URL | Request) => {
          const urlStr = typeof input === 'string' ? input : input.toString();
          fetchedTargets.push(urlStr);
          if (urlStr === 'https://example.com/sitemap.xml') {
            return new Response(null, {
              status: 302,
              headers: { location: target },
            });
          }
          return new Response('<urlset></urlset>', { status: 200 });
        };

        const ssrfValidator = new SsrfValidator(publicDns);
        const provider = new SitemapSourceProvider({ customFetch, ssrfValidator });

        const result = await provider.discover({
          type: 'sitemap',
          sitemapUrls: ['https://example.com/sitemap.xml'],
          allowedHosts: ['example.com', '2130706433', '2852039166', '::ffff:127.0.0.1', '::1', 'fe80::1'],
          collectionAllowed: true,
        });

        expect(result.summary.complete).toBe(false);
        expect(result.summary.incompleteReason).toBe('SITEMAP_PARSE_ERROR');
        expect(fetchedTargets).toEqual(['https://example.com/sitemap.xml']);
      }
    });

    it('blocks redirect to a domain resolving to private IP via DNS (DNS rebinding)', async () => {
      const dnsTable: Record<string, string[]> = {
        'example.com': ['93.184.216.34'],
        'rebind.example.com': ['10.200.0.1'], // Private IP
      };

      const fetchedTargets: string[] = [];
      const customFetch: typeof fetch = async (input: string | URL | Request) => {
        const urlStr = typeof input === 'string' ? input : input.toString();
        fetchedTargets.push(urlStr);
        if (urlStr === 'https://example.com/sitemap.xml') {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://rebind.example.com/sitemap.xml' },
          });
        }
        return new Response('<urlset></urlset>', { status: 200 });
      };

      const ssrfValidator = new SsrfValidator(async (host) => dnsTable[host] ?? ['93.184.216.34']);
      const provider = new SitemapSourceProvider({ customFetch, ssrfValidator });

      const result = await provider.discover({
        type: 'sitemap',
        sitemapUrls: ['https://example.com/sitemap.xml'],
        allowedHosts: ['example.com', 'rebind.example.com'],
        collectionAllowed: true,
      });

      expect(result.summary.complete).toBe(false);
      expect(result.summary.incompleteReason).toBe('SITEMAP_PARSE_ERROR');
      expect(fetchedTargets).toEqual(['https://example.com/sitemap.xml']);
      expect(result.summary.errors?.[0]?.message).toMatch(/resolves to restricted IP '10.200.0.1'/);
    });

    it('blocks infinite sitemap redirects (> 5 hops)', async () => {
      let hops = 0;
      const customFetch: typeof fetch = async () => {
        hops++;
        return new Response(null, {
          status: 302,
          headers: { location: `https://example.com/sitemap-hop-${hops}.xml` },
        });
      };

      const ssrfValidator = new SsrfValidator(publicDns);
      const provider = new SitemapSourceProvider({ customFetch, ssrfValidator });

      const result = await provider.discover({
        type: 'sitemap',
        sitemapUrls: ['https://example.com/sitemap.xml'],
        allowedHosts: ['example.com'],
        collectionAllowed: true,
      });

      expect(result.summary.complete).toBe(false);
      expect(result.summary.incompleteReason).toBe('SITEMAP_PARSE_ERROR');
      expect(result.summary.errors?.[0]?.message).toMatch(/Maximum redirect limit of 5 exceeded/);
      expect(hops).toBe(6); // Fails when 6th hop is attempted
    });

    it('blocks protocol downgrade (HTTPS -> HTTP) when allowHttp is false', async () => {
      const customFetch: typeof fetch = async (input: string | URL | Request) => {
        const urlStr = typeof input === 'string' ? input : input.toString();
        if (urlStr === 'https://example.com/sitemap.xml') {
          return new Response(null, {
            status: 302,
            headers: { location: 'http://example.com/sitemap.xml' },
          });
        }
        return new Response('<urlset></urlset>', { status: 200 });
      };

      const ssrfValidator = new SsrfValidator(publicDns);
      const provider = new SitemapSourceProvider({ customFetch, ssrfValidator });

      const result = await provider.discover({
        type: 'sitemap',
        sitemapUrls: ['https://example.com/sitemap.xml'],
        allowedHosts: ['example.com'],
        allowHttp: false,
        collectionAllowed: true,
      });

      expect(result.summary.complete).toBe(false);
      expect(result.summary.incompleteReason).toBe('SITEMAP_PARSE_ERROR');
      expect(result.summary.errors?.[0]?.message).toMatch(/HTTP protocol disallowed/);
    });
  });

  // ===========================================================================
  // Section 2: Robots.txt RFC 9309 Filtering Correctness
  // ===========================================================================
  describe('2. Robots.txt Filtering & Precedence', () => {
    it('applies docsctx user-agent precedence over wildcard *', () => {
      const robotsTxt = `
User-agent: *
Disallow: /docs/

User-agent: docsctx
Allow: /docs/public/
Disallow: /docs/secret/
`;
      const parser = RobotsParser.parse(robotsTxt);

      // docsctx rules apply:
      expect(parser.isAllowed('https://example.com/docs/public/guide')).toBe(true);
      expect(parser.isAllowed('https://example.com/docs/secret/credentials')).toBe(false);
      // /docs/other matches neither docsctx allow nor disallow, so allowed (docsctx takes precedence over *)
      expect(parser.isAllowed('https://example.com/docs/other')).toBe(true);
    });

    it('applies RFC 9309 longest prefix match and allow tie-breaker', () => {
      const robotsTxt = `
User-agent: *
Disallow: /docs/
Allow: /docs/public/
Disallow: /docs/public/forbidden
Allow: /docs/public/forbidden/exception
`;
      const parser = RobotsParser.parse(robotsTxt);

      expect(parser.isAllowed('/docs/guide')).toBe(false);
      expect(parser.isAllowed('/docs/public/readme')).toBe(true);
      expect(parser.isAllowed('/docs/public/forbidden/test')).toBe(false);
      expect(parser.isAllowed('/docs/public/forbidden/exception/allow-me')).toBe(true);
    });

    it('treats empty Disallow as allow all', () => {
      const robotsTxt = `
User-agent: *
Disallow:
`;
      const parser = RobotsParser.parse(robotsTxt);
      expect(parser.isAllowed('/any/path')).toBe(true);
    });

    it('handles wildcard * and end-of-string $ in patterns', () => {
      const robotsTxt = `
User-agent: *
Disallow: /*.pdf$
Disallow: /private/*/secret
`;
      const parser = RobotsParser.parse(robotsTxt);

      expect(parser.isAllowed('/docs/manual.pdf')).toBe(false);
      expect(parser.isAllowed('/docs/manual.pdf.html')).toBe(true);
      expect(parser.isAllowed('/private/group1/secret')).toBe(false);
      expect(parser.isAllowed('/private/group1/public')).toBe(true);
    });

    it('filters out disallowed URLs in sitemap discovery with multiple origins', async () => {
      const responses: Record<string, string> = {
        'https://example.com/sitemap.xml': `<?xml version="1.0" encoding="UTF-8"?>
          <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
            <url><loc>https://example.com/docs/allowed-1</loc></url>
            <url><loc>https://example.com/docs/blocked-1</loc></url>
            <url><loc>https://cdn.example.com/docs/allowed-2</loc></url>
            <url><loc>https://cdn.example.com/docs/blocked-2</loc></url>
          </urlset>`,
        'https://example.com/robots.txt': `User-agent: *\nDisallow: /docs/blocked-1\n`,
        'https://cdn.example.com/robots.txt': `User-agent: *\nDisallow: /docs/blocked-2\n`,
      };

      const provider = new SitemapSourceProvider({
        fetchFn: async (url) => {
          const content = responses[url];
          if (!content) throw new Error(`404 Not Found: ${url}`);
          return content;
        },
      });

      const result = await provider.discover({
        type: 'sitemap',
        sitemapUrls: ['https://example.com/sitemap.xml'],
        allowedHosts: ['example.com', 'cdn.example.com'],
        includePaths: ['/docs/**'],
        collectionAllowed: true,
      });

      expect(result.summary.complete).toBe(true);
      expect(result.summary.totalDiscovered).toBe(2);
      expect(result.urls.map((u) => u.url).sort()).toEqual([
        'https://cdn.example.com/docs/allowed-2',
        'https://example.com/docs/allowed-1',
      ]);
      expect(result.summary.errors?.map((e) => e.url).sort()).toEqual([
        'https://cdn.example.com/docs/blocked-2',
        'https://example.com/docs/blocked-1',
      ]);
    });

    it('safely falls back to full allow when robots.txt returns 404 or fails', async () => {
      const sitemaps: Record<string, string> = {
        'https://example.com/sitemap.xml': `<?xml version="1.0" encoding="UTF-8"?>
          <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
            <url><loc>https://example.com/docs/page-1</loc></url>
          </urlset>`,
      };

      const provider = new SitemapSourceProvider({
        fetchFn: async (url) => {
          if (url === 'https://example.com/robots.txt') {
            throw new Error('404 Not Found');
          }
          return sitemaps[url] ?? '';
        },
      });

      const result = await provider.discover({
        type: 'sitemap',
        sitemapUrls: ['https://example.com/sitemap.xml'],
        allowedHosts: ['example.com'],
        includePaths: ['/docs/**'],
        collectionAllowed: true,
      });

      expect(result.summary.complete).toBe(true);
      expect(result.urls.length).toBe(1);
      expect(result.urls[0]?.url).toBe('https://example.com/docs/page-1');
    });

    it('safely blocks malicious robots.txt redirect to AWS metadata without crashing or leaking', async () => {
      const fetchedUrls: string[] = [];
      const customFetch: typeof fetch = async (input: string | URL | Request) => {
        const urlStr = typeof input === 'string' ? input : input.toString();
        fetchedUrls.push(urlStr);

        if (urlStr === 'https://example.com/sitemap.xml') {
          return new Response(`<?xml version="1.0" encoding="UTF-8"?>
            <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
              <url><loc>https://example.com/docs/page-1</loc></url>
            </urlset>`, { status: 200 });
        }
        if (urlStr === 'https://example.com/robots.txt') {
          // Malicious redirect from robots.txt to AWS metadata!
          return new Response(null, {
            status: 302,
            headers: { location: 'http://169.254.169.254/latest/meta-data' },
          });
        }
        return new Response('', { status: 200 });
      };

      const ssrfValidator = new SsrfValidator(publicDns);
      const provider = new SitemapSourceProvider({ customFetch, ssrfValidator });

      const result = await provider.discover({
        type: 'sitemap',
        sitemapUrls: ['https://example.com/sitemap.xml'],
        allowedHosts: ['example.com'],
        includePaths: ['/docs/**'],
        collectionAllowed: true,
      });

      // Verification: robots.txt SSRF error is safely caught and falls back to allow all,
      // while AWS metadata was NEVER contacted!
      expect(result.summary.complete).toBe(true);
      expect(result.urls.length).toBe(1);
      expect(fetchedUrls).not.toContain('http://169.254.169.254/latest/meta-data');
      expect(fetchedUrls.some((u) => u.includes('169.254.169.254'))).toBe(false);
    });
  });

  // ===========================================================================
  // Section 3: Deletion Resilience & 2-Consecutive-Absence Rules
  // ===========================================================================
  describe('3. Deletion Resilience & Absence Policy', () => {
    let tmpDir: string;
    let corpusStore: FilesystemCorpusStore;
    let manifestStore: SqliteManifestStore;
    let normalizer: HtmlDocumentNormalizer;
    let chunker: MarkdownAstChunker;
    let registry: InMemoryLibraryRegistry;

    const libraryId = 'challenger-lib';
    const versionKey = 'current';

    function buildLibConfig(urls: string[]): LibraryDefinition {
      return {
        schemaVersion: 1,
        id: libraryId,
        name: 'Challenger Test Library',
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
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'challenger-resilience-'));
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

    it('network failure / 500 error aborts sync without deleting any existing documents', async () => {
      const doc1 = 'https://example.com/docs/doc1';
      const doc2 = 'https://example.com/docs/doc2';
      const doc3 = 'https://example.com/docs/doc3';

      let return500ForDoc2 = false;
      const mockFetch: typeof fetch = async (input) => {
        const urlStr = input.toString();
        if (urlStr === doc2 && return500ForDoc2) {
          return new Response('Internal Server Error', { status: 500 });
        }
        return new Response(`<main><h1>Title</h1><p>Body of ${urlStr}</p></main>`, { status: 200 });
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

      // Run 1: Successfully store all 3 docs
      registry.register(buildLibConfig([doc1, doc2, doc3]));
      const run1 = await syncUseCase.execute({ libraryId });
      expect(run1.storedCount).toBe(3);

      const rev1 = await corpusStore.getRevision(run1.corpusRevisionId);
      expect(rev1?.documents.length).toBe(3);

      // Run 2: Doc 2 returns 500 -> sync fails with error!
      return500ForDoc2 = true;
      await expect(syncUseCase.execute({ libraryId })).rejects.toThrowError(CliOperationError);

      // Verify that after failure, revision 1 is still the latest and has 3 documents!
      const latestRevMeta = await manifestStore.getLatestCorpusRevision(libraryId, versionKey);
      expect(latestRevMeta?.corpusRevisionId).toBe(run1.corpusRevisionId);

      const revAfterFail = await corpusStore.getRevision(run1.corpusRevisionId);
      expect(revAfterFail?.documents.length).toBe(3);
      for (const url of [doc1, doc2, doc3]) {
        const docId = computeDocumentId(libraryId, versionKey, url);
        expect(revAfterFail?.documents.some((d) => d.documentId === docId)).toBe(true);
      }
    });

    it('preserves documents across interleaved incomplete discovery and enforces 2 complete absences for deletion', async () => {
      const docA = 'https://example.com/docs/a';
      const docB = 'https://example.com/docs/b';
      const docIdB = computeDocumentId(libraryId, versionKey, docB);

      const mockFetch: typeof fetch = async (input) =>
        new Response(`<main><h1>Heading</h1><p>${input.toString()}</p></main>`, { status: 200 });

      const ssrfValidator = new SsrfValidator(publicDns);
      const documentFetcher = new HttpDocumentFetcher({ ssrfValidator, customFetch: mockFetch });

      // Run 1: Both docs discovered and stored
      const fullProvider = new SitemapSourceProvider({ ssrfValidator });
      const sync1 = new SyncUseCase(
        registry,
        manifestStore,
        corpusStore,
        fullProvider,
        documentFetcher,
        normalizer,
        chunker,
      );
      registry.register(buildLibConfig([docA, docB]));
      const r1 = await sync1.execute({ libraryId });
      expect(r1.storedCount).toBe(2);

      // Run 2: Complete discovery with doc B absent -> 1st complete absence
      registry.register(buildLibConfig([docA]));
      const r2 = await sync1.execute({ libraryId });
      expect(r2.deletedCount).toBe(0);
      const obsR2 = await manifestStore.getObservation(docIdB);
      expect(obsR2?.consecutiveAbsences).toBe(1);

      // Run 3: Incomplete discovery occurs (e.g. depth limit exceeded or timeout)
      // Even though doc B was NOT in the discovered list, it was INCOMPLETE!
      // Therefore, consecutiveAbsences must NOT increment to 2, and doc B must NOT be deleted!
      const incompleteProvider = {
        discover: async () => ({
          urls: [{ url: docA }],
          summary: {
            complete: false,
            totalDiscovered: 1,
            sitemapsProcessed: 1,
            depthReached: 5,
            aborted: false,
            incompleteReason: 'DEPTH_LIMIT_EXCEEDED' as const,
          },
        }),
      };
      const syncIncomplete = new SyncUseCase(
        registry,
        manifestStore,
        corpusStore,
        incompleteProvider,
        documentFetcher,
        normalizer,
        chunker,
      );
      const r3 = await syncIncomplete.execute({ libraryId });
      expect(r3.deletedCount).toBe(0);
      const obsR3 = await manifestStore.getObservation(docIdB);
      expect(obsR3?.consecutiveAbsences).toBe(1); // STILL 1, NOT 2!
      const rev3 = await corpusStore.getRevision(r3.corpusRevisionId);
      expect(rev3?.documents.some((d) => d.documentId === docIdB)).toBe(true);

      // Run 4: Another complete discovery where doc B is absent -> 2nd complete absence -> NOW DELETED!
      const r4 = await sync1.execute({ libraryId });
      expect(r4.deletedCount).toBe(1);
      const obsR4 = await manifestStore.getObservation(docIdB);
      expect(obsR4?.consecutiveAbsences).toBe(2);
      expect(obsR4?.status).toBe(404);
      const rev4 = await corpusStore.getRevision(r4.corpusRevisionId);
      expect(rev4?.documents.some((d) => d.documentId === docIdB)).toBe(false);
    });

    it('immediate deletion on explicit 404 does not touch unaffected documents', async () => {
      const docA = 'https://example.com/docs/a';
      const docB = 'https://example.com/docs/b';
      const docC = 'https://example.com/docs/c';

      let return404ForB = false;
      const mockFetch: typeof fetch = async (input) => {
        const urlStr = input.toString();
        if (urlStr === docB && return404ForB) {
          return new Response('Not Found', { status: 404 });
        }
        return new Response(`<main><h1>Page</h1><p>${urlStr}</p></main>`, { status: 200 });
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

      registry.register(buildLibConfig([docA, docB, docC]));

      // Run 1: Store all 3
      const r1 = await syncUseCase.execute({ libraryId });
      expect(r1.storedCount).toBe(3);

      // Run 2: Doc B returns 404 -> immediately deleted
      return404ForB = true;
      const r2 = await syncUseCase.execute({ libraryId });
      expect(r2.deletedCount).toBe(1);

      const rev2 = await corpusStore.getRevision(r2.corpusRevisionId);
      expect(rev2?.documents.length).toBe(2);
      const docIdB = computeDocumentId(libraryId, versionKey, docB);
      expect(rev2?.documents.some((d) => d.documentId === docIdB)).toBe(false);
      const docIdA = computeDocumentId(libraryId, versionKey, docA);
      const docIdC = computeDocumentId(libraryId, versionKey, docC);
      expect(rev2?.documents.some((d) => d.documentId === docIdA)).toBe(true);
      expect(rev2?.documents.some((d) => d.documentId === docIdC)).toBe(true);
    });
  });
});
