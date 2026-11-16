import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { join } from 'node:path';

const MIGRATIONS: string[] = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE printers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    enabled INTEGER NOT NULL DEFAULT 0,
    role TEXT NOT NULL DEFAULT 'any',        -- bw | color | any
    priority INTEGER NOT NULL DEFAULT 0,     -- lower = preferred; backups use higher numbers
    caps TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'unknown',  -- ready | offline | error | paused | unknown
    status_detail TEXT,
    present INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    idem_key TEXT UNIQUE,
    state TEXT NOT NULL,
    total INTEGER,
    estimate TEXT,
    pricing TEXT,
    amount_received INTEGER,
    error TEXT,
    files_removed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX jobs_state ON jobs(state, updated_at);
  CREATE INDEX jobs_created ON jobs(created_at);

  CREATE TABLE documents (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    size INTEGER NOT NULL,
    pages INTEGER NOT NULL,
    options TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX documents_job ON documents(job_id, position);

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    printer_id TEXT,
    seq INTEGER NOT NULL,
    state TEXT NOT NULL,                     -- waiting | queued | processing | printing | completed | failed | manual_review | cancelled
    spool_ref TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX tasks_printer ON tasks(printer_id, state, seq);
  CREATE INDEX tasks_job ON tasks(job_id);

  CREATE TABLE job_events (
    id INTEGER PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    at INTEGER NOT NULL,
    type TEXT NOT NULL,
    detail TEXT
  );
  CREATE INDEX job_events_job ON job_events(job_id);

  CREATE TABLE cleanup (path TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL);
  `,
];

export type Row = Record<string, unknown>;

export class Db {
  readonly raw: DatabaseSync;
  // Prepared statements are reused; preparing per call is the main avoidable SQLite cost.
  private cache = new Map<string, StatementSync>();

  constructor(dir: string | ':memory:') {
    this.raw = new DatabaseSync(dir === ':memory:' ? dir : join(dir, 'printhub.db'));
    this.raw.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 3000;
      PRAGMA cache_size = -4000;
      PRAGMA temp_store = MEMORY;
    `);
    this.migrate();
  }

  private migrate() {
    const version = Number((this.raw.prepare('PRAGMA user_version').get() as Row).user_version);
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.raw.exec(MIGRATIONS[v]!);
        this.raw.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  get<T = Row>(sql: string, ...params: SqlParam[]): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined;
  }
  all<T = Row>(sql: string, ...params: SqlParam[]): T[] {
    return this.stmt(sql).all(...params) as T[];
  }
  run(sql: string, ...params: SqlParam[]) {
    return this.stmt(sql).run(...params);
  }

  /** Synchronous transaction; nested calls join the outer transaction. */
  tx<T>(fn: () => T): T {
    if (this.raw.isTransaction) return fn();
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.raw.exec('COMMIT');
      return r;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    }
  }

  close() {
    this.cache.clear();
    this.raw.close();
  }
}

export type SqlParam = string | number | bigint | null | Uint8Array;
