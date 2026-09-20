import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SyncUseCase } from '../../src/application/sync/SyncUseCase.js';
import { runSyncCommand } from '../../src/interfaces/cli/commands/sync.js';
import { FilesystemCorpusStore } from '../../src/infrastructure/storage/FilesystemCorpusStore.js';
import { SqliteManifestStore } from '../../src/infrastructure/storage/SqliteManifestStore.js';
import { HtmlDocumentNormalizer } from '../../src/infrastructure/parsing/HtmlDocumentNormalizer.js';
import { MarkdownAstChunker } from '../../src/infrastructure/parsing/MarkdownAstChunker.js';
import { TiktokenCounter } from '../../src/infrastructure/tokens/TiktokenCounter.js';
import { SitemapSourceProvider } from '../../src/infrastructure/source/SitemapSourceProvider.js';
import { HttpDocumentFetcher } from '../../src/infrastructure/fetch/HttpDocumentFetcher.js';
import { SsrfValidator } from '../../src/infrastructure/fetch/SsrfValidator.js';
import type { LibraryRegistry } from '../../src/application/ports/LibraryRegistry.js';
import type { LibraryDefinition, PublishedPointer } from '../../src/domain/models/index.js';

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

describe('Gate T-06 Integration Tests: docsctx sync and Published Pointer Isolation', () => {
  let tmpDir: string;
  let corpusStore: FilesystemCorpusStore;
  let manifestStore: SqliteManifestStore;
  let registry: MockLibraryRegistry;
  let syncUseCase: SyncUseCase;

  const libraryId = 'palantir-foundry';
  const versionKey = 'current';
  const backendKey = 'google-agent-search-backend-1';

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-t06-'));
    corpusStore = new FilesystemCorpusStore(tmpDir);
    manifestStore = new SqliteManifestStore(path.join(tmpDir, 'manifest/catalog.sqlite'));
    registry = new MockLibraryRegistry();

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
      return new Response(
        `<main><h1>Doc at ${url}</h1><p>Palantir Foundry canonical content.</p></main>`,
        {
          status: 200,
          headers: { 'Content-Type': 'text/html', ETag: '"foundry-v1"' },
        },
      );
    };

    const documentFetcher = new HttpDocumentFetcher({ ssrfValidator, customFetch: mockFetch });
    const normalizer = new HtmlDocumentNormalizer();
    const tokenCounter = new TiktokenCounter();
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
  });

  afterEach(() => {
    manifestStore.close();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('Gate T-06: docsctx sync creates new revision while published search pointer remains unchanged', async () => {
    // 1. Establish an existing published search pointer
    const initialPointer: PublishedPointer = {
      backendKey,
      libraryId,
      versionKey,
      generationId: 'gen-published-baseline-001',
      previousGenerationId: undefined,
      publishedAt: '2026-09-01T00:00:00.000Z',
    };
    await manifestStore.setPublishedPointer(initialPointer);

    const pointerBeforeSync = await manifestStore.getPublishedPointer(backendKey, libraryId, versionKey);
    expect(pointerBeforeSync).toEqual(initialPointer);

    // 2. Execute docsctx sync
    const syncResult = await syncUseCase.execute({ libraryId });
    expect(syncResult.status).toBe('complete');
    expect(syncResult.storedCount).toBe(2);
    expect(syncResult.corpusRevisionId).toBeDefined();

    // 3. Verify a new corpus revision exists in CorpusStore and ManifestStore
    const newRevision = await corpusStore.getRevision(syncResult.corpusRevisionId);
    expect(newRevision).toBeDefined();
    expect(newRevision!.documents.length).toBe(2);

    const latestRevisionMeta = await manifestStore.getLatestCorpusRevision(libraryId, versionKey);
    expect(latestRevisionMeta).toBeDefined();
    expect(latestRevisionMeta!.corpusRevisionId).toBe(syncResult.corpusRevisionId);

    // 4. Verify published search pointer has NOT changed (Gate T-06 core guarantee)
    const pointerAfterSync = await manifestStore.getPublishedPointer(backendKey, libraryId, versionKey);
    expect(pointerAfterSync).toEqual(pointerBeforeSync);
    expect(pointerAfterSync!.generationId).toBe('gen-published-baseline-001');
    expect(pointerAfterSync!.publishedAt).toBe('2026-09-01T00:00:00.000Z');
  });

  it('Gate T-06: CLI runSyncCommand logs to stderr, outputs JSON summary to stdout, and leaves published pointer untouched', async () => {
    const initialPointer: PublishedPointer = {
      backendKey,
      libraryId,
      versionKey,
      generationId: 'gen-published-cli-002',
      publishedAt: '2026-09-05T12:00:00.000Z',
    };
    await manifestStore.setPublishedPointer(initialPointer);

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const origStdoutWrite = process.stdout.write;
    const origStderrWrite = process.stderr.write;

    process.stdout.write = ((chunk: any) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as any;

    process.stderr.write = ((chunk: any) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as any;

    let exitCode: number;
    try {
      exitCode = await runSyncCommand({
        syncUseCase,
        libraryId,
        versionKey,
      });
    } finally {
      process.stdout.write = origStdoutWrite;
      process.stderr.write = origStderrWrite;
    }

    expect(exitCode).toBe(0);

    // Stdout must contain valid JSON summary
    const stdoutOutput = stdoutChunks.join('');
    const parsedSummary = JSON.parse(stdoutOutput);
    expect(parsedSummary.status).toBe('complete');
    expect(parsedSummary.libraryId).toBe(libraryId);
    expect(parsedSummary.corpusRevisionId).toBeDefined();

    // Stderr must contain progress logs
    const stderrOutput = stderrChunks.join('');
    expect(stderrOutput).toContain('[docsctx sync]');

    // Published pointer still unchanged
    const pointerAfterCli = await manifestStore.getPublishedPointer(backendKey, libraryId, versionKey);
    expect(pointerAfterCli!.generationId).toBe('gen-published-cli-002');
  });
});
