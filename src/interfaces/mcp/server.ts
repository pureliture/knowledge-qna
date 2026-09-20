/**
 * Stdio MCP v2 Server Factory
 * Exposes exactly TWO tools: resolve_library and get_context.
 */

import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ResolveLibraryUseCase } from '../../application/library/resolve-library.js';
import type { GetContextUseCase } from '../../application/retrieval/get-context.js';
export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}
import { DomainError } from '../../domain/errors.js';
import {
  createSuccessEnvelope,
  createErrorEnvelope,
} from './schemas.js';

export interface McpServerOptions {
  resolveLibraryUseCase: ResolveLibraryUseCase;
  getContextUseCase: GetContextUseCase;
  logger?: Logger;
}

export function createKnowledgeQnaMcpServer(options: McpServerOptions): McpServer {
  const { resolveLibraryUseCase, getContextUseCase, logger } = options;

  const server = new McpServer({
    name: 'knowledge-qna-mcp',
    version: '0.1.0',
  });

  // Tool 1: resolve_library
  server.registerTool(
    'resolve_library',
    {
      title: 'Resolve Documentation Library',
      description:
        'Resolve a technical documentation library name or alias to registered library metadata and available versions. Pure deterministic local matching without LLM.',
      inputSchema: {
        query: z
          .string()
          .min(1, 'query must not be empty')
          .max(200, 'query must not exceed 200 characters')
          .describe('Library name, alias, or keyword to resolve'),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async (args: { query: string }) => {
      try {
        const resolved = await resolveLibraryUseCase.execute({ query: args.query });
        const envelope = createSuccessEnvelope(resolved);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(envelope) }],
          structuredContent: envelope as unknown as Record<string, unknown>,
        };
      } catch (err) {
        logger?.warn('resolve_library failed', { error: err instanceof Error ? err.message : String(err) });
        if (err instanceof DomainError) {
          const envelope = createErrorEnvelope(err.code, err.message, err.retryable, err.candidates);
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify(envelope) }],
            structuredContent: envelope as unknown as Record<string, unknown>,
          };
        }
        const envelope = createErrorEnvelope(
          'INVALID_REQUEST',
          err instanceof Error ? err.message : 'Unknown error during resolve_library',
          false,
        );
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify(envelope) }],
          structuredContent: envelope as unknown as Record<string, unknown>,
        };
      }
    },
  );

  // Tool 2: get_context
  server.registerTool(
    'get_context',
    {
      title: 'Get Documentation Context',
      description:
        'Retrieve version-aware, cited documentation context for a registered library within a token budget.',
      inputSchema: {
        libraryId: z
          .string()
          .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'libraryId must match ^[a-z0-9][a-z0-9._-]{0,63}$')
          .describe('Registered library ID'),
        query: z
          .string()
          .min(1, 'query must not be empty')
          .max(2000, 'query must not exceed 2000 characters')
          .describe('Search query text'),
        versionKey: z
          .string()
          .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'versionKey must match ^[a-z0-9][a-z0-9._-]{0,63}$')
          .optional()
          .describe('Library version key. Defaults to registry defaultVersionKey if omitted'),
        maxTokens: z
          .number()
          .int('maxTokens must be an integer')
          .min(256, 'maxTokens must be at least 256')
          .max(16000, 'maxTokens must not exceed 16000')
          .default(6000)
          .optional()
          .describe('Maximum token budget for the returned context string'),
        filters: z
          .object({
            language: z.string().optional().describe('BCP 47 language code'),
            docType: z.string().optional().describe('Document type filter'),
          })
          .optional()
          .describe('Optional retrieval filters'),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async (args: {
      libraryId: string;
      query: string;
      versionKey?: string;
      maxTokens?: number;
      filters?: { language?: string; docType?: string };
    }) => {
      try {
        const result = await getContextUseCase.execute({
          libraryId: args.libraryId,
          query: args.query,
          versionKey: args.versionKey,
          maxTokens: args.maxTokens,
          filters: args.filters,
        });
        const envelope = createSuccessEnvelope(result);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(envelope) }],
          structuredContent: envelope as unknown as Record<string, unknown>,
        };
      } catch (err) {
        logger?.warn('get_context failed', { error: err instanceof Error ? err.message : String(err) });
        if (err instanceof DomainError) {
          const envelope = createErrorEnvelope(err.code, err.message, err.retryable, err.candidates);
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify(envelope) }],
            structuredContent: envelope as unknown as Record<string, unknown>,
          };
        }
        const envelope = createErrorEnvelope(
          'SEARCH_FAILED',
          err instanceof Error ? err.message : 'Unknown error during get_context',
          false,
        );
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify(envelope) }],
          structuredContent: envelope as unknown as Record<string, unknown>,
        };
      }
    },
  );

  return server;
}
