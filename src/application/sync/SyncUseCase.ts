/**
 * SyncUseCase
 * Orchestrates: library resolution -> writer lease -> discovery -> incremental conditional fetch
 * -> structure-preserving normalization -> atomic AST chunking -> CAS storage -> manifest commit.
 * Guarantees:
 * - Gate T-03: HTTP 304 and identical normalizedHash reuse existing snapshot/chunk IDs deterministically.
 * - Gate T-05: Partial discovery failures or timeouts do NOT cause document deletion;
 *              deletion requires 2 consecutive full discovery absences or explicit 404/410.
 * - Gate T-06: docsctx sync creates an immutable corpus revision with ZERO modification
 *              to published search generation pointers.
 * Strict Layer Boundary: Application imports only domain and application/ports.
 */

import { randomUUID } from 'node:crypto';
import type {
  LibraryDefinition,
  LibraryVersionConfig,
  CorpusRevision,
  CorpusDocumentEntry,
  CorpusRevisionMetadata,
  NormalizedDocument,
  FetchObservation,
} from '../../domain/models/index.js';
import {
  canonicalHash,
  computeDocumentId,
  computeCorpusRevisionId,
} from '../../domain/identity.js';
import {
  CliOperationError,
  LibraryNotFoundError,
  VersionNotFoundError,
  CorpusCorruptError,
} from '../../domain/errors.js';
import type { LibraryRegistry } from '../ports/LibraryRegistry.js';
import type { ManifestStore, WriterLease } from '../ports/ManifestStore.js';
import type { CorpusStore } from '../ports/CorpusStore.js';
import type { SourceProvider, DiscoveredUrl } from '../ports/SourceProvider.js';
import type { DocumentFetcher, FetchRequest, FetchResponse } from '../ports/DocumentFetcher.js';
import type { DocumentNormalizer } from '../ports/DocumentNormalizer.js';
import type { DocumentChunker } from '../ports/DocumentChunker.js';

export interface SyncRequest {
  libraryId: string;
  versionKey?: string;
}

export interface SyncResult {
  runId: string;
  libraryId: string;
  versionKey: string;
  corpusRevisionId: string;
  discoveredCount: number;
  fetchedCount: number;
  storedCount: number;
  unchangedCount: number;
  deletedCount: number;
  status: 'complete';
}

export class SyncUseCase {
  constructor(
    private readonly libraryRegistry: LibraryRegistry,
    private readonly manifestStore: ManifestStore,
    private readonly corpusStore: CorpusStore,
    private readonly sourceProvider: SourceProvider,
    private readonly documentFetcher: DocumentFetcher,
    private readonly documentNormalizer: DocumentNormalizer,
    private readonly documentChunker: DocumentChunker,
  ) {}

  async execute(request: SyncRequest, signal?: AbortSignal): Promise<SyncResult> {
    // 1. Resolve library and version configuration
    const lib = await this.libraryRegistry.getLibrary(request.libraryId);
    if (!lib) {
      throw new LibraryNotFoundError(request.libraryId);
    }

    const versionKey = request.versionKey ?? lib.defaultVersionKey;
    const versionConfig = lib.versions.find((v) => v.versionKey === versionKey);
    if (!versionConfig) {
      throw new VersionNotFoundError(
        lib.id,
        versionKey,
        lib.versions.map((v) => v.versionKey),
      );
    }

    // 2. Acquire writer lease (30s lease)
    const ownerId = `sync-${randomUUID()}`;
    const lease = await this.manifestStore.acquireWriterLease(ownerId, 30000);
    if (!lease) {
      throw new CliOperationError({
        code: 'RESOURCE_BUSY',
        message: 'Could not acquire writer lease on manifest catalog. Another sync/index operation may be running.',
      });
    }

    const normalizerProfile = {
      profileId: this.documentNormalizer.profileId,
      ...versionConfig.parser,
    };
    const chunkerProfile = {
      profileId: this.documentChunker.profileId,
      ...versionConfig.chunking,
    };
    const profileHash = canonicalHash({ normalizerProfile, chunkerProfile });
    const sourceHash = canonicalHash(versionConfig.source);

    const runId = `run-${randomUUID()}`;
    const startedAt = new Date().toISOString();

    // 3. Start sync run record
    await this.manifestStore.startSyncRun({
      runId,
      libraryId: lib.id,
      versionKey,
      sourceHash,
      profileHash,
      status: 'running',
      startedAt,
      discoveredCount: 0,
      fetchedCount: 0,
      storedCount: 0,
      unchangedCount: 0,
      errorCount: 0,
    });

    let heartbeatTimer: NodeJS.Timeout | undefined;

    try {
      heartbeatTimer = setInterval(async () => {
        try {
          await this.manifestStore.renewWriterLease(ownerId, lease.fencingToken, 30000);
        } catch {
          // Ignore renewal error during background heartbeat
        }
      }, 10000);
      if (heartbeatTimer.unref) {
        heartbeatTimer.unref();
      }

      return await this.performSync({
        lib,
        versionKey,
        versionConfig,
        runId,
        normalizerProfile,
        chunkerProfile,
        profileHash,
        sourceHash,
        ownerId,
        fencingToken: lease.fencingToken,
        signal,
      });
    } catch (err) {
      await this.manifestStore
        .updateSyncRun({
          runId,
          status: 'failed',
          completedAt: new Date().toISOString(),
          errorCount: 1,
          errorCode: err instanceof CliOperationError ? err.code : 'SOURCE_FETCH_FAILED',
          errorMessage: err instanceof Error ? err.message : String(err),
        })
        .catch(() => {});
      throw err;
    } finally {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
      // Release writer lease
      await this.manifestStore.releaseWriterLease(ownerId, lease.fencingToken).catch(() => {});
    }
  }

