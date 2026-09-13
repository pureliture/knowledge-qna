import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SyncUseCase } from '../../src/application/sync/SyncUseCase.js';
import { FilesystemCorpusStore } from '../../src/infrastructure/storage/FilesystemCorpusStore.js';
import { SqliteManifestStore } from '../../src/infrastructure/storage/SqliteManifestStore.js';
import { HtmlDocumentNormalizer } from '../../src/infrastructure/parsing/HtmlDocumentNormalizer.js';
import { MarkdownAstChunker } from '../../src/infrastructure/parsing/MarkdownAstChunker.js';
import { TiktokenCounter } from '../../src/infrastructure/tokens/TiktokenCounter.js';
import { SitemapSourceProvider } from '../../src/infrastructure/source/SitemapSourceProvider.js';
import { HttpDocumentFetcher } from '../../src/infrastructure/fetch/HttpDocumentFetcher.js';
import { SsrfValidator } from '../../src/infrastructure/fetch/SsrfValidator.js';
import type { LibraryRegistry } from '../../src/application/ports/LibraryRegistry.js';
import type { LibraryDefinition, LibraryVersionConfig } from '../../src/domain/models/index.js';
import { computeDocumentId } from '../../src/domain/identity.js';

class MockLibraryRegistry implements LibraryRegistry {
  private readonly libraries = new Map<string, LibraryDefinition>();

  register(lib: LibraryDefinition): void {
    this.libraries.set(lib.id, lib);
  }

  async getLibrary(id: string): Promise<LibraryDefinition | null> {
    return this.libraries.get(id) ?? null;
  }

  async listLibraries(): Promise<LibraryDefinition[]> {
    return Array.from(this.libraries.values());
  }

  async resolveLibrary(query: string) {
    throw new Error('Not implemented');
  }
}

