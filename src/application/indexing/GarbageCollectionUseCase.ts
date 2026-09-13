/**
 * GarbageCollectionUseCase
 * Cleans up retired or abandoned index generations older than minAgeMs.
 * Enforces strict safety rules:
 * 1. Current published generation is protected against GC.
 * 2. Previous generation (previousGenerationId on published pointer) is protected against GC.
 * 3. Generations with active read leases are protected against GC.
 * 4. Staging / importing / verifying / readiness_pending runs are protected.
 * 5. Requires writer lease fencing for mutation.
 * 6. Defaults to dry-run; requires apply: true for physical deletion.
 *
 * Strict Application Layer: Zero Node I/O, Zero Infrastructure/Interfaces imports.
 */

import type { LibraryRegistry } from '../ports/LibraryRegistry.js';
import type { ManifestStore, WriterLease } from '../ports/ManifestStore.js';
import type { IndexBackend } from '../ports/IndexBackend.js';
import type { IndexGeneration } from '../../domain/models/index.js';
import {
  InvalidRequestError,
  LibraryNotFoundError,
  VersionNotFoundError,
  CliOperationError,
} from '../../domain/errors.js';

export interface GcInput {
  libraryId?: string;
  versionKey?: string;
  apply?: boolean;
  minAgeHours?: number; // default 24 hours
}

export interface GcResult {
  dryRun: boolean;
  scannedGenerations: number;
  eligibleGenerations: string[];
  deletedGenerations: string[];
  deletedEntriesCount: number;
  failedGenerations: string[];
}

const ID_REGEX = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export class GarbageCollectionUseCase {
  constructor(
    private readonly registry: LibraryRegistry,
    private readonly manifestStore: ManifestStore,
    private readonly indexBackend: IndexBackend,
    private readonly backendKey: string,
  ) {}

  async execute(input: GcInput = {}): Promise<GcResult> {
    const isApply = Boolean(input.apply);
    const minAgeHours = input.minAgeHours ?? 24;
    if (minAgeHours < 0) {
      throw new InvalidRequestError(`Invalid minAgeHours: ${minAgeHours}. Must be non-negative.`);
    }
    const minAgeMs = minAgeHours * 60 * 60 * 1000;

    // 1. Resolve target library/version scopes
    const scopes: Array<{ libraryId: string; versionKey: string }> = [];

    if (input.libraryId) {
      if (!ID_REGEX.test(input.libraryId)) {
        throw new InvalidRequestError(
          `Invalid libraryId: '${input.libraryId}'. Must match pattern ^[a-z0-9][a-z0-9._-]{0,63}$`,
        );
      }
      const lib = await this.registry.getLibrary(input.libraryId);
      if (!lib) {
        throw new LibraryNotFoundError(input.libraryId);
      }

      if (input.versionKey) {
        if (!ID_REGEX.test(input.versionKey)) {
          throw new InvalidRequestError(
            `Invalid versionKey: '${input.versionKey}'. Must match pattern ^[a-z0-9][a-z0-9._-]{0,63}$`,
          );
        }
        const available = lib.versions.map((v) => v.versionKey);
        if (!available.includes(input.versionKey)) {
          throw new VersionNotFoundError(lib.id, input.versionKey, available);
        }
        scopes.push({ libraryId: lib.id, versionKey: input.versionKey });
      } else {
        for (const v of lib.versions) {
          scopes.push({ libraryId: lib.id, versionKey: v.versionKey });
        }
      }
    } else {
      const allLibs = await this.registry.listLibraries();
      for (const lib of allLibs) {
        for (const v of lib.versions) {
          scopes.push({ libraryId: lib.id, versionKey: v.versionKey });
        }
      }
    }

    // 2. Acquire writer lease if apply is requested
    let lease: WriterLease | null = null;
    if (isApply && this.manifestStore.acquireWriterLease) {
      lease = await this.manifestStore.acquireWriterLease('gc-writer', 30000);
      if (!lease) {
        throw new CliOperationError({
          code: 'RESOURCE_BUSY',
          message: 'Failed to acquire writer lease for GC: another writer is currently active.',
          exitCode: 1,
        });
      }
    }

    try {
      let totalScanned = 0;
      const eligibleGens: IndexGeneration[] = [];

      for (const scope of scopes) {
        const allGens = await this.manifestStore.listIndexGenerations(
          scope.libraryId,
          scope.versionKey,
          this.backendKey,
        );
        totalScanned += allGens.length;

        const eligible = await this.manifestStore.listEligibleGenerationsForGc(
          scope.libraryId,
          scope.versionKey,
          minAgeMs,
          this.backendKey,
        );
        eligibleGens.push(...eligible);
      }

      const eligibleIds = eligibleGens.map((g) => g.generationId);

      // If dry-run, return planned summary without mutations
      if (!isApply) {
        return {
          dryRun: true,
          scannedGenerations: totalScanned,
          eligibleGenerations: eligibleIds,
          deletedGenerations: [],
          deletedEntriesCount: 0,
          failedGenerations: [],
        };
      }

      // Execute physical deletion for each eligible generation
      const deletedGenerations: string[] = [];
      const failedGenerations: string[] = [];
      let deletedEntriesCount = 0;

      for (const gen of eligibleGens) {
        try {
          // Transition to 'deleting' state first
          await this.manifestStore.saveIndexGeneration({
            ...gen,
            state: 'deleting',
            updatedAt: new Date().toISOString(),
          });

          // Delete from search backend
          await this.indexBackend.deleteGeneration(gen.generationId, undefined, gen.entryIds);

          // Transition to 'deleted' state
          await this.manifestStore.saveIndexGeneration({
            ...gen,
            state: 'deleted',
            updatedAt: new Date().toISOString(),
          });

          deletedGenerations.push(gen.generationId);
          deletedEntriesCount += gen.entryCount;
        } catch {
          failedGenerations.push(gen.generationId);
        }
      }

      return {
        dryRun: false,
        scannedGenerations: totalScanned,
        eligibleGenerations: eligibleIds,
        deletedGenerations,
        deletedEntriesCount,
        failedGenerations,
      };
    } finally {
      if (lease && this.manifestStore.releaseWriterLease) {
        await this.manifestStore
          .releaseWriterLease(lease.ownerId, lease.fencingToken)
          .catch(() => {});
      }
    }
  }
}
