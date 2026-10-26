// v2 build, slice A2: device pairing, per-device tokens, scopes, revocation, and the open-network gap — over HTTP
// with the real resolver (src/api/auth.ts) and routes (src/api/routes/devices.ts).
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createV1 } from '../src/api/router.js';
import { v1Routes } from '../src/api/v1.js';
import { makeAuthenticate, resetPairingThrottle, fromThisMachine } from '../src/api/auth.js';
import { appDb, resetAppDb } from '../src/v2/db.js';

const mode = { passwordSet: false, sessionValid: false };
let server: Server, base = '';
let key = 0;
const k = () => `test-key-${Date.now()}-${++key}`;
const j = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => null), headers: r.headers });
/** A request as if it came from the network through a local proxy (tailscale serve adds X-Forwarded-For). */
const NET = { 'x-forwarded-for': '100.64.0.7' };

beforeEach(async () => {
  resetAppDb(':memory:'); resetPairingThrottle(); Object.assign(mode, { passwordSet: false, sessionValid: false });
  if (!server) {
    const v1 = createV1(v1Routes(), {
      authenticate: (req) => makeAuthenticate({ passwordSet: mode.passwordSet, sessionValid: () => mode.sessionValid })(req),
      sameOrigin: (req) => !req.headers.origin || req.headers.origin === 'http://same.example',
    });
    server = createServer(async (req, res) => { if (!(await v1(req, res))) { res.writeHead(404); res.end(); } });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  }
});
afterAll(() => server?.close());

async function newCode(): Promise<string> {
  const r = await j(await fetch(`${base}/pair/codes`, { method: 'POST', headers: { 'idempotency-key': k() } }));
  expect(r.status).toBe(201);
  return r.body.code;
}
async function pairToken(name = 'Pixel'): Promise<{ deviceId: string; token: string }> {
  const r = await j(await fetch(`${base}/pair`, { method: 'POST', headers: { ...NET, 'content-type': 'application/json' }, body: JSON.stringify({ code: await newCode(), name, cookie: false }) }));
  expect(r.status).toBe(201);
  return r.body;
}
const as = (token: string, extra: Record<string, string> = {}) => ({ ...NET, authorization: `Bearer ${token}`, ...extra });

