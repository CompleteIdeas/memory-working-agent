/**
 * Web push, the wire (v2 build, slice P3, 2026-10-27): VAPID keys (RFC 8292), payload encryption (RFC 8291,
 * aes128gcm) and the one request to the browser vendor's push service. Implemented with node:crypto (about 150 lines)
 * rather than the `web-push` package: nothing new in node_modules, and the two RFCs are small. The RFC 8291 example
 * (its Appendix A) is a unit test (tests/push-server.test.ts), so the encryption is checked against the standard, not
 * only against itself.
 *
 * Why it matters what goes in: MWA runs inside a Tailscale box, but a push goes OUT through Google's (FCM), Apple's,
 * Mozilla's or Microsoft's push service. The payload is encrypted end to end, but it still leaves the box, so the
 * caller (push.ts) sends only a kind, an id and a tag — never a title, a sender or a word of mail. The app fetches
 * the details itself after it opens.
 *
 * SSRF: the server POSTs to whatever endpoint a browser handed it. Only https endpoints on the known push services
 * are accepted (checkEndpoint), redirects are not followed, and every send re-checks the endpoint. A local mock push
 * service is allowed only in a test run (VITEST or NODE_ENV=test) AND only at the loopback origin named in
 * MWA_PUSH_TEST_ORIGIN.
 *
 * The VAPID private key lives in `push-vapid.json` beside agent.db (MWA_PUSH_VAPID to put it elsewhere), created on
 * first use with mode 0600 where the file system honours it. It is never logged and never leaves the server; only the
 * public key is handed to browsers (the `applicationServerKey`).
 */
import { createECDH, createPrivateKey, createPublicKey, hkdfSync, createCipheriv, createDecipheriv, randomBytes, sign, verify, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dbFile } from '../paths.js';

export const b64u = (b: Buffer | Uint8Array): string => Buffer.from(b).toString('base64url');
export const unb64u = (s: string): Buffer => Buffer.from(s, 'base64url');

// ── endpoints ───────────────────────────────────────────────────────────────────────────────────────────────────

/** The push services a browser can hand us. Exact hosts, or a suffix (a leading dot). */
export const PUSH_HOSTS = ['fcm.googleapis.com', '.push.apple.com', 'updates.push.services.mozilla.com', '.notify.windows.com'] as const;

export type Vendor = 'google' | 'apple' | 'mozilla' | 'microsoft' | 'test';
const VENDOR_WORDS: Record<Vendor, string> = {
  google: 'Google’s push service', apple: 'Apple’s push service', mozilla: 'Mozilla’s push service', microsoft: 'Microsoft’s push service', test: 'the test push service',
};
export const vendorWords = (v: Vendor): string => VENDOR_WORDS[v];

const testRun = (env: NodeJS.ProcessEnv) => !!env.VITEST || env.NODE_ENV === 'test';
/** The loopback origin a test may point subscriptions at (http://127.0.0.1:<port> or http://localhost:<port>). */
function testOrigin(env: NodeJS.ProcessEnv): string | null {
  if (!testRun(env)) return null;
  const v = String(env.MWA_PUSH_TEST_ORIGIN ?? '').trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    if (!/^(127\.0\.0\.1|localhost|\[::1\])$/i.test(u.hostname)) return null;
    return u.origin;
  } catch { return null; }
}

/**
 * Is this an endpoint we may POST to? https, no credentials, the default port, on a known push service — or, in a
 * test run only, the named loopback test origin.
 */
export function checkEndpoint(raw: unknown, env: NodeJS.ProcessEnv = process.env): { ok: true; url: URL; vendor: Vendor } | { ok: false; why: string } {
  if (typeof raw !== 'string' || !raw || raw.length > 2048) return { ok: false, why: 'The subscription has no usable address.' };
  let u: URL;
  try { u = new URL(raw); } catch { return { ok: false, why: 'The subscription has no usable address.' }; }
  const t = testOrigin(env);
  if (t && u.origin === t) return { ok: true, url: u, vendor: 'test' };
  if (u.protocol !== 'https:') return { ok: false, why: 'Only a secure (https) push address is accepted.' };
  if (u.username || u.password || (u.port && u.port !== '443')) return { ok: false, why: 'That push address is not one I can use.' };
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  const known = PUSH_HOSTS.some((h) => (h.startsWith('.') ? host.endsWith(h) && host.length > h.length : host === h));
  if (!known) return { ok: false, why: 'That push address is not a browser push service I know (Google, Apple, Mozilla or Microsoft).' };
  const vendor: Vendor = host === 'fcm.googleapis.com' ? 'google' : host.endsWith('.push.apple.com') ? 'apple' : host.endsWith('.notify.windows.com') ? 'microsoft' : 'mozilla';
  return { ok: true, url: u, vendor };
}

