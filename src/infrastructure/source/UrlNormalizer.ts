/**
 * UrlNormalizer
 * WHATWG URL normalization according to Knowledge QnA MCP Design Spec §4.2.
 * Strict Layer Boundary: Infrastructure imports only domain and application/ports.
 */

import { CliOperationError } from '../../domain/errors.js';

export interface UrlNormalizationOptions {
  canonicalQueryKeys?: string[];
  allowedHosts?: string[];
  allowHttp?: boolean;
}

export class UrlNormalizer {
  /**
   * Normalizes a raw URL string using WHATWG URL rules:
   * 1. WHATWG parsing and validation (valid protocol, dot segment normalization)
   * 2. Hostname lowercasing
   * 3. Default port stripping (80 for http, 443 for https)
   * 4. Fragment stripping
   * 5. Userinfo rejection (username/password forbidden)
   * 6. Preserves path case and trailing slash
   * 7. Canonical query parameter filtering and alphabetical sorting
   */
  static normalize(rawUrl: string, options: UrlNormalizationOptions = {}): string {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch (err) {
      throw new CliOperationError({
        code: 'SOURCE_FETCH_FAILED',
        message: `Invalid URL '${rawUrl}': ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // Protocol validation
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new CliOperationError({
        code: 'SOURCE_FETCH_FAILED',
        message: `Unsupported protocol '${parsed.protocol}' for URL '${rawUrl}'. Only HTTP/HTTPS allowed.`,
      });
    }

    if (parsed.protocol === 'http:' && !options.allowHttp) {
      throw new CliOperationError({
        code: 'SOURCE_FETCH_FAILED',
        message: `HTTP protocol disallowed for URL '${rawUrl}'. HTTPS is required unless allowHttp: true is set.`,
      });
    }

    // Userinfo check (username or password must not be present)
    if (parsed.username || parsed.password) {
      throw new CliOperationError({
        code: 'SOURCE_FETCH_FAILED',
        message: `Userinfo (credentials) forbidden in URL '${rawUrl}'.`,
      });
    }

    // Hostname normalization: lowercase
    parsed.hostname = parsed.hostname.toLowerCase();

    // Default port stripping
    if (
      (parsed.protocol === 'http:' && parsed.port === '80') ||
      (parsed.protocol === 'https:' && parsed.port === '443')
    ) {
      parsed.port = '';
    }

    // Non-standard port rejection if specified and not 80/443
    if (parsed.port !== '') {
      const portNum = Number(parsed.port);
      if (
        (parsed.protocol === 'http:' && portNum !== 80) ||
        (parsed.protocol === 'https:' && portNum !== 443)
      ) {
        throw new CliOperationError({
          code: 'SOURCE_FETCH_FAILED',
          message: `Non-standard port '${parsed.port}' forbidden in URL '${rawUrl}'.`,
        });
      }
    }

    // Strip fragment
    parsed.hash = '';

    // Allowed hosts check
    if (options.allowedHosts && options.allowedHosts.length > 0) {
      const isAllowed = options.allowedHosts.some(
        (h) => h.toLowerCase() === parsed.hostname,
      );
      if (!isAllowed) {
        throw new CliOperationError({
          code: 'SOURCE_FETCH_FAILED',
          message: `Host '${parsed.hostname}' is not in allowedHosts: [${options.allowedHosts.join(', ')}]`,
        });
      }
    }

    // Canonical query keys sorting
    if (options.canonicalQueryKeys && options.canonicalQueryKeys.length > 0) {
      const allowedKeys = new Set(options.canonicalQueryKeys);
      const entries: Array<[string, string]> = [];

      for (const [key, val] of parsed.searchParams.entries()) {
        if (allowedKeys.has(key)) {
          entries.push([key, val]);
        }
      }

      // Sort alphabetically by key
      entries.sort((a, b) => a[0].localeCompare(b[0]));

      // Clear search and append sorted entries
      parsed.search = '';
      for (const [k, v] of entries) {
        parsed.searchParams.append(k, v);
      }
    } else {
      // If canonicalQueryKeys is undefined or empty, strip all query parameters
      parsed.search = '';
    }

    return parsed.toString();
  }

  /**
   * Matches a path against a glob pattern.
   * Supports `**` for arbitrary subpaths and `*` for single path segments.
   */
  static matchesPathPattern(pathname: string, pattern: string): boolean {
    if (pattern === pathname) return true;

    // Build regex from pattern
    let regexStr = '^';
    let i = 0;
    while (i < pattern.length) {
      const c = pattern[i];
      if (c === '*' && pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          regexStr += '(?:.*?/)?';
          i += 3;
        } else {
          regexStr += '.*';
          i += 2;
        }
      } else if (c === '*') {
        regexStr += '[^/]*';
        i++;
      } else if (['.', '+', '?', '^', '$', '(', ')', '[', ']', '{', '}', '|', '\\'].includes(c!)) {
        regexStr += '\\' + c;
        i++;
      } else {
        regexStr += c;
        i++;
      }
    }
    regexStr += '$';

    const regex = new RegExp(regexStr);
    return regex.test(pathname);
  }

  /**
   * Verifies if a URL's pathname satisfies includePaths and excludePaths rules.
   */
  static isPathAllowed(
    pathname: string,
    includePaths: string[] = [],
    excludePaths: string[] = [],
  ): boolean {
    // Must match at least one includePath (if any specified)
    if (includePaths.length > 0) {
      const matchesInclude = includePaths.some((p) => this.matchesPathPattern(pathname, p));
      if (!matchesInclude) {
        return false;
      }
    }

    // Must NOT match any excludePath
    if (excludePaths.length > 0) {
      const matchesExclude = excludePaths.some((p) => this.matchesPathPattern(pathname, p));
      if (matchesExclude) {
        return false;
      }
    }

    return true;
  }
}
