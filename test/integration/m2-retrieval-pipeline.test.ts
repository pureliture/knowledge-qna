import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SyncUseCase } from '../../src/application/sync/SyncUseCase.js';
import { IndexUseCase } from '../../src/application/indexing/IndexUseCase.js';
import { GetContextUseCase } from '../../src/application/retrieval/get-context.js';
import { runSearchCommand } from '../../src/interfaces/cli/commands/search.js';
import { runIndexCommand } from '../../src/interfaces/cli/commands/index.js';
import { FilesystemCorpusStore } from '../../src/infrastructure/storage/FilesystemCorpusStore.js';
import { SqliteManifestStore } from '../../src/infrastructure/storage/SqliteManifestStore.js';
import { HtmlDocumentNormalizer } from '../../src/infrastructure/parsing/HtmlDocumentNormalizer.js';
import { MarkdownAstChunker } from '../../src/infrastructure/parsing/MarkdownAstChunker.js';
import { TiktokenCounter } from '../../src/infrastructure/tokens/TiktokenCounter.js';
import { SitemapSourceProvider } from '../../src/infrastructure/source/SitemapSourceProvider.js';
import { HttpDocumentFetcher } from '../../src/infrastructure/fetch/HttpDocumentFetcher.js';
import { SsrfValidator } from '../../src/infrastructure/fetch/SsrfValidator.js';
import { InMemorySearchAdapter } from '../../src/infrastructure/search/InMemorySearchAdapter.js';
import type { LibraryRegistry } from '../../src/application/ports/LibraryRegistry.js';
import type { LibraryDefinition } from '../../src/domain/models/index.js';

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

  async resolveLibrary() {
    throw new Error('Not implemented');
  }
}

