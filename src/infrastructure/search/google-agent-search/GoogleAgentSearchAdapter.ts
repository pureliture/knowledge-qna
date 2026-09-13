/**
 * GoogleAgentSearchAdapter
 * Infrastructure search and index backend using official @google-cloud/discoveryengine SDK.
 * Strict Layer Boundary: Infrastructure layer only. Imports only application/ports and domain.
 */

import { SearchServiceClient, DocumentServiceClient } from '@google-cloud/discoveryengine';
import type {
  SearchBackend,
  SearchQueryParams,
  SearchHit,
  BackendHealth,
} from '../../../application/ports/SearchBackend.js';
import type {
  IndexBackend,
  IndexEntryPayload,
  ReadinessProbe,
  BatchImportResult,
} from '../../../application/ports/IndexBackend.js';
import type { ReadinessResult } from '../../../domain/models/index.js';
import {
  BackendMisconfiguredError,
  SearchFailedError,
  IndexInconsistentError,
  CliOperationError,
} from '../../../domain/errors.js';
import { computeBackendKey } from '../../../domain/identity.js';
import type {
  GoogleAgentSearchConfig,
  GoogleDocumentPayload,
  ISearchServiceClient,
  IDocumentServiceClient,
  GoogleClientFactory,
} from './types.js';

function escapeFilter(val: string): string {
  return val.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function sanitizeErrorMessage(msg: string): string {
  return msg
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/ya29\.[A-Za-z0-9_-]+/g, '[REDACTED_ACCESS_TOKEN]')
    .replace(/"private_key":\s*"[^"]+"/g, '"private_key": "[REDACTED]"')
    .replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA )?PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
    .replace(/\[REDACTED PRIVATE KEY\]/g, '[REDACTED_PRIVATE_KEY]')
    .replace(/client_secret=[^&\s]+/gi, 'client_secret=[REDACTED]');
}

export class GoogleAgentSearchAdapter implements SearchBackend, IndexBackend {
  readonly config: GoogleAgentSearchConfig;
  private readonly backendKey: string;
  private searchClient: ISearchServiceClient | null = null;
  private documentClient: IDocumentServiceClient | null = null;
  private clientFactory?: GoogleClientFactory;

  // Local generation stage tracker
  private readonly stagedGenerations = new Set<string>();

  constructor(
    config: GoogleAgentSearchConfig,
    clientsOrFactory?: {
      searchClient?: ISearchServiceClient;
      documentClient?: IDocumentServiceClient;
      clientFactory?: GoogleClientFactory;
    },
  ) {
    this.config = {
      location: 'global',
      collectionId: 'default_collection',
      servingConfigId: 'default_search',
      branchId: 'default_branch',
      pageSize: 20,
      maxBatchSizeBytes: 4 * 1024 * 1024, // 4 MiB
      maxBatchCount: 100,
      lroPollIntervalMs: 1000,
      lroTimeoutMs: 60000,
      ...config,
    };

    if (!this.config.projectId) {
      throw new BackendMisconfiguredError("Google Agent Search requires 'projectId' in configuration.");
    }
    if (!this.config.dataStoreId) {
      throw new BackendMisconfiguredError("Google Agent Search requires 'dataStoreId' in configuration.");
    }

    this.backendKey = computeBackendKey(
      'google-agent-search',
      this.config.projectId,
      this.config.location!,
      this.config.dataStoreId,
      this.config.servingConfigId!,
      'discoveryengine-v1',
    );

    if (clientsOrFactory?.searchClient) {
      this.searchClient = clientsOrFactory.searchClient;
    }
    if (clientsOrFactory?.documentClient) {
      this.documentClient = clientsOrFactory.documentClient;
    }
    if (clientsOrFactory?.clientFactory) {
      this.clientFactory = clientsOrFactory.clientFactory;
    }
  }

  getBackendKey(): string {
    return this.backendKey;
  }

  private async getSearchClient(): Promise<ISearchServiceClient> {
    if (!this.searchClient) {
      if (this.clientFactory) {
        this.searchClient = await this.clientFactory.createSearchClient();
      } else {
        this.searchClient = new SearchServiceClient();
      }
    }
    return this.searchClient;
  }

  private async getDocumentClient(): Promise<IDocumentServiceClient> {
    if (!this.documentClient) {
      if (this.clientFactory) {
        this.documentClient = await this.clientFactory.createDocumentClient();
      } else {
        this.documentClient = new DocumentServiceClient();
      }
    }
    return this.documentClient;
  }

