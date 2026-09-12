/**
 * SearchBackend Port (Read Only)
 * Used by Retrieval engine to query candidate chunks from index.
 */

import type { SearchHit, SearchFilter } from '../../domain/models/index.js';

export interface SearchQueryParams {
  libraryId: string;
  versionKey: string;
  generationId: string;
  query: string;
  limit?: number;
  filters?: SearchFilter;
}

export interface SearchBackend {
  search(params: SearchQueryParams): Promise<SearchHit[]>;
}
