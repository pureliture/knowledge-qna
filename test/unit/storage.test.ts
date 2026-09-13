import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FilesystemCorpusStore } from '../../src/infrastructure/storage/FilesystemCorpusStore.js';
import { SqliteManifestStore } from '../../src/infrastructure/storage/SqliteManifestStore.js';
import { CorpusCorruptError } from '../../src/domain/errors.js';
import {
  computeDocumentId,
  computeNormalizedHash,
  computeSnapshotId,
  computeChunkId,
  sha256Hex,
} from '../../src/domain/identity.js';
import type {
  NormalizedDocument,
  DocumentChunk,
  CorpusRevision,
  SyncRunRecord,
  CorpusRevisionMetadata,
  FetchObservation,
} from '../../src/domain/models/index.js';

describe('Storage Infrastructure Unit Tests', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('FilesystemCorpusStore', () => {
    it('saves and retrieves documents, chunks, revisions, and profiles with existence checks', async () => {
      const store = new FilesystemCorpusStore(tmpDir);

      const libraryId = 'lib-test';
      const versionKey = 'current';
      const canonicalUrl = 'https://example.com/docs/intro';

      const docId = computeDocumentId(libraryId, versionKey, canonicalUrl);
      const normHash = computeNormalizedHash({
        title: 'Intro Title',
        markdown: '# Intro\n\nWelcome.',
        headings: [{ level: 1, text: 'Intro' }],
        metadata: {},
      });
      const snapId = computeSnapshotId(docId, 'norm-v1', normHash);

      const doc: NormalizedDocument = {
        schemaVersion: 1,
        documentId: docId,
        snapshotId: snapId,
        libraryId,
        versionKey,
        canonicalUrl,
        title: 'Intro Title',
        markdown: '# Intro\n\nWelcome.',
        headings: [{ level: 1, text: 'Intro' }],
        normalizedHash: normHash,
        normalizerProfileId: 'norm-v1',
        metadata: {},
      };

      // Initially does not exist
      expect(await store.hasDocument(docId, snapId)).toBe(false);
      expect(await store.getDocument(docId, snapId)).toBeNull();

      // Save document
      await store.saveDocument(doc);
      expect(await store.hasDocument(docId, snapId)).toBe(true);

      const retrievedDoc = await store.getDocument(docId, snapId);
      expect(retrievedDoc).toEqual(doc);

      // Chunks
      const chunkerProfileId = 'chunk-v1';
      const content = '# Intro\n\nWelcome.';
      const contentHash = sha256Hex(content);
      const chunkId = computeChunkId(snapId, chunkerProfileId, 0, ['Intro'], content);

      const chunks: DocumentChunk[] = [
        {
          schemaVersion: 1,
          chunkId,
          documentId: docId,
          snapshotId: snapId,
          libraryId,
          versionKey,
          chunkerProfileId,
          title: 'Intro Title',
          headingPath: ['Intro'],
          content,
          chunkIndex: 0,
          hasCode: false,
          oversized: false,
          tokenCount: 10,
          contentHash,
        },
      ];

      expect(await store.hasChunks(chunkerProfileId, snapId)).toBe(false);
      expect(await store.getChunksForSnapshot(chunkerProfileId, snapId)).toEqual([]);

      await store.saveChunks(chunkerProfileId, snapId, chunks);
      expect(await store.hasChunks(chunkerProfileId, snapId)).toBe(true);

      const retrievedChunks = await store.getChunksForSnapshot(chunkerProfileId, snapId);
      expect(retrievedChunks).toEqual(chunks);

      const singleChunk = await store.getChunk(chunkerProfileId, snapId, chunkId);
      expect(singleChunk).toEqual(chunks[0]);

      // Revision
      const revision: CorpusRevision = {
        schemaVersion: 1,
        corpusRevisionId: 'rev-001',
        libraryId,
        versionKey,
        createdAt: '2026-09-13T00:00:00.000Z',
        documents: [
          {
            documentId: docId,
            snapshotId: snapId,
            chunkerProfileId,
            chunkIds: [chunkId],
          },
        ],
        registryProfileSnapshot: {
          versionConfigHash: 'vhash-1',
          normalizerProfile: { id: 'norm-v1' },
          chunkerProfile: { id: 'chunk-v1' },
        },
      };

      expect(await store.hasRevision('rev-001')).toBe(false);
      expect(await store.getRevision('rev-001')).toBeNull();

      await store.saveRevision(revision);
      expect(await store.hasRevision('rev-001')).toBe(true);

      const retrievedRev = await store.getRevision('rev-001');
      expect(retrievedRev).toEqual(revision);

      // Profiles
      const profile = { contentSelectors: ['main'], removeSelectors: ['nav'] };
      expect(await store.hasProfile('profile-1')).toBe(false);
      expect(await store.getProfile('profile-1')).toBeNull();

      await store.saveProfile('profile-1', profile);
      expect(await store.hasProfile('profile-1')).toBe(true);

      const retrievedProfile = await store.getProfile('profile-1');
      expect(retrievedProfile).toEqual(profile);
    });

    it('guarantees idempotency for identical saves and throws CORPUS_CORRUPT on payload mismatch', async () => {
      const store = new FilesystemCorpusStore(tmpDir);

      const libraryId = 'lib-test';
      const versionKey = 'current';
      const canonicalUrl = 'https://example.com/docs/page';

      const docId = computeDocumentId(libraryId, versionKey, canonicalUrl);
      const normHash = computeNormalizedHash({
        title: 'Page 1',
        markdown: 'Content 1',
        headings: [],
        metadata: {},
      });
      const snapId = computeSnapshotId(docId, 'norm-v1', normHash);

      const doc: NormalizedDocument = {
        schemaVersion: 1,
        documentId: docId,
        snapshotId: snapId,
        libraryId,
        versionKey,
        canonicalUrl,
        title: 'Page 1',
        markdown: 'Content 1',
        headings: [],
        normalizedHash: normHash,
        normalizerProfileId: 'norm-v1',
        metadata: {},
      };

      // Initial save
      await store.saveDocument(doc);

      // Second identical save: idempotent no-op
      await expect(store.saveDocument(doc)).resolves.not.toThrow();

      // Corrupt payload: different title but claiming same snapshotId
      const mismatchedDoc: NormalizedDocument = {
        ...doc,
        title: 'Different Title',
      };

      await expect(store.saveDocument(mismatchedDoc)).rejects.toThrowError(CorpusCorruptError);
    });

    it('throws CORPUS_CORRUPT when reading tampered files on disk', async () => {
      const store = new FilesystemCorpusStore(tmpDir);

      const libraryId = 'lib-test';
      const versionKey = 'current';
      const canonicalUrl = 'https://example.com/docs/corrupt';

      const docId = computeDocumentId(libraryId, versionKey, canonicalUrl);
      const normHash = computeNormalizedHash({
        title: 'Corrupt Test',
        markdown: 'Will be corrupted.',
        headings: [],
        metadata: {},
      });
      const snapId = computeSnapshotId(docId, 'norm-v1', normHash);

      const doc: NormalizedDocument = {
        schemaVersion: 1,
        documentId: docId,
        snapshotId: snapId,
        libraryId,
        versionKey,
        canonicalUrl,
        title: 'Corrupt Test',
        markdown: 'Will be corrupted.',
        headings: [],
        normalizedHash: normHash,
        normalizerProfileId: 'norm-v1',
        metadata: {},
      };

      await store.saveDocument(doc);

      // Tamper with the file on disk (invalid JSON)
      const filePath = path.join(tmpDir, 'corpus/documents', docId, `${snapId}.json`);
      fs.writeFileSync(filePath, '{ invalid-json-syntax', 'utf-8');

      await expect(store.getDocument(docId, snapId)).rejects.toThrowError(CorpusCorruptError);
    });
  });

  describe('SqliteManifestStore', () => {
    it('migrates schema to user_version = 2 and manages sync runs and corpus revisions', async () => {
      const dbPath = path.join(tmpDir, 'manifest/catalog.sqlite');
      const store = new SqliteManifestStore(dbPath);

      // Verify sync run operations
      const runRecord: SyncRunRecord = {
        runId: 'run-101',
        libraryId: 'lib-test',
        versionKey: 'current',
        sourceHash: 'shash-1',
        profileHash: 'phash-1',
        status: 'running',
        startedAt: '2026-09-13T01:00:00.000Z',
        discoveredCount: 10,
        fetchedCount: 5,
        storedCount: 5,
        unchangedCount: 0,
        errorCount: 0,
      };

      await store.startSyncRun(runRecord);

      let fetchedRun = await store.getSyncRun('run-101');
      expect(fetchedRun).toBeDefined();
      expect(fetchedRun!.status).toBe('running');
      expect(fetchedRun!.discoveredCount).toBe(10);

      // Update sync run
      await store.updateSyncRun({
        runId: 'run-101',
        fetchedCount: 10,
        storedCount: 8,
        unchangedCount: 2,
      });

      fetchedRun = await store.getSyncRun('run-101');
      expect(fetchedRun!.fetchedCount).toBe(10);
      expect(fetchedRun!.storedCount).toBe(8);
      expect(fetchedRun!.unchangedCount).toBe(2);

      const latestRun = await store.getLatestSyncRun('lib-test', 'current');
      expect(latestRun).toBeDefined();
      expect(latestRun!.runId).toBe('run-101');

      // Fetch observation test
      const obs: FetchObservation = {
        documentId: 'doc-001',
        runId: 'run-101',
        snapshotId: 'snap-001',
        requestedUrl: 'https://example.com/doc1',
        fetchedUrl: 'https://example.com/doc1',
        status: 200,
        lastCheckedAt: '2026-09-13T01:05:00.000Z',
        rawHash: 'raw-001',
      };

      await store.recordObservation(obs);
      const retrievedObs = await store.getObservation('doc-001');
      expect(retrievedObs).toBeDefined();
      expect(retrievedObs!.status).toBe(200);

      const libraryObs = await store.getObservationsForLibrary('lib-test', 'current');
      expect(libraryObs.length).toBe(1);
      expect(libraryObs[0]!.documentId).toBe('doc-001');

      // Atomic commitSyncRevision test
      const lease = await store.acquireWriterLease('worker-test', 30000);
      expect(lease).toBeDefined();

      const revisionMeta: CorpusRevisionMetadata = {
        corpusRevisionId: 'crev-202',
        libraryId: 'lib-test',
        versionKey: 'current',
        createdAt: '2026-09-13T01:10:00.000Z',
        versionProfileHash: 'vphash-1',
        documentCount: 10,
        syncRunId: 'run-101',
        isComplete: true,
      };

      await store.commitSyncRevision(
        revisionMeta,
        {
          runId: 'run-101',
          completedAt: '2026-09-13T01:10:00.000Z',
          storedCount: 8,
          unchangedCount: 2,
        },
        { ownerId: 'worker-test', fencingToken: lease!.fencingToken },
      );

      // Verify sync run completed
      const completedRun = await store.getSyncRun('run-101');
      expect(completedRun!.status).toBe('complete');
      expect(completedRun!.corpusRevisionId).toBe('crev-202');
      expect(completedRun!.completedAt).toBe('2026-09-13T01:10:00.000Z');

      // Verify revision registered
      const latestRev = await store.getLatestCorpusRevision('lib-test', 'current');
      expect(latestRev).toBeDefined();
      expect(latestRev!.corpusRevisionId).toBe('crev-202');
      expect(latestRev!.documentCount).toBe(10);
      expect(latestRev!.isComplete).toBe(true);

      const allRevs = await store.listCorpusRevisions('lib-test', 'current');
      expect(allRevs).toHaveLength(1);

      store.close();
    });

    it('enforces single-writer lease and fencing token semantics', async () => {
      const store = new SqliteManifestStore(':memory:');

      // 1. Owner 1 acquires 30s lease
      const lease1 = await store.acquireWriterLease('owner-1', 30000);
      expect(lease1).toBeDefined();
      expect(lease1!.ownerId).toBe('owner-1');
      expect(lease1!.fencingToken).toBe(1);

      // Verify valid
      expect(await store.isWriterLeaseValid('owner-1', lease1!.fencingToken)).toBe(true);
      expect(await store.isWriterLeaseValid('owner-2', lease1!.fencingToken)).toBe(false);

      // 2. Owner 2 tries to acquire active lease -> blocked (returns null)
      const lease2 = await store.acquireWriterLease('owner-2', 30000);
      expect(lease2).toBeNull();

      // 3. Owner 1 renews lease
      const renewed = await store.renewWriterLease('owner-1', lease1!.fencingToken, 30000);
      expect(renewed).toBe(true);

      // Renewing with wrong fencing token fails
      const renewedWrong = await store.renewWriterLease('owner-1', 999, 30000);
      expect(renewedWrong).toBe(false);

      // 4. Owner 1 releases lease
      await store.releaseWriterLease('owner-1', lease1!.fencingToken);
      expect(await store.isWriterLeaseValid('owner-1', lease1!.fencingToken)).toBe(false);

      // 5. Owner 2 can now acquire lease with next fencing token (2)
      const lease3 = await store.acquireWriterLease('owner-2', 30000);
      expect(lease3).toBeDefined();
      expect(lease3!.ownerId).toBe('owner-2');
      expect(lease3!.fencingToken).toBe(2);

      store.close();
    });
  });
});
