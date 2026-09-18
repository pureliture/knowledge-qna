/**
 * CLI Command: docsctx serve
 * Runs the Stdio MCP v2 server or HTTP/SSE MCP server.
 */

import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import type { McpServer } from '@modelcontextprotocol/server';
import { setupStdioGuards } from '../../mcp/stdioGuards.js';
import { startSseServer } from '../../mcp/sseServer.js';
import type { Logger } from '../../mcp/server.js';

export interface ServeCommandOptions {
  mcpServer: McpServer;
  createMcpServer?: () => McpServer;
  transport?: 'stdio' | 'sse';
  port?: number;
  host?: string;
  logger?: Logger;
}

export async function runServeCommand(options: ServeCommandOptions): Promise<void> {
  const transportMode = options.transport ?? 'stdio';

  if (transportMode === 'sse') {
    const port = options.port ?? 3000;
    const host = options.host ?? '0.0.0.0';
    const createServer = options.createMcpServer ?? (() => options.mcpServer);

    const sseInstance = await startSseServer({
      port,
      host,
      createMcpServer: createServer,
      logger: options.logger,
    });

    process.on('SIGINT', async () => {
      await sseInstance.close();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      await sseInstance.close();
      process.exit(0);
    });

    return;
  }

  // Stdio transport: setup stdio guards to guarantee stdout is 100% reserved for JSON-RPC
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
