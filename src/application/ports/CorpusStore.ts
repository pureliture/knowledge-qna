/**
 * CorpusStore Port
 * Content-Addressable Storage for documents, chunks, and revision manifests.
 */

import type {
  NormalizedDocument,
  DocumentChunk,
  CorpusRevision,
} from '../../domain/models/index.js';

export interface CorpusStore {
  // Documents
  saveDocument(document: NormalizedDocument): Promise<void>;
  getDocument(documentId: string, snapshotId: string): Promise<NormalizedDocument | null>;
  hasDocument(documentId: string, snapshotId: string): Promise<boolean>;

  // Chunks
  saveChunks(chunkerProfileId: string, snapshotId: string, chunks: DocumentChunk[]): Promise<void>;
  getChunk(chunkerProfileId: string, snapshotId: string, chunkId: string): Promise<DocumentChunk | null>;
  getChunksForSnapshot(chunkerProfileId: string, snapshotId: string): Promise<DocumentChunk[]>;
  hasChunks(chunkerProfileId: string, snapshotId: string): Promise<boolean>;

  // Revisions
  saveRevision(revision: CorpusRevision): Promise<void>;
  getRevision(corpusRevisionId: string): Promise<CorpusRevision | null>;
  hasRevision(corpusRevisionId: string): Promise<boolean>;

  // Profiles
  saveProfile(profileId: string, profile: unknown): Promise<void>;
  getProfile<T = unknown>(profileId: string): Promise<T | null>;
  hasProfile(profileId: string): Promise<boolean>;
}
