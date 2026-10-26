/**
 * Who is calling /api/v1 (v2 build, slice A2, 2026-10-26). Three kinds of caller:
 *   - the password session (MWA_ACCESS_PASSWORD's cookie): everything, admin included;
 *   - this machine with no password configured: everything — the one-machine default, unchanged;
 *   - a paired device: its own revocable token, sent as `Authorization: Bearer …` (a phone app) or as the
 *     `mwa_device` cookie (the installed web app — EventSource cannot send headers), with the scopes it was given.
 *
 * Closes the open-tailnet gap for v1: with no password, a request from the network — including one that comes
 * through a local proxy such as `tailscale serve` (it carries X-Forwarded-For / Tailscale-User-* headers) — is not
 * "this machine" and must be a paired device. Pairing: an admin makes a one-time code (QR in Settings), the phone
 * sends it once and gets its token. Tokens and codes are stored as SHA-256 hashes only.
 */
import type { IncomingMessage } from 'node:http';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { appDb, recordEvent, registerMigrations } from '../v2/db.js';
import type { Scope } from './router.js';

export type CallerKind = 'session' | 'local' | 'device';
export interface Caller { kind: CallerKind; id: string; scopes: Set<Scope>; viaCookie: boolean }

export const ALL_SCOPES: Scope[] = ['read', 'act', 'approve', 'admin'];
export const PHONE_SCOPES: Scope[] = ['read', 'act', 'approve'];
const CODE_TTL_MS = 10 * 60_000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
export const DEVICE_COOKIE = 'mwa_device';
const LAST_SEEN_EVERY_MS = 60_000;

registerMigrations([{
  name: '003-devices',
  sql: `
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT, token_hash TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL,
      created_at INTEGER NOT NULL, last_seen INTEGER, revoked_at INTEGER, updated_seq INTEGER);
    CREATE TABLE IF NOT EXISTS pair_codes (
      code_hash TEXT PRIMARY KEY, created_by TEXT NOT NULL, scopes TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, device_id TEXT);`,
}]);

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * True when the request was made on this machine — not relayed — and addressed to it by a local name.
 *
 * Review of A2 (2026-10-26). A loopback socket is not enough: `tailscaled --tun=userspace-networking` (our Docker
 * entrypoint), `tailscale serve --tcp`, ssh/socat/portproxy forwarders and a bare nginx proxy_pass all reach the app
 * from 127.0.0.1, some with no forwarding header at all. What they do not change is the Host the client used — a
 * tailnet peer asks for box.tailnet.ts.net or 100.x, not localhost — so Host must be localhost / 127.0.0.1 / [::1].
 * The same rule stops DNS rebinding (an attacker's page on evil.example resolving to 127.0.0.1 still sends
 * Host: evil.example). Any forwarding-style header, even an empty one, also means relayed.
 */
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;
const RELAY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'forwarded', 'x-real-ip', 'via'];
export function fromThisMachine(req: IncomingMessage): boolean {
  const a = String(req.socket?.remoteAddress ?? '');
  if (!(a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1')) return false;
  const h = req.headers;
  if (RELAY_HEADERS.some((k) => k in h) || Object.keys(h).some((k) => k.startsWith('tailscale-'))) return false;
  return LOCAL_HOST.test(String(h.host ?? ''));
}

function bearer(req: IncomingMessage): string | null {
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/.exec(String(req.headers.authorization ?? ''));
  return m ? m[1] : null;
}
function deviceCookie(req: IncomingMessage): string | null {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === DEVICE_COOKIE) { const t = v.join('='); return /^[A-Za-z0-9_-]{20,200}$/.test(t) ? t : null; }
  }
  return null;
}

/** The device a token belongs to, if it exists and is not revoked. Checked against the database on every request,
 *  so a revocation takes effect at once. */
export function deviceForToken(token: string): { id: string; scopes: Scope[] } | null {
  const d = appDb();
  const row = d.prepare('SELECT id, scopes, last_seen FROM devices WHERE token_hash = ? AND revoked_at IS NULL').get(sha(token)) as { id: string; scopes: string; last_seen: number | null } | undefined;
  if (!row) return null;
  if (!row.last_seen || Date.now() - row.last_seen > LAST_SEEN_EVERY_MS) d.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(Date.now(), row.id);
  return { id: row.id, scopes: row.scopes.split(',').filter(Boolean) as Scope[] };
}

/**
 * Build the caller resolver for the router. `passwordSet`: MWA_ACCESS_PASSWORD is configured; `sessionValid`: the
 * request carries a valid password session cookie.
 *
 * Order (review of A2): an Authorization header that is present must verify — a malformed or revoked one is a 401,
 * never a fall-through to a cookie or to "this machine". Then the password session (it outranks a device cookie, so
 * an owner who once paired this browser keeps admin), then a device cookie, then this machine with no password.
 */
