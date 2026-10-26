/**
 * v2 (2026-10-26): the app's own state — jobs and their tries, projects and threads, important items, the calendar
 * and mail caches, devices, the event log that drives live updates and offline sync. Not knowledge: what the agent
 * KNOWS stays in AWM; logs stay JSONL. A small SQLite file beside agent.db, the same shape as approvals.db
 * (src/tools/approval.ts): WAL, a busy timeout so the Telegram process can share it, migrations by name.
 *
 * Why not AWM engrams: fields would live in tags, every scheduler tick scans the whole agent, there are no
 * transactions or indexes, and consolidation can archive state away. Why not JSONL: an update is an append that is
 * folded in later, and every read loads megabytes. A job claim (`UPDATE … WHERE state='queued' RETURNING`), a
 * "handled" flag and an "updated since" cursor need a real table.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { dbFile } from '../paths.js';

export type AppDb = InstanceType<typeof Database>;

/** One schema step. Applied once, in order, inside a transaction; its name is recorded in `migrations`. */
export interface Migration { name: string; sql: string }

/** The platform tables every slice relies on. Later slices append their own steps (jobs, items, caches…). */
export const BASE_MIGRATIONS: Migration[] = [
  {
    name: '001-platform',
    sql: `
      -- One sequence for everything that changed: the live stream's cursor and the phone's "updated since".
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, person TEXT,
        entity TEXT NOT NULL, entity_id TEXT NOT NULL, op TEXT NOT NULL CHECK (op IN ('upsert','delete')), payload TEXT);
      CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
      -- A retried write gets the first answer back instead of acting twice (the phone's offline queue).
      -- The key is reserved ('pending') before the handler runs; fingerprint = hash of method, path, query and body.
      CREATE TABLE IF NOT EXISTS idempotency (
        key TEXT NOT NULL, device TEXT NOT NULL, route TEXT NOT NULL, fingerprint TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending','done')), status INTEGER NOT NULL, response TEXT NOT NULL,
        headers TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (key, device));
      CREATE INDEX IF NOT EXISTS idempotency_created ON idempotency(created_at);`,
  },
  {
    // Shared by the calendar (A7, resource 'calendar') and mail (A8, resource 'mail') syncs; read and written only
    // through src/v2/sync-state.ts. A base step, so it exists before either slice's own migration runs. Windows and
    // times are INTEGER epoch milliseconds. The rebuild converts a table an earlier build created with TEXT windows:
    // whole-number text becomes an integer, anything else (an ISO date) becomes NULL — a window is recomputed on
    // the next sync anyway; cursors are kept.
    name: '001b-sync-state',
    sql: `
      CREATE TABLE IF NOT EXISTS sync_state (
        account TEXT NOT NULL, resource TEXT NOT NULL, cursor TEXT, window_from INTEGER, window_to INTEGER,
        last_ok INTEGER, last_error TEXT, needs_reconnect INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (account, resource));
      CREATE TABLE sync_state_rebuild (
        account TEXT NOT NULL, resource TEXT NOT NULL, cursor TEXT, window_from INTEGER, window_to INTEGER,
        last_ok INTEGER, last_error TEXT, needs_reconnect INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (account, resource));
      INSERT INTO sync_state_rebuild (account, resource, cursor, window_from, window_to, last_ok, last_error, needs_reconnect)
        SELECT account, resource, cursor,
          CASE WHEN typeof(window_from) IN ('integer', 'real') THEN CAST(window_from AS INTEGER)
               WHEN typeof(window_from) = 'text' AND window_from <> '' AND window_from NOT GLOB '*[^0-9]*' THEN CAST(window_from AS INTEGER) END,
          CASE WHEN typeof(window_to) IN ('integer', 'real') THEN CAST(window_to AS INTEGER)
               WHEN typeof(window_to) = 'text' AND window_to <> '' AND window_to NOT GLOB '*[^0-9]*' THEN CAST(window_to AS INTEGER) END,
          CASE WHEN typeof(last_ok) IN ('integer', 'real') THEN CAST(last_ok AS INTEGER) END,
          last_error, COALESCE(needs_reconnect, 0)
        FROM sync_state;
      DROP TABLE sync_state;
      ALTER TABLE sync_state_rebuild RENAME TO sync_state;`,
  },
];

