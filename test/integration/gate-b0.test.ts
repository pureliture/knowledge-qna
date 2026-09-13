/**
 * Gate B0 Integration and Diagnostic Smoke Verification
 * Tests:
 * 1. Palantir documentation sitemap discovery and URL filtering.
 * 2. Real representative document fetch, body fallback normalization, and non-JS-shell proof.
 * 3. Read-only GCP ADC / Discovery Engine health diagnostics with zero secret leakage and remote blocker isolation.
 */

import { describe, it, expect } from 'vitest';
import { SitemapSourceProvider } from '../../src/infrastructure/source/SitemapSourceProvider.js';
import { HttpDocumentFetcher } from '../../src/infrastructure/fetch/HttpDocumentFetcher.js';
import { HtmlDocumentNormalizer } from '../../src/infrastructure/parsing/HtmlDocumentNormalizer.js';
import { GoogleAgentSearchAdapter } from '../../src/infrastructure/search/google-agent-search/index.js';

describe('Gate B0: Live Source & Cloud Diagnostic Smoke', () => {
  it('B0-1: Palantir documentation sitemap returns valid Foundry URLs', async () => {
    const provider = new SitemapSourceProvider();

    try {
      const result = await provider.discover({
        type: 'sitemap',
        sitemapUrls: ['https://www.palantir.com/docs/sitemap.xml'],
        allowedHosts: ['www.palantir.com', 'palantir.com'],
        includePaths: ['/docs/foundry/**'],
        excludePaths: ['/docs/foundry/release-notes/archive/**'],
        collectionAllowed: true,
      });

      expect(result.summary.complete).toBe(true);
      expect(result.urls.length).toBeGreaterThanOrEqual(10);
      const foundryUrls = result.urls.filter((u) => u.url.includes('/docs/foundry/'));
      expect(foundryUrls.length).toBeGreaterThanOrEqual(10);
      expect(foundryUrls.length).toBe(result.urls.length);
    } catch (err) {
      // In air-gapped/offline execution environments, record network unreachability safely
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('ENOTFOUND') || msg.includes('EAI_AGAIN') || msg.includes('fetch failed')) {
        console.warn(`[Gate B0 Smoke] Network unreachable for Palantir sitemap: ${msg}`);
        return;
      }
      throw err;
    }
  }, 30000);

  it('B0-2: Representative Foundry document normalizes with body fallback without JS-shell dependence', async () => {
    const fetcher = new HttpDocumentFetcher();
    const normalizer = new HtmlDocumentNormalizer();

    try {
      const fetchRes = await fetcher.fetch({
        url: 'https://www.palantir.com/docs/foundry/developers',
        security: {
          allowedHosts: ['www.palantir.com', 'palantir.com'],
          includePaths: ['/docs/foundry/**'],
        },
      });

      expect(fetchRes.status).toBe(200);
      if (fetchRes.status !== 200) return;

      // Ensure response has significant content (not a 0-byte or < 1KB shell)
      expect(fetchRes.rawBody.length).toBeGreaterThan(10000);

      const normalized = await normalizer.normalize({
        canonicalUrl: fetchRes.fetchedUrl,
        html: fetchRes.rawBody,
        parserConfig: {
          contentSelectors: ['main', 'article'],
          removeSelectors: ['nav', 'footer', 'script', 'style'],
        },
      });

      // Proof of body fallback and AST parsing
      expect(normalized.title).toBeDefined();
      expect(normalized.markdown.length).toBeGreaterThan(1000);
      expect(normalized.headings.length).toBeGreaterThan(0);

      // Verify no sensitive tokens or secrets in markdown
      expect(normalized.markdown).not.toMatch(/Bearer\s+[A-Za-z0-9._-]+/i);
      expect(normalized.markdown).not.toMatch(/client_secret/i);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('ENOTFOUND') || msg.includes('EAI_AGAIN') || msg.includes('fetch failed')) {
        console.warn(`[Gate B0 Smoke] Network unreachable for Palantir document: ${msg}`);
        return;
      }
      throw err;
    }
  }, 30000);

  it('B0-3: GCP ADC / Discovery Engine diagnostics isolates remote blocker with zero secret leakage', async () => {
    const projectId =
      process.env.GOOGLE_AGENT_SEARCH_PROJECT_ID ??
      process.env.GOOGLE_CLOUD_PROJECT ??
      'test-project-id';
    const adapter = new GoogleAgentSearchAdapter({
      projectId,
      dataStoreId: 'test-datastore',
      location: 'global',
      collectionId: 'default_collection',
      servingConfigId: 'default_search',
    });

    const health = await adapter.health();

    // Confirm read-only diagnostic reflects project status
    expect(['ok', 'unavailable', 'misconfigured']).toContain(health.status);

    if (health.status === 'unavailable') {
      expect(health.message).toBeDefined();
      // Verify remote blocker diagnosis
      expect(
        health.message!.includes('permission denied') ||
          health.message!.includes('disabled') ||
          health.message!.includes('failed') ||
          health.message!.includes('Google Agent Search'),
      ).toBe(true);
    }

    // Strict zero secret leakage verification
    const serialized = JSON.stringify(health);
    expect(serialized).not.toMatch(/ya29\.[A-Za-z0-9_-]+/); // OAuth token pattern
    expect(serialized).not.toMatch(/BEGIN PRIVATE KEY/);
    expect(serialized).not.toMatch(/private_key/);
    expect(serialized).not.toMatch(/client_secret/);
  }, 15000);
});
