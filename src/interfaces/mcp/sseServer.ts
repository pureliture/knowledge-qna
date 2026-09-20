/**
 * HTTP and SSE MCP Server
 * Exposes SSE endpoint (/sse and /messages) and modern streamable endpoint (/mcp, /).
 * Tailscale private mesh accessible, Kubernetes ready (/healthz).
 */

import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type {
  McpServer,
  Transport,
  TransportSendOptions,
  JSONRPCMessage,
  MessageExtraInfo,
} from '@modelcontextprotocol/server';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { Logger } from './server.js';

export interface SseServerOptions {
  port: number;
  host?: string;
  createMcpServer: () => McpServer;
  logger?: Logger;
}

export class SseSessionTransport implements Transport {
  readonly sessionId: string;
  private readonly res: http.ServerResponse;
  private closed = false;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

  constructor(sessionId: string, res: http.ServerResponse) {
    this.sessionId = sessionId;
    this.res = res;
  }

  async start(): Promise<void> {
    // Connection is already established by HTTP GET /sse
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (this.closed || this.res.writableEnded) {
      return;
    }
    this.res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.res.writableEnded) {
      this.res.end();
    }
    this.onclose?.();
  }

  handlePostMessage(message: JSONRPCMessage): void {
    if (this.closed) {
      throw new Error(`Cannot send message to closed session ${this.sessionId}`);
    }
    this.onmessage?.(message);
  }
}

interface ActiveSession {
  transport: SseSessionTransport;
  server: McpServer;
  keepAliveTimer: NodeJS.Timeout;
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 10 * 1024 * 1024) {
        // 10MB safety limit
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

export async function startSseServer(options: SseServerOptions): Promise<{
  server: http.Server;
  port: number;
  host: string;
  close: () => Promise<void>;
}> {
  const { port, host = '0.0.0.0', createMcpServer, logger } = options;
  const sessions = new Map<string, ActiveSession>();

  // Shared modern MCP handler for /mcp and POST / requests
  const modernMcpHandler = createMcpHandler(async () => createMcpServer());

  const server = http.createServer(async (req, res) => {
    // CORS headers for all responses
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const rawUrl = req.url ?? '/';
    const hostHeader = req.headers.host ?? `localhost:${port}`;
    const url = new URL(rawUrl, `http://${hostHeader}`);

    try {
      // 1. Health check endpoint for Kubernetes probes
      if (req.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/health')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', activeSessions: sessions.size }));
        return;
      }

      // 2. Legacy / standard SSE handshake: GET /sse
      if (req.method === 'GET' && url.pathname === '/sse') {
        const sessionId = randomUUID();

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });

        // Send initial endpoint event pointing to /messages with sessionId
        res.write(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`);

        const transport = new SseSessionTransport(sessionId, res);
        const mcpServer = createMcpServer();

        await mcpServer.connect(transport);

        // Keep-alive heartbeat every 15s to prevent NAT/proxy timeouts
        const keepAliveTimer = setInterval(() => {
          if (!res.writableEnded) {
            res.write(': keepalive\n\n');
          }
        }, 15000);

        sessions.set(sessionId, { transport, server: mcpServer, keepAliveTimer });
        logger?.info('New MCP SSE session connected', { sessionId });

        req.on('close', async () => {
          clearInterval(keepAliveTimer);
          sessions.delete(sessionId);
          await transport.close().catch(() => {});
          await mcpServer.close().catch(() => {});
          logger?.info('MCP SSE session disconnected', { sessionId });
        });

        return;
      }

      // 3. Legacy / standard SSE message ingestion: POST /messages
      if (req.method === 'POST' && url.pathname === '/messages') {
        const sessionId = url.searchParams.get('sessionId');
        if (!sessionId || !sessions.has(sessionId)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Session not found or expired' }));
          return;
        }

        const session = sessions.get(sessionId)!;
        const rawBody = await readBody(req);
        let parsedMessage: JSONRPCMessage;

        try {
          parsedMessage = JSON.parse(rawBody) as JSONRPCMessage;
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON body' }));
          return;
        }

        session.transport.handlePostMessage(parsedMessage);
        res.writeHead(202, { 'Content-Type': 'text/plain' });
        res.end('Accepted');
        return;
      }

      // 4. Modern Streamable HTTP endpoint: POST /mcp or POST /
      if (req.method === 'POST' && (url.pathname === '/mcp' || url.pathname === '/')) {
        const fullUrl = `http://${hostHeader}${rawUrl}`;
        const rawBody = await readBody(req);

        // Convert Node IncomingMessage to Web Standard Request
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (value !== undefined) {
            if (Array.isArray(value)) {
              for (const v of value) headers.append(key, v);
            } else {
              headers.set(key, value);
            }
          }
        }

        const webRequest = new Request(fullUrl, {
          method: 'POST',
          headers,
          body: rawBody || undefined,
        });

        const webResponse = await modernMcpHandler.fetch(webRequest);

        // Bridge Web Response back to Node ServerResponse
        const respHeaders: Record<string, string> = {};
        webResponse.headers.forEach((val, key) => {
          respHeaders[key] = val;
        });

        res.writeHead(webResponse.status, respHeaders);

        if (webResponse.body) {
          const nodeStream = Readable.fromWeb(webResponse.body as any);
          nodeStream.pipe(res);
        } else {
          res.end();
        }
        return;
      }

      // 404 for any other path
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
    } catch (err) {
      logger?.error('Error handling HTTP/SSE MCP request', {
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal Server Error' }));
      }
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      logger?.info(`Knowledge QnA MCP server listening on http://${host}:${actualPort}`);

      resolve({
        server,
        port: actualPort,
        host,
        close: async () => {
          // Tear down all active SSE sessions
          for (const [sessionId, session] of sessions.entries()) {
            clearInterval(session.keepAliveTimer);
            await session.transport.close().catch(() => {});
            await session.server.close().catch(() => {});
            sessions.delete(sessionId);
          }
          await modernMcpHandler.close().catch(() => {});
          return new Promise<void>((resClose) => {
            server.close(() => resClose());
          });
        },
      });
    });
  });
}