let db: AppDb | null = null;
let dbPathUsed: string | null = null;
const extra: Migration[] = [];

/** Where app.db lives: MWA_APP_DB, else beside the agent DB. Under vitest it is in memory unless a test says so. */
export function appDbPath(env: Record<string, string | undefined> = process.env): string {
  if (env.MWA_APP_DB) return env.MWA_APP_DB;
  if (env.VITEST) return ':memory:';
  return join(dirname(dbFile(env)), 'app.db');
}

/** Register a slice's migrations (call at module load). Applied on the next appDb() open, or at once if open. */
export function registerMigrations(steps: Migration[]): void {
  for (const s of steps) if (!extra.some((x) => x.name === s.name)) extra.push(s);
  if (db) migrate(db, extra);
}

/**
 * Apply the steps not yet recorded, in order. Re-running is a no-op. Returns the names applied now.
 *
 * Review of A0 (2026-10-26): each step runs in an IMMEDIATE transaction that re-checks its name inside, so two
 * processes opening app.db together (serve and the Telegram process) cannot both apply it. Foreign keys are OFF while
 * migrating — `PRAGMA foreign_keys` is ignored inside a transaction, so a table rebuild (create new, copy, DROP old,
 * rename) would otherwise cascade-delete the children — and `foreign_key_check` must come back empty before commit.
 */
export function migrate(d: AppDb, steps: Migration[]): string[] {
  d.exec(`CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, at INTEGER NOT NULL, report TEXT)`);
  const fk = d.pragma('foreign_keys', { simple: true }) as number;
  if (fk) d.pragma('foreign_keys = OFF');
  const applied: string[] = [];
  try {
    for (const s of steps) {
      const ran = d.transaction((): boolean => {
        if (d.prepare('SELECT 1 FROM migrations WHERE name = ?').get(s.name)) return false;
        d.exec(s.sql);
        const broken = d.pragma('foreign_key_check') as unknown[];
        if (broken.length) throw new Error(`migration ${s.name} leaves ${broken.length} broken reference(s)`);
        d.prepare('INSERT INTO migrations (name, at) VALUES (?, ?)').run(s.name, Date.now());
        return true;
      }).immediate();
      if (ran) applied.push(s.name);
    }
  } finally {
    if (fk) d.pragma('foreign_keys = ON');
  }
  return applied;
}

/** The open app database (opened and migrated on first use). */
export function appDb(): AppDb {
  if (db) return db;
  dbPathUsed = dbPathUsed ?? appDbPath();
  if (dbPathUsed !== ':memory:') mkdirSync(dirname(resolve(dbPathUsed)), { recursive: true });
  const d = new Database(dbPathUsed);
  try {
    d.pragma('journal_mode = WAL');
    d.pragma('busy_timeout = 5000');
    d.pragma('foreign_keys = ON');
    migrate(d, [...BASE_MIGRATIONS, ...extra]);
  } catch (e) {
    d.close(); // a failed migration must fail again next time, not hand out a half-migrated database
    throw e;
  }
  db = d;
  return db;
}

/** Tests: close and forget the handle (optionally point the next open somewhere else). */
export function resetAppDb(path?: string): void {
  try { db?.close(); } catch { /* already closed */ }
  db = null; dbPathUsed = path ?? null;
}

/** Record a change: one row in `events`, returning its sequence number (the new `updated_seq` of the entity).
 *  Call it inside the same transaction as the write it describes. */
export function recordEvent(e: { entity: string; id: string; op?: 'upsert' | 'delete'; payload?: unknown; person?: string }, d: AppDb = appDb()): number {
  const r = d.prepare('INSERT INTO events (ts, person, entity, entity_id, op, payload) VALUES (?, ?, ?, ?, ?, ?)')
    .run(Date.now(), e.person ?? null, e.entity, e.id, e.op ?? 'upsert', e.payload === undefined ? null : JSON.stringify(e.payload));
  return Number(r.lastInsertRowid);
}
