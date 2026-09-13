/**
 * InMemorySearchAdapter
 * Complete in-memory search and index backend implementing SearchBackend and IndexBackend ports.
 * Features Okapi BM25 ranking (k1=1.2, b=0.75) with field weights (Title 3x, Heading 2x, Content 1x),
 * deterministic tie-breaking (score DESC, chunkId ASC), multi-tenant generation isolation,
 * and complete offline corpus reconstruction (Gate T-12).
 */

import type {
  SearchBackend,
  SearchQueryParams,
  SearchHit,
  BackendHealth,
} from '../../application/ports/SearchBackend.js';
import type {
  IndexBackend,
  IndexEntryPayload,
  ReadinessProbe,
  BatchImportResult,
} from '../../application/ports/IndexBackend.js';
import type { ReadinessResult } from '../../domain/models/index.js';

interface InvertedPosting {
  chunkId: string;
  tfTitle: number;
  tfHeading: number;
  tfContent: number;
  weightedTf: number;
}

interface GenerationStorage {
  generationId: string;
  libraryId: string;
  versionKey: string;
  state: 'staging' | 'ready' | 'published' | 'retired';
  entries: Map<string, IndexEntryPayload>; // chunkId -> IndexEntryPayload
  docLengths: Map<string, number>; // chunkId -> total token count
  totalTokens: number;
  avgDocLength: number;
  invertedIndex: Map<string, InvertedPosting[]>; // term -> postings
  createdAt: string;
}

function tokenize(text: string): string[] {
  if (!text) return [];
  const normalized = text.normalize('NFKC').toLowerCase();
  // Match alphanumeric words, identifiers, and Korean Hangul blocks
  const tokens = normalized.match(/[a-z0-9_]+|[\uac00-\ud7af]+/g);
  return tokens ?? [];
}

export class InMemorySearchAdapter implements SearchBackend, IndexBackend {
  private readonly backendKey: string;
  // Indexed by generationId
  private readonly generations = new Map<string, GenerationStorage>();

  constructor(backendKey: string = 'in-memory-search-adapter') {
    this.backendKey = backendKey;
  }

  getBackendKey(): string {
    return this.backendKey;
  }

  // ==========================================
  // IndexBackend Implementation
  // ==========================================

  async stageGeneration(generationId: string): Promise<void> {
    if (!this.generations.has(generationId)) {
      this.generations.set(generationId, {
        generationId,
        libraryId: '',
        versionKey: '',
        state: 'staging',
        entries: new Map(),
        docLengths: new Map(),
        totalTokens: 0,
        avgDocLength: 0,
        invertedIndex: new Map(),
        createdAt: new Date().toISOString(),
      });
    }
  }

  async importBatch(
    generationId: string,
    entries: IndexEntryPayload[],
  ): Promise<BatchImportResult> {
    let gen = this.generations.get(generationId);
    if (!gen) {
      await this.stageGeneration(generationId);
      gen = this.generations.get(generationId)!;
    }

    for (const entry of entries) {
      if (!gen.libraryId && entry.libraryId) {
        gen.libraryId = entry.libraryId;
        gen.versionKey = entry.versionKey;
      }

      // If entry already exists, remove previous stats before re-adding
      if (gen.entries.has(entry.chunkId)) {
        const prevLen = gen.docLengths.get(entry.chunkId) ?? 0;
        gen.totalTokens -= prevLen;
        gen.docLengths.delete(entry.chunkId);
        gen.entries.delete(entry.chunkId);

        // Clean from inverted index
        for (const [term, postings] of gen.invertedIndex.entries()) {
          const filtered = postings.filter((p) => p.chunkId !== entry.chunkId);
          if (filtered.length > 0) {
            gen.invertedIndex.set(term, filtered);
          } else {
            gen.invertedIndex.delete(term);
          }
        }
      }

      gen.entries.set(entry.chunkId, entry);

      // Tokenize fields
      const titleTokens = tokenize(entry.title);
      const headingTokens = tokenize(entry.headingPath.join(' '));
      const contentTokens = tokenize(entry.content);

      const docLen = titleTokens.length + headingTokens.length + contentTokens.length;
      gen.docLengths.set(entry.chunkId, docLen);
      gen.totalTokens += docLen;

      // Count term frequencies per field
      const titleTf = new Map<string, number>();
      for (const t of titleTokens) {
        titleTf.set(t, (titleTf.get(t) ?? 0) + 1);
      }

      const headingTf = new Map<string, number>();
      for (const t of headingTokens) {
        headingTf.set(t, (headingTf.get(t) ?? 0) + 1);
      }

      const contentTf = new Map<string, number>();
      for (const t of contentTokens) {
        contentTf.set(t, (contentTf.get(t) ?? 0) + 1);
      }

      // Combine unique terms in document
      const allDocTerms = new Set<string>([
        ...titleTf.keys(),
        ...headingTf.keys(),
        ...contentTf.keys(),
      ]);

      for (const term of allDocTerms) {
        const tfT = titleTf.get(term) ?? 0;
        const tfH = headingTf.get(term) ?? 0;
        const tfC = contentTf.get(term) ?? 0;
        const weightedTf = 3.0 * tfT + 2.0 * tfH + 1.0 * tfC;

        let postings = gen.invertedIndex.get(term);
        if (!postings) {
          postings = [];
          gen.invertedIndex.set(term, postings);
        }

        postings.push({
          chunkId: entry.chunkId,
          tfTitle: tfT,
          tfHeading: tfH,
          tfContent: tfC,
          weightedTf,
        });
      }
    }

    gen.avgDocLength = gen.entries.size > 0 ? gen.totalTokens / gen.entries.size : 0;

    return {
      importedCount: entries.length,
      failedIds: [],
    };
  }

