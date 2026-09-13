import { describe, it, expect, beforeEach } from 'vitest';
import { InMemorySearchAdapter } from '../../src/infrastructure/search/InMemorySearchAdapter.js';
import type { SearchBackend } from '../../src/application/ports/SearchBackend.js';
import type { IndexBackend, IndexEntryPayload } from '../../src/application/ports/IndexBackend.js';

describe('SearchBackend and IndexBackend Contract (Gate T-09)', () => {
  let backend: SearchBackend & IndexBackend;
  const generationId = 'gen-contract-01';
  const libraryId = 'contract-lib';
  const versionKey = 'v1';

  beforeEach(() => {
    backend = new InMemorySearchAdapter('contract-backend-key');
  });

  it('verifies backend key and health contract', async () => {
    expect(backend.getBackendKey()).toBe('contract-backend-key');
    const health = await backend.health!();
    expect(health.status).toBe('ok');
    expect(health.message).toBeDefined();
  });

  it('verifies complete lifecycle: stage -> import -> verify -> search -> publish -> retire -> delete', async () => {
    // 1. Stage
    await backend.stageGeneration(generationId);

    // 2. Import Batch
    const entries: IndexEntryPayload[] = [
      {
        indexEntryId: 'k-c1',
        generationId,
        chunkId: 'chunk-contract-1',
        documentId: 'doc-contract-1',
        snapshotId: 'snap-contract-1',
        libraryId,
        versionKey,
        title: 'Contract Guide',
        headingPath: ['Section A'],
        content: 'This text verifies backend port compliance.',
        url: 'https://example.com/contract',
        contentHash: 'hash-c1',
        hasCode: false,
        language: 'ts',
        docType: 'guide',
      },
    ];

    const importResult = await backend.importBatch(generationId, entries);
    expect(importResult.importedCount).toBe(1);
    expect(importResult.failedIds).toEqual([]);

    // 3. Verify Readiness
    const readiness = await backend.verifyReadiness(generationId, 1, [
      { query: 'Contract Guide', expectedChunkIds: ['chunk-contract-1'] },
    ]);
    expect(readiness.state).toBe('ready');
    expect(readiness.indexedCount).toBe(1);
    expect(readiness.failedProbeQueries).toEqual([]);

    // 4. Search
    const hits = await backend.search({
      libraryId,
      versionKey,
      generationId,
      query: 'backend port compliance',
      limit: 10,
    });

    expect(hits.length).toBe(1);
    const hit = hits[0]!;
    expect(hit.indexEntryId).toBe('k-c1');
    expect(hit.chunkId).toBe('chunk-contract-1');
    expect(hit.documentId).toBe('doc-contract-1');
    expect(hit.generationId).toBe(generationId);
    expect(hit.libraryId).toBe(libraryId);
    expect(hit.versionKey).toBe(versionKey);
    expect(hit.rank).toBe(1);
    expect(hit.score).toBeGreaterThan(0);
    expect(hit.contentHash).toBe('hash-c1');
    expect(hit.snippet).toContain('backend port compliance');
    expect(hit.metadata?.title).toBe('Contract Guide');
    expect(hit.metadata?.canonicalUrl).toBe('https://example.com/contract');
    expect(hit.metadata?.language).toBe('ts');
    expect(hit.metadata?.docType).toBe('guide');

    // 5. Publish
    await backend.publishGeneration(generationId);

    // 6. Retire
    await backend.retireGeneration(generationId);

    // 7. Delete
    await backend.deleteGeneration(generationId);

    // After deletion, search must return empty
    const hitsAfterDelete = await backend.search({
      libraryId,
      versionKey,
      generationId,
      query: 'backend port compliance',
    });
    expect(hitsAfterDelete).toEqual([]);
  });
});
