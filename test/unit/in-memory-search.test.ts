import { describe, it, expect, beforeEach } from 'vitest';
import { InMemorySearchAdapter } from '../../src/infrastructure/search/InMemorySearchAdapter.js';
import type { IndexEntryPayload } from '../../src/application/ports/IndexBackend.js';

describe('InMemorySearchAdapter (Gate T-12)', () => {
  let adapter: InMemorySearchAdapter;
  const generationId = 'gen-test-01';
  const libraryId = 'palantir-foundry';
  const versionKey = 'current';

  beforeEach(async () => {
    adapter = new InMemorySearchAdapter('test-backend');
    await adapter.stageGeneration(generationId);
  });

  it('ranks higher with Title weighting (3x) over Heading (2x) and Content (1x)', async () => {
    const entries: IndexEntryPayload[] = [
      {
        indexEntryId: 'k1',
        generationId,
        chunkId: 'chunk-content',
        documentId: 'doc-1',
        snapshotId: 'snap-1',
        libraryId,
        versionKey,
        title: 'Introduction to Data',
        headingPath: ['Overview'],
        content: 'Ontology is the core building block for Palantir Foundry.',
        url: 'https://example.com/1',
        contentHash: 'hash-1',
        hasCode: false,
      },
      {
        indexEntryId: 'k2',
        generationId,
        chunkId: 'chunk-title',
        documentId: 'doc-2',
        snapshotId: 'snap-2',
        libraryId,
        versionKey,
        title: 'Ontology Building Guide',
        headingPath: ['Introduction'],
        content: 'This guide covers foundational data concepts.',
        url: 'https://example.com/2',
        contentHash: 'hash-2',
        hasCode: false,
      },
      {
        indexEntryId: 'k3',
        generationId,
        chunkId: 'chunk-heading',
        documentId: 'doc-3',
        snapshotId: 'snap-3',
        libraryId,
        versionKey,
        title: 'Architecture Overview',
        headingPath: ['Core Concepts', 'Ontology'],
        content: 'System architecture components are detailed below.',
        url: 'https://example.com/3',
        contentHash: 'hash-3',
        hasCode: false,
      },
    ];

    await adapter.importBatch(generationId, entries);

    const hits = await adapter.search({
      libraryId,
      versionKey,
      generationId,
      query: 'Ontology',
    });

    expect(hits.length).toBe(3);
    // Title match (3x) should rank #1
    expect(hits[0]!.chunkId).toBe('chunk-title');
    expect(hits[0]!.rank).toBe(1);
    // Heading match (2x) should rank #2
    expect(hits[1]!.chunkId).toBe('chunk-heading');
    expect(hits[1]!.rank).toBe(2);
    // Content match (1x) should rank #3
    expect(hits[2]!.chunkId).toBe('chunk-content');
    expect(hits[2]!.rank).toBe(3);
  });

  it('enforces deterministic tie-breaking: score DESC, chunkId ASC', async () => {
    // Two chunks with identical content and identical title, different chunkId
    const entries: IndexEntryPayload[] = [
      {
        indexEntryId: 'k-b',
        generationId,
        chunkId: 'chunk-beta',
        documentId: 'doc-b',
        snapshotId: 'snap-b',
        libraryId,
        versionKey,
        title: 'Common Guide',
        headingPath: ['Section'],
        content: 'Exact identical text for BM25 score test.',
        url: 'https://example.com/b',
        contentHash: 'hash-b',
        hasCode: false,
      },
      {
        indexEntryId: 'k-a',
        generationId,
        chunkId: 'chunk-alpha',
        documentId: 'doc-a',
        snapshotId: 'snap-a',
        libraryId,
        versionKey,
        title: 'Common Guide',
        headingPath: ['Section'],
        content: 'Exact identical text for BM25 score test.',
        url: 'https://example.com/a',
        contentHash: 'hash-a',
        hasCode: false,
      },
      {
        indexEntryId: 'k-c',
        generationId,
        chunkId: 'chunk-gamma',
        documentId: 'doc-c',
        snapshotId: 'snap-c',
        libraryId,
        versionKey,
        title: 'Common Guide',
        headingPath: ['Section'],
        content: 'Exact identical text for BM25 score test.',
        url: 'https://example.com/c',
        contentHash: 'hash-c',
        hasCode: false,
      },
    ];

    await adapter.importBatch(generationId, entries);

    const hits1 = await adapter.search({
      libraryId,
      versionKey,
      generationId,
      query: 'identical text',
    });

    const hits2 = await adapter.search({
      libraryId,
      versionKey,
      generationId,
      query: 'identical text',
    });

    expect(hits1.length).toBe(3);
    // All have identical score, tie-breaking must sort chunk-alpha, chunk-beta, chunk-gamma
    expect(hits1[0]!.chunkId).toBe('chunk-alpha');
    expect(hits1[1]!.chunkId).toBe('chunk-beta');
    expect(hits1[2]!.chunkId).toBe('chunk-gamma');

    // 100% reproducible across calls
    expect(hits1.map((h) => h.chunkId)).toEqual(hits2.map((h) => h.chunkId));
    expect(hits1.map((h) => h.rank)).toEqual([1, 2, 3]);
  });

  it('enforces multi-tenant isolation by generation and library', async () => {
    const gen1 = 'gen-1';
    const gen2 = 'gen-2';
    await adapter.stageGeneration(gen1);
    await adapter.stageGeneration(gen2);

    await adapter.importBatch(gen1, [
      {
        indexEntryId: 'k-gen1',
        generationId: gen1,
        chunkId: 'chunk-in-gen1',
        documentId: 'doc-1',
        snapshotId: 'snap-1',
        libraryId: 'palantir-foundry',
        versionKey: 'current',
        title: 'Foundry Data Types',
        headingPath: [],
        content: 'Foundry secret information.',
        url: 'https://example.com/1',
        contentHash: 'h1',
        hasCode: false,
      },
    ]);

    await adapter.importBatch(gen2, [
      {
        indexEntryId: 'k-gen2',
        generationId: gen2,
        chunkId: 'chunk-in-gen2',
        documentId: 'doc-2',
        snapshotId: 'snap-2',
        libraryId: 'palantir-foundry',
        versionKey: 'current',
        title: 'Foundry Data Types V2',
        headingPath: [],
        content: 'Foundry secret information V2.',
        url: 'https://example.com/2',
        contentHash: 'h2',
        hasCode: false,
      },
    ]);

    // Querying gen1 should never return gen2 chunks
    const hitsGen1 = await adapter.search({
      libraryId: 'palantir-foundry',
      versionKey: 'current',
      generationId: gen1,
      query: 'Foundry secret',
    });
    expect(hitsGen1.length).toBe(1);
    expect(hitsGen1[0]!.chunkId).toBe('chunk-in-gen1');

    // Querying gen2 should never return gen1 chunks
    const hitsGen2 = await adapter.search({
      libraryId: 'palantir-foundry',
      versionKey: 'current',
      generationId: gen2,
      query: 'Foundry secret',
    });
    expect(hitsGen2.length).toBe(1);
    expect(hitsGen2[0]!.chunkId).toBe('chunk-in-gen2');

    // Querying different library should return empty
    const hitsWrongLib = await adapter.search({
      libraryId: 'other-library',
      versionKey: 'current',
      generationId: gen1,
      query: 'Foundry secret',
    });
    expect(hitsWrongLib).toEqual([]);
  });

  it('correctly filters by metadata (language and docType)', async () => {
    const entries: IndexEntryPayload[] = [
      {
        indexEntryId: 'k-ts',
        generationId,
        chunkId: 'chunk-ts',
        documentId: 'doc-ts',
        snapshotId: 'snap-ts',
        libraryId,
        versionKey,
        title: 'TypeScript SDK Guide',
        headingPath: ['SDK'],
        content: 'Use npm install @foundry/sdk to install the TypeScript client.',
        url: 'https://example.com/ts',
        contentHash: 'h-ts',
        hasCode: true,
        language: 'ts',
        docType: 'api',
      },
      {
        indexEntryId: 'k-py',
        generationId,
        chunkId: 'chunk-py',
        documentId: 'doc-py',
        snapshotId: 'snap-py',
        libraryId,
        versionKey,
        title: 'Python SDK Guide',
        headingPath: ['SDK'],
        content: 'Use pip install foundry-sdk to install the Python client.',
        url: 'https://example.com/py',
        contentHash: 'h-py',
        hasCode: true,
        language: 'py',
        docType: 'api',
      },
    ];

    await adapter.importBatch(generationId, entries);

    const hitsTs = await adapter.search({
      libraryId,
      versionKey,
      generationId,
      query: 'install SDK client',
      filters: { language: 'ts' },
    });
    expect(hitsTs.length).toBe(1);
    expect(hitsTs[0]!.chunkId).toBe('chunk-ts');

    const hitsPy = await adapter.search({
      libraryId,
      versionKey,
      generationId,
      query: 'install SDK client',
      filters: { language: 'py' },
    });
    expect(hitsPy.length).toBe(1);
    expect(hitsPy[0]!.chunkId).toBe('chunk-py');
  });

  it('supports Korean Hangul queries and generates contextual snippets', async () => {
    const entries: IndexEntryPayload[] = [
      {
        indexEntryId: 'k-kr',
        generationId,
        chunkId: 'chunk-korean',
        documentId: 'doc-kr',
        snapshotId: 'snap-kr',
        libraryId,
        versionKey,
        title: '오브젝트 타입 생성 절차',
        headingPath: ['온톨로지', '개요'],
        content: 'Foundry에서 새로운 Object Type을 생성하려면 먼저 온톨로지 관리자 화면으로 이동해야 합니다.',
        url: 'https://example.com/kr',
        contentHash: 'h-kr',
        hasCode: false,
      },
    ];

    await adapter.importBatch(generationId, entries);

    const hits = await adapter.search({
      libraryId,
      versionKey,
      generationId,
      query: 'Object Type 생성',
    });

    expect(hits.length).toBe(1);
    expect(hits[0]!.chunkId).toBe('chunk-korean');
    expect(hits[0]!.snippet).toContain('Object Type');
  });

  it('verifies readiness with probe queries and returns state: ready or failed', async () => {
    const entries: IndexEntryPayload[] = [
      {
        indexEntryId: 'k-1',
        generationId,
        chunkId: 'chunk-1',
        documentId: 'doc-1',
        snapshotId: 'snap-1',
        libraryId,
        versionKey,
        title: 'Batch Transforms',
        headingPath: ['Pipeline'],
        content: 'Data transformations running on Spark cluster.',
        url: 'https://example.com/1',
        contentHash: 'h-1',
        hasCode: false,
      },
    ];
    await adapter.importBatch(generationId, entries);

    // Matching probe query
    const readinessSuccess = await adapter.verifyReadiness(generationId, 1, [
      { query: 'Batch Transforms', expectedChunkIds: ['chunk-1'] },
    ]);
    expect(readinessSuccess.state).toBe('ready');

    // Missing count
    const readinessPending = await adapter.verifyReadiness(generationId, 5, []);
    expect(readinessPending.state).toBe('pending');

    // Probe expecting non-existent chunk
    const readinessFailed = await adapter.verifyReadiness(generationId, 1, [
      { query: 'Batch Transforms', expectedChunkIds: ['non-existent-chunk'] },
    ]);
    expect(readinessFailed.state).toBe('failed');
    expect(readinessFailed.failedProbeQueries).toContain('Batch Transforms');
  });
});
