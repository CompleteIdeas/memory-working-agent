// v2 build, slice W5: the v1 file upload, the legacy /api/files hole closed, the signed-out page gate, sign-in, /me,
// settings, spending, accounts and devices — over HTTP with the real resolver (src/api/auth.ts) and routes.
import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createV1 } from '../src/api/router.js';
import { v1Routes } from '../src/api/v1.js';
import { makeAuthenticate, createPairCode, redeemPairCode } from '../src/api/auth.js';
import { signInGate, pairingGate } from '../src/api/gate.js';
import { configureSessions, sessionValid as realSessionValid } from '../src/api/sessions.js';
import { resetAppDb } from '../src/v2/db.js';
import { setProjectRouteDeps } from '../src/api/routes/projects.js';
import { setSettingsRouteDeps } from '../src/api/routes/settings.js';
import { firstFilePart } from '../src/api/routes/files.js';
import { handleLegacyFiles, signedOutPageAllowed, legacyFilesScope } from '../src/api/legacy.js';
import { createProject, setEmbedder } from '../src/v2/projects.js';
import { captureDeploymentEnv, applyStoredSettings } from '../src/v2/settings.js';
import { MAX_UPLOAD } from '../src/files.js';

const mode = { passwordSet: false, sessionValid: false };
const gateWaits: number[] = [];
let server: Server, base = '', origin = '', ws = '', cfgDir = '';
let key = 0;
const k = () => `w5-key-${Date.now()}-${++key}`;
const j = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => null), headers: r.headers });
/** From the network through a local proxy: never "this machine". */
const NET = { 'x-forwarded-for': '100.64.0.7' };
const as = (token: string, extra: Record<string, string> = {}) => ({ ...NET, authorization: `Bearer ${token}`, ...extra });
const ENV_KEYS = ['MWA_CONFIG_PATH', 'MWA_TOKEN_LOG', 'MWA_VAULT_PATH', 'MWA_TZ', 'MWA_TRIAGE', 'MWA_FIRE_CAP_USD', 'MWA_OWNER_NAME', 'MWA_MONTHLY_BUDGET_USD'];
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const e of ENV_KEYS) { saved[e] = process.env[e]; delete process.env[e]; }
  setEmbedder(async (t) => [t.length % 7, 1, 0]);
  const authenticate = (req: Parameters<ReturnType<typeof makeAuthenticate>>[0]) => makeAuthenticate({ passwordSet: mode.passwordSet, sessionValid: (r) => mode.sessionValid || realSessionValid(r) })(req);
  const sameOrigin = (req: { headers: Record<string, unknown> }) => !req.headers.origin || req.headers.origin === 'http://same.example';
  const v1 = createV1(v1Routes(), { authenticate, sameOrigin: sameOrigin as never });
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/files' || url.pathname.startsWith('/api/files/')) {
      await handleLegacyFiles(req, res, url, { root: () => ws, authenticate, sameOrigin: sameOrigin as never, sendExport: async (r) => { r.writeHead(200); r.end('exported'); } });
      return;
    }
    if (!(await v1(req, res))) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  base = `${origin}/api/v1`;
});
beforeEach(() => {
  resetAppDb(':memory:'); signInGate.reset(); pairingGate.reset(); gateWaits.length = 0;
  for (const g of [signInGate, pairingGate]) g.configure({ sleep: async (ms) => { gateWaits.push(ms); } });
  configureSessions({ password: 'throwaway-pw' });
  Object.assign(mode, { passwordSet: false, sessionValid: false });
  ws = mkdtempSync(join(tmpdir(), 'mwa-w5-ws-'));
  cfgDir = mkdtempSync(join(tmpdir(), 'mwa-w5-cfg-'));
  for (const e of ENV_KEYS) delete process.env[e];
  Object.assign(process.env, { MWA_CONFIG_PATH: join(cfgDir, 'mwa.config.json'), MWA_TOKEN_LOG: join(cfgDir, 'tokens.jsonl'), MWA_VAULT_PATH: join(cfgDir, 'vault.json') });
  captureDeploymentEnv();
  setProjectRouteDeps({ workspace: () => ws, startChat: async () => ({ state: 'started', runId: 'x' }), stop: () => false, steer: () => false, attach: () => null, acceptOffer: async () => null } as never);
  setSettingsRouteDeps({
    passwordSet: () => mode.passwordSet, checkPassword: (pw) => pw === 'throwaway-pw',
    connections: () => ({ googleClient: false, gmailAppPassword: true, googleConnected: true, outlookDeviceCode: true, microsoftClient: false, outlookConnected: false }),
    startOutlookDeviceCode: async () => ({ user_code: 'QWER-TY12', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900 }),
  });
});
afterAll(() => {
  server?.close(); setProjectRouteDeps(null); setSettingsRouteDeps(null); setEmbedder(null);
  for (const e of ENV_KEYS) { if (saved[e] === undefined) delete process.env[e]; else process.env[e] = saved[e]; }
});

