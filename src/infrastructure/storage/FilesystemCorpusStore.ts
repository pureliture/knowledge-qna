/**
 * FilesystemCorpusStore
 * Content-Addressable Storage for documents, chunks, revisions, and profiles under var/corpus/
 * Implements fsyncSync atomic flush & rename, and verifies payload integrity with CORPUS_CORRUPT errors.
 * Strict Layer Boundary: Infrastructure imports only domain and application/ports.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CorpusStore } from '../../application/ports/CorpusStore.js';
import type {
  NormalizedDocument,
  DocumentChunk,
  CorpusRevision,
} from '../../domain/models/index.js';
import {
  computeDocumentId,
  computeSnapshotId,
  computeChunkId,
  sha256Hex,
  toCanonicalJson,
} from '../../domain/identity.js';
import { CorpusCorruptError } from '../../domain/errors.js';

export class FilesystemCorpusStore implements CorpusStore {
  private readonly corpusDir: string;
  private readonly docsDir: string;
  private readonly chunksDir: string;
  private readonly revisionsDir: string;
  private readonly profilesDir: string;

  constructor(varRoot: string) {
    this.corpusDir = path.join(varRoot, 'corpus');
    this.docsDir = path.join(this.corpusDir, 'documents');
    this.chunksDir = path.join(this.corpusDir, 'chunks');
    this.revisionsDir = path.join(this.corpusDir, 'revisions');
    this.profilesDir = path.join(this.corpusDir, 'profiles');

    fs.mkdirSync(this.docsDir, { recursive: true });
    fs.mkdirSync(this.chunksDir, { recursive: true });
    fs.mkdirSync(this.revisionsDir, { recursive: true });
    fs.mkdirSync(this.profilesDir, { recursive: true });
  }

  private atomicWriteFileSync(filePath: string, content: string): void {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });

    // Temporary file in same directory ensures same filesystem volume for atomic rename
    const tempPath = path.join(
      dir,
      `.tmp.${path.basename(filePath)}.${Date.now()}.${Math.random().toString(36).slice(2)}`,
    );

    const fd = fs.openSync(tempPath, 'w');
    try {
      fs.writeSync(fd, content, 0, 'utf-8');
      fs.fsyncSync(fd); // Force kernel buffers to physical storage
    } finally {
      fs.closeSync(fd);
    }

    // Atomic POSIX rename
    fs.renameSync(tempPath, filePath);
  }

  // Documents
  async saveDocument(document: NormalizedDocument): Promise<void> {
    // 1. Verify identity consistency
    const expectedDocId = computeDocumentId(
      document.libraryId,
      document.versionKey,
      document.canonicalUrl,
    );
    if (document.documentId !== expectedDocId) {
      throw new CorpusCorruptError(
        `CORPUS_CORRUPT: documentId mismatch for '${document.canonicalUrl}'. Expected '${expectedDocId}', got '${document.documentId}'`,
      );
    }

    const expectedSnapshotId = computeSnapshotId(
      document.documentId,
      document.normalizerProfileId,
      document.normalizedHash,
    );
    if (document.snapshotId !== expectedSnapshotId) {
      throw new CorpusCorruptError(
        `CORPUS_CORRUPT: snapshotId mismatch for '${document.canonicalUrl}'. Expected '${expectedSnapshotId}', got '${document.snapshotId}'`,
      );
    }

    const filePath = path.join(this.docsDir, document.documentId, `${document.snapshotId}.json`);

    // 2. Check for existing file with different payload
    if (fs.existsSync(filePath)) {
      try {
        const existingContent = fs.readFileSync(filePath, 'utf-8');
        const existingDoc = JSON.parse(existingContent) as NormalizedDocument;
        if (
          existingDoc.snapshotId !== document.snapshotId ||
          existingDoc.normalizedHash !== document.normalizedHash ||
          toCanonicalJson(existingDoc) !== toCanonicalJson(document)
        ) {
          throw new CorpusCorruptError(
            `CORPUS_CORRUPT: Snapshot '${document.snapshotId}' already exists with different payload`,
          );
        }
        return; // Identical, idempotent no-op
      } catch (err) {
        if (err instanceof CorpusCorruptError) throw err;
        throw new CorpusCorruptError(
          `CORPUS_CORRUPT: Existing snapshot file '${filePath}' is corrupted and unparseable`,
        );
      }
    }

    this.atomicWriteFileSync(filePath, JSON.stringify(document, null, 2));
  }

  async getDocument(documentId: string, snapshotId: string): Promise<NormalizedDocument | null> {
    const filePath = path.join(this.docsDir, documentId, `${snapshotId}.json`);
    if (!fs.existsSync(filePath)) return null;

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const doc = JSON.parse(content) as NormalizedDocument;
      if (doc.snapshotId !== snapshotId || doc.documentId !== documentId) {
        throw new CorpusCorruptError(
          `CORPUS_CORRUPT: Document at '${filePath}' contains mismatched snapshotId or documentId`,
        );
      }
      return doc;
    } catch (err) {
      if (err instanceof CorpusCorruptError) throw err;
      throw new CorpusCorruptError(
        `CORPUS_CORRUPT: Failed to read or parse document from '${filePath}'`,
      );
    }
  }

  async hasDocument(documentId: string, snapshotId: string): Promise<boolean> {
    const filePath = path.join(this.docsDir, documentId, `${snapshotId}.json`);
    return fs.existsSync(filePath);
  }

  // Chunks
  async saveChunks(
    chunkerProfileId: string,
    snapshotId: string,
    chunks: DocumentChunk[],
  ): Promise<void> {
    // 1. Verify chunk identity and contentHash
    for (const chunk of chunks) {
      const expectedHash = sha256Hex(chunk.content);
      if (chunk.contentHash !== expectedHash) {
        throw new CorpusCorruptError(
          `CORPUS_CORRUPT: Chunk '${chunk.chunkId}' contentHash mismatch. Expected '${expectedHash}', got '${chunk.contentHash}'`,
        );
      }

      const expectedChunkId = computeChunkId(
        snapshotId,
        chunkerProfileId,
        chunk.chunkIndex,
        chunk.headingPath,
        chunk.content,
      );
      if (chunk.chunkId !== expectedChunkId) {
        throw new CorpusCorruptError(
          `CORPUS_CORRUPT: Chunk chunkId mismatch at index ${chunk.chunkIndex}. Expected '${expectedChunkId}', got '${chunk.chunkId}'`,
        );
      }
    }

    const filePath = path.join(this.chunksDir, chunkerProfileId, `${snapshotId}.jsonl`);

    // 2. Check for existing chunks file
    if (fs.existsSync(filePath)) {
      try {
        const existingContent = fs.readFileSync(filePath, 'utf-8');
        const lines = existingContent.split('\n').filter((l) => l.trim().length > 0);
        const existingChunks = lines.map((l) => JSON.parse(l) as DocumentChunk);

        if (existingChunks.length !== chunks.length) {
          throw new CorpusCorruptError(
            `CORPUS_CORRUPT: Chunks file for snapshot '${snapshotId}' already exists with different chunk count (${existingChunks.length} vs ${chunks.length})`,
          );
        }

        for (let i = 0; i < chunks.length; i++) {
          const e = existingChunks[i];
          const c = chunks[i];
          if (!e || !c || e.chunkId !== c.chunkId || e.contentHash !== c.contentHash) {
            throw new CorpusCorruptError(
              `CORPUS_CORRUPT: Chunks file for snapshot '${snapshotId}' already exists with different chunk payload at index ${i}`,
            );
          }
        }
        return; // Identical, idempotent no-op
      } catch (err) {
        if (err instanceof CorpusCorruptError) throw err;
        throw new CorpusCorruptError(
          `CORPUS_CORRUPT: Existing chunks file '${filePath}' is corrupted and unparseable`,
        );
      }
    }

    const lines = chunks.map((c) => JSON.stringify(c)).join('\n') + (chunks.length > 0 ? '\n' : '');
    this.atomicWriteFileSync(filePath, lines);
  }

  async getChunk(
    chunkerProfileId: string,
    snapshotId: string,
    chunkId: string,
  ): Promise<DocumentChunk | null> {
    const chunks = await this.getChunksForSnapshot(chunkerProfileId, snapshotId);
    return chunks.find((c) => c.chunkId === chunkId) ?? null;
  }

  async getChunksForSnapshot(
    chunkerProfileId: string,
    snapshotId: string,
  ): Promise<DocumentChunk[]> {
    const filePath = path.join(this.chunksDir, chunkerProfileId, `${snapshotId}.jsonl`);
    if (!fs.existsSync(filePath)) return [];

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').filter((l) => l.trim().length > 0);
      return lines.map((line) => JSON.parse(line) as DocumentChunk);
    } catch (err) {
      if (err instanceof CorpusCorruptError) throw err;
      throw new CorpusCorruptError(
        `CORPUS_CORRUPT: Failed to read or parse chunks JSONL from '${filePath}'`,
      );
    }
  }

  async hasChunks(chunkerProfileId: string, snapshotId: string): Promise<boolean> {
    const filePath = path.join(this.chunksDir, chunkerProfileId, `${snapshotId}.jsonl`);
    return fs.existsSync(filePath);
  }

  // Revisions
  async saveRevision(revision: CorpusRevision): Promise<void> {
    const filePath = path.join(this.revisionsDir, `${revision.corpusRevisionId}.json`);

    if (fs.existsSync(filePath)) {
      try {
        const existingContent = fs.readFileSync(filePath, 'utf-8');
        const existingRev = JSON.parse(existingContent) as CorpusRevision;
        if (
          existingRev.corpusRevisionId !== revision.corpusRevisionId ||
          toCanonicalJson(existingRev) !== toCanonicalJson(revision)
        ) {
          throw new CorpusCorruptError(
            `CORPUS_CORRUPT: Revision '${revision.corpusRevisionId}' already exists with different payload`,
          );
        }
        return; // Identical, idempotent no-op
      } catch (err) {
        if (err instanceof CorpusCorruptError) throw err;
        throw new CorpusCorruptError(
          `CORPUS_CORRUPT: Existing revision file '${filePath}' is corrupted and unparseable`,
        );
      }
    }

    this.atomicWriteFileSync(filePath, JSON.stringify(revision, null, 2));
  }

  async getRevision(corpusRevisionId: string): Promise<CorpusRevision | null> {
    const filePath = path.join(this.revisionsDir, `${corpusRevisionId}.json`);
    if (!fs.existsSync(filePath)) return null;

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const rev = JSON.parse(content) as CorpusRevision;
      if (rev.corpusRevisionId !== corpusRevisionId) {
        throw new CorpusCorruptError(
          `CORPUS_CORRUPT: Revision at '${filePath}' contains mismatched corpusRevisionId`,
        );
      }
      return rev;
    } catch (err) {
      if (err instanceof CorpusCorruptError) throw err;
      throw new CorpusCorruptError(
        `CORPUS_CORRUPT: Failed to read or parse revision from '${filePath}'`,
      );
    }
  }

  async hasRevision(corpusRevisionId: string): Promise<boolean> {
    const filePath = path.join(this.revisionsDir, `${corpusRevisionId}.json`);
    return fs.existsSync(filePath);
  }

  // Profiles
  async saveProfile(profileId: string, profile: unknown): Promise<void> {
    const filePath = path.join(this.profilesDir, `${profileId}.json`);

    if (fs.existsSync(filePath)) {
      try {
        const existingContent = fs.readFileSync(filePath, 'utf-8');
        const existingProfile = JSON.parse(existingContent);
        if (toCanonicalJson(existingProfile) !== toCanonicalJson(profile)) {
          throw new CorpusCorruptError(
            `CORPUS_CORRUPT: Profile '${profileId}' already exists with different payload`,
          );
        }
        return; // Identical, idempotent no-op
      } catch (err) {
        if (err instanceof CorpusCorruptError) throw err;
        throw new CorpusCorruptError(
          `CORPUS_CORRUPT: Existing profile file '${filePath}' is corrupted and unparseable`,
        );
      }
    }

    this.atomicWriteFileSync(filePath, JSON.stringify(profile, null, 2));
  }

  async getProfile<T = unknown>(profileId: string): Promise<T | null> {
    const filePath = path.join(this.profilesDir, `${profileId}.json`);
    if (!fs.existsSync(filePath)) return null;

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content) as T;
    } catch (err) {
      if (err instanceof CorpusCorruptError) throw err;
      throw new CorpusCorruptError(
        `CORPUS_CORRUPT: Failed to read or parse profile from '${filePath}'`,
      );
    }
  }

  async hasProfile(profileId: string): Promise<boolean> {
    const filePath = path.join(this.profilesDir, `${profileId}.json`);
    return fs.existsSync(filePath);
  }
}
