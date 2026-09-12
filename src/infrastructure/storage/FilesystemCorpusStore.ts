/**
 * FilesystemCorpusStore
 * Content-Addressable Storage for documents, chunks, and revisions under var/corpus/
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CorpusStore } from '../../application/ports/CorpusStore.js';
import type {
  NormalizedDocument,
  DocumentChunk,
  CorpusRevision,
} from '../../domain/models/index.js';

export class FilesystemCorpusStore implements CorpusStore {
  private readonly corpusDir: string;
  private readonly docsDir: string;
  private readonly chunksDir: string;
  private readonly revisionsDir: string;

  constructor(varRoot: string) {
    this.corpusDir = path.join(varRoot, 'corpus');
    this.docsDir = path.join(this.corpusDir, 'documents');
    this.chunksDir = path.join(this.corpusDir, 'chunks');
    this.revisionsDir = path.join(this.corpusDir, 'revisions');

    fs.mkdirSync(this.docsDir, { recursive: true });
    fs.mkdirSync(this.chunksDir, { recursive: true });
    fs.mkdirSync(this.revisionsDir, { recursive: true });
  }

  private atomicWriteFileSync(filePath: string, content: string): void {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    fs.writeFileSync(tempPath, content, 'utf-8');
    fs.renameSync(tempPath, filePath);
  }

  async saveDocument(document: NormalizedDocument): Promise<void> {
    const filePath = path.join(this.docsDir, document.documentId, `${document.snapshotId}.json`);
    this.atomicWriteFileSync(filePath, JSON.stringify(document, null, 2));
  }

  async getDocument(documentId: string, snapshotId: string): Promise<NormalizedDocument | null> {
    const filePath = path.join(this.docsDir, documentId, `${snapshotId}.json`);
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as NormalizedDocument;
  }

  async saveChunks(chunkerProfileId: string, snapshotId: string, chunks: DocumentChunk[]): Promise<void> {
    const filePath = path.join(this.chunksDir, chunkerProfileId, `${snapshotId}.jsonl`);
    const lines = chunks.map((c) => JSON.stringify(c)).join('\n') + '\n';
    this.atomicWriteFileSync(filePath, lines);
  }

  async getChunk(chunkerProfileId: string, snapshotId: string, chunkId: string): Promise<DocumentChunk | null> {
    const chunks = await this.getChunksForSnapshot(chunkerProfileId, snapshotId);
    return chunks.find((c) => c.chunkId === chunkId) ?? null;
  }

  async getChunksForSnapshot(chunkerProfileId: string, snapshotId: string): Promise<DocumentChunk[]> {
    const filePath = path.join(this.chunksDir, chunkerProfileId, `${snapshotId}.jsonl`);
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    return lines.map((line) => JSON.parse(line) as DocumentChunk);
  }

  async saveRevision(revision: CorpusRevision): Promise<void> {
    const filePath = path.join(this.revisionsDir, `${revision.corpusRevisionId}.json`);
    this.atomicWriteFileSync(filePath, JSON.stringify(revision, null, 2));
  }

  async getRevision(corpusRevisionId: string): Promise<CorpusRevision | null> {
    const filePath = path.join(this.revisionsDir, `${corpusRevisionId}.json`);
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as CorpusRevision;
  }
}
