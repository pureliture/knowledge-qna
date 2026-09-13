/**
 * CLI Command: docsctx sync <libraryId> [--version <key>]
 * Runs incremental discovery, fetch, normalization, chunking, and stores immutable revision.
 * Writes progress and diagnostic logs exclusively to stderr; writes clean JSON summary to stdout.
 * Strict Layer Boundary: Interfaces imports only application and domain.
 */

import type { SyncUseCase } from '../../../application/sync/SyncUseCase.js';
import { CliOperationError } from '../../../domain/errors.js';

export interface SyncCommandOptions {
  syncUseCase: SyncUseCase;
  libraryId: string;
  versionKey?: string;
}

export async function runSyncCommand(options: SyncCommandOptions): Promise<number> {
  process.stderr.write(
    `[docsctx sync] Starting sync for library '${options.libraryId}'${
      options.versionKey ? ` (version: '${options.versionKey}')` : ''
    }...\n`,
  );

  try {
    const result = await options.syncUseCase.execute({
      libraryId: options.libraryId,
      versionKey: options.versionKey,
    });

    process.stderr.write(
      `[docsctx sync] Completed successfully! Revision: ${result.corpusRevisionId} (discovered: ${result.discoveredCount}, fetched: ${result.fetchedCount}, stored: ${result.storedCount}, unchanged: ${result.unchangedCount}, deleted: ${result.deletedCount})\n`,
    );

    // JSON summary output to stdout
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const exitCode = err instanceof CliOperationError ? err.exitCode : 1;

    process.stderr.write(`[docsctx sync] ERROR: ${message}\n`);
    return exitCode;
  }
}
