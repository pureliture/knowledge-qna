/**
 * Adversarial Test Suite for M1 Storage, Lease Concurrency & Gate T-06 Invariants
 * Challenger: challenger_m1_2
 *
 * Adversarially challenges:
 * 1. Storage Corruption & Tampering (FilesystemCorpusStore):
 *    - Document/Snapshot identity forgery rejection
 *    - Snapshot payload collision rejection (CORPUS_CORRUPT)
 *    - Snapshot disk file tampering detection (CORPUS_CORRUPT)
 *    - Chunk contentHash and chunkId forgery rejection
 *    - Chunks payload collision and chunk count mismatch rejection (CORPUS_CORRUPT)
 *    - Chunks disk JSONL tampering detection (CORPUS_CORRUPT)
 *    - Revision and Profile payload collision and disk tampering detection
 * 2. Single-Writer Lease Expiration & Concurrency (SqliteManifestStore):
 *    - Strict monotonic fencing token incrementation
 *    - Mutual exclusion while lease is active (returns null)
 *    - isWriterLeaseValid returns true during active TTL, false on expiry/release
 *    - Probing whether renewWriterLease allows renewing an expired lease
 *    - Probing whether commitSyncRevision permits expired / overtaken leases to commit
 * 3. Gate T-06 Proof (published_pointers stability):
 *    - Multiple consecutive syncs (initial, 304 unchanged, updated document)
 *    - Direct raw SQL verification that published_pointers is never altered
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import { FilesystemCorpusStore } from '../../src/infrastructure/storage/FilesystemCorpusStore.js';
import { SqliteManifestStore } from '../../src/infrastructure/storage/SqliteManifestStore.js';
import { CorpusCorruptError } from '../../src/domain/errors.js';
import {
  computeDocumentId,
  computeSnapshotId,
  computeNormalizedHash,
  computeChunkId,
  computeCorpusRevisionId,
  sha256Hex,
} from '../../src/domain/identity.js';
import type {
  NormalizedDocument,
  DocumentChunk,
  CorpusRevision,
  CorpusRevisionMetadata,
  LibraryDefinition,
  LibraryVersionConfig,
} from '../../src/domain/models/index.js';
import { SyncUseCase } from '../../src/application/sync/SyncUseCase.js';
import type { LibraryRegistry } from '../../src/application/ports/LibraryRegistry.js';
import type { SourceProvider, DiscoveryResult } from '../../src/application/ports/SourceProvider.js';
import type { DocumentFetcher, FetchRequest, FetchResponse } from '../../src/application/ports/DocumentFetcher.js';
import { HtmlDocumentNormalizer } from '../../src/infrastructure/parsing/HtmlDocumentNormalizer.js';
import { MarkdownAstChunker } from '../../src/infrastructure/parsing/MarkdownAstChunker.js';
import { TiktokenCounter } from '../../src/infrastructure/tokens/TiktokenCounter.js';

describe('Adversarial Storage, Lease Concurrency & Gate T-06', () => {
  let tmpDir: string;
  let corpusStore: FilesystemCorpusStore;
  let manifestStore: SqliteManifestStore;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `m1-adv-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    corpusStore = new FilesystemCorpusStore(tmpDir);
    dbPath = path.join(tmpDir, 'manifest', 'catalog.sqlite');
    manifestStore = new SqliteManifestStore(dbPath);
  });

  afterEach(() => {
    manifestStore.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // 1. Storage Corruption and Tampering
  // ---------------------------------------------------------------------------
  describe('1. Storage Corruption & Disk Tampering (FilesystemCorpusStore)', () => {
    function createValidDocument(canonicalUrl: string, content: string): NormalizedDocument {
      const libraryId = 'test-lib';
      const versionKey = '1.0';
      const normalizerProfileId = 'html-normalizer-v1';
      const title = 'Document Title';
      const markdown = `# ${title}\n\n${content}`;
      const headings = [{ level: 1, text: title }];
      const docId = computeDocumentId(libraryId, versionKey, canonicalUrl);
      const normHash = computeNormalizedHash({ title, markdown, headings });
      const snapId = computeSnapshotId(docId, normalizerProfileId, normHash);

      return {
        schemaVersion: 1,
        documentId: docId,
        snapshotId: snapId,
        libraryId,
        versionKey,
        canonicalUrl,
        title,
        markdown,
        headings,
        normalizedHash: normHash,
        normalizerProfileId,
        metadata: {},
      };
    }

    it('rejects document with forged or mismatched documentId', async () => {
      const validDoc = createValidDocument('https://example.com/doc-1', 'Sample');
      const forgedDoc: NormalizedDocument = {
        ...validDoc,
        documentId: 'forged-doc-id-12345',
      };

      await expect(corpusStore.saveDocument(forgedDoc)).rejects.toThrow(CorpusCorruptError);
    });

    it('rejects document with forged or mismatched snapshotId', async () => {
      const validDoc = createValidDocument('https://example.com/doc-2', 'Sample');
      const forgedDoc: NormalizedDocument = {
        ...validDoc,
        snapshotId: 'forged-snapshot-id-67890',
      };

      await expect(corpusStore.saveDocument(forgedDoc)).rejects.toThrow(CorpusCorruptError);
    });

    it('throws CORPUS_CORRUPT when attempting to save a different payload under an existing snapshotId', async () => {
      const doc1 = createValidDocument('https://example.com/collision', 'Original text');
      await corpusStore.saveDocument(doc1);

      // Same snapshotId, but different title/content
      const collidingDoc: NormalizedDocument = {
        ...doc1,
        title: 'Collision Title',
      };

      await expect(corpusStore.saveDocument(collidingDoc)).rejects.toThrow(CorpusCorruptError);
      await expect(corpusStore.saveDocument(collidingDoc)).rejects.toThrow(/already exists with different payload/);
    });

    it('throws CORPUS_CORRUPT when saved document file on disk is corrupted or tampered', async () => {
      const doc = createValidDocument('https://example.com/tamper-doc', 'Original content');
      await corpusStore.saveDocument(doc);

      const filePath = path.join(tmpDir, 'corpus', 'documents', doc.documentId, `${doc.snapshotId}.json`);
      expect(fs.existsSync(filePath)).toBe(true);

      // Tamper disk file with invalid JSON syntax
      fs.writeFileSync(filePath, '{"schemaVersion": 1, "corrupted: unclosed json');

      await expect(corpusStore.getDocument(doc.documentId, doc.snapshotId)).rejects.toThrow(CorpusCorruptError);
      await expect(corpusStore.saveDocument(doc)).rejects.toThrow(CorpusCorruptError);
    });

    it('rejects chunks with forged contentHash or chunkId', async () => {
      const doc = createValidDocument('https://example.com/chunk-forged', 'Sample');
      const content = 'Atomic chunk content';
      const chunkerProfileId = 'ast-chunker-v1';

      const validChunkId = computeChunkId(doc.snapshotId, chunkerProfileId, 0, ['Root'], content);
      const validHash = sha256Hex(content);

      // Forged contentHash
      const chunkWithBadHash: DocumentChunk = {
        schemaVersion: 1,
        chunkId: validChunkId,
        documentId: doc.documentId,
        snapshotId: doc.snapshotId,
        libraryId: doc.libraryId,
        versionKey: doc.versionKey,
        chunkerProfileId,
        title: doc.title,
        headingPath: ['Root'],
        content,
        chunkIndex: 0,
        hasCode: false,
        oversized: false,
        tokenCount: 5,
        contentHash: 'bad-hash-0000',
      };

      await expect(corpusStore.saveChunks(chunkerProfileId, doc.snapshotId, [chunkWithBadHash])).rejects.toThrow(
        CorpusCorruptError,
      );

      // Forged chunkId
      const chunkWithBadId: DocumentChunk = {
        ...chunkWithBadHash,
        contentHash: validHash,
        chunkId: 'forged-chunk-id-9999',
      };

      await expect(corpusStore.saveChunks(chunkerProfileId, doc.snapshotId, [chunkWithBadId])).rejects.toThrow(
        CorpusCorruptError,
      );
    });

    it('throws CORPUS_CORRUPT when attempting to save a different chunk payload under an existing snapshotId', async () => {
      const doc = createValidDocument('https://example.com/chunk-collision', 'Sample');
      const chunkerProfileId = 'ast-chunker-v1';
      const content1 = 'Chunk content 1';
      const cHash1 = sha256Hex(content1);
      const cId1 = computeChunkId(doc.snapshotId, chunkerProfileId, 0, ['Root'], content1);

      const chunk1: DocumentChunk = {
        schemaVersion: 1,
        chunkId: cId1,
        documentId: doc.documentId,
        snapshotId: doc.snapshotId,
        libraryId: doc.libraryId,
        versionKey: doc.versionKey,
        chunkerProfileId,
        title: doc.title,
        headingPath: ['Root'],
        content: content1,
        chunkIndex: 0,
        hasCode: false,
        oversized: false,
        tokenCount: 4,
        contentHash: cHash1,
      };

      await corpusStore.saveChunks(chunkerProfileId, doc.snapshotId, [chunk1]);

      // Attempt saving different content under same snapshotId
      const content2 = 'Completely different content';
      const cHash2 = sha256Hex(content2);
      const cId2 = computeChunkId(doc.snapshotId, chunkerProfileId, 0, ['Root'], content2);
      const chunk2: DocumentChunk = {
        ...chunk1,
        chunkId: cId2,
        content: content2,
        contentHash: cHash2,
      };

      await expect(corpusStore.saveChunks(chunkerProfileId, doc.snapshotId, [chunk2])).rejects.toThrow(
        CorpusCorruptError,
      );
    });

    it('throws CORPUS_CORRUPT when chunks JSONL file on disk is tampered', async () => {
      const doc = createValidDocument('https://example.com/chunk-tamper', 'Sample');
      const chunkerProfileId = 'ast-chunker-v1';
      const content = 'Chunk content';
      const cHash = sha256Hex(content);
      const cId = computeChunkId(doc.snapshotId, chunkerProfileId, 0, ['Root'], content);

      const chunk: DocumentChunk = {
        schemaVersion: 1,
        chunkId: cId,
        documentId: doc.documentId,
        snapshotId: doc.snapshotId,
        libraryId: doc.libraryId,
        versionKey: doc.versionKey,
        chunkerProfileId,
        title: doc.title,
        headingPath: ['Root'],
        content,
        chunkIndex: 0,
        hasCode: false,
        oversized: false,
        tokenCount: 3,
        contentHash: cHash,
      };

      await corpusStore.saveChunks(chunkerProfileId, doc.snapshotId, [chunk]);

      const chunkFilePath = path.join(tmpDir, 'corpus', 'chunks', chunkerProfileId, `${doc.snapshotId}.jsonl`);
      expect(fs.existsSync(chunkFilePath)).toBe(true);

      // Tamper chunks file with corrupted JSONL
      fs.writeFileSync(chunkFilePath, '{"schemaVersion": 1, corrupted jsonl line\n');

      await expect(corpusStore.getChunksForSnapshot(chunkerProfileId, doc.snapshotId)).rejects.toThrow(
        CorpusCorruptError,
      );
    });

    it('detects tampering and payload collision on Revisions and Profiles', async () => {
      const revId = computeCorpusRevisionId('test-lib', '1.0', 'prof-hash', []);
      const revision: CorpusRevision = {
        schemaVersion: 1,
        corpusRevisionId: revId,
        libraryId: 'test-lib',
        versionKey: '1.0',
        createdAt: new Date().toISOString(),
        documents: [],
        registryProfileSnapshot: {
          versionConfigHash: 'prof-hash',
          normalizerProfile: {},
          chunkerProfile: {},
        },
      };

      await corpusStore.saveRevision(revision);

      // Revision payload collision
      await expect(
        corpusStore.saveRevision({
          ...revision,
          libraryId: 'colliding-lib',
        }),
      ).rejects.toThrow(CorpusCorruptError);

      // Revision disk tampering
      const revPath = path.join(tmpDir, 'corpus', 'revisions', `${revId}.json`);
      fs.writeFileSync(revPath, '{ corrupted json');
      await expect(corpusStore.getRevision(revId)).rejects.toThrow(CorpusCorruptError);

      // Profile payload collision & tampering
      await corpusStore.saveProfile('profile-1', { opt: 100 });
      await expect(corpusStore.saveProfile('profile-1', { opt: 200 })).rejects.toThrow(CorpusCorruptError);

      const profPath = path.join(tmpDir, 'corpus', 'profiles', 'profile-1.json');
      fs.writeFileSync(profPath, '{ not json');
      await expect(corpusStore.getProfile('profile-1')).rejects.toThrow(CorpusCorruptError);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Single-Writer Lease Expiration & Concurrency
  // ---------------------------------------------------------------------------
  describe('2. Single-Writer Lease Expiration & Concurrency (SqliteManifestStore)', () => {
    it('strictly increments fencing token monotonically across lease acquisitions', async () => {
      const lease1 = await manifestStore.acquireWriterLease('worker-1', 1000);
      expect(lease1).not.toBeNull();
      expect(lease1!.fencingToken).toBe(1);

      await manifestStore.releaseWriterLease('worker-1', lease1!.fencingToken);

      const lease2 = await manifestStore.acquireWriterLease('worker-2', 1000);
      expect(lease2).not.toBeNull();
      expect(lease2!.fencingToken).toBe(2);

      await manifestStore.releaseWriterLease('worker-2', lease2!.fencingToken);

      const lease3 = await manifestStore.acquireWriterLease('worker-3', 1000);
      expect(lease3).not.toBeNull();
      expect(lease3!.fencingToken).toBe(3);

      expect(lease1!.fencingToken < lease2!.fencingToken).toBe(true);
      expect(lease2!.fencingToken < lease3!.fencingToken).toBe(true);
    });

    it('enforces mutual exclusion by rejecting concurrent lease acquisition while active', async () => {
      const lease1 = await manifestStore.acquireWriterLease('worker-1', 30000);
      expect(lease1).not.toBeNull();

      // Worker 2 attempts acquisition while Worker 1 lease is active
      const lease2 = await manifestStore.acquireWriterLease('worker-2', 30000);
      expect(lease2).toBeNull();
    });

    it('isWriterLeaseValid returns true during active TTL and false after expiration or release', async () => {
      // Lease with very short TTL (50ms)
      const lease = await manifestStore.acquireWriterLease('worker-1', 50);
      expect(lease).not.toBeNull();

      expect(await manifestStore.isWriterLeaseValid('worker-1', lease!.fencingToken)).toBe(true);
      expect(await manifestStore.isWriterLeaseValid('other-worker', lease!.fencingToken)).toBe(false);
      expect(await manifestStore.isWriterLeaseValid('worker-1', 999)).toBe(false);

      // Wait for expiration
      await new Promise((r) => setTimeout(r, 70));
      expect(await manifestStore.isWriterLeaseValid('worker-1', lease!.fencingToken)).toBe(false);

      // Now acquire new lease
      const lease2 = await manifestStore.acquireWriterLease('worker-2', 10000);
      expect(lease2).not.toBeNull();
      expect(lease2!.fencingToken).toBe(lease!.fencingToken + 1);

      await manifestStore.releaseWriterLease('worker-2', lease2!.fencingToken);
      expect(await manifestStore.isWriterLeaseValid('worker-2', lease2!.fencingToken)).toBe(false);
    });

    // -------------------------------------------------------------------------
    // Empirical Vulnerability Probes: Expired Lease Safety
    // Spec §6.4 states: "State 변경과 publish는 소유 token을 검증한다. Lease 상실 시 이후 쓰기를 중지한다."
    // -------------------------------------------------------------------------
    it('rejects renewing a lease that has already expired without reacquiring', async () => {
      const lease = await manifestStore.acquireWriterLease('worker-1', 50);
      await new Promise((r) => setTimeout(r, 70));

      expect(await manifestStore.isWriterLeaseValid('worker-1', lease!.fencingToken)).toBe(false);

      // EXPECTATION: An expired lease MUST NOT be renewable without re-acquisition
      const renewed = await manifestStore.renewWriterLease('worker-1', lease!.fencingToken, 30000);
      expect(renewed).toBe(false);
    });

    it('rejects commitSyncRevision if the writer lease has expired or is held by another worker', async () => {
      const lease1 = await manifestStore.acquireWriterLease('worker-1', 50);
      await manifestStore.startSyncRun({
        runId: 'run-1',
        libraryId: 'test-lib',
        versionKey: '1.0',
        sourceHash: 's-hash',
        profileHash: 'p-hash',
        status: 'running',
        startedAt: new Date().toISOString(),
        discoveredCount: 1,
        fetchedCount: 1,
        storedCount: 1,
        unchangedCount: 0,
        errorCount: 0,
      });

      // Wait for Worker 1 lease to expire
      await new Promise((r) => setTimeout(r, 70));
      expect(await manifestStore.isWriterLeaseValid('worker-1', lease1!.fencingToken)).toBe(false);

      // Worker 2 acquires the lease
      const lease2 = await manifestStore.acquireWriterLease('worker-2', 30000);
      expect(lease2).not.toBeNull();
      expect(lease2!.fencingToken).toBe(2);

      // EXPECTATION: Worker 1 (EXPIRED LEASE) MUST NOT be allowed to commit revision!
      await expect(
        manifestStore.commitSyncRevision(
          {
            corpusRevisionId: 'rev-from-expired-worker-1',
            libraryId: 'test-lib',
            versionKey: '1.0',
            createdAt: new Date().toISOString(),
            versionProfileHash: 'p-hash',
            documentCount: 1,
            syncRunId: 'run-1',
            isComplete: true,
          },
          {
            runId: 'run-1',
            storedCount: 1,
          },
          { ownerId: 'worker-1', fencingToken: lease1!.fencingToken },
        ),
      ).rejects.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Gate T-06 Proof (published_pointers stability)
  // ---------------------------------------------------------------------------
  describe('3. Gate T-06 Proof: published_pointers Stability across Multiple Syncs', () => {
    it('running multiple consecutive syncs never modifies published_pointers in SQLite manifest', async () => {
      const backendKey = 'google_agent_search';
      const libraryId = 'test-lib';
      const versionKey = 'current';

      // 1. Set initial published pointer
      const initialPublishedPointer = {
        backendKey,
        libraryId,
        versionKey,
        generationId: 'gen-frozen-initial-uuid-12345',
        previousGenerationId: 'gen-previous-uuid-00000',
        publishedAt: '2026-09-01T12:00:00.000Z',
      };
      await manifestStore.setPublishedPointer(initialPublishedPointer);

      // Verify pointer is stored
      const initialCheck = await manifestStore.getPublishedPointer(backendKey, libraryId, versionKey);
      expect(initialCheck).toEqual(initialPublishedPointer);

      // Setup Mock Library Registry
      const versionConfig: LibraryVersionConfig = {
        versionKey,
        displayName: 'Current Version',
        source: {
          type: 'static',
          staticUrls: ['https://example.com/doc-a'],
          allowedHosts: ['example.com'],
          includePaths: ['/doc-a'],
        },
        parser: {
          contentSelectors: ['body'],
        },
        chunking: {
          minTokens: 200,
          targetTokens: 800,
          maxTokens: 1400,
          maxAtomicTokens: 16000,
        },
      };

      const libDef: LibraryDefinition = {
        id: libraryId,
        name: 'Test Library',
        aliases: ['test'],
        defaultVersionKey: versionKey,
        versions: [versionConfig],
      };

      const mockRegistry: LibraryRegistry = {
        getLibrary: async (id) => (id === libraryId ? libDef : null),
        listLibraries: async () => [libDef],
        hasLibrary: async (id) => id === libraryId,
      };

      // Mock Source Provider
      let currentDiscoveredUrls = ['https://example.com/doc-a'];
      const mockSourceProvider: SourceProvider = {
        discover: async () => ({
          urls: currentDiscoveredUrls.map((u) => ({ url: u })),
          summary: {
            totalDiscovered: currentDiscoveredUrls.length,
            filteredOut: 0,
            sitemapsProcessed: 0,
            complete: true,
            aborted: false,
          },
        }),
      };

      // Mock Document Fetcher with 304 support
      let fetchCount = 0;
      let simulate304 = false;
      const mockFetcher: DocumentFetcher = {
        fetch: async (req: FetchRequest): Promise<FetchResponse> => {
          fetchCount++;
          if (simulate304 && req.eTag === '"etag-a"') {
            return {
              status: 304,
              checkedAt: new Date().toISOString(), requestedUrl: req.url, fetchedUrl: req.url, eTag: '"etag-a"',
            };
          }
          return {
            status: 200,
            checkedAt: new Date().toISOString(),
            fetchedAt: new Date().toISOString(),
            fetchedUrl: req.url,
            rawBody: '<html><body><h1>Doc A</h1><p>Content for doc A</p></body></html>', requestedUrl: req.url,
            contentType: 'text/html',
            eTag: '"etag-a"',
            rawHash: sha256Hex('doc-a-body'),
          };
        },
      };

      const syncUseCase = new SyncUseCase(
        mockRegistry,
        manifestStore,
        corpusStore,
        mockSourceProvider,
        mockFetcher,
        new HtmlDocumentNormalizer(),
        new MarkdownAstChunker(new TiktokenCounter()),
      );

      // Raw SQLite verification helper
      const getRawPublishedPointerRow = () => {
        const rawDb = new Database(dbPath);
        try {
          return rawDb
            .prepare(
              'SELECT backend_key, library_id, version_key, generation_id, previous_generation_id, published_at FROM published_pointers WHERE backend_key = ? AND library_id = ? AND version_key = ?',
            )
            .get(backendKey, libraryId, versionKey) as Record<string, unknown> | undefined;
        } finally {
          rawDb.close();
        }
      };

      // --- SYNC 1: Initial Sync ---
      const res1 = await syncUseCase.execute({ libraryId, versionKey });
      expect(res1.status).toBe('complete');
      expect(res1.storedCount).toBe(1);

      // Verify revision 1 was created
      const rev1 = await manifestStore.getLatestCorpusRevision(libraryId, versionKey);
      expect(rev1?.corpusRevisionId).toBe(res1.corpusRevisionId);

      // Gate T-06 check after Sync 1
      const pointerAfterSync1 = await manifestStore.getPublishedPointer(backendKey, libraryId, versionKey);
      expect(pointerAfterSync1).toEqual(initialPublishedPointer);
      expect(getRawPublishedPointerRow()).toEqual({
        backend_key: backendKey,
        library_id: libraryId,
        version_key: versionKey,
        generation_id: initialPublishedPointer.generationId,
        previous_generation_id: initialPublishedPointer.previousGenerationId,
        published_at: initialPublishedPointer.publishedAt,
      });

      // --- SYNC 2: Incremental 304 Sync ---
      simulate304 = true;
      const res2 = await syncUseCase.execute({ libraryId, versionKey });
      expect(res2.status).toBe('complete');
      expect(res2.unchangedCount).toBe(1);

      // Gate T-06 check after Sync 2
      const pointerAfterSync2 = await manifestStore.getPublishedPointer(backendKey, libraryId, versionKey);
      expect(pointerAfterSync2).toEqual(initialPublishedPointer);
      expect(getRawPublishedPointerRow()).toEqual({
        backend_key: backendKey,
        library_id: libraryId,
        version_key: versionKey,
        generation_id: initialPublishedPointer.generationId,
        previous_generation_id: initialPublishedPointer.previousGenerationId,
        published_at: initialPublishedPointer.publishedAt,
      });

      // --- SYNC 3: Modified / Added Document Sync ---
      currentDiscoveredUrls = ['https://example.com/doc-a', 'https://example.com/doc-b'];
      simulate304 = false;
      const res3 = await syncUseCase.execute({ libraryId, versionKey });
      expect(res3.status).toBe('complete');
      expect(res3.discoveredCount).toBe(2);

      // Verify revision 3 was created with 2 documents
      const rev3 = await manifestStore.getLatestCorpusRevision(libraryId, versionKey);
      expect(rev3?.documentCount).toBe(2);
      expect(rev3?.corpusRevisionId).toBe(res3.corpusRevisionId);

      // Gate T-06 check after Sync 3
      const pointerAfterSync3 = await manifestStore.getPublishedPointer(backendKey, libraryId, versionKey);
      expect(pointerAfterSync3).toEqual(initialPublishedPointer);

      // Final Raw SQLite assertion: ZERO changes to published_pointers
      const finalRawRow = getRawPublishedPointerRow();
      expect(finalRawRow).toEqual({
        backend_key: backendKey,
        library_id: libraryId,
        version_key: versionKey,
        generation_id: initialPublishedPointer.generationId,
        previous_generation_id: initialPublishedPointer.previousGenerationId,
        published_at: initialPublishedPointer.publishedAt,
      });
    });
  });
});
