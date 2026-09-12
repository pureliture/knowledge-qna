/**
 * Adversarial Stdio MCP Server Protocol Boundary Tests (T-10)
 * Challenger: challenger_m0_2
 *
 * Attacks tested:
 * 1. Malformed JSON-RPC payloads (syntax errors, non-object JSON, empty lines, missing fields)
 * 2. Invalid notifications (unknown methods, invalid params, notification floods)
 * 3. Rapid sequential requests (burst pipelining 50+ concurrent requests)
 * 4. Boundary & fuzzing of tool schemas (regex violations, range limits, length bounds)
 * 5. Strict stdout cleanliness assertion: 100% of bytes on stdout MUST be valid JSON-RPC 2.0 lines.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';

interface JsonRpcMessage {
  jsonrpc: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

class AdversarialMcpClient {
  public proc!: ChildProcessWithoutNullStreams;
  public rawStdoutChunks: Buffer[] = [];
  public rawStderrChunks: Buffer[] = [];
  public stdoutLines: string[] = [];
  private pendingRequests = new Map<number | string, (res: JsonRpcMessage) => void>();
  private nextId = 1000;
  private buffer = '';

  async start(): Promise<void> {
    const mainJsPath = path.resolve(__dirname, '../../dist/main.js');

    this.proc = spawn(process.execPath, [mainJsPath, 'serve'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    this.proc.stdout.on('data', (chunk: Buffer) => {
      this.rawStdoutChunks.push(chunk);
      this.buffer += chunk.toString('utf-8');
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.stdoutLines.push(trimmed);

        try {
          const parsed = JSON.parse(trimmed) as JsonRpcMessage;
          if (parsed.id !== undefined && parsed.id !== null) {
            const handler = this.pendingRequests.get(parsed.id);
            if (handler) {
              this.pendingRequests.delete(parsed.id);
              handler(parsed);
            }
          }
        } catch {
          // Non-JSON captured in stdoutLines for assertion
        }
      }
    });

    this.proc.stderr.on('data', (chunk: Buffer) => {
      this.rawStderrChunks.push(chunk);
    });

    // Send initialize handshake
    await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'adversarial-challenger-client', version: '1.0.0' },
    });
    this.sendNotification('notifications/initialized');
  }

  async sendRequest<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<JsonRpcMessage> {
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
        resolve(res);
      });

      this.proc.stdin.write(JSON.stringify(payload) + '\n');
    });
  }

  sendRaw(rawString: string): void {
    this.proc.stdin.write(rawString + '\n');
  }

  sendNotification(method: string, params?: unknown): void {
    const payload: Record<string, unknown> = {
      jsonrpc: '2.0',
      method,
    };
    if (params !== undefined) {
      payload['params'] = params;
    }
    this.proc.stdin.write(JSON.stringify(payload) + '\n');
  }

  async stop(): Promise<void> {
    if (this.proc && !this.proc.killed) {
      this.proc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  assertAllStdoutAreValidJsonRpc(): void {
    for (const line of this.stdoutLines) {
      expect(() => JSON.parse(line)).not.toThrow();
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty('jsonrpc', '2.0');
    }
  }
}

describe('Adversarial Stdio MCP Protocol Boundary Stress Suite (T-10)', () => {
  let client: AdversarialMcpClient;

  beforeAll(async () => {
    client = new AdversarialMcpClient();
    await client.start();
  });

  afterAll(async () => {
    await client.stop();
  });

  it('1. Malformed JSON payloads do not crash server and never pollute stdout', async () => {
    const countBefore = client.stdoutLines.length;

    // Attack payloads: syntactically broken JSON, empty lines, non-object JSON
    const malformedInputs = [
      '{ broken json string here',
      '}{}{}',
      '',
      '   ',
      'true',
      '123456789',
      '"just a naked string"',
      '[1, 2, 3]',
      '{"jsonrpc": "1.0", "id": 9999, "method": "tools/list"}',
      '{"id": 8888, "method": "tools/list"}', // missing jsonrpc
    ];

    for (const malformed of malformedInputs) {
      client.sendRaw(malformed);
    }

    // Give server time to process or discard
    await new Promise((r) => setTimeout(r, 200));

    // CRITICAL: Server must still be alive and answer valid requests!
    const pingRes = await client.sendRequest('tools/list');
    expect(pingRes.result).toBeDefined();

    // Verify stdout cleanliness: all emitted lines must be 100% valid JSON-RPC
    client.assertAllStdoutAreValidJsonRpc();
  });

  it('2. Invalid notifications are silently handled without crashing or echoing to stdout', async () => {
    const countBefore = client.stdoutLines.length;

    // Send invalid notifications
    client.sendNotification('unknown/notification/v1', { arbitrary: 'payload' });
    client.sendNotification('', {});
    client.sendNotification('notifications/initialized', 'invalid-params-type');
    client.sendNotification('notifications/cancelled', { requestId: 999999 });

    await new Promise((r) => setTimeout(r, 150));

    // Per JSON-RPC 2.0 specification, notifications MUST NOT return responses
    const countAfter = client.stdoutLines.length;
    expect(countAfter).toBe(countBefore);

    // Liveness test: server still functions normally
    const listRes = await client.sendRequest('tools/list');
    expect(listRes.result).toBeDefined();

    client.assertAllStdoutAreValidJsonRpc();
  });

  it('3. Rapid burst pipelining (50 concurrent requests) maintains response integrity', async () => {
    const burstCount = 50;
    const promises: Promise<JsonRpcMessage>[] = [];

    for (let i = 0; i < burstCount; i++) {
      const toolIndex = i % 5;
      if (toolIndex === 0) {
        promises.push(client.sendRequest('tools/list'));
      } else if (toolIndex === 1) {
        promises.push(
          client.sendRequest('tools/call', {
            name: 'resolve_library',
            arguments: { query: 'foundry' },
          }),
        );
      } else if (toolIndex === 2) {
        promises.push(
          client.sendRequest('tools/call', {
            name: 'resolve_library',
            arguments: { query: 'palantir' },
          }),
        );
      } else if (toolIndex === 3) {
        promises.push(
          client.sendRequest('tools/call', {
            name: 'resolve_library',
            arguments: { query: 'non-existent-lib-' + i },
          }),
        );
      } else {
        promises.push(
          client.sendRequest('tools/call', {
            name: 'get_context',
            arguments: {
              libraryId: 'palantir-foundry',
              query: 'test query ' + i,
            },
          }),
        );
      }
    }

    const responses = await Promise.all(promises);
    expect(responses).toHaveLength(burstCount);

    for (const res of responses) {
      expect(res.jsonrpc).toBe('2.0');
      expect(res.id).toBeDefined();
    }

    client.assertAllStdoutAreValidJsonRpc();
  });

  it('4. Tool Schema Adversarial Fuzzing: resolve_library boundary attacks', async () => {
    // A: Empty query
    const resEmpty = await client.sendRequest('tools/call', {
      name: 'resolve_library',
      arguments: { query: '' },
    });
    expect(resEmpty.error || (resEmpty.result as any)?.isError).toBeTruthy();

    // B: Oversized query (> 200 characters)
    const resHuge = await client.sendRequest('tools/call', {
      name: 'resolve_library',
      arguments: { query: 'a'.repeat(201) },
    });
    expect(resHuge.error || (resHuge.result as any)?.isError).toBeTruthy();

    // C: Path traversal / SQL injection style strings
    const resInjection = await client.sendRequest('tools/call', {
      name: 'resolve_library',
      arguments: { query: '../../../../etc/passwd; DROP TABLE libraries;--' },
    });
    // Should return gracefully as LIBRARY_NOT_FOUND without crashing
    const structured = (resInjection.result as any)?.structuredContent;
    expect(structured?.error?.code).toBe('LIBRARY_NOT_FOUND');

    client.assertAllStdoutAreValidJsonRpc();
  });

  it('5. Tool Schema Adversarial Fuzzing: get_context boundary attacks', async () => {
    // A: Invalid libraryId regex (uppercase, spaces, special chars)
    const resInvalidId = await client.sendRequest('tools/call', {
      name: 'get_context',
      arguments: { libraryId: 'INVALID_UPPERCASE!', query: 'hello' },
    });
    expect(resInvalidId.error || (resInvalidId.result as any)?.isError).toBeTruthy();

    // B: maxTokens boundary violations (< 256 or > 16000)
    const resMinToken = await client.sendRequest('tools/call', {
      name: 'get_context',
      arguments: { libraryId: 'palantir-foundry', query: 'hello', maxTokens: 255 },
    });
    expect(resMinToken.error || (resMinToken.result as any)?.isError).toBeTruthy();

    const resMaxToken = await client.sendRequest('tools/call', {
      name: 'get_context',
      arguments: { libraryId: 'palantir-foundry', query: 'hello', maxTokens: 16001 },
    });
    expect(resMaxToken.error || (resMaxToken.result as any)?.isError).toBeTruthy();

    // C: Floating point maxTokens
    const resFloatToken = await client.sendRequest('tools/call', {
      name: 'get_context',
      arguments: { libraryId: 'palantir-foundry', query: 'hello', maxTokens: 500.5 },
    });
    expect(resFloatToken.error || (resFloatToken.result as any)?.isError).toBeTruthy();

    // D: Oversized query (> 2000 chars)
    const resBigQuery = await client.sendRequest('tools/call', {
      name: 'get_context',
      arguments: { libraryId: 'palantir-foundry', query: 'q'.repeat(2001) },
    });
    expect(resBigQuery.error || (resBigQuery.result as any)?.isError).toBeTruthy();

    client.assertAllStdoutAreValidJsonRpc();
  });

  it('6. Non-existent tool call returns standard error without crashing', async () => {
    const res = await client.sendRequest('tools/call', {
      name: 'super_secret_backdoor_tool',
      arguments: {},
    });

    expect(res.error || (res.result as any)?.isError).toBeTruthy();
    client.assertAllStdoutAreValidJsonRpc();
  });

  it('7. Process shutdown via SIGTERM completes cleanly without leaking to stdout', async () => {
    // Spawn a dedicated server instance to test clean termination
    const testClient = new AdversarialMcpClient();
    await testClient.start();

    // Trigger SIGTERM
    testClient.proc.kill('SIGTERM');

    await new Promise<void>((resolve) => {
      testClient.proc.on('exit', () => resolve());
    });

    // Assert all output up to termination was 100% JSON-RPC
    testClient.assertAllStdoutAreValidJsonRpc();
  });
});

describe('Stream fragmentation and console diversion tests', () => {
  let client: AdversarialMcpClient;

  beforeAll(async () => {
    client = new AdversarialMcpClient();
    await client.start();
  });

  afterAll(async () => {
    await client.stop();
  });

  it('8. Fragmented JSON-RPC chunks (byte-by-byte streaming) are assembled correctly', async () => {
    const id = 77777;
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/list',
      params: {},
    }) + '\n';

    const responsePromise = new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout on fragmented write')), 5000);
      (client as any).pendingRequests.set(id, (res: JsonRpcMessage) => {
        clearTimeout(timer);
        resolve(res);
      });
    });

    // Write chunk by chunk in 5-byte slices with small delays
    for (let i = 0; i < payload.length; i += 5) {
      const slice = payload.slice(i, i + 5);
      client.proc.stdin.write(slice);
      await new Promise((r) => setTimeout(r, 5));
    }

    const res = await responsePromise;
    expect(res.id).toBe(id);
    expect(res.result).toBeDefined();

    client.assertAllStdoutAreValidJsonRpc();
  });
});