export function makeAuthenticate(o: { passwordSet: boolean; sessionValid: (req: IncomingMessage) => boolean }) {
  return (req: IncomingMessage): Caller | null => {
    if (req.headers.authorization !== undefined) {
      const b = bearer(req); const dv = b ? deviceForToken(b) : null;
      return dv ? { kind: 'device', id: dv.id, scopes: new Set(dv.scopes), viaCookie: false } : null;
    }
    if (o.passwordSet && o.sessionValid(req)) return { kind: 'session', id: 'session', scopes: new Set(ALL_SCOPES), viaCookie: true };
    const c = deviceCookie(req);
    if (c) { const dv = deviceForToken(c); if (dv) return { kind: 'device', id: dv.id, scopes: new Set(dv.scopes), viaCookie: true }; }
    if (o.passwordSet) return null;
    return fromThisMachine(req) ? { kind: 'local', id: 'local', scopes: new Set(ALL_SCOPES), viaCookie: false } : null;
  };
}

// ── pairing ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** A one-time code, shown as "ABCD-EFGH", valid 10 minutes. Returned once; only its hash is kept. */
export function createPairCode(createdBy: string, scopes: Scope[] = PHONE_SCOPES): { code: string; expiresAt: number } {
  const raw = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
  const now = Date.now(), expiresAt = now + CODE_TTL_MS;
  const d = appDb();
  d.prepare('DELETE FROM pair_codes WHERE expires_at < ?').run(now - 24 * 3_600_000);
  d.prepare('INSERT INTO pair_codes (code_hash, created_by, scopes, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(sha(raw), createdBy, scopes.join(','), now, expiresAt);
  return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt };
}

const normCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Spend a code: a new device and its token, or null (unknown, used or expired code — not told apart). */
export function redeemPairCode(code: string, name: string, platform?: string): { deviceId: string; token: string; scopes: Scope[] } | null {
  const c = normCode(code);
  if (c.length !== 8) return null;
  const d = appDb();
  return d.transaction(() => {
    const now = Date.now();
    const row = d.prepare('SELECT scopes FROM pair_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at >= ?').get(sha(c), now) as { scopes: string } | undefined;
    if (!row) return null;
    const deviceId = `dev_${randomBytes(8).toString('hex')}`, token = randomBytes(32).toString('base64url');
    const seq = recordEvent({ entity: 'device', id: deviceId, payload: { name } }, d);
    d.prepare('INSERT INTO devices (id, name, platform, token_hash, scopes, created_at, last_seen, updated_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(deviceId, name.slice(0, 60) || 'Phone', platform?.slice(0, 30) ?? null, sha(token), row.scopes, now, now, seq);
    d.prepare('UPDATE pair_codes SET used_at = ?, device_id = ? WHERE code_hash = ?').run(now, deviceId, sha(c));
    return { deviceId, token, scopes: row.scopes.split(',') as Scope[] };
  }).immediate();
}

export interface DeviceRow { id: string; name: string; platform: string | null; scopes: string[]; createdAt: number; lastSeen: number | null; revokedAt: number | null }
export function listDevices(): DeviceRow[] {
  return (appDb().prepare('SELECT id, name, platform, scopes, created_at, last_seen, revoked_at FROM devices ORDER BY created_at DESC').all() as
    { id: string; name: string; platform: string | null; scopes: string; created_at: number; last_seen: number | null; revoked_at: number | null }[])
    .map((r) => ({ id: r.id, name: r.name, platform: r.platform, scopes: r.scopes.split(','), createdAt: r.created_at, lastSeen: r.last_seen, revokedAt: r.revoked_at }));
}

/** Revoke a device at once (its next request is refused). False when there is no such active device. */
export function revokeDevice(id: string): boolean {
  const d = appDb();
  return d.transaction(() => {
    const r = d.prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(Date.now(), id);
    if (!r.changes) return false;
    const seq = recordEvent({ entity: 'device', id, op: 'delete' }, d);
    d.prepare('UPDATE devices SET updated_seq = ? WHERE id = ?').run(seq, id);
    return true;
  })();
}

// Failed pairing attempts (review of A2): per source — at most 5 per 10 minutes from one address — so nobody can
// lock the owner out by spraying junk codes; plus a generous global ceiling against a distributed flood. A code has
// 32^8 ≈ 1e12 values and lives 10 minutes, so this is about noise more than guessing. In memory; a restart clears it.
const PER_SOURCE = 5, GLOBAL = 200;
const failures = new Map<string, number[]>();
function recent(list: number[], now: number): number[] { while (list.length && list[0] < now - CODE_TTL_MS) list.shift(); return list; }
export function sourceOf(req: IncomingMessage): string {
  const xff = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  return xff || String(req.socket?.remoteAddress ?? 'unknown');
}
export function pairingThrottled(source: string, now = Date.now()): boolean {
  if (recent(failures.get(source) ?? [], now).length >= PER_SOURCE) return true;
  let all = 0; for (const [k, v] of failures) { const r = recent(v, now); if (!r.length) failures.delete(k); all += r.length; }
  return all >= GLOBAL;
}
export function notePairingFailure(source: string, now = Date.now()): void {
  const l = failures.get(source) ?? []; l.push(now); failures.set(source, l);
}
export function resetPairingThrottle(): void { failures.clear(); }