describe('M2 Retrieval Pipeline Integration (Gates T-10, T-11, T-12)', () => {
  let tmpDir: string;
  let corpusStore: FilesystemCorpusStore;
  let manifestStore: SqliteManifestStore;
  let registry: MockLibraryRegistry;
  let searchAdapter: InMemorySearchAdapter;
  let tokenCounter: TiktokenCounter;
  let syncUseCase: SyncUseCase;
  let indexUseCase: IndexUseCase;
  let getContextUseCase: GetContextUseCase;

  const libraryId = 'palantir-foundry';
  const versionKey = 'current';
  const backendKey = 'test-in-memory-backend';

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm2-pipeline-'));
    corpusStore = new FilesystemCorpusStore(tmpDir);
    manifestStore = new SqliteManifestStore(path.join(tmpDir, 'manifest/catalog.sqlite'));
    registry = new MockLibraryRegistry();
    searchAdapter = new InMemorySearchAdapter(backendKey);
    tokenCounter = new TiktokenCounter();

    const libDef: LibraryDefinition = {
      schemaVersion: 1,
      id: libraryId,
      name: 'Palantir Foundry',
      defaultVersionKey: versionKey,
      versions: [
        {
          versionKey,
          strategy: 'rolling',
          source: {
            type: 'static',
            urls: [
              'https://www.palantir.com/docs/foundry/ontology/overview',
              'https://www.palantir.com/docs/foundry/transforms/python',
            ],
            allowedHosts: ['www.palantir.com'],
            includePaths: ['/docs/foundry/**'],
            collectionAllowed: true,
          },
          parser: {
            contentSelectors: ['main', 'article'],
            removeSelectors: ['nav', 'footer', 'script', 'style'],
          },
          chunking: {
            minTokens: 50,
            targetTokens: 200,
            maxTokens: 600,
            maxAtomicTokens: 16000,
          },
          freshness: {
            staleAfterHours: 24,
          },
        },
      ],
    };
    registry.register(libDef);

    const ssrfValidator = new SsrfValidator(async () => ['93.184.216.34']);
    const sourceProvider = new SitemapSourceProvider({ ssrfValidator });

    const mockFetch: typeof fetch = async (input) => {
      const url = input.toString();
      if (url.includes('ontology')) {
        return new Response(
          `<main>
            <h1 id="overview">Ontology in Palantir Foundry</h1>
            <p>Object types define entities in the ontology with properties, links, and actions.</p>
          </main>`,
          { status: 200, headers: { 'Content-Type': 'text/html', ETag: '"ont-1"' } },
        );
      } else {
        return new Response(
          `<main>
            <h1>Python Transforms</h1>
            <h2 id="batch-pipelines">Batch Pipelines</h2>
            <p>Python transforms process datasets incrementally on Spark clusters.</p>
          </main>`,
          { status: 200, headers: { 'Content-Type': 'text/html', ETag: '"tr-1"' } },
        );
      }
    };

    const documentFetcher = new HttpDocumentFetcher({ ssrfValidator, customFetch: mockFetch });
    const normalizer = new HtmlDocumentNormalizer();
    const chunker = new MarkdownAstChunker(tokenCounter);

    syncUseCase = new SyncUseCase(
      registry,
      manifestStore,
      corpusStore,
      sourceProvider,
      documentFetcher,
      normalizer,
      chunker,
    );

    indexUseCase = new IndexUseCase(
      registry,
      manifestStore,
      corpusStore,
      searchAdapter,
      backendKey,
    );

    getContextUseCase = new GetContextUseCase(
      registry,
      manifestStore,
      corpusStore,
      searchAdapter,
      tokenCounter,
      backendKey,
    );
  });

  afterEach(() => {
    manifestStore.close();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('runs complete end-to-end flow: sync -> index -> get_context with verified citations and budget', async () => {
    // 1. Sync
    const syncRes = await syncUseCase.execute({ libraryId });
    expect(syncRes.status).toBe('complete');
    expect(syncRes.corpusRevisionId).toBeDefined();

    // 2. Index
    const indexRes = await indexUseCase.execute({ libraryId });
    expect(indexRes.state).toBe('published');
    expect(indexRes.entryCount).toBeGreaterThan(0);
    expect(indexRes.generationId).toBeDefined();

    // Verify published pointer in SQLite manifest
    const pointer = await manifestStore.getPublishedPointer(backendKey, libraryId, versionKey);
    expect(pointer).toBeDefined();
    expect(pointer!.generationId).toBe(indexRes.generationId);

    // 3. Get Context
    const contextRes = await getContextUseCase.execute({
      libraryId,
      query: 'Object Types in Ontology',
      maxTokens: 4000,
    });

    expect(contextRes.status).toBe('ok');
    expect(contextRes.sources.length).toBeGreaterThan(0);
    expect(contextRes.sources[0]!.id).toBe('S1');
    expect(contextRes.sources[0]!.url).toContain('https://www.palantir.com/docs/foundry/ontology/overview');
    // Anchor verified against document headings
    expect(contextRes.sources[0]!.url).toContain('#overview');

    // Verify formatted markdown context
    expect(contextRes.context).toContain('# Documentation Context');
    expect(contextRes.context).toContain('## Sources');
    expect(contextRes.context).toContain('- [S1]');
    expect(contextRes.context).toContain('### [S1]');
    expect(contextRes.budget.usedTokens).toBe(tokenCounter.count(contextRes.context));
    expect(contextRes.budget.usedTokens).toBeLessThanOrEqual(4000);
    expect(contextRes.freshness.stale).toBe(false);
  });

  it('returns status: no_matches when query matches zero documents', async () => {
    await syncUseCase.execute({ libraryId });
    await indexUseCase.execute({ libraryId });

    const contextRes = await getContextUseCase.execute({
      libraryId,
      query: 'zzzznonexistentqueryterm12345',
      maxTokens: 4000,
    });

    expect(contextRes.status).toBe('no_matches');
    expect(contextRes.context).toBe('');
    expect(contextRes.sources).toEqual([]);
    expect(contextRes.budget.usedTokens).toBe(0);
    expect(contextRes.budget.truncated).toBe(false);
  });

  it('Gate T-12: reconstructs corpus and search index completely offline without network', async () => {
    // 1. Initial sync and index to populate corpus on disk
    await syncUseCase.execute({ libraryId });
    const initialIndex = await indexUseCase.execute({ libraryId });

    // 2. Simulate complete network disconnection and new adapter instance
    const offlineAdapter = new InMemorySearchAdapter('offline-backend');

    const offlineIndexUseCase = new IndexUseCase(
      registry,
      manifestStore,
      corpusStore,
      offlineAdapter,
      'offline-backend',
    );

    const offlineGetContextUseCase = new GetContextUseCase(
      registry,
      manifestStore,
      corpusStore,
      offlineAdapter,
      tokenCounter,
      'offline-backend',
    );

    // 3. Reconstruct index from local disk corpus files using IndexUseCase
    const offlineIndexRes = await offlineIndexUseCase.execute({ libraryId, rebuild: true });
    expect(offlineIndexRes.state).toBe('published');
    expect(offlineIndexRes.entryCount).toBe(initialIndex.entryCount);

    // 4. Perform search retrieval offline
    const res = await offlineGetContextUseCase.execute({
      libraryId,
      query: 'Python Transforms Batch',
    });

    expect(res.status).toBe('ok');
    expect(res.sources.length).toBeGreaterThan(0);
    expect(res.sources[0]!.url).toContain('/transforms/python');
    expect(res.context).toContain('Batch Pipelines');
  });

  it('CLI commands (docsctx search and docsctx index) work cleanly with stdout/stderr separation', async () => {
    await syncUseCase.execute({ libraryId });

    // Test index CLI
    const stdoutChunksIndex: string[] = [];
    const stderrChunksIndex: string[] = [];
    const origStdout = process.stdout.write;
    const origStderr = process.stderr.write;

    process.stdout.write = ((chunk: any) => {
      stdoutChunksIndex.push(String(chunk));
      return true;
    }) as any;
    process.stderr.write = ((chunk: any) => {
      stderrChunksIndex.push(String(chunk));
      return true;
    }) as any;

    let indexExit: number;
    try {
      indexExit = await runIndexCommand({
        indexUseCase,
        libraryId,
        plan: true,
      });
    } finally {
      process.stdout.write = origStdout;
      process.stderr.write = origStderr;
    }

    expect(indexExit).toBe(0);
    const planJson = JSON.parse(stdoutChunksIndex.join(''));
    expect(planJson.plan).toBeDefined();
    expect(stderrChunksIndex.join('')).toContain('[docsctx index]');

    // Now execute real index for search command test
    await indexUseCase.execute({ libraryId });

    // Test search CLI
    const stdoutChunksSearch: string[] = [];
    const stderrChunksSearch: string[] = [];

    process.stdout.write = ((chunk: any) => {
      stdoutChunksSearch.push(String(chunk));
      return true;
    }) as any;
    process.stderr.write = ((chunk: any) => {
      stderrChunksSearch.push(String(chunk));
      return true;
    }) as any;

    let searchExit: number;
    try {
      searchExit = await runSearchCommand({
        getContextUseCase,
        libraryId,
        query: 'Object Types',
      });
    } finally {
      process.stdout.write = origStdout;
      process.stderr.write = origStderr;
    }

    expect(searchExit).toBe(0);
    const searchJson = JSON.parse(stdoutChunksSearch.join(''));
    expect(searchJson.status).toBe('ok');
    expect(searchJson.context).toContain('# Documentation Context');
    expect(stderrChunksSearch.join('')).toContain('[docsctx search]');
  });
});