describe('Sync Pipeline Integration Tests (Gates T-02, T-03, T-05)', () => {
  let tmpDir: string;
  let corpusStore: FilesystemCorpusStore;
  let manifestStore: SqliteManifestStore;
  let tokenCounter: TiktokenCounter;
  let normalizer: HtmlDocumentNormalizer;
  let chunker: MarkdownAstChunker;
  let registry: MockLibraryRegistry;

  const publicDns = async () => ['93.184.216.34'];
  const ssrfValidator = new SsrfValidator(publicDns);

  const libraryId = 'test-lib';
  const versionKey = 'current';

  function createTestLibrary(urls: string[]): LibraryDefinition {
    const versionConfig: LibraryVersionConfig = {
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
        contentSelectors: ['main', 'article'],
        removeSelectors: ['nav', 'footer', 'script', 'style'],
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
    };

    return {
      schemaVersion: 1,
      id: libraryId,
      name: 'Test Library',
      defaultVersionKey: versionKey,
      versions: [versionConfig],
    };
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-test-'));
    corpusStore = new FilesystemCorpusStore(tmpDir);
    manifestStore = new SqliteManifestStore(path.join(tmpDir, 'manifest/catalog.sqlite'));
    tokenCounter = new TiktokenCounter();
    normalizer = new HtmlDocumentNormalizer();
    chunker = new MarkdownAstChunker(tokenCounter);
    registry = new MockLibraryRegistry();
  });

  afterEach(() => {
    manifestStore.close();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('executes full initial sync pipeline: discover -> fetch -> normalize -> chunk -> store -> revision', async () => {
    const docUrl1 = 'https://example.com/docs/intro';
    const docUrl2 = 'https://example.com/docs/guide';

    registry.register(createTestLibrary([docUrl1, docUrl2]));

    const sourceProvider = new SitemapSourceProvider({ ssrfValidator });

    const htmlMap: Record<string, string> = {
      [docUrl1]: '<main><h1>Introduction</h1><p>Welcome to Knowledge QnA MCP testing.</p></main>',
      [docUrl2]: '<main><h1>User Guide</h1><p>Step 1: Install. Step 2: Configure.</p></main>',
    };

    const mockFetch: typeof fetch = async (input) => {
      const url = input.toString();
      const body = htmlMap[url];
      if (body) {
        return new Response(body, {
          status: 200,
          headers: {
            'Content-Type': 'text/html',
            ETag: '"v1"',
          },
        });
      }
      return new Response(null, { status: 404 });
    };

    const documentFetcher = new HttpDocumentFetcher({ ssrfValidator, customFetch: mockFetch });

    const syncUseCase = new SyncUseCase(
      registry,
      manifestStore,
      corpusStore,
      sourceProvider,
      documentFetcher,
      normalizer,
      chunker,
    );

    const result = await syncUseCase.execute({ libraryId });

    expect(result.status).toBe('complete');
    expect(result.discoveredCount).toBe(2);
    expect(result.fetchedCount).toBe(2);
    expect(result.storedCount).toBe(2);
    expect(result.unchangedCount).toBe(0);
    expect(result.deletedCount).toBe(0);

    // Verify revision stored in CorpusStore
    const revision = await corpusStore.getRevision(result.corpusRevisionId);
    expect(revision).toBeDefined();
    expect(revision!.documents.length).toBe(2);

    // Verify documents and chunks exist in CorpusStore
    for (const docEntry of revision!.documents) {
      const doc = await corpusStore.getDocument(docEntry.documentId, docEntry.snapshotId);
      expect(doc).toBeDefined();
      expect(doc!.title).toBeTruthy();

      const chunks = await corpusStore.getChunksForSnapshot(docEntry.chunkerProfileId, docEntry.snapshotId);
      expect(chunks.length).toBeGreaterThan(0);
    }

    // Verify manifest sync_runs
    const syncRun = await manifestStore.getSyncRun(result.runId);
    expect(syncRun).toBeDefined();
    expect(syncRun!.status).toBe('complete');
    expect(syncRun!.corpusRevisionId).toBe(result.corpusRevisionId);
  });

  it('reuses existing snapshotId and chunkIds on conditional GET 304 without re-normalizing (Gate T-03)', async () => {
    const docUrl = 'https://example.com/docs/intro';
    registry.register(createTestLibrary([docUrl]));

    const sourceProvider = new SitemapSourceProvider({ ssrfValidator });

    let fetchCount = 0;
    const mockFetch: typeof fetch = async (input, init) => {
      fetchCount++;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers['If-None-Match'] === '"etag-304"') {
        // Return 304 on second run!
        return new Response(null, {
          status: 304,
          headers: { ETag: '"etag-304"' },
        });
      }

      return new Response('<main><h1>Intro</h1><p>Initial content.</p></main>', {
        status: 200,
        headers: { ETag: '"etag-304"' },
      });
    };

    const documentFetcher = new HttpDocumentFetcher({ ssrfValidator, customFetch: mockFetch });

    const syncUseCase = new SyncUseCase(
      registry,
      manifestStore,
      corpusStore,
      sourceProvider,
      documentFetcher,
      normalizer,
      chunker,
    );

    // Run 1: Initial sync (200 OK)
    const run1 = await syncUseCase.execute({ libraryId });
    expect(run1.storedCount).toBe(1);
    expect(run1.unchangedCount).toBe(0);

    const rev1 = await corpusStore.getRevision(run1.corpusRevisionId);
    const snapId1 = rev1!.documents[0]!.snapshotId;
    const chunkIds1 = rev1!.documents[0]!.chunkIds;

    // Run 2: Second sync (304 Not Modified)
    const run2 = await syncUseCase.execute({ libraryId });
    expect(run2.storedCount).toBe(0);
    expect(run2.unchangedCount).toBe(1); // Reused without re-normalizing!

    const rev2 = await corpusStore.getRevision(run2.corpusRevisionId);
    const snapId2 = rev2!.documents[0]!.snapshotId;
    const chunkIds2 = rev2!.documents[0]!.chunkIds;

    // Deterministic reuse check (Gate T-03)
    expect(snapId2).toBe(snapId1);
    expect(chunkIds2).toEqual(chunkIds1);
    expect(rev2!.corpusRevisionId).toBe(rev1!.corpusRevisionId);
  });

  it('reuses existing snapshotId and chunkIds when raw HTML changed only in nav/ads but normalized content is identical (Gate T-03)', async () => {
    const docUrl = 'https://example.com/docs/intro';
    registry.register(createTestLibrary([docUrl]));

    const sourceProvider = new SitemapSourceProvider({ ssrfValidator });

    let runNum = 1;
    const mockFetch: typeof fetch = async () => {
      if (runNum === 1) {
        return new Response(
          '<html><nav>Old Nav 2025</nav><main><h1>Title</h1><p>Main body content.</p></main></html>',
          { status: 200, headers: { ETag: '"v1"' } },
        );
      } else {
        // Nav changes (copyright 2026, new sidebar link), but <main> is 100% identical!
        return new Response(
          '<html><nav>New Nav 2026 - Updated Links</nav><main><h1>Title</h1><p>Main body content.</p></main></html>',
          { status: 200, headers: { ETag: '"v2"' } },
        );
      }
    };

    const documentFetcher = new HttpDocumentFetcher({ ssrfValidator, customFetch: mockFetch });

    const syncUseCase = new SyncUseCase(
      registry,
      manifestStore,
      corpusStore,
      sourceProvider,
      documentFetcher,
      normalizer,
      chunker,
    );

    // Run 1
    const run1 = await syncUseCase.execute({ libraryId });
    const rev1 = await corpusStore.getRevision(run1.corpusRevisionId);
    const snapId1 = rev1!.documents[0]!.snapshotId;

    // Run 2: Nav changed, but normalizedHash identical
    runNum = 2;
    const run2 = await syncUseCase.execute({ libraryId });
    expect(run2.storedCount).toBe(0);
    expect(run2.unchangedCount).toBe(1);

    const rev2 = await corpusStore.getRevision(run2.corpusRevisionId);
    const snapId2 = rev2!.documents[0]!.snapshotId;

    // Snapshot ID reused deterministically
    expect(snapId2).toBe(snapId1);
  });

  it('handles 2-consecutive-absence deletion policy (Gate T-05)', async () => {
    const docUrlA = 'https://example.com/docs/a';
    const docUrlB = 'https://example.com/docs/b';

    const sourceProvider = new SitemapSourceProvider({ ssrfValidator });

    const mockFetch: typeof fetch = async (input) => {
      const url = input.toString();
      return new Response(`<main><h1>Page</h1><p>Content for ${url}</p></main>`, {
        status: 200,
        headers: { ETag: '"tag"' },
      });
    };

    const documentFetcher = new HttpDocumentFetcher({ ssrfValidator, customFetch: mockFetch });

    const syncUseCase = new SyncUseCase(
      registry,
      manifestStore,
      corpusStore,
      sourceProvider,
      documentFetcher,
      normalizer,
      chunker,
    );

    // Step 1: Run 1 with docs A and B
    registry.register(createTestLibrary([docUrlA, docUrlB]));
    const run1 = await syncUseCase.execute({ libraryId });
    const rev1 = await corpusStore.getRevision(run1.corpusRevisionId);
    expect(rev1!.documents.length).toBe(2);

    const docIdB = computeDocumentId(libraryId, versionKey, docUrlB);

    // Step 2: Run 2 with doc B missing (1st absence)
    registry.register(createTestLibrary([docUrlA])); // only A in discovery!
    const run2 = await syncUseCase.execute({ libraryId });
    const rev2 = await corpusStore.getRevision(run2.corpusRevisionId);

    // Doc B must NOT be deleted yet! 1st absence is preserved as missingPending (Gate T-05)
    expect(run2.deletedCount).toBe(0);
    expect(rev2!.documents.length).toBe(2);
    expect(rev2!.documents.some((d) => d.documentId === docIdB)).toBe(true);

    const obs1 = await manifestStore.getObservation(docIdB);
    expect(obs1!.consecutiveAbsences).toBe(1);

    // Step 3: Run 3 with doc B missing again (2nd consecutive complete discovery absence)
    const run3 = await syncUseCase.execute({ libraryId });
    const rev3 = await corpusStore.getRevision(run3.corpusRevisionId);

    // Doc B is now CONFIRMED DELETED and excluded from Revision 3! (Gate T-05)
    expect(run3.deletedCount).toBe(1);
    expect(rev3!.documents.length).toBe(1);
    expect(rev3!.documents.some((d) => d.documentId === docIdB)).toBe(false);

    const obs2 = await manifestStore.getObservation(docIdB);
    expect(obs2!.consecutiveAbsences).toBe(2);
    expect(obs2!.status).toBe(404);
  });

  it('does NOT delete documents on partial discovery failure or timeout (Gate T-05)', async () => {
    const docUrlA = 'https://example.com/docs/a';
    const docUrlB = 'https://example.com/docs/b';

    registry.register(createTestLibrary([docUrlA, docUrlB]));

    const mockFetch: typeof fetch = async (input) => {
      const url = input.toString();
      return new Response(`<main><h1>Page</h1><p>${url}</p></main>`, { status: 200 });
    };

    const documentFetcher = new HttpDocumentFetcher({ ssrfValidator, customFetch: mockFetch });

    // Step 1: Initial complete sync
    const sourceProvider1 = new SitemapSourceProvider({ ssrfValidator });
    const syncUseCase1 = new SyncUseCase(
      registry,
      manifestStore,
      corpusStore,
      sourceProvider1,
      documentFetcher,
      normalizer,
      chunker,
    );

    const run1 = await syncUseCase1.execute({ libraryId });
    const rev1 = await corpusStore.getRevision(run1.corpusRevisionId);
    expect(rev1!.documents.length).toBe(2);

    // Step 2: Second sync where discovery is partial (complete: false due to timeout or limit)
    // Create a mock SourceProvider returning only 1 URL with complete: false
    const mockIncompleteProvider = {
      discover: async () => ({
        urls: [{ url: docUrlA }],
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
      mockIncompleteProvider,
      documentFetcher,
      normalizer,
      chunker,
    );

    const run2 = await syncUseCase2.execute({ libraryId });
    const rev2 = await corpusStore.getRevision(run2.corpusRevisionId);

    // Doc B was not discovered, but discovery was incomplete: DO NOT DELETE DOC B! (Gate T-05)
    expect(run2.deletedCount).toBe(0);
    expect(rev2!.documents.length).toBe(2);
  });

  it('immediately excludes document on explicit 404 or 410 deletion (Gate T-05)', async () => {
    const docUrlA = 'https://example.com/docs/a';
    const docUrlB = 'https://example.com/docs/b';

    registry.register(createTestLibrary([docUrlA, docUrlB]));

    let return404ForB = false;
    const mockFetch: typeof fetch = async (input) => {
      const url = input.toString();
      if (url === docUrlB && return404ForB) {
        return new Response(null, { status: 404 });
      }
      return new Response(`<main><h1>Page</h1><p>${url}</p></main>`, { status: 200 });
    };

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

    // Run 1: Docs A and B present
    const run1 = await syncUseCase.execute({ libraryId });
    const rev1 = await corpusStore.getRevision(run1.corpusRevisionId);
    expect(rev1!.documents.length).toBe(2);

    // Run 2: Doc B returns explicit 404
    return404ForB = true;
    const run2 = await syncUseCase.execute({ libraryId });
    const rev2 = await corpusStore.getRevision(run2.corpusRevisionId);

    // Explicit 404 immediately deletes Doc B without waiting for 2nd absence (Gate T-05)
    expect(run2.deletedCount).toBe(1);
    expect(rev2!.documents.length).toBe(1);
    expect(rev2!.documents[0]?.documentId).toBe(computeDocumentId(libraryId, versionKey, docUrlA));
  });

  it('re-chunks preserved Markdown when chunker profile changes even on 304 (Gate T-03)', async () => {
    const docUrl = 'https://example.com/docs/page';
    registry.register(createTestLibrary([docUrl]));

    let callCount = 0;
    const mockFetch: typeof fetch = async () => {
      callCount++;
      if (callCount > 1) {
        return new Response(null, { status: 304, headers: { etag: '"v1"' } });
      }
      return new Response('<main><h1>Page</h1><p>Paragraph content for page.</p></main>', {
        status: 200,
        headers: { etag: '"v1"' },
      });
    };

    const documentFetcher = new HttpDocumentFetcher({ ssrfValidator, customFetch: mockFetch });
    const sourceProvider = new SitemapSourceProvider({ ssrfValidator });

    // Sync 1 with profile v1
    const chunkerV1 = new MarkdownAstChunker(new TiktokenCounter(), 'ast-chunker-v1');
    const sync1 = new SyncUseCase(
      registry,
      manifestStore,
      corpusStore,
      sourceProvider,
      documentFetcher,
      normalizer,
      chunkerV1,
    );

    const run1 = await sync1.execute({ libraryId });
    expect(run1.storedCount).toBe(1);
    const rev1 = await corpusStore.getRevision(run1.corpusRevisionId);
    expect(rev1!.documents[0]?.chunkerProfileId).toBe('ast-chunker-v1');

    // Sync 2 with profile v2 (chunker profile changed!)
    const chunkerV2 = new MarkdownAstChunker(new TiktokenCounter(), 'ast-chunker-v2');
    const sync2 = new SyncUseCase(
      registry,
      manifestStore,
      corpusStore,
      sourceProvider,
      documentFetcher,
      normalizer,
      chunkerV2,
    );

    const run2 = await sync2.execute({ libraryId });
    // Should re-chunk preserved Markdown, so storedCount is 1, not unchanged!
    expect(run2.storedCount).toBe(1);
    const rev2 = await corpusStore.getRevision(run2.corpusRevisionId);
    expect(rev2!.documents[0]?.chunkerProfileId).toBe('ast-chunker-v2');

    // Chunks exist in corpus under the new profile ID
    const chunksV2 = await corpusStore.getChunksForSnapshot('ast-chunker-v2', rev2!.documents[0]!.snapshotId);
    expect(chunksV2).not.toBeNull();
    expect(chunksV2.length).toBeGreaterThan(0);
  });
});