  private async performSync(params: {
    lib: LibraryDefinition;
    versionKey: string;
    versionConfig: LibraryVersionConfig;
    runId: string;
    normalizerProfile: Record<string, unknown>;
    chunkerProfile: Record<string, unknown>;
    profileHash: string;
    sourceHash: string;
    ownerId: string;
    fencingToken: number;
    signal?: AbortSignal;
  }): Promise<SyncResult> {
    const {
      lib,
      versionKey,
      versionConfig,
      runId,
      normalizerProfile,
      chunkerProfile,
      profileHash,
      ownerId,
      fencingToken,
      signal,
    } = params;

    // 4. Discovery step
    const discovery = await this.sourceProvider.discover(versionConfig.source, signal);
    const summary = discovery.summary;

    if (summary.aborted) {
      throw new CliOperationError({
        code: 'SOURCE_FETCH_FAILED',
        message: 'Sync discovery was aborted.',
      });
    }

    if (discovery.urls.length === 0) {
      throw new CliOperationError({
        code: 'SOURCE_EMPTY',
        message: 'No URLs discovered for library source.',
      });
    }

    // 5. Load previous state
    const prevRevMeta = await this.manifestStore.getLatestCorpusRevision(lib.id, versionKey);
    const prevRevision = prevRevMeta
      ? await this.corpusStore.getRevision(prevRevMeta.corpusRevisionId)
      : null;

    const prevObservations = await this.manifestStore.getObservationsForLibrary(lib.id, versionKey);
    const prevObsMap = new Map(prevObservations.map((o) => [o.documentId, o]));

    const prevDocsMap = new Map<string, CorpusDocumentEntry>();
    if (prevRevision) {
      for (const doc of prevRevision.documents) {
        prevDocsMap.set(doc.documentId, doc);
      }
    }

    // 6. Map discovered URLs
    const discoveredDocIds = new Set<string>();
    const discoveredUrlMap = new Map<string, DiscoveredUrl>();

    for (const item of discovery.urls) {
      const docId = computeDocumentId(lib.id, versionKey, item.url);
      discoveredDocIds.add(docId);
      discoveredUrlMap.set(docId, item);
    }

    let fetchedCount = 0;
    let storedCount = 0;
    let unchangedCount = 0;
    let deletedCount = 0;

    const nextDocEntries = new Map<string, CorpusDocumentEntry>();

    // 7. Handle deletion detection for undiscovered documents (Gate T-05)
    if (prevRevision) {
      for (const prevDoc of prevRevision.documents) {
        if (!discoveredDocIds.has(prevDoc.documentId)) {
          if (!summary.complete) {
            // Partial discovery failure or timeout: MUST NOT delete documents! (Gate T-05)
            nextDocEntries.set(prevDoc.documentId, prevDoc);
            unchangedCount++;
          } else {
            // Complete discovery: increment consecutive absence count
            const prevObs = prevObsMap.get(prevDoc.documentId);
            const prevAbsences = prevObs?.consecutiveAbsences ?? 0;
            const newAbsences = prevAbsences + 1;

            if (newAbsences >= 2) {
              // Confirmed deletion! (2 consecutive complete discovery absences)
              deletedCount++;
              await this.manifestStore.recordObservation({
                runId,
                documentId: prevDoc.documentId,
                snapshotId: prevDoc.snapshotId,
                requestedUrl: prevObs?.requestedUrl ?? '',
                fetchedUrl: prevObs?.fetchedUrl ?? '',
                status: 404,
                lastCheckedAt: new Date().toISOString(),
                consecutiveAbsences: newAbsences,
              });
              // Document excluded from next revision
            } else {
              // 1st absence: keep in revision with missing pending
              nextDocEntries.set(prevDoc.documentId, prevDoc);
              unchangedCount++;
              await this.manifestStore.recordObservation({
                runId,
                documentId: prevDoc.documentId,
                snapshotId: prevDoc.snapshotId,
                requestedUrl: prevObs?.requestedUrl ?? '',
                fetchedUrl: prevObs?.fetchedUrl ?? '',
                status: prevObs?.status ?? 200,
                lastCheckedAt: new Date().toISOString(),
                consecutiveAbsences: newAbsences,
              });
            }
          }
        }
      }
    }

    // 8. Fetch and process discovered documents
    for (const [docId, discItem] of discoveredUrlMap) {
      if (signal?.aborted) {
        throw new CliOperationError({
          code: 'SOURCE_FETCH_FAILED',
          message: 'Sync fetch aborted by signal.',
        });
      }

      fetchedCount++;
      const prevObs = prevObsMap.get(docId);
      const prevDoc = prevDocsMap.get(docId);

      const fetchReq: FetchRequest = {
        url: discItem.url,
        eTag: prevObs?.ETag,
        lastModified: prevObs?.LastModified,
        security: {
          allowedHosts: versionConfig.source.allowedHosts,
          includePaths: versionConfig.source.includePaths,
          excludePaths: versionConfig.source.excludePaths,
          allowHttp: versionConfig.source.allowHttp,
        },
      };

      const fetchRes = await this.documentFetcher.fetch(fetchReq, signal);

      // Handle 404 / 410 explicit deletion
      if (fetchRes.status === 404 || fetchRes.status === 410) {
        deletedCount++;
        await this.manifestStore.recordObservation({
          runId,
          documentId: docId,
          snapshotId: prevDoc?.snapshotId,
          requestedUrl: discItem.url,
          fetchedUrl: fetchRes.fetchedUrl,
          status: fetchRes.status,
          lastCheckedAt: fetchRes.checkedAt,
          consecutiveAbsences: 2,
        });
        continue;
      }

      // Handle 304 Not Modified (Gate T-03)
      if (fetchRes.status === 304) {
        const hasSnap = prevDoc
          ? await this.corpusStore.hasDocument(docId, prevDoc.snapshotId)
          : false;

        if (hasSnap && prevDoc) {
          // Snapshot and chunks exist deterministically on disk: reuse or rechunk
          const docEntry = await this.resolveDocEntry(
            docId,
            prevDoc.snapshotId,
            prevDoc,
            versionConfig,
            () => {
              unchangedCount++;
            },
            () => {
              storedCount++;
            },
          );
          nextDocEntries.set(docId, docEntry);
          await this.manifestStore.recordObservation({
            runId,
            documentId: docId,
            snapshotId: prevDoc.snapshotId,
            requestedUrl: discItem.url,
            fetchedUrl: fetchRes.fetchedUrl,
            status: 304,
            lastCheckedAt: fetchRes.checkedAt,
            rawHash: prevObs?.rawHash,
            ETag: fetchRes.eTag ?? prevObs?.ETag,
            LastModified: fetchRes.lastModified ?? prevObs?.LastModified,
            consecutiveAbsences: 0,
          });
          continue;
        } else {
          // Snapshot missing locally: execute unconditional GET fallback
          const fallbackRes = await this.documentFetcher.fetch(
            { ...fetchReq, eTag: undefined, lastModified: undefined },
            signal,
          );
          if (fallbackRes.status === 200) {
            await this.process200(
              docId,
              discItem.url,
              fallbackRes,
              prevDoc,
              prevObs,
              runId,
              lib.id,
              versionKey,
              versionConfig,
              nextDocEntries,
              () => {
                unchangedCount++;
              },
              () => {
                storedCount++;
              },
            );
          }
          continue;
        }
      }

      // Handle 200 OK (Gate T-03)
      if (fetchRes.status === 200) {
        await this.process200(
          docId,
          discItem.url,
          fetchRes,
          prevDoc,
          prevObs,
          runId,
          lib.id,
          versionKey,
          versionConfig,
          nextDocEntries,
          () => {
            unchangedCount++;
          },
          () => {
            storedCount++;
          },
        );
      }
    }

    // 9. Assemble deterministic revision documents
    const sortedDocEntries = Array.from(nextDocEntries.values()).sort((a, b) =>
      a.documentId.localeCompare(b.documentId),
    );

    if (sortedDocEntries.length === 0) {
      throw new CliOperationError({
        code: 'SOURCE_EMPTY',
        message: 'Sync completed with zero valid documents.',
      });
    }

    // 10. Persist profiles in CorpusStore
    await this.corpusStore.saveProfile(this.documentNormalizer.profileId, normalizerProfile);
    await this.corpusStore.saveProfile(this.documentChunker.profileId, chunkerProfile);

    // 11. Compute deterministic corpus revision ID (§5.1)
    const corpusRevisionId = computeCorpusRevisionId(
      lib.id,
      versionKey,
      profileHash,
      sortedDocEntries,
    );

    const existingRev = await this.corpusStore.getRevision(corpusRevisionId);
    const createdAt = existingRev ? existingRev.createdAt : new Date().toISOString();

    const revision: CorpusRevision = {
      schemaVersion: 1,
      corpusRevisionId,
      libraryId: lib.id,
      versionKey,
      createdAt,
      documents: sortedDocEntries,
      registryProfileSnapshot: {
        versionConfigHash: profileHash,
        normalizerProfile,
        chunkerProfile,
      },
    };

    // Save revision payload in CorpusStore
    await this.corpusStore.saveRevision(revision);

    // 12. Atomically commit revision in ManifestStore (single SQLite CAS transaction)
    const revisionMetadata: CorpusRevisionMetadata = {
      corpusRevisionId,
      libraryId: lib.id,
      versionKey,
      createdAt: revision.createdAt,
      versionProfileHash: profileHash,
      documentCount: sortedDocEntries.length,
      syncRunId: runId,
      isComplete: summary.complete,
    };

    await this.manifestStore.commitSyncRevision(
      revisionMetadata,
      {
        runId,
        status: 'complete',
        completedAt: new Date().toISOString(),
        discoveredCount: discovery.urls.length,
        fetchedCount,
        storedCount,
        unchangedCount,
        errorCount: 0,
        corpusRevisionId,
      },
      { ownerId, fencingToken },
    );

    // NOTE: Gate T-06 Guarantee:
    // docsctx sync NEVER modifies published search pointers (setPublishedPointer is not called).

    return {
      runId,
      libraryId: lib.id,
      versionKey,
      corpusRevisionId,
      discoveredCount: discovery.urls.length,
      fetchedCount,
      storedCount,
      unchangedCount,
      deletedCount,
      status: 'complete',
    };
  }