  private getBranchPath(): string {
    return `projects/${this.config.projectId}/locations/${this.config.location}/collections/${this.config.collectionId}/dataStores/${this.config.dataStoreId}/branches/${this.config.branchId}`;
  }

  private getServingConfigPath(): string {
    return `projects/${this.config.projectId}/locations/${this.config.location}/collections/${this.config.collectionId}/dataStores/${this.config.dataStoreId}/servingConfigs/${this.config.servingConfigId}`;
  }

  // ==========================================
  // SearchBackend Implementation
  // ==========================================

  async search(params: SearchQueryParams): Promise<SearchHit[]> {
    const client = await this.getSearchClient();
    const servingConfig = this.getServingConfigPath();

    // Build strict scope and generation filter
    const filterParts: string[] = [];
    if (params.libraryId) {
      filterParts.push(`library_id: ANY("${escapeFilter(params.libraryId)}")`);
    }
    if (params.versionKey) {
      filterParts.push(`version_key: ANY("${escapeFilter(params.versionKey)}")`);
    }
    if (params.generationId) {
      filterParts.push(`generation_id: ANY("${escapeFilter(params.generationId)}")`);
    }

    if (params.filters?.language) {
      filterParts.push(`language: ANY("${escapeFilter(params.filters.language)}")`);
    }
    if (params.filters?.docType) {
      filterParts.push(`doc_type: ANY("${escapeFilter(params.filters.docType)}")`);
    }

    const filter = filterParts.join(' AND ');
    const pageSize = Math.min(Math.max(params.limit ?? this.config.pageSize ?? 20, 1), 100);

    let rawResults: any[] = [];
    try {
      const response = await client.search(
        {
          servingConfig,
          query: params.query,
          filter,
          pageSize,
          pageToken: params.cursor,
        },
        params.signal ? { autoPaginate: false, signal: params.signal } : { autoPaginate: false },
      );

      rawResults = response[0] ?? [];
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      const msg = sanitizeErrorMessage(rawMsg);
      throw new SearchFailedError(`Google Agent Search failed: ${msg}`, true);
    }

    const hits: SearchHit[] = [];
    for (let i = 0; i < rawResults.length; i++) {
      const item = rawResults[i];
      const doc = item.document ?? item;
      const struct = doc.structData ?? {};

      // Isolation check: strictly enforce that hit belongs to requested library, version, and generation
      if (struct.generation_id !== params.generationId) {
        throw new IndexInconsistentError(
          `Cross-generation leakage detected in Google search hit. Expected generation '${params.generationId}', but received '${struct.generation_id}'.`,
        );
      }

      if (
        (params.libraryId && struct.library_id !== params.libraryId) ||
        (params.versionKey && struct.version_key !== params.versionKey)
      ) {
        throw new IndexInconsistentError(
          `Cross-scope leakage detected in Google search hit. Expected '${params.libraryId}/${params.versionKey}', but received '${struct.library_id}/${struct.version_key}'.`,
        );
      }

      const chunkId = struct.chunk_id ?? '';
      const documentId = struct.document_id ?? '';
      const indexEntryId = doc.id ?? struct.index_entry_id ?? '';
      const contentHash = struct.content_hash ?? '';
      const content = struct.content ?? '';

      hits.push({
        indexEntryId,
        chunkId,
        documentId,
        generationId: struct.generation_id ?? params.generationId,
        libraryId: struct.library_id ?? params.libraryId,
        versionKey: struct.version_key ?? params.versionKey,
        rank: i + 1,
        score: item.modelScores?.[0] ?? undefined,
        contentHash,
        snippet: content.length > 300 ? content.slice(0, 300) + '...' : content,
        metadata: {
          title: struct.title,
          headingPath: struct.heading_path,
          canonicalUrl: struct.canonical_url,
          language: struct.language,
          docType: struct.doc_type,
          hasCode: struct.has_code,
        },
      });
    }

    return hits;
  }

  async health(signal?: AbortSignal): Promise<BackendHealth> {
    try {
      const client = await this.getSearchClient();
      // Probe with minimal request
      const servingConfig = this.getServingConfigPath();
      await client.search(
        {
          servingConfig,
          query: 'health-check-probe',
          pageSize: 1,
        },
        signal ? { autoPaginate: false, signal } : { autoPaginate: false },
      );

      return {
        status: 'ok',
        message: `Connected to Google Agent Search dataStore: ${this.config.dataStoreId}`,
      };
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      const msg = sanitizeErrorMessage(rawMsg);
      if (
        msg.includes('PERMISSION_DENIED') ||
        msg.includes('disabled') ||
        msg.includes('has not been used')
      ) {
        return {
          status: 'unavailable',
          message: `Discovery Engine API permission denied or API disabled for project ${this.config.projectId}`,
        };
      }
      if (msg.includes('NOT_FOUND') || msg.includes('does not exist')) {
        return {
          status: 'misconfigured',
          message: `Google Agent Search data store or serving config not found: ${msg}`,
        };
      }
      return {
        status: 'unavailable',
        message: `Google Agent Search health check failed: ${msg}`,
      };
    }
  }

