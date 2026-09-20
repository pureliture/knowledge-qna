/**
 * CLI Command: docsctx gc [libraryId] [--version <key>] [--apply] [--min-age-hours <n>]
 * Cleans up eligible retired or abandoned index generations.
 * Default is dry-run mode; requires --apply for physical deletion.
 * Writes progress and diagnostic logs to stderr; writes clean JSON to stdout.
 * Strict Layer Boundary: Interfaces imports only application and domain.
 */

import type { GarbageCollectionUseCase } from '../../../application/indexing/GarbageCollectionUseCase.js';
import { CliOperationError, DomainError } from '../../../domain/errors.js';

export interface GcCommandOptions {
  gcUseCase: GarbageCollectionUseCase;
  libraryId?: string;
  versionKey?: string;
  apply?: boolean;
  minAgeHours?: number;
}

export async function runGcCommand(options: GcCommandOptions): Promise<number> {
  const isApply = Boolean(options.apply);
  const minAgeHours = options.minAgeHours ?? 24;

  process.stderr.write(
    `[docsctx gc] Starting garbage collection${
      options.libraryId ? ` for library '${options.libraryId}'` : ' across all libraries'
    }${options.versionKey ? ` (version: '${options.versionKey}')` : ''} [mode: ${
      isApply ? 'APPLY' : 'DRY-RUN'
    }, minAgeHours: ${minAgeHours}]...\n`,
  );

  try {
    const result = await options.gcUseCase.execute({
      libraryId: options.libraryId,
      versionKey: options.versionKey,
      apply: isApply,
      minAgeHours,
    });

    if (result.dryRun) {
      process.stderr.write(
        `[docsctx gc] Dry-run plan: ${result.eligibleGenerations.length} eligible generation(s) found across ${result.scannedGenerations} scanned. Use --apply to delete.\n`,
      );
    } else {
      process.stderr.write(
        `[docsctx gc] Applied deletion: ${result.deletedGenerations.length} generation(s) deleted (${result.deletedEntriesCount} entries). Failed: ${result.failedGenerations.length}.\n`,
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

    process.stderr.write(`[docsctx gc] ERROR${code}: ${message}\n`);
    return exitCode;
  }
}
