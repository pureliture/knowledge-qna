/**
 * Document Chunk Domain Model
 * Zero Node I/O, Zero External SDKs
 */

export interface DocumentChunk {
  schemaVersion: 1;
  chunkId: string;
  documentId: string;
  snapshotId: string;
  libraryId: string;
  versionKey: string;
  chunkerProfileId: string;
  title: string;
  headingPath: string[];
  anchor?: string;
  content: string;
  chunkIndex: number;
  hasCode: boolean;
  oversized: boolean;
  tokenCount: number;
  contentHash: string;
}
