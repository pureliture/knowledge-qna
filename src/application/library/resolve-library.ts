/**
 * ResolveLibrary Use Case
 * Implements deterministic local string matching (No LLM in path).
 * Strict Application Layer: Zero Node I/O, Zero Infrastructure/Interfaces imports.
 */

import type { LibraryRegistry } from '../ports/LibraryRegistry.js';
import type { ResolvedLibrary, LibraryDefinition } from '../../domain/models/index.js';
import {
  InvalidRequestError,
  LibraryNotFoundError,
  AmbiguousLibraryError,
  VersionNotFoundError,
} from '../../domain/errors.js';

export interface ResolveLibraryInput {
  query: string;
  versionKey?: string;
}

export function normalizeComparisonString(str: string): string {
  return str.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
}

export class ResolveLibraryUseCase {
  constructor(private readonly registry: LibraryRegistry) {}

  async execute(input: ResolveLibraryInput): Promise<ResolvedLibrary> {
    const rawQuery = input.query ? input.query.trim() : '';
    if (rawQuery.length < 1 || rawQuery.length > 200) {
      throw new InvalidRequestError(
        `Invalid query length: query must be between 1 and 200 characters (got ${rawQuery.length}).`,
      );
    }

    const normQuery = normalizeComparisonString(rawQuery);
    const libraries = await this.registry.listLibraries();

    // 1. Exact libraryId match
    const idMatches = libraries.filter(
      (lib) => normalizeComparisonString(lib.id) === normQuery,
    );
    if (idMatches.length === 1 && idMatches[0]) {
      return this.resolveVersion(idMatches[0], input.versionKey);
    }
    if (idMatches.length > 1) {
      const candidates = idMatches
        .map((l) => ({ libraryId: l.id, name: l.name }))
        .sort((a, b) => a.libraryId.localeCompare(b.libraryId) || a.name.localeCompare(b.name));
      throw new AmbiguousLibraryError(rawQuery, candidates);
    }

    // 2. Exact name or alias match
    const exactNameOrAliasMatches = libraries.filter((lib) => {
      if (normalizeComparisonString(lib.name) === normQuery) return true;
      if (lib.aliases && lib.aliases.some((a) => normalizeComparisonString(a) === normQuery)) {
        return true;
      }
      return false;
    });

    if (exactNameOrAliasMatches.length === 1 && exactNameOrAliasMatches[0]) {
      return this.resolveVersion(exactNameOrAliasMatches[0], input.versionKey);
    }
    if (exactNameOrAliasMatches.length > 1) {
      const candidates = exactNameOrAliasMatches
        .map((l) => ({ libraryId: l.id, name: l.name }))
        .sort((a, b) => a.libraryId.localeCompare(b.libraryId) || a.name.localeCompare(b.name));
      throw new AmbiguousLibraryError(rawQuery, candidates);
    }

    // 3. Substring match in name or aliases
    const substringMatches = libraries.filter((lib) => {
      if (normalizeComparisonString(lib.name).includes(normQuery)) return true;
      if (lib.aliases && lib.aliases.some((a) => normalizeComparisonString(a).includes(normQuery))) {
        return true;
      }
      return false;
    });

    if (substringMatches.length === 1 && substringMatches[0]) {
      return this.resolveVersion(substringMatches[0], input.versionKey);
    }
    if (substringMatches.length > 1) {
      const candidates = substringMatches
        .map((l) => ({ libraryId: l.id, name: l.name }))
        .sort((a, b) => a.libraryId.localeCompare(b.libraryId) || a.name.localeCompare(b.name));
      throw new AmbiguousLibraryError(rawQuery, candidates);
    }

    // 4. No matches found
    throw new LibraryNotFoundError(rawQuery);
  }

  private resolveVersion(library: LibraryDefinition, requestedVersion?: string): ResolvedLibrary {
    const availableVersionKeys = library.versions.map((v) => v.versionKey);

    let versionKey: string;
    if (requestedVersion !== undefined && requestedVersion.trim().length > 0) {
      const trimmedVer = requestedVersion.trim();
      if (!availableVersionKeys.includes(trimmedVer)) {
        throw new VersionNotFoundError(library.id, trimmedVer, availableVersionKeys);
      }
      versionKey = trimmedVer;
    } else {
      versionKey = library.defaultVersionKey;
    }

    return {
      libraryId: library.id,
      name: library.name,
      versionKey,
      availableVersionKeys,
    };
  }
}
