/**
 * Adversarial Test Suite for M1 Normalization & AST Chunking (Gate T-04)
 * Challenger: challenger_m1_2
 *
 * Adversarially challenges:
 * 1. Malformed & Extreme HTML:
 *    - Deeply nested tables (3+ levels of nesting)
 *    - Unclosed tags (unclosed html, body, div, p, pre, code)
 *    - Multi-line table cells (cells with <br>, multiple <p>, lists)
 *    - Complex code blocks inside blockquotes (< 1400 tokens and > 1400 tokens)
 * 2. Atomicity Stress (Gate T-04):
 *    - Ensuring top-level tables and code blocks are never split near 1400 token boundary
 *    - Consecutive atomic blocks back-to-back
 *    - Oversized atomic units (1400 - 16000 tokens) emitted with oversized: true
 *    - Probing nested code block and table atomicity inside blockquotes
 * 3. Boundary Tests for Oversized Chunks:
 *    - Exactly 1399 tokens -> oversized: false, single chunk
 *    - Exactly 1401 tokens -> oversized: true, single chunk
 *    - Exactly 15,999 tokens -> oversized: true, single chunk
 *    - Exactly 16,001 tokens (atomic unit) -> DOCUMENT_TOO_LARGE CliOperationError
 *    - Exactly 16,001 tokens (document level) -> DOCUMENT_TOO_LARGE CliOperationError
 *    - Exactly 15,999 tokens (multi-paragraph document) -> chunks cleanly without error
 */

import { describe, it, expect } from 'vitest';
import { getEncoding } from 'js-tiktoken';
import { HtmlDocumentNormalizer } from '../../src/infrastructure/parsing/HtmlDocumentNormalizer.js';
import { MarkdownAstChunker } from '../../src/infrastructure/parsing/MarkdownAstChunker.js';
import { TiktokenCounter } from '../../src/infrastructure/tokens/TiktokenCounter.js';
import { CliOperationError } from '../../src/domain/errors.js';
import {
  computeDocumentId,
  computeSnapshotId,
  computeNormalizedHash,
} from '../../src/domain/identity.js';

