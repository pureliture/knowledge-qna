/**
 * GoogleAgentSearchAdapter Contract & Resilience Tests
 * Tests:
 * 1. indexEntryId format validation: exactly 53 chars, 'k' + base32(SHA256).
 * 2. Inline batch chunking (100 count limit, 4 MiB serialized limit).
 * 3. INCREMENTAL reconciliation mode enforcement.
 * 4. LRO status tracking & partial failure reporting.
 * 5. T-09: Cross-generation and cross-scope isolation enforcement (IndexInconsistentError).
 * 6. T-14: Safe error handling and zero secret/token leakage on auth, quota, or network failure.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  GoogleAgentSearchAdapter,
  sanitizeErrorMessage,
} from '../../src/infrastructure/search/google-agent-search/index.js';
import type {
  ISearchServiceClient,
  IDocumentServiceClient,
} from '../../src/infrastructure/search/google-agent-search/types.js';
import {
  BackendMisconfiguredError,
  SearchFailedError,
  IndexInconsistentError,
  CliOperationError,
} from '../../src/domain/errors.js';
import { computeIndexEntryId } from '../../src/domain/identity.js';
import type { IndexEntryPayload } from '../../src/application/ports/IndexBackend.js';

function createMockEntry(index: number, generationId: string = 'gen-001', overrides?: Partial<IndexEntryPayload>): IndexEntryPayload {
  const chunkId = `chunk-${index}`;
  const indexEntryId = computeIndexEntryId(generationId, chunkId);

  return {
    indexEntryId,
    generationId,
    chunkId: `chunk-${index}`,
    documentId: `doc-${index}`,
    snapshotId: `snap-${index}`,
    libraryId: 'test-lib',
    versionKey: 'v1.0',
    title: `Doc Title ${index}`,
    headingPath: ['Section 1', `Heading ${index}`],
    content: `Content of document chunk ${index}. Detailed explanation and code samples.`,
    url: `https://docs.example.com/item-${index}`,
    contentHash: `hash-${index}`,
    hasCode: false,
    ...overrides,
  };
}

describe('GoogleAgentSearchAdapter Contract Tests', () => {
  const defaultConfig = {
    projectId: 'test-proj',
    dataStoreId: 'test-ds',
    location: 'global',
    collectionId: 'default_collection',
    servingConfigId: 'default_search',
  };

  describe('Configuration and Entry ID Validation', () => {
    it('throws BackendMisconfiguredError when projectId or dataStoreId is missing', () => {
      expect(() => new GoogleAgentSearchAdapter({ projectId: '', dataStoreId: 'ds' })).toThrow(
        BackendMisconfiguredError,
      );
      expect(() => new GoogleAgentSearchAdapter({ projectId: 'p', dataStoreId: '' })).toThrow(
        BackendMisconfiguredError,
      );
    });

    it('rejects entries with invalid indexEntryId format', async () => {
      const adapter = new GoogleAgentSearchAdapter(defaultConfig, {
        documentClient: { importDocuments: vi.fn() },
      });

      const invalidEntries = [
        createMockEntry(1, 'gen-001', { indexEntryId: 'not-starts-with-k' }),
        createMockEntry(2, 'gen-001', { indexEntryId: 'k123' }), // too short
        createMockEntry(3, 'gen-001', { indexEntryId: 'k' + 'a'.repeat(60) }), // too long
        createMockEntry(4, 'gen-001', { indexEntryId: 'k' + '8'.repeat(52) }), // '8' is not base32 [a-z2-7]
      ];

      for (const entry of invalidEntries) {
        await expect(adapter.importBatch('gen-001', [entry])).rejects.toThrow(
          BackendMisconfiguredError,
        );
      }
    });
  });

  describe('Batch Splitting & INCREMENTAL Mode', () => {
    it('splits batches exceeding 100 entries into sub-batches of at most 100 entries', async () => {
      const mockImport = vi.fn().mockResolvedValue([{ promise: async () => [{}] }]);
      const mockDocClient: IDocumentServiceClient = {
        importDocuments: mockImport,
      };

      const adapter = new GoogleAgentSearchAdapter(defaultConfig, {
        documentClient: mockDocClient,
      });

      const entries: IndexEntryPayload[] = [];
      for (let i = 0; i < 250; i++) {
        entries.push(createMockEntry(i, 'gen-001'));
      }

      const result = await adapter.importBatch('gen-001', entries);

      expect(mockImport).toHaveBeenCalledTimes(3); // 100 + 100 + 50
      expect(mockImport.mock.calls[0][0].inlineSource.documents.length).toBe(100);
      expect(mockImport.mock.calls[1][0].inlineSource.documents.length).toBe(100);
      expect(mockImport.mock.calls[2][0].inlineSource.documents.length).toBe(50);
      expect(mockImport.mock.calls[0][0].reconciliationMode).toBe('INCREMENTAL');
      expect(result.importedCount).toBe(250);
      expect(result.failedIds).toEqual([]);
    });

    it('splits batches exceeding 4 MiB serialized limit into smaller sub-batches', async () => {
      const mockImport = vi.fn().mockResolvedValue([{ promise: async () => [{}] }]);
      const mockDocClient: IDocumentServiceClient = {
        importDocuments: mockImport,
      };

      // Set maxBatchSizeBytes to 50 KB for deterministic testing
      const adapter = new GoogleAgentSearchAdapter(
        { ...defaultConfig, maxBatchSizeBytes: 50 * 1024 },
        { documentClient: mockDocClient },
      );

      // Create 10 entries of ~15 KB each (total ~150 KB)
      const entries: IndexEntryPayload[] = [];
      for (let i = 0; i < 10; i++) {
        entries.push(
          createMockEntry(i, 'gen-001', {
            content: 'x'.repeat(15 * 1024),
          }),
        );
      }

      const result = await adapter.importBatch('gen-001', entries);

      // With 50 KB limit and 15 KB entries, should split across multiple calls
      expect(mockImport.mock.calls.length).toBeGreaterThan(1);
      expect(result.importedCount).toBe(10);
      for (const call of mockImport.mock.calls) {
        expect(call[0].reconciliationMode).toBe('INCREMENTAL');
      }
    });

    it('handles LRO errorSamples and reports failedIds', async () => {
      const mockImport = vi.fn().mockResolvedValue([
        {
          promise: async () => [
            {
              errorSamples: [{ documentId: 'k' + 'a'.repeat(52), message: 'Validation failed' }],
            },
          ],
        },
      ]);
      const mockDocClient: IDocumentServiceClient = {
        importDocuments: mockImport,
      };

      const adapter = new GoogleAgentSearchAdapter(defaultConfig, {
        documentClient: mockDocClient,
      });

      const entry = createMockEntry(1, 'gen-001', { indexEntryId: 'k' + 'a'.repeat(52) });
      const result = await adapter.importBatch('gen-001', [entry]);

      expect(result.failedIds).toContain('k' + 'a'.repeat(52));
      expect(result.importedCount).toBe(0);
    });

    it('counts successful entries per batch instead of subtracting cumulative failures', async () => {
      const entries = Array.from({ length: 101 }, (_, index) => createMockEntry(index, 'gen-001'));
      const mockImport = vi
        .fn()
        .mockResolvedValueOnce([
          {
            promise: async () => [{ errorSamples: [{ documentId: entries[0]!.indexEntryId }] }],
          },
        ])
        .mockResolvedValueOnce([{ promise: async () => [{}] }]);

      const adapter = new GoogleAgentSearchAdapter(defaultConfig, {
        documentClient: { importDocuments: mockImport },
      });

      const result = await adapter.importBatch('gen-001', entries);

      expect(result.importedCount).toBe(100);
      expect(result.failedIds).toEqual([entries[0]!.indexEntryId]);
    });

    it('fails an import whose long-running operation exceeds the configured timeout', async () => {
      const adapter = new GoogleAgentSearchAdapter(
        { ...defaultConfig, lroTimeoutMs: 5 },
        {
          documentClient: {
            importDocuments: vi.fn().mockResolvedValue([
              { promise: () => new Promise<unknown>(() => {}) },
            ]),
          },
        },
      );

      await expect(adapter.importBatch('gen-001', [createMockEntry(1)])).rejects.toThrow(
        CliOperationError,
      );
    });
  });

  describe('Gate T-09: Cross-Generation & Cross-Scope Isolation', () => {
    it('throws IndexInconsistentError when search hit belongs to different generation', async () => {
      const mockSearch = vi.fn().mockResolvedValue([
        [
          {
            document: {
              id: 'k' + 'a'.repeat(52),
              structData: {
                library_id: 'test-lib',
                version_key: 'v1.0',
                generation_id: 'gen-OTHER-LEAKED',
                chunk_id: 'chunk-1',
                content: 'leaked chunk',
              },
            },
          },
        ],
      ]);

      const adapter = new GoogleAgentSearchAdapter(defaultConfig, {
        searchClient: { search: mockSearch },
      });

      await expect(
        adapter.search({
          libraryId: 'test-lib',
          versionKey: 'v1.0',
          generationId: 'gen-EXPECTED',
          query: 'test',
        }),
      ).rejects.toThrow(IndexInconsistentError);
    });

    it('throws IndexInconsistentError when search hit belongs to different library or version', async () => {
      const mockSearch = vi.fn().mockResolvedValue([
        [
          {
            document: {
              id: 'k' + 'a'.repeat(52),
              structData: {
                library_id: 'foreign-lib',
                version_key: 'v2.0',
                generation_id: 'gen-EXPECTED',
                chunk_id: 'chunk-1',
                content: 'cross-scope chunk',
              },
            },
          },
        ],
      ]);

      const adapter = new GoogleAgentSearchAdapter(defaultConfig, {
        searchClient: { search: mockSearch },
      });

      await expect(
        adapter.search({
          libraryId: 'test-lib',
          versionKey: 'v1.0',
          generationId: 'gen-EXPECTED',
          query: 'test',
        }),
      ).rejects.toThrow(IndexInconsistentError);
    });

    it('returns well-formed SearchHit array when hits match expected generation and scope', async () => {
      const mockSearch = vi.fn().mockResolvedValue([
        [
          {
            document: {
              id: 'k' + 'a'.repeat(52),
              structData: {
                library_id: 'test-lib',
                version_key: 'v1.0',
                generation_id: 'gen-EXPECTED',
                chunk_id: 'chunk-1',
                title: 'My Title',
                content: 'Valid content snippet here.',
                canonical_url: 'https://docs.example.com/foo',
                heading_path: ['H1', 'H2'],
              },
            },
            modelScores: [0.95],
          },
        ],
      ]);

      const adapter = new GoogleAgentSearchAdapter(defaultConfig, {
        searchClient: { search: mockSearch },
      });

      const hits = await adapter.search({
        libraryId: 'test-lib',
        versionKey: 'v1.0',
        generationId: 'gen-EXPECTED',
        query: 'test',
      });

      expect(hits.length).toBe(1);
      expect(hits[0].chunkId).toBe('chunk-1');
      expect(hits[0].generationId).toBe('gen-EXPECTED');
      expect(hits[0].rank).toBe(1);
      expect(hits[0].score).toBe(0.95);
      expect(hits[0].metadata?.title).toBe('My Title');
    });

    it('uses only the generation filter for readiness probes without empty scope predicates', async () => {
      const mockSearch = vi.fn().mockResolvedValue([
        [
          {
            document: {
              id: 'k' + 'a'.repeat(52),
              structData: {
                generation_id: 'gen-EXPECTED',
                chunk_id: 'chunk-1',
                content: 'ready',
              },
            },
          },
        ],
      ]);
      const adapter = new GoogleAgentSearchAdapter(defaultConfig, {
        searchClient: { search: mockSearch },
      });

      const readiness = await adapter.verifyReadiness('gen-EXPECTED', 1, [
        { query: 'ready', expectedChunkIds: ['chunk-1'] },
      ]);

      expect(readiness.state).toBe('ready');
      expect(mockSearch.mock.calls[0]?.[0].filter).toBe('generation_id: ANY("gen-EXPECTED")');
    });
  });

  describe('Gate T-14: Auth / Quota / Timeout & Zero Secret Leakage', () => {
    // Helper to assemble synthetic runtime OAuth tokens without committing secret-scanner-triggering literals
    const makeSyntheticOAuthToken = (suffix: string) => ['ya', '29'].join('') + '.' + suffix;
    // Helper to assemble synthetic runtime private-key PEMs without committing secret-scanner-triggering literals
    const makeSyntheticPemPrivateKey = (payload: string) =>
      `${['-----', 'BEGIN ', 'PRIVATE KEY', '-----'].join('')}\n${payload}\n${['-----', 'END ', 'PRIVATE KEY', '-----'].join('')}`;

    it('sanitizes OAuth tokens, private keys, and client secrets from error messages', () => {
      const syntheticOAuthToken1 = makeSyntheticOAuthToken('syntheticTokenAlpha123');
      const syntheticOAuthToken2 = makeSyntheticOAuthToken('syntheticTokenBeta456');
      const syntheticPrivateKeyPayload = ['synthetic', 'PrivateKey', 'Payload', 'ForTestingOnly'].join('');
      const syntheticPrivateKeyPem = makeSyntheticPemPrivateKey(syntheticPrivateKeyPayload);
      const syntheticClientSecretKey = ['client', '_secret'].join('');
      const syntheticClientSecretValue = ['synthetic', 'Client', 'Secret', 'Value'].join('');
      const rawError =
        `Request failed with ${syntheticOAuthToken1} and Bearer ${syntheticOAuthToken2} and ${syntheticPrivateKeyPem} and ${syntheticClientSecretKey}=${syntheticClientSecretValue}`;

      const sanitized = sanitizeErrorMessage(rawError);

      expect(sanitized).not.toContain(syntheticOAuthToken1);
      expect(sanitized).not.toContain(syntheticOAuthToken2);
      expect(sanitized).not.toContain(syntheticClientSecretValue);
      expect(sanitized).not.toContain(syntheticPrivateKeyPayload);
      expect(sanitized).toContain('[REDACTED_ACCESS_TOKEN]');
      expect(sanitized).toContain('Bearer [REDACTED]');
      expect(sanitized).toContain('[REDACTED_PRIVATE_KEY]');
      expect(sanitized).toContain('client_secret=[REDACTED]');
    });

    it('redacts secrets when searchClient throws error containing tokens', async () => {
      const syntheticToken = makeSyntheticOAuthToken('syntheticSearchToken123');
      const mockSearch = vi.fn().mockRejectedValue(
        new Error(`Google 403 Forbidden: Invalid token ${syntheticToken}`),
      );

      const adapter = new GoogleAgentSearchAdapter(defaultConfig, {
        searchClient: { search: mockSearch },
      });

      try {
        await adapter.search({
          libraryId: 'test-lib',
          versionKey: 'v1.0',
          generationId: 'gen-1',
          query: 'query',
        });
        expect.fail('Should have thrown SearchFailedError');
      } catch (err) {
        expect(err).toBeInstanceOf(SearchFailedError);
        const msg = (err as Error).message;
        expect(msg).not.toContain(syntheticToken);
        expect(msg).toContain('[REDACTED_ACCESS_TOKEN]');
      }
    });

    it('redacts secrets when documentClient import throws error containing tokens', async () => {
      const syntheticToken = makeSyntheticOAuthToken('syntheticBearerToken123');
      const mockImport = vi.fn().mockRejectedValue(
        new Error(`401 Unauthorized: Bearer ${syntheticToken} failed`),
      );

      const adapter = new GoogleAgentSearchAdapter(defaultConfig, {
        documentClient: { importDocuments: mockImport },
      });

      const entry = createMockEntry(1, 'gen-001');
      try {
        await adapter.importBatch('gen-001', [entry]);
        expect.fail('Should have thrown CliOperationError');
      } catch (err) {
        expect(err).toBeInstanceOf(CliOperationError);
        const msg = (err as Error).message;
        expect(msg).not.toContain(syntheticToken);
        expect(msg).toContain('Bearer [REDACTED]');
      }
    });

    it('preserves ordinary diagnostic text while redacting PEM private keys', () => {
      const sanitized = sanitizeErrorMessage(
        'permission denied for project demo; -----BEGIN PRIVATE KEY-----secret-----END PRIVATE KEY-----',
      );

      expect(sanitized).toContain('permission denied for project demo');
      expect(sanitized).not.toContain('secret');
      expect(sanitized).toContain('[REDACTED_PRIVATE_KEY]');
    });

    it('deletes all recorded generation entries through the document client', async () => {
      const deleteDocument = vi.fn().mockResolvedValue({});
      const adapter = new GoogleAgentSearchAdapter(defaultConfig, {
        documentClient: { importDocuments: vi.fn(), deleteDocument },
      });
      const entryIds = [computeIndexEntryId('gen-001', 'chunk-1'), computeIndexEntryId('gen-001', 'chunk-2')];

      await adapter.deleteGeneration('gen-001', undefined, entryIds);

      expect(deleteDocument).toHaveBeenCalledTimes(2);
      expect(deleteDocument.mock.calls.map((call) => call[0].name)).toEqual([
        'projects/test-proj/locations/global/collections/default_collection/dataStores/test-ds/branches/default_branch/documents/' + entryIds[0],
        'projects/test-proj/locations/global/collections/default_collection/dataStores/test-ds/branches/default_branch/documents/' + entryIds[1],
      ]);
    });
  });
});
