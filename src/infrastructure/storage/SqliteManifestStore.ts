/**
 * SqliteManifestStore
 * Relational SQLite manifest using better-sqlite3 with WAL mode and transaction support.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import type {
  ManifestStore,
  WriterLease,
  ReadLease,
} from '../../application/ports/ManifestStore.js';
import type {
  FetchObservation,
  PublishedPointer,
  IndexGeneration,
} from '../../domain/models/index.js';

export class SqliteManifestStore implements ManifestStore {
  private readonly db: Database.Database;

  constructor(dbPath: string = ':memory:') {
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS published_pointers (
        backend_key TEXT NOT NULL,
        library_id TEXT NOT NULL,
        version_key TEXT NOT NULL,
        generation_id TEXT NOT NULL,
        previous_generation_id TEXT,
        published_at TEXT NOT NULL,
        PRIMARY KEY (backend_key, library_id, version_key)
      );

      CREATE TABLE IF NOT EXISTS fetch_observations (
        document_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        snapshot_id TEXT,
        requested_url TEXT NOT NULL,
        fetched_url TEXT NOT NULL,
        status TEXT NOT NULL,
        last_checked_at TEXT,
        fetched_at TEXT,
        raw_hash TEXT,
        etag TEXT,
        last_modified TEXT
      );

      CREATE TABLE IF NOT EXISTS index_runs (
        generation_id TEXT PRIMARY KEY,
        backend_key TEXT NOT NULL,
        corpus_revision_id TEXT NOT NULL,
        index_profile_hash TEXT NOT NULL,
        state TEXT NOT NULL,
        entry_count INTEGER NOT NULL,
        entry_ids_json TEXT NOT NULL,
        readiness_result_json TEXT
      );

      CREATE TABLE IF NOT EXISTS writer_leases (
        lease_key TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        fencing_token INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS read_leases (
        lease_id TEXT PRIMARY KEY,
        generation_id TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  async getPublishedPointer(
    backendKey: string,
    libraryId: string,
    versionKey: string,
  ): Promise<PublishedPointer | null> {
    const stmt = this.db.prepare(`
      SELECT backend_key, library_id, version_key, generation_id, previous_generation_id, published_at
      FROM published_pointers
      WHERE backend_key = ? AND library_id = ? AND version_key = ?
    `);
    const row = stmt.get(backendKey, libraryId, versionKey) as {
      backend_key: string;
      library_id: string;
      version_key: string;
      generation_id: string;
      previous_generation_id: string | null;
      published_at: string;
    } | undefined;

    if (!row) return null;

    return {
      backendKey: row.backend_key,
      libraryId: row.library_id,
      versionKey: row.version_key,
      generationId: row.generation_id,
      previousGenerationId: row.previous_generation_id ?? undefined,
      publishedAt: row.published_at,
    };
  }

  async setPublishedPointer(pointer: PublishedPointer): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO published_pointers (backend_key, library_id, version_key, generation_id, previous_generation_id, published_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(backend_key, library_id, version_key) DO UPDATE SET
        generation_id = excluded.generation_id,
        previous_generation_id = excluded.previous_generation_id,
        published_at = excluded.published_at
    `);

    stmt.run(
      pointer.backendKey,
      pointer.libraryId,
      pointer.versionKey,
      pointer.generationId,
      pointer.previousGenerationId ?? null,
      pointer.publishedAt,
    );
  }

  async recordObservation(obs: FetchObservation): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO fetch_observations (document_id, run_id, snapshot_id, requested_url, fetched_url, status, last_checked_at, fetched_at, raw_hash, etag, last_modified)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(document_id) DO UPDATE SET
        run_id = excluded.run_id,
        snapshot_id = excluded.snapshot_id,
        requested_url = excluded.requested_url,
        fetched_url = excluded.fetched_url,
        status = excluded.status,
        last_checked_at = excluded.last_checked_at,
        fetched_at = excluded.fetched_at,
        raw_hash = excluded.raw_hash,
        etag = excluded.etag,
        last_modified = excluded.last_modified
    `);

    stmt.run(
      obs.documentId,
      obs.runId,
      obs.snapshotId ?? null,
      obs.requestedUrl,
      obs.fetchedUrl,
      String(obs.status),
      obs.lastCheckedAt ?? null,
      obs.fetchedAt ?? null,
      obs.rawHash ?? null,
      obs.ETag ?? null,
      obs.LastModified ?? null,
    );
  }

  async getObservation(documentId: string): Promise<FetchObservation | null> {
    const stmt = this.db.prepare(`
      SELECT document_id, run_id, snapshot_id, requested_url, fetched_url, status, last_checked_at, fetched_at, raw_hash, etag, last_modified
      FROM fetch_observations
      WHERE document_id = ?
    `);
    const row = stmt.get(documentId) as {
      document_id: string;
      run_id: string;
      snapshot_id: string | null;
      requested_url: string;
      fetched_url: string;
      status: string;
      last_checked_at: string | null;
      fetched_at: string | null;
      raw_hash: string | null;
      etag: string | null;
      last_modified: string | null;
    } | undefined;

    if (!row) return null;

    const statusParsed = row.status === 'network_error' ? 'network_error' : Number(row.status);

    return {
      documentId: row.document_id,
      runId: row.run_id,
      snapshotId: row.snapshot_id ?? undefined,
      requestedUrl: row.requested_url,
      fetchedUrl: row.fetched_url,
      status: statusParsed,
      lastCheckedAt: row.last_checked_at ?? undefined,
      fetchedAt: row.fetched_at ?? undefined,
      rawHash: row.raw_hash ?? undefined,
      ETag: row.etag ?? undefined,
      LastModified: row.last_modified ?? undefined,
    };
  }

  async getIndexGeneration(generationId: string): Promise<IndexGeneration | null> {
    const stmt = this.db.prepare(`
      SELECT generation_id, backend_key, corpus_revision_id, index_profile_hash, state, entry_count, entry_ids_json, readiness_result_json
      FROM index_runs
      WHERE generation_id = ?
    `);
    const row = stmt.get(generationId) as {
      generation_id: string;
      backend_key: string;
      corpus_revision_id: string;
      index_profile_hash: string;
      state: string;
      entry_count: number;
      entry_ids_json: string;
      readiness_result_json: string | null;
    } | undefined;

    if (!row) return null;

    return {
      generationId: row.generation_id,
      backendKey: row.backend_key,
      corpusRevisionId: row.corpus_revision_id,
      indexProfileHash: row.index_profile_hash,
      state: row.state as IndexGeneration['state'],
      entryCount: row.entry_count,
      entryIds: JSON.parse(row.entry_ids_json) as string[],
      readinessResult: row.readiness_result_json ? JSON.parse(row.readiness_result_json) : undefined,
    };
  }

  async saveIndexGeneration(generation: IndexGeneration): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO index_runs (generation_id, backend_key, corpus_revision_id, index_profile_hash, state, entry_count, entry_ids_json, readiness_result_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(generation_id) DO UPDATE SET
        backend_key = excluded.backend_key,
        corpus_revision_id = excluded.corpus_revision_id,
        index_profile_hash = excluded.index_profile_hash,
        state = excluded.state,
        entry_count = excluded.entry_count,
        entry_ids_json = excluded.entry_ids_json,
        readiness_result_json = excluded.readiness_result_json
    `);

    stmt.run(
      generation.generationId,
      generation.backendKey,
      generation.corpusRevisionId,
      generation.indexProfileHash,
      generation.state,
      generation.entryCount,
      JSON.stringify(generation.entryIds),
      generation.readinessResult ? JSON.stringify(generation.readinessResult) : null,
    );
  }

  async acquireWriterLease(ownerId: string, ttlMs: number): Promise<WriterLease | null> {
    const now = Date.now();
    const expiresAt = new Date(now + ttlMs).toISOString();

    const current = this.db.prepare(`SELECT owner_id, expires_at, fencing_token FROM writer_leases WHERE lease_key = 'main'`).get() as {
      owner_id: string;
      expires_at: string;
      fencing_token: number;
    } | undefined;

    if (current && new Date(current.expires_at).getTime() > now && current.owner_id !== ownerId) {
      return null; // Busy
    }

    const nextFencingToken = (current?.fencing_token ?? 0) + 1;

    this.db.prepare(`
      INSERT INTO writer_leases (lease_key, owner_id, expires_at, fencing_token)
      VALUES ('main', ?, ?, ?)
      ON CONFLICT(lease_key) DO UPDATE SET
        owner_id = excluded.owner_id,
        expires_at = excluded.expires_at,
        fencing_token = excluded.fencing_token
    `).run(ownerId, expiresAt, nextFencingToken);

    return {
      ownerId,
      expiresAt,
      fencingToken: nextFencingToken,
    };
  }

  async renewWriterLease(ownerId: string, fencingToken: number, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const expiresAt = new Date(now + ttlMs).toISOString();

    const res = this.db.prepare(`
      UPDATE writer_leases
      SET expires_at = ?
      WHERE lease_key = 'main' AND owner_id = ? AND fencing_token = ?
    `).run(expiresAt, ownerId, fencingToken);

    return res.changes > 0;
  }

  async releaseWriterLease(ownerId: string, fencingToken: number): Promise<void> {
    this.db.prepare(`
      DELETE FROM writer_leases
      WHERE lease_key = 'main' AND owner_id = ? AND fencing_token = ?
    `).run(ownerId, fencingToken);
  }

  async acquireReadLease(generationId: string, ttlMs: number): Promise<ReadLease> {
    const leaseId = `read_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();

    this.db.prepare(`
      INSERT INTO read_leases (lease_id, generation_id, expires_at)
      VALUES (?, ?, ?)
    `).run(leaseId, generationId, expiresAt);

    return { leaseId, generationId, expiresAt };
  }

  async releaseReadLease(leaseId: string): Promise<void> {
    this.db.prepare(`DELETE FROM read_leases WHERE lease_id = ?`).run(leaseId);
  }
}
