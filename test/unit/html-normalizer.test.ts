import { describe, it, expect } from 'vitest';
import { HtmlDocumentNormalizer } from '../../src/infrastructure/parsing/HtmlDocumentNormalizer.js';
import { CliOperationError } from '../../src/domain/errors.js';
import {
  computeDocumentId,
  computeNormalizedHash,
  computeSnapshotId,
} from '../../src/domain/identity.js';

describe('HtmlDocumentNormalizer Unit Tests', () => {
  const normalizer = new HtmlDocumentNormalizer('normalizer-profile-v1');

  const defaultParserConfig = {
    contentSelectors: ['main', 'article'],
    removeSelectors: ['nav', 'footer', 'script', 'style'],
  };

  it('preserves semantic structure: headings, lists, tables, and fenced code blocks', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head><title>Test Documentation</title></head>
        <body>
          <nav><a href="/home">Home</a></nav>
          <main>
            <h1 id="overview">Overview</h1>
            <p>Welcome to the guide. Here is an overview of features:</p>
            <ul>
              <li>Item 1</li>
              <li>Item 2
                <ul>
                  <li>Sub-item 2.1</li>
                </ul>
              </li>
            </ul>
            <h2 id="config-table">Configuration Options</h2>
            <table>
              <thead>
                <tr><th>Option</th><th>Type</th><th>Default</th></tr>
              </thead>
              <tbody>
                <tr><td>port</td><td>number</td><td>8080</td></tr>
                <tr><td>host</td><td>string</td><td>localhost</td></tr>
              </tbody>
            </table>
            <h2 id="sample-code">Sample Code</h2>
            <pre><code class="language-python">def calculate_total(items):
    total = 0
    for item in items:
        total += item.price
    return total
</code></pre>
          </main>
          <footer>Footer text</footer>
        </body>
      </html>
    `;

    const doc = await normalizer.normalize({
      libraryId: 'test-lib',
      versionKey: 'v1',
      canonicalUrl: 'https://docs.example.com/guide',
      html,
      parserConfig: defaultParserConfig,
      normalizerProfileId: 'normalizer-profile-v1',
    });

    expect(doc.title).toBe('Overview');
    expect(doc.canonicalUrl).toBe('https://docs.example.com/guide');
    expect(doc.libraryId).toBe('test-lib');
    expect(doc.versionKey).toBe('v1');

    // Verify noise removal: nav and footer stripped
    expect(doc.markdown).not.toContain('Home');
    expect(doc.markdown).not.toContain('Footer text');

    // Verify headings
    expect(doc.headings).toEqual([
      { level: 1, text: 'Overview', anchor: 'overview' },
      { level: 2, text: 'Configuration Options', anchor: 'config-table' },
      { level: 2, text: 'Sample Code', anchor: 'sample-code' },
    ]);

    // Verify markdown contains ATX headings
    expect(doc.markdown).toContain('# Overview');
    expect(doc.markdown).toContain('## Configuration Options');
    expect(doc.markdown).toContain('## Sample Code');

    // Verify table markdown
    expect(doc.markdown).toContain('| Option | Type | Default |');
    expect(doc.markdown).toContain('| port | number | 8080 |');

    // Verify code block preservation with language and 4-space indentation
    expect(doc.markdown).toContain('```python');
    expect(doc.markdown).toContain('    total = 0');
    expect(doc.markdown).toContain('    for item in items:');
    expect(doc.markdown).toContain('        total += item.price');

    // Verify deterministic identity
    const expectedDocId = computeDocumentId('test-lib', 'v1', 'https://docs.example.com/guide');
    expect(doc.documentId).toBe(expectedDocId);

    const expectedHash = computeNormalizedHash({
      title: doc.title,
      markdown: doc.markdown,
      headings: doc.headings,
      metadata: doc.metadata,
    });
    expect(doc.normalizedHash).toBe(expectedHash);

    const expectedSnapshotId = computeSnapshotId(
      doc.documentId,
      'normalizer-profile-v1',
      expectedHash,
    );
    expect(doc.snapshotId).toBe(expectedSnapshotId);
  });

  it('extracts language identifiers from multiple class formats and data attributes', async () => {
    const html = `
      <main>
        <h1>Code Samples</h1>
        <pre class="highlight-source-typescript"><code>const x: number = 42;</code></pre>
        <pre data-lang="rust"><code>fn main() { println!("Hello"); }</code></pre>
        <pre class="highlight-sql"><code>SELECT * FROM users;</code></pre>
      </main>
    `;

    const doc = await normalizer.normalize({
      libraryId: 'test-lib',
      versionKey: 'v1',
      canonicalUrl: 'https://docs.example.com/code',
      html,
      parserConfig: defaultParserConfig,
      normalizerProfileId: 'normalizer-profile-v1',
    });

    expect(doc.markdown).toContain('```typescript\nconst x: number = 42;\n```');
    expect(doc.markdown).toContain('```rust\nfn main() { println!("Hello"); }\n```');
    expect(doc.markdown).toContain('```sql\nSELECT * FROM users;\n```');
  });

  it('strictly respects content container selector precedence and avoids duplicate extraction', async () => {
    // Nested <article> inside <main>: searching ['main', 'article'] should select <main> once and not duplicate <article>
    const html = `
      <div>
        <main>
          <h1>Main Title</h1>
          <p>Main content paragraph.</p>
          <article>
            <h2>Nested Article</h2>
            <p>Nested article paragraph.</p>
          </article>
        </main>
      </div>
    `;

    const doc = await normalizer.normalize({
      libraryId: 'test-lib',
      versionKey: 'v1',
      canonicalUrl: 'https://docs.example.com/nested',
      html,
      parserConfig: { contentSelectors: ['main', 'article'], removeSelectors: [] },
      normalizerProfileId: 'normalizer-profile-v1',
    });

    // Content should appear exactly once
    const matches = doc.markdown.match(/Nested article paragraph\./g);
    expect(matches).toHaveLength(1);
  });

  it('resolves relative URLs to absolute URLs based on canonicalUrl', async () => {
    const html = `
      <main>
        <h1>Links & Images</h1>
        <p>Read the <a href="/getting-started">Getting Started</a> guide.</p>
        <p>Relative link: <a href="subpage/details.html#anchor-one">Details</a></p>
        <p>Fragment link: <a href="#local-anchor">Local</a></p>
        <img src="../images/diagram.png" alt="Architecture" />
      </main>
    `;

    const doc = await normalizer.normalize({
      libraryId: 'test-lib',
      versionKey: 'v1',
      canonicalUrl: 'https://docs.example.com/section/page.html',
      html,
      parserConfig: defaultParserConfig,
      normalizerProfileId: 'normalizer-profile-v1',
    });

    expect(doc.markdown).toContain('[Getting Started](https://docs.example.com/getting-started)');
    expect(doc.markdown).toContain(
      '[Details](https://docs.example.com/section/subpage/details.html#anchor-one)',
    );
    expect(doc.markdown).toContain('[Local](#local-anchor)');
    expect(doc.markdown).toContain('![Architecture](https://docs.example.com/images/diagram.png)');
  });

  it('preserves genuine heading anchors and does not synthesize artificial slugs', async () => {
    const html = `
      <main>
        <h1 id="real-anchor">Document With Anchor</h1>
        <h2>Heading Without Anchor</h2>
        <h3><a name="named-anchor"></a>Heading With Named Anchor</h3>
      </main>
    `;

    const doc = await normalizer.normalize({
      libraryId: 'test-lib',
      versionKey: 'v1',
      canonicalUrl: 'https://docs.example.com/anchors',
      html,
      parserConfig: defaultParserConfig,
      normalizerProfileId: 'normalizer-profile-v1',
    });

    expect(doc.headings).toEqual([
      { level: 1, text: 'Document With Anchor', anchor: 'real-anchor' },
      { level: 2, text: 'Heading Without Anchor' }, // No synthetic anchor!
      { level: 3, text: 'Heading With Named Anchor', anchor: 'named-anchor' },
    ]);
  });

  it('extracts metadata language when present', async () => {
    const html = `
      <!DOCTYPE html>
      <html lang="ko-KR">
        <head><title>문서</title></head>
        <body>
          <main>
            <h1>한국어 문서</h1>
            <p>본문 내용입니다.</p>
          </main>
        </body>
      </html>
    `;

    const doc = await normalizer.normalize({
      libraryId: 'test-lib',
      versionKey: 'v1',
      canonicalUrl: 'https://docs.example.com/ko',
      html,
      parserConfig: defaultParserConfig,
      normalizerProfileId: 'normalizer-profile-v1',
    });

    expect(doc.metadata.language).toBe('ko-KR');
  });

  it('throws DOCUMENT_PARSE_FAILED on empty HTML or when contentSelectors match nothing', async () => {
    await expect(
      normalizer.normalize({
        libraryId: 'test-lib',
        versionKey: 'v1',
        canonicalUrl: 'https://docs.example.com/empty',
        html: '',
        parserConfig: defaultParserConfig,
        normalizerProfileId: 'normalizer-profile-v1',
      }),
    ).rejects.toThrowError(CliOperationError);

    await expect(
      normalizer.normalize({
        libraryId: 'test-lib',
        versionKey: 'v1',
        canonicalUrl: 'https://docs.example.com/empty-div',
        html: '<div><nav>Nav only</nav></div>',
        parserConfig: { contentSelectors: ['main'], removeSelectors: ['nav'] },
        normalizerProfileId: 'normalizer-profile-v1',
      }),
    ).rejects.toThrowError(CliOperationError);
  });
});