describe('Adversarial Normalization & AST Chunking (Gate T-04)', () => {
  const enc = getEncoding('cl100k_base');
  const tokenCounter = new TiktokenCounter();
  const normalizer = new HtmlDocumentNormalizer();
  const chunker = new MarkdownAstChunker(tokenCounter);

  const defaultChunkConfig = {
    minTokens: 200,
    targetTokens: 800,
    maxTokens: 1400,
    maxAtomicTokens: 16000,
  };

  const sampleTok = enc.encode(' word')[0]!;

  function makeExactTokenCodeBlock(targetTokens: number): string {
    const overhead = enc.encode('```\n\n```').length;
    let n = Math.max(1, targetTokens - overhead);
    let md = '```\n' + enc.decode(new Array(n).fill(sampleTok)) + '\n```';
    while (enc.encode(md).length < targetTokens) {
      n++;
      md = '```\n' + enc.decode(new Array(n).fill(sampleTok)) + '\n```';
    }
    while (enc.encode(md).length > targetTokens) {
      n--;
      md = '```\n' + enc.decode(new Array(n).fill(sampleTok)) + '\n```';
    }
    return md;
  }

  function makeExactTokenParagraphs(targetTokens: number, numParagraphs: number = 20): string {
    const tokensPerPara = Math.floor(targetTokens / numParagraphs);
    const paras: string[] = [];
    let remaining = targetTokens;

    for (let i = 0; i < numParagraphs; i++) {
      const count = i === numParagraphs - 1 ? remaining : tokensPerPara;
      paras.push(enc.decode(new Array(count).fill(sampleTok)));
      remaining -= count;
    }
    let md = paras.join('\n\n');
    let currentTokens = enc.encode(md).length;

    // Adjust last paragraph until exact target count is achieved
    while (currentTokens < targetTokens) {
      paras[paras.length - 1] += enc.decode([sampleTok]);
      md = paras.join('\n\n');
      currentTokens = enc.encode(md).length;
    }
    while (currentTokens > targetTokens) {
      const last = paras[paras.length - 1]!;
      if (last.length > 5) {
        paras[paras.length - 1] = last.slice(0, -5);
      } else {
        paras.pop();
      }
      md = paras.join('\n\n');
      currentTokens = enc.encode(md).length;
    }
    return md;
  }

  // ---------------------------------------------------------------------------
  // 1. Malformed and Extreme HTML
  // ---------------------------------------------------------------------------
  describe('1. Malformed and Extreme HTML', () => {
    it('handles deeply nested tables (3 levels) without crashing or corruption', async () => {
      const nestedHtml = `
        <html>
          <body>
            <table class="level-1">
              <tr>
                <td>Level 1 Cell
                  <table class="level-2">
                    <tr>
                      <td>Level 2 Cell
                        <table class="level-3">
                          <tr><td>Deepest Content</td></tr>
                        </table>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
          </body>
        </html>
      `;

      const doc = await normalizer.normalize({
        canonicalUrl: 'https://example.com/nested-tables',
        libraryId: 'adversarial-lib',
        versionKey: '1.0',
        normalizerProfileId: 'html-normalizer-v1',
        html: nestedHtml,
        parserConfig: { contentSelectors: ['body'] },
      });

      expect(doc.markdown).toContain('Level 1 Cell');
      expect(doc.markdown).toContain('Deepest Content');

      const chunks = await chunker.chunk({
        document: doc,
        chunkerProfileId: 'ast-chunker-v1',
        config: defaultChunkConfig,
      });

      expect(chunks.length).toBeGreaterThanOrEqual(1);
      expect(chunks[0]!.content).toContain('Deepest Content');
    });

    it('recovers gracefully from unclosed tags and preserves structure', async () => {
      const unclosedHtml = `
        <div>
          <h1>Malformed Document Title</h1>
          <p>This paragraph is never closed
          <div>
            <pre><code class="language-python">def broken():
    return "unclosed tags"
      `;

      const doc = await normalizer.normalize({
        canonicalUrl: 'https://example.com/unclosed-tags',
        libraryId: 'adversarial-lib',
        versionKey: '1.0',
        normalizerProfileId: 'html-normalizer-v1',
        html: unclosedHtml,
        parserConfig: { contentSelectors: ['div'] },
      });

      expect(doc.title).toBe('Malformed Document Title');
      expect(doc.markdown).toContain('# Malformed Document Title');
      expect(doc.markdown).toContain('```python');
      expect(doc.markdown).toContain('def broken():');

      const chunks = await chunker.chunk({
        document: doc,
        chunkerProfileId: 'ast-chunker-v1',
        config: defaultChunkConfig,
      });

      expect(chunks.length).toBe(1);
      expect(chunks[0]!.hasCode).toBe(true);
      expect(chunks[0]!.content).toContain('```python');
    });

    it('correctly parses tables with multi-line cells (<br>, <p>, lists)', async () => {
      const multilineTableHtml = `
        <table>
          <thead>
            <tr><th>Header A</th><th>Header B</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>Line 1<br/>Line 2<br/>Line 3</td>
              <td><p>Paragraph 1</p><p>Paragraph 2</p></td>
            </tr>
            <tr>
              <td>Simple Cell</td>
              <td>
                <ul>
                  <li>Item 1</li>
                  <li>Item 2</li>
                </ul>
              </td>
            </tr>
          </tbody>
        </table>
      `;

      const doc = await normalizer.normalize({
        canonicalUrl: 'https://example.com/multiline-table',
        libraryId: 'adversarial-lib',
        versionKey: '1.0',
        normalizerProfileId: 'html-normalizer-v1',
        html: multilineTableHtml,
        parserConfig: { contentSelectors: ['body'] },
      });

      expect(doc.markdown).toContain('Header A');
      expect(doc.markdown).toContain('Header B');

      const chunks = await chunker.chunk({
        document: doc,
        chunkerProfileId: 'ast-chunker-v1',
        config: defaultChunkConfig,
      });

      expect(chunks.length).toBe(1);
      expect(chunks[0]!.content).toContain('Header A');
      expect(chunks[0]!.content).toContain('Paragraph 1');
    });

    it('preserves code blocks inside blockquotes when within maxTokens budget', async () => {
      const blockquoteHtml = `
        <blockquote>
          <p><strong>Note:</strong> Observe the following snippet:</p>
          <pre><code class="language-typescript">const apiKey = process.env.API_KEY;\nif (!apiKey) throw new Error("Missing key");</code></pre>
        </blockquote>
      `;

      const doc = await normalizer.normalize({
        canonicalUrl: 'https://example.com/blockquote-code',
        libraryId: 'adversarial-lib',
        versionKey: '1.0',
        normalizerProfileId: 'html-normalizer-v1',
        html: blockquoteHtml,
        parserConfig: { contentSelectors: ['body'] },
      });

      expect(doc.markdown).toContain('**Note:**');
      expect(doc.markdown).toContain('```typescript');

      const chunks = await chunker.chunk({
        document: doc,
        chunkerProfileId: 'ast-chunker-v1',
        config: defaultChunkConfig,
      });

      expect(chunks.length).toBe(1);
      expect(chunks[0]!.hasCode).toBe(true);
      expect(chunks[0]!.content).toContain('```typescript');
      expect(chunks[0]!.content).toContain('const apiKey');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Atomicity Stress (Gate T-04)
  // ---------------------------------------------------------------------------
  describe('2. Atomicity Stress (Gate T-04)', () => {
    it('preserves code block atomicity when positioned directly at the 1400 token boundary', async () => {
      // Preamble paragraph: 1250 tokens
      const preamble = makeExactTokenParagraphs(1250, 1);
      // Code block: 300 tokens
      const codeBlock = makeExactTokenCodeBlock(300);

      const markdown = `${preamble}\n\n${codeBlock}`;

      const docId = computeDocumentId('test', '1.0', 'https://example.com/boundary-code');
      const hash = computeNormalizedHash({ title: 'Boundary', markdown, headings: [] });
      const snapId = computeSnapshotId(docId, 'norm', hash);

      const chunks = await chunker.chunk({
        document: {
          schemaVersion: 1,
          documentId: docId,
          snapshotId: snapId,
          libraryId: 'test',
          versionKey: '1.0',
          canonicalUrl: 'https://example.com/boundary-code',
          title: 'Boundary',
          markdown,
          headings: [],
          normalizedHash: hash,
          normalizerProfileId: 'norm',
        },
        chunkerProfileId: 'ast-chunker-v1',
        config: defaultChunkConfig,
      });

      // Total tokens = 1550 > 1400.
      // Chunk 0 must contain the preamble.
      // Chunk 1 must contain the COMPLETE code block intact without mid-code split.
      expect(chunks.length).toBe(2);
      expect(chunks[0]!.hasCode).toBe(false);
      expect(chunks[1]!.hasCode).toBe(true);

      const codeChunkContent = chunks[1]!.content;
      expect(codeChunkContent.startsWith('```')).toBe(true);
      expect(codeChunkContent.endsWith('```')).toBe(true);
      expect(tokenCounter.count(codeChunkContent)).toBe(300);
    });

    it('preserves table atomicity when positioned directly at the 1400 token boundary', async () => {
      // Preamble paragraph: 1250 tokens
      const preamble = makeExactTokenParagraphs(1250, 1);

      // Markdown table with 15 rows
      const tableRows: string[] = [];
      for (let i = 0; i < 15; i++) {
        tableRows.push(`| key_${i} | value_description_${i}_with_extra_data |`);
      }
      const table = `| Key | Description |\n| --- | --- |\n${tableRows.join('\n')}`;

      const markdown = `${preamble}\n\n${table}`;

      const docId = computeDocumentId('test', '1.0', 'https://example.com/boundary-table');
      const hash = computeNormalizedHash({ title: 'Boundary Table', markdown, headings: [] });
      const snapId = computeSnapshotId(docId, 'norm', hash);

      const chunks = await chunker.chunk({
        document: {
          schemaVersion: 1,
          documentId: docId,
          snapshotId: snapId,
          libraryId: 'test',
          versionKey: '1.0',
          canonicalUrl: 'https://example.com/boundary-table',
          title: 'Boundary Table',
          markdown,
          headings: [],
          normalizedHash: hash,
          normalizerProfileId: 'norm',
        },
        chunkerProfileId: 'ast-chunker-v1',
        config: defaultChunkConfig,
      });

      expect(chunks.length).toBe(2);
      expect(chunks[0]!.content).not.toContain('| Key | Description |');
      expect(chunks[1]!.content).toContain('| Key | Description |');
      expect(chunks[1]!.content).toContain('| --- | --- |');
      // Ensure all rows are in Chunk 1
      for (let i = 0; i < 15; i++) {
        expect(chunks[1]!.content).toContain(`| key_${i} |`);
      }
    });

    it('preserves back-to-back large atomic units without fragmentation', async () => {
      const code1 = makeExactTokenCodeBlock(500);
      const code2 = makeExactTokenCodeBlock(1000); // 500 + 1000 = 1500 > 1400
      const markdown = `${code1}\n\n${code2}`;

      const docId = computeDocumentId('test', '1.0', 'https://example.com/two-codes');
      const hash = computeNormalizedHash({ title: 'Two Codes', markdown, headings: [] });
      const snapId = computeSnapshotId(docId, 'norm', hash);

      const chunks = await chunker.chunk({
        document: {
          schemaVersion: 1,
          documentId: docId,
          snapshotId: snapId,
          libraryId: 'test',
          versionKey: '1.0',
          canonicalUrl: 'https://example.com/two-codes',
          title: 'Two Codes',
          markdown,
          headings: [],
          normalizedHash: hash,
          normalizerProfileId: 'norm',
        },
        chunkerProfileId: 'ast-chunker-v1',
        config: defaultChunkConfig,
      });

      expect(chunks.length).toBe(2);
      expect(chunks[0]!.hasCode).toBe(true);
      expect(chunks[0]!.oversized).toBe(false);
      expect(chunks[1]!.hasCode).toBe(true);
      expect(chunks[1]!.oversized).toBe(false);
      expect(chunks[0]!.content.endsWith('```')).toBe(true);
      expect(chunks[1]!.content.startsWith('```')).toBe(true);
    });

    // -------------------------------------------------------------------------
    // Empirical Vulnerability Probes: Nested Code/Table in Blockquotes
    // Gate T-04 states: "Code blocks and tables must be preserved as atomic units without mid-block fragmentation."
    // When a code block or table is inside a blockquote (> 1400 tokens), marked lexer
    // emits token.type = 'blockquote'. MarkdownAstChunker treats it as plain text and
    // invokes splitIntoSentences, slicing the code/table into non-atomic pieces!
    // -------------------------------------------------------------------------
    it('preserves code block atomicity when nested inside a blockquote exceeding 1400 tokens', async () => {
      const codeLines: string[] = [];
      for (let i = 0; i < 300; i++) {
        codeLines.push(`val_${i} = compute_metric(${i}).execute()`);
      }
      const md = `> Note: Code below\n>\n> \`\`\`python\n> ${codeLines.join('\n> ')}\n> \`\`\`\n`;

      const docId = computeDocumentId('test', '1.0', 'https://example.com/nested-code-large');
      const hash = computeNormalizedHash({ title: 'Nested Code', markdown: md, headings: [] });
      const snapId = computeSnapshotId(docId, 'norm', hash);

      const chunks = await chunker.chunk({
        document: {
          schemaVersion: 1,
          documentId: docId,
          snapshotId: snapId,
          libraryId: 'test',
          versionKey: '1.0',
          canonicalUrl: 'https://example.com/nested-code-large',
          title: 'Nested Code',
          markdown: md,
          headings: [],
          normalizedHash: hash,
          normalizerProfileId: 'norm',
        },
        chunkerProfileId: 'ast-chunker-v1',
        config: defaultChunkConfig,
      });

      // EXPECTATION: Code block must NOT be split mid-block into fragmented chunks
      // Currently FAILS because it gets split into 5 sentence chunks without code fences!
      expect(chunks.length).toBe(1);
      expect(chunks[0]!.oversized).toBe(true);
    });

    it('preserves table atomicity and headers when nested inside a blockquote exceeding 1400 tokens', async () => {
      const rows: string[] = [];
      for (let i = 0; i < 200; i++) {
        rows.push(`> | item_${i} | description for item number ${i} with explanation. |`);
      }
      const md = `> | Item | Description |\n> | --- | --- |\n${rows.join('\n')}\n`;

      const docId = computeDocumentId('test', '1.0', 'https://example.com/nested-table-large');
      const hash = computeNormalizedHash({ title: 'Nested Table', markdown: md, headings: [] });
      const snapId = computeSnapshotId(docId, 'norm', hash);

      const chunks = await chunker.chunk({
        document: {
          schemaVersion: 1,
          documentId: docId,
          snapshotId: snapId,
          libraryId: 'test',
          versionKey: '1.0',
          canonicalUrl: 'https://example.com/nested-table-large',
          title: 'Nested Table',
          markdown: md,
          headings: [],
          normalizedHash: hash,
          normalizerProfileId: 'norm',
        },
        chunkerProfileId: 'ast-chunker-v1',
        config: defaultChunkConfig,
      });

      // EXPECTATION: Table must NOT be split mid-table, losing its table header
      // Currently FAILS because it gets split into partial rows without headers!
      expect(chunks.length).toBe(1);
      expect(chunks[0]!.oversized).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Boundary Tests for Oversized Chunks (1399, 1401, 15999, 16001)
  // ---------------------------------------------------------------------------
  describe('3. Boundary Tests for Oversized Chunks', () => {
    it('chunks exactly 1399 tokens atomic block as oversized: false in 1 chunk', async () => {
      const code1399 = makeExactTokenCodeBlock(1399);
      expect(tokenCounter.count(code1399)).toBe(1399);

      const docId = computeDocumentId('test', '1.0', 'https://example.com/1399');
      const hash = computeNormalizedHash({ title: '1399', markdown: code1399, headings: [] });
      const snapId = computeSnapshotId(docId, 'norm', hash);

      const chunks = await chunker.chunk({
        document: {
          schemaVersion: 1,
          documentId: docId,
          snapshotId: snapId,
          libraryId: 'test',
          versionKey: '1.0',
          canonicalUrl: 'https://example.com/1399',
          title: '1399',
          markdown: code1399,
          headings: [],
          normalizedHash: hash,
          normalizerProfileId: 'norm',
        },
        chunkerProfileId: 'ast-chunker-v1',
        config: defaultChunkConfig,
      });

      expect(chunks.length).toBe(1);
      expect(chunks[0]!.tokenCount).toBe(1399);
      expect(chunks[0]!.oversized).toBe(false);
      expect(chunks[0]!.hasCode).toBe(true);
    });

    it('chunks exactly 1401 tokens atomic block as oversized: true in 1 chunk', async () => {
      const code1401 = makeExactTokenCodeBlock(1401);
      expect(tokenCounter.count(code1401)).toBe(1401);

      const docId = computeDocumentId('test', '1.0', 'https://example.com/1401');
      const hash = computeNormalizedHash({ title: '1401', markdown: code1401, headings: [] });
      const snapId = computeSnapshotId(docId, 'norm', hash);

      const chunks = await chunker.chunk({
        document: {
          schemaVersion: 1,
          documentId: docId,
          snapshotId: snapId,
          libraryId: 'test',
          versionKey: '1.0',
          canonicalUrl: 'https://example.com/1401',
          title: '1401',
          markdown: code1401,
          headings: [],
          normalizedHash: hash,
          normalizerProfileId: 'norm',
        },
        chunkerProfileId: 'ast-chunker-v1',
        config: defaultChunkConfig,
      });

      expect(chunks.length).toBe(1);
      expect(chunks[0]!.tokenCount).toBe(1401);
      expect(chunks[0]!.oversized).toBe(true);
      expect(chunks[0]!.hasCode).toBe(true);
    });

    it('chunks exactly 15,999 tokens atomic block as oversized: true in 1 chunk', async () => {
      const code15999 = makeExactTokenCodeBlock(15999);
      expect(tokenCounter.count(code15999)).toBe(15999);

      const docId = computeDocumentId('test', '1.0', 'https://example.com/15999');
      const hash = computeNormalizedHash({ title: '15999', markdown: code15999, headings: [] });
      const snapId = computeSnapshotId(docId, 'norm', hash);

      const chunks = await chunker.chunk({
        document: {
          schemaVersion: 1,
          documentId: docId,
          snapshotId: snapId,
          libraryId: 'test',
          versionKey: '1.0',
          canonicalUrl: 'https://example.com/15999',
          title: '15999',
          markdown: code15999,
          headings: [],
          normalizedHash: hash,
          normalizerProfileId: 'norm',
        },
        chunkerProfileId: 'ast-chunker-v1',
        config: defaultChunkConfig,
      });

      expect(chunks.length).toBe(1);
      expect(chunks[0]!.tokenCount).toBe(15999);
      expect(chunks[0]!.oversized).toBe(true);
      expect(chunks[0]!.hasCode).toBe(true);
    });

    it('throws DOCUMENT_TOO_LARGE for an atomic block of exactly 16,001 tokens', async () => {
      const code16001 = makeExactTokenCodeBlock(16001);
      expect(tokenCounter.count(code16001)).toBe(16001);

      const docId = computeDocumentId('test', '1.0', 'https://example.com/16001');
      const hash = computeNormalizedHash({ title: '16001', markdown: code16001, headings: [] });
      const snapId = computeSnapshotId(docId, 'norm', hash);

      await expect(
        chunker.chunk({
          document: {
            schemaVersion: 1,
            documentId: docId,
            snapshotId: snapId,
            libraryId: 'test',
            versionKey: '1.0',
            canonicalUrl: 'https://example.com/16001',
            title: '16001',
            markdown: code16001,
            headings: [],
            normalizedHash: hash,
            normalizerProfileId: 'norm',
          },
          chunkerProfileId: 'ast-chunker-v1',
          config: defaultChunkConfig,
        }),
      ).rejects.toThrowError(
        expect.objectContaining({
          code: 'DOCUMENT_TOO_LARGE',
        }),
      );
    });

    it('throws DOCUMENT_TOO_LARGE for a document exceeding 16,000 tokens even if composed of small paragraphs', async () => {
      const doc16001 = makeExactTokenParagraphs(16001, 30);
      expect(tokenCounter.count(doc16001)).toBe(16001);

      const docId = computeDocumentId('test', '1.0', 'https://example.com/doc-16001');
      const hash = computeNormalizedHash({ title: 'Doc 16001', markdown: doc16001, headings: [] });
      const snapId = computeSnapshotId(docId, 'norm', hash);

      await expect(
        chunker.chunk({
          document: {
            schemaVersion: 1,
            documentId: docId,
            snapshotId: snapId,
            libraryId: 'test',
            versionKey: '1.0',
            canonicalUrl: 'https://example.com/doc-16001',
            title: 'Doc 16001',
            markdown: doc16001,
            headings: [],
            normalizedHash: hash,
            normalizerProfileId: 'norm',
          },
          chunkerProfileId: 'ast-chunker-v1',
          config: defaultChunkConfig,
        }),
      ).rejects.toThrowError(
        expect.objectContaining({
          code: 'DOCUMENT_TOO_LARGE',
        }),
      );
    });

    it('chunks cleanly without error for a 15,999 token document composed of normal paragraphs', async () => {
      const doc15999 = makeExactTokenParagraphs(15999, 30);
      expect(tokenCounter.count(doc15999)).toBe(15999);

      const docId = computeDocumentId('test', '1.0', 'https://example.com/doc-15999');
      const hash = computeNormalizedHash({ title: 'Doc 15999', markdown: doc15999, headings: [] });
      const snapId = computeSnapshotId(docId, 'norm', hash);

      const chunks = await chunker.chunk({
        document: {
          schemaVersion: 1,
          documentId: docId,
          snapshotId: snapId,
          libraryId: 'test',
          versionKey: '1.0',
          canonicalUrl: 'https://example.com/doc-15999',
          title: 'Doc 15999',
          markdown: doc15999,
          headings: [],
          normalizedHash: hash,
          normalizerProfileId: 'norm',
        },
        chunkerProfileId: 'ast-chunker-v1',
        config: defaultChunkConfig,
      });

      expect(chunks.length).toBeGreaterThan(10);
      // All normal paragraphs should be chunked around targetTokens (800) and within maxTokens (1400)
      for (const chunk of chunks) {
        expect(chunk.tokenCount).toBeLessThanOrEqual(1400);
        expect(chunk.oversized).toBe(false);
      }
    });
  });
});
