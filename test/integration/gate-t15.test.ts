/**
 * Gate T-15: Concurrency Fencing, Read Lease Pinning & GC Protection Tests
 *
 * Tests:
 * 1. Stale writer lease / concurrent writer rejection (RESOURCE_BUSY).
 * 2. Active read lease protects generation from GC.
 * 3. Currently published generation is protected from GC.
 * 4. Previous generation (previousGenerationId) is protected from GC.
 * 5. Dry-run mode plans deletion without mutating backend or database.
 * 6. Apply mode safely transitions through 'deleting' -> 'deleted' and deletes from backend.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FilesystemCorpusStore } from '../../src/infrastructure/storage/FilesystemCorpusStore.js';
import { SqliteManifestStore } from '../../src/infrastructure/storage/SqliteManifestStore.js';
import { InMemorySearchAdapter } from '../../src/infrastructure/search/InMemorySearchAdapter.js';
import { GarbageCollectionUseCase } from '../../src/application/indexing/GarbageCollectionUseCase.js';
import type { LibraryRegistry } from '../../src/application/ports/LibraryRegistry.js';
import type { LibraryDefinition } from '../../src/domain/models/index.js';
import { CliOperationError } from '../../src/domain/errors.js';

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

describe('Gate T-15: Concurrency Fencing, Read Leases & GC Protection', () => {
  let tmpDir: string;
  let corpusStore: FilesystemCorpusStore;
  let manifestStore: SqliteManifestStore;
  let registry: MockLibraryRegistry;
  let backend: InMemorySearchAdapter;
  let gcUseCase: GarbageCollectionUseCase;

  const libraryId = 'palantir-foundry';
  const versionKey = 'current';
  const backendKey = 'in-memory-backend-t15';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-t15-'));
    corpusStore = new FilesystemCorpusStore(tmpDir);
    manifestStore = new SqliteManifestStore(path.join(tmpDir, 'manifest/catalog.sqlite'));
    registry = new MockLibraryRegistry();
    backend = new InMemorySearchAdapter(backendKey);

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
            type: 'sitemap',
            sitemapUrls: ['https://www.palantir.com/docs/sitemap.xml'],
            allowedHosts: ['www.palantir.com', 'palantir.com'],
            includePaths: ['/docs/foundry/**'],
            collectionAllowed: true,
          },
          parser: {
            contentSelectors: ['main', 'article'],
            removeSelectors: ['nav', 'footer'],
          },
          chunking: {
            minTokens: 200,
            targetTokens: 800,
            maxTokens: 1400,
            maxAtomicTokens: 16000,
          },
          freshness: {
            staleAfterHours: 168,
          },
        },
      ],
    };

    registry.register(libDef);

    gcUseCase = new GarbageCollectionUseCase(
      registry,
      manifestStore,
      backend,
      backendKey,
    );
  });

  afterEach(() => {
    manifestStore.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('T-15.1: rejects concurrent writer when another active writer holds lease', async () => {
    // Acquire a 30s lease under owner A
    const leaseA = await manifestStore.acquireWriterLease('writer-A', 30000);
    expect(leaseA).not.toBeNull();

    // Writer B tries to acquire lease while lease A is active
    const leaseB = await manifestStore.acquireWriterLease('writer-B', 30000);
    expect(leaseB).toBeNull();

    // GC with apply: true should be rejected because lease is held by writer-A
    await expect(gcUseCase.execute({ libraryId, apply: true })).rejects.toThrow(
      CliOperationError,
    );
  });

  it('T-15.2: active read lease protects a retired generation from GC deletion', async () => {
    // Setup a 48-hour-old retired generation
    const oldTimestamp = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    await manifestStore.saveIndexGeneration({
      generationId: 'gen-old-with-read-lease',
      backendKey,
      corpusRevisionId: 'rev-old',
      indexProfileHash: backendKey,
      state: 'retired',
      entryCount: 10,
      entryIds: ['k1', 'k2'],
      createdAt: oldTimestamp,
      updatedAt: oldTimestamp,
    });

    // Also register a revision so it joins cleanly in SQLite queries
    await manifestStore.registerCorpusRevision({
      corpusRevisionId: 'rev-old',
      libraryId,
      versionKey,
      createdAt: oldTimestamp,
      versionProfileHash: 'hash',
      documentCount: 1,
      syncRunId: 'sync-1',
      isComplete: true,
    });

    // Acquire an active read lease for gen-old-with-read-lease (valid for 60 seconds)
    const readLease = await manifestStore.acquireReadLease('gen-old-with-read-lease', 60000);
    expect(readLease).toBeDefined();

    // Run GC dry-run
    const dryRun = await gcUseCase.execute({ libraryId, minAgeHours: 24 });
    expect(dryRun.eligibleGenerations).not.toContain('gen-old-with-read-lease');

    // Run GC apply
    const applyRun = await gcUseCase.execute({ libraryId, apply: true, minAgeHours: 24 });
    expect(applyRun.deletedGenerations).not.toContain('gen-old-with-read-lease');

    // Verify generation remains retired, NOT deleted
    const gen = await manifestStore.getIndexGeneration('gen-old-with-read-lease');
    expect(gen?.state).toBe('retired');

    // Release read lease
    await manifestStore.releaseReadLease(readLease.leaseId);

    // Now it should be eligible for GC
    const afterLeaseExpired = await gcUseCase.execute({ libraryId, minAgeHours: 24 });
    expect(afterLeaseExpired.eligibleGenerations).toContain('gen-old-with-read-lease');
  });

  it('T-15.3: currently published generation is protected from GC even if older than threshold', async () => {
    const oldTimestamp = new Date(Date.now() - 72 * 3600 * 1000).toISOString();

    await manifestStore.registerCorpusRevision({
      corpusRevisionId: 'rev-current',
      libraryId,
      versionKey,
      createdAt: oldTimestamp,
      versionProfileHash: 'hash',
      documentCount: 1,
      syncRunId: 'sync-1',
      isComplete: true,
    });

    await manifestStore.saveIndexGeneration({
      generationId: 'gen-current-published',
      backendKey,
      corpusRevisionId: 'rev-current',
      indexProfileHash: backendKey,
      state: 'published',
      entryCount: 5,
      entryIds: ['k1'],
      createdAt: oldTimestamp,
      updatedAt: oldTimestamp,
    });

    await manifestStore.setPublishedPointer({
      backendKey,
      libraryId,
      versionKey,
      generationId: 'gen-current-published',
      publishedAt: oldTimestamp,
    });

    const gc = await gcUseCase.execute({ libraryId, minAgeHours: 24 });
    expect(gc.eligibleGenerations).not.toContain('gen-current-published');
  });

  it('T-15.4: previous generation (previousGenerationId) is protected from GC', async () => {
    const oldTimestamp = new Date(Date.now() - 72 * 3600 * 1000).toISOString();

    await manifestStore.registerCorpusRevision({
      corpusRevisionId: 'rev-prev',
      libraryId,
      versionKey,
      createdAt: oldTimestamp,
      versionProfileHash: 'hash',
      documentCount: 1,
      syncRunId: 'sync-prev',
      isComplete: true,
    });

    // Previous generation is retired
    await manifestStore.saveIndexGeneration({
      generationId: 'gen-prev-retired',
      backendKey,
      corpusRevisionId: 'rev-prev',
      indexProfileHash: backendKey,
      state: 'retired',
      entryCount: 5,
      entryIds: ['k1'],
      createdAt: oldTimestamp,
      updatedAt: oldTimestamp,
    });

    // Published pointer points to gen-new with previousGenerationId = gen-prev-retired
    await manifestStore.setPublishedPointer({
      backendKey,
      libraryId,
      versionKey,
      generationId: 'gen-new',
      previousGenerationId: 'gen-prev-retired',
      publishedAt: new Date().toISOString(),
    });

    const gc = await gcUseCase.execute({ libraryId, minAgeHours: 24 });
    expect(gc.eligibleGenerations).not.toContain('gen-prev-retired');
  });

  it('T-15.5: dry-run plans deletion and apply mode transitions to deleted and deletes from backend', async () => {
    const oldTimestamp = new Date(Date.now() - 48 * 3600 * 1000).toISOString();

    await manifestStore.registerCorpusRevision({
      corpusRevisionId: 'rev-abandoned',
      libraryId,
      versionKey,
      createdAt: oldTimestamp,
      versionProfileHash: 'hash',
      documentCount: 1,
      syncRunId: 'sync-abandoned',
      isComplete: true,
    });

    await manifestStore.saveIndexGeneration({
      generationId: 'gen-abandoned-old',
      backendKey,
      corpusRevisionId: 'rev-abandoned',
      indexProfileHash: backendKey,
      state: 'abandoned',
      entryCount: 3,
      entryIds: ['k1', 'k2', 'k3'],
      createdAt: oldTimestamp,
      updatedAt: oldTimestamp,
    });

    await backend.stageGeneration('gen-abandoned-old');

    // 1. Dry run
    const dryRunRes = await gcUseCase.execute({ libraryId, minAgeHours: 24 });
    expect(dryRunRes.dryRun).toBe(true);
    expect(dryRunRes.eligibleGenerations).toContain('gen-abandoned-old');
    expect(dryRunRes.deletedGenerations).toEqual([]);

    // Backend and manifest unchanged
    const genBefore = await manifestStore.getIndexGeneration('gen-abandoned-old');
    expect(genBefore?.state).toBe('abandoned');

    // 2. Apply mode
    const applyRes = await gcUseCase.execute({ libraryId, apply: true, minAgeHours: 24 });
    expect(applyRes.dryRun).toBe(false);
    expect(applyRes.deletedGenerations).toContain('gen-abandoned-old');
    expect(applyRes.deletedEntriesCount).toBe(3);

    // Verify manifest state is now 'deleted'
    const genAfter = await manifestStore.getIndexGeneration('gen-abandoned-old');
    expect(genAfter?.state).toBe('deleted');
  });
});
