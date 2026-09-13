import { describe, it, expect } from 'vitest';
import {
  escapeMarkdown,
  resolveOfficialUrl,
  mapCitation,
  formatHeadingLine,
  formatSourceIndexEntry,
  formatChunkHeader,
  type HydratedCandidate,
} from '../../src/application/retrieval/CitationMapper.js';
import type { DocumentChunk, NormalizedDocument } from '../../src/domain/models/index.js';

describe('CitationMapper (Gate T-11)', () => {
  describe('escapeMarkdown', () => {
    it('escapes markdown control characters properly', () => {
      const input = '[API] *Guide* <v1.0> & {Details} | #Header_1';
      const escaped = escapeMarkdown(input);
      expect(escaped).toBe('\\[API\\] \\*Guide\\* \\<v1\\.0\\> & \\{Details\\} \\| \\#Header\\_1');
    });

    it('handles empty and clean strings without alteration', () => {
      expect(escapeMarkdown('')).toBe('');
      expect(escapeMarkdown('Simple Title 123')).toBe('Simple Title 123');
    });
  });

  describe('resolveOfficialUrl', () => {
    const mockDoc: NormalizedDocument = {
      schemaVersion: 1,
      documentId: 'doc-1',
      snapshotId: 'snap-1',
      libraryId: 'lib',
      versionKey: 'v1',
      canonicalUrl: 'https://example.com/docs/pipeline',
      title: 'Pipeline Guide',
      markdown: '',
      headings: [
        { level: 1, text: 'Pipeline Guide', anchor: 'pipeline-guide' },
        { level: 2, text: 'Spark Execution', anchor: 'spark-execution' },
      ],
      normalizedHash: 'h1',
      normalizerProfileId: 'norm-1',
      metadata: {},
    };

    it('appends validated anchor if present in document headings', () => {
      const url = resolveOfficialUrl(mockDoc.canonicalUrl, 'spark-execution', mockDoc);
      expect(url).toBe('https://example.com/docs/pipeline#spark-execution');
    });

    it('strips leading hash from anchor when appending', () => {
      const url = resolveOfficialUrl(mockDoc.canonicalUrl, '#spark-execution', mockDoc);
      expect(url).toBe('https://example.com/docs/pipeline#spark-execution');
    });

    it('returns pure canonicalUrl if anchor is NOT verified in document headings', () => {
      const url = resolveOfficialUrl(mockDoc.canonicalUrl, 'non-existent-anchor', mockDoc);
      expect(url).toBe('https://example.com/docs/pipeline');
    });

    it('returns pure canonicalUrl if anchor is omitted or empty', () => {
      expect(resolveOfficialUrl(mockDoc.canonicalUrl, undefined, mockDoc)).toBe(
        'https://example.com/docs/pipeline',
      );
      expect(resolveOfficialUrl(mockDoc.canonicalUrl, '', mockDoc)).toBe(
        'https://example.com/docs/pipeline',
      );
    });
  });

  describe('mapCitation', () => {
    it('maps candidate to S1 with verified anchor and preserved metadata', () => {
      const chunk: DocumentChunk = {
        schemaVersion: 1,
        chunkId: 'chunk-123',
        documentId: 'doc-123',
        snapshotId: 'snap-123',
        libraryId: 'lib-1',
        versionKey: 'v1',
        chunkerProfileId: 'prof-1',
        title: 'Transforms in Foundry',
        headingPath: ['Batch', 'Python Transforms'],
        anchor: 'python-transforms',
        content: 'def my_transform(): pass',
        chunkIndex: 0,
        hasCode: true,
        oversized: false,
        tokenCount: 40,
        contentHash: 'hash-abc',
      };

      const doc: NormalizedDocument = {
        schemaVersion: 1,
        documentId: 'doc-123',
        snapshotId: 'snap-123',
        libraryId: 'lib-1',
        versionKey: 'v1',
        canonicalUrl: 'https://example.com/docs/transforms',
        title: 'Transforms in Foundry',
        markdown: '',
        headings: [{ level: 2, text: 'Python Transforms', anchor: 'python-transforms' }],
        normalizedHash: 'nh-123',
        normalizerProfileId: 'norm-1',
        metadata: {},
      };

      const candidate: HydratedCandidate = {
        chunk,
        document: doc,
        lastCheckedAt: '2026-09-13T12:00:00.000Z',
        rank: 1,
      };

      const sourceRef = mapCitation(candidate, 0);

      expect(sourceRef.id).toBe('S1');
      expect(sourceRef.chunkId).toBe('chunk-123');
      expect(sourceRef.title).toBe('Transforms in Foundry');
      expect(sourceRef.url).toBe('https://example.com/docs/transforms#python-transforms');
      expect(sourceRef.headingPath).toEqual(['Batch', 'Python Transforms']);
      expect(sourceRef.lastCheckedAt).toBe('2026-09-13T12:00:00.000Z');
    });

    it('assigns S2 for index 1', () => {
      const candidate: HydratedCandidate = {
        chunk: {
          schemaVersion: 1,
          chunkId: 'chunk-2',
          documentId: 'doc-2',
          snapshotId: 'snap-2',
          libraryId: 'lib-1',
          versionKey: 'v1',
          chunkerProfileId: 'prof-1',
          title: 'Second Chunk',
          headingPath: [],
          content: 'Sample text',
          chunkIndex: 1,
          hasCode: false,
          oversized: false,
          tokenCount: 10,
          contentHash: 'hash-2',
        },
        document: null,
        lastCheckedAt: '2026-09-13T12:00:00.000Z',
        rank: 2,
      };

      const sourceRef = mapCitation(candidate, 1);
      expect(sourceRef.id).toBe('S2');
    });
  });

  describe('formatting helpers', () => {
    it('formats heading line with escaped characters', () => {
      const line = formatHeadingLine('[Foundry] *Guide*', ['Core_Concepts', 'API <v2>']);
      expect(line).toBe('\\[Foundry\\] \\*Guide\\* > Core\\_Concepts > API \\<v2\\>');
    });

    it('formats source index entry and chunk header', () => {
      const source = {
        id: 'S1',
        chunkId: 'c1',
        documentId: 'd1',
        snapshotId: 's1',
        title: 'Title',
        url: 'https://example.com',
        headingPath: ['Heading'],
        lastCheckedAt: '2026-09-13T00:00:00Z',
      };

      expect(formatSourceIndexEntry(source)).toBe(
        '- [S1] Title > Heading (https://example.com)',
      );
      expect(formatChunkHeader(source)).toBe(
        '### [S1] Title > Heading\n**Source**: https://example.com',
      );
    });
  });
});
