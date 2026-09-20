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
import type { GarbageCollectionUseCase } from '../../application/indexing/GarbageCollectionUseCase.js';
import type { SearchBackend } from '../../application/ports/SearchBackend.js';
import type { Logger } from '../mcp/server.js';
import { runServeCommand } from './commands/serve.js';
import { runDoctorCommand } from './commands/doctor.js';
import { runSyncCommand } from './commands/sync.js';
import { runSearchCommand } from './commands/search.js';
import { runIndexCommand } from './commands/index.js';
import { runGcCommand } from './commands/gc.js';

export interface CliDependencies {
  mcpServer: McpServer;
  createMcpServer?: () => McpServer;
  libraryRegistry: LibraryRegistry;
  manifestStore?: ManifestStore;
  syncUseCase?: SyncUseCase;
  getContextUseCase?: GetContextUseCase;
  indexUseCase?: IndexUseCase;
  gcUseCase?: GarbageCollectionUseCase;
  searchBackend?: SearchBackend;
  remoteSearchBackend?: SearchBackend;
  varRoot: string;
  configDir: string;
  logger?: Logger;
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
    .description('Start the host-local stdio or HTTP/SSE MCP server')
    .option('-t, --transport <mode>', 'Transport mode: stdio or sse', 'stdio')
    .option('-p, --port <port>', 'Port for sse transport', (val) => parseInt(val, 10), 3000)
    .option('-h, --host <host>', 'Host for sse transport', '0.0.0.0')
    .action(async (cmdOptions: { transport?: 'stdio' | 'sse'; port?: number; host?: string }) => {
      const deps = getDeps();
      await runServeCommand({
        mcpServer: deps.mcpServer,
        createMcpServer: deps.createMcpServer,
        transport: cmdOptions.transport,
        port: cmdOptions.port,
        host: cmdOptions.host,
        logger: deps.logger,
      });
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
    .option('--resume <runId>', 'Resume an un-finished or failed index run')
    .option('--abandon <runId>', 'Abandon an un-finished index run')
    .option('--wait-seconds <n>', 'Readiness verification timeout in seconds (default 1800)', (val) => parseInt(val, 10))
    .action(
      async (
        libraryId: string,
        cmdOptions: {
          version?: string;
          plan?: boolean;
          rebuild?: boolean;
          resume?: string;
          abandon?: string;
          waitSeconds?: number;
        },
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
          resumeRunId: cmdOptions.resume,
          abandonRunId: cmdOptions.abandon,
          waitSeconds: cmdOptions.waitSeconds,
        });
        process.exit(exitCode);
      },
    );

  program
    .command('gc [libraryId]')
    .description('Garbage collect retired or abandoned generations older than threshold')
    .option('--version <key>', 'Version key to target (defaults to all versions)')
    .option('--apply', 'Apply physical deletion (default is dry-run mode)')
    .option(
      '--min-age-hours <n>',
      'Minimum age threshold in hours (default 24)',
      (val) => parseInt(val, 10),
    )
    .action(
      async (
        libraryId: string | undefined,
        cmdOptions: { version?: string; apply?: boolean; minAgeHours?: number },
      ) => {
        const deps = getDeps();
        if (!deps.gcUseCase) {
          process.stderr.write('[docsctx gc] ERROR: GarbageCollectionUseCase is not available.\n');
          process.exit(1);
        }
        const exitCode = await runGcCommand({
          gcUseCase: deps.gcUseCase,
          libraryId,
          versionKey: cmdOptions.version,
          apply: cmdOptions.apply,
          minAgeHours: cmdOptions.minAgeHours,
        });
        process.exit(exitCode);
      },
    );

  program
    .command('doctor')
    .description('Perform read-only diagnostic checks on environment, registry, and storage')
    .option('--remote', 'Perform remote search backend connectivity and schema health check')
    .action(async (cmdOptions: { remote?: boolean }) => {
      const deps = getDeps();
      const exitCode = await runDoctorCommand({
        libraryRegistry: deps.libraryRegistry,
        manifestStore: deps.manifestStore,
        searchBackend: deps.remoteSearchBackend ?? deps.searchBackend,
        varRoot: deps.varRoot,
        configDir: deps.configDir,
        remote: cmdOptions.remote,
      });
      process.exit(exitCode);
    });

  return program;
}
