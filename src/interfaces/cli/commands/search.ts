/**
 * CLI Command: docsctx search <libraryId> <query> [--version <key>] [--max-tokens <n>]
 * Runs retrieval and context packing pipeline, returning cited context.
 * Writes progress to stderr; writes clean ContextResult JSON to stdout.
 * Strict Layer Boundary: Interfaces imports only application and domain.
 */

import type { GetContextUseCase } from '../../../application/retrieval/get-context.js';
import { DomainError } from '../../../domain/errors.js';

export interface SearchCommandOptions {
  getContextUseCase: GetContextUseCase;
  libraryId: string;
  query: string;
  versionKey?: string;
  maxTokens?: number;
}

export async function runSearchCommand(options: SearchCommandOptions): Promise<number> {
  process.stderr.write(
    `[docsctx search] Searching library '${options.libraryId}'${
      options.versionKey ? ` (version: '${options.versionKey}')` : ''
    } for query '${options.query}'...\n`,
  );

  try {
    const result = await options.getContextUseCase.execute({
      libraryId: options.libraryId,
      query: options.query,
      versionKey: options.versionKey,
      maxTokens: options.maxTokens,
    });

    process.stderr.write(
      `[docsctx search] Complete: status=${result.status}, sources=${result.sources.length}, tokens=${result.budget.usedTokens}/${result.budget.maxTokens} (truncated=${result.budget.truncated})\n`,
    );

    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof DomainError ? ` [${err.code}]` : '';

    process.stderr.write(`[docsctx search] ERROR${code}: ${message}\n`);
    return 1;
  }
}
