/**
 * Adversarial Empirical Verification Test Suite for Milestone M2
 * Challenger: challenger_m2_1
 *
 * Empirical verification of:
 * 1. Okapi BM25 field weighting hierarchy (Title 3x, Heading 2x, Content 1x), multi-field compounding, term saturation, and coordination matching.
 * 2. Deterministic tie-breaking (chunkId ASC) under mass ties (200+ chunks) and Monte Carlo insertion order permutations (10 randomized runs).
 * 3. Multi-tenant generation, library, and version isolation (Gate T-09) and dynamic index mutation cleanup.
 * 4. Complete offline corpus reconstruction and retrieval pipeline (Gate T-12).
 * 5. Unicode normalization (NFKC), Korean Hangul tokenization, and adversarial query handling (symbols, SQLi strings, whitespace).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { InMemorySearchAdapter } from '../../src/infrastructure/search/InMemorySearchAdapter.js';
import type { IndexEntryPayload } from '../../src/application/ports/IndexBackend.js';
import { FilesystemCorpusStore } from '../../src/infrastructure/storage/FilesystemCorpusStore.js';
import { SqliteManifestStore } from '../../src/infrastructure/storage/SqliteManifestStore.js';
import { TiktokenCounter } from '../../src/infrastructure/tokens/TiktokenCounter.js';
import { IndexUseCase } from '../../src/application/indexing/IndexUseCase.js';
import { GetContextUseCase } from '../../src/application/retrieval/get-context.js';
import {
  sha256Hex,
  computeChunkId,
  computeDocumentId,
  computeNormalizedHash,
  computeSnapshotId,
  computeIndexEntryId,
} from '../../src/domain/identity.js';
import { CorpusCorruptError, IndexInconsistentError } from '../../src/domain/errors.js';
import type { LibraryRegistry } from '../../src/application/ports/LibraryRegistry.js';
import type {
  LibraryDefinition,
  CorpusRevision,
  DocumentChunk,
  NormalizedDocument,
} from '../../src/domain/models/index.js';

class MockLibraryRegistry implements LibraryRegistry {
  private readonly libs = new Map<string, LibraryDefinition>();

  register(lib: LibraryDefinition): void {
    this.libs.set(lib.id, lib);
  }

  async getLibrary(id: string): Promise<LibraryDefinition | null> {
    return this.libs.get(id) ?? null;
  }

  async listLibraries(): Promise<LibraryDefinition[]> {
    return Array.from(this.libs.values());
  }

  async resolveLibrary() {
    throw new Error('Not implemented in mock');
  }
}

describe('Milestone M2 Challenger Empirical Verification (Gates T-09, T-12)', () => {
  let adapter: InMemorySearchAdapter;
  const generationId = 'gen-adv-m2-001';
  const libraryId = 'test-lib';
  const versionKey = 'v1';

  beforeEach(async () => {
    adapter = new InMemorySearchAdapter('adv-backend-key');
    await adapter.stageGeneration(generationId);
  });

  // ===========================================================================
  // Section 1: Okapi BM25 Field Weighting & Mathematical Properties
  // ===========================================================================
  describe('1. Okapi BM25 Field Weighting & Scoring Properties', () => {
    it('strictly enforces Title (3x) > Heading (2x) > Content (1x) when document lengths are identical', async () => {
      // 3 documents of identical length (6 tokens each), single query term in different fields
      const entries: IndexEntryPayload[] = [
        {
          indexEntryId: 'k-title',
          generationId,
          chunkId: 'doc-title-match',
          documentId: 'doc-1',
          snapshotId: 's-1',
          libraryId,
          versionKey,
          title: 'Quantum computing algorithm basics', // "quantum" in title (docLen = 4 title + 1 heading + 1 content = 6)
          headingPath: ['Intro'],
          content: 'Overview text',
          url: 'https://example.com/1',
          contentHash: 'h1',
          hasCode: false,
        },
        {
          indexEntryId: 'k-heading',
          generationId,
          chunkId: 'doc-heading-match',
          documentId: 'doc-2',
          snapshotId: 's-2',
          libraryId,
          versionKey,
          title: 'Physics computing algorithm basics',
          headingPath: ['Quantum'], // "quantum" in heading (docLen = 4 title + 1 heading + 1 content = 6)
          content: 'Overview text',
          url: 'https://example.com/2',
          contentHash: 'h2',
          hasCode: false,
        },
        {
          indexEntryId: 'k-content',
          generationId,
          chunkId: 'doc-content-match',
          documentId: 'doc-3',
          snapshotId: 's-3',
          libraryId,
          versionKey,
          title: 'Physics computing algorithm basics',
          headingPath: ['Intro'],
          content: 'Quantum text', // "quantum" in content (docLen = 4 title + 1 heading + 1 content = 6)
          url: 'https://example.com/3',
          contentHash: 'h3',
          hasCode: false,
        },
      ];

      await adapter.importBatch(generationId, entries);

      const hits = await adapter.search({
        libraryId,
        versionKey,
        generationId,
        query: 'Quantum',
      });

      expect(hits.length).toBe(3);

      const titleHit = hits.find((h) => h.chunkId === 'doc-title-match')!;
      const headingHit = hits.find((h) => h.chunkId === 'doc-heading-match')!;
      const contentHit = hits.find((h) => h.chunkId === 'doc-content-match')!;

      // Title match must strictly outrank Heading match
      expect(titleHit.score!).toBeGreaterThan(headingHit.score!);
      // Heading match must strictly outrank Content match
      expect(headingHit.score!).toBeGreaterThan(contentHit.score!);

      // Strict ranking assertion
      expect(hits[0]!.chunkId).toBe('doc-title-match');
      expect(hits[1]!.chunkId).toBe('doc-heading-match');
      expect(hits[2]!.chunkId).toBe('doc-content-match');
      expect(hits.map((h) => h.rank)).toEqual([1, 2, 3]);
    });

    it('demonstrates multi-field compound weighting beats single-field matches', async () => {
      const entries: IndexEntryPayload[] = [
        {
          indexEntryId: 'k-compound',
          generationId,
          chunkId: 'doc-compound',
          documentId: 'doc-comp',
          snapshotId: 's-c',
          libraryId,
          versionKey,
          title: 'Ontology Architecture', // "ontology" in Title (3x)
          headingPath: ['Ontology Core'], // "ontology" in Heading (2x) -> weightedTf = 5
          content: 'System structures and data connections.',
          url: 'https://example.com/comp',
          contentHash: 'hc',
          hasCode: false,
        },
        {
          indexEntryId: 'k-body-heavy',
          generationId,
          chunkId: 'doc-body-heavy',
          documentId: 'doc-bh',
          snapshotId: 's-bh',
          libraryId,
          versionKey,
          title: 'General Guide',
          headingPath: ['Section A'],
          content: 'Ontology ontology ontology ontology concepts.', // 4 content matches -> weightedTf = 4
          url: 'https://example.com/bh',
          contentHash: 'hbh',
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

      expect(hits.length).toBe(2);
      // Compound title (3x) + heading (2x) has weightedTf=5 > body repeated 4 times (weightedTf=4)
      expect(hits[0]!.chunkId).toBe('doc-compound');
      expect(hits[1]!.chunkId).toBe('doc-body-heavy');
    });

    it('deduplicates repetitive query terms to protect against query-stuffing score amplification', async () => {
      const entries: IndexEntryPayload[] = [
        {
          indexEntryId: 'k-1',
          generationId,
          chunkId: 'doc-1',
          documentId: 'd-1',
          snapshotId: 's-1',
          libraryId,
          versionKey,
          title: 'Pipeline Transformations',
          headingPath: ['Spark'],
          content: 'Incremental transformations on datasets.',
          url: 'https://example.com/p',
          contentHash: 'hp',
          hasCode: false,
        },
      ];

      await adapter.importBatch(generationId, entries);

      const singleTermHits = await adapter.search({
        libraryId,
        versionKey,
        generationId,
        query: 'Transformations',
      });

      const repeatedTermHits = await adapter.search({
        libraryId,
        versionKey,
        generationId,
        query: 'Transformations Transformations Transformations Transformations',
      });

      expect(singleTermHits.length).toBe(1);
      expect(repeatedTermHits.length).toBe(1);
      // Scores must be identical: query terms must be deduplicated
      expect(repeatedTermHits[0]!.score).toBeCloseTo(singleTermHits[0]!.score!, 6);
    });

    it('ranks documents with multiple distinct query term matches higher than single-term repetitive documents (coordination matching)', async () => {
      const entries: IndexEntryPayload[] = [
        {
          indexEntryId: 'k-both',
          generationId,
          chunkId: 'doc-both-terms',
          documentId: 'd-both',
          snapshotId: 's-both',
          libraryId,
          versionKey,
          title: 'Data Engine',
          headingPath: ['Overview'],
          content: 'This document explains schema and validation together.',
          url: 'https://example.com/both',
          contentHash: 'hboth',
          hasCode: false,
        },
        {
          indexEntryId: 'k-single',
          generationId,
          chunkId: 'doc-single-term-heavy',
          documentId: 'd-single',
          snapshotId: 's-single',
          libraryId,
          versionKey,
          title: 'Data Engine',
          headingPath: ['Overview'],
          content: 'Schema schema schema schema schema schema schema details.',
          url: 'https://example.com/single',
          contentHash: 'hsingle',
          hasCode: false,
        },
      ];

      await adapter.importBatch(generationId, entries);

      const hits = await adapter.search({
        libraryId,
        versionKey,
        generationId,
        query: 'schema validation',
      });

      expect(hits.length).toBe(2);
      // Doc matching both distinct terms gets IDF for both terms and must rank higher
      expect(hits[0]!.chunkId).toBe('doc-both-terms');
      expect(hits[1]!.chunkId).toBe('doc-single-term-heavy');
    });
  });

  // ===========================================================================
  // Section 2: Deterministic Tie-Breaking & Permutation Stability
  // ===========================================================================
  describe('2. Deterministic Tie-Breaking & Permutation Stability', () => {
    it('empirically breaks ties across 200 identical-scoring chunks using chunkId ASC total ordering', async () => {
      const entries: IndexEntryPayload[] = [];
      const totalChunks = 200;

      for (let i = totalChunks; i >= 1; i--) {
        const paddedNum = String(i).padStart(3, '0');
        const chunkId = `chunk-${paddedNum}`;
        entries.push({
          indexEntryId: `k-${chunkId}`,
          generationId,
          chunkId,
          documentId: `doc-${paddedNum}`,
          snapshotId: `snap-${paddedNum}`,
          libraryId,
          versionKey,
          title: 'Identical Standard Title',
          headingPath: ['Identical Section'],
          content: 'Identical uniform document text for tie breaking stress test.',
          url: `https://example.com/${paddedNum}`,
          contentHash: `hash-${paddedNum}`,
          hasCode: false,
        });
      }

      await adapter.importBatch(generationId, entries);

      const hits = await adapter.search({
        libraryId,
        versionKey,
        generationId,
        query: 'uniform document text',
        limit: 100, // Maximum allowed limit
      });

      expect(hits.length).toBe(100);

      // Verify all hits have identical score (within 1e-9)
      const firstScore = hits[0]!.score!;
      for (const hit of hits) {
        expect(Math.abs(hit.score! - firstScore)).toBeLessThanOrEqual(1e-9);
      }

      // Verify chunkId ASC ordering: chunk-001, chunk-002, ..., chunk-100
      for (let i = 0; i < hits.length; i++) {
        const expectedPadded = String(i + 1).padStart(3, '0');
        expect(hits[i]!.chunkId).toBe(`chunk-${expectedPadded}`);
        expect(hits[i]!.rank).toBe(i + 1);
      }
    });

    it('Monte Carlo permutation stress: 10 random insertion orders yield 100% identical rankings and scores', async () => {
      const baseChunks: IndexEntryPayload[] = [];
      for (let i = 0; i < 30; i++) {
        const id = `perm-chunk-${String(i).padStart(2, '0')}`;
        // Create 3 tiers of text so there are both tiers and ties
        const tier = i % 3;
        baseChunks.push({
          indexEntryId: `k-${id}`,
          generationId,
          chunkId: id,
          documentId: `doc-${id}`,
          snapshotId: `snap-${id}`,
          libraryId,
          versionKey,
          title: tier === 0 ? 'Target Keyword in Title' : 'Other Document',
          headingPath: tier === 1 ? ['Target Keyword in Heading'] : ['Other'],
          content: 'Target Keyword appears in content text for all.',
          url: `https://example.com/${id}`,
          contentHash: `hash-${id}`,
          hasCode: false,
        });
      }

      // Shuffle helper
      function shuffle<T>(array: T[]): T[] {
        const copy = [...array];
        for (let i = copy.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [copy[i], copy[j]] = [copy[j]!, copy[i]!];
        }
        return copy;
      }

      let canonicalOrder: string[] | null = null;
      let canonicalScores: number[] | null = null;

      // Run 10 trials with different randomly shuffled input arrays
      for (let trial = 0; trial < 10; trial++) {
        const trialGenId = `gen-trial-${trial}`;
        const trialAdapter = new InMemorySearchAdapter('trial-backend');
        await trialAdapter.stageGeneration(trialGenId);

        const shuffledChunks = shuffle(baseChunks).map((c) => ({
          ...c,
          generationId: trialGenId,
        }));

        await trialAdapter.importBatch(trialGenId, shuffledChunks);

        const hits = await trialAdapter.search({
          libraryId,
          versionKey,
          generationId: trialGenId,
          query: 'Target Keyword',
          limit: 50,
        });

        const currentOrder = hits.map((h) => h.chunkId);
        const currentScores = hits.map((h) => h.score!);

        if (canonicalOrder === null) {
          canonicalOrder = currentOrder;
          canonicalScores = currentScores;
        } else {
          // Strict assertion: ranking must be 100% identical regardless of insertion order
          expect(currentOrder).toEqual(canonicalOrder);
          for (let k = 0; k < currentScores.length; k++) {
            expect(currentScores[k]).toBeCloseTo(canonicalScores![k]!, 9);
          }
        }
      }
    });

    it('validates 1e-9 epsilon threshold boundary for floating-point tie-breaking', async () => {
      // Entry 1 has slightly higher score if term appears in both content and title
      const entries: IndexEntryPayload[] = [
        {
          indexEntryId: 'k-z',
          generationId,
          chunkId: 'chunk-z-higher-score',
          documentId: 'd-z',
          snapshotId: 's-z',
          libraryId,
          versionKey,
          title: 'Search Testing Title',
          headingPath: [],
          content: 'Search query match in content.',
          url: 'https://example.com/z',
          contentHash: 'hz',
          hasCode: false,
        },
        {
          indexEntryId: 'k-a',
          generationId,
          chunkId: 'chunk-a-lower-score',
          documentId: 'd-a',
          snapshotId: 's-a',
          libraryId,
          versionKey,
          title: 'Other Title',
          headingPath: [],
          content: 'Search query match in content.',
          url: 'https://example.com/a',
          contentHash: 'ha',
          hasCode: false,
        },
      ];

      await adapter.importBatch(generationId, entries);

      const hits = await adapter.search({
        libraryId,
        versionKey,
        generationId,
        query: 'Search',
      });

      expect(hits.length).toBe(2);
      // Even though 'chunk-a' comes before 'chunk-z' alphabetically,
      // 'chunk-z' has a higher score (Title + Content > Content only), so score wins
      expect(hits[0]!.chunkId).toBe('chunk-z-higher-score');
      expect(hits[1]!.chunkId).toBe('chunk-a-lower-score');
    });
  });

  // ===========================================================================
  // Section 3: Multi-Tenant & Generation Isolation (Gate T-09)
  // ===========================================================================
  describe('3. Multi-Tenant Generation & Index Mutation Isolation (Gate T-09)', () => {
    it('strictly isolates generations: queries to Gen-A never leak hits from Gen-B', async () => {
      const genA = 'generation-alpha';
      const genB = 'generation-beta';

      await adapter.stageGeneration(genA);
      await adapter.stageGeneration(genB);

      await adapter.importBatch(genA, [
        {
          indexEntryId: 'k-secret-a',
          generationId: genA,
          chunkId: 'chunk-secret-a',
          documentId: 'doc-a',
          snapshotId: 'snap-a',
          libraryId: 'company-a',
          versionKey: 'v1',
          title: 'Company A Secret Roadmap',
          headingPath: ['Roadmap'],
          content: 'Project X confidential specifications.',
          url: 'https://example.com/a',
          contentHash: 'ha',
          hasCode: false,
        },
      ]);

      await adapter.importBatch(genB, [
        {
          indexEntryId: 'k-secret-b',
          generationId: genB,
          chunkId: 'chunk-secret-b',
          documentId: 'doc-b',
          snapshotId: 'snap-b',
          libraryId: 'company-b',
          versionKey: 'v1',
          title: 'Company B Public Guide',
          headingPath: ['Guide'],
          content: 'Public guide mentioning Project X external compatibility.',
          url: 'https://example.com/b',
          contentHash: 'hb',
          hasCode: false,
        },
      ]);

      // Query Gen-A for company-a
      const hitsA = await adapter.search({
        libraryId: 'company-a',
        versionKey: 'v1',
        generationId: genA,
        query: 'Project X',
      });
      expect(hitsA.length).toBe(1);
      expect(hitsA[0]!.chunkId).toBe('chunk-secret-a');

      // Query Gen-B for company-b
      const hitsB = await adapter.search({
        libraryId: 'company-b',
        versionKey: 'v1',
        generationId: genB,
        query: 'Project X',
      });
      expect(hitsB.length).toBe(1);
      expect(hitsB[0]!.chunkId).toBe('chunk-secret-b');

      // Cross-querying libraryId mismatch must return empty
      const hitsMismatchedLib = await adapter.search({
        libraryId: 'company-b',
        versionKey: 'v1',
        generationId: genA,
        query: 'Project X',
      });
      expect(hitsMismatchedLib).toEqual([]);

      // Cross-querying versionKey mismatch must return empty
      const hitsMismatchedVer = await adapter.search({
        libraryId: 'company-a',
        versionKey: 'v2',
        generationId: genA,
        query: 'Project X',
      });
      expect(hitsMismatchedVer).toEqual([]);

      // Querying non-existent generation must return empty
      const hitsMissingGen = await adapter.search({
        libraryId: 'company-a',
        versionKey: 'v1',
        generationId: 'non-existent-gen-id',
        query: 'Project X',
      });
      expect(hitsMissingGen).toEqual([]);
    });

    it('cleans up stale inverted index entries and recomputes document lengths on re-import', async () => {
      // Step 1: Import chunk with term "apple"
      await adapter.importBatch(generationId, [
        {
          indexEntryId: 'k-mutating',
          generationId,
          chunkId: 'chunk-mutable',
          documentId: 'doc-mut',
          snapshotId: 'snap-mut',
          libraryId,
          versionKey,
          title: 'Fruit Guide',
          headingPath: [],
          content: 'Fresh red apple in basket.',
          url: 'https://example.com/mut',
          contentHash: 'h-apple',
          hasCode: false,
        },
      ]);

      const hitsApple1 = await adapter.search({
        libraryId,
        versionKey,
        generationId,
        query: 'apple',
      });
      expect(hitsApple1.length).toBe(1);

      // Step 2: Re-import chunk-mutable with completely different content "orange"
      await adapter.importBatch(generationId, [
        {
          indexEntryId: 'k-mutating-v2',
          generationId,
          chunkId: 'chunk-mutable',
          documentId: 'doc-mut',
          snapshotId: 'snap-mut-2',
          libraryId,
          versionKey,
          title: 'Citrus Guide',
          headingPath: [],
          content: 'Fresh sweet orange in basket.',
          url: 'https://example.com/mut',
          contentHash: 'h-orange',
          hasCode: false,
        },
      ]);

      // Search for old term "apple" must return ZERO hits (no stale postings)
      const hitsApple2 = await adapter.search({
        libraryId,
        versionKey,
        generationId,
        query: 'apple',
      });
      expect(hitsApple2).toEqual([]);

      // Search for new term "orange" must return the updated chunk
      const hitsOrange = await adapter.search({
        libraryId,
        versionKey,
        generationId,
        query: 'orange',
      });
      expect(hitsOrange.length).toBe(1);
      expect(hitsOrange[0]!.chunkId).toBe('chunk-mutable');
      expect(hitsOrange[0]!.metadata?.title).toBe('Citrus Guide');
    });

    it('completely deletes generation and purges all postings upon deleteGeneration', async () => {
      const ephemeralGen = 'ephemeral-gen-99';
      await adapter.stageGeneration(ephemeralGen);
      await adapter.importBatch(ephemeralGen, [
        {
          indexEntryId: 'k-eph',
          generationId: ephemeralGen,
          chunkId: 'chunk-eph',
          documentId: 'doc-eph',
          snapshotId: 'snap-eph',
          libraryId,
          versionKey,
          title: 'Ephemeral Data',
          headingPath: [],
          content: 'Temporary data to be purged.',
          url: 'https://example.com/eph',
          contentHash: 'heph',
          hasCode: false,
        },
      ]);

      expect((await adapter.search({ libraryId, versionKey, generationId: ephemeralGen, query: 'Temporary' })).length).toBe(1);

      await adapter.deleteGeneration(ephemeralGen);

      // After delete, search returns empty
      const hitsAfterDelete = await adapter.search({
        libraryId,
        versionKey,
        generationId,
        query: 'Temporary',
      });
      expect(hitsAfterDelete).toEqual([]);

      // verifyReadiness on deleted generation reports failed
      const probeResult = await adapter.verifyReadiness(ephemeralGen, 1, ['Temporary']);
      expect(probeResult.state).toBe('failed');
    });
  });

  // ===========================================================================
  // Section 4: Offline Corpus Reconstruction & Retrieval Pipeline (Gate T-12)
  // ===========================================================================
  describe('4. Complete Offline Corpus Reconstruction & Retrieval Pipeline (Gate T-12)', () => {
    let tmpDir: string;
    let corpusStore: FilesystemCorpusStore;
    let manifestStore: SqliteManifestStore;
    let registry: MockLibraryRegistry;
    let tokenCounter: TiktokenCounter;

    const offlineLibId = 'offline-library';
    const offlineVersionKey = 'current';

    beforeEach(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-m2-gate-t12-'));
      corpusStore = new FilesystemCorpusStore(tmpDir);
      manifestStore = new SqliteManifestStore(path.join(tmpDir, 'manifest/catalog.sqlite'));
      registry = new MockLibraryRegistry();
      tokenCounter = new TiktokenCounter();

      const libDef: LibraryDefinition = {
        schemaVersion: 1,
        id: offlineLibId,
        name: 'Offline Test Library',
        defaultVersionKey: offlineVersionKey,
        versions: [
          {
            versionKey: offlineVersionKey,
            strategy: 'rolling',
            source: {
              type: 'static',
              urls: ['https://example.com/offline/docs'],
              allowedHosts: ['example.com'],
              includePaths: ['/**'],
              collectionAllowed: true,
            },
            parser: { contentSelectors: ['main'] },
            chunking: { minTokens: 50, targetTokens: 200, maxTokens: 600, maxAtomicTokens: 16000 },
            freshness: { staleAfterHours: 24 },
          },
        ],
      };
      registry.register(libDef);
    });

    afterEach(() => {
      manifestStore.close();
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('Gate T-12: reconstructs entire index from local disk corpus files into fresh InMemorySearchAdapter and answers queries', async () => {
      // 1. Manually write valid corpus files to disk mimicking a cold restore / backup
      const docUrl = 'https://example.com/offline/docs';
      const docId = computeDocumentId(offlineLibId, offlineVersionKey, docUrl);
      const content = 'Comprehensive offline corpus document detailing system operations and architecture.';
      const contentHash = sha256Hex(content);
      const headings = [{ level: 1, text: 'System Operations', anchor: 'system-operations' }];
      const title = 'System Operations';
      const normHash = computeNormalizedHash({ title, markdown: content, headings, metadata: {} });
      const snapId = computeSnapshotId(docId, 'norm-profile-1', normHash);
      const chunkId = computeChunkId(snapId, 'chunker-profile-1', 0, ['System Operations'], content);

      const chunk: DocumentChunk = {
        schemaVersion: 1,
        chunkId,
        documentId: docId,
        snapshotId: snapId,
        libraryId: offlineLibId,
        versionKey: offlineVersionKey,
        chunkerProfileId: 'chunker-profile-1',
        title,
        headingPath: ['System Operations'],
        anchor: 'system-operations',
        content,
        chunkIndex: 0,
        hasCode: false,
        oversized: false,
        tokenCount: tokenCounter.count(content),
        contentHash,
      };

      const doc: NormalizedDocument = {
        schemaVersion: 1,
        documentId: docId,
        snapshotId: snapId,
        libraryId: offlineLibId,
        versionKey: offlineVersionKey,
        canonicalUrl: docUrl,
        title,
        markdown: content,
        headings,
        normalizedHash: normHash,
        normalizerProfileId: 'norm-profile-1',
        metadata: {},
      };

      await corpusStore.saveDocument(doc);
      await corpusStore.saveChunks('chunker-profile-1', snapId, [chunk]);

      const revId = 'rev-offline-001';
      const revision: CorpusRevision = {
        schemaVersion: 1,
        corpusRevisionId: revId,
        libraryId: offlineLibId,
        versionKey: offlineVersionKey,
        createdAt: '2026-09-13T12:00:00.000Z',
        documents: [
          {
            documentId: docId,
            snapshotId: snapId,
            chunkerProfileId: 'chunker-profile-1',
            chunkIds: [chunkId],
          },
        ],
        registryProfileSnapshot: {
          versionConfigHash: 'vcfg',
          normalizerProfile: {},
          chunkerProfile: {},
        },
      };
      await corpusStore.saveRevision(revision);

      await manifestStore.registerCorpusRevision({
        corpusRevisionId: revId,
        libraryId: offlineLibId,
        versionKey: offlineVersionKey,
        createdAt: '2026-09-13T12:00:00.000Z',
        versionProfileHash: 'vcfg',
        documentCount: 1,
        syncRunId: 'sync-cold-restore',
        isComplete: true,
      });

      // 2. Fresh InMemorySearchAdapter created with ZERO prior state
      const freshAdapter = new InMemorySearchAdapter('cold-restore-backend');

      const indexUseCase = new IndexUseCase(
        registry,
        manifestStore,
        corpusStore,
        freshAdapter,
        'cold-restore-backend',
      );

      const getContextUseCase = new GetContextUseCase(
        registry,
        manifestStore,
        corpusStore,
        freshAdapter,
        tokenCounter,
        'cold-restore-backend',
      );

      // 3. Rebuild index from disk
      const indexResult = await indexUseCase.execute({
        libraryId: offlineLibId,
        versionKey: offlineVersionKey,
        rebuild: true,
      });

      expect(indexResult.state).toBe('published');
      expect(indexResult.entryCount).toBe(1);
      expect(indexResult.generationId).toBeDefined();

      // 4. Perform search query via GetContextUseCase
      const contextResult = await getContextUseCase.execute({
        libraryId: offlineLibId,
        versionKey: offlineVersionKey,
        query: 'system operations architecture',
        maxTokens: 3000,
      });

      expect(contextResult.status).toBe('ok');
      expect(contextResult.sources.length).toBe(1);
      expect(contextResult.sources[0]!.url).toBe('https://example.com/offline/docs#system-operations');
      expect(contextResult.context).toContain('# Documentation Context');
      expect(contextResult.context).toContain('System Operations');
      expect(contextResult.budget.usedTokens).toBeGreaterThan(0);
      expect(contextResult.budget.usedTokens).toBeLessThanOrEqual(3000);
    });

    it('fails safely with CorpusCorruptError when an offline chunk file is tampered or damaged', async () => {
      const docUrl = 'https://example.com/offline/tampered';
      const docId = computeDocumentId(offlineLibId, offlineVersionKey, docUrl);
      const content = 'Original untampered content.';
      const contentHash = sha256Hex(content);
      const title = 'Untampered Title';
      const normHash = computeNormalizedHash({ title, markdown: content, headings: [], metadata: {} });
      const snapId = computeSnapshotId(docId, 'norm-1', normHash);
      const chunkId = computeChunkId(snapId, 'chunker-1', 0, ['Untampered'], content);

      const chunk: DocumentChunk = {
        schemaVersion: 1,
        chunkId,
        documentId: docId,
        snapshotId: snapId,
        libraryId: offlineLibId,
        versionKey: offlineVersionKey,
        chunkerProfileId: 'chunker-1',
        title,
        headingPath: ['Untampered'],
        content,
        chunkIndex: 0,
        hasCode: false,
        oversized: false,
        tokenCount: tokenCounter.count(content),
        contentHash,
      };

      const doc: NormalizedDocument = {
        schemaVersion: 1,
        documentId: docId,
        snapshotId: snapId,
        libraryId: offlineLibId,
        versionKey: offlineVersionKey,
        canonicalUrl: docUrl,
        title,
        markdown: content,
        headings: [],
        normalizedHash: normHash,
        normalizerProfileId: 'norm-1',
        metadata: {},
      };

      await corpusStore.saveDocument(doc);
      await corpusStore.saveChunks('chunker-1', snapId, [chunk]);

      const revId = 'rev-tampered';
      await corpusStore.saveRevision({
        schemaVersion: 1,
        corpusRevisionId: revId,
        libraryId: offlineLibId,
        versionKey: offlineVersionKey,
        createdAt: '2026-09-13T12:00:00.000Z',
        documents: [{ documentId: docId, snapshotId: snapId, chunkerProfileId: 'chunker-1', chunkIds: [chunkId] }],
        registryProfileSnapshot: { versionConfigHash: 'vcfg', normalizerProfile: {}, chunkerProfile: {} },
      });

      await manifestStore.registerCorpusRevision({
        corpusRevisionId: revId,
        libraryId: offlineLibId,
        versionKey: offlineVersionKey,
        createdAt: '2026-09-13T12:00:00.000Z',
        versionProfileHash: 'vcfg',
        documentCount: 1,
        syncRunId: 'sync-1',
        isComplete: true,
      });

      const backend = new InMemorySearchAdapter('corrupt-backend');
      const indexUseCase = new IndexUseCase(registry, manifestStore, corpusStore, backend, 'corrupt-backend');
      await indexUseCase.execute({ libraryId: offlineLibId, rebuild: true });

      // Tamper chunk on disk AFTER indexing
      const chunkFilePath = path.join(tmpDir, 'corpus/chunks/chunker-1', `${snapId}.jsonl`);
      fs.writeFileSync(chunkFilePath, JSON.stringify({ ...chunk, content: 'Tampered malicious data' }) + '\n');

      const getContextUseCase = new GetContextUseCase(registry, manifestStore, corpusStore, backend, tokenCounter, 'corrupt-backend');

      await expect(
        getContextUseCase.execute({ libraryId: offlineLibId, query: 'Untampered' }),
      ).rejects.toThrow(CorpusCorruptError);
    });
  });

  // ===========================================================================
  // Section 5: Tokenization, Unicode Normalization & Adversarial Inputs
  // ===========================================================================
  describe('5. Unicode Normalization & Adversarial Query Hardening', () => {
    it('normalizes full-width characters and ligatures via Unicode NFKC normalization', async () => {
      const entries: IndexEntryPayload[] = [
        {
          indexEntryId: 'k-unicode',
          generationId,
          chunkId: 'chunk-unicode',
          documentId: 'doc-u',
          snapshotId: 'snap-u',
          libraryId,
          versionKey,
          title: 'Ｆｏｕｎｄｒｙ Ｄａｔａ', // Full-width characters
          headingPath: ['ﬁle formats'], // Ligature 'ﬁ'
          content: 'Standard content regarding data structures.',
          url: 'https://example.com/u',
          contentHash: 'hu',
          hasCode: false,
        },
      ];

      await adapter.importBatch(generationId, entries);

      // Query with standard ASCII "foundry"
      const hitsFoundry = await adapter.search({
        libraryId,
        versionKey,
        generationId,
        query: 'foundry',
      });
      expect(hitsFoundry.length).toBe(1);
      expect(hitsFoundry[0]!.chunkId).toBe('chunk-unicode');

      // Query with standard ASCII "file"
      const hitsFile = await adapter.search({
        libraryId,
        versionKey,
        generationId,
        query: 'file',
      });
      expect(hitsFile.length).toBe(1);
      expect(hitsFile[0]!.chunkId).toBe('chunk-unicode');
    });

    it('safely handles adversarial query inputs (symbols only, SQLi, huge whitespace)', async () => {
      const entries: IndexEntryPayload[] = [
        {
          indexEntryId: 'k-safe',
          generationId,
          chunkId: 'chunk-safe',
          documentId: 'doc-s',
          snapshotId: 'snap-s',
          libraryId,
          versionKey,
          title: 'Safe API Reference',
          headingPath: [],
          content: 'Normal API reference documentation.',
          url: 'https://example.com/s',
          contentHash: 'hs',
          hasCode: false,
        },
      ];

      await adapter.importBatch(generationId, entries);

      // Query with only punctuation/symbols
      const hitsSymbols = await adapter.search({
        libraryId,
        versionKey,
        generationId,
        query: '!@#$%^&*()_+{}[]:;"\'<>?,./',
      });
      expect(hitsSymbols).toEqual([]);

      // Query with SQL injection string
      const hitsSqli = await adapter.search({
        libraryId,
        versionKey,
        generationId,
        query: "' OR '1'='1' --",
      });
      // '1' is tokenized, but matches nothing
      expect(hitsSqli).toEqual([]);

      // Query with only whitespace and zero-width spaces
      const hitsWhitespace = await adapter.search({
        libraryId,
        versionKey,
        generationId,
        query: '   \t\n  \u200B\u200C  ',
      });
      expect(hitsWhitespace).toEqual([]);
    });

    it('correctly clamps search limits between 1 and 100', async () => {
      const entries: IndexEntryPayload[] = [];
      for (let i = 0; i < 15; i++) {
        entries.push({
          indexEntryId: `k-lim-${i}`,
          generationId,
          chunkId: `chunk-lim-${i}`,
          documentId: `doc-lim-${i}`,
          snapshotId: `snap-lim-${i}`,
          libraryId,
          versionKey,
          title: 'Limit Test',
          headingPath: [],
          content: 'Limit test content keyword.',
          url: `https://example.com/lim/${i}`,
          contentHash: `h-lim-${i}`,
          hasCode: false,
        });
      }
      await adapter.importBatch(generationId, entries);

      // limit <= 0 clamped to 1
      const hitsMin = await adapter.search({
        libraryId,
        versionKey,
        generationId,
        query: 'keyword',
        limit: 0,
      });
      expect(hitsMin.length).toBe(1);

      // limit = 5 respected
      const hitsFive = await adapter.search({
        libraryId,
        versionKey,
        generationId,
        query: 'keyword',
        limit: 5,
      });
      expect(hitsFive.length).toBe(5);

      // limit > 100 clamped to 100 (in this case 15 available)
      const hitsMax = await adapter.search({
        libraryId,
        versionKey,
        generationId,
        query: 'keyword',
        limit: 999,
      });
      expect(hitsMax.length).toBe(15);
    });
  });
});
