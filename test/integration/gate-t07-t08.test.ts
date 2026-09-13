/**
 * Gate T-07 and Gate T-08 Integration Tests
 *
 * Gate T-07: Index Generation Lifecycle & Pointer Immutability
 * - Full generation journaling: Doc A changes, Doc B unchanged -> G2 includes both A and B.
 * - Failure of G2 leaves G1 published pointer completely intact.
 * - Successful publish of G2 retires G1 (marked 'retired', not deleted).
 * - Queries strictly pinned to single generation.
 *
 * Gate T-08: Partial Failure, Timeout, Crash Recovery, Resume & Abandon
 * - Partial batch import failure tracks failed entries and permits resume.
 * - Readiness timeout sets state to 'readiness_pending' with exit code 2.
 * - Pending un-finished run blocks accidental concurrent run (INDEX_RUN_PENDING).
 * - Abandoning un-finished run transitions it to 'abandoned'.
 * - Superseded run detection prevents resuming outdated runs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FilesystemCorpusStore } from '../../src/infrastructure/storage/FilesystemCorpusStore.js';
import { SqliteManifestStore } from '../../src/infrastructure/storage/SqliteManifestStore.js';
import { InMemorySearchAdapter } from '../../src/infrastructure/search/InMemorySearchAdapter.js';
import { IndexUseCase } from '../../src/application/indexing/IndexUseCase.js';
import { GetContextUseCase } from '../../src/application/retrieval/get-context.js';
import { TiktokenCounter } from '../../src/infrastructure/tokens/TiktokenCounter.js';
import type { LibraryRegistry } from '../../src/application/ports/LibraryRegistry.js';
import type {
  LibraryDefinition,
  NormalizedDocument,
  Chunk,
  CorpusRevisionManifest,
} from '../../src/domain/models/index.js';
import { CliOperationError } from '../../src/domain/errors.js';
import {
  computeDocumentId,
  computeSnapshotId,
  computeNormalizedHash,
  computeChunkId,
  sha256Hex,
} from '../../src/domain/identity.js';

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

describe('Gate T-07 & T-08: Index Lifecycle, Recovery, and Resilience', () => {
  let tmpDir: string;
  let corpusStore: FilesystemCorpusStore;
  let manifestStore: SqliteManifestStore;
  let registry: MockLibraryRegistry;
  let backend: InMemorySearchAdapter;
  let indexUseCase: IndexUseCase;
  let tokenCounter: TiktokenCounter;

  const libraryId = 'palantir-foundry';
  const versionKey = 'current';
  const backendKey = 'in-memory-backend-t07-t08';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-t07-t08-'));
    corpusStore = new FilesystemCorpusStore(tmpDir);
    manifestStore = new SqliteManifestStore(path.join(tmpDir, 'manifest/catalog.sqlite'));
    registry = new MockLibraryRegistry();
    backend = new InMemorySearchAdapter(backendKey);
    tokenCounter = new TiktokenCounter('cl100k_base');

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
          readinessQueries: ['Doc A', 'Doc B'],
        },
      ],
    };

    registry.register(libDef);

    indexUseCase = new IndexUseCase(
      registry,
      manifestStore,
      corpusStore,
      backend,
      backendKey,
    );
  });

  afterEach(() => {
    manifestStore.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createCorpusRevision(
    revId: string,
    docs: Array<{ docId: string; snapId: string; title: string; content: string }>,
  ) {
    const docEntries: Array<{ documentId: string; snapshotId: string; chunkerProfileId: string }> = [];

    for (const d of docs) {
      const canonicalUrl = `https://www.palantir.com/docs/foundry/${d.docId}`;
      const realDocId = computeDocumentId(libraryId, versionKey, canonicalUrl);
      const markdown = `# ${d.title}\n\n${d.content}`;
      const headings = [{ level: 1, text: d.title, path: [d.title] }];
      const normalizedHash = computeNormalizedHash({
        title: d.title,
        markdown,
        headings,
        metadata: {},
      });
      const normalizerProfileId = 'html-normalizer-v1';
      const realSnapshotId = computeSnapshotId(realDocId, normalizerProfileId, normalizedHash);

      const normDoc: NormalizedDocument = {
        schemaVersion: 1,
        documentId: realDocId,
        snapshotId: realSnapshotId,
        libraryId,
        versionKey,
        canonicalUrl,
        title: d.title,
        markdown,
        headings,
        normalizedHash,
        normalizerProfileId,
        metadata: {},
      };
      await corpusStore.saveDocument(normDoc);

      const chunkIndex = 0;
      const headingPath = [d.title];
      const contentHash = sha256Hex(d.content);
      const chunkId = computeChunkId(realSnapshotId, 'chunker-v1', chunkIndex, headingPath, d.content);

      const chunk: Chunk = {
        chunkId,
        documentId: realDocId,
        snapshotId: realSnapshotId,
        chunkerProfileId: 'chunker-v1',
        chunkIndex,
        headingPath,
        title: d.title,
        content: d.content,
        tokenCount: 50,
        contentHash,
        hasCode: false,
      };
      await corpusStore.saveChunks('chunker-v1', realSnapshotId, [chunk]);

      docEntries.push({
        documentId: realDocId,
        snapshotId: realSnapshotId,
        chunkerProfileId: 'chunker-v1',
        chunkIds: [chunkId],
      });
    }

    const revManifest: CorpusRevisionManifest = {
      corpusRevisionId: revId,
      libraryId,
      versionKey,
      createdAt: new Date().toISOString(),
      versionProfileHash: 'profile-v1',
      documents: docEntries,
    };
    await corpusStore.saveRevision(revManifest);

    await manifestStore.registerCorpusRevision({
      corpusRevisionId: revId,
      libraryId,
      versionKey,
      createdAt: revManifest.createdAt,
      versionProfileHash: 'profile-v1',
      documentCount: docs.length,
      syncRunId: `sync-${revId}`,
      isComplete: true,
    });
  }

  describe('Gate T-07: Full Generation Journaling & Atomic Transition', () => {
    it('G2 includes unchanged document B chunks when only document A is modified', async () => {
      // 1. Setup Rev 1 with Doc A (snap-1a) and Doc B (snap-1b)
      await createCorpusRevision('rev-1', [
        { docId: 'doc-a', snapId: 'snap-1a', title: 'Doc A v1', content: 'Doc A original content' },
        { docId: 'doc-b', snapId: 'snap-1b', title: 'Doc B unchanged', content: 'Doc B persistent content' },
      ]);

      // 2. Publish G1
      const resG1 = await indexUseCase.execute({ libraryId });
      expect(resG1.state).toBe('published');
      expect(resG1.entryCount).toBe(2);
      const g1Id = resG1.generationId;

      const genG1 = await manifestStore.getIndexGeneration(g1Id);
      expect(genG1?.state).toBe('published');
      expect(genG1?.entryCount).toBe(2);

      // 3. Setup Rev 2: Doc A modified to snap-2a, Doc B remains snap-1b
      await createCorpusRevision('rev-2', [
        { docId: 'doc-a', snapId: 'snap-2a', title: 'Doc A v2', content: 'Doc A updated content' },
        { docId: 'doc-b', snapId: 'snap-1b', title: 'Doc B unchanged', content: 'Doc B persistent content' },
      ]);

      // 4. Publish G2
      const resG2 = await indexUseCase.execute({ libraryId, rebuild: true });
      expect(resG2.state).toBe('published');
      expect(resG2.entryCount).toBe(2);
      const g2Id = resG2.generationId;
      expect(g2Id).not.toBe(g1Id);

      // 5. Verify G2 contains both Doc A v2 and Doc B chunks (Full generation journaling)
      const genG2 = await manifestStore.getIndexGeneration(g2Id);
      expect(genG2?.state).toBe('published');
      expect(genG2?.entryCount).toBe(2);

      // 6. Verify G1 is now marked retired, not deleted
      const genG1After = await manifestStore.getIndexGeneration(g1Id);
      expect(genG1After?.state).toBe('retired');

      // 7. Verify published pointer points to G2 with previousGenerationId = G1
      const pointer = await manifestStore.getPublishedPointer(backendKey, libraryId, versionKey);
      expect(pointer?.generationId).toBe(g2Id);
      expect(pointer?.previousGenerationId).toBe(g1Id);
    });

    it('preserves G1 published pointer if G2 fails during indexing', async () => {
      // 1. Publish G1
      await createCorpusRevision('rev-1', [
        { docId: 'doc-a', snapId: 'snap-1a', title: 'Doc A', content: 'Doc A content' },
      ]);
      const resG1 = await indexUseCase.execute({ libraryId });
      expect(resG1.state).toBe('published');
      const g1Id = resG1.generationId;

      // 2. Setup Rev 2
      await createCorpusRevision('rev-2', [
        { docId: 'doc-a', snapId: 'snap-2a', title: 'Doc A v2', content: 'Doc A v2 content' },
      ]);

      // 3. Mock backend to fail during importBatch
      const originalImport = backend.importBatch.bind(backend);
      backend.importBatch = vi.fn().mockResolvedValueOnce({
        importedCount: 0,
        failedIds: ['some-failed-id'],
      });

      // 4. Execute index on Rev 2 - should throw CliOperationError
      await expect(indexUseCase.execute({ libraryId, rebuild: true })).rejects.toThrow(
        CliOperationError,
      );

      // 5. Verify published pointer is STILL G1!
      const pointer = await manifestStore.getPublishedPointer(backendKey, libraryId, versionKey);
      expect(pointer?.generationId).toBe(g1Id);

      const genG1 = await manifestStore.getIndexGeneration(g1Id);
      expect(genG1?.state).toBe('published');

      backend.importBatch = originalImport;
    });

    it('enforces single generation pinning for retrieval', async () => {
      await createCorpusRevision('rev-1', [
        { docId: 'doc-a', snapId: 'snap-1a', title: 'Doc A Foundry Guide', content: 'Platform details' },
      ]);
      await indexUseCase.execute({ libraryId });

      const getContext = new GetContextUseCase(
        registry,
        manifestStore,
        corpusStore,
        backend,
        tokenCounter,
        backendKey,
      );

      const ctxResult = await getContext.execute({
        libraryId,
        query: 'Platform details',
      });

      expect(ctxResult.sources.length).toBeGreaterThan(0);
      const pointer = await manifestStore.getPublishedPointer(backendKey, libraryId, versionKey);
      expect(ctxResult.generationId).toBe(pointer?.generationId);
    });
  });

  describe('Gate T-08: Partial Failure, Timeout, Pending Collisions, Resume & Abandon', () => {
    it('detects pending un-finished run and rejects concurrent run with INDEX_RUN_PENDING', async () => {
      await createCorpusRevision('rev-1', [
        { docId: 'doc-a', snapId: 'snap-1a', title: 'Doc A', content: 'Content A' },
      ]);

      // Manually insert an un-finished run in staging state
      await manifestStore.saveIndexGeneration({
        generationId: 'pending-run-123',
        backendKey,
        corpusRevisionId: 'rev-1',
        indexProfileHash: backendKey,
        state: 'staging',
        entryCount: 1,
        entryIds: ['k123'],
      });

      // Attempting to run index should throw INDEX_RUN_PENDING
      try {
        await indexUseCase.execute({ libraryId });
        expect.fail('Should have thrown INDEX_RUN_PENDING');
      } catch (err) {
        expect(err).toBeInstanceOf(CliOperationError);
        const cliErr = err as CliOperationError;
        expect(cliErr.code).toBe('INDEX_RUN_PENDING');
        expect(cliErr.runId).toBe('pending-run-123');
        expect(cliErr.exitCode).toBe(1);
      }
    });

    it('abandons un-finished run with --abandon <runId>', async () => {
      await createCorpusRevision('rev-1', [
        { docId: 'doc-a', snapId: 'snap-1a', title: 'Doc A', content: 'Content A' },
      ]);

      await manifestStore.saveIndexGeneration({
        generationId: 'abandon-me-456',
        backendKey,
        corpusRevisionId: 'rev-1',
        indexProfileHash: backendKey,
        state: 'importing',
        entryCount: 1,
        entryIds: ['k123'],
      });

      const abandonRes = await indexUseCase.execute({
        libraryId,
        abandonRunId: 'abandon-me-456',
      });

      expect(abandonRes.state).toBe('abandoned');
      expect(abandonRes.generationId).toBe('abandon-me-456');

      const saved = await manifestStore.getIndexGeneration('abandon-me-456');
      expect(saved?.state).toBe('abandoned');

      // Now a new index run can proceed without pending conflict
      const newRun = await indexUseCase.execute({ libraryId });
      expect(newRun.state).toBe('published');
    });

    it('handles readiness verification timeout with state READINESS_PENDING and exitCode 2', async () => {
      await createCorpusRevision('rev-1', [
        { docId: 'doc-a', snapId: 'snap-1a', title: 'Doc A', content: 'Content A' },
      ]);

      // Mock verifyReadiness to return pending
      const origVerify = backend.verifyReadiness.bind(backend);
      backend.verifyReadiness = vi.fn().mockResolvedValue({
        state: 'pending',
        expectedCount: 1,
        indexedCount: 0,
        missingIds: [],
        failedProbeQueries: ['query'],
      });

      try {
        await indexUseCase.execute({ libraryId, waitSeconds: 1 });
        expect.fail('Should have thrown READINESS_PENDING');
      } catch (err) {
        expect(err).toBeInstanceOf(CliOperationError);
        const cliErr = err as CliOperationError;
        expect(cliErr.code).toBe('READINESS_PENDING');
        expect(cliErr.exitCode).toBe(2);

        // Check manifest saved as readiness_pending
        const saved = await manifestStore.getIndexGeneration(cliErr.runId!);
        expect(saved?.state).toBe('readiness_pending');
      } finally {
        backend.verifyReadiness = origVerify;
      }
    });

    it('enforces the wait-seconds deadline when the backend readiness probe hangs', async () => {
      await createCorpusRevision('rev-hanging-readiness', [
        { docId: 'doc-a', snapId: 'snap-hanging', title: 'Doc A', content: 'Content A' },
      ]);

      const origVerify = backend.verifyReadiness.bind(backend);
      backend.verifyReadiness = vi.fn(() => new Promise<never>(() => {}));

      try {
        await expect(indexUseCase.execute({ libraryId, waitSeconds: 1 })).rejects.toMatchObject({
          code: 'READINESS_PENDING',
          exitCode: 2,
        });
      } finally {
        backend.verifyReadiness = origVerify;
      }
    });

    it('resumes a failed or pending run with --resume <runId>', async () => {
      await createCorpusRevision('rev-1', [
        { docId: 'doc-a', snapId: 'snap-1a', title: 'Doc A', content: 'Content A' },
      ]);

      // 1. Simulate failed run
      const origImport = backend.importBatch.bind(backend);
      backend.importBatch = vi.fn().mockResolvedValueOnce({
        importedCount: 0,
        failedIds: ['failed-chunk-1'],
      });

      let failedRunId = '';
      try {
        await indexUseCase.execute({ libraryId });
      } catch (err) {
        failedRunId = (err as CliOperationError).runId!;
      }
      expect(failedRunId).not.toBe('');

      const failedGen = await manifestStore.getIndexGeneration(failedRunId);
      expect(failedGen?.state).toBe('failed');

      // 2. Restore normal import and resume
      backend.importBatch = origImport;
      const resumeRes = await indexUseCase.execute({
        libraryId,
        resumeRunId: failedRunId,
      });

      expect(resumeRes.state).toBe('published');
      expect(resumeRes.generationId).toBe(failedRunId);

      const publishedGen = await manifestStore.getIndexGeneration(failedRunId);
      expect(publishedGen?.state).toBe('published');

      const pointer = await manifestStore.getPublishedPointer(backendKey, libraryId, versionKey);
      expect(pointer?.generationId).toBe(failedRunId);
    });

    it('rejects resuming a superseded generation if a newer revision was already published', async () => {
      // 1. Create Rev 1 and simulate an interrupted run G_old
      await createCorpusRevision('rev-1', [
        { docId: 'doc-a', snapId: 'snap-1a', title: 'Doc A v1', content: 'Content A v1' },
      ]);

      const oldGenId = 'old-gen-interrupted';
      await manifestStore.saveIndexGeneration({
        generationId: oldGenId,
        backendKey,
        corpusRevisionId: 'rev-1',
        indexProfileHash: backendKey,
        state: 'failed',
        entryCount: 1,
        entryIds: ['k123'],
        createdAt: '2026-09-01T10:00:00.000Z',
        updatedAt: '2026-09-01T10:05:00.000Z',
      });

      // 2. In the meantime, Rev 2 was created and published as G_new!
      await createCorpusRevision('rev-2', [
        { docId: 'doc-a', snapId: 'snap-2a', title: 'Doc A v2', content: 'Content A v2' },
      ]);
      const resNew = await indexUseCase.execute({ libraryId });
      expect(resNew.state).toBe('published');

      // 3. Now attempt to resume oldGenId
      try {
        await indexUseCase.execute({ libraryId, resumeRunId: oldGenId });
        expect.fail('Should have rejected superseded resume');
      } catch (err) {
        expect(err).toBeInstanceOf(CliOperationError);
        const cliErr = err as CliOperationError;
        expect(cliErr.message).toContain('superseded');

        // Check that oldGenId is marked superseded
        const oldGen = await manifestStore.getIndexGeneration(oldGenId);
        expect(oldGen?.state).toBe('superseded');
      }
    });

    it('calculates dry-run plan without writing to backend or mutating manifest', async () => {
      await createCorpusRevision('rev-1', [
        { docId: 'doc-a', snapId: 'snap-1a', title: 'Doc A', content: 'Content A' },
        { docId: 'doc-b', snapId: 'snap-1b', title: 'Doc B', content: 'Content B' },
      ]);

      const planRes = await indexUseCase.execute({ libraryId, plan: true });

      expect(planRes.state).toBe('staging');
      expect(planRes.entryCount).toBe(2);
      expect(planRes.plan?.batchCount).toBe(1);
      expect(planRes.plan?.entryCount).toBe(2);

      // Ensure no generation or pointer was saved in manifest
      const pointer = await manifestStore.getPublishedPointer(backendKey, libraryId, versionKey);
      expect(pointer).toBeNull();
    });
  });
});