/** A paired device with these scopes, and its bearer token. */
function device(scopes: ('read' | 'act' | 'approve' | 'admin')[], name = 'Pixel'): { id: string; token: string } {
  const { code } = createPairCode('test', scopes);
  const got = redeemPairCode(code, name, 'android')!;
  return { id: got.deviceId, token: got.token };
}
const upload = (q: string, body: BodyInit, headers: Record<string, string> = {}) =>
  fetch(`${base}/files?${q}`, { method: 'POST', headers: { 'idempotency-key': k(), 'content-type': 'application/octet-stream', ...headers }, body });

describe('POST /api/v1/files: who may upload', () => {
  it('a stranger from the network gets 401; a read-only device 403; a device that may act, 201', async () => {
    expect((await upload('name=a.txt', 'hello', NET)).status).toBe(401);
    const ro = device(['read']);
    const r1 = await j(await upload('name=a.txt', 'hello', as(ro.token)));
    expect(r1.status).toBe(403);
    expect(r1.body.error.code).toBe('forbidden');
    const phone = device(['read', 'act', 'approve']);
    const r2 = await j(await upload('name=a.txt', 'hello', as(phone.token)));
    expect(r2.status).toBe(201);
    expect(r2.body).toMatchObject({ path: 'serve/p-general/uploads/a.txt', id: 'serve/p-general/uploads/a.txt', name: 'a.txt', size: 5, projectId: 'general' });
    expect(readFileSync(join(ws, 'serve/p-general/uploads/a.txt'), 'utf8')).toBe('hello');
  });
  it('with a password set, this machine alone is not enough; the session is', async () => {
    mode.passwordSet = true;
    expect((await upload('name=a.txt', 'x')).status).toBe(401);
    mode.sessionValid = true;
    expect((await upload('name=a.txt', 'x')).status).toBe(201);
  });
  it('a cookie-carried write from another site is refused (cross-origin)', async () => {
    const r = await j(await upload('name=a.txt', 'x', { origin: 'http://evil.example' }));
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('cross_origin');
  });
  it('needs an Idempotency-Key, and a retry with the same key saves one file and answers the same', async () => {
    expect((await fetch(`${base}/files?name=a.txt`, { method: 'POST', body: 'x' })).status).toBe(400);
    const key1 = k();
    const send = () => fetch(`${base}/files?name=same.txt`, { method: 'POST', headers: { 'idempotency-key': key1 }, body: 'one' });
    const a = await j(await send()), b = await j(await send());
    expect(a.status).toBe(201); expect(b.status).toBe(201);
    expect(b.headers.get('idempotent-replay')).toBe('true');
    expect(b.body.path).toBe(a.body.path);
    expect(readdirSync(join(ws, 'serve/p-general/uploads'))).toEqual(['same.txt']);
  });
});

