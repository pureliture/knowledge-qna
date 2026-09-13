import { describe, it, expect, beforeEach } from 'vitest';
import { ChunkHydrator } from '../../src/application/retrieval/ChunkHydrator.js';
import type { CorpusStore } from '../../src/application/ports/CorpusStore.js';
import type { ManifestStore } from '../../src/application/ports/ManifestStore.js';
import type { SearchHit } from '../../src/application/ports/SearchBackend.js';
import type { CorpusRevision, DocumentChunk, NormalizedDocument } from '../../src/domain/models/index.js';
import { IndexInconsistentError, CorpusCorruptError } from '../../src/domain/errors.js';
import { sha256Hex, computeChunkId } from '../../src/domain/identity.js';

describe('ChunkHydrator (Gate T-11)', () => {
  let mockCorpusStore: Partial<CorpusStore>;
  let mockManifestStore: Partial<ManifestStore>;
  let hydrator: ChunkHydrator;

  const libraryId = 'palantir-foundry';
  const versionKey = 'current';
  const corpusRevisionId = 'rev-123';
  const snapshotId = 'snap-1';
  const chunkerProfileId = 'prof-1';
  const documentId = 'doc-1';

  const validContent = 'This is verified canonical content.';
  const validHash = sha256Hex(validContent);
  const validChunkId = computeChunkId(snapshotId, chunkerProfileId, 0, ['Overview'], validContent);

  const mockChunk: DocumentChunk = {
    schemaVersion: 1,
    chunkId: validChunkId,
    documentId,
    snapshotId,
    libraryId,
    versionKey,
    chunkerProfileId,
    title: 'Foundry Guide',
    headingPath: ['Overview'],
    content: validContent,
    chunkIndex: 0,
    hasCode: false,
    oversized: false,
    tokenCount: 15,
    contentHash: validHash,
  };

  const mockRevision: CorpusRevision = {
    schemaVersion: 1,
    corpusRevisionId,
    libraryId,
    versionKey,
    createdAt: '2026-09-13T10:00:00.000Z',
    documents: [
      {
        documentId,
        snapshotId,
        chunkerProfileId,
        chunkIds: [validChunkId],
      },
    ],
    registryProfileSnapshot: {
      versionConfigHash: 'vcfg',
      normalizerProfile: {},
      chunkerProfile: {},
    },
  };

  const mockDoc: NormalizedDocument = {
    schemaVersion: 1,
    documentId,
    snapshotId,
    libraryId,
    versionKey,
    canonicalUrl: 'https://example.com/foundry',
    title: 'Foundry Guide',
    markdown: validContent,
    headings: [{ level: 1, text: 'Foundry Guide' }],
    normalizedHash: 'nh-1',
    normalizerProfileId: 'norm-1',
    metadata: {},
  };

  beforeEach(() => {
    mockCorpusStore = {
      getRevision: async (id: string) => (id === corpusRevisionId ? mockRevision : null),
      getChunk: async (pId, sId, cId) => (cId === validChunkId ? { ...mockChunk } : null),
      getDocument: async (dId, sId) => (dId === documentId ? mockDoc : null),
    };

    mockManifestStore = {
      getObservation: async (dId) => ({
        runId: 'run-1',
        documentId: dId,
        requestedUrl: 'https://example.com/foundry',
        fetchedUrl: 'https://example.com/foundry',
        status: 200,
        lastCheckedAt: '2026-09-13T10:30:00.000Z',
      }),
    };

    hydrator = new ChunkHydrator(
      mockCorpusStore as CorpusStore,
      mockManifestStore as ManifestStore,
    );
  });

  it('hydrates valid search hits and deduplicates identical chunkIds', async () => {
    const hits: SearchHit[] = [
      {
        indexEntryId: 'k1',
        chunkId: validChunkId,
        documentId,
        generationId: 'gen-1',
        libraryId,
        versionKey,
        rank: 1,
      },
      {
        indexEntryId: 'k1-duplicate',
        chunkId: validChunkId,
        documentId,
        generationId: 'gen-1',
        libraryId,
        versionKey,
        rank: 2,
      },
    ];

    const candidates = await hydrator.hydrate(hits, corpusRevisionId, libraryId, versionKey);

    expect(candidates.length).toBe(1);
    expect(candidates[0]!.chunk.chunkId).toBe(validChunkId);
    expect(candidates[0]!.document?.canonicalUrl).toBe('https://example.com/foundry');
    expect(candidates[0]!.lastCheckedAt).toBe('2026-09-13T10:30:00.000Z');
    expect(candidates[0]!.rank).toBe(1);
  });

  it('throws IndexInconsistentError when hit chunkId is not in revision manifest', async () => {
    const hits: SearchHit[] = [
      {
        indexEntryId: 'k-unknown',
        chunkId: 'chunk-not-in-manifest',
        documentId,
        generationId: 'gen-1',
        libraryId,
        versionKey,
        rank: 1,
      },
    ];

    await expect(hydrator.hydrate(hits, corpusRevisionId, libraryId, versionKey)).rejects.toThrow(
      IndexInconsistentError,
    );
  });

  it('throws IndexInconsistentError on scope mismatch (libraryId or versionKey)', async () => {
    const hits: SearchHit[] = [
      {
        indexEntryId: 'k-foreign',
        chunkId: validChunkId,
        documentId,
        generationId: 'gen-1',
        libraryId: 'other-library',
        versionKey,
        rank: 1,
      },
    ];

    await expect(hydrator.hydrate(hits, corpusRevisionId, libraryId, versionKey)).rejects.toThrow(
      IndexInconsistentError,
    );
  });

  it('throws CorpusCorruptError when chunk file is missing in CorpusStore', async () => {
    mockCorpusStore.getChunk = async () => null;

    const hits: SearchHit[] = [
      {
        indexEntryId: 'k1',
        chunkId: validChunkId,
        documentId,
        generationId: 'gen-1',
        libraryId,
        versionKey,
        rank: 1,
      },
    ];

    await expect(hydrator.hydrate(hits, corpusRevisionId, libraryId, versionKey)).rejects.toThrow(
      CorpusCorruptError,
    );
  });

  it('throws CorpusCorruptError when sha256Hex(chunk.content) does not match chunk.contentHash', async () => {
    mockCorpusStore.getChunk = async () => ({
      ...mockChunk,
      content: 'Tampered content that does not match hash!',
    });

    const hits: SearchHit[] = [
      {
        indexEntryId: 'k1',
        chunkId: validChunkId,
        documentId,
        generationId: 'gen-1',
        libraryId,
        versionKey,
        rank: 1,
      },
    ];

    await expect(hydrator.hydrate(hits, corpusRevisionId, libraryId, versionKey)).rejects.toThrow(
      CorpusCorruptError,
    );
  });

  it('throws CorpusCorruptError when computeChunkId does not match chunk.chunkId', async () => {
    mockCorpusStore.getChunk = async () => ({
      ...mockChunk,
      chunkIndex: 99, // Tampered index
    });

    const hits: SearchHit[] = [
      {
        indexEntryId: 'k1',
        chunkId: validChunkId,
        documentId,
        generationId: 'gen-1',
        libraryId,
        versionKey,
        rank: 1,
      },
    ];

    await expect(hydrator.hydrate(hits, corpusRevisionId, libraryId, versionKey)).rejects.toThrow(
      CorpusCorruptError,
    );
  });

  it('throws IndexInconsistentError when hit.contentHash differs from chunk.contentHash', async () => {
    const hits: SearchHit[] = [
      {
        indexEntryId: 'k1',
        chunkId: validChunkId,
        documentId,
        generationId: 'gen-1',
        libraryId,
        versionKey,
        rank: 1,
        contentHash: 'stale-search-hit-content-hash',
      },
    ];

    await expect(hydrator.hydrate(hits, corpusRevisionId, libraryId, versionKey)).rejects.toThrow(
      IndexInconsistentError,
    );
  });
});
