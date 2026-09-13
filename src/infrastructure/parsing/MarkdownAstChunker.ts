/**
 * MarkdownAstChunker
 * Infrastructure implementation of DocumentChunker port using marked.lexer and TokenCounter.
 * Preserves tables and code blocks atomically, handles oversized blocks up to 16,000 tokens,
 * and calculates deterministic SHA-256 identities.
 * Strict Layer Boundary: Infrastructure imports only domain and application/ports.
 */

import { marked, type Token } from 'marked';
import type {
  DocumentChunker,
  ChunkerInput,
} from '../../application/ports/DocumentChunker.js';
import type { TokenCounter } from '../../application/ports/TokenCounter.js';
import type {
  DocumentChunk,
  DocumentHeading,
} from '../../domain/models/index.js';
import { computeChunkId, sha256Hex } from '../../domain/identity.js';
import { CliOperationError } from '../../domain/errors.js';

interface HeadingEntry {
  depth: number;
  text: string;
  anchor?: string;
}

function hasAtomicChild(token: Token): boolean {
  if (token.type === 'table' || token.type === 'code') {
    return true;
  }
  if ('tokens' in token && Array.isArray(token.tokens)) {
    return token.tokens.some((child) => hasAtomicChild(child));
  }
  return false;
}

export class MarkdownAstChunker implements DocumentChunker {
  readonly profileId: string;
  private readonly tokenCounter: TokenCounter;

  constructor(tokenCounter: TokenCounter, profileId: string = 'ast-chunker-v1') {
    this.tokenCounter = tokenCounter;
    this.profileId = profileId;
  }

