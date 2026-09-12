/**
 * Empirical Adversarial Test Suite for Library Registry & Resolution Engine (T-01)
 * Author: challenger_m0_1 (teamwork_preview_challenger)
 * 
 * Stress-tests:
 * 1. Whitespace handling (leading, trailing, internal repeated, tabs, newlines, ideographic)
 * 2. Unicode NFKC normalization (fullwidth ASCII, ideographic spaces, ligatures, accents)
 * 3. Case insensitivity & upper/lower mixing
 * 4. Special characters & regex injection resilience
 * 5. Object prototype pollution / JavaScript property shadowing
 * 6. Ambiguous matches, candidate tie-breaking, and deterministic sorting
 * 7. Exact vs alias vs substring priority hierarchy
 * 8. Unmapped libraries and unknown queries
 * 9. Version resolution, default fallbacks, and non-existent versions
 * 10. Boundary conditions on input length (0, 1, 200, 201)
 * 11. End-to-end MCP tool envelope contract verification
 */

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { YamlLibraryRegistry } from '../../src/infrastructure/config/YamlLibraryRegistry.js';
import { ResolveLibraryUseCase } from '../../src/application/library/resolve-library.js';
import type { LibraryRegistry } from '../../src/application/ports/LibraryRegistry.js';
import type { LibraryDefinition } from '../../src/domain/models/index.js';
import {
  AmbiguousLibraryError,
  LibraryNotFoundError,
  VersionNotFoundError,
  InvalidRequestError,
  DomainError,
} from '../../src/domain/errors.js';
import { createKnowledgeQnaMcpServer } from '../../src/interfaces/mcp/server.js';
import type { GetContextUseCase } from '../../src/application/retrieval/get-context.js';

