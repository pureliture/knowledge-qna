/**
 * SearchBackend Port (Read Only)
 * Used by Retrieval engine to query candidate chunks from index.
 * Strict Application Layer Boundary: Zero Node I/O, Zero Infrastructure/Interfaces imports.
 */

import type { SearchFilter } from '../../domain/models/index.js';

export interface SearchQueryParams {
  libraryId: string;
  versionKey: string;
  generationId: string;
  query: string;
  limit?: number;
  cursor?: string;
  filters?: SearchFilter;
  signal?: AbortSignal;
}

export interface SearchHit {
  indexEntryId: string;
  chunkId: string;
  documentId: string;
  generationId: string;
  libraryId: string;
  versionKey: string;
  rank: number;
  score?: number;
  contentHash?: string;
  snippet?: string;
  metadata?: {
    title?: string;
    headingPath?: string[];
    canonicalUrl?: string;
    language?: string;
    docType?: string;
    hasCode?: boolean;
    [key: string]: unknown;
  };
}

export interface BackendHealth {
  status: 'ok' | 'unavailable' | 'misconfigured';
  message?: string;
}

export interface SearchBackend {
  search(params: SearchQueryParams): Promise<SearchHit[]>;
  health?(signal?: AbortSignal): Promise<BackendHealth>;
}