  private async process200(
    docId: string,
    canonicalUrl: string,
    fetchRes: Extract<FetchResponse, { status: 200 }>,
    prevDoc: CorpusDocumentEntry | undefined,
    prevObs: FetchObservation | undefined,
    runId: string,
    libraryId: string,
    versionKey: string,
    versionConfig: LibraryVersionConfig,
    nextDocEntries: Map<string, CorpusDocumentEntry>,
    onUnchanged: () => void,
    onStored: () => void,
  ): Promise<void> {
    // 1. Raw hash comparison
    if (
      prevObs?.rawHash === fetchRes.rawHash &&
      prevDoc &&
      (await this.corpusStore.hasDocument(docId, prevDoc.snapshotId))
    ) {
      // Raw bytes identical: reuse existing snapshot and chunks or rechunk!
      const docEntry = await this.resolveDocEntry(
        docId,
        prevDoc.snapshotId,
        prevDoc,
        versionConfig,
        onUnchanged,
        onStored,
      );
      nextDocEntries.set(docId, docEntry);
      await this.manifestStore.recordObservation({
        runId,
        documentId: docId,
        snapshotId: prevDoc.snapshotId,
        requestedUrl: canonicalUrl,
        fetchedUrl: fetchRes.fetchedUrl,
        status: 200,
        lastCheckedAt: new Date().toISOString(),
        fetchedAt: fetchRes.fetchedAt,
        rawHash: fetchRes.rawHash,
        ETag: fetchRes.eTag ?? prevObs?.ETag,
        LastModified: fetchRes.lastModified ?? prevObs?.LastModified,
        consecutiveAbsences: 0,
      });
      return;
    }

    // 2. Normalize HTML
    const normalizedDoc = await this.documentNormalizer.normalize({
      libraryId,
      versionKey,
      canonicalUrl,
      html: fetchRes.rawBody,
      parserConfig: versionConfig.parser,
      normalizerProfileId: this.documentNormalizer.profileId,
    });

    // 3. Normalized hash comparison (nav/ad changes only)
    let prevSnap: NormalizedDocument | null = null;
    if (prevDoc) {
      prevSnap = await this.corpusStore.getDocument(docId, prevDoc.snapshotId);
    }

    if (prevSnap && prevSnap.normalizedHash === normalizedDoc.normalizedHash && prevDoc) {
      // Content identical after normalization: reuse snapshot and chunk IDs or rechunk! (Gate T-03)
      const docEntry = await this.resolveDocEntry(
        docId,
        prevDoc.snapshotId,
        prevDoc,
        versionConfig,
        onUnchanged,
        onStored,
      );
      nextDocEntries.set(docId, docEntry);
      await this.manifestStore.recordObservation({
        runId,
        documentId: docId,
        snapshotId: prevDoc.snapshotId,
        requestedUrl: canonicalUrl,
        fetchedUrl: fetchRes.fetchedUrl,
        status: 200,
        lastCheckedAt: new Date().toISOString(),
        fetchedAt: fetchRes.fetchedAt,
        rawHash: fetchRes.rawHash,
        ETag: fetchRes.eTag ?? prevObs?.ETag,
        LastModified: fetchRes.lastModified ?? prevObs?.LastModified,
        consecutiveAbsences: 0,
      });
      return;
    }

    // 4. Real content change or brand new document
    // Save normalized document to CorpusStore
    await this.corpusStore.saveDocument(normalizedDoc);

    // Chunk document using AST chunker
    const chunks = await this.documentChunker.chunk({
      document: normalizedDoc,
      config: versionConfig.chunking,
      chunkerProfileId: this.documentChunker.profileId,
    });

    // Save chunks to CorpusStore
    await this.corpusStore.saveChunks(
      this.documentChunker.profileId,
      normalizedDoc.snapshotId,
      chunks,
    );
    onStored();

    const chunkIds = chunks.map((c) => c.chunkId);
    const docEntry: CorpusDocumentEntry = {
      documentId: docId,
      snapshotId: normalizedDoc.snapshotId,
      chunkerProfileId: this.documentChunker.profileId,
      chunkIds,
    };
    nextDocEntries.set(docId, docEntry);

    await this.manifestStore.recordObservation({
      runId,
      documentId: docId,
      snapshotId: normalizedDoc.snapshotId,
      requestedUrl: canonicalUrl,
      fetchedUrl: fetchRes.fetchedUrl,
      status: 200,
      lastCheckedAt: new Date().toISOString(),
      fetchedAt: fetchRes.fetchedAt,
      rawHash: fetchRes.rawHash,
      ETag: fetchRes.eTag,
      LastModified: fetchRes.lastModified,
      consecutiveAbsences: 0,
    });
  }

