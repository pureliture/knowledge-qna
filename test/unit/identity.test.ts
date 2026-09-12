/**
 * Unit tests for Domain Identity and Hashing
 */

import { describe, it, expect } from 'vitest';
import {
  toCanonicalJson,
  sha256Hex,
  canonicalHash,
  base32Encode,
  computeDocumentId,
  computeSnapshotId,
  computeChunkId,
  computeCorpusRevisionId,
  computeGenerationId,
  computeIndexEntryId,
} from '../../src/domain/identity.js';

describe('Domain Identity & Canonical Hashing', () => {
  describe('toCanonicalJson', () => {
    it('recursively sorts object keys lexicographically', () => {
      const obj1 = { z: 1, a: 2, m: { b: 3, a: 4 } };
      const obj2 = { a: 2, m: { a: 4, b: 3 }, z: 1 };
      expect(toCanonicalJson(obj1)).toBe(toCanonicalJson(obj2));
      expect(toCanonicalJson(obj1)).toBe('{"a":2,"m":{"a":4,"b":3},"z":1}');
    });

    it('preserves array element order without sorting', () => {
      const arr = [3, 1, 2];
      expect(toCanonicalJson(arr)).toBe('[3,1,2]');
    });

    it('omits undefined properties from objects', () => {
      const obj = { a: 1, b: undefined, c: 3 };
      expect(toCanonicalJson(obj)).toBe('{"a":1,"c":3}');
    });

    it('rejects non-finite numbers', () => {
      expect(() => toCanonicalJson(NaN)).toThrow(TypeError);
      expect(() => toCanonicalJson(Infinity)).toThrow(TypeError);
      expect(() => toCanonicalJson(-Infinity)).toThrow(TypeError);
    });
  });

  describe('sha256Hex & canonicalHash', () => {
    it('produces 64-character lowercase hex strings', () => {
      const hash = sha256Hex('test content');
      expect(hash).toHaveLength(64);
      expect(/^[0-9a-f]{64}$/.test(hash)).toBe(true);
    });

    it('canonicalHash is deterministic for differently ordered equivalent objects', () => {
      const h1 = canonicalHash({ x: 10, y: [1, 2] });
      const h2 = canonicalHash({ y: [1, 2], x: 10 });
      expect(h1).toBe(h2);
    });
  });

  describe('RFC 4648 Base32 Encoding', () => {
    it('encodes 32-byte hashes into exactly 52 base32 characters', () => {
      const buffer = Buffer.alloc(32, 0xab);
      const encoded = base32Encode(buffer);
      expect(encoded).toHaveLength(52);
      expect(/^[a-z2-7]{52}$/.test(encoded)).toBe(true);
    });
  });

  describe('Deterministic ID computation', () => {
    it('computeDocumentId returns deterministic hex64', () => {
      const id1 = computeDocumentId('palantir-foundry', 'current', 'https://www.palantir.com/docs/foundry');
      const id2 = computeDocumentId('palantir-foundry', 'current', 'https://www.palantir.com/docs/foundry');
      expect(id1).toBe(id2);
      expect(id1).toHaveLength(64);
      expect(/^[0-9a-f]{64}$/.test(id1)).toBe(true);
    });

    it('computeSnapshotId returns deterministic hex64', () => {
      const snapId = computeSnapshotId('doc123', 'normalizer_v1', 'hash_abc');
      expect(snapId).toHaveLength(64);
      expect(/^[0-9a-f]{64}$/.test(snapId)).toBe(true);
    });

    it('computeChunkId returns deterministic hex64 sensitive to index and headingPath', () => {
      const c1 = computeChunkId('snap1', 'chunker_v1', 0, ['Overview'], 'content');
      const c2 = computeChunkId('snap1', 'chunker_v1', 1, ['Overview'], 'content');
      expect(c1).not.toBe(c2);
      expect(c1).toHaveLength(64);
    });

    it('computeCorpusRevisionId returns deterministic hex64', () => {
      const revId = computeCorpusRevisionId('palantir-foundry', 'current', 'cfgHash', []);
      expect(revId).toHaveLength(64);
    });

    it('computeGenerationId produces valid UUID v4', () => {
      const genId = computeGenerationId();
      expect(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(genId)).toBe(true);
    });

    it('computeIndexEntryId produces exactly 53 characters starting with "k"', () => {
      const entryId = computeIndexEntryId('12345678-1234-4234-8234-123456789abc', 'chunk123');
      expect(entryId).toHaveLength(53);
      expect(entryId.startsWith('k')).toBe(true);
      expect(/^k[a-z2-7]{52}$/.test(entryId)).toBe(true);
    });
  });
});
