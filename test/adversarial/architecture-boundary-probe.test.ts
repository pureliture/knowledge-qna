/**
 * Adversarial Architecture Boundary Validator Probe
 * Challenger: challenger_m0_2
 *
 * This test suite empirically probes test/architecture/layer-boundaries.test.ts
 * to determine whether forbidden imports in domain or application layers
 * can bypass the static analysis architecture validator.
 */

import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';

// Replicate the exact AST import extraction logic from test/architecture/layer-boundaries.test.ts
function getImportsFromSource(content: string): Array<{ specifier: string; line: number }> {
  const sourceFile = ts.createSourceFile('probe.ts', content, ts.ScriptTarget.Latest, true);
  const imports: Array<{ specifier: string; line: number }> = [];

  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        imports.push({ specifier: node.moduleSpecifier.text, line: line + 1 });
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteral(arg)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        imports.push({ specifier: arg.text, line: line + 1 });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return imports;
}

// Replicate the exact Rule 1 validator check from test/architecture/layer-boundaries.test.ts
function checkDomainRule(imports: Array<{ specifier: string; line: number }>): string[] {
  const forbiddenModules = [
    'node:fs',
    'fs',
    'node:net',
    'net',
    'node:http',
    'http',
    'node:https',
    'https',
    'node:child_process',
    'child_process',
    '@modelcontextprotocol',
    'better-sqlite3',
    'cheerio',
    'turndown',
    'marked',
    'commander',
    'yaml',
    'zod',
    'js-tiktoken',
  ];
  const forbiddenLayers = ['application', 'infrastructure', 'interfaces', 'composition'];
  const violations: string[] = [];

  for (const imp of imports) {
    if (forbiddenModules.some((m) => imp.specifier === m || imp.specifier.startsWith(`${m}/`))) {
      violations.push(`Imports forbidden module/package: ${imp.specifier}`);
    }
    if (forbiddenLayers.some((layer) => imp.specifier.includes(`/${layer}/`) || imp.specifier.startsWith(`../${layer}`))) {
      violations.push(`Imports forbidden layer: ${imp.specifier}`);
    }
  }

  return violations;
}

// Replicate the exact Rule 2 validator check from test/architecture/layer-boundaries.test.ts
function checkApplicationRule(imports: Array<{ specifier: string; line: number }>): string[] {
  const forbiddenLayers = ['infrastructure', 'interfaces', 'composition'];
  const forbiddenExternal = ['better-sqlite3', 'cheerio', 'turndown', '@modelcontextprotocol/server', 'marked', 'commander'];
  const violations: string[] = [];

  for (const imp of imports) {
    if (forbiddenLayers.some((layer) => imp.specifier.includes(`/${layer}/`) || imp.specifier.startsWith(`../${layer}`))) {
      violations.push(`Application imports forbidden layer: ${imp.specifier}`);
    }
    if (forbiddenExternal.some((pkg) => imp.specifier === pkg || imp.specifier.startsWith(`${pkg}/`))) {
      violations.push(`Application imports concrete external package: ${imp.specifier}`);
    }
  }

  return violations;
}

describe('Architecture Boundary Validator Vulnerability Probes', () => {
  it('PROBE 1: Dynamic import with template literal (backticks) bypasses AST extractor', () => {
    // Evasion: Using backtick template literal instead of single/double quotes
    const snippet = `
      export async function backdoor() {
        const fs = await import(\`node:fs\`);
        return fs.readFileSync('/etc/passwd');
      }
    `;

    const extracted = getImportsFromSource(snippet);
    // VULNERABILITY: ts.isStringLiteral is false for NoSubstitutionTemplateLiteral!
    // The import is completely invisible to getImportsFromFile!
    expect(extracted).toEqual([]);

    const violations = checkDomainRule(extracted);
    expect(violations).toHaveLength(0); // BYPASS CONFIRMED!
  });

  it('PROBE 2: Subdirectory layer import without trailing slash bypasses layer check', () => {
    // Evasion: From src/application/sub/file.ts, importing ../../infrastructure
    const snippet = `
      import * as infra from '../../infrastructure';
    `;

    const extracted = getImportsFromSource(snippet);
    expect(extracted).toEqual([{ specifier: '../../infrastructure', line: 2 }]);

    const violations = checkApplicationRule(extracted);
    // VULNERABILITY: '../../infrastructure' does not start with '../infrastructure'
    // and does not contain '/infrastructure/' (no trailing slash).
    // The violation is undetected!
    expect(violations).toHaveLength(0); // BYPASS CONFIRMED!
  });

  it('PROBE 3: Blacklist gap permits unlisted Node I/O and network modules in Domain', () => {
    // Evasion: Domain imports node:os, node:worker_threads, node:dns, node:module
    const snippet = `
      import * as os from 'node:os';
      import * as dns from 'node:dns';
      import * as threads from 'node:worker_threads';
      import { createRequire } from 'node:module';
    `;

    const extracted = getImportsFromSource(snippet);
    expect(extracted).toHaveLength(4);

    const violations = checkDomainRule(extracted);
    // VULNERABILITY: Rule 1 uses a hard-coded blacklist instead of a whitelist.
    // ZERO violations are flagged despite extensive OS and network imports!
    expect(violations).toHaveLength(0); // BYPASS CONFIRMED!
  });

  it('PROBE 4: Dynamic require via node:module allows loading forbidden SQLite/MCP in Domain', () => {
    // Evasion: Use unblacklisted node:module to create require, then load better-sqlite3
    const snippet = `
      import { createRequire } from 'node:module';
      const require = createRequire(import.meta.url);
      const Database = require('better-sqlite3');
    `;

    const extracted = getImportsFromSource(snippet);
    // Only node:module is seen by import extractor
    expect(extracted).toEqual([{ specifier: 'node:module', line: 2 }]);

    const violations = checkDomainRule(extracted);
    expect(violations).toHaveLength(0); // BYPASS CONFIRMED!
  });

  it('PROBE 5: Dynamic import with concatenated strings or variables bypasses AST extractor', () => {
    // Evasion: import with expression
    const snippet = `
      const target = 'better-' + 'sqlite3';
      export async function loadDb() {
        return import(target);
      }
    `;

    const extracted = getImportsFromSource(snippet);
    expect(extracted).toEqual([]);

    const violations = checkApplicationRule(extracted);
    expect(violations).toHaveLength(0); // BYPASS CONFIRMED!
  });
});
