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
import { relayedMode, sourceOf as trustedSourceOf } from './trust.js';

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
 * True when the request was made on this machine by someone sitting at it.
 *
 * Review of A2, corrected by the W5 security review (2026-10-26). A loopback socket is not enough: `tailscaled
 * --tun=userspace-networking` (our Docker entrypoint), `tailscale serve --tcp`, ssh/socat/portproxy forwarders and a
 * bare nginx proxy_pass all reach the app from 127.0.0.1, some with no forwarding header at all — and A2's idea that
 * such a relay would never carry `Host: localhost` was wrong: the client chooses the Host, so anyone on the far side
 * of a raw TCP relay can send `Host: localhost`. So "this machine" now also needs the server NOT to be reachable
 * through a relay at all (trust.ts relayedMode: bound beyond 127.0.0.1, MWA_RELAYED=1, the Docker image's Tailscale, a
 * hosted deploy, or a non-local allowed host / public URL). In those setups the owner signs in with the password or
 * uses a paired device. The local Host and the absence of forwarding headers are still required (they stop DNS
 * rebinding and a proxy that does add headers), and every request's Host is also checked against the allowed hosts
 * before anything else (serve.ts, trust.ts hostAllowed).
 */
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;
const RELAY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'forwarded', 'x-real-ip', 'via'];
export function fromThisMachine(req: IncomingMessage, env: Record<string, string | undefined> = process.env): boolean {
  if (relayedMode(env)) return false;
  const a = String(req.socket?.remoteAddress ?? '');
  if (!(a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1')) return false;
  const h = req.headers;
  if (RELAY_HEADERS.some((k) => k in h) || Object.keys(h).some((k) => k.startsWith('tailscale-'))) return false;
  return LOCAL_HOST.test(String(h.host ?? ''));
}

/** Strip what a name must not carry: control characters and bidirectional overrides (a name that renders backwards
 *  or hides part of itself), then trim and cap. */
export function cleanDeviceName(name: string, max = 60): string {
  return name.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
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
      .run(deviceId, cleanDeviceName(name) || 'Phone', platform ? cleanDeviceName(platform, 30) || null : null, sha(token), row.scopes, now, now, seq);
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

/** The address a throttle counts against (trust.ts: the socket peer; X-Forwarded-For only behind MWA_TRUSTED_PROXY). */
export const sourceOf = (req: IncomingMessage): string => trustedSourceOf(req);

/** W5: rename a device (Settings › Devices). False when there is no such active device. */
export function renameDevice(id: string, name: string): DeviceRow | null {
  const clean = cleanDeviceName(name);
  if (!clean) return null;
  const d = appDb();
  const ok = d.transaction(() => {
    const r = d.prepare('UPDATE devices SET name = ? WHERE id = ? AND revoked_at IS NULL').run(clean, id);
    if (!r.changes) return false;
    const seq = recordEvent({ entity: 'device', id, payload: { name: clean } }, d);
    d.prepare('UPDATE devices SET updated_seq = ? WHERE id = ?').run(seq, id);
    return true;
  })();
  return ok ? listDevices().find((x) => x.id === id) ?? null : null;
}

/** W5: one active device's name (GET /me tells a paired phone what it is called). */
export function deviceName(id: string): string | null {
  const r = appDb().prepare('SELECT name FROM devices WHERE id = ? AND revoked_at IS NULL').get(id) as { name: string } | undefined;
  return r?.name ?? null;
}

/** W5: the request carries a paired device's cookie that is still valid (the legacy page gate lets the app load). */
export function hasValidDeviceCookie(req: IncomingMessage): boolean {
  const c = deviceCookie(req);
  if (!c) return false;
  try { return !!deviceForToken(c); } catch { return false; }
}
