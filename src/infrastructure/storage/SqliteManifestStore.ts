/**
 * SqliteManifestStore
 * Relational SQLite manifest using better-sqlite3 with WAL mode, transaction support,
 * and user_version schema migrations (v1 and v2).
 * Strict Layer Boundary: Infrastructure imports only domain and application/ports.
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
  SyncRunRecord,
  CorpusRevisionMetadata,
} from '../../domain/models/index.js';
import { CliOperationError } from '../../domain/errors.js';

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
    const userVersion = this.db.pragma('user_version', { simple: true }) as number;

    if (userVersion < 1) {
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
          last_modified TEXT,
          consecutive_absences INTEGER DEFAULT 0
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
      this.db.pragma('user_version = 1');
    }

    if (userVersion < 2) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS sync_runs (
          run_id TEXT PRIMARY KEY,
          library_id TEXT NOT NULL,
          version_key TEXT NOT NULL,
          source_hash TEXT NOT NULL,
          profile_hash TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          discovered_count INTEGER NOT NULL DEFAULT 0,
          fetched_count INTEGER NOT NULL DEFAULT 0,
          stored_count INTEGER NOT NULL DEFAULT 0,
          unchanged_count INTEGER NOT NULL DEFAULT 0,
          error_count INTEGER NOT NULL DEFAULT 0,
          error_code TEXT,
          error_message TEXT,
          corpus_revision_id TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_sync_runs_lib_ver ON sync_runs(library_id, version_key, started_at DESC);

        CREATE TABLE IF NOT EXISTS corpus_revisions (
          corpus_revision_id TEXT PRIMARY KEY,
          library_id TEXT NOT NULL,
          version_key TEXT NOT NULL,
          created_at TEXT NOT NULL,
          version_profile_hash TEXT NOT NULL,
          document_count INTEGER NOT NULL,
          sync_run_id TEXT NOT NULL,
          is_complete INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_corpus_revisions_lookup ON corpus_revisions(library_id, version_key, created_at DESC);
      `);
      this.db.pragma('user_version = 2');
    }

    // Ensure consecutive_absences column exists for older databases
    const columns = this.db.pragma('table_info(fetch_observations)') as Array<{ name: string }>;
    if (columns.length > 0 && !columns.some((c) => c.name === 'consecutive_absences')) {
      this.db.exec('ALTER TABLE fetch_observations ADD COLUMN consecutive_absences INTEGER DEFAULT 0');
    }
  }

  close(): void {
    this.db.close();
  }

  // Published pointers
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
    const row = stmt.get(backendKey, libraryId, versionKey) as
      | {
          backend_key: string;
          library_id: string;
          version_key: string;
          generation_id: string;
          previous_generation_id: string | null;
          published_at: string;
        }
      | undefined;

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

  // Observations
  async recordObservation(obs: FetchObservation): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO fetch_observations (document_id, run_id, snapshot_id, requested_url, fetched_url, status, last_checked_at, fetched_at, raw_hash, etag, last_modified, consecutive_absences)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        last_modified = excluded.last_modified,
        consecutive_absences = excluded.consecutive_absences
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
      obs.consecutiveAbsences ?? 0,
    );
  }

  async getObservation(documentId: string): Promise<FetchObservation | null> {
    const stmt = this.db.prepare(`
      SELECT document_id, run_id, snapshot_id, requested_url, fetched_url, status, last_checked_at, fetched_at, raw_hash, etag, last_modified, consecutive_absences
      FROM fetch_observations
      WHERE document_id = ?
    `);
    const row = stmt.get(documentId) as
      | {
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
          consecutive_absences: number | null;
        }
      | undefined;

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
      consecutiveAbsences: row.consecutive_absences ?? 0,
    };
  }

  async getObservationsForLibrary(
    libraryId: string,
    versionKey: string,
  ): Promise<FetchObservation[]> {
    const stmt = this.db.prepare(`
      SELECT o.document_id, o.run_id, o.snapshot_id, o.requested_url, o.fetched_url,
             o.status, o.last_checked_at, o.fetched_at, o.raw_hash, o.etag, o.last_modified, o.consecutive_absences
      FROM fetch_observations o
      JOIN sync_runs s ON o.run_id = s.run_id
      WHERE s.library_id = ? AND s.version_key = ?
      ORDER BY o.last_checked_at DESC
    `);
    const rows = stmt.all(libraryId, versionKey) as Array<{
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
      consecutive_absences: number | null;
    }>;

    return rows.map((row) => ({
      documentId: row.document_id,
      runId: row.run_id,
      snapshotId: row.snapshot_id ?? undefined,
      requestedUrl: row.requested_url,
      fetchedUrl: row.fetched_url,
      status: row.status === 'network_error' ? 'network_error' : Number(row.status),
      lastCheckedAt: row.last_checked_at ?? undefined,
      fetchedAt: row.fetched_at ?? undefined,
      rawHash: row.raw_hash ?? undefined,
      ETag: row.etag ?? undefined,
      LastModified: row.last_modified ?? undefined,
      consecutiveAbsences: row.consecutive_absences ?? 0,
    }));
  }

  // Generations
  async getIndexGeneration(generationId: string): Promise<IndexGeneration | null> {
    const stmt = this.db.prepare(`
      SELECT generation_id, backend_key, corpus_revision_id, index_profile_hash, state, entry_count, entry_ids_json, readiness_result_json
      FROM index_runs
      WHERE generation_id = ?
    `);
    const row = stmt.get(generationId) as
      | {
          generation_id: string;
          backend_key: string;
          corpus_revision_id: string;
          index_profile_hash: string;
          state: string;
          entry_count: number;
          entry_ids_json: string;
          readiness_result_json: string | null;
        }
      | undefined;

    if (!row) return null;

    return {
      generationId: row.generation_id,
      backendKey: row.backend_key,
      corpusRevisionId: row.corpus_revision_id,
      indexProfileHash: row.index_profile_hash,
      state: row.state as IndexGeneration['state'],
      entryCount: row.entry_count,
      entryIds: JSON.parse(row.entry_ids_json) as string[],
      readinessResult: row.readiness_result_json
        ? JSON.parse(row.readiness_result_json)
        : undefined,
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

  // Sync Runs
  async startSyncRun(run: SyncRunRecord): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO sync_runs (
        run_id, library_id, version_key, source_hash, profile_hash,
        status, started_at, completed_at, discovered_count, fetched_count,
        stored_count, unchanged_count, error_count, error_code, error_message, corpus_revision_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        status = excluded.status,
        source_hash = excluded.source_hash,
        profile_hash = excluded.profile_hash
    `);

    stmt.run(
      run.runId,
      run.libraryId,
      run.versionKey,
      run.sourceHash,
      run.profileHash,
      run.status,
      run.startedAt,
      run.completedAt ?? null,
      run.discoveredCount,
      run.fetchedCount,
      run.storedCount,
      run.unchangedCount,
      run.errorCount,
      run.errorCode ?? null,
      run.errorMessage ?? null,
      run.corpusRevisionId ?? null,
    );
  }

  async updateSyncRun(run: Partial<SyncRunRecord> & { runId: string }): Promise<void> {
    const fields: string[] = [];
    const params: unknown[] = [];

    if (run.status !== undefined) {
      fields.push('status = ?');
      params.push(run.status);
    }
    if (run.completedAt !== undefined) {
      fields.push('completed_at = ?');
      params.push(run.completedAt);
    }
    if (run.discoveredCount !== undefined) {
      fields.push('discovered_count = ?');
      params.push(run.discoveredCount);
    }
    if (run.fetchedCount !== undefined) {
      fields.push('fetched_count = ?');
      params.push(run.fetchedCount);
    }
    if (run.storedCount !== undefined) {
      fields.push('stored_count = ?');
      params.push(run.storedCount);
    }
    if (run.unchangedCount !== undefined) {
      fields.push('unchanged_count = ?');
      params.push(run.unchangedCount);
    }
    if (run.errorCount !== undefined) {
      fields.push('error_count = ?');
      params.push(run.errorCount);
    }
    if (run.errorCode !== undefined) {
      fields.push('error_code = ?');
      params.push(run.errorCode);
    }
    if (run.errorMessage !== undefined) {
      fields.push('error_message = ?');
      params.push(run.errorMessage);
    }
    if (run.corpusRevisionId !== undefined) {
      fields.push('corpus_revision_id = ?');
      params.push(run.corpusRevisionId);
    }

    if (fields.length > 0) {
      params.push(run.runId);
      this.db.prepare(`UPDATE sync_runs SET ${fields.join(', ')} WHERE run_id = ?`).run(...params);
    }
  }

  async getSyncRun(runId: string): Promise<SyncRunRecord | null> {
    const stmt = this.db.prepare(`
      SELECT run_id, library_id, version_key, source_hash, profile_hash, status, started_at, completed_at,
             discovered_count, fetched_count, stored_count, unchanged_count, error_count,
             error_code, error_message, corpus_revision_id
      FROM sync_runs
      WHERE run_id = ?
    `);
    const row = stmt.get(runId) as
      | {
          run_id: string;
          library_id: string;
          version_key: string;
          source_hash: string;
          profile_hash: string;
          status: string;
          started_at: string;
          completed_at: string | null;
          discovered_count: number;
          fetched_count: number;
          stored_count: number;
          unchanged_count: number;
          error_count: number;
          error_code: string | null;
          error_message: string | null;
          corpus_revision_id: string | null;
        }
      | undefined;

    if (!row) return null;

    return {
      runId: row.run_id,
      libraryId: row.library_id,
      versionKey: row.version_key,
      sourceHash: row.source_hash,
      profileHash: row.profile_hash,
      status: row.status as SyncRunRecord['status'],
      startedAt: row.started_at,
      completedAt: row.completed_at ?? undefined,
      discoveredCount: row.discovered_count,
      fetchedCount: row.fetched_count,
      storedCount: row.stored_count,
      unchangedCount: row.unchanged_count,
      errorCount: row.error_count,
      errorCode: row.error_code ?? undefined,
      errorMessage: row.error_message ?? undefined,
      corpusRevisionId: row.corpus_revision_id ?? undefined,
    };
  }

  async getLatestSyncRun(libraryId: string, versionKey: string): Promise<SyncRunRecord | null> {
    const stmt = this.db.prepare(`
      SELECT run_id, library_id, version_key, source_hash, profile_hash, status, started_at, completed_at,
             discovered_count, fetched_count, stored_count, unchanged_count, error_count,
             error_code, error_message, corpus_revision_id
      FROM sync_runs
      WHERE library_id = ? AND version_key = ?
      ORDER BY started_at DESC
      LIMIT 1
    `);
    const row = stmt.get(libraryId, versionKey) as
      | {
          run_id: string;
          library_id: string;
          version_key: string;
          source_hash: string;
          profile_hash: string;
          status: string;
          started_at: string;
          completed_at: string | null;
          discovered_count: number;
          fetched_count: number;
          stored_count: number;
          unchanged_count: number;
          error_count: number;
          error_code: string | null;
          error_message: string | null;
          corpus_revision_id: string | null;
        }
      | undefined;

    if (!row) return null;

    return {
      runId: row.run_id,
      libraryId: row.library_id,
      versionKey: row.version_key,
      sourceHash: row.source_hash,
      profileHash: row.profile_hash,
      status: row.status as SyncRunRecord['status'],
      startedAt: row.started_at,
      completedAt: row.completed_at ?? undefined,
      discoveredCount: row.discovered_count,
      fetchedCount: row.fetched_count,
      storedCount: row.stored_count,
      unchangedCount: row.unchanged_count,
      errorCount: row.error_count,
      errorCode: row.error_code ?? undefined,
      errorMessage: row.error_message ?? undefined,
      corpusRevisionId: row.corpus_revision_id ?? undefined,
    };
  }

  // Corpus Revisions
  async registerCorpusRevision(metadata: CorpusRevisionMetadata): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO corpus_revisions (
        corpus_revision_id, library_id, version_key, created_at,
        version_profile_hash, document_count, sync_run_id, is_complete
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(corpus_revision_id) DO UPDATE SET
        is_complete = excluded.is_complete,
        document_count = excluded.document_count
    `);

    stmt.run(
      metadata.corpusRevisionId,
      metadata.libraryId,
      metadata.versionKey,
      metadata.createdAt,
      metadata.versionProfileHash,
      metadata.documentCount,
      metadata.syncRunId,
      metadata.isComplete ? 1 : 0,
    );
  }

  async getLatestCorpusRevision(
    libraryId: string,
    versionKey: string,
  ): Promise<CorpusRevisionMetadata | null> {
    const stmt = this.db.prepare(`
      SELECT corpus_revision_id, library_id, version_key, created_at, version_profile_hash, document_count, sync_run_id, is_complete
      FROM corpus_revisions
      WHERE library_id = ? AND version_key = ? AND is_complete = 1
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const row = stmt.get(libraryId, versionKey) as
      | {
          corpus_revision_id: string;
          library_id: string;
          version_key: string;
          created_at: string;
          version_profile_hash: string;
          document_count: number;
          sync_run_id: string;
          is_complete: number;
        }
      | undefined;

    if (!row) return null;

    return {
      corpusRevisionId: row.corpus_revision_id,
      libraryId: row.library_id,
      versionKey: row.version_key,
      createdAt: row.created_at,
      versionProfileHash: row.version_profile_hash,
      documentCount: row.document_count,
      syncRunId: row.sync_run_id,
      isComplete: Boolean(row.is_complete),
    };
  }

  async getCorpusRevision(corpusRevisionId: string): Promise<CorpusRevisionMetadata | null> {
    const stmt = this.db.prepare(`
      SELECT corpus_revision_id, library_id, version_key, created_at, version_profile_hash, document_count, sync_run_id, is_complete
      FROM corpus_revisions
      WHERE corpus_revision_id = ?
    `);
    const row = stmt.get(corpusRevisionId) as
      | {
          corpus_revision_id: string;
          library_id: string;
          version_key: string;
          created_at: string;
          version_profile_hash: string;
          document_count: number;
          sync_run_id: string;
          is_complete: number;
        }
      | undefined;

    if (!row) return null;

    return {
      corpusRevisionId: row.corpus_revision_id,
      libraryId: row.library_id,
      versionKey: row.version_key,
      createdAt: row.created_at,
      versionProfileHash: row.version_profile_hash,
      documentCount: row.document_count,
      syncRunId: row.sync_run_id,
      isComplete: Boolean(row.is_complete),
    };
  }

  async listCorpusRevisions(
    libraryId: string,
    versionKey: string,
  ): Promise<CorpusRevisionMetadata[]> {
    const stmt = this.db.prepare(`
      SELECT corpus_revision_id, library_id, version_key, created_at, version_profile_hash, document_count, sync_run_id, is_complete
      FROM corpus_revisions
      WHERE library_id = ? AND version_key = ?
      ORDER BY created_at DESC
    `);
    const rows = stmt.all(libraryId, versionKey) as Array<{
      corpus_revision_id: string;
      library_id: string;
      version_key: string;
      created_at: string;
      version_profile_hash: string;
      document_count: number;
      sync_run_id: string;
      is_complete: number;
    }>;

    return rows.map((row) => ({
      corpusRevisionId: row.corpus_revision_id,
      libraryId: row.library_id,
      versionKey: row.version_key,
      createdAt: row.created_at,
      versionProfileHash: row.version_profile_hash,
      documentCount: row.document_count,
      syncRunId: row.sync_run_id,
      isComplete: Boolean(row.is_complete),
    }));
  }

  // Atomic Sync Revision Commit (Single SQLite transaction)
  async commitSyncRevision(
    revision: CorpusRevisionMetadata,
    syncRunUpdate: Partial<SyncRunRecord> & { runId: string },
    lease?: { ownerId: string; fencingToken: number },
  ): Promise<void> {
    const tx = this.db.transaction(() => {
      // 0. Verify writer lease fencing token and validity
      if (!lease) {
        throw new CliOperationError({
          code: 'RESOURCE_BUSY',
          message: 'Writer lease ownerId and fencingToken are required to commit revision.',
        });
      }

      const current = this.db
        .prepare(
          `SELECT owner_id, expires_at, fencing_token FROM writer_leases WHERE lease_key = 'main'`,
        )
        .get() as
        | {
            owner_id: string;
            expires_at: string;
            fencing_token: number;
          }
        | undefined;

      const now = Date.now();
      const isValid =
        current &&
        current.owner_id === lease.ownerId &&
        current.fencing_token === lease.fencingToken &&
        new Date(current.expires_at).getTime() > now;

      if (!isValid) {
        throw new CliOperationError({
          code: 'RESOURCE_BUSY',
          message: `Cannot commit revision: writer lease for '${lease.ownerId}' with fencing token ${lease.fencingToken} is expired or invalid.`,
        });
      }

      // 1. Insert or update corpus_revisions
      this.db.prepare(`
        INSERT INTO corpus_revisions (
          corpus_revision_id, library_id, version_key, created_at,
          version_profile_hash, document_count, sync_run_id, is_complete
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(corpus_revision_id) DO UPDATE SET
          is_complete = 1,
          document_count = excluded.document_count
      `).run(
        revision.corpusRevisionId,
        revision.libraryId,
        revision.versionKey,
        revision.createdAt,
        revision.versionProfileHash,
        revision.documentCount,
        revision.syncRunId,
      );

      // 2. Update sync_runs
      this.db.prepare(`
        UPDATE sync_runs SET
          status = 'complete',
          completed_at = ?,
          corpus_revision_id = ?,
          stored_count = COALESCE(?, stored_count),
          unchanged_count = COALESCE(?, unchanged_count),
          discovered_count = COALESCE(?, discovered_count),
          fetched_count = COALESCE(?, fetched_count)
        WHERE run_id = ?
      `).run(
        syncRunUpdate.completedAt ?? new Date().toISOString(),
        revision.corpusRevisionId,
        syncRunUpdate.storedCount ?? null,
        syncRunUpdate.unchangedCount ?? null,
        syncRunUpdate.discoveredCount ?? null,
        syncRunUpdate.fetchedCount ?? null,
        syncRunUpdate.runId,
      );
    });

    tx();
  }

  // Leases
  async acquireWriterLease(ownerId: string, ttlMs: number = 30000): Promise<WriterLease | null> {
    const now = Date.now();
    const expiresAt = new Date(now + ttlMs).toISOString();

    const current = this.db
      .prepare(
        `SELECT owner_id, expires_at, fencing_token FROM writer_leases WHERE lease_key = 'main'`,
      )
      .get() as
      | {
          owner_id: string;
          expires_at: string;
          fencing_token: number;
        }
      | undefined;

    if (current && new Date(current.expires_at).getTime() > now && current.owner_id !== ownerId) {
      return null; // Busy
    }

    const nextFencingToken = (current?.fencing_token ?? 0) + 1;

    this.db
      .prepare(
        `
      INSERT INTO writer_leases (lease_key, owner_id, expires_at, fencing_token)
      VALUES ('main', ?, ?, ?)
      ON CONFLICT(lease_key) DO UPDATE SET
        owner_id = excluded.owner_id,
        expires_at = excluded.expires_at,
        fencing_token = excluded.fencing_token
    `,
      )
      .run(ownerId, expiresAt, nextFencingToken);

    return {
      ownerId,
      expiresAt,
      fencingToken: nextFencingToken,
    };
  }

  async renewWriterLease(
    ownerId: string,
    fencingToken: number,
    ttlMs: number = 30000,
  ): Promise<boolean> {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const expiresAt = new Date(now + ttlMs).toISOString();

    const res = this.db
      .prepare(
        `
      UPDATE writer_leases
      SET expires_at = ?
      WHERE lease_key = 'main'
        AND owner_id = ?
        AND fencing_token = ?
        AND expires_at > ?
    `,
      )
      .run(expiresAt, ownerId, fencingToken, nowIso);

    return res.changes > 0;
  }

  async releaseWriterLease(ownerId: string, fencingToken: number): Promise<void> {
    this.db
      .prepare(
        `
      UPDATE writer_leases
      SET expires_at = '1970-01-01T00:00:00.000Z'
      WHERE lease_key = 'main' AND owner_id = ? AND fencing_token = ?
    `,
      )
      .run(ownerId, fencingToken);
  }

  async isWriterLeaseValid(ownerId: string, fencingToken: number): Promise<boolean> {
    const row = this.db
      .prepare(
        `SELECT owner_id, expires_at, fencing_token FROM writer_leases WHERE lease_key = 'main'`,
      )
      .get() as
      | {
          owner_id: string;
          expires_at: string;
          fencing_token: number;
        }
      | undefined;

    if (!row) return false;
    const notExpired = new Date(row.expires_at).getTime() > Date.now();
    return notExpired && row.owner_id === ownerId && row.fencing_token === fencingToken;
  }

  async acquireReadLease(generationId: string, ttlMs: number): Promise<ReadLease> {
    const leaseId = `read_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();

    this.db
      .prepare(
        `
      INSERT INTO read_leases (lease_id, generation_id, expires_at)
      VALUES (?, ?, ?)
    `,
      )
      .run(leaseId, generationId, expiresAt);

    return { leaseId, generationId, expiresAt };
  }

  async releaseReadLease(leaseId: string): Promise<void> {
    this.db.prepare(`DELETE FROM read_leases WHERE lease_id = ?`).run(leaseId);
  }

  async checkIntegrity(): Promise<{ ok: boolean; message: string }> {
    try {
      const result = this.db.pragma('integrity_check', { simple: true }) as string;
      return {
        ok: result === 'ok',
        message: result === 'ok' ? 'SQLite PRAGMA integrity_check passed' : `Integrity check: ${result}`,
      };
    } catch (err) {
      return {
        ok: false,
        message: `Integrity check failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
