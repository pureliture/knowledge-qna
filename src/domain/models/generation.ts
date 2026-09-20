/**
 * Index Generation and Published Pointer Domain Models
 * Zero Node I/O, Zero External SDKs
 */

export type IndexGenerationState =
  | 'staging'
  | 'importing'
  | 'verifying'
  | 'ready'
  | 'published'
  | 'retired'
  | 'deleting'
  | 'deleted'
  | 'failed'
  | 'readiness_pending'
  | 'abandoned'
  | 'superseded';

export interface ReadinessResult {
  state: 'ready' | 'pending' | 'failed';
  expectedCount: number;
  indexedCount: number;
  missingIds: string[];
  failedProbeQueries: string[];
}

export interface IndexGeneration {
  generationId: string;
  backendKey: string;
  corpusRevisionId: string;
  indexProfileHash: string;
  state: IndexGenerationState;
  entryCount: number;
  entryIds: string[];
  readinessResult?: ReadinessResult;
  createdAt?: string;
  updatedAt?: string;
}

export interface PublishedPointer {
  backendKey: string;
  libraryId: string;
  versionKey: string;
  generationId: string;
  previousGenerationId?: string;
  publishedAt: string;
}
