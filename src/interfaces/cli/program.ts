/**
 * Commander Program Definition for docsctx CLI
 * Strict Layer Boundary: Interfaces imports only application and domain.
 */

import { Command } from 'commander';
import type { McpServer } from '@modelcontextprotocol/server';
import type { LibraryRegistry } from '../../application/ports/LibraryRegistry.js';
import type { ManifestStore } from '../../application/ports/ManifestStore.js';
import type { SyncUseCase } from '../../application/sync/SyncUseCase.js';
import type { GetContextUseCase } from '../../application/retrieval/get-context.js';
import type { IndexUseCase } from '../../application/indexing/IndexUseCase.js';
import { runServeCommand } from './commands/serve.js';
import { runDoctorCommand } from './commands/doctor.js';
import { runSyncCommand } from './commands/sync.js';
import { runSearchCommand } from './commands/search.js';
import { runIndexCommand } from './commands/index.js';

export interface CliDependencies {
  mcpServer: McpServer;
  libraryRegistry: LibraryRegistry;
  manifestStore?: ManifestStore;
  syncUseCase?: SyncUseCase;
  getContextUseCase?: GetContextUseCase;
  indexUseCase?: IndexUseCase;
  varRoot: string;
  configDir: string;
}

export function buildCliProgram(getDeps: () => CliDependencies): Command {
  const program = new Command();

  program
    .name('docsctx')
    .description('Host-local stdio Model Context Protocol (MCP) server for cited documentation retrieval')
    .version('0.1.0');

  program
    .option('-c, --config <path>', 'Path to library configuration directory')
    .option('-v, --var-root <path>', 'Path to var directory for manifests and corpus');

  program
    .command('serve')
    .description('Start the host-local stdio MCP v2 server')
    .action(async () => {
      const deps = getDeps();
      await runServeCommand({ mcpServer: deps.mcpServer });
    });

  program
    .command('sync <libraryId>')
    .description('Run incremental discovery, fetch, normalize, chunk, and create local corpus revision')
    .option('--version <key>', 'Version key to sync (defaults to library defaultVersionKey)')
    .action(async (libraryId: string, cmdOptions: { version?: string }) => {
      const deps = getDeps();
      if (!deps.syncUseCase) {
        process.stderr.write('[docsctx sync] ERROR: SyncUseCase is not available.\n');
        process.exit(1);
      }
      const exitCode = await runSyncCommand({
        syncUseCase: deps.syncUseCase,
        libraryId,
        versionKey: cmdOptions.version,
      });
      process.exit(exitCode);
    });

  program
    .command('search <libraryId> <query>')
    .description('Retrieve version-aware cited documentation context via CLI')
    .option('--version <key>', 'Library version key (defaults to defaultVersionKey)')
    .option('--max-tokens <n>', 'Maximum token budget (default 6000)', (val) => parseInt(val, 10))
    .action(
      async (
        libraryId: string,
        query: string,
        cmdOptions: { version?: string; maxTokens?: number },
      ) => {
        const deps = getDeps();
        if (!deps.getContextUseCase) {
          process.stderr.write('[docsctx search] ERROR: GetContextUseCase is not available.\n');
          process.exit(1);
        }
        const exitCode = await runSearchCommand({
          getContextUseCase: deps.getContextUseCase,
          libraryId,
          query,
          versionKey: cmdOptions.version,
          maxTokens: cmdOptions.maxTokens,
        });
        process.exit(exitCode);
      },
    );

  program
    .command('index <libraryId>')
    .description('Publish complete local corpus revision to search backend generation')
    .option('--version <key>', 'Version key to index')
    .option('--plan', 'Dry-run: output indexing plan summary without modifying backend')
    .option('--rebuild', 'Force new generation publishing even if revision is already indexed')
    .option('--wait-seconds <n>', 'Readiness verification timeout in seconds (default 1800)', (val) => parseInt(val, 10))
    .action(
      async (
        libraryId: string,
        cmdOptions: { version?: string; plan?: boolean; rebuild?: boolean; waitSeconds?: number },
      ) => {
        const deps = getDeps();
        if (!deps.indexUseCase) {
          process.stderr.write('[docsctx index] ERROR: IndexUseCase is not available.\n');
          process.exit(1);
        }
        const exitCode = await runIndexCommand({
          indexUseCase: deps.indexUseCase,
          libraryId,
          versionKey: cmdOptions.version,
          plan: cmdOptions.plan,
          rebuild: cmdOptions.rebuild,
          waitSeconds: cmdOptions.waitSeconds,
        });
        process.exit(exitCode);
      },
    );

  program
    .command('doctor')
    .description('Perform read-only diagnostic checks on environment, registry, and storage')
    .action(async () => {
      const deps = getDeps();
      const exitCode = await runDoctorCommand({
        libraryRegistry: deps.libraryRegistry,
        manifestStore: deps.manifestStore,
        varRoot: deps.varRoot,
        configDir: deps.configDir,
      });
      process.exit(exitCode);
    });

  return program;
}
