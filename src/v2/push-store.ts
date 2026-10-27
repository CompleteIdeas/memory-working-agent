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

// P3 review: the VAPID key a subscription was made with (only those with the current key are sent to); when a
// subscription started failing to reach its push service (removed after a few days of nothing but failures); and
// the per-device retry queue (a device that got "try later" receives the item later instead of losing it).
registerMigrations([{
  name: '015-push-review',
  sql: `
    ALTER TABLE push_subs ADD COLUMN vapid TEXT;
    ALTER TABLE push_subs ADD COLUMN failing_since INTEGER;
    CREATE TABLE IF NOT EXISTS push_retry (
      sub_id TEXT NOT NULL REFERENCES push_subs(id) ON DELETE CASCADE, key TEXT NOT NULL, kind TEXT NOT NULL, item_id TEXT,
      receipt_job TEXT, receipt_fire TEXT, tries INTEGER NOT NULL DEFAULT 1, first_at INTEGER NOT NULL, next_at INTEGER NOT NULL,
      PRIMARY KEY (sub_id, key));
    CREATE INDEX IF NOT EXISTS push_retry_next ON push_retry(next_at);`,
}]);

export interface SubRow {
  id: string; endpoint: string; p256dh: string; auth: string; owner: string; platform: string | null; vendor: string;
  created_at: number; expires_at: number | null; last_ok: number | null; last_status: number | null; last_error: string | null; fails: number;
  vapid: string | null; failing_since: number | null;
}

/** A refusal the route turns into plain words. */
export class PushStoreError extends Error { constructor(public code: 'endpoint_taken' | 'too_many', message: string) { super(message); } }

/**
 * Add a subscription. The same endpoint again from the same owner refreshes it (its keys, its VAPID key). An endpoint
 * another LIVE owner holds is never moved (P3 review: knowing an endpoint URL proves nothing; a phone that saw
 * another's endpoint could otherwise take its notifications): refused with `endpoint_taken`. One whose owner is gone
 * (revoked, signed out) is replaced.
 *
 * Bounded (P3 review): at most MAX_SUBS_PER_OWNER per owner (its oldest goes). Past MAX_SUBS in all, what goes first is
 * a subscription of an owner that is gone, then this owner's own older ones, then the oldest that is NOT some live
 * owner's newest; if nothing can go, the new one is refused (`too_many`) rather than cutting off another device.
 */
