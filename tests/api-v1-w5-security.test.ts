// v2 build, slice W5 — the security review's fixes (2026-10-26), one regression test or more each:
//   (3) upload page counting, concurrency and quota; the .docx zip bomb      (5) the Host allowlist and "this machine"
//   (6) every legacy /api route behind a caller check                         (7) OAuth state + PKCE, fake code delivery
//   (8) the pairing link's address                                            (9) the LOWs (config errors, names, …)
// (1) the sign-in throttle, (2) sessions and (4) the per-run limit are in tests/api-v1-w5.test.ts and
// tests/api-v1-pairing.test.ts; the live probes in scripts/v2-w5-security-probe.mjs run them against a real server.
import { describe, it, expect, beforeEach, afterAll, beforeAll, vi } from 'vitest';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createV1 } from '../src/api/router.js';
import { v1Routes } from '../src/api/v1.js';
import { makeAuthenticate, fromThisMachine, createPairCode, redeemPairCode, renameDevice, listDevices, cleanDeviceName } from '../src/api/auth.js';
import { resetAppDb, appDb } from '../src/v2/db.js';
import { setProjectRouteDeps } from '../src/api/routes/projects.js';
import { setSettingsRouteDeps } from '../src/api/routes/settings.js';
import { hostAllowed, relayedMode, sourceOf, cookieSecure, detectTailscaleServe } from '../src/api/trust.js';
import { legacyApiScope } from '../src/api/legacy.js';
import { captureDeploymentEnv, readSettings, updateSettings } from '../src/v2/settings.js';
import { configureSessions, issueSession, sessionIdOf, secretEquals, SESSION_MS } from '../src/api/sessions.js';
import { cleanName } from '../src/files.js';
import { zipUnpackedSize, docxReadable, documentSize } from '../src/tools/builtins.js';
import { catchOAuthCode } from '../src/connect/oauth-catcher.js';
import { fileRoutes } from '../src/api/routes/files.js';

const require = createRequire(import.meta.url);
const JSZip = require('jszip');
const req = (o: { addr?: string; host?: string; headers?: Record<string, string> } = {}) =>
  ({ socket: { remoteAddress: o.addr ?? '127.0.0.1' }, headers: { host: o.host ?? 'localhost:7788', ...(o.headers ?? {}) } }) as unknown as IncomingMessage;
const NOT_HOSTED = () => false;

describe('(5) the Host allowlist (DNS rebinding)', () => {
  it('answers to loopback, IP literals, this machine and the configured names; not to a rebinding name', () => {
    const env = {};
    expect(hostAllowed(req({ host: 'localhost:7788' }), env)).toBe(true);
    expect(hostAllowed(req({ host: '127.0.0.1:7788' }), env)).toBe(true);
    expect(hostAllowed(req({ host: '[::1]:7788' }), env)).toBe(true);
    expect(hostAllowed(req({ host: '100.64.0.7:7788' }), env)).toBe(true); // a rebinding page always has a name
    expect(hostAllowed(req({ host: 'rebind.attacker.example:7902' }), env)).toBe(false);
    expect(hostAllowed(req({ host: '' }), env)).toBe(false);
    expect(hostAllowed(req({ host: 'mwa.tail1a2b.ts.net' }), env)).toBe(false);
    expect(hostAllowed(req({ host: 'mwa.tail1a2b.ts.net' }), { MWA_ALLOWED_HOSTS: 'mwa.tail1a2b.ts.net' })).toBe(true);
    expect(hostAllowed(req({ host: 'box.tail1a2b.ts.net' }), { MWA_ALLOWED_HOSTS: '*.tail1a2b.ts.net' })).toBe(true);
    expect(hostAllowed(req({ host: 'tail1a2b.ts.net.evil.example' }), { MWA_ALLOWED_HOSTS: '*.tail1a2b.ts.net' })).toBe(false);
    expect(hostAllowed(req({ host: 'mwa.tail1a2b.ts.net' }), { MWA_PUBLIC_URL: 'https://mwa.tail1a2b.ts.net' })).toBe(true);
    expect(hostAllowed(req({ host: 'mwa.tail9.ts.net' }), { TAILSCALE_AUTHKEY: 'tskey', TAILSCALE_HOSTNAME: 'mwa' })).toBe(true);
    expect(hostAllowed(req({ host: 'other.tail9.ts.net' }), { TAILSCALE_AUTHKEY: 'tskey', TAILSCALE_HOSTNAME: 'mwa' })).toBe(false);
    expect(hostAllowed(req({ host: 'mwa-production.up.railway.app' }), { RAILWAY_PUBLIC_DOMAIN: 'mwa-production.up.railway.app' })).toBe(true);
    expect(hostAllowed(req({ host: 'anything.example' }), { MWA_ALLOWED_HOSTS: '*' })).toBe(true);
  });
});