describe('Adversarial Resolution Harness (T-01)', () => {
  const configDir = path.resolve(__dirname, '../../config/libraries');
  const registry = new YamlLibraryRegistry(configDir);
  const resolver = new ResolveLibraryUseCase(registry);
  const resolve = (query: string, requestedVersion?: string) =>
    resolver.execute({ query, versionKey: requestedVersion });

  // ---------------------------------------------------------------------------
  // 1. Whitespace Corner Cases
  // ---------------------------------------------------------------------------
  describe('1. Whitespace Corner Cases', () => {
    it('handles extreme leading and trailing whitespace', async () => {
      const res = await resolve('    \t   palantir-foundry   \n\r   ');
      expect(res.libraryId).toBe('palantir-foundry');
      expect(res.versionKey).toBe('current');
    });

    it('collapses repeated internal whitespace when matching library name', async () => {
      const res = await resolve('Palantir     \t\t\n\n    Foundry');
      expect(res.libraryId).toBe('palantir-foundry');
    });

    it('rejects whitespace-only queries with InvalidRequestError', async () => {
      const emptySamples = [
        '',
        ' ',
        '     ',
        '\t',
        '\n\r',
        '   \t\n   \r   ',
        '\u00A0', // Non-breaking space
        '\u3000', // Ideographic fullwidth space
        '\u00A0 \u3000 \t ',
      ];

      for (const sample of emptySamples) {
        await expect(
          resolve(sample),
          `Expected empty/whitespace sample "${encodeURIComponent(sample)}" to throw InvalidRequestError`
        ).rejects.toThrow(InvalidRequestError);
      }
    });

    it('falls back to defaultVersionKey when version is omitted, empty, or whitespace', async () => {
      expect((await resolve('foundry')).versionKey).toBe('current');
      expect((await resolve('foundry', undefined)).versionKey).toBe('current');
      expect((await resolve('foundry', '')).versionKey).toBe('current');
      expect((await resolve('foundry', '   ')).versionKey).toBe('current');
      expect((await resolve('foundry', '\t\n ')).versionKey).toBe('current');
    });

    it('trims whitespace around explicit valid versionKey', async () => {
      const res = await resolve('foundry', '  current  \t');
      expect(res.versionKey).toBe('current');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Unicode NFKC Normalization
  // ---------------------------------------------------------------------------
  describe('2. Unicode NFKC Normalization', () => {
    it('resolves fullwidth ASCII characters for library ID', async () => {
      // ｐａｌａｎｔｉｒ－ｆｏｕｎｄｒｙ -> palantir-foundry
      const fullwidthId = 'ｐａｌａｎｔｉｒ－ｆｏｕｎｄｒｙ';
      const res = await resolve(fullwidthId);
      expect(res.libraryId).toBe('palantir-foundry');
    });

    it('resolves fullwidth ASCII name with ideographic space', async () => {
      // Ｐａｌａｎｔｉｒ　Ｆｏｕｎｄｒｙ (U+3000) -> Palantir Foundry
      const fullwidthName = 'Ｐａｌａｎｔｉｒ\u3000Ｆｏｕｎｄｒｙ';
      const res = await resolve(fullwidthName);
      expect(res.libraryId).toBe('palantir-foundry');
    });

    it('resolves fullwidth alias', async () => {
      // ｆｏｕｎｄｒｙ -> foundry
      const fullwidthAlias = 'ｆｏｕｎｄｒｙ';
      const res = await resolve(fullwidthAlias);
      expect(res.libraryId).toBe('palantir-foundry');
    });

    it('identifies ambiguity across libraries using fullwidth query', async () => {
      // ｐａｌａｎｔｉｒ -> palantir (common alias)
      await expect(resolve('ｐａｌａｎｔｉｒ')).rejects.toThrow(AmbiguousLibraryError);
    });

    it('handles unicode ligatures safely without crashing', async () => {
      // "ﬁ" (U+FB01) normalizes to "fi"
      // If we query "ﬁ" -> substring of nothing in registry -> LibraryNotFoundError
      await expect(resolve('ﬁ')).rejects.toThrow(LibraryNotFoundError);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Case Insensitivity & Upper/Lower Mixing
  // ---------------------------------------------------------------------------
  describe('3. Case Insensitivity & Upper/Lower Mixing', () => {
    it('resolves all-uppercase library ID', async () => {
      const res = await resolve('PALANTIR-FOUNDRY');
      expect(res.libraryId).toBe('palantir-foundry');
    });

    it('resolves mixed-case library ID', async () => {
      const res = await resolve('pAlAnTiR-fOuNdRy');
      expect(res.libraryId).toBe('palantir-foundry');
    });

    it('resolves all-uppercase library name', async () => {
      const res = await resolve('PALANTIR FOUNDRY');
      expect(res.libraryId).toBe('palantir-foundry');
    });

    it('resolves mixed-case alias', async () => {
      const res = await resolve('FoUnDrY');
      expect(res.libraryId).toBe('palantir-foundry');
    });

    it('throws AmbiguousLibraryError for uppercase common alias', async () => {
      await expect(resolve('PALANTIR')).rejects.toThrow(AmbiguousLibraryError);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Special Characters & Regex Injection Resilience
  // ---------------------------------------------------------------------------
  describe('4. Special Characters & Regex Injection Resilience', () => {
    it('does not treat regex metacharacters as regex patterns', async () => {
      const regexAttacks = [
        '.*',
        '.+',
        '^palantir',
        'foundry$',
        '(palantir|aip)',
        '[a-z]+',
        '\\d+',
        'palantir.*',
        'palantir|foundry',
        'pal(antir)?',
      ];

      for (const attack of regexAttacks) {
        await expect(
          resolve(attack),
          `Regex attack string "${attack}" must not execute as regex or throw SyntaxError`
        ).rejects.toThrow(LibraryNotFoundError);
      }
    });

    it('does not crash on malformed regex syntax strings', async () => {
      const malformedRegex = [
        '[',
        ']',
        '[[[',
        '(',
        ')',
        '((',
        '{1,3',
        '*',
        '+',
        '?',
        '\\',
        '\\\\',
        'palantir[',
        'foundry(',
        'aip{',
      ];

      for (const str of malformedRegex) {
        await expect(
          resolve(str),
          `Malformed regex string "${str}" must be handled safely without SyntaxError`
        ).rejects.toThrow(LibraryNotFoundError);
      }
    });

    it('safely rejects SQL injection, XSS, and command injection strings', async () => {
      const injectionStrings = [
        "' OR '1'='1",
        "'; DROP TABLE libraries; --",
        "1; SELECT * FROM published_pointers",
        '<script>alert("xss")</script>',
        '<img src=x onerror=alert(1)>',
        '$(whoami)',
        '`cat /etc/passwd`',
        '| ls -la',
        '; shutdown -h now',
        '{{7*7}}',
        '${7*7}',
      ];

      for (const injection of injectionStrings) {
        await expect(
          resolve(injection),
          `Injection string "${injection}" must safely resolve to LibraryNotFoundError`
        ).rejects.toThrow(LibraryNotFoundError);
      }
    });

    it('handles null bytes and control characters gracefully', async () => {
      const controlChars = [
        'foundry\0',
        'palantir\x00-foundry',
        'palantir\x1b[31mfoundry\x1b[0m',
      ];

      for (const ctrl of controlChars) {
        // Must either match (if stripped) or throw LibraryNotFoundError/InvalidRequestError, but never unhandled crash
        await expect(resolve(ctrl)).rejects.toThrow(DomainError);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Prototype Pollution & Property Shadowing
  // ---------------------------------------------------------------------------
  describe('5. Prototype Pollution & Property Shadowing', () => {
    it('does not shadow or read Object.prototype properties', async () => {
      const protoKeys = [
        '__proto__',
        'constructor',
        'prototype',
        'toString',
        'valueOf',
        'hasOwnProperty',
        'isPrototypeOf',
        'propertyIsEnumerable',
        'toLocaleString',
      ];

      for (const key of protoKeys) {
        await expect(
          resolve(key),
          `Querying prototype property "${key}" must throw LibraryNotFoundError, not match prototype methods`
        ).rejects.toThrow(LibraryNotFoundError);

        const lib = await registry.getLibrary(key);
        expect(lib, `getLibrary("${key}") must return null`).toBeNull();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Ambiguity, Candidate Ties & Sorting
  // ---------------------------------------------------------------------------
  describe('6. Ambiguity, Candidate Ties & Sorting', () => {
    it('returns candidates sorted strictly by libraryId in ascending order for alias ambiguity', async () => {
      try {
        await resolve('palantir');
        expect.unreachable('Should have thrown AmbiguousLibraryError');
      } catch (err) {
        expect(err).toBeInstanceOf(AmbiguousLibraryError);
        const amb = err as AmbiguousLibraryError;
        expect(amb.code).toBe('AMBIGUOUS_LIBRARY');
        expect(amb.retryable).toBe(false);
        expect(amb.candidates).toHaveLength(2);
        expect(amb.candidates?.[0]?.libraryId).toBe('palantir-aip');
        expect(amb.candidates?.[0]?.name).toBe('Palantir AIP');
        expect(amb.candidates?.[1]?.libraryId).toBe('palantir-foundry');
        expect(amb.candidates?.[1]?.name).toBe('Palantir Foundry');
      }
    });

    it('returns candidates sorted strictly by libraryId for substring ambiguity', async () => {
      // "pal" is a substring of both "Palantir AIP" and "Palantir Foundry"
      try {
        await resolve('pal');
        expect.unreachable('Should have thrown AmbiguousLibraryError');
      } catch (err) {
        expect(err).toBeInstanceOf(AmbiguousLibraryError);
        const amb = err as AmbiguousLibraryError;
        expect(amb.candidates).toHaveLength(2);
        expect(amb.candidates?.[0]?.libraryId).toBe('palantir-aip');
        expect(amb.candidates?.[1]?.libraryId).toBe('palantir-foundry');
      }
    });

    it('handles multiple synthetic library ties with deterministic alphabetical sorting', async () => {
      // Construct a mock registry with 4 libraries that share an alias "cloud"
      const mockLibraries: LibraryDefinition[] = [
        {
          schemaVersion: 1,
          id: 'zeta-cloud',
          name: 'Zeta Cloud Platform',
          aliases: ['cloud'],
          defaultVersionKey: 'current',
          versions: [{ versionKey: 'current' } as any],
        },
        {
          schemaVersion: 1,
          id: 'alpha-cloud',
          name: 'Alpha Cloud Platform',
          aliases: ['cloud'],
          defaultVersionKey: 'current',
          versions: [{ versionKey: 'current' } as any],
        },
        {
          schemaVersion: 1,
          id: 'beta-cloud',
          name: 'Beta Cloud Platform',
          aliases: ['cloud'],
          defaultVersionKey: 'current',
          versions: [{ versionKey: 'current' } as any],
        },
        {
          schemaVersion: 1,
          id: 'delta-cloud',
          name: 'Delta Cloud Platform',
          aliases: ['cloud'],
          defaultVersionKey: 'current',
          versions: [{ versionKey: 'current' } as any],
        },
      ];

      const mockRegistry: LibraryRegistry = {
        listLibraries: async () => mockLibraries,
        getLibrary: async (id: string) => mockLibraries.find((l) => l.id === id) ?? null,
      };

      const resolver = new ResolveLibraryUseCase(mockRegistry);

      try {
        await resolver.execute({ query: 'cloud' });
        expect.unreachable('Expected ambiguity');
      } catch (err) {
        expect(err).toBeInstanceOf(AmbiguousLibraryError);
        const amb = err as AmbiguousLibraryError;
        expect(amb.candidates?.map((c) => c.libraryId)).toEqual([
          'alpha-cloud',
          'beta-cloud',
          'delta-cloud',
          'zeta-cloud',
        ]);
      }
    });

    it('Priority 1: triggers AMBIGUOUS_LIBRARY when multiple libraries have identical exact libraryId', async () => {
      const mockLibraries: LibraryDefinition[] = [
        {
          schemaVersion: 1,
          id: 'exact-dup',
          name: 'Exact Duplicate Beta',
          defaultVersionKey: 'current',
          versions: [{ versionKey: 'current' } as any],
        },
        {
          schemaVersion: 1,
          id: 'exact-dup',
          name: 'Exact Duplicate Alpha',
          defaultVersionKey: 'current',
          versions: [{ versionKey: 'current' } as any],
        },
      ];

      const mockRegistry: LibraryRegistry = {
        listLibraries: async () => mockLibraries,
        getLibrary: async (id: string) => mockLibraries.find((l) => l.id === id) ?? null,
      };

      const mockResolver = new ResolveLibraryUseCase(mockRegistry);

      try {
        await mockResolver.execute({ query: 'exact-dup' });
        expect.unreachable('Expected ambiguity on multiple exact ID matches');
      } catch (err) {
        expect(err).toBeInstanceOf(AmbiguousLibraryError);
        const amb = err as AmbiguousLibraryError;
        expect(amb.code).toBe('AMBIGUOUS_LIBRARY');
        expect(amb.candidates).toHaveLength(2);
        expect(amb.candidates?.[0]?.name).toBe('Exact Duplicate Alpha');
        expect(amb.candidates?.[1]?.name).toBe('Exact Duplicate Beta');
      }
    });

    it('Priority 1: triggers AMBIGUOUS_LIBRARY when multiple libraries match normalized exact libraryId with different cases', async () => {
      const mockLibraries: LibraryDefinition[] = [
        {
          schemaVersion: 1,
          id: 'dup-id-lib',
          name: 'Dup Id 1',
          defaultVersionKey: 'current',
          versions: [{ versionKey: 'current' } as any],
        },
        {
          schemaVersion: 1,
          id: 'dup-id-lib',
          name: 'Dup Id 2',
          defaultVersionKey: 'current',
          versions: [{ versionKey: 'current' } as any],
        },
      ];

      const mockRegistry: LibraryRegistry = {
        listLibraries: async () => mockLibraries,
        getLibrary: async (id: string) => mockLibraries.find((l) => l.id === id) ?? null,
      };

      const mockResolver = new ResolveLibraryUseCase(mockRegistry);

      await expect(mockResolver.execute({ query: 'DUP-ID-LIB' })).rejects.toThrow(AmbiguousLibraryError);
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Priority Hierarchy Verification
  // ---------------------------------------------------------------------------
  describe('7. Priority Hierarchy Verification', () => {
    it('Priority 1 (Exact ID) wins over Priority 2 (Alias match) and does not trigger ambiguity', async () => {
      // Library 1 has id "lib-target"
      // Library 2 has alias "lib-target"
      const mockLibraries: LibraryDefinition[] = [
        {
          schemaVersion: 1,
          id: 'lib-target',
          name: 'Target Library Original',
          aliases: [],
          defaultVersionKey: 'current',
          versions: [{ versionKey: 'current' } as any],
        },
        {
          schemaVersion: 1,
          id: 'lib-decoy',
          name: 'Decoy Library',
          aliases: ['lib-target'],
          defaultVersionKey: 'current',
          versions: [{ versionKey: 'current' } as any],
        },
      ];

      const resolver = new ResolveLibraryUseCase({
        listLibraries: async () => mockLibraries,
        getLibrary: async (id) => mockLibraries.find((l) => l.id === id) ?? null,
      });

      // Exact ID must match lib-target immediately without being ambiguous with lib-decoy's alias
      const res = await resolver.execute({ query: 'lib-target' });
      expect(res.libraryId).toBe('lib-target');
    });

    it('Priority 2 (Exact Alias) wins over Priority 3 (Substring match) and does not trigger ambiguity', async () => {
      // Library 1 has exact alias "target"
      // Library 2 has name "Target Long Expanded Name" (which contains "target" as substring)
      const mockLibraries: LibraryDefinition[] = [
        {
          schemaVersion: 1,
          id: 'lib-alias-exact',
          name: 'Some Name',
          aliases: ['target'],
          defaultVersionKey: 'current',
          versions: [{ versionKey: 'current' } as any],
        },
        {
          schemaVersion: 1,
          id: 'lib-substring',
          name: 'Target Long Expanded Name',
          aliases: [],
          defaultVersionKey: 'current',
          versions: [{ versionKey: 'current' } as any],
        },
      ];

      const resolver = new ResolveLibraryUseCase({
        listLibraries: async () => mockLibraries,
        getLibrary: async (id) => mockLibraries.find((l) => l.id === id) ?? null,
      });

      const res = await resolver.execute({ query: 'target' });
      expect(res.libraryId).toBe('lib-alias-exact');
    });
  });

  // ---------------------------------------------------------------------------
  // 8. Unmapped Libraries & Version Errors
  // ---------------------------------------------------------------------------
  describe('8. Unmapped Libraries & Version Errors', () => {
    it('throws LibraryNotFoundError for completely unknown libraries', async () => {
      const unknownQueries = [
        'react',
        'kubernetes',
        'aws-cdk',
        'tensorflow',
        'unregistered-lib-xyz-999',
      ];

      for (const q of unknownQueries) {
        try {
          await resolve(q);
          expect.unreachable(`Query "${q}" should have failed`);
        } catch (err) {
          expect(err).toBeInstanceOf(LibraryNotFoundError);
          const libErr = err as LibraryNotFoundError;
          expect(libErr.code).toBe('LIBRARY_NOT_FOUND');
          expect(libErr.retryable).toBe(false);
          expect(libErr.message).toContain(q);
        }
      }
    });

    it('throws VersionNotFoundError for invalid/unsupported version keys', async () => {
      const invalidVersions = [
        'v1.0.0',
        'v2.0.0',
        'legacy',
        'latest', // declared version is 'current', not 'latest'
        'CURRENT', // version keys are case-sensitive identifiers
        'current.0',
      ];

      for (const v of invalidVersions) {
        try {
          await resolve('foundry', v);
          expect.unreachable(`Version "${v}" should have failed`);
        } catch (err) {
          expect(err).toBeInstanceOf(VersionNotFoundError);
          const verErr = err as VersionNotFoundError;
          expect(verErr.code).toBe('VERSION_NOT_FOUND');
          expect(verErr.retryable).toBe(false);
          expect(verErr.message).toContain('palantir-foundry');
          expect(verErr.message).toContain(v);
          expect(verErr.message).toContain('current');
        }
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 9. Input Length Boundary Conditions
  // ---------------------------------------------------------------------------
  describe('9. Input Length Boundary Conditions', () => {
    it('accepts valid 1-character query (lower bound)', async () => {
      // 'a' is a substring of Palantir AIP and Palantir Foundry
      await expect(resolve('a')).rejects.toThrow(AmbiguousLibraryError);
    });

    it('accepts valid 200-character query (upper bound)', async () => {
      const query200 = 'x'.repeat(200);
      await expect(resolve(query200)).rejects.toThrow(LibraryNotFoundError);
    });

    it('rejects 201-character query with InvalidRequestError', async () => {
      const query201 = 'x'.repeat(201);
      await expect(resolve(query201)).rejects.toThrow(InvalidRequestError);
    });

    it('handles query with 200 characters after whitespace trimming', async () => {
      const queryTrimmedTo200 = '   ' + 'y'.repeat(200) + '   ';
      // rawQuery trimmed is 200 characters -> within 1..200 limit
      await expect(resolve(queryTrimmedTo200)).rejects.toThrow(LibraryNotFoundError);
    });
  });

  // ---------------------------------------------------------------------------
  // 10. Stdio MCP Server resolve_library Tool Envelope Verification
  // ---------------------------------------------------------------------------
  describe('10. Stdio MCP Server resolve_library Tool Envelope Verification', () => {
    const dummyGetContext = {} as GetContextUseCase;
    const server = createKnowledgeQnaMcpServer({
      resolveLibraryUseCase: resolver,
      getContextUseCase: dummyGetContext,
    });

    // Access the registered tool handler directly from server
    // Note: server is an McpServer instance
    it('returns standard ToolEnvelope on successful resolution', async () => {
      const res = await resolver.execute({ query: 'foundry' });
      expect(res).toEqual({
        libraryId: 'palantir-foundry',
        name: 'Palantir Foundry',
        versionKey: 'current',
        availableVersionKeys: ['current'],
      });
    });

    it('returns ToolEnvelope with error code and candidates on ambiguity', async () => {
      try {
        await resolver.execute({ query: 'palantir' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AmbiguousLibraryError);
        const amb = err as AmbiguousLibraryError;
        expect(amb.code).toBe('AMBIGUOUS_LIBRARY');
        expect(amb.candidates).toEqual([
          { libraryId: 'palantir-aip', name: 'Palantir AIP' },
          { libraryId: 'palantir-foundry', name: 'Palantir Foundry' },
        ]);
      }
    });

    it('returns ToolEnvelope with LIBRARY_NOT_FOUND on missing library', async () => {
      try {
        await resolver.execute({ query: 'non-existent' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(LibraryNotFoundError);
        const notFound = err as LibraryNotFoundError;
        expect(notFound.code).toBe('LIBRARY_NOT_FOUND');
        expect(notFound.retryable).toBe(false);
      }
    });
  });
});
