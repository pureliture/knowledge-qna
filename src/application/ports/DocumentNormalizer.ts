/**
 * DocumentNormalizer Port
 * Normalizes raw HTML into structured Markdown AST payload.
 */

import type {
  ParserConfig,
  NormalizedDocument,
} from '../../domain/models/index.js';

export interface NormalizeInput {
  libraryId: string;
  versionKey: string;
  canonicalUrl: string;
  html: string;
  parserConfig: ParserConfig;
  normalizerProfileId: string;
}

export interface DocumentNormalizer {
  readonly profileId: string;
  normalize(input: NormalizeInput): Promise<NormalizedDocument>;
  normalizeMany?(input: NormalizeInput): Promise<NormalizedDocument[]>;
}