describe('(5) "this machine" only when nothing can relay to it', () => {
  it('relayed mode: bound beyond loopback, MWA_RELAYED, the Docker Tailscale, a hosted deploy, a non-local allowed name', () => {
    expect(relayedMode({}, NOT_HOSTED)).toBe(false);
    expect(relayedMode({ MWA_SERVE_HOST: '0.0.0.0' }, NOT_HOSTED)).toBe(true);
    expect(relayedMode({ MWA_SERVE_HOST: '127.0.0.1' }, NOT_HOSTED)).toBe(false);
    expect(relayedMode({ MWA_RELAYED: '1' }, NOT_HOSTED)).toBe(true);
    expect(relayedMode({ TAILSCALE_AUTHKEY: 'tskey-auth-x' }, NOT_HOSTED)).toBe(true);
    expect(relayedMode({}, () => true)).toBe(true);
    expect(relayedMode({ MWA_ALLOWED_HOSTS: 'mwa.tail1a2b.ts.net' }, NOT_HOSTED)).toBe(true);
    expect(relayedMode({ MWA_ALLOWED_HOSTS: '127.0.0.1,localhost' }, NOT_HOSTED)).toBe(false);
    expect(relayedMode({ MWA_PUBLIC_URL: 'https://mwa.tail1a2b.ts.net' }, NOT_HOSTED)).toBe(true);
    expect(relayedMode({ MWA_SERVE_HOST: '0.0.0.0', MWA_RELAYED: '0' }, NOT_HOSTED)).toBe(false); // the owner's own word
  });
  it('a raw relay with Host: localhost, an nginx-style Host: 127.0.0.1 with no XFF, a rebinding Host: none is this machine when relayed', () => {
    const relayed = { MWA_RELAYED: '1' };
    expect(fromThisMachine(req({ host: 'localhost:7788' }), relayed)).toBe(false);
    expect(fromThisMachine(req({ host: '127.0.0.1' }), relayed)).toBe(false);
    expect(fromThisMachine(req({ host: 'localhost:7788' }), { MWA_SERVE_HOST: '0.0.0.0' })).toBe(false);
    expect(fromThisMachine(req({ host: 'localhost:7788' }), { TAILSCALE_AUTHKEY: 'tskey' })).toBe(false);
    // not relayed: still a local Host and no forwarding header
    expect(fromThisMachine(req({ host: 'localhost:7788' }), { MWA_RELAYED: '0' })).toBe(true);
    expect(fromThisMachine(req({ host: 'rebind.attacker.example' }), { MWA_RELAYED: '0' })).toBe(false);
    expect(fromThisMachine(req({ host: 'localhost', headers: { 'x-forwarded-for': '1.2.3.4' } }), { MWA_RELAYED: '0' })).toBe(false);
  });
  it('`tailscale serve` forwarding to this port switches relayed mode on (unless MWA_RELAYED says otherwise)', async () => {
    const prev = process.env.MWA_RELAYED; delete process.env.MWA_RELAYED;
    try {
      const status = JSON.stringify({ TCP: { 443: { HTTPS: true } }, Web: { 'mwa.tail1a2b.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:7788' } } } } });
      expect(await detectTailscaleServe(7799, async () => status)).toBe(false);
      expect(process.env.MWA_RELAYED).toBeUndefined();
      expect(await detectTailscaleServe(7788, async () => status)).toBe(true);
      expect(process.env.MWA_RELAYED).toBe('1');
      delete process.env.MWA_RELAYED;
      expect(await detectTailscaleServe(7788, async () => JSON.stringify({ TCP: { 7788: { TCPForward: '127.0.0.1:7788' } } }))).toBe(true);
      delete process.env.MWA_RELAYED;
      expect(await detectTailscaleServe(7788, async () => { throw new Error('ENOENT'); })).toBe(false);
      process.env.MWA_RELAYED = '0';
      expect(await detectTailscaleServe(7788, async () => status)).toBe(false); // the owner's own word stands
    } finally { if (prev === undefined) delete process.env.MWA_RELAYED; else process.env.MWA_RELAYED = prev; }
  });
  it('the throttle source is the socket; X-Forwarded-For only behind a trusted proxy (right-most untrusted hop)', () => {
    expect(sourceOf(req({ addr: '::ffff:127.0.0.1', headers: { 'x-forwarded-for': '6.6.6.6' } }), {})).toBe('127.0.0.1');
    expect(sourceOf(req({ addr: '127.0.0.1', headers: { 'x-forwarded-for': '6.6.6.6, 100.64.0.9' } }), { MWA_TRUSTED_PROXY: '127.0.0.1' })).toBe('100.64.0.9');
    expect(sourceOf(req({ addr: '10.0.0.5', headers: { 'x-forwarded-for': '6.6.6.6' } }), { MWA_TRUSTED_PROXY: '127.0.0.1' })).toBe('10.0.0.5');
  });
  it('a cookie is Secure only over https (not on plain-http loopback)', () => {
    expect(cookieSecure(req({}))).toBe(false);
    expect(cookieSecure(req({ headers: { 'x-forwarded-proto': 'https' } }))).toBe(true);
  });
});

