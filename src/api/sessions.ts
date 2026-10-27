/**
 * Password sessions with a server-side record (W5 security review, 2026-10-26).
 *
 * BL-71 made a session `<expiry>.<id>.<mac>`, signed with a key from the access password and a salt beside the data,
 * so a session survived a restart — but nothing was kept per session, so "sign out" only cleared the browser's
 * cookie: a copied cookie stayed good for 30 days. Now each session has a row in app.db `sessions` (keyed by the id
 * in its token: created, last seen, revoked). Signing out revokes that row; "sign out everywhere" revokes every row
 * and sets a cut-off, so anything issued before it is refused.
 *
 * Upgrade: a session issued before this table existed has no row. It is adopted (a row is made) on first use if it
 * was issued before the table was created and after the last "sign out everywhere"; anything newer without a row is
 * refused. Changing the password still invalidates every session (the key changes).
 */
import type { IncomingMessage } from 'node:http';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appDb, registerMigrations } from '../v2/db.js';
import { dbFile } from '../paths.js';
import { removeSubscriptionsOf } from '../v2/push-store.js';

export const SESSION_MS = 30 * 24 * 3_600_000;
export const SESSION_COOKIE = 'mwa_session';
const SEEN_EVERY_MS = 60_000;

registerMigrations([{
  name: '013-sessions',
  sql: `
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_seen INTEGER, revoked_at INTEGER, via TEXT);
    CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);`,
}]);

/** A small key/value store in app.db for settings that must not depend on mwa.config.json being valid. */
export function getAppSetting(key: string): string | null {
  const r = appDb().prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return r?.value ?? null;
}
export function setAppSetting(key: string, value: string | null): void {
  if (value === null) appDb().prepare('DELETE FROM app_settings WHERE key = ?').run(key);
  else appDb().prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(key, value, Date.now());
}

/** Compare two secrets in constant time without leaking their lengths: both sides are hashed first. */
export function secretEquals(a: string, b: string): boolean {
  const ha = createHash('sha256').update(String(a)).digest(), hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

let password = '';
let keyCache: { pw: string; dir: string; key: Buffer } | null = null;
/** Set the access password (serve.ts at start; tests). An empty password means sessions are off. */
export function configureSessions(o: { password: string }): void { password = o.password; keyCache = null; }
export const sessionsOn = () => !!password;

function macKey(): Buffer {
  const dir = dirname(dbFile());
  if (keyCache && keyCache.pw === password && keyCache.dir === dir) return keyCache.key;
  const p = join(dir, '.session-salt');
  let salt = '';
  try { salt = readFileSync(p, 'utf8').trim(); } catch { /* first start */ }
  if (salt.length < 32) {
    salt = randomBytes(32).toString('hex');
    try { mkdirSync(dir, { recursive: true }); if (!existsSync(p) || readFileSync(p, 'utf8').trim().length < 32) writeFileSync(p, salt, { mode: 0o600 }); } catch { /* sessions then last until a restart */ }
  }
  const key = createHmac('sha256', password).update(`mwa-session-v1:${salt}`).digest();
  keyCache = { pw: password, dir, key };
  return key;
}
const mac = (body: string) => createHmac('sha256', macKey()).update(body).digest('base64url');

/** A new session: its token (the cookie's value) and its id. */
export function issueSession(via = 'password'): { token: string; id: string } {
  const d = appDb(); // opened (and migrated) before the token's time is taken
  const id = randomBytes(18).toString('base64url');
  const body = `${Date.now() + SESSION_MS}.${id}`;
  d.prepare('INSERT INTO sessions (id, created_at, last_seen, via) VALUES (?, ?, ?, ?)').run(id, Date.now(), Date.now(), via);
  return { token: `${body}.${mac(body)}`, id };
}

function parse(token: string): { exp: number; id: string } | null {
  const m = /^(\d{10,16})\.([A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{20,})$/.exec(token);
  if (!m || !password) return null;
  if (!secretEquals(m[3], mac(`${m[1]}.${m[2]}`))) return null;
  return { exp: Number(m[1]), id: m[2] };
}
const migratedAt = (): number => (appDb().prepare(`SELECT at FROM migrations WHERE name = '013-sessions'`).get() as { at: number } | undefined)?.at ?? 0;
const cutoff = (): number => Number(getAppSetting('sessions_cutoff') ?? 0) || 0;

/** The session id when the token is a live session, else null. */
export function sessionIdOf(token: string | null): string | null {
  if (!token) return null;
  const t = parse(token);
  if (!t || t.exp < Date.now()) return null;
  const issued = t.exp - SESSION_MS;
  if (issued < cutoff()) return null;
  const d = appDb();
  const row = d.prepare('SELECT revoked_at, last_seen FROM sessions WHERE id = ?').get(t.id) as { revoked_at: number | null; last_seen: number | null } | undefined;
  if (!row) {
    if (issued >= migratedAt() - 1000) return null; // issued since the table exists (or within a second of it), yet unknown: refuse
    d.prepare('INSERT OR IGNORE INTO sessions (id, created_at, last_seen, via) VALUES (?, ?, ?, ?)').run(t.id, issued, Date.now(), 'adopted');
    return t.id;
  }
  if (row.revoked_at) return null;
  if (!row.last_seen || Date.now() - row.last_seen > SEEN_EVERY_MS) d.prepare('UPDATE sessions SET last_seen = ? WHERE id = ?').run(Date.now(), t.id);
  return t.id;
}

export function cookieToken(req: IncomingMessage): string | null {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === SESSION_COOKIE) return v.join('=');
  }
  return null;
}
/** The request carries a live password session. */
export function sessionValid(req: IncomingMessage): boolean { return !!sessionIdOf(cookieToken(req)); }

/** Sign this session out. False when it was not a live session. */
export function revokeSessionOf(req: IncomingMessage): boolean {
  const id = sessionIdOf(cookieToken(req));
  if (!id) return false;
  appDb().prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(Date.now(), id);
  removeSubscriptionsOf(`session:${id}`); // P3: no more notifications to this browser
  return true;
}
/** Sign every password session out (devices are removed one by one in Settings). Returns how many were live. */
export function revokeAllSessions(): number {
  const now = Date.now();
  setAppSetting('sessions_cutoff', String(now));
  const n = appDb().prepare('UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL').run(now).changes;
  removeSubscriptionsOf('session:', { prefix: true }); // P3: every password browser stops getting notifications
  return n;
}
/**
 * Forget sessions that can't come back (W5 re-review): ones older than a session can live, and revoked ones issued
 * since the table existed. Called at server start and daily. Returns how many rows went. A revoked session's token
 * stays refused without its row (an unknown session issued after the table existed is refused); a revoked session
 * from before the table keeps its row until it would have expired, or its token would be adopted again.
 */
export function pruneSessions(now = Date.now()): number {
  return appDb().prepare('DELETE FROM sessions WHERE created_at < ? OR (revoked_at IS NOT NULL AND created_at >= ?)').run(now - SESSION_MS, migratedAt()).changes;
}
/** Tests. */
export function sessionCount(): number { return (appDb().prepare('SELECT COUNT(*) n FROM sessions WHERE revoked_at IS NULL').get() as { n: number }).n; }