/** The browser's keys: p256dh is an uncompressed P-256 point (65 bytes), auth a 16-byte secret. Null when malformed. */
export function checkKeys(p256dh: unknown, auth: unknown): { p256dh: Buffer; auth: Buffer } | null {
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(p256dh) || !/^[A-Za-z0-9_-]+={0,2}$/.test(auth)) return null;
  const p = unb64u(p256dh.replace(/=+$/, '')), a = unb64u(auth.replace(/=+$/, ''));
  if (p.length !== 65 || p[0] !== 4 || a.length !== 16) return null;
  // a point that is not on the curve is refused here, not at send time
  try { const e = createECDH('prime256v1'); e.generateKeys(); e.computeSecret(p); } catch { return null; }
  return { p256dh: p, auth: a };
}

// ── VAPID ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface VapidKeys { publicKey: string; privateKey: string }
let memo: { path: string; keys: VapidKeys } | null = null;

export function vapidPath(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.MWA_PUSH_VAPID) return env.MWA_PUSH_VAPID;
  if (env.VITEST) return null; // tests: in memory unless a test names a file
  return join(dirname(dbFile(env)), 'push-vapid.json');
}

function newKeys(): VapidKeys {
  const e = createECDH('prime256v1'); e.generateKeys();
  return { publicKey: b64u(e.getPublicKey()), privateKey: b64u(e.getPrivateKey()) };
}
function validKeys(k: unknown): k is VapidKeys {
  const o = k as VapidKeys;
  return !!o && typeof o.publicKey === 'string' && typeof o.privateKey === 'string' && unb64u(o.publicKey).length === 65 && unb64u(o.privateKey).length === 32;
}

/** This server's VAPID keys: read, or made once and saved (0600). Two processes starting together agree on one file
 *  (an exclusive create; the loser reads the winner's). */
export function vapidKeys(env: NodeJS.ProcessEnv = process.env): VapidKeys {
  const p = vapidPath(env) ?? ':memory:';
  if (memo && memo.path === p) return memo.keys;
  let keys: VapidKeys | null = null;
  if (p !== ':memory:' && existsSync(p)) {
    try { const k = JSON.parse(readFileSync(p, 'utf8')); if (validKeys(k)) keys = { publicKey: k.publicKey, privateKey: k.privateKey }; } catch { /* unreadable: made again below */ }
  }
  if (!keys) {
    keys = newKeys();
    if (p !== ':memory:') {
      mkdirSync(dirname(p), { recursive: true });
      const text = JSON.stringify({ ...keys, createdAt: new Date().toISOString(), note: 'MWA web push (VAPID) keys. Keep private. Deleting this file turns every phone\'s notifications off until each turns them on again.' }, null, 2);
      try { writeFileSync(p, text, { mode: 0o600, flag: existsSync(p) ? 'w' : 'wx' }); }
      catch {
        // another process made it first: use theirs
        const k = JSON.parse(readFileSync(p, 'utf8'));
        if (!validKeys(k)) throw new Error('push-vapid.json is unreadable');
        keys = { publicKey: k.publicKey, privateKey: k.privateKey };
      }
      try { chmodSync(p, 0o600); } catch { /* Windows: the folder's permissions apply */ }
    }
  }
  memo = { path: p, keys };
  return keys;
}
/** Tests: forget the memoised keys. */
export function resetVapid(): void { memo = null; }

function signingKey(k: VapidKeys): KeyObject {
  const pub = unb64u(k.publicKey);
  return createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: k.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: 'jwk' });
}

