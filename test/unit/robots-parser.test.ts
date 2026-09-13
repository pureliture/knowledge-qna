import { describe, it, expect } from 'vitest';
import { RobotsParser } from '../../src/infrastructure/source/RobotsParser.js';

describe('RobotsParser Unit Tests', () => {
  it('parses user-agent * rules and disallow paths', () => {
    const robotsTxt = `
      User-agent: *
      Disallow: /admin/
      Disallow: /private
      Allow: /private/public-doc
      Sitemap: https://example.com/sitemap.xml
    `;

    const parser = RobotsParser.parse(robotsTxt);
    expect(parser.isAllowed('/docs/intro')).toBe(true);
    expect(parser.isAllowed('/admin/dashboard')).toBe(false);
    expect(parser.isAllowed('/private/secret')).toBe(false);
    expect(parser.isAllowed('/private/public-doc')).toBe(true); // More specific allow wins
    expect(parser.getSitemaps()).toEqual(['https://example.com/sitemap.xml']);
  });

  it('prefers docsctx specific user-agent over wildcard *', () => {
    const robotsTxt = `
      User-agent: *
      Disallow: /docs/

      User-agent: docsctx
      Allow: /docs/
      Disallow: /docs/internal/
    `;

    const parser = RobotsParser.parse(robotsTxt);
    expect(parser.isAllowed('/docs/public-guide')).toBe(true);
    expect(parser.isAllowed('/docs/internal/secret')).toBe(false);
  });

  it('handles empty Disallow as allowing everything', () => {
    const robotsTxt = `
      User-agent: *
      Disallow:
    `;

    const parser = RobotsParser.parse(robotsTxt);
    expect(parser.isAllowed('/anything')).toBe(true);
  });
});