  async verifyReadiness(
    generationId: string,
    expectedCount: number,
    probes: Array<ReadinessProbe | string>,
  ): Promise<ReadinessResult> {
    const gen = this.generations.get(generationId);
    if (!gen) {
      return {
        state: 'failed',
        expectedCount,
        indexedCount: 0,
        missingIds: [],
        failedProbeQueries: probes.map((p) => (typeof p === 'string' ? p : p.query)),
      };
    }

    const indexedCount = gen.entries.size;
    const failedProbeQueries: string[] = [];

    // Verify entry count
    if (indexedCount < expectedCount) {
      return {
        state: 'pending',
        expectedCount,
        indexedCount,
        missingIds: [],
        failedProbeQueries,
      };
    }

    // Execute probe queries
    for (const rawProbe of probes) {
      const probe: ReadinessProbe =
        typeof rawProbe === 'string'
          ? { query: rawProbe }
          : rawProbe;

      const hits = await this.search({
        libraryId: gen.libraryId,
        versionKey: gen.versionKey,
        generationId,
        query: probe.query,
        limit: 10,
      });

      if (hits.length === 0) {
        failedProbeQueries.push(probe.query);
      } else if (probe.expectedChunkIds && probe.expectedChunkIds.length > 0) {
        const found = hits.some((h) => probe.expectedChunkIds!.includes(h.chunkId));
        if (!found) {
          failedProbeQueries.push(probe.query);
        }
      }
    }

    if (failedProbeQueries.length > 0) {
      return {
        state: 'failed',
        expectedCount,
        indexedCount,
        missingIds: [],
        failedProbeQueries,
      };
    }

    gen.state = 'ready';
    return {
      state: 'ready',
      expectedCount,
      indexedCount,
      missingIds: [],
      failedProbeQueries: [],
    };
  }

  async publishGeneration(generationId: string): Promise<void> {
    const gen = this.generations.get(generationId);
    if (gen) {
      gen.state = 'published';
    }
  }

  async retireGeneration(generationId: string): Promise<void> {
    const gen = this.generations.get(generationId);
    if (gen) {
      gen.state = 'retired';
    }
  }

  async deleteGeneration(generationId: string): Promise<void> {
    this.generations.delete(generationId);
  }

  // ==========================================
  // SearchBackend Implementation
  // ==========================================

  async health(): Promise<BackendHealth> {
    return {
      status: 'ok',
      message: `In-memory search active with ${this.generations.size} generations.`,
    };
  }

  async search(params: SearchQueryParams): Promise<SearchHit[]> {
    const { libraryId, versionKey, generationId, query, limit = 20, filters } = params;

    const gen = this.generations.get(generationId);
    if (!gen) {
      return [];
    }

    // Strict multi-tenant isolation: verify libraryId and versionKey match generation
    if (gen.libraryId && gen.libraryId !== libraryId) {
      return [];
    }
    if (gen.versionKey && gen.versionKey !== versionKey) {
      return [];
    }

    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) {
      return [];
    }