describe('POST /api/v1/files: names, folders, sizes', () => {
  it('goes into the project’s own folder; an unknown or path-like project is 404', async () => {
    const p = createProject({ name: 'Eventing' });
    const r = await j(await upload(`projectId=${p.id}&name=rules.txt`, 'The rules.'));
    expect(r.status).toBe(201);
    expect(r.body.path).toBe(`serve/p-${p.id}/uploads/rules.txt`);
    expect(r.body.projectId).toBe(p.id);
    for (const bad of ['pr_nope', '../general', '..%2F..%2Fetc', 'general/../../x']) {
      expect((await upload(`projectId=${bad}&name=x.txt`, 'x')).status, bad).toBe(404);
    }
  });
  it('cleans the name: no folders, no leading dots, nothing odd; never over an existing file', async () => {
    const names: [string, string][] = [
      ['../../etc/passwd', 'passwd'], ['..\\..\\boot.ini', 'boot.ini'], ['.env', 'env'], ['a<b>c|d.pdf', 'a_b_c_d.pdf'],
      ['/abs/path/notes.md', 'notes.md'], ['...', 'upload'],
    ];
    for (const [given, want] of names) {
      const r = await j(await upload(`name=${encodeURIComponent(given)}`, 'x'));
      expect(r.status, given).toBe(201);
      expect(r.body.name, given).toBe(want);
      expect(r.body.path, given).toBe(`serve/p-general/uploads/${want}`);
    }
    const again = await j(await upload('name=passwd', 'second'));
    expect(again.body.name).toBe('passwd (2)');
    expect(existsSync(join(ws, '..', 'etc'))).toBe(false);
  });
  it('a raw body needs a name; an empty file is refused', async () => {
    expect((await j(await upload('', 'x'))).body.error.code).toBe('no_name');
    expect((await j(await upload('name=%20%20', 'x'))).body.error.code).toBe('no_name');
    expect((await j(await upload('name=a.txt', ''))).body.error.code).toBe('empty_file');
  });
  it('takes multipart/form-data with one file part (the part’s name, cleaned)', async () => {
    const fd = new FormData();
    fd.append('note', 'not a file');
    fd.append('file', new Blob(['Willow’s vaccination dates'], { type: 'text/plain' }), '../vaccines.txt');
    const r = await j(await fetch(`${base}/files`, { method: 'POST', headers: { 'idempotency-key': k() }, body: fd }));
    expect(r.status).toBe(201);
    expect(r.body.name).toBe('vaccines.txt');
    expect(readFileSync(join(ws, r.body.path), 'utf8')).toBe('Willow’s vaccination dates');
    expect(r.body.pages).toBe(1);
    const none = new FormData(); none.append('note', 'just text');
    expect((await j(await fetch(`${base}/files`, { method: 'POST', headers: { 'idempotency-key': k() }, body: none }))).body.error.code).toBe('no_file');
  });
  it('refuses a file over the limit (413) and saves nothing', async () => {
    const big = Buffer.alloc(MAX_UPLOAD + 70 * 1024, 97);
    const r = await j(await upload('name=big.bin', big));
    expect(r.status).toBe(413);
    expect(r.body.error.message).toMatch(/too big. The limit is 25 MB/);
    expect(existsSync(join(ws, 'serve/p-general/uploads/big.bin'))).toBe(false);
  });
  it('an archived project takes no files', async () => {
    const p = createProject({ name: 'Old' });
    const { updateProject } = await import('../src/v2/projects.js');
    updateProject(p.id, { archived: true });
    expect((await j(await upload(`projectId=${p.id}&name=a.txt`, 'x'))).body.error.code).toBe('archived');
  });
  it('GET /files lists what was added to the project, newest first; needs read', async () => {
    await upload('name=one.txt', '1');
    await new Promise((r) => setTimeout(r, 20));
    await upload('name=two.txt', '22');
    const r = await j(await fetch(`${base}/files`));
    expect(r.status).toBe(200);
    expect(r.body.files.map((f: { name: string }) => f.name)).toEqual(['two.txt', 'one.txt']);
    expect(r.body.files[0]).toMatchObject({ id: 'serve/p-general/uploads/two.txt', path: 'serve/p-general/uploads/two.txt', size: 2 });
    expect((await fetch(`${base}/files`, { headers: NET })).status).toBe(401);
    const ro = device(['read']);
    expect((await fetch(`${base}/files`, { headers: as(ro.token) })).status).toBe(200);
  });
  it('firstFilePart reads the first part that is a file', () => {
    const body = Buffer.from('--XX\r\nContent-Disposition: form-data; name="a"\r\n\r\nplain\r\n--XX\r\nContent-Disposition: form-data; name="f"; filename="r.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF\r\nbytes\r\n--XX--\r\n');
    expect(firstFilePart(body, 'multipart/form-data; boundary=XX')).toEqual({ filename: 'r.pdf', data: Buffer.from('%PDF\r\nbytes') });
    expect(firstFilePart(body, 'multipart/form-data')).toBeNull();
    expect(firstFilePart(Buffer.from('--XX--\r\n'), 'multipart/form-data; boundary=XX')).toBeNull();
  });
});

