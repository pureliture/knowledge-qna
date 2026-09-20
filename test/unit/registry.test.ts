/**
 * Unit Tests for Library Registry & Resolution (T-01)
 */

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { YamlLibraryRegistry } from '../../src/infrastructure/config/YamlLibraryRegistry.js';
import { ResolveLibraryUseCase } from '../../src/application/library/resolve-library.js';
import type { LibraryDefinition } from '../../src/domain/models/index.js';
import {
  AmbiguousLibraryError,
  LibraryNotFoundError,
  VersionNotFoundError,
  InvalidRequestError,
} from '../../src/domain/errors.js';

describe('Library Registry & Deterministic Resolution (T-01)', () => {
  const configDir = path.resolve(__dirname, '../../config/libraries');
  const registry = new YamlLibraryRegistry(configDir);
  const resolver = new ResolveLibraryUseCase(registry);

  describe('YamlLibraryRegistry (Storage Port Adapter)', () => {
    it('loads registered libraries from config/libraries', async () => {
      const libs = await registry.listLibraries();
      expect(libs.length).toBeGreaterThanOrEqual(2);
      expect(libs.some((l) => l.id === 'palantir-foundry')).toBe(true);
      expect(libs.some((l) => l.id === 'palantir-aip')).toBe(true);
    });

    it('retrieves library by ID via getLibrary', async () => {
      const lib = await registry.getLibrary('palantir-foundry');
      expect(lib).not.toBeNull();
      expect(lib?.id).toBe('palantir-foundry');
      expect(lib?.name).toBe('Palantir Foundry');

      const nonExistent = await registry.getLibrary('non-existent');
      expect(nonExistent).toBeNull();
    });

    it('throws error when registering duplicate library id in YamlLibraryRegistry', () => {
      const reg = new YamlLibraryRegistry();
      const libDef: LibraryDefinition = {
        schemaVersion: 1,
        id: 'conflict-id',
        name: 'Conflict Lib 1',
        defaultVersionKey: 'v1',
        versions: [{ versionKey: 'v1' }],
      };

      reg.register(libDef);
      expect(() => reg.register(libDef)).toThrow(/Duplicate library id 'conflict-id' in configuration/);
    });
  });

  describe('Deterministic Matching Priority (ResolveLibraryUseCase)', () => {
    it('Priority 1: exact libraryId match returns library immediately', async () => {
      const res = await resolver.execute({ query: 'palantir-foundry' });
      expect(res.libraryId).toBe('palantir-foundry');
      expect(res.name).toBe('Palantir Foundry');
      expect(res.versionKey).toBe('current');
      expect(res.availableVersionKeys).toContain('current');
    });

    it('Priority 1: throws AmbiguousLibraryError when multiple libraries have identical normalized id', async () => {
      const mockLibraries: LibraryDefinition[] = [
        {
          schemaVersion: 1,
          id: 'dup-lib',
          name: 'Duplicate Library A',
          defaultVersionKey: 'current',
          versions: [{ versionKey: 'current' }],
        },
        {
          schemaVersion: 1,
          id: 'dup-lib',
          name: 'Duplicate Library B',
          defaultVersionKey: 'current',
          versions: [{ versionKey: 'current' }],
        },
      ];

      const mockResolver = new ResolveLibraryUseCase({
        listLibraries: async () => mockLibraries,
        getLibrary: async () => null,
      });

      await expect(mockResolver.execute({ query: 'dup-lib' })).rejects.toThrow(AmbiguousLibraryError);

      try {
        await mockResolver.execute({ query: 'dup-lib' });
      } catch (err) {
        expect(err).toBeInstanceOf(AmbiguousLibraryError);
        const amb = err as AmbiguousLibraryError;
        expect(amb.code).toBe('AMBIGUOUS_LIBRARY');
        expect(amb.candidates).toHaveLength(2);
        expect(amb.candidates?.[0]?.name).toBe('Duplicate Library A');
        expect(amb.candidates?.[1]?.name).toBe('Duplicate Library B');
      }
    });

    it('Priority 2: exact alias match resolves uniquely if only 1 matches', async () => {
      const res = await resolver.execute({ query: 'foundry' });
      expect(res.libraryId).toBe('palantir-foundry');
    });

    it('Priority 2: exact alias match throws AMBIGUOUS_LIBRARY when multiple libraries share alias', async () => {
      // Both palantir-foundry and palantir-aip have alias 'palantir'
      await expect(resolver.execute({ query: 'palantir' })).rejects.toThrow(AmbiguousLibraryError);

      try {
        await resolver.execute({ query: 'palantir' });
      } catch (err) {
        expect(err).toBeInstanceOf(AmbiguousLibraryError);
        const ambErr = err as AmbiguousLibraryError;
        expect(ambErr.code).toBe('AMBIGUOUS_LIBRARY');
        expect(ambErr.candidates).toBeDefined();
        expect(ambErr.candidates?.length).toBe(2);
        // Ensure candidates are sorted by libraryId
        expect(ambErr.candidates?.[0]?.libraryId).toBe('palantir-aip');
        expect(ambErr.candidates?.[1]?.libraryId).toBe('palantir-foundry');
      }
    });

    it('Priority 3: substring match resolves uniquely if only 1 matches', async () => {
      const res = await resolver.execute({ query: 'found' });
      expect(res.libraryId).toBe('palantir-foundry');
    });

    it('Priority 4: unknown query throws LIBRARY_NOT_FOUND', async () => {
      await expect(resolver.execute({ query: 'completely-unknown-library-xyz' })).rejects.toThrow(
        LibraryNotFoundError,
      );

      try {
        await resolver.execute({ query: 'completely-unknown-library-xyz' });
      } catch (err) {
        expect(err).toBeInstanceOf(LibraryNotFoundError);
        expect((err as LibraryNotFoundError).code).toBe('LIBRARY_NOT_FOUND');
      }
    });
  });

  describe('Version Key Resolution', () => {
    it('resolves defaultVersionKey when version is omitted', async () => {
      const res = await resolver.execute({ query: 'foundry' });
      expect(res.versionKey).toBe('current');
    });

    it('resolves explicit valid versionKey', async () => {
      const res = await resolver.execute({ query: 'foundry', versionKey: 'current' });
      expect(res.versionKey).toBe('current');
    });

    it('throws VERSION_NOT_FOUND when requested version is not declared', async () => {
      await expect(resolver.execute({ query: 'foundry', versionKey: 'v99.0.0' })).rejects.toThrow(VersionNotFoundError);

      try {
        await resolver.execute({ query: 'foundry', versionKey: 'v99.0.0' });
      } catch (err) {
        expect(err).toBeInstanceOf(VersionNotFoundError);
        const verErr = err as VersionNotFoundError;
        expect(verErr.code).toBe('VERSION_NOT_FOUND');
        expect(verErr.message).toContain('v99.0.0');
        expect(verErr.message).toContain('current');
      }
    });
  });

  describe('Input Validation', () => {
    it('throws InvalidRequestError for empty query', async () => {
      await expect(resolver.execute({ query: '' })).rejects.toThrow(InvalidRequestError);
      await expect(resolver.execute({ query: '   ' })).rejects.toThrow(InvalidRequestError);
    });

    it('throws InvalidRequestError for query exceeding 200 characters', async () => {
      const longQuery = 'a'.repeat(201);
      await expect(resolver.execute({ query: longQuery })).rejects.toThrow(InvalidRequestError);
    });
  });
});
