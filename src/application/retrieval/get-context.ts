/**
 * GetContext Use Case
 * Implements cited documentation retrieval within token budget.
 * Strict Application Layer: Zero Node I/O, Zero Infrastructure/Interfaces imports.
 */

import type { LibraryRegistry } from '../ports/LibraryRegistry.js';
import type { ManifestStore } from '../ports/ManifestStore.js';
import type { CorpusStore } from '../ports/CorpusStore.js';
import type { SearchBackend } from '../ports/SearchBackend.js';
import type { TokenCounter } from '../ports/TokenCounter.js';
import type { ContextResult, SearchFilter } from '../../domain/models/index.js';
import {
  InvalidRequestError,
  LibraryNotFoundError,
  VersionNotFoundError,
  CorpusNotReadyError,
  ResponseTooLargeError,
} from '../../domain/errors.js';
import { ChunkHydrator } from './ChunkHydrator.js';
import { ContextPacker } from './ContextPacker.js';

export interface GetContextInput {
  libraryId: string;
  query: string;
  versionKey?: string;
  maxTokens?: number;
  filters?: SearchFilter;
}

const ID_REGEX = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export class GetContextUseCase {
  private readonly chunkHydrator: ChunkHydrator;
  private readonly contextPacker: ContextPacker;

  constructor(
    private readonly registry: LibraryRegistry,
    private readonly manifestStore: ManifestStore,
    private readonly corpusStore: CorpusStore,
    private readonly searchBackend: SearchBackend,
    private readonly tokenCounter: TokenCounter,
    private readonly backendKey: string,
    chunkHydrator?: ChunkHydrator,
    contextPacker?: ContextPacker,
  ) {
    this.chunkHydrator = chunkHydrator ?? new ChunkHydrator(this.corpusStore, this.manifestStore);
    this.contextPacker = contextPacker ?? new ContextPacker(this.tokenCounter);
  }

  async execute(input: GetContextInput): Promise<ContextResult> {
    // 1. Validate libraryId
    if (!input.libraryId || !ID_REGEX.test(input.libraryId)) {
      throw new InvalidRequestError(
        `Invalid libraryId: '${input.libraryId}'. Must match pattern ^[a-z0-9][a-z0-9._-]{0,63}$`,
      );
    }

    // 2. Validate query
    const trimmedQuery = input.query ? input.query.trim() : '';
    if (trimmedQuery.length < 1 || trimmedQuery.length > 2000) {
      throw new InvalidRequestError(
        `Invalid query: length must be between 1 and 2000 characters (got ${trimmedQuery.length}).`,
      );
    }

    // 3. Validate maxTokens
    const maxTokens = this.contextPacker.validateMaxTokens(input.maxTokens);

    // 4. Validate versionKey format if provided
    if (input.versionKey !== undefined && !ID_REGEX.test(input.versionKey)) {
      throw new InvalidRequestError(
        `Invalid versionKey: '${input.versionKey}'. Must match pattern ^[a-z0-9][a-z0-9._-]{0,63}$`,
      );
    }

    // 5. Look up library from registry
    const library = await this.registry.getLibrary(input.libraryId);
    if (!library) {
      throw new LibraryNotFoundError(input.libraryId);
    }

    const availableVersionKeys = library.versions.map((v) => v.versionKey);
    const resolvedVersionKey = input.versionKey ?? library.defaultVersionKey;
    if (!availableVersionKeys.includes(resolvedVersionKey)) {
      throw new VersionNotFoundError(library.id, resolvedVersionKey, availableVersionKeys);
    }

    const versionConfig = library.versions.find((v) => v.versionKey === resolvedVersionKey);
    const staleAfterHours = versionConfig?.freshness.staleAfterHours ?? 168;

    // 6. Look up published pointer
    const publishedPointer = await this.manifestStore.getPublishedPointer(
      this.backendKey,
      library.id,
      resolvedVersionKey,
    );

    if (!publishedPointer) {
      throw new CorpusNotReadyError(library.id, resolvedVersionKey);
    }

    const generationId = publishedPointer.generationId;
    const indexGen = await this.manifestStore.getIndexGeneration(generationId);
    const corpusRevisionId = indexGen?.corpusRevisionId ?? '';

    // 7. Acquire short read lease (best effort)
    let readLeaseId: string | null = null;
    try {
      const lease = await this.manifestStore.acquireReadLease(generationId, 25000);
      readLeaseId = lease.leaseId;
    } catch {
      // Manifest implementations that don't enforce read lease
    }

    try {
      // 8. Execute search via backend
      const searchHits = await this.searchBackend.search({
        libraryId: library.id,
        versionKey: resolvedVersionKey,
        generationId,
        query: trimmedQuery,
        limit: 20,
        filters: input.filters,
      });

      // Check whether newer corpus revision is available in manifest
      const latestRev = await this.manifestStore.getLatestCorpusRevision(
        library.id,
        resolvedVersionKey,
      );
      const newerCorpusAvailable = latestRev
        ? latestRev.corpusRevisionId !== corpusRevisionId
        : false;

      // 9. Handle 0 matches (normal no_matches status)
      if (searchHits.length === 0) {
        return {
          status: 'no_matches',
          library: {
            id: library.id,
            versionKey: resolvedVersionKey,
          },
          query: trimmedQuery,
          generationId,
          corpusRevisionId,
          freshness: {
            publishedAt: publishedPointer.publishedAt,
            oldestSourceCheckAt: null,
            stale: false,
            newerCorpusAvailable,
          },
          context: '',
          sources: [],
          budget: {
            scope: 'context',
            tokenizerId: this.tokenCounter.tokenizerId,
            maxTokens,
            usedTokens: 0,
            truncated: false,
            omittedChunkCount: 0,
          },
        };
      }

      // 10. Hydrate chunks with revision manifest and content hash validation
      const candidates = await this.chunkHydrator.hydrate(
        searchHits,
        corpusRevisionId,
        library.id,
        resolvedVersionKey,
      );

      // 11. Pack context within maxTokens budget
      const packingResult = this.contextPacker.pack(candidates, maxTokens);

      if (packingResult.status === 'no_matches') {
        return {
          status: 'no_matches',
          library: {
            id: library.id,
            versionKey: resolvedVersionKey,
          },
          query: trimmedQuery,
          generationId,
          corpusRevisionId,
          freshness: {
            publishedAt: publishedPointer.publishedAt,
            oldestSourceCheckAt: null,
            stale: false,
            newerCorpusAvailable,
          },
          context: '',
          sources: [],
          budget: {
            scope: 'context',
            tokenizerId: this.tokenCounter.tokenizerId,
            maxTokens,
            usedTokens: 0,
            truncated: false,
            omittedChunkCount: 0,
          },
        };
      }

      // 12. Compute freshness from accepted sources
      let oldestSourceCheckAt: string | null = null;
      let isStale = false;
      if (packingResult.sources.length > 0) {
        const timestamps = packingResult.sources
          .map((s) => new Date(s.lastCheckedAt).getTime())
          .filter((t) => !isNaN(t));
        if (timestamps.length > 0) {
          const minTime = Math.min(...timestamps);
          oldestSourceCheckAt = new Date(minTime).toISOString();
          const ageHours = (Date.now() - minTime) / (1000 * 60 * 60);
          isStale = ageHours > staleAfterHours;
        }
      }

      const result: ContextResult = {
        status: 'ok',
        library: {
          id: library.id,
          versionKey: resolvedVersionKey,
        },
        query: trimmedQuery,
        generationId,
        corpusRevisionId,
        freshness: {
          publishedAt: publishedPointer.publishedAt,
          oldestSourceCheckAt,
          stale: isStale,
          newerCorpusAvailable,
        },
        context: packingResult.context,
        sources: packingResult.sources,
        budget: {
          scope: 'context',
          tokenizerId: this.tokenCounter.tokenizerId,
          maxTokens,
          usedTokens: packingResult.usedTokens,
          truncated: packingResult.truncated,
          omittedChunkCount: packingResult.omittedChunkCount,
        },
      };

      // 13. Check 1 MiB response size limit
      const serialized = JSON.stringify(result);
      if (Buffer.byteLength(serialized, 'utf-8') > 1048576) {
        throw new ResponseTooLargeError(Buffer.byteLength(serialized, 'utf-8'));
      }

      return result;
    } finally {
      if (readLeaseId) {
        await this.manifestStore.releaseReadLease(readLeaseId).catch(() => {});
      }
    }
  }
}
