/**
 * IndexUseCase
 * Coordinates indexing of a complete corpus revision into IndexBackend and publishes pointer in ManifestStore.
 * Lifecycle: STAGING -> IMPORTING -> VERIFYING -> READY -> PUBLISHED -> RETIRED -> DELETING -> DELETED
 * Supports: --plan, --resume <runId>, --abandon <runId>, --rebuild, --wait-seconds <n>
 * Strict Application Layer: Zero Node I/O, Zero Infrastructure/Interfaces imports.
 */

import type { LibraryRegistry } from '../ports/LibraryRegistry.js';
import type { ManifestStore, WriterLease } from '../ports/ManifestStore.js';
import type { CorpusStore } from '../ports/CorpusStore.js';
import type { IndexBackend, IndexEntryPayload, ReadinessProbe } from '../ports/IndexBackend.js';
import type { IndexGeneration, IndexGenerationState } from '../../domain/models/index.js';
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
  state: IndexGenerationState;
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
    const waitSeconds = input.waitSeconds ?? 1800;
    if (!Number.isInteger(waitSeconds) || waitSeconds < 1 || waitSeconds > 7200) {
      throw new InvalidRequestError('waitSeconds must be an integer between 1 and 7200.');
    }

    // 1. Validate mutually exclusive flags
    const modeCount = [
      Boolean(input.plan),
      Boolean(input.rebuild),
      Boolean(input.resumeRunId),
      Boolean(input.abandonRunId),
    ].filter(Boolean).length;
    if (modeCount > 1) {
      throw new InvalidRequestError(
        "Flags '--plan', '--rebuild', '--resume', and '--abandon' are mutually exclusive.",
      );
    }

    // 2. Validate IDs
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

    // 3. Resolve library and version
    const library = await this.registry.getLibrary(input.libraryId);
    if (!library) {
      throw new LibraryNotFoundError(input.libraryId);
    }

    const availableVersionKeys = library.versions.map((v) => v.versionKey);
    const resolvedVersionKey = input.versionKey ?? library.defaultVersionKey;
    if (!availableVersionKeys.includes(resolvedVersionKey)) {
      throw new VersionNotFoundError(library.id, resolvedVersionKey, availableVersionKeys);
    }

    // 4. Handle --abandon <runId>
    if (input.abandonRunId) {
      const gen = await this.manifestStore.getIndexGeneration(input.abandonRunId);
      if (!gen) {
        throw new CliOperationError({
          code: 'RESOURCE_LIMIT_EXCEEDED',
          message: `Index run '${input.abandonRunId}' not found.`,
          exitCode: 1,
        });
      }
      if (['published', 'retired', 'deleted'].includes(gen.state)) {
        throw new CliOperationError({
          code: 'RESOURCE_BUSY',
          message: `Cannot abandon index run '${input.abandonRunId}' in terminal state '${gen.state}'.`,
          exitCode: 1,
        });
      }

      let abandonLease: WriterLease | null = null;
      if (this.manifestStore.acquireWriterLease) {
        abandonLease = await this.manifestStore.acquireWriterLease('index-abandon', 30000);
      }
      try {
        await this.manifestStore.saveIndexGeneration({
          ...gen,
          state: 'abandoned',
          updatedAt: new Date().toISOString(),
        });
        return {
          libraryId: library.id,
          versionKey: resolvedVersionKey,
          corpusRevisionId: gen.corpusRevisionId,
          generationId: gen.generationId,
          entryCount: gen.entryCount,
          state: 'abandoned',
        };
      } finally {
        if (abandonLease && this.manifestStore.releaseWriterLease) {
          await this.manifestStore
            .releaseWriterLease(abandonLease.ownerId, abandonLease.fencingToken)
            .catch(() => {});
        }
      }
    }

    // 5. Current published pointer
    const currentPointer = await this.manifestStore.getPublishedPointer(
      this.backendKey,
      library.id,
      resolvedVersionKey,
    );

    // 6. Handle --resume <runId> or new generation
    let generationId: string;
    let existingGen: IndexGeneration | null = null;
    let targetRevisionId: string;

    if (input.resumeRunId) {
      existingGen = await this.manifestStore.getIndexGeneration(input.resumeRunId);
      if (!existingGen) {
        throw new CliOperationError({
          code: 'RESOURCE_LIMIT_EXCEEDED',
          message: `Index run '${input.resumeRunId}' not found for resume.`,
          exitCode: 1,
        });
      }
      if (['published', 'retired', 'abandoned', 'deleted'].includes(existingGen.state)) {
        throw new CliOperationError({
          code: 'RESOURCE_BUSY',
          message: `Cannot resume index run '${input.resumeRunId}' in terminal state '${existingGen.state}'.`,
          exitCode: 1,
        });
      }

      // Check if superseded
      if (currentPointer && currentPointer.generationId !== existingGen.generationId) {
        if (
          currentPointer.publishedAt &&
          existingGen.createdAt &&
          new Date(currentPointer.publishedAt).getTime() > new Date(existingGen.createdAt).getTime()
        ) {
          await this.manifestStore.saveIndexGeneration({
            ...existingGen,
            state: 'superseded',
            updatedAt: new Date().toISOString(),
          });
          throw new CliOperationError({
            code: 'INDEX_PARTIAL_FAILURE',
            message: `Index run '${input.resumeRunId}' has been superseded by newer published generation '${currentPointer.generationId}'. Cannot resume.`,
            exitCode: 1,
          });
        }
      }

      generationId = existingGen.generationId;
      targetRevisionId = existingGen.corpusRevisionId;
    } else {
      // Check for pending un-finished run
      if (!input.plan) {
        const pending = await this.manifestStore.getPendingIndexRun(
          library.id,
          resolvedVersionKey,
          this.backendKey,
        );
        if (pending) {
          throw new CliOperationError({
            code: 'INDEX_RUN_PENDING',
            message: `An index run is already pending for library '${library.id}' version '${resolvedVersionKey}': runId=${pending.generationId} (state=${pending.state}). Use --resume or --abandon.`,
            runId: pending.generationId,
            resumeRunId: pending.generationId,
            exitCode: 1,
          });
        }
      }

      // Find latest complete corpus revision
      const latestRevision = await this.manifestStore.getLatestCorpusRevision(
        library.id,
        resolvedVersionKey,
      );
      if (!latestRevision) {
        throw new CorpusNotReadyError(library.id, resolvedVersionKey);
      }

      // Check already indexed
      if (currentPointer && !input.rebuild && !input.plan) {
        const currentGen = await this.manifestStore.getIndexGeneration(currentPointer.generationId);
        if (currentGen && currentGen.corpusRevisionId === latestRevision.corpusRevisionId) {
          return {
            libraryId: library.id,
            versionKey: resolvedVersionKey,
            corpusRevisionId: latestRevision.corpusRevisionId,
            generationId: currentPointer.generationId,
            entryCount: currentGen.entryCount,
            state: 'published',
            alreadyIndexed: true,
            publishedAt: currentPointer.publishedAt,
          };
        }
      }

      generationId = computeGenerationId();
      targetRevisionId = latestRevision.corpusRevisionId;
    }

    // 7. Load full revision manifest from corpus store
    const revision = await this.corpusStore.getRevision(targetRevisionId);
    if (!revision) {
      throw new CorpusCorruptError(
        `Corpus revision '${targetRevisionId}' recorded in manifest is missing from corpus storage.`,
      );
    }

    // 8. Gather all chunks for this revision (Full generation journaling - Gate T-07)
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

    // 9. Dry-run plan mode
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

    // 10. Execute actual indexing with writer lease fencing
    let lease: WriterLease | null = null;
    if (this.manifestStore.acquireWriterLease) {
      lease = await this.manifestStore.acquireWriterLease('index-writer', 30000);
      if (!lease) {
        throw new CliOperationError({
          code: 'RESOURCE_BUSY',
          message: 'Failed to acquire writer lease for indexing: another writer is currently active.',
          exitCode: 1,
        });
      }
    }

    const nowIso = new Date().toISOString();
    const createdAt = existingGen?.createdAt ?? nowIso;

    try {
      // Stage generation in manifest and backend
      await this.manifestStore.saveIndexGeneration({
        generationId,
        backendKey: this.backendKey,
        corpusRevisionId: revision.corpusRevisionId,
        indexProfileHash: this.backendKey,
        state: 'staging',
        entryCount: entries.length,
        entryIds: entries.map((e) => e.indexEntryId),
        createdAt,
        updatedAt: new Date().toISOString(),
      });

      await this.indexBackend.stageGeneration(generationId);

      // Import entries in batches of 100
      await this.manifestStore.saveIndexGeneration({
        generationId,
        backendKey: this.backendKey,
        corpusRevisionId: revision.corpusRevisionId,
        indexProfileHash: this.backendKey,
        state: 'importing',
        entryCount: entries.length,
        entryIds: entries.map((e) => e.indexEntryId),
        createdAt,
        updatedAt: new Date().toISOString(),
      });

      const batchSize = 100;
      for (let i = 0; i < entries.length; i += batchSize) {
        const batch = entries.slice(i, i + batchSize);
        const importResult = await this.indexBackend.importBatch(generationId, batch);
        if (importResult.failedIds && importResult.failedIds.length > 0) {
          await this.manifestStore.saveIndexGeneration({
            generationId,
            backendKey: this.backendKey,
            corpusRevisionId: revision.corpusRevisionId,
            indexProfileHash: this.backendKey,
            state: 'failed',
            entryCount: entries.length,
            entryIds: entries.map((e) => e.indexEntryId),
            createdAt,
            updatedAt: new Date().toISOString(),
          });
          throw new CliOperationError({
            code: 'INDEX_PARTIAL_FAILURE',
            message: `Failed to index ${importResult.failedIds.length} entries into generation ${generationId}.`,
            runId: generationId,
            resumeRunId: generationId,
            exitCode: 1,
          });
        }
      }

      // Verifying readiness
      await this.manifestStore.saveIndexGeneration({
        generationId,
        backendKey: this.backendKey,
        corpusRevisionId: revision.corpusRevisionId,
        indexProfileHash: this.backendKey,
        state: 'verifying',
        entryCount: entries.length,
        entryIds: entries.map((e) => e.indexEntryId),
        createdAt,
        updatedAt: new Date().toISOString(),
      });

      // Build readiness probes
      const probes: ReadinessProbe[] = [];
      const versionConfig = library.versions.find((v) => v.versionKey === resolvedVersionKey);
      if (versionConfig?.readinessQueries && versionConfig.readinessQueries.length > 0) {
        for (const query of versionConfig.readinessQueries) {
          probes.push({ query });
        }
      }

      if (entries.length > 0 && probes.length === 0) {
        probes.push({
          query: entries[0]!.title,
          expectedChunkIds: [entries[0]!.chunkId],
        });
      }

      let readiness: Awaited<ReturnType<IndexBackend['verifyReadiness']>>;
      const readinessDeadline = Date.now() + waitSeconds * 1000;
      while (true) {
        const remainingMs = Math.max(1, readinessDeadline - Date.now());
        const controller = new AbortController();
        let timeoutFired = false;
        let readinessTimer: ReturnType<typeof setTimeout> | undefined;
        const readinessTimeout = new Promise<Awaited<ReturnType<IndexBackend['verifyReadiness']>>>((resolve) => {
          readinessTimer = setTimeout(() => {
            timeoutFired = true;
            resolve({
              state: 'pending',
              expectedCount: entries.length,
              indexedCount: 0,
              missingIds: entries.map((entry) => entry.indexEntryId),
              failedProbeQueries: probes.map((probe) => probe.query),
            });
          }, remainingMs);
        });

        try {
          readiness = await Promise.race([
            this.indexBackend.verifyReadiness(generationId, entries.length, probes, controller.signal),
            readinessTimeout,
          ]);
        } finally {
          if (readinessTimer) clearTimeout(readinessTimer);
          if (timeoutFired) controller.abort();
        }

        if (readiness.state !== 'pending' || Date.now() >= readinessDeadline) {
          break;
        }

        await new Promise<void>((resolve) => {
          setTimeout(resolve, Math.min(250, Math.max(1, readinessDeadline - Date.now())));
        });
      }

      if (readiness.state === 'pending') {
        await this.manifestStore.saveIndexGeneration({
          generationId,
          backendKey: this.backendKey,
          corpusRevisionId: revision.corpusRevisionId,
          indexProfileHash: this.backendKey,
          state: 'readiness_pending',
          entryCount: entries.length,
          entryIds: entries.map((e) => e.indexEntryId),
          readinessResult: readiness,
          createdAt,
          updatedAt: new Date().toISOString(),
        });
        throw new CliOperationError({
          code: 'READINESS_PENDING',
          message: `Readiness verification pending for generation ${generationId}.`,
          runId: generationId,
          resumeRunId: generationId,
          exitCode: 2,
        });
      }

      if (readiness.state !== 'ready') {
        await this.manifestStore.saveIndexGeneration({
          generationId,
          backendKey: this.backendKey,
          corpusRevisionId: revision.corpusRevisionId,
          indexProfileHash: this.backendKey,
          state: 'failed',
          entryCount: entries.length,
          entryIds: entries.map((e) => e.indexEntryId),
          readinessResult: readiness,
          createdAt,
          updatedAt: new Date().toISOString(),
        });
        throw new CliOperationError({
          code: 'INDEX_PARTIAL_FAILURE',
          message: `Readiness verification failed for generation ${generationId}.`,
          runId: generationId,
          resumeRunId: generationId,
          exitCode: 1,
        });
      }

      // Ready state recorded
      await this.manifestStore.saveIndexGeneration({
        generationId,
        backendKey: this.backendKey,
        corpusRevisionId: revision.corpusRevisionId,
        indexProfileHash: this.backendKey,
        state: 'ready',
        entryCount: entries.length,
        entryIds: entries.map((e) => e.indexEntryId),
        readinessResult: readiness,
        createdAt,
        updatedAt: new Date().toISOString(),
      });

      // Publish in backend
      await this.indexBackend.publishGeneration(generationId);

      // Atomically update published pointer
      const publishedAt = new Date().toISOString();
      await this.manifestStore.setPublishedPointer({
        backendKey: this.backendKey,
        libraryId: library.id,
        versionKey: resolvedVersionKey,
        generationId,
        previousGenerationId: currentPointer?.generationId,
        publishedAt,
      });

      // Retire previous generation (Gate T-07: previous generation marked retired, not deleted)
      if (currentPointer?.generationId && currentPointer.generationId !== generationId) {
        const prevGen = await this.manifestStore.getIndexGeneration(currentPointer.generationId);
        if (prevGen) {
          await this.manifestStore.saveIndexGeneration({
            ...prevGen,
            state: 'retired',
            updatedAt: publishedAt,
          });
          await this.indexBackend.retireGeneration(currentPointer.generationId).catch(() => {});
        }
      }

      // Transition this generation to published
      await this.manifestStore.saveIndexGeneration({
        generationId,
        backendKey: this.backendKey,
        corpusRevisionId: revision.corpusRevisionId,
        indexProfileHash: this.backendKey,
        state: 'published',
        entryCount: entries.length,
        entryIds: entries.map((e) => e.indexEntryId),
        readinessResult: readiness,
        createdAt,
        updatedAt: publishedAt,
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
      if (lease && this.manifestStore.releaseWriterLease) {
        await this.manifestStore
          .releaseWriterLease(lease.ownerId, lease.fencingToken)
          .catch(() => {});
      }
    }
  }
}
