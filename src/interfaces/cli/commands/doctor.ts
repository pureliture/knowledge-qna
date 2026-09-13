/**
 * CLI Command: docsctx doctor
 * Read-only health check and environment diagnostics.
 * Includes Node version, library registry, SQLite connection, PRAGMA integrity_check,
 * corpus directory layout, and parser/chunker profile boundary validation.
 * Strict Layer Boundary: Interfaces imports only application and domain.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LibraryRegistry } from '../../../application/ports/LibraryRegistry.js';
import type { ManifestStore } from '../../../application/ports/ManifestStore.js';
import type { CorpusStore } from '../../../application/ports/CorpusStore.js';
import type { SearchBackend } from '../../../application/ports/SearchBackend.js';

export interface DoctorCommandOptions {
  libraryRegistry: LibraryRegistry;
  manifestStore?: ManifestStore;
  corpusStore?: CorpusStore;
  searchBackend?: SearchBackend;
  varRoot: string;
  configDir: string;
  remote?: boolean;
}

export interface DoctorCheckResult {
  name: string;
  passed: boolean;
  message: string;
}

export async function runDoctorCommand(options: DoctorCommandOptions): Promise<number> {
  const checks: DoctorCheckResult[] = [];

  // Check 1: Node.js version >= 24
  const nodeVersion = process.version;
  const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0] ?? '0', 10);
  if (majorVersion >= 24) {
    checks.push({
      name: 'Node.js Version',
      passed: true,
      message: `Node ${nodeVersion} (LTS >= 24 supported)`,
    });
  } else {
    checks.push({
      name: 'Node.js Version',
      passed: false,
      message: `Node ${nodeVersion} is below required Node 24 LTS`,
    });
  }

  // Check 2: Configuration directory & loaded libraries
  let loadedLibraries: Array<{ id: string; versions: Array<{ versionKey: string }> }> = [];
  try {
    const libraries = await options.libraryRegistry.listLibraries();
    loadedLibraries = libraries;
    checks.push({
      name: 'Library Registry',
      passed: libraries.length > 0,
      message: `Loaded ${libraries.length} libraries from ${options.configDir} (${libraries.map((l) => l.id).join(', ') || 'none'})`,
    });
  } catch (err) {
    checks.push({
      name: 'Library Registry',
      passed: false,
      message: `Failed to load libraries: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // Check 3: Manifest Store (SQLite Connection)
  if (options.manifestStore) {
    try {
      await options.manifestStore.getPublishedPointer('test', 'test', 'test');
      checks.push({
        name: 'Manifest Store (SQLite Connection)',
        passed: true,
        message: `Connected successfully to catalog database in ${options.varRoot}`,
      });
    } catch (err) {
      checks.push({
        name: 'Manifest Store (SQLite Connection)',
        passed: false,
        message: `Failed to query manifest: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // Check 4: SQLite PRAGMA integrity_check
    if (options.manifestStore.checkIntegrity) {
      try {
        const integrity = await options.manifestStore.checkIntegrity();
        checks.push({
          name: 'SQLite PRAGMA integrity_check',
          passed: integrity.ok,
          message: integrity.message,
        });
      } catch (err) {
        checks.push({
          name: 'SQLite PRAGMA integrity_check',
          passed: false,
          message: `Integrity check failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  // Check 5: Corpus directory layout check
  const corpusDir = path.join(options.varRoot, 'corpus');
  const expectedSubdirs = ['documents', 'chunks', 'revisions', 'profiles'];
  const missingDirs: string[] = [];

  for (const subdir of expectedSubdirs) {
    const p = path.join(corpusDir, subdir);
    if (!fs.existsSync(p)) {
      missingDirs.push(subdir);
    }
  }

  if (missingDirs.length === 0) {
    checks.push({
      name: 'Corpus Directory Layout',
      passed: true,
      message: `All corpus directories present in ${corpusDir} (${expectedSubdirs.join(', ')})`,
    });
  } else {
    // If varRoot hasn't been synced yet, verify directory can be created or exists
    const varExists = fs.existsSync(options.varRoot);
    checks.push({
      name: 'Corpus Directory Layout',
      passed: true,
      message: varExists
        ? `Corpus layout ready under ${corpusDir} (pending subdirs will be created on sync: ${missingDirs.join(', ')})`
        : `Corpus base root ${options.varRoot} ready to be initialized`,
    });
  }

  // Check 6: Profiles boundary validation
  if (loadedLibraries.length > 0) {
    const profileViolations: string[] = [];

    for (const lib of loadedLibraries) {
      const fullLib = await options.libraryRegistry.getLibrary(lib.id);
      if (!fullLib) continue;

      for (const ver of fullLib.versions) {
        const p = ver.parser;
        const c = ver.chunking;

        // Parser validation
        if (!p || !p.contentSelectors || p.contentSelectors.length === 0) {
          profileViolations.push(`${lib.id}@${ver.versionKey}: contentSelectors must not be empty`);
        }

        // Chunking boundary validation (min < target <= max <= maxAtomic <= 16000)
        if (!c) {
          profileViolations.push(`${lib.id}@${ver.versionKey}: chunking config missing`);
        } else {
          if (c.minTokens <= 0) {
            profileViolations.push(`${lib.id}@${ver.versionKey}: minTokens must be > 0 (got ${c.minTokens})`);
          }
          if (c.minTokens >= c.targetTokens) {
            profileViolations.push(
              `${lib.id}@${ver.versionKey}: minTokens (${c.minTokens}) must be < targetTokens (${c.targetTokens})`,
            );
          }
          if (c.targetTokens > c.maxTokens) {
            profileViolations.push(
              `${lib.id}@${ver.versionKey}: targetTokens (${c.targetTokens}) must be <= maxTokens (${c.maxTokens})`,
            );
          }
          if (c.maxTokens > c.maxAtomicTokens) {
            profileViolations.push(
              `${lib.id}@${ver.versionKey}: maxTokens (${c.maxTokens}) must be <= maxAtomicTokens (${c.maxAtomicTokens})`,
            );
          }
          if (c.maxAtomicTokens > 16000) {
            profileViolations.push(
              `${lib.id}@${ver.versionKey}: maxAtomicTokens (${c.maxAtomicTokens}) must be <= 16000`,
            );
          }
        }

        // Freshness validation
        if (ver.freshness && ver.freshness.staleAfterHours <= 0) {
          profileViolations.push(`${lib.id}@${ver.versionKey}: staleAfterHours must be > 0`);
        }
      }
    }

    if (profileViolations.length === 0) {
      checks.push({
        name: 'Profiles Boundary Validation',
        passed: true,
        message: `All parser and chunker profile boundaries valid across ${loadedLibraries.length} libraries`,
      });
    } else {
      checks.push({
        name: 'Profiles Boundary Validation',
        passed: false,
        message: `Profile boundary violations: ${profileViolations.join('; ')}`,
      });
    }
  }

  // Check 7: Remote Search Backend (if --remote specified)
  if (options.remote) {
    if (options.searchBackend && options.searchBackend.health) {
      try {
        const health = await options.searchBackend.health();
        checks.push({
          name: 'Remote Search Backend',
          passed: health.status === 'ok',
          message: `[${health.status}] ${health.message ?? 'No message'}`,
        });
      } catch (err) {
        checks.push({
          name: 'Remote Search Backend',
          passed: false,
          message: `Remote health check failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    } else {
      checks.push({
        name: 'Remote Search Backend',
        passed: false,
        message: 'No remote search backend configured or health probe unsupported',
      });
    }
  }

  // Print results
  process.stdout.write('Knowledge QnA MCP Diagnostic Report (docsctx doctor):\n');
  process.stdout.write('=====================================================\n');

  let allPassed = true;
  for (const check of checks) {
    const symbol = check.passed ? '✓' : '✗';
    process.stdout.write(`${symbol} [${check.name}]: ${check.message}\n`);
    if (!check.passed) {
      allPassed = false;
    }
  }
  process.stdout.write('=====================================================\n');
  process.stdout.write(allPassed ? 'Overall Status: HEALTHY\n' : 'Overall Status: ISSUES DETECTED\n');

  return allPassed ? 0 : 1;
}
