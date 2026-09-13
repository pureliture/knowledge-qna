/**
 * IndexUseCase
 * Coordinates indexing of a complete corpus revision into IndexBackend and publishes pointer in ManifestStore.
 * Strict Application Layer: Zero Node I/O, Zero Infrastructure/Interfaces imports.
 */

import type { LibraryRegistry } from '../ports/LibraryRegistry.js';
import type { ManifestStore } from '../ports/ManifestStore.js';
import type { CorpusStore } from '../ports/CorpusStore.js';
import type { IndexBackend, IndexEntryPayload, ReadinessProbe } from '../ports/IndexBackend.js';
import {
  InvalidRequestError,
  LibraryNotFoundError,
  VersionNotFoundError,
  CorpusNotReadyError,
  CorpusCorruptError,
  CliOperationError,
} from '../../domain/errors.js';
import { computeGenerationId, computeIndexEntryId } from '../../domain/identity.js';

export interface IndexInput {
  libraryId: string;
  versionKey?: string;
  plan?: boolean;
  rebuild?: boolean;
  waitSeconds?: number;
  resumeRunId?: string;
  abandonRunId?: string;
}

export interface IndexResult {
  libraryId: string;
  versionKey: string;
  corpusRevisionId: string;
  generationId: string;
  entryCount: number;
  state: 'published' | 'staging' | 'readiness_pending' | 'abandoned';
  alreadyIndexed?: boolean;
  publishedAt?: string;
  plan?: {
    entryCount: number;
    batchCount: number;
    corpusRevisionId: string;
  };
}

