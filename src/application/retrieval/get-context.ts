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
import type {
  ContextResult,
  SourceRef,
  SearchFilter,
  DocumentChunk,
} from '../../domain/models/index.js';
import {
  InvalidRequestError,
  LibraryNotFoundError,
  VersionNotFoundError,
  CorpusNotReadyError,
  TokenBudgetExceededError,
  ResponseTooLargeError,
  IndexInconsistentError,
} from '../../domain/errors.js';

export interface GetContextInput {
  libraryId: string;
  query: string;
  versionKey?: string;
  maxTokens?: number;
  filters?: SearchFilter;
}

const ID_REGEX = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export class GetContextUseCase {
  constructor(
    private readonly registry: LibraryRegistry,
    private readonly manifestStore: ManifestStore,
    private readonly corpusStore: CorpusStore,
    private readonly searchBackend: SearchBackend,
    private readonly tokenCounter: TokenCounter,
    private readonly backendKey: string,
  ) {}

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
    const maxTokens = input.maxTokens ?? 6000;
    if (!Number.isInteger(maxTokens) || maxTokens < 256 || maxTokens > 16000) {
      throw new InvalidRequestError(
        `Invalid maxTokens: must be an integer between 256 and 16000 (got ${maxTokens}).`,
      );
    }

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

    // 7. Execute search via backend
    const searchHits = await this.searchBackend.search({
      libraryId: library.id,
      versionKey: resolvedVersionKey,
      generationId,
      query: trimmedQuery,
      limit: 20,
      filters: input.filters,
    });

    // 8. Handle 0 matches (normal no_matches status)
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
          newerCorpusAvailable: false,
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

    // 9. Hydrate and deduplicate chunks
    const seenChunkIds = new Set<string>();
    const uniqueHits = searchHits.filter((hit) => {
      if (seenChunkIds.has(hit.chunkId)) return false;
      seenChunkIds.add(hit.chunkId);
      return true;
    });

    const chunkCandidates: Array<{ chunk: DocumentChunk; docUrl: string; lastCheckedAt: string }> = [];

    for (const hit of uniqueHits) {
      const chunk = await this.corpusStore.getChunk(
        versionConfig?.parser ? 'default' : 'default',
        hit.chunkId,
        hit.chunkId,
      );

      if (!chunk) {
        // In full pipeline this triggers INDEX_INCONSISTENT
        throw new IndexInconsistentError(
          `Chunk '${hit.chunkId}' returned by search backend does not exist in local corpus.`,
        );
      }

      const doc = await this.corpusStore.getDocument(chunk.documentId, chunk.snapshotId);
      const obs = await this.manifestStore.getObservation(chunk.documentId);

      chunkCandidates.push({
        chunk,
        docUrl: doc?.canonicalUrl ?? '',
        lastCheckedAt: obs?.lastCheckedAt ?? publishedPointer.publishedAt,
      });
    }

    // 10. Pack context within maxTokens budget
    const acceptedSources: SourceRef[] = [];
    const contextSections: string[] = [];
    let omittedChunkCount = 0;
    let truncated = false;

    for (let i = 0; i < chunkCandidates.length; i++) {
      const item = chunkCandidates[i];
      if (!item) continue;

      const sourceId = `S${acceptedSources.length + 1}`;
      const headingLine = item.chunk.headingPath.length > 0 ? ` > ${item.chunk.headingPath.join(' > ')}` : '';
      const anchorPart = item.chunk.anchor ? `#${item.chunk.anchor}` : '';
      const finalUrl = item.docUrl ? `${item.docUrl}${anchorPart}` : '';

      const sectionText = [
        `### [${sourceId}] ${item.chunk.title}${headingLine}`,
        `**Source**: ${finalUrl}`,
        '',
        item.chunk.content,
      ].join('\n');

      const proposedContext = contextSections.length === 0
        ? sectionText
        : contextSections.join('\n\n---\n\n') + '\n\n---\n\n' + sectionText;

      const proposedTokens = this.tokenCounter.count(proposedContext);

      if (proposedTokens <= maxTokens) {
        contextSections.push(sectionText);
        acceptedSources.push({
          id: sourceId,
          chunkId: item.chunk.chunkId,
          documentId: item.chunk.documentId,
          snapshotId: item.chunk.snapshotId,
          title: item.chunk.title,
          url: finalUrl,
          headingPath: item.chunk.headingPath,
          lastCheckedAt: item.lastCheckedAt,
        });
      } else {
        truncated = true;
        omittedChunkCount++;
      }
    }

    if (acceptedSources.length === 0 && chunkCandidates.length > 0) {
      throw new TokenBudgetExceededError(maxTokens);
    }

    const finalContext = contextSections.join('\n\n---\n\n');
    const usedTokens = this.tokenCounter.count(finalContext);

    // Compute freshness
    let oldestSourceCheckAt: string | null = null;
    let isStale = false;
    if (acceptedSources.length > 0) {
      const timestamps = acceptedSources
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
        newerCorpusAvailable: false,
      },
      context: finalContext,
      sources: acceptedSources,
      budget: {
        scope: 'context',
        tokenizerId: this.tokenCounter.tokenizerId,
        maxTokens,
        usedTokens,
        truncated,
        omittedChunkCount,
      },
    };

    // 11. Check 1 MiB response size limit
    const serialized = JSON.stringify(result);
    if (Buffer.byteLength(serialized, 'utf-8') > 1048576) {
      throw new ResponseTooLargeError(Buffer.byteLength(serialized, 'utf-8'));
    }

    return result;
  }
}
