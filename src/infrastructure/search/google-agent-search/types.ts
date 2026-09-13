/**
 * Google Agent Search Configuration and Internal Types
 * Strict Layer Boundary: Infrastructure layer only.
 */

export interface GoogleAgentSearchConfig {
  projectId: string;
  location?: string; // Default: 'global'
  collectionId?: string; // Default: 'default_collection'
  dataStoreId: string;
  servingConfigId?: string; // Default: 'default_search'
  branchId?: string; // Default: 'default_branch'
  pageSize?: number; // Default: 20, max: 100
  maxBatchSizeBytes?: number; // Default: 4 * 1024 * 1024 (4 MiB)
  maxBatchCount?: number; // Default: 100
  lroPollIntervalMs?: number; // Default: 1000 ms
  lroTimeoutMs?: number; // Default: 60000 ms
}

export interface GoogleDocumentStructData {
  library_id: string;
  version_key: string;
  generation_id: string;
  chunk_id: string;
  document_id: string;
  snapshot_id: string;
  content_hash: string;
  title: string;
  content: string;
  canonical_url: string;
  heading_path: string[];
  has_code: boolean;
  language?: string;
  doc_type?: string;
}

export interface GoogleDocumentPayload {
  id: string; // 53 chars, starts with 'k'
  structData: GoogleDocumentStructData;
}

export interface ISearchServiceClient {
  search(request?: any, options?: any): Promise<any>;
}

export interface IDocumentServiceClient {
  importDocuments(request?: any, options?: any): Promise<any>;
  deleteDocument?(request?: any, options?: any): Promise<any>;
}

export interface GoogleClientFactory {
  createSearchClient(): Promise<ISearchServiceClient>;
  createDocumentClient(): Promise<IDocumentServiceClient>;
}