describe('the legacy /api/files routes take the same callers as v1, password or not', () => {
  beforeEach(() => { mkdirSync(join(ws, 'serve/web-1'), { recursive: true }); writeFileSync(join(ws, 'serve/web-1/report.md'), '# Report'); });
  const legacy = (path: string, init: RequestInit = {}) => fetch(`${origin}${path}`, init);
  it('no password: a stranger from the network gets 401 on every route (it used to get everything)', async () => {
    for (const [path, method] of [['/api/files', 'GET'], ['/api/files/raw?path=serve/web-1/report.md', 'GET'], ['/api/files/shares', 'GET'],
      ['/api/files/upload?name=x.txt', 'POST'], ['/api/files/delete', 'POST'], ['/api/files/share', 'POST'], ['/api/files/unshare', 'POST'], ['/api/files/export?path=serve/web-1/report.md&format=html', 'GET']] as const) {
      const r = await legacy(path, { method, headers: { ...NET, 'content-type': 'application/json' }, body: method === 'POST' ? JSON.stringify({ path: 'serve/web-1/report.md' }) : undefined });
      expect(r.status, `${method} ${path}`).toBe(401);
    }
    expect(existsSync(join(ws, 'serve/web-1/report.md'))).toBe(true); // the delete did nothing
    const viaTailscale = await legacy('/api/files', { headers: { 'tailscale-user-login': 'someone@example.com' } });
    expect(viaTailscale.status).toBe(401);
  });
  it('a read-only device may list and read but not upload, delete or share', async () => {
    const ro = device(['read']);
    expect((await legacy('/api/files', { headers: as(ro.token) })).status).toBe(200);
    expect(await (await legacy('/api/files/raw?path=serve/web-1/report.md', { headers: as(ro.token) })).text()).toBe('# Report');
    const up = await legacy('/api/files/upload?name=x.txt&session=web-1', { method: 'POST', headers: as(ro.token), body: 'x' });
    expect(up.status).toBe(403);
    expect(existsSync(join(ws, 'serve/web-1/uploads/x.txt'))).toBe(false);
    expect((await legacy('/api/files/delete', { method: 'POST', headers: as(ro.token), body: JSON.stringify({ path: 'serve/web-1/report.md' }) })).status).toBe(403);
    expect((await legacy('/api/files/share', { method: 'POST', headers: as(ro.token), body: JSON.stringify({ path: 'serve/web-1/report.md' }) })).status).toBe(403);
    expect(existsSync(join(ws, 'serve/web-1/report.md'))).toBe(true);
  });
  it('a device that may act can upload; a revoked one is refused at once', async () => {
    const phone = device(['read', 'act', 'approve']);
    const up = await j(await legacy('/api/files/upload?name=x.txt&session=web-1', { method: 'POST', headers: as(phone.token), body: 'x' }));
    expect(up.status).toBe(200);
    expect(up.body.path).toBe('serve/web-1/uploads/x.txt');
    const { revokeDevice } = await import('../src/api/auth.js');
    revokeDevice(phone.id);
    expect((await legacy('/api/files', { headers: as(phone.token) })).status).toBe(401);
  });
  it('this machine (no password) keeps working, as before', async () => {
    expect((await legacy('/api/files')).status).toBe(200);
    expect((await legacy('/api/files/upload?name=y.txt&session=web-1', { method: 'POST', body: 'y' })).status).toBe(200);
    expect((await legacy('/api/files/upload?name=y.txt&session=web-1', { method: 'POST', headers: { origin: 'http://evil.example' }, body: 'y' })).status).toBe(403);
  });
  it('with a password: nothing without the session, everything with it', async () => {
    mode.passwordSet = true;
    expect((await legacy('/api/files')).status).toBe(401);
    mode.sessionValid = true;
    expect((await legacy('/api/files')).status).toBe(200);
  });
  it('reading needs read, everything else act', () => {
    expect(legacyFilesScope('GET')).toBe('read');
    expect(legacyFilesScope('HEAD')).toBe('read');
    expect(legacyFilesScope('POST')).toBe('act');
  });
});

describe('which pages load signed out (password set): the app shell and /pair', () => {
  it('/pair, the v2 app and the app’s own files load; other pages get the sign-in page; /api never does', () => {
    expect(signedOutPageAllowed('/pair', '', false)).toBe(true);
    expect(signedOutPageAllowed('/pair/', '', false)).toBe(true);
    expect(signedOutPageAllowed('/', '?ui=v2', false)).toBe(true);
    expect(signedOutPageAllowed('/', '?ui=v2&view=settings', false)).toBe(true);
    expect(signedOutPageAllowed('/manifest.webmanifest', '', false)).toBe(true);
    expect(signedOutPageAllowed('/favicon.svg', '', false)).toBe(true);
    expect(signedOutPageAllowed('/', '', false)).toBe(false);
    expect(signedOutPageAllowed('/', '?ui=v1', false)).toBe(false);
    expect(signedOutPageAllowed('/settings', '', false)).toBe(false);
    expect(signedOutPageAllowed('/index.html', '', false)).toBe(false);
    expect(signedOutPageAllowed('/api/status', '?ui=v2', true)).toBe(false);
    expect(signedOutPageAllowed('/api/files', '', true)).toBe(false);
  });
  it('a browser holding a paired device’s cookie gets the app at /', () => {
    expect(signedOutPageAllowed('/', '', true)).toBe(true);
    expect(signedOutPageAllowed('/calendar', '', true)).toBe(true);
    expect(signedOutPageAllowed('/secret.html', '', true)).toBe(false);
  });
});

