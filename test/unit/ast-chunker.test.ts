import { describe, it, expect } from 'vitest';
import { MarkdownAstChunker } from '../../src/infrastructure/parsing/MarkdownAstChunker.js';
import { TiktokenCounter } from '../../src/infrastructure/tokens/TiktokenCounter.js';
import type { NormalizedDocument, ChunkingConfig } from '../../src/domain/models/index.js';
import { CliOperationError } from '../../src/domain/errors.js';
import { computeChunkId, sha256Hex } from '../../src/domain/identity.js';

describe('MarkdownAstChunker Unit Tests', () => {
  const tokenCounter = new TiktokenCounter();
  const chunker = new MarkdownAstChunker(tokenCounter, 'chunker-profile-v1');

  const defaultConfig: ChunkingConfig = {
    minTokens: 200,
    targetTokens: 800,
    maxTokens: 1400,
    maxAtomicTokens: 16000,
  };

  const createDoc = (markdown: string, headings: Array<{ level: number; text: string; anchor?: string }> = []): NormalizedDocument => ({
    schemaVersion: 1,
    documentId: 'doc-123',
    snapshotId: 'snap-456',
    libraryId: 'test-lib',
    versionKey: 'v1',
    canonicalUrl: 'https://docs.example.com/guide',
    title: 'Guide Title',
    markdown,
    headings,
    normalizedHash: 'hash-789',
    normalizerProfileId: 'norm-profile',
    metadata: {},
  });

  it('tracks heading hierarchy in headingPath across sections and subsections', async () => {
    const markdown = `
# Section 1

Content under section 1.

## Subsection 1.1

Content under subsection 1.1.

### Deep Topic

Deep topic content.

## Subsection 1.2

Content under subsection 1.2.

# Section 2

Content under section 2.
`;

    const headings = [
      { level: 1, text: 'Section 1', anchor: 'sec-1' },
      { level: 2, text: 'Subsection 1.1', anchor: 'sub-1-1' },
      { level: 3, text: 'Deep Topic', anchor: 'deep' },
      { level: 2, text: 'Subsection 1.2', anchor: 'sub-1-2' },
      { level: 1, text: 'Section 2', anchor: 'sec-2' },
    ];

    const chunks = await chunker.chunk({
      document: createDoc(markdown, headings),
      config: defaultConfig,
      chunkerProfileId: 'chunker-profile-v1',
    });

    expect(chunks.length).toBeGreaterThanOrEqual(4);

    // Check heading paths
    expect(chunks[0]!.headingPath).toEqual(['Section 1']);
    expect(chunks[0]!.anchor).toBe('sec-1');

    const sub11Chunk = chunks.find((c) => c.headingPath.includes('Subsection 1.1'));
    expect(sub11Chunk).toBeDefined();
    expect(sub11Chunk!.headingPath).toEqual(['Section 1', 'Subsection 1.1']);
    expect(sub11Chunk!.anchor).toBe('sub-1-1');

    const deepChunk = chunks.find((c) => c.headingPath.includes('Deep Topic'));
    expect(deepChunk).toBeDefined();
    expect(deepChunk!.headingPath).toEqual(['Section 1', 'Subsection 1.1', 'Deep Topic']);
    expect(deepChunk!.anchor).toBe('deep');

    const sub12Chunk = chunks.find((c) => c.headingPath.includes('Subsection 1.2'));
    expect(sub12Chunk).toBeDefined();
    expect(sub12Chunk!.headingPath).toEqual(['Section 1', 'Subsection 1.2']);

    const sec2Chunk = chunks.find((c) => c.headingPath[0] === 'Section 2');
    expect(sec2Chunk).toBeDefined();
    expect(sec2Chunk!.headingPath).toEqual(['Section 2']);
  });

  it('preserves code blocks as atomic units without fragmentation', async () => {
    // Generate a 40-line code block
    const codeLines = Array.from({ length: 40 }, (_, i) => `    val item_${i} = calculate(x + ${i})`).join('\n');
    const markdown = `
# Code Example

Here is the implementation:

\`\`\`kotlin
fun processBatch(x: Int): List<Result> {
${codeLines}
    return results
}
\`\`\`

End of section.
`;

    const chunks = await chunker.chunk({
      document: createDoc(markdown, [{ level: 1, text: 'Code Example', anchor: 'code' }]),
      config: defaultConfig,
      chunkerProfileId: 'chunker-profile-v1',
    });

    // Find chunk with code
    const codeChunk = chunks.find((c) => c.hasCode);
    expect(codeChunk).toBeDefined();
    expect(codeChunk!.content).toContain('```kotlin');
    expect(codeChunk!.content).toContain('fun processBatch(x: Int): List<Result> {');
    expect(codeChunk!.content).toContain('val item_0 = calculate(x + 0)');
    expect(codeChunk!.content).toContain('val item_39 = calculate(x + 39)');
    expect(codeChunk!.content).toContain('return results\n}\n```');
    expect(codeChunk!.oversized).toBe(false);
  });

  it('preserves tables as atomic units without fragmentation', async () => {
    // Generate a 50-row GFM table
    const tableHeader = '| ID | Name | Description | Status |\n|---|---|---|---|';
    const tableRows = Array.from({ length: 50 }, (_, i) => `| ${i} | Item ${i} | Detailed description of item ${i} with extra text | ACTIVE |`).join('\n');
    const markdown = `
# API Reference Table

Below is the exhaustive list of items:

${tableHeader}
${tableRows}

Following notes.
`;

    const chunks = await chunker.chunk({
      document: createDoc(markdown, [{ level: 1, text: 'API Reference Table', anchor: 'tbl' }]),
      config: defaultConfig,
      chunkerProfileId: 'chunker-profile-v1',
    });

    // Find table chunk
    const tableChunk = chunks.find((c) => c.content.includes('| ID | Name |'));
    expect(tableChunk).toBeDefined();
    // All 50 rows must remain in the same chunk
    expect(tableChunk!.content).toContain('| 0 | Item 0 |');
    expect(tableChunk!.content).toContain('| 49 | Item 49 |');
  });

  it('handles oversized atomic block (1400 - 16000 tokens) with oversized: true', async () => {
    // Generate an atomic code block that exceeds 1400 tokens (~2000 tokens)
    const longCodeLines = Array.from(
      { length: 400 },
      (_, i) => `    console.log("Processing message step ${i}: executing transaction verification pipeline with token check", payload_${i});`,
    ).join('\n');

    const markdown = `
# Oversized Block Section

Preceding text that forms a normal buffer.

\`\`\`typescript
function handleLargeTransaction(payload: TransactionData) {
${longCodeLines}
}
\`\`\`

Trailing text after oversized block.
`;

    const chunks = await chunker.chunk({
      document: createDoc(markdown, [{ level: 1, text: 'Oversized Block Section', anchor: 'over' }]),
      config: defaultConfig,
      chunkerProfileId: 'chunker-profile-v1',
    });

    const oversizedChunk = chunks.find((c) => c.oversized);
    expect(oversizedChunk).toBeDefined();
    expect(oversizedChunk!.tokenCount).toBeGreaterThan(1400);
    expect(oversizedChunk!.tokenCount).toBeLessThanOrEqual(16000);
    expect(oversizedChunk!.content).toContain('```typescript');
    expect(oversizedChunk!.content).toContain('function handleLargeTransaction');
    expect(oversizedChunk!.hasCode).toBe(true);
  });

  it('throws DOCUMENT_TOO_LARGE when atomic block exceeds 16,000 tokens', async () => {
    // Generate an atomic code block exceeding 16,000 tokens
    const massiveCodeLines = Array.from(
      { length: 3000 },
      (_, i) => `    const longVariableIdentifier_${i}: Record<string, unknown> = { key: "${i}", data: "very long repeated string content for token budget testing" };`,
    ).join('\n');

    const markdown = `
# Massive Block

\`\`\`typescript
${massiveCodeLines}
\`\`\`
`;

    await expect(
      chunker.chunk({
        document: createDoc(markdown),
        config: defaultConfig,
        chunkerProfileId: 'chunker-profile-v1',
      }),
    ).rejects.toThrowError(CliOperationError);

    try {
      await chunker.chunk({
        document: createDoc(markdown),
        config: defaultConfig,
        chunkerProfileId: 'chunker-profile-v1',
      });
    } catch (err: unknown) {
      const cliErr = err as CliOperationError;
      expect(cliErr.code).toBe('DOCUMENT_TOO_LARGE');
    }
  });

  it('throws DOCUMENT_TOO_LARGE when entire document exceeds 16,000 tokens', async () => {
    // Generate a massive text document
    const paragraphs = Array.from(
      { length: 600 },
      (_, i) => `Paragraph ${i}. This is a detailed documentation section explaining various architectural principles in modern distributed systems, including consensus protocols, replication logs, and failover mechanics.`,
    ).join('\n\n');

    const markdown = `# Massive Document\n\n${paragraphs}`;

    // Verify token count exceeds 16000
    const count = tokenCounter.count(markdown);
    expect(count).toBeGreaterThan(16000);

    await expect(
      chunker.chunk({
        document: createDoc(markdown),
        config: defaultConfig,
        chunkerProfileId: 'chunker-profile-v1',
      }),
    ).rejects.toThrowError(CliOperationError);
  });

  it('splits paragraphs larger than maxTokens on sentence boundaries', async () => {
    // Create a ~2000-token single paragraph with distinct sentences exceeding maxTokens (1400)
    const sentences = Array.from(
      { length: 120 },
      (_, i) => `Sentence number ${i} describes specific domain requirement ${i} for resilient token parsing and storage.`,
    ).join(' ');

    const markdown = `# Large Paragraph Section\n\n${sentences}`;

    const chunks = await chunker.chunk({
      document: createDoc(markdown),
      config: defaultConfig,
      chunkerProfileId: 'chunker-profile-v1',
    });

    // Paragraph should be split across multiple chunks
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.oversized).toBe(false);
      expect(chunk.tokenCount).toBeLessThanOrEqual(1400);
    }
  });

  it('calculates deterministic SHA-256 chunk identities and sequential chunkIndex', async () => {
    const markdown = `
# Section A

First chunk content here.

# Section B

Second chunk content here.
`;

    const doc = createDoc(markdown, [
      { level: 1, text: 'Section A', anchor: 'sec-a' },
      { level: 1, text: 'Section B', anchor: 'sec-b' },
    ]);

    const chunks1 = await chunker.chunk({
      document: doc,
      config: defaultConfig,
      chunkerProfileId: 'chunker-profile-v1',
    });

    const chunks2 = await chunker.chunk({
      document: doc,
      config: defaultConfig,
      chunkerProfileId: 'chunker-profile-v1',
    });

    expect(chunks1).toHaveLength(chunks2.length);

    for (let i = 0; i < chunks1.length; i++) {
      const c1 = chunks1[i]!;
      const c2 = chunks2[i]!;

      expect(c1.chunkIndex).toBe(i);
      expect(c1.chunkId).toBe(c2.chunkId);
      expect(c1.contentHash).toBe(c2.contentHash);
      expect(c1.contentHash).toBe(sha256Hex(c1.content));

      const expectedChunkId = computeChunkId(
        doc.snapshotId,
        'chunker-profile-v1',
        c1.chunkIndex,
        c1.headingPath,
        c1.content,
      );
      expect(c1.chunkId).toBe(expectedChunkId);
    }
  });

  it('accurately tokenizes multibyte Korean documentation content', async () => {
    const markdown = `
# 한국어 기술 문서 가이드

이 문서는 대규모 분산 환경에서 지식 검색 및 문서 컨텍스트 인출 시스템을 설계할 때 준수해야 하는 원칙을 다룹니다.

## 청킹 정책

AST 기반 청킹 엔진은 제목 계층 구조를 보존하며 코드 블록과 표를 원자적으로 유지합니다.
최대 토큰 한도를 초과하지 않도록 문장 경계에서 안전하게 분할됩니다.
`;

    const chunks = await chunker.chunk({
      document: createDoc(markdown, [
        { level: 1, text: '한국어 기술 문서 가이드' },
        { level: 2, text: '청킹 정책' },
      ]),
      config: defaultConfig,
      chunkerProfileId: 'chunker-profile-v1',
    });

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]!.content).toContain('한국어 기술 문서 가이드');
    expect(chunks[0]!.tokenCount).toBeGreaterThan(0);
  });
});
