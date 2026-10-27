/**
 * Web push subscriptions and what was sent (v2 build, slice P3). app.db tables:
 *   push_subs   one row per browser subscription (its endpoint and keys), owned by the caller that made it:
 *               `device:<id>` (a paired phone), `session:<id>` (a password session) or `local` (this machine, no
 *               password). A revoked device or session loses its subscriptions at once (auth.ts, sessions.ts call
 *               removeSubscriptionsOf), and a send checks the owner is still live as well.
 *   push_sent   one row per thing that was (or deliberately was not) notified: at most one notification per item.
 *   push_log    one row per notification sent, for the hourly limit.
 *   push_prefs  which kinds notify, and the morning time.
 *
 * Only imports the database, so auth.ts and sessions.ts can call it without a cycle.
 */
import { randomBytes } from 'node:crypto';
import { appDb, registerMigrations } from './db.js';

registerMigrations([{
  name: '014-push',
  sql: `
    CREATE TABLE IF NOT EXISTS push_subs (
      id TEXT PRIMARY KEY, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
      owner TEXT NOT NULL, platform TEXT, vendor TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER,
      last_ok INTEGER, last_status INTEGER, last_error TEXT, fails INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS push_subs_owner ON push_subs(owner);
    -- key: 'approval:<id>', 'waiting:<job>:<try>', 'result:<job>:<try>', 'morning:<day>'.
    -- state: sent (notified) · baseline (already there when notifications were turned on) · held (quiet hours or the
    -- hourly limit; looked at again) · skipped (nothing to say, or a kind turned off at the time)
    CREATE TABLE IF NOT EXISTS push_sent (key TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS push_sent_at ON push_sent(at);
    CREATE TABLE IF NOT EXISTS push_log (id TEXT PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, test INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS push_log_at ON push_log(at);
    CREATE TABLE IF NOT EXISTS push_prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
}]);

export type PushKind = 'approval' | 'waiting' | 'result' | 'morning';
export const PUSH_KINDS: readonly PushKind[] = ['approval', 'waiting', 'result', 'morning'];
/** At most this many subscriptions per owner (the oldest goes) and in all. */
export const MAX_SUBS_PER_OWNER = 10, MAX_SUBS = 50;

export interface SubRow {
  id: string; endpoint: string; p256dh: string; auth: string; owner: string; platform: string | null; vendor: string;
  created_at: number; expires_at: number | null; last_ok: number | null; last_status: number | null; last_error: string | null; fails: number;
}

/** Add a subscription, or move an existing endpoint to this owner (the browser that holds it is the one asking). */
export function saveSubscription(s: { endpoint: string; p256dh: string; auth: string; owner: string; platform?: string | null; vendor: string; expiresAt?: number | null }, now = Date.now()): SubRow {
  const d = appDb();
  return d.transaction((): SubRow => {
    const old = d.prepare('SELECT id FROM push_subs WHERE endpoint = ?').get(s.endpoint) as { id: string } | undefined;
    const id = old?.id ?? `ps_${randomBytes(9).toString('base64url')}`;
    if (old) {
      d.prepare('UPDATE push_subs SET p256dh = ?, auth = ?, owner = ?, platform = ?, vendor = ?, expires_at = ?, fails = 0, last_error = NULL WHERE id = ?')
        .run(s.p256dh, s.auth, s.owner, s.platform ?? null, s.vendor, s.expiresAt ?? null, id);
    } else {
      d.prepare('INSERT INTO push_subs (id, endpoint, p256dh, auth, owner, platform, vendor, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, s.endpoint, s.p256dh, s.auth, s.owner, s.platform ?? null, s.vendor, now, s.expiresAt ?? null);
    }
    // bounded: the oldest of this owner, then the oldest of all
    const mine = d.prepare('SELECT id FROM push_subs WHERE owner = ? ORDER BY created_at DESC, id').all(s.owner) as { id: string }[];
    for (const x of mine.slice(MAX_SUBS_PER_OWNER)) d.prepare('DELETE FROM push_subs WHERE id = ?').run(x.id);
    const all = d.prepare('SELECT id FROM push_subs ORDER BY created_at DESC, id').all() as { id: string }[];
    for (const x of all.slice(MAX_SUBS)) d.prepare('DELETE FROM push_subs WHERE id = ?').run(x.id);
    return d.prepare('SELECT * FROM push_subs WHERE id = ?').get(id) as SubRow;
  }).immediate();
}

export function getSubscription(id: string): SubRow | null {
  return (appDb().prepare('SELECT * FROM push_subs WHERE id = ?').get(id) as SubRow | undefined) ?? null;
}
export function subscriptionByEndpoint(endpoint: string): SubRow | null {
  return (appDb().prepare('SELECT * FROM push_subs WHERE endpoint = ?').get(endpoint) as SubRow | undefined) ?? null;
}
export function listSubscriptions(owner?: string): SubRow[] {
  return (owner === undefined
    ? appDb().prepare('SELECT * FROM push_subs ORDER BY created_at DESC, id').all()
    : appDb().prepare('SELECT * FROM push_subs WHERE owner = ? ORDER BY created_at DESC, id').all(owner)) as SubRow[];
}
export function deleteSubscription(id: string): boolean {
  return appDb().prepare('DELETE FROM push_subs WHERE id = ?').run(id).changes > 0;
}
/** A device or session was revoked: its subscriptions go with it. `prefix` removes every owner starting with it
 *  ('session:' after "sign out everywhere"). Never throws (a revoke must not fail over push). */
export function removeSubscriptionsOf(owner: string, o: { prefix?: boolean } = {}): number {
  try {
    return o.prefix
      ? appDb().prepare(`DELETE FROM push_subs WHERE substr(owner, 1, ?) = ?`).run(owner.length, owner).changes
      : appDb().prepare('DELETE FROM push_subs WHERE owner = ?').run(owner).changes;
  } catch { return 0; }
}
export function noteSendResult(id: string, r: { ok: boolean; status: number; error?: string }, now = Date.now()): void {
  if (r.ok) appDb().prepare('UPDATE push_subs SET last_ok = ?, last_status = ?, last_error = NULL, fails = 0 WHERE id = ?').run(now, r.status, id);
  else appDb().prepare('UPDATE push_subs SET last_status = ?, last_error = ?, fails = fails + 1 WHERE id = ?').run(r.status, (r.error ?? '').slice(0, 200) || null, id);
}

/**
 * Is the owner of a subscription still allowed to receive? A device not revoked; a password session not revoked and
 * not past its 30 days; this machine always. Anything else (an unknown kind of owner) is not.
 */
export function ownerLive(owner: string, now = Date.now()): boolean {
  const d = appDb();
  try {
    if (owner === 'local') return true;
    if (owner.startsWith('device:')) {
      const r = d.prepare('SELECT revoked_at FROM devices WHERE id = ?').get(owner.slice(7)) as { revoked_at: number | null } | undefined;
      return !!r && r.revoked_at == null;
    }
    if (owner.startsWith('session:')) {
      const r = d.prepare('SELECT revoked_at, created_at FROM sessions WHERE id = ?').get(owner.slice(8)) as { revoked_at: number | null; created_at: number } | undefined;
      return !!r && r.revoked_at == null && r.created_at + 30 * 86_400_000 > now;
    }
  } catch { return false; }
  return false;
}

// ── what was sent ───────────────────────────────────────────────────────────────────────────────────────────────

export type SentState = 'sent' | 'baseline' | 'held' | 'skipped';
export function sentState(key: string): SentState | null {
  return ((appDb().prepare('SELECT state FROM push_sent WHERE key = ?').get(key) as { state: SentState } | undefined)?.state) ?? null;
}
export function markSent(key: string, kind: string, state: SentState, now = Date.now()): void {
  appDb().prepare('INSERT INTO push_sent (key, kind, state, at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET state = excluded.state, at = excluded.at').run(key, kind, state, now);
}
/** Forget records older than 30 days (an approval or a job result is long settled by then). */
export function prunePushRecords(now = Date.now()): void {
  appDb().prepare('DELETE FROM push_sent WHERE at < ?').run(now - 30 * 86_400_000);
  appDb().prepare('DELETE FROM push_log WHERE at < ?').run(now - 2 * 86_400_000);
}
export function logPush(kind: string, test: boolean, now = Date.now()): void {
  appDb().prepare('INSERT INTO push_log (id, at, kind, test) VALUES (?, ?, ?, ?)').run(randomBytes(8).toString('hex'), now, kind, test ? 1 : 0);
}
/** Notifications (not tests) sent in the hour before `now`. */
export function sentLastHour(now = Date.now()): number {
  return (appDb().prepare('SELECT COUNT(*) n FROM push_log WHERE test = 0 AND at > ?').get(now - 3_600_000) as { n: number }).n;
}

// ── preferences ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface PushPrefs { kinds: Record<PushKind, boolean>; morning: string }
export const DEFAULT_PREFS: PushPrefs = { kinds: { approval: true, waiting: true, result: true, morning: true }, morning: '07:30' };
/** The morning time: HH:MM between 05:00 and 11:30 (the check-in shows 05:00–12:00). */
export function validMorning(s: unknown): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  const t = h * 60 + mi;
  if (t < 5 * 60 || t > 11 * 60 + 30) return null;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}
export function readPrefs(): PushPrefs {
  const rows = appDb().prepare('SELECT key, value FROM push_prefs').all() as { key: string; value: string }[];
  const p: PushPrefs = { kinds: { ...DEFAULT_PREFS.kinds }, morning: DEFAULT_PREFS.morning };
  for (const r of rows) {
    if (r.key === 'morning') p.morning = validMorning(r.value) ?? p.morning;
    else if (r.key.startsWith('kind:')) { const k = r.key.slice(5) as PushKind; if (PUSH_KINDS.includes(k)) p.kinds[k] = r.value === '1'; }
  }
  return p;
}
export function writePrefs(p: { kinds?: Partial<Record<PushKind, boolean>>; morning?: string }): PushPrefs {
  const d = appDb();
  d.transaction(() => {
    const put = d.prepare('INSERT INTO push_prefs (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [k, v] of Object.entries(p.kinds ?? {})) if (PUSH_KINDS.includes(k as PushKind)) put.run(`kind:${k}`, v ? '1' : '0');
    if (p.morning !== undefined) put.run('morning', p.morning);
  })();
  return readPrefs();
}