  private async resolveDocEntry(
    docId: string,
    snapshotId: string,
    prevDoc: CorpusDocumentEntry | undefined,
    versionConfig: LibraryVersionConfig,
    onUnchanged: () => void,
    onStored: () => void,
  ): Promise<CorpusDocumentEntry> {
    const chunkerProfileId = this.documentChunker.profileId;

    // 1. Chunker profile unchanged -> perfectly reuse previous document entry
    if (prevDoc && prevDoc.chunkerProfileId === chunkerProfileId) {
      onUnchanged();
      return prevDoc;
    }

    // 2. Chunker profile changed -> re-chunk from preserved normalized Markdown
    const normalizedDoc = await this.corpusStore.getDocument(docId, snapshotId);
    if (!normalizedDoc) {
      throw new CorpusCorruptError(
        `Preserved snapshot '${snapshotId}' for document '${docId}' not found in corpus store.`,
      );
    }

    const chunks = await this.documentChunker.chunk({
      document: normalizedDoc,
      config: versionConfig.chunking,
      chunkerProfileId,
    });

    await this.corpusStore.saveChunks(chunkerProfileId, snapshotId, chunks);
    onStored();

    return {
      documentId: docId,
      snapshotId,
      chunkerProfileId,
      chunkIds: chunks.map((c) => c.chunkId),
    };
  }
}
