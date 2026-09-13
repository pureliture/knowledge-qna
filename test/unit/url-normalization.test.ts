import { describe, it, expect } from 'vitest';
import { UrlNormalizer } from '../../src/infrastructure/source/UrlNormalizer.js';
import { CliOperationError } from '../../src/domain/errors.js';

describe('UrlNormalizer Unit Tests', () => {
  it('lowercases host and strips default ports 80 and 443', () => {
    const res1 = UrlNormalizer.normalize('HTTP://WWW.EXAMPLE.COM:80/docs/intro', { allowHttp: true });
    expect(res1).toBe('http://www.example.com/docs/intro');

    const res2 = UrlNormalizer.normalize('HTTPS://Docs.Example.COM:443/guide/start');
    expect(res2).toBe('https://docs.example.com/guide/start');
  });

  it('strips URL fragment/hash deterministically', () => {
    const res = UrlNormalizer.normalize('https://example.com/docs/intro#section-1');
    expect(res).toBe('https://example.com/docs/intro');
  });

  it('preserves path case and trailing slash', () => {
    const withSlash = UrlNormalizer.normalize('https://example.com/Docs/API/');
    expect(withSlash).toBe('https://example.com/Docs/API/');

    const withoutSlash = UrlNormalizer.normalize('https://example.com/Docs/API');
    expect(withoutSlash).toBe('https://example.com/Docs/API');
  });

  it('normalizes dot segments in pathname', () => {
    const res = UrlNormalizer.normalize('https://example.com/docs/../docs/guide/./intro');
    expect(res).toBe('https://example.com/docs/guide/intro');
  });

  it('filters and sorts canonicalQueryKeys alphabetically', () => {
    const res = UrlNormalizer.normalize(
      'https://example.com/docs?utm_source=feed&b=2&a=1&c=3&ref=xyz',
      { canonicalQueryKeys: ['b', 'a', 'c'] },
    );
    expect(res).toBe('https://example.com/docs?a=1&b=2&c=3');
  });

  it('removes all query parameters if canonicalQueryKeys is omitted or empty', () => {
    const res1 = UrlNormalizer.normalize('https://example.com/docs?a=1&b=2');
    expect(res1).toBe('https://example.com/docs');

    const res2 = UrlNormalizer.normalize('https://example.com/docs?a=1&b=2', { canonicalQueryKeys: [] });
    expect(res2).toBe('https://example.com/docs');
  });

  it('rejects userinfo (credentials in URL)', () => {
    expect(() => {
      UrlNormalizer.normalize('https://user:password@example.com/docs');
    }).toThrowError(CliOperationError);

    expect(() => {
      UrlNormalizer.normalize('https://admin@example.com/docs');
    }).toThrowError(CliOperationError);
  });

  it('rejects non-standard ports', () => {
    expect(() => {
      UrlNormalizer.normalize('https://example.com:8443/docs');
    }).toThrowError(CliOperationError);

    expect(() => {
      UrlNormalizer.normalize('http://example.com:8080/docs', { allowHttp: true });
    }).toThrowError(CliOperationError);
  });

  it('rejects http when allowHttp is false or not set', () => {
    expect(() => {
      UrlNormalizer.normalize('http://example.com/docs');
    }).toThrowError(CliOperationError);
  });

  it('validates allowedHosts when specified', () => {
    expect(() => {
      UrlNormalizer.normalize('https://malicious.com/docs', {
        allowedHosts: ['www.palantir.com', 'example.com'],
      });
    }).toThrowError(CliOperationError);

    const valid = UrlNormalizer.normalize('https://WWW.PALANTIR.COM/docs', {
      allowedHosts: ['www.palantir.com'],
    });
    expect(valid).toBe('https://www.palantir.com/docs');
  });

  it('correctly matches path patterns with glob wildcards', () => {
    expect(UrlNormalizer.matchesPathPattern('/docs/foundry/intro', '/docs/foundry/**')).toBe(true);
    expect(UrlNormalizer.matchesPathPattern('/docs/foundry/sub/page', '/docs/foundry/**')).toBe(true);
    expect(UrlNormalizer.matchesPathPattern('/docs/foundry/', '/docs/foundry/**')).toBe(true);
    expect(UrlNormalizer.matchesPathPattern('/docs/other/page', '/docs/foundry/**')).toBe(false);

    expect(UrlNormalizer.matchesPathPattern('/docs/foundry/intro', '/docs/foundry/*')).toBe(true);
    expect(UrlNormalizer.matchesPathPattern('/docs/foundry/sub/page', '/docs/foundry/*')).toBe(false);
  });

  it('verifies isPathAllowed with includePaths and excludePaths', () => {
    const include = ['/docs/foundry/**'];
    const exclude = ['/docs/foundry/release-notes/archive/**'];

    expect(UrlNormalizer.isPathAllowed('/docs/foundry/getting-started', include, exclude)).toBe(true);
    expect(UrlNormalizer.isPathAllowed('/docs/foundry/release-notes/archive/2020', include, exclude)).toBe(false);
    expect(UrlNormalizer.isPathAllowed('/docs/different/page', include, exclude)).toBe(false);
  });
});
