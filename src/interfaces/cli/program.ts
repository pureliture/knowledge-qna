/**
 * Commander Program Definition for docsctx CLI
 */

import { Command } from 'commander';
import type { McpServer } from '@modelcontextprotocol/server';
import type { LibraryRegistry } from '../../application/ports/LibraryRegistry.js';
import type { ManifestStore } from '../../application/ports/ManifestStore.js';
import { runServeCommand } from './commands/serve.js';
import { runDoctorCommand } from './commands/doctor.js';

export interface CliDependencies {
  mcpServer: McpServer;
  libraryRegistry: LibraryRegistry;
  manifestStore?: ManifestStore;
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
