/**
 * CLI Command: docsctx index <libraryId> [--version <key>] [--plan] [--rebuild] [--wait-seconds <n>]
 * Indexes a complete local corpus revision into the search backend and updates published pointer.
 * Writes progress to stderr; writes clean IndexResult JSON to stdout.
 * Strict Layer Boundary: Interfaces imports only application and domain.
 */

import type { IndexUseCase } from '../../../application/indexing/IndexUseCase.js';
import { CliOperationError, DomainError } from '../../../domain/errors.js';

export interface IndexCommandOptions {
  indexUseCase: IndexUseCase;
  libraryId: string;
  versionKey?: string;
  plan?: boolean;
  rebuild?: boolean;
  waitSeconds?: number;
}

export async function runIndexCommand(options: IndexCommandOptions): Promise<number> {
  process.stderr.write(
    `[docsctx index] Starting index for library '${options.libraryId}'${
      options.versionKey ? ` (version: '${options.versionKey}')` : ''
    }${options.plan ? ' (plan mode)' : ''}...\n`,
  );

  try {
    const result = await options.indexUseCase.execute({
      libraryId: options.libraryId,
      versionKey: options.versionKey,
      plan: options.plan,
      rebuild: options.rebuild,
      waitSeconds: options.waitSeconds,
    });

    if (options.plan) {
      process.stderr.write(
        `[docsctx index] Plan calculated: ${result.entryCount} entries across ${result.plan?.batchCount} batches for revision ${result.corpusRevisionId}.\n`,
      );
    } else if (result.alreadyIndexed) {
      process.stderr.write(
        `[docsctx index] Revision ${result.corpusRevisionId} is already published (generation: ${result.generationId}).\n`,
      );
    } else {
      process.stderr.write(
        `[docsctx index] Successfully published generation ${result.generationId} with ${result.entryCount} entries for revision ${result.corpusRevisionId}.\n`,
      );
    }

    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const exitCode = err instanceof CliOperationError ? err.exitCode : 1;
    const code =
      err instanceof CliOperationError
        ? ` [${err.code}]`
        : err instanceof DomainError
          ? ` [${err.code}]`
          : '';

    process.stderr.write(`[docsctx index] ERROR${code}: ${message}\n`);
    return exitCode;
  }
}
