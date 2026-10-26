/**
 * Sync state for the calendar (A7) and mail (A8) syncs — one row per account and resource ('calendar', 'mail'):
 * the provider's cursor, the window synced (INTEGER epoch ms), the last success, the last error, and whether the
 * sign-in must be renewed. The table is a base migration (src/v2/db.ts '001b-sync-state'); every read and write goes
 * through here.
 *
 * Accounts are keyed 'provider:<address>' ('google:me@example.com', 'imap:me@gmail.com', 'outlook:me@outlook.com'),
 * or the bare provider when the address is not known.
 */
import { appDb, type AppDb } from './db.js';

export interface SyncStateRow {
  account: string; resource: string; cursor: string | null; window_from: number | null; window_to: number | null;
  last_ok: number | null; last_error: string | null; needs_reconnect: number;
}

export function getSyncState(account: string, resource: string, d: AppDb = appDb()): SyncStateRow | null {
  return (d.prepare('SELECT * FROM sync_state WHERE account = ? AND resource = ?').get(account, resource) as SyncStateRow | undefined) ?? null;
}

/** All rows for a resource (optionally only one provider's accounts). */
export function listSyncStates(resource: string, provider?: string, d: AppDb = appDb()): SyncStateRow[] {
  return (provider
    ? d.prepare('SELECT * FROM sync_state WHERE resource = ? AND (account = ? OR account LIKE ?) ORDER BY account').all(resource, provider, `${provider}:%`)
    : d.prepare('SELECT * FROM sync_state WHERE resource = ? ORDER BY account').all(resource)) as SyncStateRow[];
}

/** All rows for a resource (the calendar sync's name for listSyncStates). */
export function syncStates(resource: string): SyncStateRow[] { return listSyncStates(resource); }

const COLUMNS = new Set(['cursor', 'window_from', 'window_to', 'last_ok', 'last_error', 'needs_reconnect']);
/** Set some columns of a row (creating it if needed). Column names are checked against the table's own. */
export function setSyncState(account: string, resource: string, set: Partial<Omit<SyncStateRow, 'account' | 'resource'>>, d: AppDb = appDb()): void {
  d.prepare(`INSERT INTO sync_state (account, resource) VALUES (?, ?) ON CONFLICT (account, resource) DO NOTHING`).run(account, resource);
  const cols = Object.keys(set).filter((c) => COLUMNS.has(c));
  if (!cols.length) return;
  d.prepare(`UPDATE sync_state SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE account = @account AND resource = @resource`).run({ ...set, account, resource });
}

/** A sync succeeded: store the cursor and window, clear the error and the reconnect flag. */
export function recordSyncOk(account: string, resource: string, s: { cursor: string | null; windowFrom: number | null; windowTo: number | null }, now = Date.now(), d: AppDb = appDb()): void {
  d.prepare(`INSERT INTO sync_state (account, resource, cursor, window_from, window_to, last_ok, last_error, needs_reconnect)
             VALUES (?, ?, ?, ?, ?, ?, NULL, 0)
             ON CONFLICT (account, resource) DO UPDATE SET cursor = excluded.cursor, window_from = excluded.window_from,
               window_to = excluded.window_to, last_ok = excluded.last_ok, last_error = NULL, needs_reconnect = 0`)
    .run(account, resource, s.cursor, s.windowFrom === null ? null : Math.round(s.windowFrom), s.windowTo === null ? null : Math.round(s.windowTo), Math.round(now));
}

/** A sync failed. `reconnect`: the sign-in is no longer valid (invalid_grant, 401) — the person must reconnect. */
export function recordSyncError(account: string, resource: string, message: string, reconnect: boolean, d: AppDb = appDb()): void {
  d.prepare(`INSERT INTO sync_state (account, resource, last_error, needs_reconnect) VALUES (?, ?, ?, ?)
             ON CONFLICT (account, resource) DO UPDATE SET last_error = excluded.last_error, needs_reconnect = excluded.needs_reconnect`)
    .run(account, resource, message.slice(0, 300), reconnect ? 1 : 0);
}

export function deleteSyncState(account: string, resource: string, d: AppDb = appDb()): void {
  d.prepare('DELETE FROM sync_state WHERE account = ? AND resource = ?').run(account, resource);
}