describe('who may call v1 with no password configured', () => {
  it('this machine may do everything, including making a pairing code', async () => {
    const r = await j(await fetch(`${base}/pair/codes`, { method: 'POST', headers: { 'idempotency-key': k() } }));
    expect(r.status).toBe(201);
    expect(r.body.code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(r.body.pairUrl).toMatch(/\/pair#c=/);
  });
  it('the network — even through a local proxy — is NOT this machine, and is refused without a paired device', async () => {
    expect((await j(await fetch(`${base}/devices`, { headers: NET }))).status).toBe(401);
    expect((await j(await fetch(`${base}/devices`, { headers: { 'tailscale-user-login': 'robert@example.com' } }))).status).toBe(401);
    expect((await j(await fetch(`${base}/meta`, { headers: NET }))).status).toBe(200); // public stays public
  });
  it('fromThisMachine reads the socket and the proxy headers', () => {
    const req = (addr: string, h: Record<string, string> = {}) => ({ socket: { remoteAddress: addr }, headers: { host: '127.0.0.1:7788', ...h } }) as never;
    expect(fromThisMachine(req('127.0.0.1'))).toBe(true);
    expect(fromThisMachine(req('::ffff:127.0.0.1'))).toBe(true);
    expect(fromThisMachine(req('100.64.0.7'))).toBe(false);
    expect(fromThisMachine(req('127.0.0.1', { 'x-forwarded-for': '100.64.0.7' }))).toBe(false);
  });
});

describe('with a password configured', () => {
  it('this machine gets nothing without the session; with it, everything', async () => {
    mode.passwordSet = true;
    expect((await j(await fetch(`${base}/devices`))).status).toBe(401);
    mode.sessionValid = true;
    expect((await j(await fetch(`${base}/devices`))).status).toBe(200);
  });
});

describe('pairing', () => {
  it('a code pairs exactly one device; the token is returned once and stored only as a hash', async () => {
    const code = await newCode();
    const p1 = await j(await fetch(`${base}/pair`, { method: 'POST', headers: { ...NET, 'content-type': 'application/json' }, body: JSON.stringify({ code, name: 'Pixel 9', cookie: false }) }));
    expect(p1.status).toBe(201);
    expect(p1.body.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(p1.body.scopes).toEqual(['read', 'act', 'approve']);
    const p2 = await j(await fetch(`${base}/pair`, { method: 'POST', headers: { ...NET, 'content-type': 'application/json' }, body: JSON.stringify({ code, name: 'Thief' }) }));
    expect(p2).toMatchObject({ status: 400, body: { error: { code: 'pair_code_invalid' } } });
    const rows = appDb().prepare('SELECT token_hash FROM devices').all() as { token_hash: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).not.toContain(p1.body.token);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
  });
  it('codes are case- and dash-insensitive, and expire', async () => {
    const code = await newCode();
    const ok = await j(await fetch(`${base}/pair`, { method: 'POST', headers: { ...NET, 'content-type': 'application/json' }, body: JSON.stringify({ code: code.toLowerCase().replace('-', ' '), cookie: false }) }));
    expect(ok.status).toBe(201);
    const old = await newCode();
    appDb().prepare('UPDATE pair_codes SET expires_at = ? WHERE used_at IS NULL').run(Date.now() - 1);
    const late = await j(await fetch(`${base}/pair`, { method: 'POST', headers: { ...NET, 'content-type': 'application/json' }, body: JSON.stringify({ code: old }) }));
    expect(late.body.error.code).toBe('pair_code_invalid');
  });
  it('the web app gets an HttpOnly, SameSite=Strict, Secure cookie on a secure connection, and no token in the body', async () => {
    const r1 = await j(await fetch(`${base}/pair`, { method: 'POST', headers: { ...NET, 'content-type': 'application/json' }, body: JSON.stringify({ code: await newCode() }) }));
    expect(r1.body.token).toBeUndefined();
    const c1 = r1.headers.get('set-cookie') ?? '';
    // a request to 127.0.0.1 is a secure context for a browser, so Secure is right here too (the not-secure case —
    // a plain http://100.x address — is covered by secureContext's own test)
    expect(c1).toMatch(/^mwa_device=[A-Za-z0-9_-]{40,}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=\d+; Secure$/);
    const r2 = await fetch(`${base}/pair`, { method: 'POST', headers: { ...NET, 'x-forwarded-proto': 'https', 'content-type': 'application/json' }, body: JSON.stringify({ code: await newCode() }) });
    expect(r2.headers.get('set-cookie')).toMatch(/; Secure$/);
  });
  it('five wrong codes in ten minutes from one place stop further tries from there (429)', async () => {
    for (let i = 0; i < 5; i++) await fetch(`${base}/pair`, { method: 'POST', headers: { ...NET, 'content-type': 'application/json' }, body: JSON.stringify({ code: 'AAAA-AAAA' }) });
    const r = await j(await fetch(`${base}/pair`, { method: 'POST', headers: { ...NET, 'content-type': 'application/json' }, body: JSON.stringify({ code: await newCode() }) }));
    expect(r).toMatchObject({ status: 429, body: { error: { code: 'too_many_attempts' } } });
  });
});

describe('a paired device', () => {
  it('can do what its scopes allow and nothing else (no admin)', async () => {
    const { token } = await pairToken();
    const r = await j(await fetch(`${base}/devices`, { headers: as(token) }));
    expect(r).toMatchObject({ status: 403, body: { error: { code: 'forbidden' } } });
    expect((await fetch(`${base}/pair/codes`, { method: 'POST', headers: as(token, { 'idempotency-key': k() }) })).status).toBe(403);
  });
  it('with a bearer token, a write is not subject to the cross-site check; with a cookie it is', async () => {
    const { token } = await pairToken();
    const bearer = await fetch(`${base}/devices/me/sign-out`, { method: 'POST', headers: as(token, { origin: 'https://evil.example', 'idempotency-key': k() }) });
    expect(bearer.status).toBe(200);
    const c = await j(await fetch(`${base}/pair`, { method: 'POST', headers: { ...NET, 'content-type': 'application/json' }, body: JSON.stringify({ code: await newCode() }) }));
    const cookie = (c.headers.get('set-cookie') ?? '').split(';')[0];
    const viaCookie = await j(await fetch(`${base}/devices/me/sign-out`, { method: 'POST', headers: { ...NET, cookie, origin: 'https://evil.example', 'idempotency-key': k() } }));
    expect(viaCookie).toMatchObject({ status: 403, body: { error: { code: 'cross_origin' } } });
  });
  it('is refused on its very next request after being revoked from Settings', async () => {
    const { deviceId, token } = await pairToken();
    expect((await fetch(`${base}/devices/me/sign-out`, { method: 'POST', headers: as(token, { 'idempotency-key': k() }) })).status).toBe(200); // works…
    const { deviceId: id2, token: t2 } = await pairToken('Tablet');
    const list = await j(await fetch(`${base}/devices`));
    expect(list.body.devices.map((d: { id: string }) => d.id)).toEqual(expect.arrayContaining([deviceId, id2]));
    const rev = await j(await fetch(`${base}/devices/${id2}`, { method: 'DELETE', headers: { 'idempotency-key': k() } }));
    expect(rev).toMatchObject({ status: 200, body: { revoked: id2 } });
    expect((await fetch(`${base}/devices/me/sign-out`, { method: 'POST', headers: as(t2, { 'idempotency-key': k() }) })).status).toBe(401);
    expect((await j(await fetch(`${base}/devices/${id2}`, { method: 'DELETE', headers: { 'idempotency-key': k() } }))).status).toBe(404);
  });
  it('signing itself out revokes it and tells the browser to clear this site\'s storage', async () => {
    const { token } = await pairToken();
    const r = await fetch(`${base}/devices/me/sign-out`, { method: 'POST', headers: as(token, { 'idempotency-key': k() }) });
    expect(r.headers.get('clear-site-data')).toBe('"cache", "storage"');
    expect(r.headers.get('set-cookie')).toMatch(/Max-Age=0/);
    expect((await fetch(`${base}/devices/me/sign-out`, { method: 'POST', headers: as(token, { 'idempotency-key': k() }) })).status).toBe(401);
  });
  it('two devices using the same idempotency key do not get each other\'s answers', async () => {
    const a = await pairToken('A'), b = await pairToken('B');
    const ra = await j(await fetch(`${base}/devices/me/sign-out`, { method: 'POST', headers: as(a.token, { 'idempotency-key': 'shared-key-0001' }) }));
    const rb = await j(await fetch(`${base}/devices/me/sign-out`, { method: 'POST', headers: as(b.token, { 'idempotency-key': 'shared-key-0001' }) }));
    expect(ra.body.revoked).toBe(a.deviceId);
    expect(rb.body.revoked).toBe(b.deviceId);
    expect(rb.headers.get('idempotent-replay')).toBeNull();
  });
});

// Review of A2 (2026-10-26): each finding, pinned.
describe('review of A2', () => {
  const req = (addr: string, h: Record<string, string>) => ({ socket: { remoteAddress: addr }, headers: h }) as never;
  it('"this machine" needs a local Host: a relay (tailscale userspace, ssh/socat, rebinding) that keeps the client\'s Host is not local', () => {
    expect(fromThisMachine(req('127.0.0.1', { host: 'localhost:7788' }))).toBe(true);
    expect(fromThisMachine(req('::1', { host: '[::1]:7788' }))).toBe(true);
    expect(fromThisMachine(req('127.0.0.1', { host: 'box.tail1234.ts.net' }))).toBe(false);
    expect(fromThisMachine(req('127.0.0.1', { host: '100.64.0.7:7788' }))).toBe(false);
    expect(fromThisMachine(req('127.0.0.1', { host: 'evil.example' }))).toBe(false); // DNS rebinding
    expect(fromThisMachine(req('127.0.0.1', {}))).toBe(false); // no Host at all
  });
  it('any forwarding-style header — even empty — means relayed', () => {
    for (const h of ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip', 'via', 'tailscale-user-login'])
      expect(fromThisMachine(req('127.0.0.1', { host: 'localhost', [h]: '' })), h).toBe(false);
  });
  it('this machine is subject to the cross-site check (a page in the owner\'s browser reaches 127.0.0.1)', async () => {
    const r = await j(await fetch(`${base}/pair/codes`, { method: 'POST', headers: { origin: 'https://evil.example', 'idempotency-key': k() } }));
    expect(r).toMatchObject({ status: 403, body: { error: { code: 'cross_origin' } } });
    const pub = await j(await fetch(`${base}/pair`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'text/plain' }, body: JSON.stringify({ code: 'AAAA-AAAA' }) }));
    expect(pub.body.error.code).toBe('cross_origin');
  });
  it('an Authorization header that does not verify is a 401 — never a fall-through to this machine or a cookie', async () => {
    expect((await fetch(`${base}/devices`, { headers: { authorization: 'Bearer short.token' } })).status).toBe(401);
    expect((await fetch(`${base}/devices`, { headers: { authorization: 'Basic abc' } })).status).toBe(401);
    expect((await fetch(`${base}/devices`)).status).toBe(200);
  });
  it('the password session outranks a device cookie in the same browser (the owner keeps admin)', async () => {
    const c = await j(await fetch(`${base}/pair`, { method: 'POST', headers: { ...NET, 'content-type': 'application/json' }, body: JSON.stringify({ code: await newCode() }) }));
    const cookie = (c.headers.get('set-cookie') ?? '').split(';')[0];
    Object.assign(mode, { passwordSet: true, sessionValid: true });
    expect((await fetch(`${base}/devices`, { headers: { ...NET, cookie } })).status).toBe(200);
    mode.sessionValid = false;
    expect((await fetch(`${base}/devices`, { headers: { ...NET, cookie } })).status).toBe(403); // the device alone: no admin
  });
  it('wrong codes are limited per source: one sprayer cannot lock the owner out', async () => {
    for (let i = 0; i < 5; i++) await fetch(`${base}/pair`, { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.9', 'content-type': 'application/json' }, body: JSON.stringify({ code: 'AAAA-AAAA' }) });
    expect((await fetch(`${base}/pair`, { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.9', 'content-type': 'application/json' }, body: JSON.stringify({ code: 'BBBB-BBBB' }) })).status).toBe(429);
    const owner = await j(await fetch(`${base}/pair`, { method: 'POST', headers: { ...NET, 'content-type': 'application/json' }, body: JSON.stringify({ code: await newCode(), cookie: false }) }));
    expect(owner.status).toBe(201);
  });
  it('with a password set, a stranger gets 401 for every non-public path — no route map', async () => {
    mode.passwordSet = true;
    expect((await fetch(`${base}/nope`, { headers: NET })).status).toBe(401);
    expect((await fetch(`${base}/devices`, { method: 'PUT', headers: NET })).status).toBe(401);
    expect((await fetch(`${base}/meta`, { headers: NET })).status).toBe(200);
  });
});