describe('GET /me and POST /session', () => {
  it('says who is calling, and whether a password is set', async () => {
    expect((await j(await fetch(`${base}/me`))).body).toEqual({ signedIn: true, kind: 'local', deviceId: null, deviceName: null, scopes: ['read', 'act', 'approve', 'admin'], passwordSet: false });
    expect((await j(await fetch(`${base}/me`, { headers: NET }))).body).toMatchObject({ signedIn: false, kind: null, scopes: [], passwordSet: false });
    const phone = device(['read', 'act', 'approve'], 'Robert’s Pixel');
    expect((await j(await fetch(`${base}/me`, { headers: as(phone.token) }))).body).toEqual({ signedIn: true, kind: 'device', deviceId: phone.id, deviceName: 'Robert’s Pixel', scopes: ['read', 'act', 'approve'], passwordSet: false });
    mode.passwordSet = true;
    expect((await j(await fetch(`${base}/me`))).body).toMatchObject({ signedIn: false, passwordSet: true });
  });
  it('the password signs in (an HttpOnly cookie); a wrong one is 401; no password configured is 409', async () => {
    const send = (pw: string, h: Record<string, string> = {}) => fetch(`${base}/session`, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify({ password: pw }) });
    expect((await j(await send('throwaway-pw'))).body.error.code).toBe('no_password');
    mode.passwordSet = true;
    const bad = await j(await send('nope'));
    expect(bad.status).toBe(401); expect(bad.body.error.code).toBe('wrong_password');
    const ok = await j(await send('throwaway-pw'));
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ signedIn: true, kind: 'session', scopes: ['read', 'act', 'approve', 'admin'] });
    // a session of its own (id in the token, a row in app.db); no Secure flag on plain http (W5 review)
    expect(ok.headers.get('set-cookie')).toMatch(/^mwa_session=\d+\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{20,}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=2592000$/);
    expect((await send('throwaway-pw', { origin: 'http://evil.example' })).status).toBe(403); // no login CSRF
  });
  it('wrong passwords slow their source down; rotating X-Forwarded-For does not help; the right password always gets in', async () => {
    mode.passwordSet = true;
    const send = (pw: string, h: Record<string, string> = {}) => fetch(`${base}/session`, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify({ password: pw }) });
    for (let i = 0; i < 12; i++) expect((await send('nope', { 'x-forwarded-for': `10.0.0.${i}` })).status).toBe(401);
    expect(signInGate.failures('127.0.0.1')).toBe(12); // one source: the socket, whatever the header said
    expect(gateWaits.slice(0, 3)).toEqual([250, 500, 1000]);
    expect(Math.max(...gateWaits)).toBe(10_000); // doubling, capped at 10 s
    const ok = await j(await send('throwaway-pw'));
    expect(ok.status).toBe(200); // never refused: it waited, then got in
    expect(pairingGate.failures('127.0.0.1')).toBe(0); // pairing is counted apart
  });
  it('an owner behind a spoofed X-Forwarded-For cannot be locked out, and a junk flood never blocks the right password', async () => {
    mode.passwordSet = true;
    const send = (pw: string, h: Record<string, string> = {}) => fetch(`${base}/session`, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify({ password: pw }) });
    for (let i = 0; i < 60; i++) await send(`junk${i}`, { 'x-forwarded-for': '100.64.0.7' });
    expect((await send('throwaway-pw', { 'x-forwarded-for': '100.64.0.7' })).status).toBe(200);
    expect((await send('throwaway-pw')).status).toBe(200);
    expect(gateWaits.every((w) => w <= 30_000)).toBe(true);
  });
  it('behind a configured trusted proxy, X-Forwarded-For names the source', async () => {
    mode.passwordSet = true;
    process.env.MWA_TRUSTED_PROXY = '127.0.0.1';
    try {
      const send = (pw: string, xff: string) => fetch(`${base}/session`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': xff }, body: JSON.stringify({ password: pw }) });
      for (let i = 0; i < 4; i++) await send('nope', '100.64.0.9');
      expect(signInGate.failures('100.64.0.9')).toBe(4);
      expect(signInGate.failures('127.0.0.1')).toBe(0);
      expect(signInGate.failures('100.64.0.10')).toBe(0);
    } finally { delete process.env.MWA_TRUSTED_PROXY; }
  });
  it('signing out ends the session on the server: the copied cookie stops working', async () => {
    mode.passwordSet = true;
    const r = await fetch(`${base}/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'throwaway-pw' }) });
    const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
    expect((await fetch(`${base}/settings`, { headers: { cookie } })).status).toBe(200);
    const copied = cookie;
    expect((await fetch(`${base}/session`, { method: 'DELETE', headers: { cookie, 'idempotency-key': k() } })).status).toBe(200);
    expect((await fetch(`${base}/settings`, { headers: { cookie: copied } })).status).toBe(401);
    expect((await j(await fetch(`${base}/me`, { headers: { cookie: copied } }))).body.signedIn).toBe(false);
  });
  it('sign out everywhere ends every password session (admin only)', async () => {
    mode.passwordSet = true;
    const signIn = async () => ((await fetch(`${base}/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'throwaway-pw' }) })).headers.get('set-cookie') ?? '').split(';')[0];
    const a = await signIn(), b = await signIn();
    const phone = device(['read', 'act', 'approve']);
    expect((await fetch(`${base}/session/sign-out-everywhere`, { method: 'POST', headers: as(phone.token, { 'idempotency-key': k() }) })).status).toBe(403);
    const r = await j(await fetch(`${base}/session/sign-out-everywhere`, { method: 'POST', headers: { cookie: a, 'idempotency-key': k() } }));
    expect(r.status).toBe(200); expect(r.body.signedOut).toBe(2);
    for (const c of [a, b]) expect((await fetch(`${base}/settings`, { headers: { cookie: c } })).status).toBe(401);
    expect((await fetch(`${base}/settings`, { headers: as(phone.token) })).status).toBe(200);
    await new Promise((res) => setTimeout(res, 5));
    const fresh = await signIn();
    expect((await fetch(`${base}/settings`, { headers: { cookie: fresh } })).status).toBe(200);
  });
  it('DELETE /session clears the cookie for a password session only', async () => {
    mode.passwordSet = true; mode.sessionValid = true;
    const r = await j(await fetch(`${base}/session`, { method: 'DELETE', headers: { 'idempotency-key': k() } }));
    expect(r.status).toBe(200);
    expect(r.headers.get('set-cookie')).toMatch(/^mwa_session=x;.*Max-Age=0/);
    // P2 review fix 7: the browser drops the app's caches and storage (IndexedDB, the outbox) for this helper
    expect(r.headers.get('clear-site-data')).toBe('"cache", "storage"');
    const phone = device(['read']);
    expect((await j(await fetch(`${base}/session`, { method: 'DELETE', headers: as(phone.token, { 'idempotency-key': k() }) }))).body.error.code).toBe('not_a_session');
  });
});

