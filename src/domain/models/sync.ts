/**
 * Sync Run and Revision Metadata Domain Models
 * Strict Domain Layer: Zero Node I/O, Zero External SDKs
 */

export interface SyncRunRecord {
  runId: string;
  libraryId: string;
  versionKey: string;
  sourceHash: string;
  profileHash: string;
  status: 'running' | 'complete' | 'failed';
  startedAt: string;
  completedAt?: string;
  discoveredCount: number;
  fetchedCount: number;
  storedCount: number;
  unchangedCount: number;
  errorCount: number;
  errorCode?: string;
  errorMessage?: string;
  corpusRevisionId?: string;
}

export interface CorpusRevisionMetadata {
  corpusRevisionId: string;
  libraryId: string;
  versionKey: string;
  createdAt: string;
  versionProfileHash: string;
  documentCount: number;
  syncRunId: string;
  isComplete: boolean;
}
