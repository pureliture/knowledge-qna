/**
 * Safe remote-search placeholder used when Google Agent Search has no complete target configuration.
 * It makes `docsctx doctor --remote` fail closed instead of reporting the offline adapter as healthy.
 */

import type {
  BackendHealth,
  SearchBackend,
  SearchQueryParams,
  SearchHit,
} from '../../application/ports/SearchBackend.js';
import { SearchFailedError } from '../../domain/errors.js';

export class UnavailableSearchBackend implements SearchBackend {
  constructor(private readonly reason: string) {}

  async search(_params: SearchQueryParams): Promise<SearchHit[]> {
    throw new SearchFailedError(this.reason, false);
  }

  async health(_signal?: AbortSignal): Promise<BackendHealth> {
    return {
      status: 'unavailable',
      message: this.reason,
    };
  }
}
