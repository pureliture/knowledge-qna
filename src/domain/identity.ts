/**
 * Canonical Identity & Hashing Utilities
 * Strict Domain Layer: Zero Node I/O, Zero External SDKs (node:crypto permitted)
 */

import { createHash, randomUUID } from 'node:crypto';

const RFC4648_BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * Deterministically serializes a JS value to Canonical JSON string.
 * Rules:
 * 1. Object keys are recursively sorted in lexicographical order (Unicode code point).
 * 2. Arrays preserve exact element order.
 * 3. Non-finite numbers (NaN, Infinity) throw an error.
 * 4. Undefined object values are omitted.
 * 5. Whitespace is stripped (compact).
 */
export function toCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError(`Cannot serialize non-finite number in canonical JSON: ${value}`);
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return '[' + value.map((item) => toCanonicalJson(item)).join(',') + ']';
  }

  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const parts: string[] = [];

  for (const key of sortedKeys) {
    const val = obj[key];
    if (val !== undefined) {
      parts.push(`${JSON.stringify(key)}:${toCanonicalJson(val)}`);
    }
  }

  return '{' + parts.join(',') + '}';
}

/**
 * Computes SHA-256 digest of arbitrary UTF-8 string or Buffer.
 * Returns 64-character lowercase hex string.
 */
export function sha256Hex(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Computes SHA-256 of Canonical JSON serialization of any data structure.
 * Returns 64-character lowercase hex string.
 */
export function canonicalHash(data: unknown): string {
  const json = toCanonicalJson(data);
  return sha256Hex(json);
}

/**
 * Encodes a buffer/Uint8Array to lowercase RFC 4648 Base32 without padding.
 */
export function base32Encode(buffer: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i];
    if (byte === undefined) continue;
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += RFC4648_BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += RFC4648_BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

/**
 * Computes deterministic documentId: H([libraryId, versionKey, canonicalUrl])
 */
export function computeDocumentId(
  libraryId: string,
  versionKey: string,
  canonicalUrl: string,
): string {
  return canonicalHash([libraryId, versionKey, canonicalUrl]);
}

/**
 * Computes normalizedHash of document body and metadata (excluding HTTP headers/dates).
 */
export function computeNormalizedHash(docPayload: {
  title: string;
  markdown: string;
  headings: unknown[];
  metadata: Record<string, unknown>;
}): string {
  return canonicalHash({
    headings: docPayload.headings,
    markdown: docPayload.markdown,
    metadata: docPayload.metadata,
    title: docPayload.title,
  });
}

/**
 * Computes deterministic snapshotId: H([documentId, normalizerProfileId, normalizedHash])
 */
export function computeSnapshotId(
  documentId: string,
  normalizerProfileId: string,
  normalizedHash: string,
): string {
  return canonicalHash([documentId, normalizerProfileId, normalizedHash]);
}

/**
 * Computes deterministic chunkId: H([snapshotId, chunkerProfileId, chunkIndex, headingPath, content])
 */
export function computeChunkId(
  snapshotId: string,
  chunkerProfileId: string,
  chunkIndex: number,
  headingPath: string[],
  content: string,
): string {
  return canonicalHash([snapshotId, chunkerProfileId, chunkIndex, headingPath, content]);
}

/**
 * Computes deterministic corpusRevisionId: H([libraryId, versionKey, versionProfileHash, sortedDocRefs])
 */
export function computeCorpusRevisionId(
  libraryId: string,
  versionKey: string,
  versionProfileHash: string,
  sortedDocRefs: unknown[],
): string {
  return canonicalHash([libraryId, versionKey, versionProfileHash, sortedDocRefs]);
}

/**
 * Computes a new generationId: standard UUID v4 string
 */
export function computeGenerationId(): string {
  return randomUUID();
}

/**
 * Computes indexEntryId for search backend: "k" + base32(SHA-256([generationId, chunkId]))
 * Produces exactly 53 characters (1 'k' + 52 base32 chars).
 */
export function computeIndexEntryId(generationId: string, chunkId: string): string {
  const json = toCanonicalJson([generationId, chunkId]);
  const rawDigest = createHash('sha256').update(json, 'utf-8').digest();
  return 'k' + base32Encode(rawDigest);
}

/**
 * Computes backendKey identifying backend configuration
 */
export function computeBackendKey(
  provider: string,
  project: string,
  location: string,
  dataStore: string,
  servingConfig: string,
  schemaProfile: string,
): string {
  return canonicalHash([provider, project, location, dataStore, servingConfig, schemaProfile]);
}
