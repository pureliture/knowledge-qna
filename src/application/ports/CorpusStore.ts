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
  saveDocument(document: NormalizedDocument): Promise<void>;
  getDocument(documentId: string, snapshotId: string): Promise<NormalizedDocument | null>;

  saveChunks(chunkerProfileId: string, snapshotId: string, chunks: DocumentChunk[]): Promise<void>;
  getChunk(chunkerProfileId: string, snapshotId: string, chunkId: string): Promise<DocumentChunk | null>;
  getChunksForSnapshot(chunkerProfileId: string, snapshotId: string): Promise<DocumentChunk[]>;

  saveRevision(revision: CorpusRevision): Promise<void>;
  getRevision(corpusRevisionId: string): Promise<CorpusRevision | null>;
}
