import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { GetContextUseCase } from '../../src/application/retrieval/get-context.js';
import { TiktokenCounter } from '../../src/infrastructure/tokens/TiktokenCounter.js';
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

describe('M2 Retrieval Adversarial & Stress Testing (Gate T-11)', () => {
  let tmpDir: string;
  let corpusStore: FilesystemCorpusStore;
  let manifestStore: SqliteManifestStore;
  let registry: MockLibraryRegistry;
  let searchAdapter: InMemorySearchAdapter;
  let tokenCounter: TiktokenCounter;
  let getContextUseCase: GetContextUseCase;

  const libraryId = 'adversarial-lib';
  const versionKey = 'current';
  const backendKey = 'adv-backend';
  const generationId = 'adv-gen-001';
  const corpusRevisionId = 'adv-rev-001';
  const chunkerProfileId = 'adv-profile';
  const normalizerProfileId = 'norm-1';
  const canonicalUrl = 'https://example.com/adv';
  const documentId = computeDocumentId(libraryId, versionKey, canonicalUrl);

  let snapshotId: string;
  let validChunk: DocumentChunk;
  let validDoc: NormalizedDocument;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-retrieval-'));
    corpusStore = new FilesystemCorpusStore(tmpDir);
    manifestStore = new SqliteManifestStore(path.join(tmpDir, 'manifest/catalog.sqlite'));
    registry = new MockLibraryRegistry();
    searchAdapter = new InMemorySearchAdapter(backendKey);
    tokenCounter = new TiktokenCounter();

    const libDef: LibraryDefinition = {
      schemaVersion: 1,
      id: libraryId,
      name: 'Adversarial Test Library',
      defaultVersionKey: versionKey,
      versions: [
        {
          versionKey,
          strategy: 'rolling',
          source: {
            type: 'static',
            urls: ['https://example.com/adv'],
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

    // Setup valid document and chunk with deterministic IDs
    const content = 'Valid adversarial test canonical text.';
    const contentHash = sha256Hex(content);
    const headings = [{ level: 1, text: 'Security Guide', anchor: 'security-guide' }];
    const metadata = {};
    const title = 'Security Guide';

    const normalizedHash = computeNormalizedHash({
      title,
      markdown: content,
      headings,
      metadata,
    });
    snapshotId = computeSnapshotId(documentId, normalizerProfileId, normalizedHash);
    const chunkId = computeChunkId(snapshotId, chunkerProfileId, 0, ['Security'], content);

    validChunk = {
      schemaVersion: 1,
      chunkId,
      documentId,
      snapshotId,
      libraryId,
      versionKey,
      chunkerProfileId,
      title,
      headingPath: ['Security'],
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
      title,
      markdown: content,
      headings,
      normalizedHash,
      normalizerProfileId,
      metadata,
    };

    // Save document, chunks, and revision to corpus store
    await corpusStore.saveDocument(validDoc);
    await corpusStore.saveChunks(chunkerProfileId, snapshotId, [validChunk]);

    const revision: CorpusRevision = {
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

    // Setup SQLite manifest
    await manifestStore.registerCorpusRevision({
      corpusRevisionId,
      libraryId,
      versionKey,
      createdAt: '2026-09-13T12:00:00.000Z',
      versionProfileHash: 'vcfg',
      documentCount: 1,
      syncRunId: 'sync-1',
      isComplete: true,
    });

    await manifestStore.saveIndexGeneration({
      generationId,
      backendKey,
      corpusRevisionId,
      indexProfileHash: 'profile-1',
      state: 'published',
      entryCount: 1,
      entryIds: [computeIndexEntryId(generationId, chunkId)],
    });

    await manifestStore.setPublishedPointer({
      backendKey,
      libraryId,
      versionKey,
      generationId,
      publishedAt: '2026-09-13T12:00:00.000Z',
    });

    // Populate search adapter
    await searchAdapter.stageGeneration(generationId);
    await searchAdapter.importBatch(generationId, [
      {
        indexEntryId: computeIndexEntryId(generationId, chunkId),
        generationId,
        chunkId,
        documentId,
        snapshotId,
        libraryId,
        versionKey,
        title: validChunk.title,
        headingPath: validChunk.headingPath,
        content: validChunk.content,
        url: validDoc.canonicalUrl,
        contentHash: validChunk.contentHash,
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

  describe('Budget Boundary & Validation Edge Cases', () => {
    it('rejects maxTokens < 256 with InvalidRequestError', async () => {
      await expect(
        getContextUseCase.execute({ libraryId, query: 'test', maxTokens: 255 }),
      ).rejects.toThrow(InvalidRequestError);
    });

    it('rejects maxTokens > 16000 with InvalidRequestError', async () => {
      await expect(
        getContextUseCase.execute({ libraryId, query: 'test', maxTokens: 16001 }),
      ).rejects.toThrow(InvalidRequestError);
    });

    it('rejects fractional maxTokens with InvalidRequestError', async () => {
      await expect(
        getContextUseCase.execute({ libraryId, query: 'test', maxTokens: 500.5 }),
      ).rejects.toThrow(InvalidRequestError);
    });

    it('throws TokenBudgetExceededError when top-1 chunk exceeds budget', async () => {
      // Create a doc with large content that cannot fit within 256 tokens when combined with Preamble
      const largeContent = 'Important text block that repeats. '.repeat(150);
      const largeHash = sha256Hex(largeContent);
      const largeUrl = 'https://example.com/large';
      const largeDocId = computeDocumentId(libraryId, versionKey, largeUrl);
      const largeNormHash = computeNormalizedHash({
        title: 'Large',
        markdown: largeContent,
        headings: [],
        metadata: {},
      });
      const largeSnapId = computeSnapshotId(largeDocId, normalizerProfileId, largeNormHash);
      const largeChunkId = computeChunkId(largeSnapId, chunkerProfileId, 0, ['Large'], largeContent);

      const largeChunk: DocumentChunk = {
        schemaVersion: 1,
        chunkId: largeChunkId,
        documentId: largeDocId,
        snapshotId: largeSnapId,
        libraryId,
        versionKey,
        chunkerProfileId,
        title: 'Large Section',
        headingPath: ['Large'],
        content: largeContent,
        chunkIndex: 0,
        hasCode: false,
        oversized: false,
        tokenCount: tokenCounter.count(largeContent),
        contentHash: largeHash,
      };

      const largeDoc: NormalizedDocument = {
        schemaVersion: 1,
        documentId: largeDocId,
        snapshotId: largeSnapId,
        libraryId,
        versionKey,
        canonicalUrl: largeUrl,
        title: 'Large Section',
        markdown: largeContent,
        headings: [],
        normalizedHash: largeNormHash,
        normalizerProfileId,
        metadata: {},
      };

      await corpusStore.saveDocument(largeDoc);
      await corpusStore.saveChunks(chunkerProfileId, largeSnapId, [largeChunk]);

      const revision: CorpusRevision = {
        schemaVersion: 1,
        corpusRevisionId: 'rev-large',
        libraryId,
        versionKey,
        createdAt: '2026-09-13T12:00:00.000Z',
        documents: [
          {
            documentId: largeDocId,
            snapshotId: largeSnapId,
            chunkerProfileId,
            chunkIds: [largeChunkId],
          },
        ],
        registryProfileSnapshot: {
          versionConfigHash: 'vcfg',
          normalizerProfile: {},
          chunkerProfile: {},
        },
      };
      await corpusStore.saveRevision(revision);

      await manifestStore.saveIndexGeneration({
        generationId: 'gen-large',
        backendKey,
        corpusRevisionId: 'rev-large',
        indexProfileHash: 'profile-1',
        state: 'published',
        entryCount: 1,
        entryIds: [computeIndexEntryId('gen-large', largeChunkId)],
      });

      await manifestStore.setPublishedPointer({
        backendKey,
        libraryId,
        versionKey,
        generationId: 'gen-large',
        publishedAt: '2026-09-13T12:00:00.000Z',
      });

      await searchAdapter.stageGeneration('gen-large');
      await searchAdapter.importBatch('gen-large', [
        {
          indexEntryId: computeIndexEntryId('gen-large', largeChunkId),
          generationId: 'gen-large',
          chunkId: largeChunkId,
          documentId: largeDocId,
          snapshotId: largeSnapId,
          libraryId,
          versionKey,
          title: largeChunk.title,
          headingPath: largeChunk.headingPath,
          content: largeContent,
          url: largeDoc.canonicalUrl,
          contentHash: largeHash,
          hasCode: false,
        },
      ]);

      await expect(
        getContextUseCase.execute({ libraryId, query: 'Important text', maxTokens: 256 }),
      ).rejects.toThrow(TokenBudgetExceededError);
    });
  });

  describe('Corpus Corruption & Inconsistency Defenses', () => {
    it('throws IndexInconsistentError when search hit chunk is not in manifest', async () => {
      const ghostChunkId = 'chunk-ghost-999';
      // Import ghost chunk directly into search backend without updating corpus revision manifest
      await searchAdapter.importBatch(generationId, [
        {
          indexEntryId: computeIndexEntryId(generationId, ghostChunkId),
          generationId,
          chunkId: ghostChunkId,
          documentId,
          snapshotId,
          libraryId,
          versionKey,
          title: 'Ghost Title',
          headingPath: [],
          content: 'Ghost text content',
          url: 'https://example.com/ghost',
          contentHash: 'hash-ghost',
          hasCode: false,
        },
      ]);

      await expect(
        getContextUseCase.execute({ libraryId, query: 'Ghost text content' }),
      ).rejects.toThrow(IndexInconsistentError);
    });

    it('throws CorpusCorruptError when chunk file on disk is tampered (hash mismatch)', async () => {
      // Tamper chunk directly on disk
      const chunkPath = path.join(tmpDir, 'corpus', 'chunks', chunkerProfileId, `${snapshotId}.jsonl`);
      const tamperedChunk = {
        ...validChunk,
        content: 'Tampered malicious content inserted into storage!',
      };
      fs.writeFileSync(chunkPath, JSON.stringify(tamperedChunk) + '\n', 'utf-8');

      await expect(
        getContextUseCase.execute({ libraryId, query: 'adversarial test' }),
      ).rejects.toThrow(CorpusCorruptError);
    });

    it('throws CorpusCorruptError when chunk ID does not match computed deterministic ID', async () => {
      // Tamper chunk heading path on disk without changing chunkId
      const chunkPath = path.join(tmpDir, 'corpus', 'chunks', chunkerProfileId, `${snapshotId}.jsonl`);
      const tamperedChunk = {
        ...validChunk,
        headingPath: ['Altered', 'Heading'],
      };
      fs.writeFileSync(chunkPath, JSON.stringify(tamperedChunk) + '\n', 'utf-8');

      await expect(
        getContextUseCase.execute({ libraryId, query: 'adversarial test' }),
      ).rejects.toThrow(CorpusCorruptError);
    });
  });

  describe('Special Tokens & Injection Protection', () => {
    it('safely handles <|endoftext|> in document text without tokenizer exception', async () => {
      const specialContent = 'LLM tokenizer test: <|endoftext|> token inside body.';
      const specialHash = sha256Hex(specialContent);
      const specialUrl = 'https://example.com/special';
      const specialDocId = computeDocumentId(libraryId, versionKey, specialUrl);
      const specialNormHash = computeNormalizedHash({
        title: 'Special',
        markdown: specialContent,
        headings: [],
        metadata: {},
      });
      const specialSnapId = computeSnapshotId(specialDocId, normalizerProfileId, specialNormHash);
      const specialChunkId = computeChunkId(specialSnapId, chunkerProfileId, 0, ['Tokens'], specialContent);

      const specialChunk: DocumentChunk = {
        schemaVersion: 1,
        chunkId: specialChunkId,
        documentId: specialDocId,
        snapshotId: specialSnapId,
        libraryId,
        versionKey,
        chunkerProfileId,
        title: 'Special Token Guide',
        headingPath: ['Tokens'],
        content: specialContent,
        chunkIndex: 0,
        hasCode: false,
        oversized: false,
        tokenCount: tokenCounter.count(specialContent),
        contentHash: specialHash,
      };

      const specialDoc: NormalizedDocument = {
        schemaVersion: 1,
        documentId: specialDocId,
        snapshotId: specialSnapId,
        libraryId,
        versionKey,
        canonicalUrl: specialUrl,
        title: 'Special Token Guide',
        markdown: specialContent,
        headings: [],
        normalizedHash: specialNormHash,
        normalizerProfileId,
        metadata: {},
      };

      await corpusStore.saveDocument(specialDoc);
      await corpusStore.saveChunks(chunkerProfileId, specialSnapId, [specialChunk]);

      const specialRevId = 'adv-rev-special';
      const specialGenId = 'adv-gen-special';
      const specialRevision: CorpusRevision = {
        schemaVersion: 1,
        corpusRevisionId: specialRevId,
        libraryId,
        versionKey,
        createdAt: '2026-09-13T12:00:00.000Z',
        documents: [
          {
            documentId: specialDocId,
            snapshotId: specialSnapId,
            chunkerProfileId,
            chunkIds: [specialChunkId],
          },
        ],
        registryProfileSnapshot: {
          versionConfigHash: 'vcfg',
          normalizerProfile: {},
          chunkerProfile: {},
        },
      };
      await corpusStore.saveRevision(specialRevision);

      await manifestStore.saveIndexGeneration({
        generationId: specialGenId,
        backendKey,
        corpusRevisionId: specialRevId,
        indexProfileHash: 'profile-1',
        state: 'published',
        entryCount: 1,
        entryIds: [computeIndexEntryId(specialGenId, specialChunkId)],
      });

      await manifestStore.setPublishedPointer({
        backendKey,
        libraryId,
        versionKey,
        generationId: specialGenId,
        publishedAt: '2026-09-13T12:00:00.000Z',
      });

      await searchAdapter.stageGeneration(specialGenId);
      await searchAdapter.importBatch(specialGenId, [
        {
          indexEntryId: computeIndexEntryId(specialGenId, specialChunkId),
          generationId: specialGenId,
          chunkId: specialChunkId,
          documentId: specialDocId,
          snapshotId: specialSnapId,
          libraryId,
          versionKey,
          title: specialChunk.title,
          headingPath: specialChunk.headingPath,
          content: specialContent,
          url: specialDoc.canonicalUrl,
          contentHash: specialHash,
          hasCode: false,
        },
      ]);

      const result = await getContextUseCase.execute({
        libraryId,
        query: 'endoftext token',
        maxTokens: 2000,
      });

      expect(result.status).toBe('ok');
      expect(result.context).toContain('<|endoftext|>');
    });

    it('escapes Markdown injection characters in titles and headings', async () => {
      const injectTitle = '[Click Here](https://malicious.com) *Bold*';
      const injectHeading = ['# Injection', '<script>alert(1)</script>'];
      const injectContent = 'Safe content under injected header.';
      const injectHash = sha256Hex(injectContent);
      const injectUrl = 'https://example.com/inject';
      const injectDocId = computeDocumentId(libraryId, versionKey, injectUrl);
      const injectNormHash = computeNormalizedHash({
        title: injectTitle,
        markdown: injectContent,
        headings: [],
        metadata: {},
      });
      const injectSnapId = computeSnapshotId(injectDocId, normalizerProfileId, injectNormHash);
      const injectChunkId = computeChunkId(injectSnapId, chunkerProfileId, 0, injectHeading, injectContent);

      const injectChunk: DocumentChunk = {
        schemaVersion: 1,
        chunkId: injectChunkId,
        documentId: injectDocId,
        snapshotId: injectSnapId,
        libraryId,
        versionKey,
        chunkerProfileId,
        title: injectTitle,
        headingPath: injectHeading,
        content: injectContent,
        chunkIndex: 0,
        hasCode: false,
        oversized: false,
        tokenCount: tokenCounter.count(injectContent),
        contentHash: injectHash,
      };

      const injectDoc: NormalizedDocument = {
        schemaVersion: 1,
        documentId: injectDocId,
        snapshotId: injectSnapId,
        libraryId,
        versionKey,
        canonicalUrl: injectUrl,
        title: injectTitle,
        markdown: injectContent,
        headings: [],
        normalizedHash: injectNormHash,
        normalizerProfileId,
        metadata: {},
      };

      await corpusStore.saveDocument(injectDoc);
      await corpusStore.saveChunks(chunkerProfileId, injectSnapId, [injectChunk]);

      const injectRevId = 'adv-rev-inject';
      const injectGenId = 'adv-gen-inject';
      const injectRevision: CorpusRevision = {
        schemaVersion: 1,
        corpusRevisionId: injectRevId,
        libraryId,
        versionKey,
        createdAt: '2026-09-13T12:00:00.000Z',
        documents: [
          {
            documentId: injectDocId,
            snapshotId: injectSnapId,
            chunkerProfileId,
            chunkIds: [injectChunkId],
          },
        ],
        registryProfileSnapshot: {
          versionConfigHash: 'vcfg',
          normalizerProfile: {},
          chunkerProfile: {},
        },
      };
      await corpusStore.saveRevision(injectRevision);

      await manifestStore.saveIndexGeneration({
        generationId: injectGenId,
        backendKey,
        corpusRevisionId: injectRevId,
        indexProfileHash: 'profile-1',
        state: 'published',
        entryCount: 1,
        entryIds: [computeIndexEntryId(injectGenId, injectChunkId)],
      });

      await manifestStore.setPublishedPointer({
        backendKey,
        libraryId,
        versionKey,
        generationId: injectGenId,
        publishedAt: '2026-09-13T12:00:00.000Z',
      });

      await searchAdapter.stageGeneration(injectGenId);
      await searchAdapter.importBatch(injectGenId, [
        {
          indexEntryId: computeIndexEntryId(injectGenId, injectChunkId),
          generationId: injectGenId,
          chunkId: injectChunkId,
          documentId: injectDocId,
          snapshotId: injectSnapId,
          libraryId,
          versionKey,
          title: injectTitle,
          headingPath: injectHeading,
          content: injectContent,
          url: injectDoc.canonicalUrl,
          contentHash: injectHash,
          hasCode: false,
        },
      ]);

      const result = await getContextUseCase.execute({
        libraryId,
        query: 'Safe content under injected',
        maxTokens: 2000,
      });

      expect(result.status).toBe('ok');
      // Verify characters are escaped with backslash
      expect(result.context).toContain('\\[Click Here\\]\\(https://malicious\\.com\\)');
      expect(result.context).toContain('\\<script\\>alert\\(1\\)\\</script\\>');
    });

    it('rejects queries with invalid lengths (< 1 or > 2000)', async () => {
      await expect(
        getContextUseCase.execute({ libraryId, query: '' }),
      ).rejects.toThrow(InvalidRequestError);

      await expect(
        getContextUseCase.execute({ libraryId, query: '   ' }),
      ).rejects.toThrow(InvalidRequestError);

      await expect(
        getContextUseCase.execute({ libraryId, query: 'a'.repeat(2001) }),
      ).rejects.toThrow(InvalidRequestError);
    });
  });
});
