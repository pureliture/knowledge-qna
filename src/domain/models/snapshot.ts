/**
 * Document and Snapshot Domain Models
 * Zero Node I/O, Zero External SDKs
 */

export interface DocumentHeading {
  level: number;
  text: string;
  anchor?: string;
}

export interface DocumentMetadata {
  language?: string;
  docType?: string;
  product?: string;
  vendor?: string;
  [key: string]: string | undefined;
}

export interface NormalizedDocument {
  schemaVersion: 1;
  documentId: string;
  snapshotId: string;
  libraryId: string;
  versionKey: string;
  canonicalUrl: string;
  title: string;
  markdown: string;
  headings: DocumentHeading[];
  normalizedHash: string;
  normalizerProfileId: string;
  metadata: DocumentMetadata;
}

export interface FetchObservation {
  runId: string;
  documentId: string;
  snapshotId?: string;
  requestedUrl: string;
  fetchedUrl: string;
  status: number | 'network_error';
  lastCheckedAt?: string;
  fetchedAt?: string;
  rawHash?: string;
  ETag?: string;
  LastModified?: string;
}
