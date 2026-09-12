/**
 * DocumentChunker Port
 * Chunks NormalizedDocument into atomic AST chunks adhering to token and code/table boundaries.
 */

import type {
  NormalizedDocument,
  DocumentChunk,
  ChunkingConfig,
} from '../../domain/models/index.js';

export interface ChunkerInput {
  document: NormalizedDocument;
  config: ChunkingConfig;
  chunkerProfileId: string;
}

export interface DocumentChunker {
  readonly profileId: string;
  chunk(input: ChunkerInput): Promise<DocumentChunk[]>;
}
