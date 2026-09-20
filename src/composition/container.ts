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
import { GoogleAgentSearchAdapter } from '../infrastructure/search/google-agent-search/GoogleAgentSearchAdapter.js';
import type { GoogleAgentSearchConfig } from '../infrastructure/search/google-agent-search/types.js';
import { UnavailableSearchBackend } from '../infrastructure/search/UnavailableSearchBackend.js';
import { ResolveLibraryUseCase } from '../application/library/resolve-library.js';
import { GetContextUseCase } from '../application/retrieval/get-context.js';
import { SyncUseCase } from '../application/sync/SyncUseCase.js';
import { IndexUseCase } from '../application/indexing/IndexUseCase.js';
import { GarbageCollectionUseCase } from '../application/indexing/GarbageCollectionUseCase.js';
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
  gcUseCase?: GarbageCollectionUseCase;
  remoteSearchBackend?: SearchBackend;
}

import * as fs from 'node:fs';
import * as os from 'node:os';

function loadDotEnv(): void {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    try {
      const content = fs.readFileSync(envPath, 'utf-8');
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx).trim();
          let val = trimmed.slice(eqIdx + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
      }
    } catch {
      // Ignore .env read errors
    }
  }
}

function resolveAdcCredentials(): void {

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return;
  }

  const gcloudDir = path.join(os.homedir(), '.config', 'gcloud');

  // 1. Explicit account env var
  const targetAccount = process.env.GOOGLE_AGENT_SEARCH_ACCOUNT;
  if (targetAccount) {
    const candidate = path.join(gcloudDir, 'legacy_credentials', targetAccount, 'adc.json');
    if (fs.existsSync(candidate)) {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = candidate;
      return;
    }
  }

  // 2. Read active gcloud account
  try {
    const activeConfigPath = path.join(gcloudDir, 'active_config');
    if (fs.existsSync(activeConfigPath)) {
      const activeConfig = fs.readFileSync(activeConfigPath, 'utf-8').trim();
      const configFile = path.join(gcloudDir, 'configurations', `config_${activeConfig}`);
      if (fs.existsSync(configFile)) {
        const lines = fs.readFileSync(configFile, 'utf-8').split('\n');
        for (const line of lines) {
          const match = line.match(/^\s*account\s*=\s*(.+)$/);
          if (match && match[1]) {
            const account = match[1].trim();
            const candidate = path.join(gcloudDir, 'legacy_credentials', account, 'adc.json');
            if (fs.existsSync(candidate)) {
              process.env.GOOGLE_APPLICATION_CREDENTIALS = candidate;
              return;
            }
          }
        }
      }
    }
  } catch {
    // Ignore fallback errors and let default ADC discovery proceed
  }
}

function createConfiguredGoogleBackend(): GoogleAgentSearchAdapter | undefined {
  loadDotEnv();
  resolveAdcCredentials();

  const projectId = process.env.GOOGLE_AGENT_SEARCH_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT;
  const dataStoreId = process.env.GOOGLE_AGENT_SEARCH_DATA_STORE_ID;
  if (!projectId || !dataStoreId) {
    return undefined;
  }

  const config: GoogleAgentSearchConfig = {
    projectId,
    dataStoreId,
    location: process.env.GOOGLE_AGENT_SEARCH_LOCATION || 'global',
    collectionId: process.env.GOOGLE_AGENT_SEARCH_COLLECTION_ID || 'default_collection',
    branchId: process.env.GOOGLE_AGENT_SEARCH_BRANCH_ID || 'default_branch',
    servingConfigId: process.env.GOOGLE_AGENT_SEARCH_SERVING_CONFIG_ID || 'default_search',
  };
  return new GoogleAgentSearchAdapter(config);
}


function isIndexBackend(value: SearchBackend | IndexBackend): value is IndexBackend {
  return (
    'stageGeneration' in value &&
    'importBatch' in value &&
    'verifyReadiness' in value &&
    'publishGeneration' in value &&
    'retireGeneration' in value &&
    'deleteGeneration' in value
  );
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
  readonly remoteSearchBackend: SearchBackend;
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
  readonly gcUseCase: GarbageCollectionUseCase;
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
    const googleBackend = createConfiguredGoogleBackend();
    this.backendKey =
      config.backendKey ?? (googleBackend ? 'google-agent-search' : 'in-memory-search-adapter');
    const defaultAdapter = new InMemorySearchAdapter(this.backendKey);
    this.remoteSearchBackend =
      config.remoteSearchBackend ??
      googleBackend ??
      new UnavailableSearchBackend(
        'Google Agent Search remote target is not configured; set GOOGLE_AGENT_SEARCH_PROJECT_ID (or GOOGLE_CLOUD_PROJECT) and GOOGLE_AGENT_SEARCH_DATA_STORE_ID.',
      );
    this.searchBackend = config.searchBackend ?? googleBackend ?? defaultAdapter;
    this.indexBackend =
      config.indexBackend ??
      (isIndexBackend(this.searchBackend) ? this.searchBackend : googleBackend ?? defaultAdapter);

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
    this.gcUseCase =
      config.gcUseCase ??
      new GarbageCollectionUseCase(
        this.libraryRegistry,
        this.manifestStore,
        this.indexBackend,
        this.backendKey,
      );

    this.mcpServer = this.createMcpServer();
  }

  createMcpServer(): McpServer {
    return createKnowledgeQnaMcpServer({
      resolveLibraryUseCase: this.resolveLibraryUseCase,
      getContextUseCase: this.getContextUseCase,
      logger: this.logger,
    });
  }
}
