/**
 * Entry Point for docsctx CLI and MCP Server
 */

import * as path from 'node:path';
import { AppContainer } from './composition/container.js';
import { buildCliProgram, type CliDependencies } from './interfaces/cli/program.js';

function findCliOption(args: string[], longFlag: string, shortFlag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === longFlag || arg === shortFlag) {
      if (i + 1 < args.length && !args[i + 1]!.startsWith('-')) {
        return args[i + 1];
      }
    }
    if (arg.startsWith(`${longFlag}=`)) {
      return arg.slice(longFlag.length + 1);
    }
    if (arg.startsWith(`${shortFlag}=`)) {
      return arg.slice(shortFlag.length + 1);
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  let container: AppContainer | null = null;
  let program: ReturnType<typeof buildCliProgram>;

  function getDependencies(): CliDependencies {
    if (!container) {
      const parsedOpts = program ? program.opts<{ config?: string; varRoot?: string }>() : {};

      const cleanOpt = (val?: string) => (val?.startsWith('=') ? val.slice(1) : val);
      const configArg = cleanOpt(parsedOpts.config) ?? findCliOption(process.argv, '--config', '-c');
      const varRootArg = cleanOpt(parsedOpts.varRoot) ?? findCliOption(process.argv, '--var-root', '-v');

      const configDir = configArg
        ? path.resolve(configArg)
        : path.resolve(process.cwd(), 'config/libraries');

      const varRoot = varRootArg
        ? path.resolve(varRootArg)
        : path.resolve(process.cwd(), 'var');

      container = new AppContainer({
        configDir,
        varRoot,
      });
    }

    return {
      mcpServer: container.mcpServer,
      libraryRegistry: container.libraryRegistry,
      manifestStore: container.manifestStore,
      syncUseCase: container.syncUseCase,
      getContextUseCase: container.getContextUseCase,
      indexUseCase: container.indexUseCase,
      varRoot: container.varRoot,
      configDir: container.configDir,
    };
  }

  program = buildCliProgram(getDependencies);
  await program.parseAsync(process.argv);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
