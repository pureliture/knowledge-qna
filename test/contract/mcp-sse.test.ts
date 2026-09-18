import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import { startSseServer } from '../../src/interfaces/mcp/sseServer.js';
import { createKnowledgeQnaMcpServer } from '../../src/interfaces/mcp/server.js';
import { ResolveLibraryUseCase } from '../../src/application/library/resolve-library.js';
import { GetContextUseCase } from '../../src/application/retrieval/get-context.js';
import { InMemorySearchAdapter } from '../../src/infrastructure/search/InMemorySearchAdapter.js';
import { TiktokenCounter } from '../../src/infrastructure/tokens/TiktokenCounter.js';
import type { LibraryRegistry } from '../../src/application/ports/LibraryRegistry.js';
import type { ManifestStore } from '../../src/application/ports/ManifestStore.js';
import type { CorpusStore } from '../../src/application/ports/CorpusStore.js';

describe('HTTP & SSE MCP Server Contract', () => {
  let sseInstance: { server: http.Server; port: number; close: () => Promise<void> } | null = null;

  function createTestServer() {
    const mockRegistry: LibraryRegistry = {
      resolve: async (q) => (q === 'test-lib' ? { libraryId: 'test-lib', defaultVersionKey: 'v1', availableVersions: ['v1'], name: 'Test Lib' } : null),
      getAll: async () => [],
    };
    const mockManifest: ManifestStore = {
      getCurrentRevision: async () => null,
      getRevision: async () => null,
      saveRevision: async () => {},
      updateCurrentRevision: async () => {},
      createStagedRevision: async () => 'rev-1',
    };
    const mockCorpus: CorpusStore = {
      getChunk: async () => null,
      saveChunk: async () => {},
      hasChunk: async () => false,
      deleteChunk: async () => {},
    };

    const resolveLibraryUseCase = new ResolveLibraryUseCase(mockRegistry);
    const getContextUseCase = new GetContextUseCase(
      mockRegistry,
      mockManifest,
      mockCorpus,
      new InMemorySearchAdapter('mock'),
      new TiktokenCounter(),
      'mock',
    );

    return () =>
      createKnowledgeQnaMcpServer({
        resolveLibraryUseCase,
        getContextUseCase,
      });
  }

  afterEach(async () => {
    if (sseInstance) {
      await sseInstance.close();
      sseInstance = null;
    }
  });

  it('responds 200 OK to /healthz', async () => {
    sseInstance = await startSseServer({
      port: 0, // Random available port
      host: '127.0.0.1',
      createMcpServer: createTestServer(),
    });

    const res = await fetch(`http://127.0.0.1:${sseInstance.port}/healthz`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
  });

  it('performs SSE handshake and receives initial endpoint event', async () => {
    sseInstance = await startSseServer({
      port: 0,
      host: '127.0.0.1',
      createMcpServer: createTestServer(),
    });

    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${sseInstance.port}/sse`, {
      signal: controller.signal,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const { value } = await reader.read();
    const chunk = decoder.decode(value);

    expect(chunk).toContain('event: endpoint');
    expect(chunk).toContain('/messages?sessionId=');

    controller.abort();
  });

  it('handles JSON-RPC initialize request via POST /messages and sends response over SSE', async () => {
    sseInstance = await startSseServer({
      port: 0,
      host: '127.0.0.1',
      createMcpServer: createTestServer(),
    });

    const controller = new AbortController();
    const sseRes = await fetch(`http://127.0.0.1:${sseInstance.port}/sse`, {
      signal: controller.signal,
    });

    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();

    // Read endpoint event
    const firstChunk = await reader.read();
    const endpointText = decoder.decode(firstChunk.value);
    const match = endpointText.match(/data:\s*\/messages\?sessionId=([a-f0-9-]+)/);
    expect(match).toBeTruthy();
    const sessionId = match![1];

    // Send initialize request via POST /messages
    const postRes = await fetch(`http://127.0.0.1:${sseInstance.port}/messages?sessionId=${sessionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }),
    });

    expect(postRes.status).toBe(202);

    // Read SSE message response
    const secondChunk = await reader.read();
    const messageText = decoder.decode(secondChunk.value);
    expect(messageText).toContain('event: message');
    expect(messageText).toContain('"serverInfo"');
    expect(messageText).toContain('knowledge-qna-mcp');

    controller.abort();
  });

  it('returns 404 for POST /messages with invalid session ID', async () => {
    sseInstance = await startSseServer({
      port: 0,
      host: '127.0.0.1',
      createMcpServer: createTestServer(),
    });

    const postRes = await fetch(`http://127.0.0.1:${sseInstance.port}/messages?sessionId=invalid-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });

    expect(postRes.status).toBe(404);
  });
});
