import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { OpenApiNormalizer } from '../../src/infrastructure/parsing/OpenApiNormalizer.js';
import { TiktokenCounter } from '../../src/infrastructure/tokens/TiktokenCounter.js';

describe('OpenApiNormalizer Unit Tests', () => {
  const normalizer = new OpenApiNormalizer();
  const tokenCounter = new TiktokenCounter();

  // Minimal spec for basic contract tests
  const minimalSpec = JSON.stringify({
    openapi: '3.1.0',
    info: {
      title: 'Sample Test API',
      version: '1.0.0',
    },
    paths: {
      '/api/v1/test': {
        get: {
          summary: 'Get test resource',
          description: 'Fetches sample test resource for unit tests.',
          tags: ['TestTag'],
          parameters: [
            {
              name: 'filter',
              in: 'query',
              required: true,
              schema: { type: 'string' },
              description: 'Filter parameter',
            },
          ],
          responses: {
            '200': {
              description: 'Successful response',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      id: { type: 'string', description: 'Resource ID' },
                      name: { type: 'string', description: 'Resource Name' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  it('normalizes minimal OpenAPI spec into structured NormalizedDocument', () => {
    const docs = normalizer.normalizeSpec({
      libraryId: 'test-api',
      versionKey: 'v1',
      specUrl: 'https://example.com/openapi.json',
      jsonContent: minimalSpec,
    });

    expect(docs).toHaveLength(1);
    const doc = docs[0];

    expect(doc.title).toBe('[TestTag] Get test resource (GET /api/v1/test)');
    expect(doc.canonicalUrl).toBe('https://example.com/openapi.json#/TestTag/get/api/v1/test');
    expect(doc.documentId).toBeDefined();
    expect(doc.snapshotId).toBeDefined();
    expect(doc.normalizedHash).toBeDefined();

    expect(doc.markdown).toContain('# [TestTag] Get test resource (GET /api/v1/test)');
    expect(doc.markdown).toContain('## 기능 설명');
    expect(doc.markdown).toContain('## 요청 파라미터');
    expect(doc.markdown).toContain('| `filter` | query | 필수 | `string` | Filter parameter |');
    expect(doc.markdown).toContain('## 응답 결과');
    expect(doc.markdown).toContain('### HTTP 200: Successful response');

    expect(doc.headings.length).toBeGreaterThan(1);
    expect(doc.headings[0].text).toBe('[TestTag] Get test resource (GET /api/v1/test)');
  });

  it('normalizes real Toss Invest OpenAPI specification', () => {
    const rawContentPath = '/Users/ddalkak/.gemini/antigravity/brain/f7a53a3f-5a0c-4551-9b88-086c0a814c5b/.system_generated/steps/150/content.md';
    if (!fs.existsSync(rawContentPath)) return;

    const rawFile = fs.readFileSync(rawContentPath, 'utf-8');
    const jsonStart = rawFile.indexOf('{');
    const jsonContent = rawFile.slice(jsonStart);

    const docs = normalizer.normalizeSpec({
      libraryId: 'toss-invest-openapi',
      versionKey: '1.2.17',
      specUrl: 'https://openapi.tossinvest.com/openapi-docs/latest/openapi.json',
      jsonContent,
    });

    // 36 operations in Toss Invest API
    expect(docs.length).toBe(36);

    // Verify order creation endpoint
    const orderDoc = docs.find((d) => d.canonicalUrl.includes('orders') && d.title.includes('POST'));
    expect(orderDoc).toBeDefined();
    expect(orderDoc!.title).toContain('주문');
    expect(orderDoc!.markdown).toContain('POST /api/v1/orders');
    expect(orderDoc!.markdown).toContain('요청 본문');

    // Verify token sizes are well within bounded limits (all < 16,000 tokens)
    for (const doc of docs) {
      const tokens = tokenCounter.count(doc.markdown);
      expect(tokens).toBeLessThan(16000);
      expect(tokens).toBeGreaterThan(50); // Meaningful documentation content
    }
  });
});
