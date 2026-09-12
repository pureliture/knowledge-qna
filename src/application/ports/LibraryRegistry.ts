/**
 * LibraryRegistry Port
 * In-memory or loaded configuration storage of official documentation libraries.
 */

import type { LibraryDefinition } from '../../domain/models/index.js';

export interface LibraryRegistry {
  getLibrary(libraryId: string): Promise<LibraryDefinition | null>;
  listLibraries(): Promise<LibraryDefinition[]>;
}