describe('settings', () => {
  const patch = (path: string, body: unknown, h: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: 'PATCH', headers: { 'idempotency-key': k(), 'content-type': 'application/json', ...h }, body: JSON.stringify(body) });
  it('reads the defaults, and saves the helper’s name, the greeting name, the time zone and first run', async () => {
    const r0 = await j(await fetch(`${base}/settings`));
    expect(r0.body).toMatchObject({ helperName: 'Your helper', ownerName: null, ownerNameFixed: false, timeZoneFixed: false, firstRunDone: false });
    expect(r0.body.features.map((f: { id: string }) => f.id)).toEqual(['sorting', 'calendar', 'mail']);
    const r = await j(await patch('/settings', { helperName: '  Juniper  ', ownerName: 'Robert', timeZone: 'Europe/London', firstRunDone: true }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ helperName: 'Juniper', ownerName: 'Robert', timeZone: 'Europe/London', firstRunDone: true });
    expect(process.env.MWA_TZ).toBe('Europe/London'); // applies now, without a restart
    const cfg = JSON.parse(readFileSync(process.env.MWA_CONFIG_PATH!, 'utf8'));
    expect(cfg).toMatchObject({ owner: { name: 'Robert' }, helper: { name: 'Juniper', timeZone: 'Europe/London' } });
    expect(cfg.helper.firstRunDone).toBeUndefined(); // first run lives in app.db (a broken config must not trap the owner in it)
    expect((await j(await patch('/settings', { ownerName: null }))).body.ownerName).toBeNull();
  });
  it('switches mail sorting off and on (the triage reads it at once); the calendar switch cannot be changed here', async () => {
    expect((await j(await patch('/settings', { features: { sorting: false } }))).body.features[0]).toMatchObject({ id: 'sorting', on: false, canChange: true });
    expect(process.env.MWA_TRIAGE).toBe('0');
    expect((await j(await patch('/settings', { features: { sorting: true } }))).body.features[0].on).toBe(true);
    expect((await j(await patch('/settings', { features: { calendar: false } }))).status).toBe(400);
  });
  it('refuses a bad time zone, an empty name, unknown fields — and a setting the deployment fixed', async () => {
    expect((await j(await patch('/settings', { timeZone: 'Mars/Olympus' }))).body.error.code).toBe('bad_time_zone');
    expect((await j(await patch('/settings', { helperName: '   ' }))).body.error.code).toBe('bad_name');
    expect((await j(await patch('/settings', { colour: 'red' }))).body.error.code).toBe('bad_body');
    process.env.MWA_OWNER_NAME = 'Deployed Name'; process.env.MWA_TZ = 'Asia/Tokyo'; captureDeploymentEnv();
    const r = await j(await fetch(`${base}/settings`));
    expect(r.body).toMatchObject({ ownerName: 'Deployed Name', ownerNameFixed: true, timeZone: 'Asia/Tokyo', timeZoneFixed: true });
    expect((await j(await patch('/settings', { ownerName: 'X' }))).body.error.code).toBe('fixed');
    expect((await j(await patch('/settings', { timeZone: 'Europe/Paris' }))).body.error.code).toBe('fixed');
  });
  it('only admin may change settings: a paired phone reads them and gets 403 on a change', async () => {
    const phone = device(['read', 'act', 'approve']);
    expect((await fetch(`${base}/settings`, { headers: as(phone.token) })).status).toBe(200);
    expect((await patch('/settings', { helperName: 'x' }, as(phone.token))).status).toBe(403);
    expect((await patch('/spending', { monthlyUsd: 5 }, as(phone.token))).status).toBe(403);
    expect((await fetch(`${base}/vault`, { headers: as(phone.token) })).status).toBe(403);
    expect((await fetch(`${base}/accounts/google/connect`, { method: 'POST', headers: as(phone.token, { 'idempotency-key': k() }) })).status).toBe(403);
    expect((await fetch(`${base}/accounts`, { headers: as(phone.token) })).status).toBe(200);
  });
  it('applyStoredSettings puts the saved time zone, sorting and per-run limit back at start', async () => {
    writeFileSync(process.env.MWA_CONFIG_PATH!, JSON.stringify({ helper: { timeZone: 'America/Denver', sorting: false, fireCapUsd: 0.4 } }));
    applyStoredSettings();
    expect(process.env.MWA_TZ).toBe('America/Denver');
    expect(process.env.MWA_TRIAGE).toBe('0');
    expect(process.env.MWA_FIRE_CAP_USD).toBe('0.4');
  });
});

