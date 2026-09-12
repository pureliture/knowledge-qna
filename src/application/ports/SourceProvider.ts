/**
 * SourceProvider Port
 * Discovers URL candidates from sitemaps or static URL lists.
 */

import type { VersionSource } from '../../domain/models/index.js';

export interface DiscoveredUrl {
  url: string;
  lastModified?: string;
}

export interface SourceProvider {
  discover(source: VersionSource): Promise<DiscoveredUrl[]>;
}
