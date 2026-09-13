/**
 * ManifestStore Port
 * Relational SQLite manifest for runs, observations, revisions, pointers, and leases.
 */

import type {
  FetchObservation,
  PublishedPointer,
  IndexGeneration,
  SyncRunRecord,
  CorpusRevisionMetadata,
} from '../../domain/models/index.js';

export interface WriterLease {
  ownerId: string;
  expiresAt: string;
  fencingToken: number;
}

export interface ReadLease {
  leaseId: string;
  generationId: string;
  expiresAt: string;
}

export interface ManifestStore {
  // Published pointers
  getPublishedPointer(backendKey: string, libraryId: string, versionKey: string): Promise<PublishedPointer | null>;
  setPublishedPointer(pointer: PublishedPointer): Promise<void>;

  // Observations
  recordObservation(observation: FetchObservation): Promise<void>;
  getObservation(documentId: string): Promise<FetchObservation | null>;
  getObservationsForLibrary(libraryId: string, versionKey: string): Promise<FetchObservation[]>;

  // Generations
  getIndexGeneration(generationId: string): Promise<IndexGeneration | null>;
  saveIndexGeneration(generation: IndexGeneration): Promise<void>;

  // Sync Runs
  startSyncRun(run: SyncRunRecord): Promise<void>;
  updateSyncRun(run: Partial<SyncRunRecord> & { runId: string }): Promise<void>;
  getSyncRun(runId: string): Promise<SyncRunRecord | null>;
  getLatestSyncRun(libraryId: string, versionKey: string): Promise<SyncRunRecord | null>;

  // Corpus Revisions
  registerCorpusRevision(metadata: CorpusRevisionMetadata): Promise<void>;
  getLatestCorpusRevision(libraryId: string, versionKey: string): Promise<CorpusRevisionMetadata | null>;
  getCorpusRevision(corpusRevisionId: string): Promise<CorpusRevisionMetadata | null>;
  listCorpusRevisions(libraryId: string, versionKey: string): Promise<CorpusRevisionMetadata[]>;

  // Atomic Sync Revision Commit (single SQLite transaction)
  commitSyncRevision(
    revision: CorpusRevisionMetadata,
    syncRunUpdate: Partial<SyncRunRecord> & { runId: string },
    lease?: { ownerId: string; fencingToken: number },
  ): Promise<void>;

  // Leases
  acquireWriterLease(ownerId: string, ttlMs: number): Promise<WriterLease | null>;
  renewWriterLease(ownerId: string, fencingToken: number, ttlMs: number): Promise<boolean>;
  releaseWriterLease(ownerId: string, fencingToken: number): Promise<void>;
  isWriterLeaseValid(ownerId: string, fencingToken: number): Promise<boolean>;

  acquireReadLease(generationId: string, ttlMs: number): Promise<ReadLease>;
  releaseReadLease(leaseId: string): Promise<void>;

  // Integrity diagnostics
  checkIntegrity?(): Promise<{ ok: boolean; message: string }>;
}