/** The VAPID JWT for one push service origin (RFC 8292): ES256, `aud` the service's origin, valid 12 hours. */
export function vapidJwt(audience: string, subject: string, k: VapidKeys, now = Date.now()): string {
  const head = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(Buffer.from(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key: signingKey(k), dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${b64u(sig)}`;
}
/** Tests: check a JWT against a public key. */
export function verifyVapidJwt(jwt: string, publicKey: string): { aud: string; exp: number; sub: string } | null {
  const [h, b, s] = jwt.split('.');
  if (!h || !b || !s) return null;
  const pub = unb64u(publicKey);
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: 'jwk' });
  if (!verify('sha256', Buffer.from(`${h}.${b}`), { key, dsaEncoding: 'ieee-p1363' }, unb64u(s))) return null;
  return JSON.parse(unb64u(b).toString('utf8'));
}

// ── RFC 8291 (aes128gcm) ────────────────────────────────────────────────────────────────────────────────────────

const RS = 4096;
const hkdf = (ikm: Buffer, salt: Buffer, info: Buffer, len: number) => Buffer.from(hkdfSync('sha256', ikm, salt, info, len));

/**
 * Encrypt one push message for a browser (one record, RFC 8188 header: salt, rs, keyid = our ephemeral public key).
 * `salt` and `asPrivate` are for the RFC's test vector only; normally both are fresh per message.
 */
export function encryptPayload(plain: Buffer, uaPublic: Buffer, authSecret: Buffer, o: { salt?: Buffer; asPrivate?: Buffer } = {}): Buffer {
  if (plain.length > RS - 17) throw new Error('push payload too large');
  const ecdh = createECDH('prime256v1');
  if (o.asPrivate) ecdh.setPrivateKey(o.asPrivate); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPublic);
  const salt = o.salt ?? randomBytes(16);
  const ikm = hkdf(secret, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const c = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([plain, Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const head = Buffer.alloc(21); salt.copy(head, 0); head.writeUInt32BE(RS, 16); head[20] = asPublic.length;
  return Buffer.concat([head, asPublic, body]);
}

/** The browser's side (tests and the local mock push service): decrypt one aes128gcm message. */
export function decryptPayload(msg: Buffer, uaPrivate: Buffer, authSecret: Buffer): Buffer {
  const salt = msg.subarray(0, 16), idlen = msg[20], asPublic = msg.subarray(21, 21 + idlen), body = msg.subarray(21 + idlen);
  const ecdh = createECDH('prime256v1'); ecdh.setPrivateKey(uaPrivate);
  const uaPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(asPublic);
  const ikm = hkdf(secret, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(body.subarray(body.length - 16));
  const out = Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]);
  let end = out.length - 1;
  while (end >= 0 && out[end] === 0) end--;
  if (out[end] !== 2) throw new Error('not a last record');
  return out.subarray(0, end);
}

// ── sending ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface PushTarget { endpoint: string; p256dh: string; auth: string }
export interface SendOpts { ttlSec?: number; urgency?: 'very-low' | 'low' | 'normal' | 'high'; topic?: string; subject?: string }
/**
 * What the push service said. `accepted` (201): it took the message — NOT that the phone showed it (the phone may be
 * off; the service keeps it up to the TTL). `gone` (404/410): the subscription no longer exists — remove it.
 * `retry` (429/5xx/no answer): try again later. `failed`: refused for another reason (a bad key, a bad VAPID token).
 */
export type SendOutcome = { outcome: 'accepted' | 'gone' | 'retry' | 'failed'; status: number; detail?: string };
export type Transport = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: Buffer }) => Promise<{ status: number; text?: () => Promise<string> }>;

const defaultTransport: Transport = async (url, init) => {
  const r = await fetch(url, { method: 'POST', headers: init.headers, body: init.body, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  return { status: r.status, text: () => r.text() };
};

/** The VAPID `sub`: MWA_PUSH_SUBJECT, else the helper's https address, else a placeholder mailto (some services
 *  insist on one). */
export function pushSubject(publicUrl: string | null, env: NodeJS.ProcessEnv = process.env): string {
  const s = String(env.MWA_PUSH_SUBJECT ?? '').trim();
  if (/^(mailto:|https:\/\/)/i.test(s)) return s;
  if (publicUrl && /^https:\/\//i.test(publicUrl)) return publicUrl.replace(/\/+$/, '');
  return 'mailto:owner@example.com';
}

/** Encrypt and send one message to one subscription. Never throws. */
export async function sendPush(t: PushTarget, payload: object, o: SendOpts = {}, transport: Transport = defaultTransport, env: NodeJS.ProcessEnv = process.env): Promise<SendOutcome> {
  const ep = checkEndpoint(t.endpoint, env);
  if (!ep.ok) return { outcome: 'failed', status: 0, detail: 'not a push service address' };
  const keys = checkKeys(t.p256dh, t.auth);
  if (!keys) return { outcome: 'failed', status: 0, detail: 'the subscription keys are malformed' };
  let body: Buffer, auth: string;
  try {
    const k = vapidKeys(env);
    body = encryptPayload(Buffer.from(JSON.stringify(payload)), keys.p256dh, keys.auth);
    auth = `vapid t=${vapidJwt(ep.url.origin, o.subject ?? pushSubject(null, env), k)}, k=${k.publicKey}`;
  } catch (e) { return { outcome: 'failed', status: 0, detail: `could not encrypt: ${(e as Error).message.slice(0, 80)}` }; }
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream', 'content-encoding': 'aes128gcm', ttl: String(o.ttlSec ?? 4 * 3600),
    urgency: o.urgency ?? 'normal', authorization: auth,
  };
  // Topic: the push service replaces an undelivered message with the same topic (≤ 32 URL-safe characters)
  if (o.topic && /^[A-Za-z0-9_-]{1,32}$/.test(o.topic)) headers.topic = o.topic;
  try {
    const r = await transport(ep.url.href, { method: 'POST', headers, body });
    if (r.status >= 200 && r.status < 300) return { outcome: 'accepted', status: r.status };
    if (r.status === 404 || r.status === 410) return { outcome: 'gone', status: r.status };
    if (r.status === 429 || r.status >= 500) return { outcome: 'retry', status: r.status };
    if (r.status >= 300 && r.status < 400) return { outcome: 'failed', status: r.status, detail: 'the push service redirected (not followed)' };
    let why = '';
    try { why = (await r.text?.())?.replace(/\s+/g, ' ').slice(0, 120) ?? ''; } catch { /* no body */ }
    return { outcome: 'failed', status: r.status, ...(why ? { detail: why } : {}) };
  } catch (e) {
    return { outcome: 'retry', status: 0, detail: (e as Error).name === 'TimeoutError' ? 'no answer in 10 seconds' : 'could not reach the push service' };
  }
}
