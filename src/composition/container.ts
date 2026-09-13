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
import type { IndexBackend } from '../application/ports/IndexBackend.js';
import type { SourceProvider } from '../application/ports/SourceProvider.js';
import type { DocumentFetcher } from '../application/ports/DocumentFetcher.js';
import type { DocumentNormalizer } from '../application/ports/DocumentNormalizer.js';
import type { DocumentChunker } from '../application/ports/DocumentChunker.js';
import type { TokenCounter } from '../application/ports/TokenCounter.js';
import { StderrLogger, type Logger } from '../infrastructure/logging/StderrLogger.js';
import { TiktokenCounter } from '../infrastructure/tokens/TiktokenCounter.js';
import { YamlLibraryRegistry } from '../infrastructure/config/YamlLibraryRegistry.js';
import { FilesystemCorpusStore } from '../infrastructure/storage/FilesystemCorpusStore.js';
import { SqliteManifestStore } from '../infrastructure/storage/SqliteManifestStore.js';
import { SitemapSourceProvider } from '../infrastructure/source/SitemapSourceProvider.js';
import { HttpDocumentFetcher } from '../infrastructure/fetch/HttpDocumentFetcher.js';
import { HtmlDocumentNormalizer } from '../infrastructure/parsing/HtmlDocumentNormalizer.js';
import { MarkdownAstChunker } from '../infrastructure/parsing/MarkdownAstChunker.js';
import { InMemorySearchAdapter } from '../infrastructure/search/InMemorySearchAdapter.js';
import { ResolveLibraryUseCase } from '../application/library/resolve-library.js';
import { GetContextUseCase } from '../application/retrieval/get-context.js';
import { SyncUseCase } from '../application/sync/SyncUseCase.js';
import { IndexUseCase } from '../application/indexing/IndexUseCase.js';
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
  indexBackend?: IndexBackend;
  backendKey?: string;
  sourceProvider?: SourceProvider;
  documentFetcher?: DocumentFetcher;
  documentNormalizer?: DocumentNormalizer;
  documentChunker?: DocumentChunker;
  resolveLibraryUseCase?: ResolveLibraryUseCase;
  getContextUseCase?: GetContextUseCase;
  syncUseCase?: SyncUseCase;
  indexUseCase?: IndexUseCase;
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
  readonly indexBackend: IndexBackend;
  readonly backendKey: string;

  readonly sourceProvider: SourceProvider;
  readonly documentFetcher: DocumentFetcher;
  readonly documentNormalizer: DocumentNormalizer;
  readonly documentChunker: DocumentChunker;

  readonly resolveLibraryUseCase: ResolveLibraryUseCase;
  readonly getContextUseCase: GetContextUseCase;
  readonly syncUseCase: SyncUseCase;
  readonly indexUseCase: IndexUseCase;
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
    this.backendKey = config.backendKey ?? 'in-memory-search-adapter';

    const defaultAdapter = new InMemorySearchAdapter(this.backendKey);
    this.searchBackend = config.searchBackend ?? defaultAdapter;
    this.indexBackend =
      config.indexBackend ??
      ((this.searchBackend as unknown as IndexBackend) || defaultAdapter);

    this.sourceProvider = config.sourceProvider ?? new SitemapSourceProvider();
    this.documentFetcher = config.documentFetcher ?? new HttpDocumentFetcher();
    this.documentNormalizer = config.documentNormalizer ?? new HtmlDocumentNormalizer();
    this.documentChunker = config.documentChunker ?? new MarkdownAstChunker(this.tokenCounter);

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
    this.syncUseCase =
      config.syncUseCase ??
      new SyncUseCase(
        this.libraryRegistry,
        this.manifestStore,
        this.corpusStore,
        this.sourceProvider,
        this.documentFetcher,
        this.documentNormalizer,
        this.documentChunker,
      );
    this.indexUseCase =
      config.indexUseCase ??
      new IndexUseCase(
        this.libraryRegistry,
        this.manifestStore,
        this.corpusStore,
        this.indexBackend,
        this.backendKey,
      );

    this.mcpServer = createKnowledgeQnaMcpServer({
      resolveLibraryUseCase: this.resolveLibraryUseCase,
      getContextUseCase: this.getContextUseCase,
      logger: this.logger,
    });
  }
}
