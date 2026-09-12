/**
 * ManifestStore Port
 * Relational SQLite manifest for runs, observations, revisions, pointers, and leases.
 */

import type {
  FetchObservation,
  PublishedPointer,
  IndexGeneration,
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

  // Generations
  getIndexGeneration(generationId: string): Promise<IndexGeneration | null>;
  saveIndexGeneration(generation: IndexGeneration): Promise<void>;

  // Leases
  acquireWriterLease(ownerId: string, ttlMs: number): Promise<WriterLease | null>;
  renewWriterLease(ownerId: string, fencingToken: number, ttlMs: number): Promise<boolean>;
  releaseWriterLease(ownerId: string, fencingToken: number): Promise<void>;

  acquireReadLease(generationId: string, ttlMs: number): Promise<ReadLease>;
  releaseReadLease(leaseId: string): Promise<void>;
}
