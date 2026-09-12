/**
 * Automated Hexagonal Layer Boundary Architecture Test
 * Verifies strict import constraints across domain, application, infrastructure, interfaces, and composition layers.
 * Hardened against AST evasion, relative path traversals, and unauthorized module imports.
 */

import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import * as fs from 'node:fs';
import * as path from 'node:path';

function getAllTsFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const res = path.resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getAllTsFiles(res));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      files.push(res);
    }
  }
  return files;
}

function isStringOrTemplate(node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function getImportsFromFile(filePath: string): Array<{ specifier: string; line: number }> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
  const imports: Array<{ specifier: string; line: number }> = [];

  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && isStringOrTemplate(node.moduleSpecifier)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        imports.push({ specifier: node.moduleSpecifier.text, line: line + 1 });
      }
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        if (arg) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          if (isStringOrTemplate(arg)) {
            imports.push({ specifier: arg.text, line: line + 1 });
          } else {
            // Non-literal dynamic import expression detected
            imports.push({ specifier: '<dynamic-import-expression>', line: line + 1 });
          }
        }
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        const arg = node.arguments[0];
        if (arg) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          if (isStringOrTemplate(arg)) {
            imports.push({ specifier: arg.text, line: line + 1 });
          } else {
            imports.push({ specifier: '<dynamic-require-expression>', line: line + 1 });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return imports;
}