describe('spending', () => {
  const patch = (body: unknown) => fetch(`${base}/spending`, { method: 'PATCH', headers: { 'idempotency-key': k(), 'content-type': 'application/json' }, body: JSON.stringify(body) });
  it('this month, the limit, the background line and the defaults per kind', async () => {
    const now = Date.now();
    writeFileSync(process.env.MWA_TOKEN_LOG!, [
      { ts: now - 1000, model: 'm', in: 10, cached: 0, out: 5, reasoning: 0, cost: 0.5, session: 'web-1' },
      { ts: now - 900, model: 'm', in: 10, cached: 0, out: 5, reasoning: 0, cost: 0.02, purpose: 'triage-headers' },
    ].map((x) => JSON.stringify(x)).join('\n') + '\n');
    const r = await j(await fetch(`${base}/spending`));
    expect(r.body.month.usd).toBeCloseTo(0.52);
    expect(r.body.limit).toMatchObject({ usd: null, fixed: false, state: 'none' });
    expect(r.body.background).toEqual([{ purpose: 'triage-headers', label: 'Sorting your mail', usd: 0.02, calls: 1 }]);
    expect(r.body.defaults).toEqual({ handoffMaxUsd: 5, continueMaxUsd: 20, perFireUsd: 0.25, perFireFixed: false });
  });
  it('sets and clears the monthly limit and the per-run limit; refuses nonsense', async () => {
    const r = await j(await patch({ monthlyUsd: 20, perFireUsd: 0.5 }));
    expect(r.status).toBe(200);
    expect(r.body.limit.usd).toBe(20);
    expect(r.body.defaults.perFireUsd).toBe(0.5);
    expect(process.env.MWA_FIRE_CAP_USD).toBe('0.5');
    const cleared = await j(await patch({ monthlyUsd: null, perFireUsd: null }));
    expect(cleared.body.limit.usd).toBeNull();
    expect(cleared.body.defaults.perFireUsd).toBe(0.25);
    expect((await j(await patch({ monthlyUsd: 0.5 }))).body.error.code).toBe('bad_limit');
    expect((await j(await patch({ perFireUsd: 21 }))).body.error.code).toBe('bad_cap');
    // W5 review: rounded first, then at least 1 cent: 0.001 is refused, never "no limit"; 0 means the default
    expect((await j(await patch({ perFireUsd: 0.001 }))).body.error.code).toBe('bad_cap');
    expect((await j(await patch({ perFireUsd: 0.004 }))).body.error.code).toBe('bad_cap');
    expect((await j(await patch({ perFireUsd: 20.004 }))).body.defaults.perFireUsd).toBe(20);
    expect((await j(await patch({ perFireUsd: 0 }))).body.defaults.perFireUsd).toBe(0.25);
    expect(process.env.MWA_FIRE_CAP_USD).toBeUndefined();
    // a refusal saves nothing: the monthly limit is not changed by a request whose per-run limit is refused
    await patch({ monthlyUsd: 20 });
    expect((await j(await patch({ monthlyUsd: 40, perFireUsd: 0.001 }))).status).toBe(400);
    expect((await j(await fetch(`${base}/spending`))).body.limit.usd).toBe(20);
    expect((await j(await patch({ monthlyUsd: '20' }))).body.error.code).toBe('bad_body');
    process.env.MWA_MONTHLY_BUDGET_USD = '30';
    expect((await j(await patch({ monthlyUsd: 10 }))).body.error.code).toBe('fixed');
  });
});

