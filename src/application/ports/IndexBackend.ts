/**
 * IndexBackend Port (Write Only)
 * Used by Indexing engine to publish corpus revisions to search generation.
 * Strict Application Layer Boundary: Zero Node I/O, Zero Infrastructure/Interfaces imports.
 */

import type { ReadinessResult } from '../../domain/models/index.js';

export interface IndexEntryPayload {
  indexEntryId: string;
  generationId: string;
  chunkId: string;
  documentId: string;
  snapshotId: string;
  libraryId: string;
  versionKey: string;
  title: string;
  headingPath: string[];
  content: string;
  url: string;
  contentHash: string;
  hasCode: boolean;
  language?: string;
  docType?: string;
}

export interface ReadinessProbe {
  query: string;
  expectedChunkIds?: string[];
}

export interface BatchImportResult {
  importedCount: number;
  failedIds: string[];
  unknownIds?: string[];
}

export interface IndexBackend {
  getBackendKey(): string;
  stageGeneration(generationId: string, signal?: AbortSignal): Promise<void>;
  importBatch(
    generationId: string,
    entries: IndexEntryPayload[],
    signal?: AbortSignal,
  ): Promise<BatchImportResult>;
  verifyReadiness(
    generationId: string,
    expectedCount: number,
    probes: Array<ReadinessProbe | string>,
    signal?: AbortSignal,
  ): Promise<ReadinessResult>;
  publishGeneration(generationId: string, signal?: AbortSignal): Promise<void>;
  retireGeneration(generationId: string, signal?: AbortSignal): Promise<void>;
  deleteGeneration(
    generationId: string,
    signal?: AbortSignal,
    entryIds?: string[],
  ): Promise<void>;
}