export function saveSubscription(s: { endpoint: string; p256dh: string; auth: string; owner: string; platform?: string | null; vendor: string; expiresAt?: number | null; vapid?: string | null }, now = Date.now()): SubRow {
  const d = appDb();
  return d.transaction((): SubRow => {
    const old = d.prepare('SELECT id, owner FROM push_subs WHERE endpoint = ?').get(s.endpoint) as { id: string; owner: string } | undefined;
    if (old && old.owner !== s.owner) {
      if (ownerLive(old.owner, now)) throw new PushStoreError('endpoint_taken', 'That notification address belongs to another device. Turn notifications off and on again on this device.');
      d.prepare('DELETE FROM push_subs WHERE id = ?').run(old.id);
    }
    const mineOld = old && old.owner === s.owner ? old : undefined;
    const id = mineOld?.id ?? `ps_${randomBytes(9).toString('base64url')}`;
    if (mineOld) {
      d.prepare('UPDATE push_subs SET p256dh = ?, auth = ?, platform = ?, vendor = ?, expires_at = ?, vapid = ?, fails = 0, last_error = NULL, failing_since = NULL WHERE id = ?')
        .run(s.p256dh, s.auth, s.platform ?? null, s.vendor, s.expiresAt ?? null, s.vapid ?? null, id);
    } else {
      d.prepare('INSERT INTO push_subs (id, endpoint, p256dh, auth, owner, platform, vendor, created_at, expires_at, vapid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, s.endpoint, s.p256dh, s.auth, s.owner, s.platform ?? null, s.vendor, now, s.expiresAt ?? null, s.vapid ?? null);
    }
    const del = d.prepare('DELETE FROM push_subs WHERE id = ?');
    const mine = d.prepare('SELECT id FROM push_subs WHERE owner = ? ORDER BY created_at DESC, id DESC').all(s.owner) as { id: string }[];
    for (const x of mine.slice(MAX_SUBS_PER_OWNER)) if (x.id !== id) del.run(x.id);
    const all = d.prepare('SELECT id, owner FROM push_subs ORDER BY created_at ASC, id ASC').all() as { id: string; owner: string }[];
    let over = all.length - MAX_SUBS;
    if (over > 0) {
      const live = new Map<string, boolean>();
      const isLive = (o: string) => { if (!live.has(o)) live.set(o, ownerLive(o, now)); return live.get(o)!; };
      const newest = new Map<string, string>();
      for (const x of all) newest.set(x.owner, x.id); // ascending: the last one seen is each owner's newest
      const order = [
        ...all.filter((x) => !isLive(x.owner)),
        ...all.filter((x) => isLive(x.owner) && x.owner === s.owner && x.id !== id),
        ...all.filter((x) => isLive(x.owner) && x.owner !== s.owner && newest.get(x.owner) !== x.id),
      ];
      const gone = new Set<string>();
      for (const x of order) { if (over <= 0) break; if (gone.has(x.id)) continue; del.run(x.id); gone.add(x.id); over--; }
      if (over > 0) throw new PushStoreError('too_many', 'There are too many devices with notifications on. Turn them off on one you no longer use.');
    }
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
/** What the push service said. A success clears the failure clock; a failure starts it (once). */
export function noteSendResult(id: string, r: { ok: boolean; status: number; error?: string }, now = Date.now()): void {
  if (r.ok) appDb().prepare('UPDATE push_subs SET last_ok = ?, last_status = ?, last_error = NULL, fails = 0, failing_since = NULL WHERE id = ?').run(now, r.status, id);
  else appDb().prepare('UPDATE push_subs SET last_status = ?, last_error = ?, fails = fails + 1, failing_since = COALESCE(failing_since, ?) WHERE id = ?').run(r.status, (r.error ?? '').slice(0, 200) || null, now, id);
}

/** P3 review: "this machine" (no password, nothing relaying) owns `local` subscriptions only while that trust holds.
 *  serve sets it at start: once a password is set (or the server is reachable through a relay), `local` subscriptions
 *  are removed and never sent to. */
let localOwnerValid = true;
export function setLocalOwnerValid(v: boolean): void {
  localOwnerValid = v;
  if (!v) removeSubscriptionsOf('local');
}

/**
 * Is the owner of a subscription still allowed to receive? A device not revoked; a password session not revoked and
 * not past its 30 days; this machine while it is trusted as such. Anything else (an unknown kind of owner) is not.
 */
export function ownerLive(owner: string, now = Date.now()): boolean {
  const d = appDb();
  try {
    if (owner === 'local') return localOwnerValid;
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
/**
 * Forget what can no longer come back (P3 review: a blanket 30-day prune re-notified an item still unresolved after a
 * month). `live` holds every key that still stands (an approval still pending, a result still unopened…): those
 * records are kept however old, so an item is notified once for as long as it is unresolved. A record whose item is
 * resolved or gone goes after a week; anything goes after a year. Without `live` (the sources could not be read),
 * only the year-old ones go.
 */
export function prunePushRecords(now = Date.now(), live?: ReadonlySet<string>): number {
  const d = appDb();
  let n = d.prepare('DELETE FROM push_sent WHERE at < ?').run(now - 365 * 86_400_000).changes;
  if (live) {
    const old = d.prepare('SELECT key FROM push_sent WHERE at < ?').all(now - 7 * 86_400_000) as { key: string }[];
    const del = d.prepare('DELETE FROM push_sent WHERE key = ?');
    for (const r of old) if (!live.has(r.key)) n += del.run(r.key).changes;
  }
  d.prepare('DELETE FROM push_log WHERE at < ?').run(now - 2 * 86_400_000);
  return n;
}

// ── retries, per device (P3 review) ─────────────────────────────────────────────────────────────────────────────

export interface RetryRow { sub_id: string; key: string; kind: string; item_id: string | null; receipt_job: string | null; receipt_fire: string | null; tries: number; first_at: number; next_at: number }
/** 30 s, then 1, 2, 4 … minutes, at most an hour between tries. */
export const retryDelay = (tries: number): number => Math.min(3_600_000, 30_000 * 2 ** Math.max(0, tries - 1));
export function queueRetry(r: { subId: string; key: string; kind: string; itemId: string | null; receiptJob?: string; receiptFire?: string }, now = Date.now()): void {
  const d = appDb();
  const old = d.prepare('SELECT tries, first_at FROM push_retry WHERE sub_id = ? AND key = ?').get(r.subId, r.key) as { tries: number; first_at: number } | undefined;
  const tries = (old?.tries ?? 0) + 1;
  d.prepare(`INSERT INTO push_retry (sub_id, key, kind, item_id, receipt_job, receipt_fire, tries, first_at, next_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sub_id, key) DO UPDATE SET tries = excluded.tries, next_at = excluded.next_at`)
    .run(r.subId, r.key, r.kind, r.itemId, r.receiptJob ?? null, r.receiptFire ?? null, tries, old?.first_at ?? now, now + retryDelay(tries));
}
export function dueRetries(now = Date.now()): RetryRow[] {
  return appDb().prepare('SELECT * FROM push_retry WHERE next_at <= ? ORDER BY next_at').all(now) as RetryRow[];
}
export function dropRetry(subId: string, key: string): void {
  appDb().prepare('DELETE FROM push_retry WHERE sub_id = ? AND key = ?').run(subId, key);
}
export function retryRows(): RetryRow[] { return appDb().prepare('SELECT * FROM push_retry ORDER BY next_at').all() as RetryRow[]; }
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