describe('accounts and devices', () => {
  it('lists Google and Outlook with how Connect works here', async () => {
    const r = await j(await fetch(`${base}/accounts`));
    expect(r.body.accounts).toEqual([
      expect.objectContaining({ provider: 'google', connected: true, needsReconnect: false, method: 'app-password', connect: 'setup' }),
      expect.objectContaining({ provider: 'outlook', connected: false, needsReconnect: false, method: null, connect: 'code' }),
    ]);
  });
  it('Connect starts the existing flow: Outlook gives a code; Google without its app needs the setup first', async () => {
    const post = (p: string) => fetch(`${base}/accounts/${p}/connect`, { method: 'POST', headers: { 'idempotency-key': k() } });
    expect((await j(await post('outlook'))).body).toMatchObject({ kind: 'code', provider: 'outlook', code: 'QWER-TY12', url: 'https://microsoft.com/devicelogin', expiresIn: 900 });
    // S3: the setup is Settings › Connections in this app (it was the classic app)
    expect((await j(await post('google'))).body).toMatchObject({ kind: 'setup', provider: 'google', url: '/?view=connections&at=google' });
  });
  it('a failing flow is a 503 the app can retry with the same key', async () => {
    setSettingsRouteDeps({ passwordSet: () => false, checkPassword: () => false,
      connections: () => ({ googleClient: true, gmailAppPassword: false, googleConnected: false, outlookDeviceCode: false, microsoftClient: false, outlookConnected: false }),
      startGoogle: () => { throw new Error('port in use'); } });
    const key1 = k();
    const r = await j(await fetch(`${base}/accounts/google/connect`, { method: 'POST', headers: { 'idempotency-key': key1 } }));
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('provider_unavailable');
  });
  it('renames a device (admin); a removed one cannot be renamed', async () => {
    const phone = device(['read', 'act', 'approve']);
    const rn = (id: string, name: string) => fetch(`${base}/devices/${id}`, { method: 'PATCH', headers: { 'idempotency-key': k(), 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    const r = await j(await rn(phone.id, '  Kitchen\ntablet '));
    expect(r.status).toBe(200);
    expect(r.body.device).toMatchObject({ id: phone.id, name: 'Kitchen tablet' });
    const { revokeDevice } = await import('../src/api/auth.js');
    revokeDevice(phone.id);
    expect((await rn(phone.id, 'x')).status).toBe(404);
  });
});