  // ==========================================
  // IndexBackend Implementation
  // ==========================================

  async stageGeneration(generationId: string, _signal?: AbortSignal): Promise<void> {
    this.stagedGenerations.add(generationId);
  }

  async importBatch(
    generationId: string,
    entries: IndexEntryPayload[],
    signal?: AbortSignal,
  ): Promise<BatchImportResult> {
    const client = await this.getDocumentClient();
    const parent = this.getBranchPath();

    const maxCount = this.config.maxBatchCount ?? 100;
    const maxBytes = this.config.maxBatchSizeBytes ?? 4 * 1024 * 1024;

    // Validate indexEntryId format: 'k' + 52 base32 characters = 53 characters
    for (const entry of entries) {
      if (!entry.indexEntryId || !/^k[a-z2-7]{52}$/.test(entry.indexEntryId)) {
        throw new BackendMisconfiguredError(
          `Invalid indexEntryId '${entry.indexEntryId}'. Must match 53-character 'k' + base32(SHA256) format.`,
        );
      }
    }

    // Split entries into sub-batches respecting 100 count and 4 MiB limits
    const subBatches: IndexEntryPayload[][] = [];
    let currentBatch: IndexEntryPayload[] = [];
    let currentBatchBytes = 0;

    for (const entry of entries) {
      const docPayload: GoogleDocumentPayload = {
        id: entry.indexEntryId,
        structData: {
          library_id: entry.libraryId,
          version_key: entry.versionKey,
          generation_id: generationId,
          chunk_id: entry.chunkId,
          document_id: entry.documentId,
          snapshot_id: entry.snapshotId,
          content_hash: entry.contentHash,
          title: entry.title,
          content: entry.content,
          canonical_url: entry.url,
          heading_path: entry.headingPath,
          has_code: Boolean(entry.hasCode),
          ...(entry.language ? { language: entry.language } : {}),
          ...(entry.docType ? { doc_type: entry.docType } : {}),
        },
      };

      const entryBytes = Buffer.byteLength(JSON.stringify(docPayload), 'utf-8');

      if (
        currentBatch.length >= maxCount ||
        (currentBatchBytes + entryBytes > maxBytes && currentBatch.length > 0)
      ) {
        subBatches.push(currentBatch);
        currentBatch = [];
        currentBatchBytes = 0;
      }

      currentBatch.push(entry);
      currentBatchBytes += entryBytes;
    }

    if (currentBatch.length > 0) {
      subBatches.push(currentBatch);
    }

    let totalImported = 0;
    const failedIds: string[] = [];

    for (const subBatch of subBatches) {
      const documents: GoogleDocumentPayload[] = subBatch.map((entry) => ({
        id: entry.indexEntryId,
        structData: {
          library_id: entry.libraryId,
          version_key: entry.versionKey,
          generation_id: generationId,
          chunk_id: entry.chunkId,
          document_id: entry.documentId,
          snapshot_id: entry.snapshotId,
          content_hash: entry.contentHash,
          title: entry.title,
          content: entry.content,
          canonical_url: entry.url,
          heading_path: entry.headingPath,
          has_code: Boolean(entry.hasCode),
          ...(entry.language ? { language: entry.language } : {}),
          ...(entry.docType ? { doc_type: entry.docType } : {}),
        },
      }));

      try {
        const [operation] = await client.importDocuments(
          {
            parent,
            reconciliationMode: 'INCREMENTAL',
            inlineSource: {
              documents,
            },
          },
          signal ? { signal } : undefined,
        );

        // Wait for LRO if operation promise exists
        const batchFailedIds: string[] = [];
        if (operation && typeof operation.promise === 'function') {
          const operationPromise = operation.promise() as Promise<[any]>;
          let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
          const timeoutPromise = new Promise<[any]>((_, reject) => {
            timeoutHandle = setTimeout(() => {
              reject(new Error(`Import operation timed out after ${this.config.lroTimeoutMs}ms.`));
            }, this.config.lroTimeoutMs);
          });
          try {
            const [result] = await Promise.race([operationPromise, timeoutPromise]);
            if (result?.errorSamples && Array.isArray(result.errorSamples) && result.errorSamples.length > 0) {
              for (const sample of result.errorSamples) {
                const failedId = sample.documentId || sample.id;
                if (failedId) batchFailedIds.push(failedId);
              }
            }
          } finally {
            if (timeoutHandle) clearTimeout(timeoutHandle);
          }
        }

        failedIds.push(...batchFailedIds);
        totalImported += subBatch.length - batchFailedIds.length;
      } catch (err) {
        const rawMsg = err instanceof Error ? err.message : String(err);
        const msg = sanitizeErrorMessage(rawMsg);
        for (const entry of subBatch) {
          failedIds.push(entry.indexEntryId);
        }
        throw new CliOperationError({
          code: 'INDEX_PARTIAL_FAILURE',
          message: `Failed to import batch of ${subBatch.length} entries into generation ${generationId}: ${msg}`,
          exitCode: 1,
        });
      }
    }

    return {
      importedCount: totalImported,
      failedIds,
    };
  }

