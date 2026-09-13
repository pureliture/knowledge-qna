import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { HtmlDocumentNormalizer } from '../../src/infrastructure/parsing/HtmlDocumentNormalizer.js';
import { MarkdownAstChunker } from '../../src/infrastructure/parsing/MarkdownAstChunker.js';
import { TiktokenCounter } from '../../src/infrastructure/tokens/TiktokenCounter.js';
import { FilesystemCorpusStore } from '../../src/infrastructure/storage/FilesystemCorpusStore.js';
import type { ChunkingConfig, ParserConfig } from '../../src/domain/models/index.js';

describe('Gate T-04: Normalization and Atomic AST Chunking Pipeline Integration', () => {
  let tmpDir: string;
  let corpusStore: FilesystemCorpusStore;
  let normalizer: HtmlDocumentNormalizer;
  let chunker: MarkdownAstChunker;
  let tokenCounter: TiktokenCounter;

  const parserConfig: ParserConfig = {
    contentSelectors: ['main', 'article'],
    removeSelectors: ['nav', 'footer', 'script', 'style'],
  };

  const chunkingConfig: ChunkingConfig = {
    minTokens: 200,
    targetTokens: 800,
    maxTokens: 1400,
    maxAtomicTokens: 16000,
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-t04-test-'));
    corpusStore = new FilesystemCorpusStore(tmpDir);
    normalizer = new HtmlDocumentNormalizer('normalizer-profile-v1');
    tokenCounter = new TiktokenCounter();
    chunker = new MarkdownAstChunker(tokenCounter, 'chunker-profile-v1');
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('Gate T-04: converts HTML to canonical Markdown, chunks atomically, and persists to CorpusStore deterministically', async () => {
    // 1. Realistic documentation HTML with headings, lists, tables, code blocks, and links
    const htmlFixture = `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <title>Ontology API Guide - Palantir Foundry</title>
        </head>
        <body>
          <nav class="sidebar">
            <ul><li><a href="/nav1">Nav Item 1</a></li></ul>
          </nav>
          <main id="content">
            <h1 id="ontology-overview">Ontology Object API Overview</h1>
            <p>The Foundry Ontology is a digital twin of your organization. See the <a href="/docs/foundry/security">Security Guide</a> for permission models.</p>

            <h2 id="object-type-config">Object Type Configuration</h2>
            <p>Object types define entities within the ontology. The following table describes schema definitions:</p>

            <table>
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Type</th>
                  <th>Required</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>apiName</td>
                  <td>string</td>
                  <td>true</td>
                  <td>Unique API identifier for the object type in camelCase.</td>
                </tr>
                <tr>
                  <td>primaryKey</td>
                  <td>string</td>
                  <td>true</td>
                  <td>The property that uniquely identifies an object instance.</td>
                </tr>
                <tr>
                  <td>status</td>
                  <td>string</td>
                  <td>false</td>
                  <td>Lifecycle status: ACTIVE, DEPRECATED, or EXPERIMENTAL.</td>
                </tr>
                <tr>
                  <td>visibility</td>
                  <td>string</td>
                  <td>false</td>
                  <td>Access visibility across workspace applications.</td>
                </tr>
              </tbody>
            </table>

            <h2 id="sdk-generation">TypeScript SDK Generation</h2>
            <p>You can query object types directly using the generated TypeScript SDK:</p>

            <pre><code class="language-typescript">import { FoundryClient } from "@osdk/client";
import { Employee } from "@osdk/foundry-sdk";

export async function fetchActiveEmployees(client: FoundryClient): Promise<Employee[]> {
    const results = await client(Employee)
        .where({ status: { $eq: "ACTIVE" } })
        .fetchPage({ pageSize: 50 });

    return results.data;
}
</code></pre>

            <h3 id="filtering-notes">Filtering and Pagination</h3>
            <p>Always paginate requests when querying large object sets. See relative link <a href="pagination.html#limits">Pagination Limits</a>.</p>
          </main>
          <footer class="site-footer">
            <p>Copyright 2026 Palantir Technologies Inc.</p>
          </footer>
        </body>
      </html>
    `;

    const libraryId = 'palantir-foundry';
    const versionKey = 'current';
    const canonicalUrl = 'https://www.palantir.com/docs/foundry/ontology/api.html';

    // 2. Normalization Step
    const normalizedDoc = await normalizer.normalize({
      libraryId,
      versionKey,
      canonicalUrl,
      html: htmlFixture,
      parserConfig,
      normalizerProfileId: 'normalizer-profile-v1',
    });

    expect(normalizedDoc.title).toBe('Ontology Object API Overview');
    expect(normalizedDoc.metadata.language).toBe('en');

    // Verify noise removal
    expect(normalizedDoc.markdown).not.toContain('Nav Item 1');
    expect(normalizedDoc.markdown).not.toContain('Copyright 2026 Palantir');

    // Verify URL resolution
    expect(normalizedDoc.markdown).toContain(
      '[Security Guide](https://www.palantir.com/docs/foundry/security)',
    );
    expect(normalizedDoc.markdown).toContain(
      '[Pagination Limits](https://www.palantir.com/docs/foundry/ontology/pagination.html#limits)',
    );

    // Verify Headings
    expect(normalizedDoc.headings).toEqual([
      { level: 1, text: 'Ontology Object API Overview', anchor: 'ontology-overview' },
      { level: 2, text: 'Object Type Configuration', anchor: 'object-type-config' },
      { level: 2, text: 'TypeScript SDK Generation', anchor: 'sdk-generation' },
      { level: 3, text: 'Filtering and Pagination', anchor: 'filtering-notes' },
    ]);

    // 3. Chunking Step
    const chunks = await chunker.chunk({
      document: normalizedDoc,
      config: chunkingConfig,
      chunkerProfileId: 'chunker-profile-v1',
    });

    expect(chunks.length).toBeGreaterThan(0);

    // Verify Table Atomicity: Table must be fully contained within a chunk without row splitting
    const tableChunk = chunks.find((c) => c.content.includes('| Field | Type | Required |'));
    expect(tableChunk).toBeDefined();
    expect(tableChunk!.content).toContain('| apiName | string | true |');
    expect(tableChunk!.content).toContain('| visibility | string | false |');
    expect(tableChunk!.headingPath).toContain('Object Type Configuration');
    expect(tableChunk!.anchor).toBe('object-type-config');

    // Verify Code Block Atomicity: TypeScript code block must be fully preserved intact
    const codeChunk = chunks.find((c) => c.hasCode);
    expect(codeChunk).toBeDefined();
    expect(codeChunk!.content).toContain('```typescript');
    expect(codeChunk!.content).toContain('export async function fetchActiveEmployees');
    expect(codeChunk!.content).toContain('return results.data;\n}');
    expect(codeChunk!.headingPath).toContain('TypeScript SDK Generation');
    expect(codeChunk!.anchor).toBe('sdk-generation');

    // 4. Persistence Step: Save to FilesystemCorpusStore
    await corpusStore.saveDocument(normalizedDoc);
    await corpusStore.saveChunks('chunker-profile-v1', normalizedDoc.snapshotId, chunks);

    // Verify existence on disk
    expect(await corpusStore.hasDocument(normalizedDoc.documentId, normalizedDoc.snapshotId)).toBe(
      true,
    );
    expect(await corpusStore.hasChunks('chunker-profile-v1', normalizedDoc.snapshotId)).toBe(true);

    // Read back and assert equality
    const loadedDoc = await corpusStore.getDocument(
      normalizedDoc.documentId,
      normalizedDoc.snapshotId,
    );
    expect(loadedDoc).toEqual(normalizedDoc);

    const loadedChunks = await corpusStore.getChunksForSnapshot(
      'chunker-profile-v1',
      normalizedDoc.snapshotId,
    );
    expect(loadedChunks).toEqual(chunks);

    // 5. Deterministic Round-Trip: Re-running pipeline on identical HTML produces byte-identical IDs
    const normalizedDoc2 = await normalizer.normalize({
      libraryId,
      versionKey,
      canonicalUrl,
      html: htmlFixture,
      parserConfig,
      normalizerProfileId: 'normalizer-profile-v1',
    });

    expect(normalizedDoc2.documentId).toBe(normalizedDoc.documentId);
    expect(normalizedDoc2.normalizedHash).toBe(normalizedDoc.normalizedHash);
    expect(normalizedDoc2.snapshotId).toBe(normalizedDoc.snapshotId);

    const chunks2 = await chunker.chunk({
      document: normalizedDoc2,
      config: chunkingConfig,
      chunkerProfileId: 'chunker-profile-v1',
    });

    expect(chunks2).toHaveLength(chunks.length);
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks2[i]!.chunkId).toBe(chunks[i]!.chunkId);
      expect(chunks2[i]!.contentHash).toBe(chunks[i]!.contentHash);
      expect(chunks2[i]!.tokenCount).toBe(chunks[i]!.tokenCount);
    }

    // Idempotent re-save succeeds without error
    await expect(corpusStore.saveDocument(normalizedDoc2)).resolves.not.toThrow();
    await expect(
      corpusStore.saveChunks('chunker-profile-v1', normalizedDoc2.snapshotId, chunks2),
    ).resolves.not.toThrow();
  });
});
