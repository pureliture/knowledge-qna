/**
 * Contract & Integration Test for Stdio MCP v2 Server (T-10)
 * Spawns the CLI in stdio server mode, exchanges JSON-RPC messages,
 * verifies stdout discipline (100% JSON-RPC lines), and asserts on tool envelopes.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';

interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id?: number | string;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

class McpTestClient {
  private proc!: ChildProcessWithoutNullStreams;
  private pendingRequests = new Map<number, (res: JsonRpcResponse) => void>();
  private nextId = 1;
  private stdoutLines: string[] = [];
  private stderrOutput = '';
  private buffer = '';

  async start(): Promise<void> {
    const mainJsPath = path.resolve(__dirname, '../../dist/main.js');

    this.proc = spawn(process.execPath, [mainJsPath, 'serve'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    this.proc.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf-8');
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.stdoutLines.push(trimmed);

        try {
          const parsed = JSON.parse(trimmed) as JsonRpcResponse;
          if (parsed.id !== undefined) {
            const reqId = Number(parsed.id);
            const handler = this.pendingRequests.get(reqId);
            if (handler) {
              this.pendingRequests.delete(reqId);
              handler(parsed);
            }
          }
        } catch {
          // If non-JSON is received, it will remain in stdoutLines and fail assertion
        }
      }
    });

    this.proc.stderr.on('data', (chunk: Buffer) => {
      this.stderrOutput += chunk.toString('utf-8');
    });
  }

  async sendRequest<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<JsonRpcResponse<T>> {
    const id = this.nextId++;
    const payload = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Timeout waiting for response to ${method} (id: ${id})`));
      }, 5000);

      this.pendingRequests.set(id, (res) => {
        clearTimeout(timer);
        resolve(res as JsonRpcResponse<T>);
      });

      this.proc.stdin.write(JSON.stringify(payload) + '\n');
    });
  }

  sendNotification(method: string, params?: Record<string, unknown>): void {
    const payload: Record<string, unknown> = {
      jsonrpc: '2.0',
      method,
    };
    if (params) {
      payload['params'] = params;
    }
    this.proc.stdin.write(JSON.stringify(payload) + '\n');
  }

  getStdoutLines(): string[] {
    return this.stdoutLines;
  }

  getStderrOutput(): string {
    return this.stderrOutput;
  }

  async stop(): Promise<void> {
    if (this.proc && !this.proc.killed) {
      this.proc.kill('SIGTERM');
    }
  }
}

describe('Stdio MCP v2 Server Integration (T-10)', () => {
  const client = new McpTestClient();

  beforeAll(async () => {
    await client.start();

    // 1. Initialize MCP connection
    const initRes = await client.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'vitest-test-client', version: '1.0.0' },
    });

    expect(initRes.result).toBeDefined();
    client.sendNotification('notifications/initialized');
  });

  afterAll(async () => {
    await client.stop();
  });

  it('Rule A-09 / T-10: Stdio stdout emits ZERO non-JSON-RPC lines', () => {
    const lines = client.getStdoutLines();
    expect(lines.length).toBeGreaterThan(0);

    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
      const parsed = JSON.parse(line);
      expect(parsed.jsonrpc).toBe('2.0');
    }
  });

  it('Rule A-09: tools/list returns EXACTLY TWO tools: resolve_library and get_context', async () => {
    const res = await client.sendRequest<{ tools: Array<{ name: string; description: string }> }>('tools/list');

    expect(res.result).toBeDefined();
    expect(res.result?.tools).toHaveLength(2);

    const toolNames = res.result?.tools.map((t) => t.name).sort();
    expect(toolNames).toEqual(['get_context', 'resolve_library']);
  });

  it('tools/call resolve_library with exact alias returns success ToolEnvelope', async () => {
    const res = await client.sendRequest<{
      content: Array<{ type: string; text: string }>;
      structuredContent: {
        schemaVersion: number;
        ok: boolean;
        data: {
          libraryId: string;
          name: string;
          versionKey: string;
          availableVersionKeys: string[];
        };
      };
    }>('tools/call', {
      name: 'resolve_library',
      arguments: { query: 'foundry' },
    });

    expect(res.result).toBeDefined();
    const structured = res.result?.structuredContent;
    expect(structured).toBeDefined();
    expect(structured?.schemaVersion).toBe(1);
    expect(structured?.ok).toBe(true);
    expect(structured?.data.libraryId).toBe('palantir-foundry');
    expect(structured?.data.versionKey).toBe('current');
  });

  it('tools/call resolve_library with ambiguous query returns AMBIGUOUS_LIBRARY error envelope', async () => {
    const res = await client.sendRequest<{
      isError: boolean;
      structuredContent: {
        schemaVersion: number;
        ok: boolean;
        error: {
          code: string;
          message: string;
          retryable: boolean;
          candidates?: Array<{ libraryId: string; name: string }>;
        };
      };
    }>('tools/call', {
      name: 'resolve_library',
      arguments: { query: 'palantir' },
    });

    expect(res.result).toBeDefined();
    expect(res.result?.isError).toBe(true);

    const structured = res.result?.structuredContent;
    expect(structured?.ok).toBe(false);
    expect(structured?.error.code).toBe('AMBIGUOUS_LIBRARY');
    expect(structured?.error.candidates).toBeDefined();
    expect(structured?.error.candidates?.length).toBe(2);
    expect(structured?.error.candidates?.[0]?.libraryId).toBe('palantir-aip');
    expect(structured?.error.candidates?.[1]?.libraryId).toBe('palantir-foundry');
  });

  it('tools/call resolve_library with unknown library returns LIBRARY_NOT_FOUND error envelope', async () => {
    const res = await client.sendRequest<{
      isError: boolean;
      structuredContent: {
        schemaVersion: number;
        ok: boolean;
        error: {
          code: string;
        };
      };
    }>('tools/call', {
      name: 'resolve_library',
      arguments: { query: 'non-existent-library-12345' },
    });

    expect(res.result).toBeDefined();
    expect(res.result?.isError).toBe(true);
    expect(res.result?.structuredContent.error.code).toBe('LIBRARY_NOT_FOUND');
  });

  it('tools/call get_context for unindexed library returns CORPUS_NOT_READY error envelope', async () => {
    const res = await client.sendRequest<{
      isError: boolean;
      structuredContent: {
        schemaVersion: number;
        ok: boolean;
        error: {
          code: string;
        };
      };
    }>('tools/call', {
      name: 'get_context',
      arguments: {
        libraryId: 'palantir-foundry',
        query: 'how to create ontology object type',
      },
    });

    expect(res.result).toBeDefined();
    expect(res.result?.isError).toBe(true);
    expect(res.result?.structuredContent.error.code).toBe('CORPUS_NOT_READY');
  });

  it('tools/call get_context with schema violation (maxTokens < 256) returns error envelope or protocol error', async () => {
    const res = await client.sendRequest<{
      isError?: boolean;
      error?: unknown;
      structuredContent?: { ok: boolean; error: { code: string } };
    }>('tools/call', {
      name: 'get_context',
      arguments: {
        libraryId: 'palantir-foundry',
        query: 'valid query',
        maxTokens: 50, // invalid: minimum is 256
      },
    });

    // MCP SDK validation will reject schema violation either via protocol error or isError tool result
    if (res.error) {
      expect(res.error).toBeDefined();
    } else {
      expect(res.result?.isError).toBe(true);
    }
  });
});
