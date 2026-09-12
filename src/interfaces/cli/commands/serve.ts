/**
 * CLI Command: docsctx serve
 * Runs the Stdio MCP v2 server with stdout protection guards.
 */

import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import type { McpServer } from '@modelcontextprotocol/server';
import { setupStdioGuards } from '../../mcp/stdioGuards.js';

export interface ServeCommandOptions {
  mcpServer: McpServer;
}

export async function runServeCommand(options: ServeCommandOptions): Promise<void> {
  // 1. Setup stdio guards to guarantee stdout is 100% reserved for JSON-RPC
  setupStdioGuards();

  const transport = new StdioServerTransport();
  await options.mcpServer.connect(transport);

  process.on('SIGINT', async () => {
    await options.mcpServer.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await options.mcpServer.close();
    process.exit(0);
  });
}
