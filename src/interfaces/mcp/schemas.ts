/**
 * Zod Wire Schemas for MCP Public Tools & ToolEnvelope
 */

import { z } from 'zod';
import type { McpErrorCode, LibraryCandidate } from '../../domain/errors.js';

export const ErrorCodeSchema = z.enum([
  'LIBRARY_NOT_FOUND',
  'AMBIGUOUS_LIBRARY',
  'VERSION_NOT_FOUND',
  'CORPUS_NOT_READY',
  'INVALID_REQUEST',
  'TOKEN_BUDGET_EXCEEDED',
  'BACKEND_MISCONFIGURED',
  'INDEX_BACKEND_UNAVAILABLE',
  'SEARCH_FAILED',
  'INDEX_INCONSISTENT',
  'CORPUS_CORRUPT',
  'DEADLINE_EXCEEDED',
  'RESPONSE_TOO_LARGE',
]);

export interface ToolSuccessEnvelope<T> {
  schemaVersion: 1;
  ok: true;
  data: T;
}

export interface ToolErrorEnvelope {
  schemaVersion: 1;
  ok: false;
  error: {
    code: McpErrorCode;
    message: string;
    retryable: boolean;
    candidates?: LibraryCandidate[];
  };
}

export type ToolEnvelope<T> = ToolSuccessEnvelope<T> | ToolErrorEnvelope;

export function createSuccessEnvelope<T>(data: T): ToolSuccessEnvelope<T> {
  return {
    schemaVersion: 1,
    ok: true,
    data,
  };
}

export function createErrorEnvelope(
  code: McpErrorCode,
  message: string,
  retryable: boolean = false,
  candidates?: LibraryCandidate[],
): ToolErrorEnvelope {
  return {
    schemaVersion: 1,
    ok: false,
    error: {
      code,
      message,
      retryable,
      ...(candidates ? { candidates } : {}),
    },
  };
}

export const ResolveLibraryInputSchema = z.object({
  query: z
    .string()
    .min(1, 'query must be at least 1 character')
    .max(200, 'query must not exceed 200 characters')
    .describe('Library name, alias, or keyword to resolve'),
});

export const GetContextInputSchema = z.object({
  libraryId: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'libraryId must match ^[a-z0-9][a-z0-9._-]{0,63}$')
    .describe('Registered library ID'),
  query: z
    .string()
    .min(1, 'query must be at least 1 character')
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
});