describe('(6) every legacy /api route takes a caller with the right scope', () => {
  // the inventory the review probed through a relay, and more
  const INVENTORY: [string, string, string][] = [
    ['GET', '/api/status', 'read'], ['GET', '/api/connections', 'admin'], ['POST', '/api/connections', 'admin'], ['GET', '/api/memories', 'read'],
    ['GET', '/api/vault', 'admin'], ['POST', '/api/vault/forget', 'admin'], ['GET', '/api/billing', 'read'], ['POST', '/api/billing/budget', 'admin'],
    ['GET', '/api/billing.csv', 'admin'], ['GET', '/api/logs', 'admin'], ['GET', '/api/conversations', 'read'], ['GET', '/api/schedule', 'read'],
    ['GET', '/api/approvals', 'read'], ['POST', '/api/approvals/confirm', 'approve'], ['POST', '/api/approvals/cancel', 'approve'],
    ['GET', '/api/people', 'read'], ['GET', '/api/notifications', 'read'], ['GET', '/api/memory/export', 'admin'], ['POST', '/api/memory/forget', 'admin'],
    ['POST', '/api/open', 'admin'], ['GET', '/api/quiet', 'read'], ['POST', '/api/quiet', 'admin'], ['POST', '/api/save', 'admin'], ['GET', '/api/models', 'admin'],
    ['GET', '/api/chat', 'act'], ['GET', '/api/chat/live', 'read'], ['POST', '/api/chat/stop', 'act'], ['GET', '/api/ingest', 'admin'],
    ['POST', '/api/work/start', 'act'], ['POST', '/api/stepup/issue', 'admin'], ['GET', '/api/setup', 'admin'], ['POST', '/api/onboard/scan', 'admin'],
    ['GET', '/api/health', 'public'], ['POST', '/api/login', 'public'], ['GET', '/api/share/abc', 'public'], ['GET', '/api/whatever', 'read'], ['POST', '/api/whatever', 'act'],
  ];
  it('the scope each route needs', () => {
    for (const [m, p, want] of INVENTORY) expect(`${m} ${p} → ${legacyApiScope(m, p)}`).toBe(`${m} ${p} → ${want}`);
  });
  it('a stranger through a relay (no password) gets nothing; a paired phone gets reads but not admin', () => {
    const auth = makeAuthenticate({ passwordSet: false, sessionValid: () => false });
    resetAppDb(':memory:');
    const prev = process.env.MWA_RELAYED; process.env.MWA_RELAYED = '1';
    try {
      const stranger = auth(req({ host: 'localhost:7788' }));
      expect(stranger).toBeNull(); // so every non-public route above answers 401 (serve.ts)
      const { code } = createPairCode('t');
      const dev = redeemPairCode(code, 'Pixel')!;
      const phone = auth(req({ host: 'mwa.example', headers: { authorization: `Bearer ${dev.token}` } }))!;
      for (const [m, p, want] of INVENTORY) {
        if (want === 'public') continue;
        expect(`${m} ${p} ${phone.scopes.has(legacyApiScope(m, p) as never)}`).toBe(`${m} ${p} ${want !== 'admin'}`);
      }
    } finally { if (prev === undefined) delete process.env.MWA_RELAYED; else process.env.MWA_RELAYED = prev; }
  });
});