    const N = gen.entries.size;
    if (N === 0) {
      return [];
    }

    const k1 = 1.2;
    const b = 0.75;
    const avgdl = gen.avgDocLength > 0 ? gen.avgDocLength : 1;

    // Accumulate scores per chunkId
    const scores = new Map<string, number>();

    // Deduplicate query terms to avoid over-counting identical terms
    const uniqueQueryTerms = Array.from(new Set(queryTokens));

    for (const term of uniqueQueryTerms) {
      const postings = gen.invertedIndex.get(term);
      if (!postings || postings.length === 0) {
        continue;
      }

      const nq = postings.length;
      // Standard Okapi BM25 non-negative IDF formulation
      const idf = Math.log(1 + (N - nq + 0.5) / (nq + 0.5));

      for (const posting of postings) {
        const docLen = gen.docLengths.get(posting.chunkId) ?? avgdl;
        const tfWeighted = posting.weightedTf;

        const num = tfWeighted * (k1 + 1);
        const den = tfWeighted + k1 * (1 - b + b * (docLen / avgdl));
        const termScore = idf * (num / den);

        scores.set(posting.chunkId, (scores.get(posting.chunkId) ?? 0) + termScore);
      }
    }

    if (scores.size === 0) {
      return [];
    }

    // Filter by metadata if requested
    const candidates: Array<{ chunkId: string; score: number; entry: IndexEntryPayload }> = [];

    for (const [chunkId, score] of scores.entries()) {
      if (score <= 0) continue;
      const entry = gen.entries.get(chunkId);
      if (!entry) continue;

      if (filters?.language && entry.language && entry.language !== filters.language) {
        continue;
      }
      if (filters?.docType && entry.docType && entry.docType !== filters.docType) {
        continue;
      }

      candidates.push({ chunkId, score, entry });
    }

    // Deterministic tie-breaking:
    // 1. score DESC (with small epsilon 1e-9 for floating point comparison)
    // 2. chunkId ASC (localeCompare for 100% reproducible tie-breaking)
    candidates.sort((a, b) => {
      const diff = b.score - a.score;
      if (Math.abs(diff) > 1e-9) {
        return diff;
      }
      return a.chunkId.localeCompare(b.chunkId);
    });

    // Take top hits according to limit (clamped 1 to 100)
    const effectiveLimit = Math.max(1, Math.min(limit, 100));
    const sliced = candidates.slice(0, effectiveLimit);

    return sliced.map((c, index) => {
      const entry = c.entry;
      return {
        indexEntryId: entry.indexEntryId,
        chunkId: entry.chunkId,
        documentId: entry.documentId,
        generationId: entry.generationId,
        libraryId: entry.libraryId,
        versionKey: entry.versionKey,
        rank: index + 1, // 1-based monotonic rank
        score: c.score,
        contentHash: entry.contentHash,
        snippet: this.generateSnippet(entry.content, uniqueQueryTerms),
        metadata: {
          title: entry.title,
          headingPath: entry.headingPath,
          canonicalUrl: entry.url,
          language: entry.language,
          docType: entry.docType,
          hasCode: entry.hasCode,
        },
      };
    });
  }

  private generateSnippet(content: string, queryTerms: string[]): string {
    if (!content) return '';

    const lower = content.toLowerCase();
    let firstPos = -1;

    for (const term of queryTerms) {
      const idx = lower.indexOf(term);
      if (idx !== -1 && (firstPos === -1 || idx < firstPos)) {
        firstPos = idx;
      }
    }

    if (firstPos === -1) {
      const sample = content.slice(0, 160).replace(/\s+/g, ' ').trim();
      return content.length > 160 ? `${sample}...` : sample;
    }

    const start = Math.max(0, firstPos - 60);
    const end = Math.min(content.length, firstPos + 100);
    let snippet = content.slice(start, end).replace(/\s+/g, ' ').trim();

    if (start > 0) snippet = `...${snippet}`;
    if (end < content.length) snippet = `${snippet}...`;

    return snippet;
  }
}
