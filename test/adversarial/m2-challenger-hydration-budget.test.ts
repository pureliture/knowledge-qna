/**
 * Adversarial Empirical Verification Test Suite for Milestone M2 (Gate T-11)
 * Challenger: challenger_m2_2
 * Role: Hydration & Token Budget Adversarial Verifier
 *
 * Empirical verification of:
 * 1. Token budget edge cases (255, 256, 16000, 16001, non-integers, invalid types)
 * 2. Budget exhaustion & atomic chunk packing (top-1 failure, multi-chunk omission, anti-slicing oracle, greedy skip)
 * 3. Corruption and membership defense (hash mismatch, unregistered chunk, tampered ID, missing chunk, stale hit hash)
 * 4. Citation integrity & injection protection (anchor verification, markdown escaping, special token safety)
 * 5. Full GetContextUseCase end-to-end integration under adversarial conditions
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { ContextPacker } from '../../src/application/retrieval/ContextPacker.js';
import { ChunkHydrator } from '../../src/application/retrieval/ChunkHydrator.js';
import {
  escapeMarkdown,
  resolveOfficialUrl,
  mapCitation,
  formatHeadingLine,
  type HydratedCandidate,
} from '../../src/application/retrieval/CitationMapper.js';
import { TiktokenCounter } from '../../src/infrastructure/tokens/TiktokenCounter.js';
import { GetContextUseCase } from '../../src/application/retrieval/get-context.js';
import { InMemorySearchAdapter } from '../../src/infrastructure/search/InMemorySearchAdapter.js';
import { FilesystemCorpusStore } from '../../src/infrastructure/storage/FilesystemCorpusStore.js';
import { SqliteManifestStore } from '../../src/infrastructure/storage/SqliteManifestStore.js';
import type { LibraryRegistry } from '../../src/application/ports/LibraryRegistry.js';
import type {
  LibraryDefinition,
  CorpusRevision,
  DocumentChunk,
  NormalizedDocument,
} from '../../src/domain/models/index.js';
import {
  InvalidRequestError,
  TokenBudgetExceededError,
  IndexInconsistentError,
  CorpusCorruptError,
  ResponseTooLargeError,
} from '../../src/domain/errors.js';
import {
  sha256Hex,
  computeChunkId,
  computeIndexEntryId,
  computeDocumentId,
  computeNormalizedHash,
  computeSnapshotId,
} from '../../src/domain/identity.js';

class MockLibraryRegistry implements LibraryRegistry {
  private readonly libraries = new Map<string, LibraryDefinition>();

  register(lib: LibraryDefinition): void {
    this.libraries.set(lib.id, lib);
  }

  async getLibrary(id: string): Promise<LibraryDefinition | null> {
    return this.libraries.get(id) ?? null;
  }

  async listLibraries(): Promise<LibraryDefinition[]> {
    return Array.from(this.libraries.values());
  }

  async resolveLibrary() {
    throw new Error('Not implemented');
  }
}

describe('Challenger M2-2: Hydration & Token Budget Adversarial Suite (Gate T-11)', () => {
  const tokenCounter = new TiktokenCounter();
  const packer = new ContextPacker(tokenCounter);

  function createCandidate(
    id: string,
    content: string,
    opts: {
      title?: string;
      headingPath?: string[];
      anchor?: string;
      headings?: Array<{ level: number; text: string; anchor?: string }>;
    } = {},
  ): HydratedCandidate {
    const title = opts.title ?? `Doc ${id}`;
    const headingPath = opts.headingPath ?? [`Heading ${id}`];
    const chunkId = `chunk-${id}`;
    const documentId = `doc-${id}`;
    const snapshotId = `snap-${id}`;

    const chunk: DocumentChunk = {
      schemaVersion: 1,
      chunkId,
      documentId,
      snapshotId,
      libraryId: 'test-lib',
      versionKey: 'current',
      chunkerProfileId: 'profile-1',
      title,
      headingPath,
      anchor: opts.anchor,
      content,
      chunkIndex: 0,
      hasCode: false,
      oversized: false,
      tokenCount: tokenCounter.count(content),
      contentHash: sha256Hex(content),
    };

    const document: NormalizedDocument = {
      schemaVersion: 1,
      documentId,
      snapshotId,
      libraryId: 'test-lib',
      versionKey: 'current',
      canonicalUrl: `https://example.com/docs/${id}`,
      title,
      markdown: content,
      headings: opts.headings ?? [],
      normalizedHash: `nh-${id}`,
      normalizerProfileId: 'norm-1',
      metadata: {},
    };

    return {
      chunk,
      document,
      lastCheckedAt: '2026-09-13T12:00:00.000Z',
      rank: 1,
    };
  }

  // =========================================================================
  // Section 1: Token Budget Edge Cases & Robust Validation
  // =========================================================================
  describe('1. Token Budget Boundary & Type Edge Cases', () => {
    it('rejects maxTokens = 255 with InvalidRequestError', () => {
      expect(() => packer.validateMaxTokens(255)).toThrow(InvalidRequestError);
      try {
        packer.validateMaxTokens(255);
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidRequestError);
        expect((err as InvalidRequestError).code).toBe('INVALID_REQUEST');
      }
    });

    it('accepts boundary maxTokens = 256', () => {
      expect(packer.validateMaxTokens(256)).toBe(256);
    });

    it('accepts boundary maxTokens = 16000', () => {
      expect(packer.validateMaxTokens(16000)).toBe(16000);
    });

    it('rejects maxTokens = 16001 with InvalidRequestError', () => {
      expect(() => packer.validateMaxTokens(16001)).toThrow(InvalidRequestError);
      try {
        packer.validateMaxTokens(16001);
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidRequestError);
        expect((err as InvalidRequestError).code).toBe('INVALID_REQUEST');
      }
    });

    it('rejects zero and negative maxTokens', () => {
      expect(() => packer.validateMaxTokens(0)).toThrow(InvalidRequestError);
      expect(() => packer.validateMaxTokens(-1)).toThrow(InvalidRequestError);
      expect(() => packer.validateMaxTokens(-256)).toThrow(InvalidRequestError);
    });

    it('rejects fractional numbers (no floating-point budgets)', () => {
      expect(() => packer.validateMaxTokens(256.0001)).toThrow(InvalidRequestError);
      expect(() => packer.validateMaxTokens(1000.5)).toThrow(InvalidRequestError);
      expect(() => packer.validateMaxTokens(15999.99)).toThrow(InvalidRequestError);
    });

    it('rejects NaN, Infinity, and -Infinity', () => {
      expect(() => packer.validateMaxTokens(NaN)).toThrow(InvalidRequestError);
      expect(() => packer.validateMaxTokens(Infinity)).toThrow(InvalidRequestError);
      expect(() => packer.validateMaxTokens(-Infinity)).toThrow(InvalidRequestError);
    });

    it('defaults to exactly 6000 when maxTokens is undefined', () => {
      expect(packer.validateMaxTokens(undefined)).toBe(6000);
    });

    it('rejects string coercion attempts when passed via any/invalid typing', () => {
      // @ts-expect-error Testing runtime boundary against non-TypeScript clients
      expect(() => packer.validateMaxTokens('6000')).toThrow(InvalidRequestError);
      // @ts-expect-error Testing runtime boundary against non-TypeScript clients
      expect(() => packer.validateMaxTokens('256')).toThrow(InvalidRequestError);
      // @ts-expect-error Testing runtime boundary against null
      // Note: null ?? 6000 coalesces to 6000 due to nullish coalescing
      expect(packer.validateMaxTokens(null as any)).toBe(6000);
    });
  });

  // =========================================================================
  // Section 2: Budget Exhaustion & Atomic Packing (Anti-Slicing Oracle)
  // =========================================================================
  describe('2. Budget Exhaustion & Atomic Packing Integrity', () => {
    it('throws TokenBudgetExceededError when top-1 chunk cannot fit in maxTokens', () => {
      // Smallest valid maxTokens is 256. Preamble is ~40 tokens.
      // A chunk with 300 tokens will exceed 256 immediately.
      const candidate = createCandidate('top1', 'Exceeding content words. '.repeat(60));
      expect(() => packer.pack([candidate], 256)).toThrow(TokenBudgetExceededError);

      try {
        packer.pack([candidate], 256);
      } catch (err) {
        expect(err).toBeInstanceOf(TokenBudgetExceededError);
        expect((err as TokenBudgetExceededError).code).toBe('TOKEN_BUDGET_EXCEEDED');
      }
    });

    it('NEVER returns a truncated empty context when top-1 chunk fails budget', () => {
      const candidate = createCandidate('oversized', 'Massive content. '.repeat(200));
      let errorThrown = false;
      try {
        packer.pack([candidate], 256);
      } catch (err) {
        errorThrown = true;
        expect(err).toBeInstanceOf(TokenBudgetExceededError);
      }
      expect(errorThrown).toBe(true);
    });

    it('atomically packs chunk 1 and omits chunk 2 without slicing chunk 1 in the middle', () => {
      const chunk1Content = 'This is chunk 1 content. Complete and intact sentence here.';
      const chunk2Content = 'Chunk 2 is very long. '.repeat(80);

      const candidate1 = createCandidate('c1', chunk1Content);
      const candidate2 = createCandidate('c2', chunk2Content);

      // Set budget such that candidate 1 + preamble + headers (~70 tokens) fits in 120 tokens, but candidate 2 pushes beyond
      // Note: packer minimum budget validation requires >= 256. Let's size chunk 1 to ~150 tokens and chunk 2 to ~300 tokens with budget 256.
      const sizedChunk1Content = 'Safe chunk 1 sentence. '.repeat(20); // ~100 tokens
      const sizedChunk2Content = 'Exceeding chunk 2 sentence. '.repeat(50); // ~250 tokens

      const cand1 = createCandidate('c1', sizedChunk1Content);
      const cand2 = createCandidate('c2', sizedChunk2Content);

      const result = packer.pack([cand1, cand2], 256);

      expect(result.status).toBe('ok');
      expect(result.sources.length).toBe(1);
      expect(result.sources[0]!.id).toBe('S1');
      expect(result.sources[0]!.chunkId).toBe('chunk-c1');

      // Anti-slicing verification: chunk 1 content must be 100% identical and intact
      expect(result.context).toContain(sizedChunk1Content);
      expect(result.context).not.toContain(sizedChunk2Content);

      // Verify no partial slicing indicator like "..." appended to chunk 1
      expect(result.context).not.toContain(sizedChunk1Content + '...');

      // Verify metadata
      expect(result.truncated).toBe(true);
      expect(result.omittedChunkCount).toBe(1);
      expect(result.usedTokens).toBeLessThanOrEqual(256);
      expect(result.usedTokens).toBe(tokenCounter.count(result.context));
    });

    it('greedy skip-and-continue: skips oversized chunk 2 and includes chunk 3 if chunk 3 fits', () => {
      // Chunk 1: ~60 tokens
      const c1 = createCandidate('c1', 'Chunk 1 first priority text. '.repeat(10));
      // Chunk 2: ~300 tokens (oversized for remaining budget)
      const c2 = createCandidate('c2', 'Chunk 2 second priority massive text. '.repeat(50));
      // Chunk 3: ~30 tokens (small, can fit in remaining budget!)
      const c3 = createCandidate('c3', 'Chunk 3 third priority small text. '.repeat(5));

      // With budget 256:
      // Preamble (~40) + S1 (~80) = ~120 tokens.
      // + S2 (~320) = ~440 tokens (> 256 -> skip S2!).
      // + S3 (~50) = ~170 tokens (<= 256 -> accept S3 as S2 in output!).
      const result = packer.pack([c1, c2, c3], 256);

      expect(result.status).toBe('ok');
      expect(result.sources.length).toBe(2);
      expect(result.sources[0]!.id).toBe('S1');
      expect(result.sources[0]!.chunkId).toBe('chunk-c1');
      expect(result.sources[1]!.id).toBe('S2');
      expect(result.sources[1]!.chunkId).toBe('chunk-c3');

      expect(result.context).toContain('Chunk 1 first priority text.');
      expect(result.context).not.toContain('Chunk 2 second priority');
      expect(result.context).toContain('Chunk 3 third priority small text.');

      expect(result.truncated).toBe(true);
      expect(result.omittedChunkCount).toBe(1);
      expect(result.usedTokens).toBeLessThanOrEqual(256);
      expect(result.usedTokens).toBe(tokenCounter.count(result.context));
    });

    it('handles empty candidates list cleanly with no_matches and 0 usedTokens', () => {
      const result = packer.pack([], 6000);
      expect(result.status).toBe('no_matches');
      expect(result.context).toBe('');
      expect(result.sources).toEqual([]);
      expect(result.usedTokens).toBe(0);
      expect(result.truncated).toBe(false);
      expect(result.omittedChunkCount).toBe(0);
    });
  });

  // =========================================================================
  // Section 3: Corruption & Membership Defense
  // =========================================================================
  describe('3. Corpus Corruption & Membership Defense', () => {
    let mockCorpusStore: any;
    let mockManifestStore: any;
    let hydrator: ChunkHydrator;

    const libId = 'secure-lib';
    const verKey = 'v1';
    const revId = 'rev-sec-01';
    const snapId = 'snap-sec-01';
    const profId = 'prof-sec-01';
    const docId = 'doc-sec-01';

    const goodContent = 'Cryptographically secure documentation content.';
    const goodHash = sha256Hex(goodContent);
    const goodChunkId = computeChunkId(snapId, profId, 0, ['Security'], goodContent);

    const canonicalChunk: DocumentChunk = {
      schemaVersion: 1,
      chunkId: goodChunkId,
      documentId: docId,
      snapshotId: snapId,
      libraryId: libId,
      versionKey: verKey,
      chunkerProfileId: profId,
      title: 'Security Manual',
      headingPath: ['Security'],
      content: goodContent,
      chunkIndex: 0,
      hasCode: false,
      oversized: false,
      tokenCount: 10,
      contentHash: goodHash,
    };

    const canonicalRevision: CorpusRevision = {
      schemaVersion: 1,
      corpusRevisionId: revId,
      libraryId: libId,
      versionKey: verKey,
      createdAt: '2026-09-13T10:00:00.000Z',
      documents: [
        {
          documentId: docId,
          snapshotId: snapId,
          chunkerProfileId: profId,
          chunkIds: [goodChunkId],
        },
      ],
      registryProfileSnapshot: {
        versionConfigHash: 'vcfg',
        normalizerProfile: {},
        chunkerProfile: {},
      },
    };

    const canonicalDoc: NormalizedDocument = {
      schemaVersion: 1,
      documentId: docId,
      snapshotId: snapId,
      libraryId: libId,
      versionKey: verKey,
      canonicalUrl: 'https://example.com/sec',
      title: 'Security Manual',
      markdown: goodContent,
      headings: [{ level: 1, text: 'Security', anchor: 'security' }],
      normalizedHash: 'nh-sec',
      normalizerProfileId: 'norm-1',
      metadata: {},
    };

    beforeEach(() => {
      mockCorpusStore = {
        getRevision: async (id: string) => (id === revId ? canonicalRevision : null),
        getChunk: async () => ({ ...canonicalChunk }),
        getDocument: async () => canonicalDoc,
      };

      mockManifestStore = {
        getObservation: async () => ({
          runId: 'run-1',
          documentId: docId,
          requestedUrl: 'https://example.com/sec',
          fetchedUrl: 'https://example.com/sec',
          status: 200,
          lastCheckedAt: '2026-09-13T10:00:00.000Z',
        }),
      };

      hydrator = new ChunkHydrator(mockCorpusStore, mockManifestStore);
    });

    it('throws CorpusCorruptError with code CORPUS_CORRUPT when chunk content hash does not match', async () => {
      // Return chunk whose content does not match contentHash
      mockCorpusStore.getChunk = async () => ({
        ...canonicalChunk,
        content: 'Tampered byte in corpus storage!',
        // contentHash remains old hash
      });

      const hits = [
        {
          indexEntryId: 'hit-1',
          chunkId: goodChunkId,
          documentId: docId,
          generationId: 'gen-1',
          libraryId: libId,
          versionKey: verKey,
          rank: 1,
        },
      ];

      await expect(hydrator.hydrate(hits, revId, libId, verKey)).rejects.toThrow(CorpusCorruptError);

      try {
        await hydrator.hydrate(hits, revId, libId, verKey);
      } catch (err) {
        expect(err).toBeInstanceOf(CorpusCorruptError);
        expect((err as CorpusCorruptError).code).toBe('CORPUS_CORRUPT');
      }
    });

    it('throws IndexInconsistentError with code INDEX_INCONSISTENT when search hit chunkId is not in revision manifest', async () => {
      const hits = [
        {
          indexEntryId: 'hit-unregistered',
          chunkId: 'unregistered-rogue-chunk-id',
          documentId: docId,
          generationId: 'gen-1',
          libraryId: libId,
          versionKey: verKey,
          rank: 1,
        },
      ];

      await expect(hydrator.hydrate(hits, revId, libId, verKey)).rejects.toThrow(IndexInconsistentError);

      try {
        await hydrator.hydrate(hits, revId, libId, verKey);
      } catch (err) {
        expect(err).toBeInstanceOf(IndexInconsistentError);
        expect((err as IndexInconsistentError).code).toBe('INDEX_INCONSISTENT');
      }
    });

    it('throws CorpusCorruptError when computeChunkId does not match chunkId', async () => {
      // Content hash matches, but chunkIndex or headingPath changed
      const tamperedContent = 'New content with matching hash.';
      mockCorpusStore.getChunk = async () => ({
        ...canonicalChunk,
        content: tamperedContent,
        contentHash: sha256Hex(tamperedContent),
        // chunkId is still goodChunkId, which was computed with different content/inputs!
      });

      const hits = [
        {
          indexEntryId: 'hit-1',
          chunkId: goodChunkId,
          documentId: docId,
          generationId: 'gen-1',
          libraryId: libId,
          versionKey: verKey,
          rank: 1,
        },
      ];

      await expect(hydrator.hydrate(hits, revId, libId, verKey)).rejects.toThrow(CorpusCorruptError);
    });

    it('throws CorpusCorruptError when chunk is in manifest but missing on disk (null)', async () => {
      mockCorpusStore.getChunk = async () => null;

      const hits = [
        {
          indexEntryId: 'hit-1',
          chunkId: goodChunkId,
          documentId: docId,
          generationId: 'gen-1',
          libraryId: libId,
          versionKey: verKey,
          rank: 1,
        },
      ];

      await expect(hydrator.hydrate(hits, revId, libId, verKey)).rejects.toThrow(CorpusCorruptError);
    });

    it('throws IndexInconsistentError when hit.contentHash differs from chunk.contentHash', async () => {
      const hits = [
        {
          indexEntryId: 'hit-1',
          chunkId: goodChunkId,
          documentId: docId,
          generationId: 'gen-1',
          libraryId: libId,
          versionKey: verKey,
          rank: 1,
          contentHash: 'stale-hash-from-old-index-generation',
        },
      ];

      await expect(hydrator.hydrate(hits, revId, libId, verKey)).rejects.toThrow(IndexInconsistentError);
    });

    it('throws IndexInconsistentError when corpus revision is missing in corpusStore', async () => {
      mockCorpusStore.getRevision = async () => null;

      const hits = [
        {
          indexEntryId: 'hit-1',
          chunkId: goodChunkId,
          documentId: docId,
          generationId: 'gen-1',
          libraryId: libId,
          versionKey: verKey,
          rank: 1,
        },
      ];

      await expect(hydrator.hydrate(hits, 'non-existent-revision', libId, verKey)).rejects.toThrow(
        IndexInconsistentError,
      );
    });
  });

  // =========================================================================
  // Section 4: Citation Integrity & Formatting Security
  // =========================================================================
  describe('4. Citation Integrity & Injection Protection', () => {
    const mockDoc: NormalizedDocument = {
      schemaVersion: 1,
      documentId: 'doc-cite',
      snapshotId: 'snap-cite',
      libraryId: 'lib',
      versionKey: 'v1',
      canonicalUrl: 'https://example.com/guide',
      title: 'User Guide',
      markdown: '',
      headings: [
        { level: 1, text: 'User Guide', anchor: 'user-guide' },
        { level: 2, text: 'Installation', anchor: 'installation' },
        { level: 3, text: 'Troubleshooting', anchor: 'faq-troubleshooting' },
      ],
      normalizedHash: 'h-cite',
      normalizerProfileId: 'norm-1',
      metadata: {},
    };

    it('returns canonical URL without fake #anchor when anchor is not in document headings', () => {
      const fakeAnchors = [
        'nonexistent-heading',
        'phantom-anchor',
        'admin-panel',
        'arbitrary-id',
      ];

      for (const fakeAnchor of fakeAnchors) {
        const url = resolveOfficialUrl(mockDoc.canonicalUrl, fakeAnchor, mockDoc);
        expect(url).toBe('https://example.com/guide');
        expect(url).not.toContain(`#${fakeAnchor}`);
      }
    });

    it('returns official URL with verified #anchor when anchor exists in headings', () => {
      const validUrl1 = resolveOfficialUrl(mockDoc.canonicalUrl, 'installation', mockDoc);
      expect(validUrl1).toBe('https://example.com/guide#installation');

      const validUrl2 = resolveOfficialUrl(mockDoc.canonicalUrl, 'faq-troubleshooting', mockDoc);
      expect(validUrl2).toBe('https://example.com/guide#faq-troubleshooting');
    });

    it('normalizes anchors with leading hash (#installation -> #installation)', () => {
      const url = resolveOfficialUrl(mockDoc.canonicalUrl, '#installation', mockDoc);
      expect(url).toBe('https://example.com/guide#installation');
      expect(url).not.toContain('##');
    });

    it('returns pure canonicalUrl if document is null or has empty headings', () => {
      expect(resolveOfficialUrl('https://example.com/guide', 'installation', null)).toBe(
        'https://example.com/guide',
      );
      const emptyHeadingsDoc = { ...mockDoc, headings: [] };
      expect(
        resolveOfficialUrl('https://example.com/guide', 'installation', emptyHeadingsDoc),
      ).toBe('https://example.com/guide');
    });

    it('escapes markdown injection characters in titles and headings', () => {
      const adversarialTitles = [
        '[Evil Link](https://attacker.com)',
        '*Bold* and _Italic_ and `Code` and # Heading',
        '<script>alert("xss")</script>',
        '| Column 1 | Column 2 | Table Injection |',
        'Header with {curly} and [brackets] and (parens) and \\ backslash',
        'Exclamation ! and Dot . and Dash - and Plus + and Pipe |',
      ];

      for (const title of adversarialTitles) {
        const escaped = escapeMarkdown(title);
        // None of the raw control characters [ ] ( ) < > * _ # should remain unescaped
        expect(escaped).not.toMatch(/(?<!\\)[\[\]\(\)<>\*_#]/);
      }
    });

    it('escapes heading breadcrumbs in formatHeadingLine', () => {
      const formatted = formatHeadingLine('[Main] *Section*', ['Level <1>', 'Topic (Advanced)']);
      expect(formatted).toBe(
        '\\[Main\\] \\*Section\\* > Level \\<1\\> > Topic \\(Advanced\\)',
      );
    });

    it('safely processes special tokens without tokenizer exceptions', () => {
      const specialTokens = [
        '<|endoftext|>',
        '<|fim_prefix|>',
        '<|fim_middle|>',
        '<|fim_suffix|>',
        '<|endofprompt|>',
      ];

      for (const token of specialTokens) {
        const text = `Document explaining special LLM token ${token} in detail.`;
        // TiktokenCounter must not throw on any special token
        expect(() => tokenCounter.count(text)).not.toThrow();
        const count = tokenCounter.count(text);
        expect(count).toBeGreaterThan(0);

        // ContextPacker must pack candidate containing special token without throwing
        const cand = createCandidate('spec', text);
        expect(() => packer.pack([cand], 2000)).not.toThrow();
        const packed = packer.pack([cand], 2000);
        expect(packed.status).toBe('ok');
        expect(packed.context).toContain(token);
      }
    });
  });

  // =========================================================================
  // Section 5: End-to-End GetContextUseCase Adversarial Integration
  // =========================================================================
  describe('5. GetContextUseCase End-to-End Adversarial Integration', () => {
    let tmpDir: string;
    let corpusStore: FilesystemCorpusStore;
    let manifestStore: SqliteManifestStore;
    let registry: MockLibraryRegistry;
    let searchAdapter: InMemorySearchAdapter;
    let getContextUseCase: GetContextUseCase;

    const libraryId = 'e2e-adv-lib';
    const versionKey = 'current';
    const backendKey = 'adv-backend';
    const generationId = 'e2e-gen-01';
    const corpusRevisionId = 'e2e-rev-01';
    const chunkerProfileId = 'e2e-profile';
    const normalizerProfileId = 'e2e-norm';
    const canonicalUrl = 'https://example.com/e2e';
    const documentId = computeDocumentId(libraryId, versionKey, canonicalUrl);

    let snapshotId: string;
    let validChunkId: string;
    let validChunk: DocumentChunk;
    let validDoc: NormalizedDocument;

    beforeEach(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-adv-retrieval-'));
      corpusStore = new FilesystemCorpusStore(tmpDir);
      manifestStore = new SqliteManifestStore(path.join(tmpDir, 'manifest/catalog.sqlite'));
      registry = new MockLibraryRegistry();
      searchAdapter = new InMemorySearchAdapter(backendKey);

      registry.register({
        schemaVersion: 1,
        id: libraryId,
        name: 'E2E Adversarial Library',
        defaultVersionKey: versionKey,
        versions: [
          {
            versionKey,
            strategy: 'rolling',
            source: {
              type: 'static',
              urls: [canonicalUrl],
              allowedHosts: ['example.com'],
              includePaths: ['/**'],
              collectionAllowed: true,
            },
            parser: { contentSelectors: ['main'] },
            chunking: { minTokens: 50, targetTokens: 200, maxTokens: 600, maxAtomicTokens: 16000 },
            freshness: { staleAfterHours: 24 },
          },
        ],
      });

      const content = 'Official documentation content for retrieval.';
      const contentHash = sha256Hex(content);
      const headings = [{ level: 1, text: 'E2E Title', anchor: 'e2e-title' }];
      const normalizedHash = computeNormalizedHash({
        title: 'E2E Title',
        markdown: content,
        headings,
        metadata: {},
      });
      snapshotId = computeSnapshotId(documentId, normalizerProfileId, normalizedHash);
      validChunkId = computeChunkId(snapshotId, chunkerProfileId, 0, ['E2E'], content);

      validChunk = {
        schemaVersion: 1,
        chunkId: validChunkId,
        documentId,
        snapshotId,
        libraryId,
        versionKey,
        chunkerProfileId,
        title: 'E2E Title',
        headingPath: ['E2E'],
        anchor: 'e2e-title',
        content,
        chunkIndex: 0,
        hasCode: false,
        oversized: false,
        tokenCount: tokenCounter.count(content),
        contentHash,
      };

      validDoc = {
        schemaVersion: 1,
        documentId,
        snapshotId,
        libraryId,
        versionKey,
        canonicalUrl,
        title: 'E2E Title',
        markdown: content,
        headings,
        normalizedHash,
        normalizerProfileId,
        metadata: {},
      };

      await corpusStore.saveDocument(validDoc);
      await corpusStore.saveChunks(chunkerProfileId, snapshotId, [validChunk]);

      await corpusStore.saveRevision({
        schemaVersion: 1,
        corpusRevisionId,
        libraryId,
        versionKey,
        createdAt: '2026-09-13T12:00:00.000Z',
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
      });

      await manifestStore.registerCorpusRevision({
        corpusRevisionId,
        libraryId,
        versionKey,
        createdAt: '2026-09-13T12:00:00.000Z',
        versionProfileHash: 'vcfg',
        documentCount: 1,
        syncRunId: 'sync-e2e',
        isComplete: true,
      });

      await manifestStore.saveIndexGeneration({
        generationId,
        backendKey,
        corpusRevisionId,
        indexProfileHash: 'idx-profile',
        state: 'published',
        entryCount: 1,
        entryIds: [computeIndexEntryId(generationId, validChunkId)],
      });

      await manifestStore.setPublishedPointer({
        backendKey,
        libraryId,
        versionKey,
        generationId,
        publishedAt: '2026-09-13T12:00:00.000Z',
      });

      await searchAdapter.stageGeneration(generationId);
      await searchAdapter.importBatch(generationId, [
        {
          indexEntryId: computeIndexEntryId(generationId, validChunkId),
          generationId,
          chunkId: validChunkId,
          documentId,
          snapshotId,
          libraryId,
          versionKey,
          title: validChunk.title,
          headingPath: validChunk.headingPath,
          content,
          url: validDoc.canonicalUrl,
          contentHash,
          hasCode: false,
        },
      ]);

      getContextUseCase = new GetContextUseCase(
        registry,
        manifestStore,
        corpusStore,
        searchAdapter,
        tokenCounter,
        backendKey,
      );
    });

    afterEach(() => {
      manifestStore.close();
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('successfully returns cited context on valid query and budget', async () => {
      const res = await getContextUseCase.execute({
        libraryId,
        query: 'Official documentation',
        maxTokens: 2000,
      });

      expect(res.status).toBe('ok');
      expect(res.library.id).toBe(libraryId);
      expect(res.generationId).toBe(generationId);
      expect(res.corpusRevisionId).toBe(corpusRevisionId);
      expect(res.sources.length).toBe(1);
      expect(res.sources[0]!.id).toBe('S1');
      expect(res.sources[0]!.url).toBe('https://example.com/e2e#e2e-title');
      expect(res.budget.maxTokens).toBe(2000);
      expect(res.budget.usedTokens).toBe(tokenCounter.count(res.context));
      expect(res.budget.truncated).toBe(false);
      expect(res.budget.omittedChunkCount).toBe(0);
    });

    it('returns no_matches when query matches 0 documents', async () => {
      const res = await getContextUseCase.execute({
        libraryId,
        query: 'xyznonexistentterm12345',
        maxTokens: 6000,
      });

      expect(res.status).toBe('no_matches');
      expect(res.context).toBe('');
      expect(res.sources).toEqual([]);
      expect(res.budget.usedTokens).toBe(0);
      expect(res.budget.truncated).toBe(false);
      expect(res.budget.omittedChunkCount).toBe(0);
    });

    it('validates libraryId format strictly', async () => {
      await expect(
        getContextUseCase.execute({ libraryId: 'INVALID_CAPS', query: 'test' }),
      ).rejects.toThrow(InvalidRequestError);

      await expect(
        getContextUseCase.execute({ libraryId: '-leading-dash', query: 'test' }),
      ).rejects.toThrow(InvalidRequestError);

      await expect(
        getContextUseCase.execute({ libraryId: '', query: 'test' }),
      ).rejects.toThrow(InvalidRequestError);
    });

    it('validates query bounds: empty, whitespace-only, and > 2000 chars', async () => {
      await expect(
        getContextUseCase.execute({ libraryId, query: '' }),
      ).rejects.toThrow(InvalidRequestError);

      await expect(
        getContextUseCase.execute({ libraryId, query: '   \t\n  ' }),
      ).rejects.toThrow(InvalidRequestError);

      await expect(
        getContextUseCase.execute({ libraryId, query: 'x'.repeat(2001) }),
      ).rejects.toThrow(InvalidRequestError);
    });

    it('validates versionKey format when provided', async () => {
      await expect(
        getContextUseCase.execute({ libraryId, query: 'test', versionKey: 'BAD VERSION' }),
      ).rejects.toThrow(InvalidRequestError);
    });
  });
});