const ID_REGEX = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export class IndexUseCase {
  constructor(
    private readonly registry: LibraryRegistry,
    private readonly manifestStore: ManifestStore,
    private readonly corpusStore: CorpusStore,
    private readonly indexBackend: IndexBackend,
    private readonly backendKey: string,
  ) {}

  async execute(input: IndexInput): Promise<IndexResult> {
    // 1. Validate inputs
    if (!input.libraryId || !ID_REGEX.test(input.libraryId)) {
      throw new InvalidRequestError(
        `Invalid libraryId: '${input.libraryId}'. Must match pattern ^[a-z0-9][a-z0-9._-]{0,63}$`,
      );
    }
    if (input.versionKey !== undefined && !ID_REGEX.test(input.versionKey)) {
      throw new InvalidRequestError(
        `Invalid versionKey: '${input.versionKey}'. Must match pattern ^[a-z0-9][a-z0-9._-]{0,63}$`,
      );
    }

    // 2. Resolve library and version
    const library = await this.registry.getLibrary(input.libraryId);
    if (!library) {
      throw new LibraryNotFoundError(input.libraryId);
    }

    const availableVersionKeys = library.versions.map((v) => v.versionKey);
    const resolvedVersionKey = input.versionKey ?? library.defaultVersionKey;
    if (!availableVersionKeys.includes(resolvedVersionKey)) {
      throw new VersionNotFoundError(library.id, resolvedVersionKey, availableVersionKeys);
    }

    // 3. Find latest complete corpus revision
    const latestRevision = await this.manifestStore.getLatestCorpusRevision(
      library.id,
      resolvedVersionKey,
    );
    if (!latestRevision) {
      throw new CorpusNotReadyError(
        library.id,
        resolvedVersionKey,
      );
    }

    // 4. Load full revision manifest from corpus store
    const revision = await this.corpusStore.getRevision(latestRevision.corpusRevisionId);
    if (!revision) {
      throw new CorpusCorruptError(
        `Corpus revision '${latestRevision.corpusRevisionId}' recorded in manifest is missing from corpus storage.`,
      );
    }

    // 5. Check if this revision is already published
    const currentPointer = await this.manifestStore.getPublishedPointer(
      this.backendKey,
      library.id,
      resolvedVersionKey,
    );

    if (currentPointer && !input.rebuild) {
      const currentGen = await this.manifestStore.getIndexGeneration(currentPointer.generationId);
      if (currentGen && currentGen.corpusRevisionId === revision.corpusRevisionId) {
        if (!input.plan) {
          return {
            libraryId: library.id,
            versionKey: resolvedVersionKey,
            corpusRevisionId: revision.corpusRevisionId,
            generationId: currentPointer.generationId,
            entryCount: currentGen.entryCount,
            state: 'published',
            alreadyIndexed: true,
            publishedAt: currentPointer.publishedAt,
          };
        }
      }
    }

    // 6. Gather all chunks for this revision
    const generationId = computeGenerationId();
    const entries: IndexEntryPayload[] = [];

    for (const docEntry of revision.documents) {
      const doc = await this.corpusStore.getDocument(docEntry.documentId, docEntry.snapshotId);
      const chunks = await this.corpusStore.getChunksForSnapshot(
        docEntry.chunkerProfileId,
        docEntry.snapshotId,
      );

      for (const chunk of chunks) {
        entries.push({
          indexEntryId: computeIndexEntryId(generationId, chunk.chunkId),
          generationId,
          chunkId: chunk.chunkId,
          documentId: chunk.documentId,
          snapshotId: chunk.snapshotId,
          libraryId: library.id,
          versionKey: resolvedVersionKey,
          title: chunk.title,
          headingPath: chunk.headingPath,
          content: chunk.content,
          url: doc?.canonicalUrl ?? '',
          contentHash: chunk.contentHash,
          hasCode: chunk.hasCode,
          language: doc?.metadata?.language,
          docType: doc?.metadata?.docType,
        });
      }
    }

    // 7. Dry-run plan mode
    if (input.plan) {
      return {
        libraryId: library.id,
        versionKey: resolvedVersionKey,
        corpusRevisionId: revision.corpusRevisionId,
        generationId: 'plan-only',
        entryCount: entries.length,
        state: 'staging',
        plan: {
          entryCount: entries.length,
          batchCount: Math.ceil(entries.length / 100),
          corpusRevisionId: revision.corpusRevisionId,
        },
      };
    }

    // 8. Execute actual indexing
    let lease = null;
    try {
      lease = await this.manifestStore.acquireWriterLease('index-writer', 30000);
    } catch {
      // Best effort if leases not required in current environment
    }

    try {
      // Stage generation in backend
      await this.indexBackend.stageGeneration(generationId);

      // Import entries in batches of 100
      const batchSize = 100;
      for (let i = 0; i < entries.length; i += batchSize) {
        const batch = entries.slice(i, i + batchSize);
        const importResult = await this.indexBackend.importBatch(generationId, batch);
        if (importResult.failedIds.length > 0) {
          throw new CliOperationError({
            code: 'INDEX_PARTIAL_FAILURE',
            message: `Failed to index ${importResult.failedIds.length} entries into generation ${generationId}.`,
            exitCode: 1,
          });
        }
      }

      // Build readiness probes
      const probes: ReadinessProbe[] = [];
      if (entries.length > 0) {
        probes.push({
          query: entries[0]!.title,
          expectedChunkIds: [entries[0]!.chunkId],
        });
      }

      const readiness = await this.indexBackend.verifyReadiness(
        generationId,
        entries.length,
        probes,
      );

      if (readiness.state !== 'ready') {
        throw new CliOperationError({
          code: 'READINESS_PENDING',
          message: `Readiness verification pending or failed for generation ${generationId}.`,
          exitCode: 2,
        });
      }

      // Publish in backend
      await this.indexBackend.publishGeneration(generationId);

      // Record generation in manifest store
      await this.manifestStore.saveIndexGeneration({
        generationId,
        backendKey: this.backendKey,
        corpusRevisionId: revision.corpusRevisionId,
        indexProfileHash: 'in-memory-v1',
        state: 'published',
        entryCount: entries.length,
        entryIds: entries.map((e) => e.indexEntryId),
        readinessResult: readiness,
      });

      // Update published pointer atomically
      const publishedAt = new Date().toISOString();
      await this.manifestStore.setPublishedPointer({
        backendKey: this.backendKey,
        libraryId: library.id,
        versionKey: resolvedVersionKey,
        generationId,
        previousGenerationId: currentPointer?.generationId,
        publishedAt,
      });

      return {
        libraryId: library.id,
        versionKey: resolvedVersionKey,
        corpusRevisionId: revision.corpusRevisionId,
        generationId,
        entryCount: entries.length,
        state: 'published',
        publishedAt,
      };
    } finally {
      if (lease) {
        await this.manifestStore.releaseWriterLease(lease.ownerId, lease.fencingToken).catch(() => {});
      }
    }
  }
}