  async chunk(input: ChunkerInput): Promise<DocumentChunk[]> {
    const { document, config, chunkerProfileId } = input;
    const markdown = document.markdown.trim();

    if (!markdown) {
      return [];
    }

    // 1. Document-level size check
    const totalDocTokens = this.tokenCounter.count(markdown);
    if (totalDocTokens > config.maxAtomicTokens) {
      throw new CliOperationError({
        code: 'DOCUMENT_TOO_LARGE',
        message: `Document '${document.canonicalUrl}' token count (${totalDocTokens}) exceeds maxAtomicTokens (${config.maxAtomicTokens})`,
      });
    }

    // 2. Parse Markdown AST into tokens
    const tokens = marked.lexer(markdown);

    const chunks: DocumentChunk[] = [];
    let chunkIndex = 0;

    // Heading hierarchy state
    const headingStack: HeadingEntry[] = [];
    let headingSearchIdx = 0;

    const findAnchor = (level: number, text: string): string | undefined => {
      if (!document.headings || document.headings.length === 0) return undefined;
      const targetText = text.trim();

      // Search forward from last match index
      for (let i = headingSearchIdx; i < document.headings.length; i++) {
        const h = document.headings[i];
        if (h && h.level === level && h.text.trim() === targetText) {
          headingSearchIdx = i + 1;
          return h.anchor;
        }
      }
      // Fallback search from start
      for (let i = 0; i < document.headings.length; i++) {
        const h = document.headings[i];
        if (h && h.level === level && h.text.trim() === targetText) {
          return h.anchor;
        }
      }
      return undefined;
    };

    const getCurrentHeadingPath = (): string[] => {
      if (headingStack.length > 0) {
        return headingStack.map((h) => h.text);
      }
      return document.title ? [document.title] : ['Root'];
    };

    const getCurrentAnchor = (): string | undefined => {
      for (let i = headingStack.length - 1; i >= 0; i--) {
        const entry = headingStack[i];
        if (entry && entry.anchor) {
          return entry.anchor;
        }
      }
      return undefined;
    };

    // Buffer state for current chunk
    let bufferBlocks: string[] = [];
    let bufferTokens = 0;
    let bufferOnlyHeadings = true;
    let bufferHeadingPath = getCurrentHeadingPath();
    let bufferAnchor = getCurrentAnchor();

    const emitChunk = (
      content: string,
      oversized: boolean,
      headingPath: string[],
      anchor?: string,
    ): void => {
      const trimmed = content.trim();
      if (!trimmed) return;

      const tokenCount = this.tokenCounter.count(trimmed);
      const contentHash = sha256Hex(trimmed);
      const chunkId = computeChunkId(
        document.snapshotId,
        chunkerProfileId,
        chunkIndex,
        headingPath,
        trimmed,
      );

      chunks.push({
        schemaVersion: 1,
        chunkId,
        documentId: document.documentId,
        snapshotId: document.snapshotId,
        libraryId: document.libraryId,
        versionKey: document.versionKey,
        chunkerProfileId,
        title: document.title,
        headingPath,
        ...(anchor ? { anchor } : {}),
        content: trimmed,
        chunkIndex,
        hasCode: trimmed.includes('```'),
        oversized,
        tokenCount,
        contentHash,
      });

      chunkIndex++;
    };

    const flushBuffer = (): void => {
      if (bufferBlocks.length === 0) return;
      const content = bufferBlocks.join('\n\n').trim();
      if (content) {
        emitChunk(content, false, bufferHeadingPath, bufferAnchor);
      }
      bufferBlocks = [];
      bufferTokens = 0;
      bufferOnlyHeadings = true;
      bufferHeadingPath = getCurrentHeadingPath();
      bufferAnchor = getCurrentAnchor();
    };

    const splitIntoSentences = (text: string): string[] => {
      const parts = text.split(/(?<=[.?!])\s+/);
      const result: string[] = [];
      for (const p of parts) {
        const trimmed = p.trim();
        if (trimmed) result.push(trimmed);
      }
      if (result.length <= 1) {
        // Fallback to word splitting if no punctuation breaks
        const words = text.split(/\s+/);
        if (words.length <= 250) return [text];
        const sub: string[] = [];
        let cur: string[] = [];
        for (const w of words) {
          cur.push(w);
          if (cur.length >= 250) {
            sub.push(cur.join(' '));
            cur = [];
          }
        }
        if (cur.length > 0) sub.push(cur.join(' '));
        return sub;
      }
      return result;
    };

    for (const token of tokens) {
      if (token.type === 'space') {
        continue;
      }

      if (token.type === 'heading') {
        // A heading indicates a new section boundary
        // If current buffer already contains non-heading content, flush it
        if (!bufferOnlyHeadings && bufferBlocks.length > 0) {
          flushBuffer();
        }

        // Update heading hierarchy
        const depth = token.depth;
        const text = token.text.trim();
        const anchor = findAnchor(depth, text);

        while (
          headingStack.length > 0 &&
          headingStack[headingStack.length - 1]!.depth >= depth
        ) {
          headingStack.pop();
        }
        headingStack.push({ depth, text, ...(anchor ? { anchor } : {}) });

        const rawHeading = token.raw.trim();
        const headingTokens = this.tokenCounter.count(rawHeading);

        if (bufferBlocks.length === 0) {
          bufferHeadingPath = getCurrentHeadingPath();
          bufferAnchor = getCurrentAnchor();
        }

        bufferBlocks.push(rawHeading);
        bufferTokens += headingTokens;
        // bufferOnlyHeadings remains true since only headings are in buffer
        continue;
      }

      // Check atomic units: table, code blocks, and blockquotes containing them
      const isAtomicBlock =
        token.type === 'table' ||
        token.type === 'code' ||
        (token.type === 'blockquote' && hasAtomicChild(token));

      if (isAtomicBlock) {
        const rawContent = token.raw.trim();
        const blockTokens = this.tokenCounter.count(rawContent);

        // Check hard 16,000 token limit
        if (blockTokens > config.maxAtomicTokens) {
          throw new CliOperationError({
            code: 'DOCUMENT_TOO_LARGE',
            message: `Atomic ${token.type} block (${blockTokens} tokens) exceeds maxAtomicTokens (${config.maxAtomicTokens}) in '${document.canonicalUrl}'`,
          });
        }

        if (blockTokens > config.maxTokens) {
          // Oversized atomic block (1400 - 16000 tokens)
          if (!bufferOnlyHeadings && bufferBlocks.length > 0) {
            // Prior non-heading content exists: flush it first
            flushBuffer();
          }

          // If buffer contains leading headings for this block, combine them with the oversized block
          let chunkContent = rawContent;
          let chunkHeadingPath = getCurrentHeadingPath();
          let chunkAnchor = getCurrentAnchor();

          if (bufferBlocks.length > 0) {
            chunkHeadingPath = bufferHeadingPath;
            chunkAnchor = bufferAnchor;
            chunkContent = `${bufferBlocks.join('\n\n')}\n\n${rawContent}`;
          }

          bufferBlocks = [];
          bufferTokens = 0;
          bufferOnlyHeadings = true;
          bufferHeadingPath = getCurrentHeadingPath();
          bufferAnchor = getCurrentAnchor();

          emitChunk(chunkContent, true, chunkHeadingPath, chunkAnchor);
          continue;
        }

        // Standard atomic block (<= maxTokens)
        if (bufferBlocks.length === 0) {
          bufferHeadingPath = getCurrentHeadingPath();
          bufferAnchor = getCurrentAnchor();
        }

        if (bufferTokens + blockTokens > config.maxTokens && !bufferOnlyHeadings) {
          flushBuffer();
        }

        bufferBlocks.push(rawContent);
        bufferTokens += blockTokens;
        bufferOnlyHeadings = false;
        continue;
      }

      // Other content blocks: paragraph, list, blockquote, html, etc.
      const rawContent = token.raw.trim();
      if (!rawContent) continue;

      const blockTokens = this.tokenCounter.count(rawContent);

      if (blockTokens > config.maxTokens) {
        // Large paragraph/text block: split into smaller sentence units
        const sentences = splitIntoSentences(rawContent);
        for (const sentence of sentences) {
          const sentTokens = this.tokenCounter.count(sentence);

          if (bufferBlocks.length === 0) {
            bufferHeadingPath = getCurrentHeadingPath();
            bufferAnchor = getCurrentAnchor();
          }

          if (bufferTokens + sentTokens > config.maxTokens && !bufferOnlyHeadings) {
            flushBuffer();
          } else if (
            bufferTokens + sentTokens > config.targetTokens &&
            bufferTokens >= config.minTokens &&
            !bufferOnlyHeadings
          ) {
            flushBuffer();
          }

          bufferBlocks.push(sentence);
          bufferTokens += sentTokens;
          bufferOnlyHeadings = false;
        }
      } else {
        if (bufferBlocks.length === 0) {
          bufferHeadingPath = getCurrentHeadingPath();
          bufferAnchor = getCurrentAnchor();
        }

        if (bufferTokens + blockTokens > config.maxTokens && !bufferOnlyHeadings) {
          flushBuffer();
        } else if (
          bufferTokens + blockTokens > config.targetTokens &&
          bufferTokens >= config.minTokens &&
          !bufferOnlyHeadings
        ) {
          flushBuffer();
        }

        bufferBlocks.push(rawContent);
        bufferTokens += blockTokens;
        bufferOnlyHeadings = false;
      }
    }

    // Flush any remaining content in buffer
    if (bufferBlocks.length > 0) {
      flushBuffer();
    }

    return chunks;
  }
}