describe('(3) uploads: what is counted, at what size, how many at once, how much in all', () => {
  let server: Server, base = '', ws = '';
  beforeAll(async () => {
    const v1 = createV1(v1Routes(), { authenticate: makeAuthenticate({ passwordSet: false, sessionValid: () => false }), sameOrigin: () => true });
    server = createServer(async (rq, rs) => { if (!(await v1(rq, rs))) { rs.writeHead(404); rs.end(); } });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  });
  beforeEach(() => {
    resetAppDb(':memory:');
    ws = mkdtempSync(join(tmpdir(), 'mwa-w5sec-ws-'));
    setProjectRouteDeps({ workspace: () => ws } as never);
    delete process.env.MWA_UPLOAD_QUOTA_MB;
  });
  afterAll(() => { server?.close(); setProjectRouteDeps(null); delete process.env.MWA_UPLOAD_QUOTA_MB; });
  let n = 0;
  const up = (name: string, body: BodyInit) => fetch(`${base}/files?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'idempotency-key': `sec-up-${Date.now()}-${++n}` }, body });
  async function bomb(mb: number): Promise<Buffer> {
    const z = new JSZip();
    z.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
    const para = '<w:p><w:r><w:t>' + 'A'.repeat(1000) + '</w:t></w:r></w:p>';
    z.file('word/document.xml', '<w:document><w:body>' + para.repeat(Math.round(mb * 1048576 / para.length)) + '</w:body></w:document>');
    return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
  }
  it('reads the zip directory without inflating: a 150 MB .docx in a few hundred KB is "too big"', async () => {
    const b = await bomb(150);
    expect(b.length).toBeLessThan(2 * 1048576);
    expect(zipUnpackedSize(b)!).toBeGreaterThan(150 * 1000 * 1000);
    expect(docxReadable(b)).toBe(false);
    const small = await bomb(1);
    expect(docxReadable(small)).toBe(true);
    expect(zipUnpackedSize(Buffer.from('not a zip'))).toBeNull();
  });
  it('the bomb uploads without being inflated: no page count, memory stays small, the server keeps answering', async () => {
    const b = await bomb(150);
    const before = process.memoryUsage().rss;
    const t0 = Date.now();
    const r = await (await up('bomb.docx', b)).json() as { pages: number | null; path: string };
    expect(r.pages).toBeNull();
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(process.memoryUsage().rss - before).toBeLessThan(80 * 1048576);
    // and an ask that attaches it counts it by size, never inflating it
    const t1 = Date.now();
    const file = readFileSync(join(ws, r.path));
    const size = await documentSize(join(ws, r.path), file);
    expect(Date.now() - t1).toBeLessThan(1_000);
    expect(size.chars).toBe(file.length); // its size in bytes stands in; it was never unzipped
    expect((await fetch(`${base}/meta`)).status).toBe(200);
  });
  it('counts PDFs and text; not images or other binaries', async () => {
    expect((await (await up('notes.txt', 'x'.repeat(7000))).json() as { pages: number }).pages).toBe(3);
    expect((await (await up('photo.jpg', Buffer.alloc(5000, 1))).json() as { pages: number | null }).pages).toBeNull();
    expect((await (await up('sheet.xlsx', Buffer.alloc(5000, 1))).json() as { pages: number | null }).pages).toBeNull();
  });
  it('at most 2 at a time from one device and 4 in all (429, plain words), and a quota for all added files (507)', async () => {
    const admit = fileRoutes.find((r) => r.method === 'POST' && r.path === '/files')!.admit!;
    const ctx = (caller: string) => ({ req: {} as IncomingMessage, caller });
    const a1 = admit(ctx('device:a')), a2 = admit(ctx('device:a'));
    expect(() => admit(ctx('device:a'))).toThrow('Other files are still being added. Try again in a moment.');
    const b1 = admit(ctx('device:b')), b2 = admit(ctx('device:b'));
    expect(() => admit(ctx('local'))).toThrow(/still being added/); // 4 in all
    a1(); a1(); // releasing twice counts once
    const c1 = admit(ctx('local'));
    for (const r of [a2, b1, b2, c1]) r();
    const big = Buffer.alloc(3 * 1048576, 65);
    expect((await up('a.bin', big)).status).toBe(201);
    expect((await up('b.bin', big)).status).toBe(201);
    process.env.MWA_UPLOAD_QUOTA_MB = '7';
    const full = await up('d.bin', big);
    expect(full.status).toBe(507);
    expect(((await full.json()) as { error: { message: string } }).error.message).toMatch(/space for added files is full \(7 MB\)/);
  });
});

describe('(7) OAuth: state and PKCE on the loopback listener', () => {
  const port = 17_000 + Math.floor(Math.random() * 2000);
  const hit = (q: string) => fetch(`http://127.0.0.1:${port}/oauth?${q}`).then(async (r) => ({ status: r.status, text: await r.text() }));
  it('a request without the right state is refused and does not end the attempt; the right one finishes it', async () => {
    const c = catchOAuthCode({ port, state: 'the-right-state-1234567890', label: 'Google' });
    await c.ready;
    expect((await hit('code=attacker&state=wrong')).status).toBe(400);
    expect((await hit('code=attacker')).status).toBe(400);
    expect((await hit('error=access_denied&state=nope')).status).toBe(400);
    const ok = await hit('code=real-code&state=the-right-state-1234567890');
    expect(ok.status).toBe(200);
    expect(await c.code).toBe('real-code');
    expect((await hit('code=late&state=the-right-state-1234567890').catch(() => ({ status: 0 }))).status).toBe(0); // closed
  });
  it('gives up after its time; a newer sign-in replaces an older one', async () => {
    const slow = catchOAuthCode({ port, state: 's1', label: 'Outlook', timeoutMs: 50 });
    await slow.ready;
    await expect(slow.code).rejects.toThrow(/wasn’t finished within 10 minutes/);
    const a = catchOAuthCode({ port, state: 'first', label: 'Outlook' });
    await a.ready;
    const b = catchOAuthCode({ port, state: 'second', label: 'Outlook' });
    await expect(a.code).rejects.toThrow(/newer sign-in/);
    await b.ready;
    expect((await hit('code=c2&state=second')).status).toBe(200);
    expect(await b.code).toBe('c2');
  });
  it('Google: the consent URL carries state and an S256 challenge; the code is exchanged with its verifier (fake Google)', async () => {
    const seen: Record<string, string>[] = [];
    const fake = createServer((rq, rs) => {
      let body = ''; rq.on('data', (d) => { body += d; });
      rq.on('end', () => {
        if (rq.url?.startsWith('/token')) { seen.push(Object.fromEntries(new URLSearchParams(body))); rs.writeHead(200, { 'content-type': 'application/json' }); rs.end(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, token_type: 'Bearer' })); return; }
        if (rq.url?.includes('/gmail/v1/users/me/profile')) { rs.writeHead(200, { 'content-type': 'application/json' }); rs.end(JSON.stringify({ emailAddress: 'owner@example.com' })); return; }
        rs.writeHead(404); rs.end();
      });
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
    const fp = (fake.address() as { port: number }).port;
    const gport = port + 1;
    const dir = mkdtempSync(join(tmpdir(), 'mwa-oauth-'));
    Object.assign(process.env, { MWA_GOOGLE_OAUTH_PORT: String(gport), GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'secret', MWA_GOOGLE_TOKEN_URL: `http://127.0.0.1:${fp}/token`, MWA_GOOGLE_API_ROOT: `http://127.0.0.1:${fp}/`, MWA_GOOGLE_TOKEN: join(dir, 'google-token.json') });
    try {
      vi.resetModules();
      const g = await import('../src/connectors/google.js');
      resetAppDb(':memory:');
      const { url, done } = g.beginGoogleConsentForTests(false);
      const u = new URL(url);
      const state = u.searchParams.get('state')!, challenge = u.searchParams.get('code_challenge')!;
      expect(state).toMatch(/^[A-Za-z0-9_-]{30,}$/);
      expect(u.searchParams.get('code_challenge_method')).toBe('S256');
      await new Promise((r) => setTimeout(r, 100));
      expect((await fetch(`http://127.0.0.1:${gport}/oauth?code=forged&state=guess`)).status).toBe(400);
      expect((await fetch(`http://127.0.0.1:${gport}/oauth?code=good-code&state=${state}`)).status).toBe(200);
      expect(await done).toBe('owner@example.com');
      expect(seen).toHaveLength(1);
      expect(seen[0].code).toBe('good-code');
      expect(createHash('sha256').update(seen[0].code_verifier).digest('base64url')).toBe(challenge);
      expect(JSON.parse(readFileSync(join(dir, 'google-token.json'), 'utf8')).mwa_account).toBe('owner@example.com');
    } finally {
      fake.close();
      for (const k of ['MWA_GOOGLE_OAUTH_PORT', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'MWA_GOOGLE_TOKEN_URL', 'MWA_GOOGLE_API_ROOT', 'MWA_GOOGLE_TOKEN']) delete process.env[k];
    }
  });
  it('Outlook: the consent URL carries state and its S256 challenge', async () => {
    Object.assign(process.env, { MWA_MS_OAUTH_PORT: String(port + 2), MICROSOFT_CLIENT_ID: 'mscid' });
    try {
      vi.resetModules();
      const m = await import('../src/connectors/microsoft.js');
      const { url, done } = m.beginMicrosoftConsentForTests(false);
      done.catch(() => { /* never finished here */ });
      const u = new URL(url);
      expect(u.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{30,}$/);
      expect(u.searchParams.get('code_challenge_method')).toBe('S256');
      await new Promise((r) => setTimeout(r, 100));
      expect((await fetch(`http://127.0.0.1:${port + 2}/oauth?code=forged`)).status).toBe(400); // no state: refused, still waiting
      expect((await fetch(`http://127.0.0.1:${port + 2}/oauth?code=forged&state=${u.searchParams.get('state')}x`)).status).toBe(400);
    } finally { delete process.env.MWA_MS_OAUTH_PORT; delete process.env.MICROSOFT_CLIENT_ID; }
  });
});

describe('(8) the pairing link uses an address a phone can open', () => {
  let server: Server, base = '';
  beforeAll(async () => {
    // signed in with the password (a non-local allowed host puts the server in relayed mode: no "this machine")
    const v1 = createV1(v1Routes(), { authenticate: makeAuthenticate({ passwordSet: true, sessionValid: () => true }), sameOrigin: () => true });
    server = createServer(async (rq, rs) => { if (!(await v1(rq, rs))) { rs.writeHead(404); rs.end(); } });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  });
  beforeEach(() => { resetAppDb(':memory:'); delete process.env.MWA_PUBLIC_URL; delete process.env.MWA_ALLOWED_HOSTS; process.env.MWA_CONFIG_PATH = join(mkdtempSync(join(tmpdir(), 'mwa-cfg-')), 'c.json'); captureDeploymentEnv(); });
  afterAll(() => { server?.close(); delete process.env.MWA_PUBLIC_URL; delete process.env.MWA_CONFIG_PATH; captureDeploymentEnv(); });
  let n = 0;
  const code = async () => (await fetch(`${base}/pair/codes`, { method: 'POST', headers: { 'idempotency-key': `sec-pc-${++n}-xxxx` } })).json() as Promise<{ pairUrl: string; reachable: boolean }>;
  it('opened at localhost with no address known: says so (reachable false)', async () => {
    const c = await code();
    expect(c.reachable).toBe(false);
    expect(c.pairUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/pair#c=/);
  });
  it('the address saved in Settings, or MWA_PUBLIC_URL, or the tailnet name in MWA_ALLOWED_HOSTS', async () => {
    updateSettings({ publicUrl: 'mwa.tail1a2b.ts.net' });
    expect((await code())).toMatchObject({ reachable: true, pairUrl: expect.stringMatching(/^https:\/\/mwa\.tail1a2b\.ts\.net\/pair#c=/) });
    updateSettings({ publicUrl: null });
    process.env.MWA_ALLOWED_HOSTS = 'box.tail9.ts.net';
    expect((await code()).pairUrl).toMatch(/^https:\/\/box\.tail9\.ts\.net\/pair#c=/);
    process.env.MWA_PUBLIC_URL = 'https://mwa.example.ts.net:8443/';
    expect((await code()).pairUrl).toMatch(/^https:\/\/mwa\.example\.ts\.net:8443\/pair#c=/);
  });
  it('refuses an address a phone cannot open', () => {
    expect(() => updateSettings({ publicUrl: 'ftp://x' })).toThrow(/address a phone can open/);
    expect(() => updateSettings({ publicUrl: 'https://x.example/path?q' })).toThrow(/address a phone can open/);
  });
});

describe('(9) the LOWs', () => {
  beforeEach(() => { resetAppDb(':memory:'); process.env.MWA_CONFIG_PATH = join(mkdtempSync(join(tmpdir(), 'mwa-cfg-')), 'mwa.config.json'); captureDeploymentEnv(); });
  afterAll(() => { delete process.env.MWA_CONFIG_PATH; });
  it('an invalid settings file is reported (not a first-run trap); first run is kept in app.db', () => {
    writeFileSync(process.env.MWA_CONFIG_PATH!, '{ not json');
    const s = readSettings();
    expect(s.configError).toMatch(/isn’t valid JSON/);
    updateSettings({ firstRunDone: true }); // works although the file is broken
    expect(readSettings().firstRunDone).toBe(true);
    expect(() => updateSettings({ helperName: 'x' })).toThrow(/Nothing was saved/);
    expect(readFileSync(process.env.MWA_CONFIG_PATH!, 'utf8')).toBe('{ not json'); // untouched
  });
  it('odd values in the settings file are ignored, not shown', () => {
    writeFileSync(process.env.MWA_CONFIG_PATH!, JSON.stringify({ helper: { name: { a: 1 }, timeZone: 'Not/AZone', sorting: 'yes', fireCapUsd: 1e400, firstRunDone: 'true' }, owner: { name: ['x', 'y'] } }));
    const s = readSettings();
    expect(s).toMatchObject({ helperName: 'Your helper', ownerName: null, firstRunDone: false, configError: null });
  });
  it('non-string settings are 400s', () => {
    for (const p of [{ helperName: ['a', 'b'] }, { ownerName: { toString: 1 } }, { timeZone: 5 }, { publicUrl: 7 }]) {
      expect(() => updateSettings(p as never)).toThrow(/is text|is an address/);
    }
    expect(() => updateSettings({ features: JSON.parse('{"__proto__":{"sorting":true}}') })).toThrow(/features/);
  });
  it('bidi controls are stripped from device names at pairing and rename', () => {
    const { code } = createPairCode('t');
    const d = redeemPairCode(code, 'evil‮gnp.exe⁦x')!;
    expect(listDevices().find((x) => x.id === d.deviceId)!.name).toBe('evil gnp.exe x');
    expect(renameDevice(d.deviceId, '‮kcatta‏')!.name).toBe('kcatta');
    expect(cleanDeviceName('\u0000\u0007a⁧b')).toBe('a b');
  });
  it('secrets are compared without leaking their length', () => {
    expect(secretEquals('abc', 'abc')).toBe(true);
    expect(secretEquals('abc', 'abcd')).toBe(false);
    expect(secretEquals('', 'x')).toBe(false);
  });
  it('Windows device names and trailing dots are never file names', () => {
    expect(cleanName('CON')).toBe('_CON');
    expect(cleanName('nul.txt')).toBe('_nul.txt');
    expect(cleanName('LPT1')).toBe('_LPT1');
    expect(cleanName('a.txt:ads')).toBe('a.txt_ads');
    expect(cleanName('report. . ')).toBe('report');
    expect(cleanName('console.txt')).toBe('console.txt');
  });
  it('sessions: a pre-upgrade session is adopted once; one issued since the table exists needs its row', () => {
    configureSessions({ password: 'pw-for-tests' });
    const { token, id } = issueSession();
    expect(sessionIdOf(token)).toBe(id);
    appDb().prepare('DELETE FROM sessions WHERE id = ?').run(id);
    expect(sessionIdOf(token)).toBeNull(); // issued after the table existed, yet unknown: refused
    appDb().prepare(`UPDATE migrations SET at = ? WHERE name = '013-sessions'`).run(Date.now() + 5000);
    expect(sessionIdOf(token)).toBe(id); // "older" than the table: adopted
    expect(appDb().prepare('SELECT via FROM sessions WHERE id = ?').get(id)).toEqual({ via: 'adopted' });
    expect(sessionIdOf(token.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')))).toBeNull();
    expect(SESSION_MS).toBe(30 * 24 * 3_600_000);
  });
  it('a body over the limit sent chunked gets a clean 413', async () => {
    const v1 = createV1(v1Routes(), { authenticate: makeAuthenticate({ passwordSet: false, sessionValid: () => false }), sameOrigin: () => true });
    const srv = createServer(async (rq, rs) => { if (!(await v1(rq, rs))) { rs.writeHead(404); rs.end(); } });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const ws = mkdtempSync(join(tmpdir(), 'mwa-413-'));
    setProjectRouteDeps({ workspace: () => ws } as never);
    try {
      const { request } = await import('node:http');
      const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const r = request({ host: '127.0.0.1', port: (srv.address() as { port: number }).port, path: '/api/v1/files?name=big.bin', method: 'POST', headers: { 'idempotency-key': 'chunked-0001', 'transfer-encoding': 'chunked' } }, (x) => {
          let b = ''; x.on('data', (d) => { b += d; }); x.on('end', () => resolve({ status: x.statusCode!, body: b }));
        });
        r.on('error', reject);
        const chunk = Buffer.alloc(1 << 20, 65);
        let sent = 0;
        const pump = () => { while (sent < 40) { sent++; if (!r.write(chunk)) { r.once('drain', pump); return; } } r.end(); };
        pump();
      });
      expect(res.status).toBe(413);
      expect(JSON.parse(res.body).error.code).toBe('too_large');
      expect(existsSync(join(ws, 'serve/p-general/uploads/big.bin'))).toBe(false);
    } finally { srv.close(); setProjectRouteDeps(null); }
  });
});
