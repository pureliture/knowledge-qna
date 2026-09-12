/**
 * IndexBackend Port (Write Only)
 * Used by Indexing engine to publish corpus revisions to search generation.
 */

import type { ReadinessResult } from '../../domain/models/index.js';

export interface IndexEntryPayload {
  indexEntryId: string;
  generationId: string;
  chunkId: string;
  documentId: string;
  libraryId: string;
  versionKey: string;
  title: string;
  headingPath: string[];
  content: string;
  url: string;
}

export interface IndexBackend {
  getBackendKey(): string;
  stageGeneration(generationId: string): Promise<void>;
  importBatch(generationId: string, entries: IndexEntryPayload[]): Promise<{ importedCount: number; failedIds: string[] }>;
  verifyReadiness(generationId: string, expectedCount: number, probeQueries: string[]): Promise<ReadinessResult>;
  publishGeneration(generationId: string): Promise<void>;
  retireGeneration(generationId: string): Promise<void>;
  deleteGeneration(generationId: string): Promise<void>;
}
