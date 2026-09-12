/**
 * Composition Root (DI Container)
 * Wires concrete infrastructure adapters to application use cases and interface layers.
 */

import * as path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import type { LibraryRegistry } from '../application/ports/LibraryRegistry.js';
import type { ManifestStore } from '../application/ports/ManifestStore.js';
import type { CorpusStore } from '../application/ports/CorpusStore.js';
import type { SearchBackend } from '../application/ports/SearchBackend.js';
import type { TokenCounter } from '../application/ports/TokenCounter.js';
import type { SearchHit } from '../domain/models/index.js';
import { StderrLogger, type Logger } from '../infrastructure/logging/StderrLogger.js';
import { TiktokenCounter } from '../infrastructure/tokens/TiktokenCounter.js';
import { YamlLibraryRegistry } from '../infrastructure/config/YamlLibraryRegistry.js';
import { FilesystemCorpusStore } from '../infrastructure/storage/FilesystemCorpusStore.js';
import { SqliteManifestStore } from '../infrastructure/storage/SqliteManifestStore.js';
import { ResolveLibraryUseCase } from '../application/library/resolve-library.js';
import { GetContextUseCase } from '../application/retrieval/get-context.js';
import { createKnowledgeQnaMcpServer } from '../interfaces/mcp/server.js';

export interface AppContainerConfig {
  varRoot?: string;
  configDir?: string;
  logger?: Logger;
  tokenCounter?: TokenCounter;
  corpusStore?: CorpusStore;
  manifestStore?: ManifestStore;
  libraryRegistry?: LibraryRegistry;
  searchBackend?: SearchBackend;
  backendKey?: string;
  resolveLibraryUseCase?: ResolveLibraryUseCase;
  getContextUseCase?: GetContextUseCase;
}

/**
 * Basic In-Memory SearchBackend for baseline M0 retrieval.
 */
class InMemorySearchBackend implements SearchBackend {
  private readonly hitsByGeneration = new Map<string, SearchHit[]>();

  setHits(generationId: string, hits: SearchHit[]): void {
    this.hitsByGeneration.set(generationId, hits);
  }

  async search(params: { generationId: string }): Promise<SearchHit[]> {
    return this.hitsByGeneration.get(params.generationId) ?? [];
  }
}

export class AppContainer {
  readonly varRoot: string;
  readonly configDir: string;
  readonly logger: Logger;
  readonly tokenCounter: TokenCounter;
  readonly corpusStore: CorpusStore;
  readonly manifestStore: ManifestStore;
  readonly libraryRegistry: LibraryRegistry;
  readonly searchBackend: SearchBackend;
  readonly backendKey: string;

  readonly resolveLibraryUseCase: ResolveLibraryUseCase;
  readonly getContextUseCase: GetContextUseCase;
  readonly mcpServer: McpServer;

  constructor(config: AppContainerConfig = {}) {
    this.varRoot = config.varRoot ?? path.resolve(process.cwd(), 'var');
    this.configDir = config.configDir ?? path.resolve(process.cwd(), 'config/libraries');
    this.logger = config.logger ?? new StderrLogger('info');
    this.tokenCounter = config.tokenCounter ?? new TiktokenCounter();
    this.corpusStore = config.corpusStore ?? new FilesystemCorpusStore(this.varRoot);
    this.manifestStore =
      config.manifestStore ??
      new SqliteManifestStore(path.join(this.varRoot, 'manifest/catalog.sqlite'));
    this.libraryRegistry = config.libraryRegistry ?? new YamlLibraryRegistry(this.configDir);
    this.searchBackend = config.searchBackend ?? new InMemorySearchBackend();
    this.backendKey = config.backendKey ?? 'default-backend-key';

    this.resolveLibraryUseCase =
      config.resolveLibraryUseCase ?? new ResolveLibraryUseCase(this.libraryRegistry);
    this.getContextUseCase =
      config.getContextUseCase ??
      new GetContextUseCase(
        this.libraryRegistry,
        this.manifestStore,
        this.corpusStore,
        this.searchBackend,
        this.tokenCounter,
        this.backendKey,
      );

    this.mcpServer = createKnowledgeQnaMcpServer({
      resolveLibraryUseCase: this.resolveLibraryUseCase,
      getContextUseCase: this.getContextUseCase,
      logger: this.logger,
    });
  }
}
