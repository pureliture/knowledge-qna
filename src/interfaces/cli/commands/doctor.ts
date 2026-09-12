/**
 * CLI Command: docsctx doctor
 * Read-only health check and environment diagnostics.
 */

import type { LibraryRegistry } from '../../../application/ports/LibraryRegistry.js';
import type { ManifestStore } from '../../../application/ports/ManifestStore.js';

export interface DoctorCommandOptions {
  libraryRegistry: LibraryRegistry;
  manifestStore?: ManifestStore;
  varRoot: string;
  configDir: string;
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
  try {
    const libraries = await options.libraryRegistry.listLibraries();
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

  // Check 3: Manifest Store
  if (options.manifestStore) {
    try {
      // Test read lease or pointer query
      await options.manifestStore.getPublishedPointer('test', 'test', 'test');
      checks.push({
        name: 'Manifest Store (SQLite)',
        passed: true,
        message: `Connected successfully to catalog database in ${options.varRoot}`,
      });
    } catch (err) {
      checks.push({
        name: 'Manifest Store (SQLite)',
        passed: false,
        message: `Failed to query manifest: ${err instanceof Error ? err.message : String(err)}`,
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
