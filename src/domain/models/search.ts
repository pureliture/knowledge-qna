/**
 * Search and Context Result Domain Models
 * Zero Node I/O, Zero External SDKs
 */

export interface SourceRef {
  id: string;
  chunkId: string;
  documentId: string;
  snapshotId: string;
  title: string;
  url: string;
  headingPath: string[];
  lastCheckedAt: string;
}

export interface FreshnessInfo {
  publishedAt: string;
  oldestSourceCheckAt: string | null;
  stale: boolean;
  newerCorpusAvailable: boolean;
}

export interface ContextBudget {
  scope: 'context';
  tokenizerId: string;
  maxTokens: number;
  usedTokens: number;
  truncated: boolean;
  omittedChunkCount: number;
}

export interface ContextResult {
  status: 'ok' | 'no_matches';
  library: {
    id: string;
    versionKey: string;
  };
  query: string;
  generationId: string;
  corpusRevisionId: string;
  freshness: FreshnessInfo;
  context: string;
  sources: SourceRef[];
  budget: ContextBudget;
}

export interface SearchHit {
  indexEntryId: string;
  chunkId: string;
  documentId?: string;
  score?: number;
  rank: number;
}

export interface SearchFilter {
  language?: string;
  docType?: string;
}
