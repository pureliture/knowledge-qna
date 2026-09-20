/**
 * Library and Version Domain Models
 * Zero Node I/O, Zero External SDKs
 */

export interface VersionSource {
  type: 'sitemap' | 'static';
  sitemapUrls?: string[];
  urls?: string[];
  allowedHosts: string[];
  includePaths: string[];
  excludePaths?: string[];
  canonicalQueryKeys?: string[];
  collectionAllowed: boolean;
  allowHttp?: boolean;
}

export interface ParserConfig {
  contentSelectors: string[];
  removeSelectors: string[];
}

export interface ChunkingConfig {
  minTokens: number;
  targetTokens: number;
  maxTokens: number;
  maxAtomicTokens: number;
}

export interface FreshnessConfig {
  staleAfterHours: number;
}

export interface LibraryVersionConfig {
  versionKey: string;
  strategy?: 'rolling' | 'static';
  source: VersionSource;
  parser: ParserConfig;
  chunking: ChunkingConfig;
  freshness: FreshnessConfig;
  readinessQueries?: string[];
}

export interface LibraryDefinition {
  schemaVersion: 1;
  id: string;
  name: string;
  aliases?: string[];
  defaultVersionKey: string;
  versions: LibraryVersionConfig[];
}

export interface ResolvedLibrary {
  libraryId: string;
  name: string;
  versionKey: string;
  availableVersionKeys: string[];
}
