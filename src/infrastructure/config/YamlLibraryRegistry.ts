/**
 * YamlLibraryRegistry
 * Loads and validates library definitions from YAML configuration files.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { LibraryRegistry } from '../../application/ports/LibraryRegistry.js';
import type { LibraryDefinition } from '../../domain/models/index.js';

const ID_REGEX = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export class YamlLibraryRegistry implements LibraryRegistry {
  private readonly libraries = new Map<string, LibraryDefinition>();

  constructor(librariesDir?: string) {
    if (librariesDir && fs.existsSync(librariesDir)) {
      this.loadFromDirectory(librariesDir);
    }
  }

  loadFromDirectory(dirPath: string): void {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml'))) {
        const fullPath = path.join(dirPath, entry.name);
        const content = fs.readFileSync(fullPath, 'utf-8');
        const parsed = parseYaml(content);
        this.register(this.validateLibraryDefinition(parsed, entry.name), entry.name);
      }
    }
  }

  register(lib: LibraryDefinition, sourceFile?: string): void {
    if (this.libraries.has(lib.id)) {
      const location = sourceFile ? ` (attempted from '${sourceFile}')` : '';
      throw new Error(`Duplicate library id '${lib.id}' in configuration${location}`);
    }
    this.libraries.set(lib.id, lib);
  }

  private validateLibraryDefinition(raw: unknown, fileName: string): LibraryDefinition {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`Invalid library config in ${fileName}: root must be an object`);
    }

    const obj = raw as Record<string, unknown>;

    if (typeof obj['id'] !== 'string' || !ID_REGEX.test(obj['id']) || obj['id'] === '.' || obj['id'] === '..') {
      throw new Error(`Invalid library id in ${fileName}: '${obj['id']}'. Must match ${ID_REGEX}`);
    }

    if (typeof obj['name'] !== 'string' || obj['name'].trim().length === 0) {
      throw new Error(`Invalid library name in ${fileName}: name must be a non-empty string`);
    }

    if (typeof obj['defaultVersionKey'] !== 'string' || !ID_REGEX.test(obj['defaultVersionKey'])) {
      throw new Error(`Invalid defaultVersionKey in ${fileName}: '${obj['defaultVersionKey']}'`);
    }

    if (!Array.isArray(obj['versions']) || obj['versions'].length === 0) {
      throw new Error(`Invalid versions list in ${fileName}: must contain at least 1 version`);
    }

    const versionKeys = new Set<string>();
    for (const v of obj['versions']) {
      if (!v || typeof v !== 'object') {
        throw new Error(`Invalid version config in ${fileName}`);
      }
      const vKey = (v as Record<string, unknown>)['versionKey'];
      if (typeof vKey !== 'string' || !ID_REGEX.test(vKey) || vKey === '.' || vKey === '..') {
        throw new Error(`Invalid versionKey in ${fileName}: '${vKey}'`);
      }
      if (versionKeys.has(vKey)) {
        throw new Error(`Duplicate versionKey '${vKey}' in ${fileName}`);
      }
      versionKeys.add(vKey);
    }

    if (!versionKeys.has(obj['defaultVersionKey'])) {
      throw new Error(
        `defaultVersionKey '${obj['defaultVersionKey']}' does not exist in declared versions in ${fileName}`,
      );
    }

    return obj as unknown as LibraryDefinition;
  }

  async getLibrary(libraryId: string): Promise<LibraryDefinition | null> {
    return this.libraries.get(libraryId) ?? null;
  }

  async listLibraries(): Promise<LibraryDefinition[]> {
    return Array.from(this.libraries.values());
  }
}
