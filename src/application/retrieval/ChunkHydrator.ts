/**
 * ChunkHydrator
 * Strict Application Layer: Zero Node I/O, Zero Infrastructure/Interfaces imports.
 * Hydrates search hits into canonical local chunks, verifies corpus revision membership,
 * and validates content hash integrity (Gate T-09, Gate T-11).
 */

import type { CorpusStore } from '../ports/CorpusStore.js';
import type { ManifestStore } from '../ports/ManifestStore.js';
import type { SearchHit } from '../ports/SearchBackend.js';
import { IndexInconsistentError, CorpusCorruptError } from '../../domain/errors.js';
import { sha256Hex, computeChunkId } from '../../domain/identity.js';
import type { HydratedCandidate } from './CitationMapper.js';

interface RevisionChunkLocation {
  documentId: string;
  snapshotId: string;
  chunkerProfileId: string;
}

export class ChunkHydrator {
  constructor(
    private readonly corpusStore: CorpusStore,
    private readonly manifestStore: ManifestStore,
  ) {}

  /**
   * Hydrates an array of SearchHits into fully verified HydratedCandidate chunks.
   *
   * @param hits Candidate hits returned from search backend
   * @param corpusRevisionId Target published corpus revision ID
   * @param expectedLibraryId Optional expected library ID for scope verification
   * @param expectedVersionKey Optional expected version key for scope verification
   */
  async hydrate(
    hits: SearchHit[],
    corpusRevisionId: string,
    expectedLibraryId?: string,
    expectedVersionKey?: string,
  ): Promise<HydratedCandidate[]> {
    if (!hits || hits.length === 0) {
      return [];
    }

    // 1. Deduplicate hits by chunkId while preserving rank order
    const seenChunkIds = new Set<string>();
    const uniqueHits: SearchHit[] = [];
    for (const hit of hits) {
      if (!seenChunkIds.has(hit.chunkId)) {
        seenChunkIds.add(hit.chunkId);
        uniqueHits.push(hit);
      }
    }

    // 2. Fetch the target corpus revision to verify membership
    const revision = await this.corpusStore.getRevision(corpusRevisionId);
    if (!revision) {
      throw new IndexInconsistentError(
        `Corpus revision '${corpusRevisionId}' does not exist in local corpus store.`,
      );
    }

    // 3. Build O(1) map from revision.documents
    const chunkMap = new Map<string, RevisionChunkLocation>();
    for (const docEntry of revision.documents) {
      for (const cId of docEntry.chunkIds) {
        chunkMap.set(cId, {
          documentId: docEntry.documentId,
          snapshotId: docEntry.snapshotId,
          chunkerProfileId: docEntry.chunkerProfileId,
        });
      }
    }

    const candidates: HydratedCandidate[] = [];

    // 4. Hydrate and verify each hit
    for (const hit of uniqueHits) {
      // Scope verification
      if (expectedLibraryId && hit.libraryId && hit.libraryId !== expectedLibraryId) {
        throw new IndexInconsistentError(
          `Search hit libraryId '${hit.libraryId}' does not match expected libraryId '${expectedLibraryId}'.`,
        );
      }
      if (expectedVersionKey && hit.versionKey && hit.versionKey !== expectedVersionKey) {
        throw new IndexInconsistentError(
          `Search hit versionKey '${hit.versionKey}' does not match expected versionKey '${expectedVersionKey}'.`,
        );
      }

      // Check revision manifest membership
      const location = chunkMap.get(hit.chunkId);
      if (!location) {
        throw new IndexInconsistentError(
          `Chunk '${hit.chunkId}' returned by search backend is not registered in published corpus revision '${corpusRevisionId}'.`,
        );
      }

      // Load chunk from CorpusStore
      const chunk = await this.corpusStore.getChunk(
        location.chunkerProfileId,
        location.snapshotId,
        hit.chunkId,
      );

      if (!chunk) {
        throw new CorpusCorruptError(
          `Chunk '${hit.chunkId}' is registered in manifest but chunk file is missing from corpus storage.`,
        );
      }

      // Verify content hash integrity
      const calculatedHash = sha256Hex(chunk.content);
      if (calculatedHash !== chunk.contentHash) {
        throw new CorpusCorruptError(
          `Chunk '${hit.chunkId}' content hash mismatch: expected '${chunk.contentHash}', calculated '${calculatedHash}'.`,
        );
      }

      // Verify deterministic chunk ID calculation
      const calculatedChunkId = computeChunkId(
        chunk.snapshotId,
        chunk.chunkerProfileId,
        chunk.chunkIndex,
        chunk.headingPath,
        chunk.content,
      );
      if (calculatedChunkId !== chunk.chunkId) {
        throw new CorpusCorruptError(
          `Chunk '${hit.chunkId}' ID mismatch: expected '${chunk.chunkId}', calculated '${calculatedChunkId}'.`,
        );
      }

      // If search hit provided a contentHash, verify it matches the canonical chunk
      if (hit.contentHash && hit.contentHash !== chunk.contentHash) {
        throw new IndexInconsistentError(
          `Search hit contentHash '${hit.contentHash}' does not match canonical chunk hash '${chunk.contentHash}'.`,
        );
      }

      // Load associated document and observation for URL and freshness
      const doc = await this.corpusStore.getDocument(chunk.documentId, chunk.snapshotId);
      const obs = await this.manifestStore.getObservation(chunk.documentId);

      candidates.push({
        chunk,
        document: doc,
        lastCheckedAt: obs?.lastCheckedAt ?? revision.createdAt,
        rank: hit.rank,
      });
    }

    return candidates;
  }
}
