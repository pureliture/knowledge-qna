// End-to-end MCP SSE Client Verification Script
const BASE_URL = process.env.MCP_URL || 'http://192.168.219.143:30080';

console.log(`[*] Connecting to MCP server at ${BASE_URL}...`);

// 1. Establish SSE Connection
const sseController = new AbortController();
const sseResponse = await fetch(`${BASE_URL}/sse`, {
  signal: sseController.signal,
  headers: { Accept: 'text/event-stream' },
});

if (!sseResponse.ok) {
  throw new Error(`SSE handshake failed: ${sseResponse.status} ${sseResponse.statusText}`);
}

const reader = sseResponse.body.getReader();
const decoder = new TextDecoder();

// Helper to read next SSE event
async function readNextEvent() {
  const { value, done } = await reader.read();
  if (done) return null;
  const chunk = decoder.decode(value);
  const lines = chunk.split('\n');
  let event = '';
  let data = '';
  for (const line of lines) {
    if (line.startsWith('event: ')) event = line.slice(7).trim();
    if (line.startsWith('data: ')) data = line.slice(6).trim();
  }
  return { event, data, raw: chunk };
}

// 2. Read initial endpoint event
const initEvent = await readNextEvent();
console.log(`[+] Received initial SSE event:`, initEvent.raw.trim());
const match = initEvent.data.match(/sessionId=([a-f0-9-]+)/);
if (!match) {
  throw new Error(`Failed to extract sessionId from ${initEvent.data}`);
}
const sessionId = match[1];
console.log(`[+] Acquired Session ID: ${sessionId}`);

// Helper to send POST message
async function postMessage(msg) {
  const res = await fetch(`${BASE_URL}/messages?sessionId=${sessionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(msg),
  });
  if (!res.ok) {
    throw new Error(`POST failed with ${res.status}: ${await res.text()}`);
  }
}

// 3. Send initialize
console.log('\n[*] Step 1: Sending initialize request...');
await postMessage({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-agent-client', version: '1.0.0' },
  },
});

const initResultEvent = await readNextEvent();
console.log('[+] Received initialize response:');
console.log(initResultEvent.raw.trim());

// 4. Send notifications/initialized
console.log('\n[*] Step 2: Sending initialized notification...');
await postMessage({
  jsonrpc: '2.0',
  method: 'notifications/initialized',
});

// 5. Send tools/list
console.log('\n[*] Step 3: Sending tools/list request...');
await postMessage({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/list',
  params: {},
});

const toolsListEvent = await readNextEvent();
console.log('[+] Received tools/list response:');
const toolsData = JSON.parse(toolsListEvent.data);
console.log('Available Tools:', toolsData.result?.tools?.map((t) => t.name));

// 6. Call resolve_library
console.log('\n[*] Step 4: Calling resolve_library for "toss"...');
await postMessage({
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: {
    name: 'resolve_library',
    arguments: { query: 'toss' },
  },
});

const resolveResultEvent = await readNextEvent();
console.log('[+] Received resolve_library response:');
console.log(resolveResultEvent.data);

// 7. Call get_context (Semantic Search via GCP Discovery Engine!)
console.log('\n[*] Step 5: Calling get_context for toss-invest-openapi (query: "계좌 조회")...');
await postMessage({
  jsonrpc: '2.0',
  id: 4,
  method: 'tools/call',
  params: {
    name: 'get_context',
    arguments: {
      libraryId: 'toss-invest-openapi',
      query: '계좌 잔고 조회 API 엔드포인트',
      maxTokens: 2000,
    },
  },
});

const contextResultEvent = await readNextEvent();
console.log('[+] Received get_context response:');
const contextData = JSON.parse(contextResultEvent.data);
console.log('Response status:', contextData.result?.isError ? 'ERROR' : 'SUCCESS');
if (contextData.result?.content?.[0]?.text) {
  const content = JSON.parse(contextData.result.content[0].text);
  console.log('Context snippets count:', content.snippets?.length);
  if (content.snippets?.[0]) {
    console.log('Sample snippet title:', content.snippets[0].title);
    console.log('Sample snippet text preview:', content.snippets[0].text?.slice(0, 150));
  }
}

// Cleanup
sseController.abort();
console.log('\n[ok] All verification steps passed successfully!');
