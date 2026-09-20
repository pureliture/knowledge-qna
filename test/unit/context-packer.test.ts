import { describe, it, expect } from 'vitest';
import { ContextPacker } from '../../src/application/retrieval/ContextPacker.js';
import { TiktokenCounter } from '../../src/infrastructure/tokens/TiktokenCounter.js';
import type { HydratedCandidate } from '../../src/application/retrieval/CitationMapper.js';
import type { DocumentChunk, NormalizedDocument } from '../../src/domain/models/index.js';
import { InvalidRequestError, TokenBudgetExceededError } from '../../src/domain/errors.js';

describe('ContextPacker (Gate T-11)', () => {
  const tokenCounter = new TiktokenCounter();
  const packer = new ContextPacker(tokenCounter);

  function createCandidate(id: string, content: string, title = 'Sample Title'): HydratedCandidate {
    const chunk: DocumentChunk = {
      schemaVersion: 1,
      chunkId: `chunk-${id}`,
      documentId: `doc-${id}`,
      snapshotId: `snap-${id}`,
      libraryId: 'lib-1',
      versionKey: 'v1',
      chunkerProfileId: 'prof-1',
      title,
      headingPath: ['Section 1'],
      content,
      chunkIndex: 0,
      hasCode: false,
      oversized: false,
      tokenCount: tokenCounter.count(content),
      contentHash: `hash-${id}`,
    };

    const document: NormalizedDocument = {
      schemaVersion: 1,
      documentId: `doc-${id}`,
      snapshotId: `snap-${id}`,
      libraryId: 'lib-1',
      versionKey: 'v1',
      canonicalUrl: `https://example.com/docs/${id}`,
      title,
      markdown: content,
      headings: [],
      normalizedHash: `nh-${id}`,
      normalizerProfileId: 'norm-1',
      metadata: {},
    };

    return {
      chunk,
      document,
      lastCheckedAt: '2026-09-13T10:00:00.000Z',
      rank: 1,
    };
  }

  describe('validateMaxTokens', () => {
    it('defaults to 6000 when maxTokens is omitted', () => {
      expect(packer.validateMaxTokens(undefined)).toBe(6000);
    });

    it('accepts valid integers within range 256 to 16000', () => {
      expect(packer.validateMaxTokens(256)).toBe(256);
      expect(packer.validateMaxTokens(16000)).toBe(16000);
      expect(packer.validateMaxTokens(1000)).toBe(1000);
    });

    it('throws InvalidRequestError when out of bounds or non-integer', () => {
      expect(() => packer.validateMaxTokens(255)).toThrow(InvalidRequestError);
      expect(() => packer.validateMaxTokens(16001)).toThrow(InvalidRequestError);
      expect(() => packer.validateMaxTokens(500.5)).toThrow(InvalidRequestError);
      expect(() => packer.validateMaxTokens(NaN)).toThrow(InvalidRequestError);
    });
  });

  describe('pack execution', () => {
    it('returns status: no_matches when candidate list is empty', () => {
      const result = packer.pack([], 6000);
      expect(result.status).toBe('no_matches');
      expect(result.context).toBe('');
      expect(result.sources).toEqual([]);
      expect(result.usedTokens).toBe(0);
      expect(result.truncated).toBe(false);
      expect(result.omittedChunkCount).toBe(0);
    });

    it('assembles complete context with Preamble, ## Sources, and --- chunk blocks', () => {
      const candidate1 = createCandidate('1', 'Content of first chunk.');
      const candidate2 = createCandidate('2', 'Content of second chunk.');

      const result = packer.pack([candidate1, candidate2], 6000);

      expect(result.status).toBe('ok');
      expect(result.sources.length).toBe(2);
      expect(result.sources[0]!.id).toBe('S1');
      expect(result.sources[1]!.id).toBe('S2');

      // Verify Markdown structure
      expect(result.context).toContain('# Documentation Context');
      expect(result.context).toContain('Excerpts are reference data for citations');
      expect(result.context).toContain('## Sources');
      expect(result.context).toContain('- [S1] Sample Title > Section 1 (https://example.com/docs/1)');
      expect(result.context).toContain('- [S2] Sample Title > Section 1 (https://example.com/docs/2)');
      expect(result.context).toContain('### [S1] Sample Title > Section 1');
      expect(result.context).toContain('### [S2] Sample Title > Section 1');
      expect(result.context).toContain('Content of first chunk.');
      expect(result.context).toContain('Content of second chunk.');

      // Verify atomic usedTokens equals token count of entire assembled text
      expect(result.usedTokens).toBe(tokenCounter.count(result.context));
      expect(result.truncated).toBe(false);
      expect(result.omittedChunkCount).toBe(0);
    });

    it('atomically omits chunks exceeding budget without slicing them mid-content', () => {
      const smallCandidate1 = createCandidate('1', 'Small chunk 1.');
      // Large content that pushes beyond a tight budget
      const largeCandidate2 = createCandidate('2', 'Large chunk repeating content. '.repeat(100));

      // Tight budget allowing candidate 1 with headers (~100 tokens), but not candidate 2
      const result = packer.pack([smallCandidate1, largeCandidate2], 300);

      expect(result.status).toBe('ok');
      expect(result.sources.length).toBe(1);
      expect(result.sources[0]!.id).toBe('S1');
      expect(result.context).toContain('Small chunk 1.');
      expect(result.context).not.toContain('Large chunk repeating');
      expect(result.truncated).toBe(true);
      expect(result.omittedChunkCount).toBe(1);
      expect(result.usedTokens).toBeLessThanOrEqual(300);
    });

    it('throws TokenBudgetExceededError if top-1 chunk cannot fit within maxTokens', () => {
      const veryLargeCandidate = createCandidate('oversized', 'Massive document text. '.repeat(300));

      // Budget is 256 tokens, candidate + preamble requires ~1000 tokens
      expect(() => packer.pack([veryLargeCandidate], 256)).toThrow(TokenBudgetExceededError);
    });

    it('safely handles text containing special tokens like <|endoftext|>', () => {
      const specialCandidate = createCandidate(
        'special',
        'Special token example: <|endoftext|> in LLM training text.',
      );

      const result = packer.pack([specialCandidate], 1000);
      expect(result.status).toBe('ok');
      expect(result.context).toContain('<|endoftext|>');
    });
  });
});