  async verifyReadiness(
    generationId: string,
    expectedCount: number,
    probes: Array<ReadinessProbe | string>,
    signal?: AbortSignal,
  ): Promise<ReadinessResult> {
    const failedProbeQueries: string[] = [];
    const missingIds: string[] = [];

    for (const probe of probes) {
      const query = typeof probe === 'string' ? probe : probe.query;
      const expectedChunkIds = typeof probe === 'string' ? undefined : probe.expectedChunkIds;

      try {
        const hits = await this.search({
          libraryId: '',
          versionKey: '',
          generationId,
          query,
          limit: 10,
          signal,
        });

        if (hits.length === 0) {
          failedProbeQueries.push(query);
          continue;
        }

        // Verify that returned hits belong strictly to this generation
        for (const hit of hits) {
          if (hit.generationId !== generationId) {
            failedProbeQueries.push(query);
            break;
          }
        }

        if (expectedChunkIds && expectedChunkIds.length > 0) {
          const matchedAny = hits.some((h) => expectedChunkIds.includes(h.chunkId));
          if (!matchedAny) {
            failedProbeQueries.push(query);
          }
        }
      } catch (err) {
        if (err instanceof IndexInconsistentError) {
          throw err;
        }
        failedProbeQueries.push(query);
      }
    }

    const state: ReadinessResult['state'] =
      failedProbeQueries.length === 0 ? 'ready' : 'pending';

    return {
      state,
      expectedCount,
      indexedCount: expectedCount,
      missingIds,
      failedProbeQueries,
    };
  }

  async publishGeneration(_generationId: string, _signal?: AbortSignal): Promise<void> {
    // Discovery Engine does not require a remote publish call because generation_id filter isolates queries
  }

  async retireGeneration(_generationId: string, _signal?: AbortSignal): Promise<void> {
    // Retired generation remains in Google data store until GC
  }

  async deleteGeneration(
    generationId: string,
    signal?: AbortSignal,
    entryIds: string[] = [],
  ): Promise<void> {
    this.stagedGenerations.delete(generationId);
    if (entryIds.length === 0) {
      throw new CliOperationError({
        code: 'RESOURCE_LIMIT_EXCEEDED',
        message: `Cannot delete Google generation '${generationId}' without its recorded entry IDs.`,
        exitCode: 1,
      });
    }

    const result = await this.deleteEntries(entryIds, signal);
    if (result.failedIds.length > 0) {
      throw new CliOperationError({
        code: 'INDEX_PARTIAL_FAILURE',
        message: `Failed to delete ${result.failedIds.length} entries from Google generation '${generationId}'.`,
        exitCode: 1,
      });
    }
  }

  async deleteEntries(
    ids: string[],
    signal?: AbortSignal,
  ): Promise<{ succeededIds: string[]; failedIds: string[] }> {
    const client = await this.getDocumentClient();
    const branchPath = this.getBranchPath();

    const succeededIds: string[] = [];
    const failedIds: string[] = [];

    for (const id of ids) {
      if (client.deleteDocument) {
        try {
          await client.deleteDocument(
            {
              name: `${branchPath}/documents/${id}`,
            },
            signal ? { signal } : undefined,
          );
          succeededIds.push(id);
        } catch {
          failedIds.push(id);
        }
      } else {
        succeededIds.push(id);
      }
    }

    return { succeededIds, failedIds };
  }
}