function isInside(targetPath: string, parentDir: string): boolean {
  const rel = path.relative(parentDir, targetPath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

describe('Hexagonal Architecture Layer Boundary Verification', () => {
  const srcRoot = path.resolve(__dirname, '../../src');
  const allFiles = getAllTsFiles(srcRoot);

  const domainDir = path.resolve(srcRoot, 'domain');
  const appDir = path.resolve(srcRoot, 'application');
  const appPortsDir = path.resolve(srcRoot, 'application/ports');
  const infraDir = path.resolve(srcRoot, 'infrastructure');
  const interfacesDir = path.resolve(srcRoot, 'interfaces');
  const compositionDir = path.resolve(srcRoot, 'composition');

  it('Rule 1: Domain layer must have ZERO I/O and ZERO external dependencies (node:crypto permitted)', () => {
    const domainFiles = allFiles.filter((f) => isInside(f, domainDir));
    expect(domainFiles.length).toBeGreaterThan(0);

    const violations: string[] = [];

    for (const file of domainFiles) {
      const imports = getImportsFromFile(file);
      for (const imp of imports) {
        // Whitelist: only 'node:crypto' is permitted as an external built-in module
        if (imp.specifier === 'node:crypto') {
          continue;
        }

        // Relative imports must strictly resolve inside src/domain/
        if (imp.specifier.startsWith('.')) {
          const resolved = path.resolve(path.dirname(file), imp.specifier);
          if (!isInside(resolved, domainDir)) {
            violations.push(
              `${file}:${imp.line} -> Domain imports relative module outside domain layer: ${imp.specifier} (resolved: ${resolved})`,
            );
          }
        } else {
          violations.push(
            `${file}:${imp.line} -> Domain imports forbidden external/built-in module: ${imp.specifier} (only relative domain imports and 'node:crypto' allowed)`,
          );
        }
      }
    }

    expect(violations, `Domain layer boundary violations found:\n${violations.join('\n')}`).toEqual([]);
  });

  it('Rule 2: Application layer must NEVER import infrastructure, interfaces, or composition', () => {
    const appFiles = allFiles.filter((f) => isInside(f, appDir));
    expect(appFiles.length).toBeGreaterThan(0);

    const forbiddenExternal = [
      'better-sqlite3',
      'cheerio',
      'turndown',
      '@modelcontextprotocol/server',
      '@modelcontextprotocol/core',
      'marked',
      'commander',
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
      'node:module',
    ];

    const violations: string[] = [];

    for (const file of appFiles) {
      const imports = getImportsFromFile(file);
      for (const imp of imports) {
        if (imp.specifier.startsWith('.')) {
          const resolved = path.resolve(path.dirname(file), imp.specifier);
          if (isInside(resolved, infraDir)) {
            violations.push(
              `${file}:${imp.line} -> Application imports forbidden infrastructure layer: ${imp.specifier} (resolved: ${resolved})`,
            );
          } else if (isInside(resolved, interfacesDir)) {
            violations.push(
              `${file}:${imp.line} -> Application imports forbidden interfaces layer: ${imp.specifier} (resolved: ${resolved})`,
            );
          } else if (isInside(resolved, compositionDir)) {
            violations.push(
              `${file}:${imp.line} -> Application imports forbidden composition layer: ${imp.specifier} (resolved: ${resolved})`,
            );
          }
        } else {
          if (
            forbiddenExternal.some((pkg) => imp.specifier === pkg || imp.specifier.startsWith(`${pkg}/`)) ||
            imp.specifier === '<dynamic-import-expression>' ||
            imp.specifier === '<dynamic-require-expression>'
          ) {
            violations.push(
              `${file}:${imp.line} -> Application imports forbidden concrete external/IO package: ${imp.specifier}`,
            );
          }
        }
      }
    }

    expect(violations, `Application layer boundary violations found:\n${violations.join('\n')}`).toEqual([]);
  });

  it('Rule 3: Infrastructure layer must NEVER import interfaces, composition, or concrete application modules (ports allowed)', () => {
    const infraFiles = allFiles.filter((f) => isInside(f, infraDir));
    expect(infraFiles.length).toBeGreaterThan(0);

    const violations: string[] = [];

    for (const file of infraFiles) {
      const imports = getImportsFromFile(file);
      for (const imp of imports) {
        if (imp.specifier.startsWith('.')) {
          const resolved = path.resolve(path.dirname(file), imp.specifier);

          if (isInside(resolved, interfacesDir)) {
            violations.push(
              `${file}:${imp.line} -> Infrastructure imports forbidden layer: interfaces (${imp.specifier})`,
            );
          } else if (isInside(resolved, compositionDir)) {
            violations.push(
              `${file}:${imp.line} -> Infrastructure imports forbidden layer: composition (${imp.specifier})`,
            );
          } else if (isInside(resolved, appDir)) {
            // Infrastructure can ONLY import from src/application/ports/
            if (!isInside(resolved, appPortsDir)) {
              violations.push(
                `${file}:${imp.line} -> Infrastructure imports concrete application module outside of ports: ${imp.specifier} (resolved: ${resolved})`,
              );
            }
          }
        }
      }
    }

    expect(violations, `Infrastructure layer boundary violations found:\n${violations.join('\n')}`).toEqual([]);
  });

  it('Rule 4: Interfaces layer must NEVER directly import concrete infrastructure adapters or composition', () => {
    const interfaceFiles = allFiles.filter((f) => isInside(f, interfacesDir));
    expect(interfaceFiles.length).toBeGreaterThan(0);

    const violations: string[] = [];

    for (const file of interfaceFiles) {
      const imports = getImportsFromFile(file);
      for (const imp of imports) {
        if (imp.specifier.startsWith('.')) {
          const resolved = path.resolve(path.dirname(file), imp.specifier);

          if (isInside(resolved, infraDir)) {
            violations.push(
              `${file}:${imp.line} -> Interfaces imports forbidden infrastructure layer directly: ${imp.specifier} (resolved: ${resolved})`,
            );
          } else if (isInside(resolved, compositionDir)) {
            violations.push(
              `${file}:${imp.line} -> Interfaces imports forbidden composition layer: ${imp.specifier} (resolved: ${resolved})`,
            );
          }
        }
      }
    }

    expect(violations, `Interfaces layer boundary violations found:\n${violations.join('\n')}`).toEqual([]);
  });
});
