/**
 * Corpus Revision Domain Models
 * Zero Node I/O, Zero External SDKs
 */

export interface CorpusDocumentEntry {
  documentId: string;
  snapshotId: string;
  chunkerProfileId: string;
  chunkIds: string[];
}

export interface RegistryProfileSnapshot {
  versionConfigHash: string;
  normalizerProfile: Record<string, unknown>;
  chunkerProfile: Record<string, unknown>;
}

export interface CorpusRevision {
  schemaVersion: 1;
  corpusRevisionId: string;
  libraryId: string;
  versionKey: string;
  createdAt: string;
  documents: CorpusDocumentEntry[];
  registryProfileSnapshot: RegistryProfileSnapshot;
}
