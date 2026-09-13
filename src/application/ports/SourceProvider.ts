/**
 * SourceProvider Port
 * Discovers URL candidates from sitemaps or static URL lists.
 */

import type { VersionSource } from '../../domain/models/index.js';

export interface DiscoveredUrl {
  url: string;
  lastModified?: string;
  changeFreq?: string;
  priority?: number;
}

export interface DiscoverySummary {
  complete: boolean;
  totalDiscovered: number;
  sitemapsProcessed: number;
  depthReached: number;
  aborted: boolean;
  incompleteReason?:
    | 'DEPTH_LIMIT_EXCEEDED'
    | 'DOCUMENT_LIMIT_EXCEEDED'
    | 'SITEMAP_PARSE_ERROR'
    | 'ABORTED';
  errors?: Array<{ url: string; message: string }>;
}

export interface DiscoveryResult {
  urls: DiscoveredUrl[];
  summary: DiscoverySummary;
}

export interface SourceProvider {
  discover(source: VersionSource, signal?: AbortSignal): Promise<DiscoveryResult>;
}
