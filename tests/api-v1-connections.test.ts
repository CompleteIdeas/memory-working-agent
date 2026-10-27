// v2 build, slice S3: Connections (src/api/routes/connections.ts over src/connection-settings.ts, and the Connect flow in
// src/api/routes/settings.ts) over HTTP with the real caller resolver: who may see and change them; that no app
// password, bot token, client secret or Tailscale key ever comes back (not in a reply, not quoted in a refusal, not in
// the log); the checks on each input; what each disconnect removes; and that the classic page's /api/connections and
// /api/save leave the same settings behind as the v1 routes. No network: Gmail's and Telegram's checks are stubs, the
// .env is a map, the sign-in flows are stubs.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createV1 } from '../src/api/router.js';
import { v1Routes } from '../src/api/v1.js';
import { makeAuthenticate, createPairCode, redeemPairCode } from '../src/api/auth.js';
import { resetAppDb } from '../src/v2/db.js';
import { setSettingsRouteDeps } from '../src/api/routes/settings.js';
import { setConnectionDeps, legacyConnectionAction, legacyConnectionSave, LEGACY_ACTIONS, LEGACY_CONNECTION_WHICH } from '../src/connection-settings.js';

const NET = { 'x-forwarded-for': '100.64.0.7' };
const as = (token: string) => ({ ...NET, authorization: `Bearer ${token}` });
let server: Server, base = '';
let n = 0;
const key = () => `s3-key-${Date.now()}-${++n}`;
const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method, headers: { 'idempotency-key': key(), 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
    .then(async (r) => { const text = await r.text(); return { status: r.status, text, body: (() => { try { return JSON.parse(text); } catch { return null; } })() as any }; });
const get = (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers }).then(async (r) => ({ status: r.status, text: await r.text() }));
const view = async () => JSON.parse((await get('/connections')).text);

// what the stubs saw and what the ".env" holds
const env = new Map<string, string>();
let signedIn = { google: false, outlook: false };
const forgot: string[] = [];
const cancelled: string[] = [];
const hostSet = new Set<string>();
const started: { flow: string; readOnly?: boolean }[] = [];
const APP_PASSWORD = 'abcdefghijklmnop'; // 16 letters
const BAD_APP_PASSWORD = 'badbadbadbadbadx';
const BOT = '123456789:AAH-SUPERSECRETbotTOKEN_0123456789abc';
const BAD_BOT = '987654321:AAH-badSECRETbotTOKEN_0123456789xyz';
const CLIENT_SECRET = 'GOCSPX-SuperSecretClientValue123';
const TS_KEY = 'tskey-auth-kSUPERSECRET123-abcdefghijklmnop';
const SECRETS = [APP_PASSWORD, 'abcd efgh ijkl mnop', BAD_APP_PASSWORD, BOT, BAD_BOT, CLIENT_SECRET, TS_KEY, 'SUPERSECRET'];
const logFile = join(mkdtempSync(join(tmpdir(), 'mwa-s3-log-')), 'mwa.log');
const consoleSeen: string[] = [];

function device(scopes: ('read' | 'act' | 'approve' | 'admin')[]): string {
  const { code } = createPairCode('test', scopes);
  return redeemPairCode(code, 'Pixel', 'android')!.token;
}
function stubs() {
  setConnectionDeps({
    // the stubs quote what they were given, the way a real failure can (Telegram's address holds the token)
    checkGmail: async (a, p) => (p.includes('bad') ? { ok: false, message: `Couldn't reach Gmail: LOGIN failed for ${a} with ${p}` } : { ok: true, message: `Connected ${a}` }),
    checkTelegram: async (t) => (t.includes('bad') ? { ok: false, message: `Telegram failed: request to https://api.telegram.org/bot${t}/getMe failed` } : { ok: true, message: 'Bot @juniper_bot works ✓' }),
    saveEnv: (kv) => { for (const [k, v] of Object.entries(kv)) env.set(k, v); },
    removeEnv: (names) => { for (const k of names) env.delete(k); },
    forgetGoogle: () => { forgot.push('google'); signedIn.google = false; },
    forgetMicrosoft: () => { forgot.push('outlook'); signedIn.outlook = false; },
    env: (name) => env.get(name),
    googleSignedIn: () => signedIn.google,
    outlookSignedIn: () => signedIn.outlook,
    outlookCodeReady: () => env.has('MICROSOFT_CLIENT_ID') || env.has('MWA_DEFAULT_MS_CLIENT_ID'),
    cancelGoogle: () => { cancelled.push('google'); return true; },
    cancelOutlook: () => { cancelled.push('outlook'); return true; },
    fromHost: (n) => hostSet.has(n),
  });
  setSettingsRouteDeps({
    passwordSet: () => false, checkPassword: () => false,
    connections: () => ({
      googleClient: env.has('GOOGLE_CLIENT_ID') && env.has('GOOGLE_CLIENT_SECRET'), gmailAppPassword: env.has('MWA_GMAIL_USER') && env.has('MWA_GMAIL_APP_PASSWORD'),
      googleConnected: signedIn.google || env.has('MWA_GMAIL_USER'), outlookDeviceCode: env.has('MICROSOFT_CLIENT_ID') || env.has('MWA_DEFAULT_MS_CLIENT_ID'),
      microsoftClient: env.has('MICROSOFT_CLIENT_ID'), outlookConnected: signedIn.outlook,
    }),
    startGoogle: (readOnly) => { started.push({ flow: 'google', readOnly }); return 'https://accounts.google.com/o/oauth2/auth?x=1'; },
    startOutlookDeviceCode: async (readOnly) => { started.push({ flow: 'outlook-code', readOnly }); return { user_code: 'QWER-TY12', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900 }; },
    startOutlook: (readOnly) => { started.push({ flow: 'outlook-browser', readOnly }); return 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?x=1'; },
  });
}

const SAVED = { log: process.env.MWA_LOG, hosted: process.env.MWA_HOSTED };
beforeAll(async () => {
  process.env.MWA_LOG = logFile;
  process.env.MWA_HOSTED = '0';
  for (const k of ['log', 'error', 'warn'] as const) {
    const orig = console[k].bind(console);
    vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { consoleSeen.push(a.map(String).join(' ')); orig(...a); });
  }
  const authenticate = makeAuthenticate({ passwordSet: false, sessionValid: () => false });
  const sameOrigin = (req: { headers: Record<string, unknown> }) => !req.headers.origin;
  const v1 = createV1(v1Routes(), { authenticate, sameOrigin: sameOrigin as never });
  server = createServer(async (req, res) => { if (!(await v1(req, res))) { res.writeHead(404); res.end(); } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
});
beforeEach(() => {
  resetAppDb(':memory:');
  env.clear(); forgot.length = 0; started.length = 0; cancelled.length = 0; hostSet.clear();
  signedIn = { google: false, outlook: false };
  stubs();
});
afterAll(() => {
  server?.close(); setConnectionDeps(null); setSettingsRouteDeps(null); vi.restoreAllMocks();
  for (const [k, v] of Object.entries({ MWA_LOG: SAVED.log, MWA_HOSTED: SAVED.hosted })) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

describe('who may see and change connections', () => {
  it('a paired phone reads them but every change is 403; this machine (admin) may change', async () => {
    const phone = device(['read', 'act', 'approve']);
    const r = await get('/connections', as(phone));
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toMatchObject({ google: { connected: false }, outlook: { connected: false }, telegram: { connected: false }, tailscale: { keySaved: false } });
    const changes: [string, string, unknown?][] = [
      ['POST', '/connections/gmail/app-password', { address: 'me@gmail.com', appPassword: APP_PASSWORD }],
      ['PUT', '/connections/google/app', { clientId: '123-abc.apps.googleusercontent.com', clientSecret: CLIENT_SECRET }],
      ['PUT', '/connections/outlook/app', { clientId: '11111111-2222-3333-4444-555555555555' }],
      ['PUT', '/connections/telegram', { token: BOT }], ['PUT', '/connections/tailscale', { authKey: TS_KEY }],
      ['DELETE', '/connections/google'], ['DELETE', '/connections/outlook'], ['DELETE', '/connections/telegram'], ['DELETE', '/connections/tailscale'],
      ['POST', '/accounts/outlook/connect', { method: 'code' }], ['POST', '/accounts/outlook/cancel'],
    ];
    for (const [m, p, b] of changes) {
      const x = await send(m, p, b, as(phone));
      expect(x.status, `${m} ${p}`).toBe(403);
      expect(x.body.error.code).toBe('forbidden');
    }
    expect(env.size).toBe(0);
    expect(forgot).toEqual([]);
    expect(started).toEqual([]);
    expect(cancelled).toEqual([]);
    expect((await send('PUT', '/connections/telegram', { token: BOT }, as(device(['read', 'act', 'approve', 'admin'])))).status).toBe(200);
  });
  it('a stranger from the network gets 401 even for reading', async () => {
    expect((await get('/connections', NET)).status).toBe(401);
  });
  it('a change from another site is refused (cross-origin) and nothing is saved', async () => {
    const r = await send('PUT', '/connections/tailscale', { authKey: TS_KEY }, { origin: 'http://evil.example' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('cross_origin');
    const d = await send('DELETE', '/connections/google', undefined, { origin: 'http://evil.example' });
    expect(d.status).toBe(403);
    expect(env.size).toBe(0);
    expect(forgot).toEqual([]);
  });
});

describe('Gmail with an app password', () => {
  it('checks the sign-in, saves address + password (spaces taken out), and the password never comes back', async () => {
    const r = await send('POST', '/connections/gmail/app-password', { address: ' me@gmail.com ', appPassword: 'abcd efgh ijkl mnop' });
    expect(r.status).toBe(200);
    expect(r.body.message).toMatch(/Connected me@gmail.com.*never send/);
    expect(env.get('MWA_GMAIL_USER')).toBe('me@gmail.com');
    expect(env.get('MWA_GMAIL_APP_PASSWORD')).toBe(APP_PASSWORD);
    expect(r.body.connections.google).toMatchObject({ connected: true, method: 'app-password', address: 'me@gmail.com' });
    expect(r.text).not.toContain(APP_PASSWORD);
    expect((await get('/connections')).text).not.toContain(APP_PASSWORD);
    // the Settings list agrees
    const acc = JSON.parse((await get('/accounts')).text).accounts;
    expect(acc[0]).toMatchObject({ provider: 'google', connected: true, method: 'app-password' });
  });
  it('a refused sign-in is a 400 that never quotes the password, and saves nothing', async () => {
    const r = await send('POST', '/connections/gmail/app-password', { address: 'me@gmail.com', appPassword: BAD_APP_PASSWORD });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('check_failed');
    expect(r.text).not.toContain(BAD_APP_PASSWORD);
    expect(env.size).toBe(0);
  });
  it('checks the inputs first (no network call for a bad one)', async () => {
    for (const [b, code] of [
      [{ address: 'not-an-address', appPassword: APP_PASSWORD }, 'bad_address'],
      [{ address: 'me@gmail.com\nX=1', appPassword: APP_PASSWORD }, 'bad_address'],
      [{ address: 'me@gmail.com', appPassword: 'short' }, 'bad_app_password'],
      [{ address: 'me@gmail.com', appPassword: 'abcdefghijklmnop\nX=1' }, 'bad_app_password'],
      [{ address: 'me@gmail.com', appPassword: '1234567890123456' }, 'bad_app_password'],
      [{ address: 'me@gmail.com' }, 'bad_app_password'],
    ] as const) {
      const r = await send('POST', '/connections/gmail/app-password', b);
      expect(r.status, JSON.stringify(b)).toBe(400);
      expect(r.body.error.code).toBe(code);
    }
    expect(env.size).toBe(0);
  });
});

describe('the sign-in apps', () => {
  it('Google: client ID + secret saved write-only; then sign-in is ready', async () => {
    expect((await view()).google).toMatchObject({ appSaved: false, signIn: 'setup' });
    const r = await send('PUT', '/connections/google/app', { clientId: '123-abc.apps.googleusercontent.com', clientSecret: CLIENT_SECRET });
    expect(r.status).toBe(200);
    expect(r.body.message).toBe('Saved. Now sign in with Google.');
    expect(env.get('GOOGLE_CLIENT_SECRET')).toBe(CLIENT_SECRET);
    expect(r.body.connections.google).toMatchObject({ appSaved: true, signIn: 'ready' });
    expect(r.text).not.toContain(CLIENT_SECRET);
    expect(r.text).not.toContain('123-abc.apps');
    for (const [b, code] of [
      [{ clientId: 'nope', clientSecret: 'x' }, 'bad_client_id'], [{ clientId: '123-abc.apps.googleusercontent.com' }, 'bad_client'],
      [{ clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'a b' }, 'bad_client_secret'],
      [{ clientId: 'x.apps.googleusercontent.com\nEVIL=1', clientSecret: 's' }, 'bad_client'],
    ] as const) expect((await send('PUT', '/connections/google/app', b)).body.error.code, JSON.stringify(b)).toBe(code);
  });
  it('Microsoft: a GUID and an optional tenant name; the code and the browser sign-in then work', async () => {
    const r = await send('PUT', '/connections/outlook/app', { clientId: '11111111-2222-3333-4444-555555555555', tenant: 'contoso.onmicrosoft.com' });
    expect(r.status).toBe(200);
    expect(r.body.message).toMatch(/Saved\. Now connect Outlook\. The tenant is used after your helper restarts\./);
    expect(r.body.connections.outlook).toMatchObject({ appSaved: true, code: true, browser: 'ready', tenant: 'contoso.onmicrosoft.com', redirectUri: 'http://localhost:7798/oauth' });
    for (const [b, code] of [
      [{ clientId: 'not-a-guid' }, 'bad_client_id'], [{}, 'bad_client_id'],
      [{ clientId: '11111111-2222-3333-4444-555555555555', tenant: 'bad tenant/../x' }, 'bad_tenant'],
    ] as const) expect((await send('PUT', '/connections/outlook/app', b)).body.error.code, JSON.stringify(b)).toBe(code);
  });
});

describe('Connect (POST /accounts/{provider}/connect)', () => {
  it('a setup is Settings › Connections in this app, not the classic app', async () => {
    const r = await send('POST', '/accounts/google/connect');
    expect(r.body).toMatchObject({ kind: 'setup', provider: 'google', url: '/?view=connections&at=google' });
    expect(r.body.message).toMatch(/Settings › Connections/);
    expect(r.text).not.toContain('ui=v1');
  });
  it('Outlook: the code or the browser window, read-only passed on; Google: browser only', async () => {
    env.set('MWA_DEFAULT_MS_CLIENT_ID', 'shipped');
    const code = await send('POST', '/accounts/outlook/connect', { method: 'code', readOnly: true });
    expect(code.body).toMatchObject({ kind: 'code', code: 'QWER-TY12', url: 'https://microsoft.com/devicelogin', expiresIn: 900 });
    // the browser window needs your own app
    const nb = await send('POST', '/accounts/outlook/connect', { method: 'browser' });
    expect(nb.body).toMatchObject({ kind: 'setup', url: '/?view=connections&at=outlook' });
    env.set('MICROSOFT_CLIENT_ID', '11111111-2222-3333-4444-555555555555');
    const br = await send('POST', '/accounts/outlook/connect', { method: 'browser' });
    expect(br.body).toMatchObject({ kind: 'browser', provider: 'outlook' });
    env.set('GOOGLE_CLIENT_ID', 'x.apps.googleusercontent.com'); env.set('GOOGLE_CLIENT_SECRET', 's');
    expect((await send('POST', '/accounts/google/connect', { readOnly: true })).body).toMatchObject({ kind: 'browser', provider: 'google' });
    expect(started).toEqual([{ flow: 'outlook-code', readOnly: true }, { flow: 'outlook-browser', readOnly: false }, { flow: 'google', readOnly: true }]);
    expect((await send('POST', '/accounts/google/connect', { method: 'code' })).body.error.code).toBe('bad_method');
    expect((await send('POST', '/accounts/outlook/connect', { method: 'carrier-pigeon' })).body.error.code).toBe('bad_method');
    expect((await send('POST', '/accounts/outlook/connect', { readOnly: 'yes' })).body.error.code).toBe('bad_body');
  });
  it('on a server, sign-in in a browser window is said not to work here', async () => {
    process.env.MWA_HOSTED = '1';
    try {
      env.set('GOOGLE_CLIENT_ID', 'x.apps.googleusercontent.com'); env.set('GOOGLE_CLIENT_SECRET', 's');
      // (on a server, nobody counts as "this machine": a paired device reads it)
      const r = await get('/connections', as(device(['read'])));
      expect(JSON.parse(r.text)).toMatchObject({ hosted: true, google: { signIn: 'server' }, outlook: { browser: 'server' } });
      // review: the server refuses the browser window there too, and the Settings list offers the setup instead
      const admin = as(device(['read', 'act', 'approve', 'admin']));
      env.set('MICROSOFT_CLIENT_ID', '11111111-2222-3333-4444-555555555555');
      for (const [p, b] of [['google', { method: 'browser' }], ['outlook', { method: 'browser' }]] as const) {
        const x = await send('POST', `/accounts/${p}/connect`, b, admin);
        expect(x.status, p).toBe(400);
        expect(x.body.error.code).toBe('browser_not_here');
      }
      expect(started).toEqual([]);
      expect((await send('POST', '/accounts/outlook/connect', { method: 'code' }, admin)).body.kind).toBe('code');
      const acc = JSON.parse((await get('/accounts', admin)).text).accounts;
      expect(acc.map((a: { connect: string }) => a.connect)).toEqual(['setup', 'code']);
      env.delete('MICROSOFT_CLIENT_ID');
      expect(JSON.parse((await get('/accounts', admin)).text).accounts[1].connect).toBe('setup');
    } finally { process.env.MWA_HOSTED = '0'; }
  });
});

describe('Telegram and Tailscale', () => {
  it('Telegram: the token is checked, saved write-only, and a refusal never quotes it', async () => {
    const bad = await send('PUT', '/connections/telegram', { token: BAD_BOT });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('check_failed');
    expect(bad.text).not.toContain(BAD_BOT);
    expect(bad.text).not.toContain('badSECRET');
    expect(env.size).toBe(0);
    const r = await send('PUT', '/connections/telegram', { token: BOT });
    expect(r.status).toBe(200);
    expect(r.body.message).toBe('Your bot @juniper_bot works. Message it on Telegram to talk to your helper.');
    expect(env.get('TELEGRAM_BOT_TOKEN')).toBe(BOT);
    expect(r.body.connections.telegram).toEqual({ connected: true });
    expect(r.text).not.toContain(BOT);
  });
  it('Telegram: a token that is not shaped like one never reaches Telegram (it would change the address called)', async () => {
    for (const t of ['123456789:abc/../../evil', '123456789:AAH-SUPERSECRETbotTOKEN_0123?x=1', 'not a token', '']) {
      const r = await send('PUT', '/connections/telegram', { token: t });
      expect(r.status, t).toBe(400);
      expect(r.body.error.code).toBe('bad_token');
    }
  });
  it('Tailscale: an auth key and a name; an API token, a bad name and a key with spaces are refused', async () => {
    const r = await send('PUT', '/connections/tailscale', { authKey: TS_KEY, hostname: 'Barn-Helper' });
    expect(r.status).toBe(200);
    expect(r.body.message).toMatch(/takes effect after your helper restarts/);
    expect(env.get('TAILSCALE_AUTHKEY')).toBe(TS_KEY);
    expect(env.get('TAILSCALE_HOSTNAME')).toBe('barn-helper');
    expect(r.body.connections.tailscale).toEqual({ keySaved: true, hostname: 'barn-helper' });
    expect(r.text).not.toContain(TS_KEY);
    for (const [b, code] of [
      [{ authKey: 'tskey-api-abc' }, 'bad_auth_key'], [{ authKey: 'nope' }, 'bad_auth_key'], [{ authKey: 'tskey-auth-a b' }, 'bad_auth_key'],
      [{ authKey: TS_KEY, hostname: 'my host!' }, 'bad_hostname'], [{ authKey: TS_KEY, hostname: '-x' }, 'bad_hostname'],
    ] as const) expect((await send('PUT', '/connections/tailscale', b)).body.error.code, JSON.stringify(b)).toBe(code);
  });
});

describe('disconnecting', () => {
  it('Google: the sign-in, the app password and the sign-in app are removed', async () => {
    signedIn.google = true;
    for (const [k, v] of Object.entries({ MWA_GMAIL_USER: 'me@gmail.com', MWA_GMAIL_APP_PASSWORD: APP_PASSWORD, GOOGLE_CLIENT_ID: 'x.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: CLIENT_SECRET, TELEGRAM_BOT_TOKEN: BOT })) env.set(k, v);
    const r = await send('DELETE', '/connections/google');
    expect(r.status).toBe(200);
    expect(r.body.message).toMatch(/Google disconnected/);
    expect(forgot).toEqual(['google']);
    expect([...env.keys()]).toEqual(['TELEGRAM_BOT_TOKEN']);
    expect(r.body.connections.google).toMatchObject({ connected: false, method: null, appSaved: false });
  });
  it('Outlook, Telegram and Tailscale remove only their own', async () => {
    signedIn.outlook = true;
    for (const k of ['MICROSOFT_CLIENT_ID', 'MICROSOFT_TENANT', 'TELEGRAM_BOT_TOKEN', 'TAILSCALE_AUTHKEY', 'TAILSCALE_HOSTNAME', 'GOOGLE_CLIENT_ID']) env.set(k, 'x');
    expect((await send('DELETE', '/connections/outlook')).body.connections.outlook.connected).toBe(false);
    expect(forgot).toEqual(['outlook']);
    expect(env.has('MICROSOFT_CLIENT_ID') || env.has('MICROSOFT_TENANT')).toBe(false);
    expect((await send('DELETE', '/connections/telegram')).body.connections.telegram.connected).toBe(false);
    expect(env.has('TELEGRAM_BOT_TOKEN')).toBe(false);
    const ts = await send('DELETE', '/connections/tailscale');
    expect(ts.body.message).toMatch(/takes effect after a restart/);
    expect([...env.keys()]).toEqual(['GOOGLE_CLIENT_ID']);
    expect((await send('DELETE', '/connections/everything')).status).toBe(404);
  });
});

describe('the classic page and the v1 routes leave the same settings behind', () => {
  const run = async (f: () => Promise<{ ok: boolean; message: string }>) => {
    env.clear(); forgot.length = 0;
    const r = await f();
    return { ok: r.ok, message: r.message, env: Object.fromEntries(env), forgot: [...forgot] };
  };
  const v1 = (m: string, p: string, b?: unknown) => async () => { const r = await send(m, p, b); return { ok: r.status === 200, message: r.status === 200 ? r.body.message : r.body.error.message }; };
  it('the same results, refusals included', async () => {
    const pairs: [Record<string, unknown>, string, string, unknown?][] = [
      [{ action: 'connect-gmail-imap', user: 'me@gmail.com', appPassword: 'abcd efgh ijkl mnop' }, 'POST', '/connections/gmail/app-password', { address: 'me@gmail.com', appPassword: 'abcd efgh ijkl mnop' }],
      [{ action: 'connect-gmail-imap', user: 'me@gmail.com', appPassword: BAD_APP_PASSWORD }, 'POST', '/connections/gmail/app-password', { address: 'me@gmail.com', appPassword: BAD_APP_PASSWORD }],
      [{ action: 'disconnect-gmail' }, 'DELETE', '/connections/google'],
      [{ action: 'disconnect-outlook' }, 'DELETE', '/connections/outlook'],
      [{ action: 'disconnect-telegram' }, 'DELETE', '/connections/telegram'],
      [{ which: 'telegram', TELEGRAM_BOT_TOKEN: BOT }, 'PUT', '/connections/telegram', { token: BOT }],
      [{ which: 'telegram', TELEGRAM_BOT_TOKEN: BAD_BOT }, 'PUT', '/connections/telegram', { token: BAD_BOT }],
      [{ which: 'google', GOOGLE_CLIENT_ID: '123-abc.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: CLIENT_SECRET }, 'PUT', '/connections/google/app', { clientId: '123-abc.apps.googleusercontent.com', clientSecret: CLIENT_SECRET }],
      [{ which: 'google', GOOGLE_CLIENT_ID: 'nope', GOOGLE_CLIENT_SECRET: CLIENT_SECRET }, 'PUT', '/connections/google/app', { clientId: 'nope', clientSecret: CLIENT_SECRET }],
      [{ which: 'microsoft', MICROSOFT_CLIENT_ID: '11111111-2222-3333-4444-555555555555', MICROSOFT_TENANT: 'common' }, 'PUT', '/connections/outlook/app', { clientId: '11111111-2222-3333-4444-555555555555', tenant: 'common' }],
      [{ which: 'tailscale', key: TS_KEY, hostname: 'mwa' }, 'PUT', '/connections/tailscale', { authKey: TS_KEY, hostname: 'mwa' }],
      [{ which: 'tailscale', TAILSCALE_AUTHKEY: 'tskey-api-x' }, 'PUT', '/connections/tailscale', { authKey: 'tskey-api-x' }],
    ];
    for (const [legacy, m, p, b] of pairs) {
      const fn = legacy.action ? legacyConnectionAction : legacyConnectionSave;
      const before = () => { signedIn = { google: true, outlook: true }; };
      before(); const a = await run(() => fn(legacy));
      before(); const c = await run(v1(m, p, b));
      expect(c, JSON.stringify(legacy)).toEqual(a);
    }
    expect([...LEGACY_ACTIONS].sort()).toEqual(['connect-gmail-imap', 'disconnect-gmail', 'disconnect-outlook', 'disconnect-telegram']);
    expect([...LEGACY_CONNECTION_WHICH].sort()).toEqual(['google', 'microsoft', 'tailscale', 'telegram']);
  });
});

describe('no secret anywhere it could leak', () => {
  it('the log and the console never hold an app password, bot token, client secret or Tailscale key', async () => {
    await send('POST', '/connections/gmail/app-password', { address: 'me@gmail.com', appPassword: APP_PASSWORD });
    await send('POST', '/connections/gmail/app-password', { address: 'me@gmail.com', appPassword: BAD_APP_PASSWORD });
    await send('PUT', '/connections/telegram', { token: BOT });
    await send('PUT', '/connections/telegram', { token: BAD_BOT });
    await send('PUT', '/connections/google/app', { clientId: '123-abc.apps.googleusercontent.com', clientSecret: CLIENT_SECRET });
    await send('PUT', '/connections/tailscale', { authKey: TS_KEY });
    const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
    expect(log).toMatch(/connections/); // the changes were logged…
    const all = log + consoleSeen.join('\n');
    for (const s of SECRETS) expect(all, s).not.toContain(s); // …without their values
    const v = (await get('/connections')).text;
    for (const s of SECRETS) expect(v).not.toContain(s);
  });
});

describe('review fixes', () => {
  it('Cancel stops a waiting sign-in (admin); disconnecting stops one too', async () => {
    const c = await send('POST', '/accounts/outlook/cancel');
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ cancelled: true });
    expect((await send('POST', '/accounts/nope/cancel')).status).toBe(404);
    cancelled.length = 0;
    await send('DELETE', '/connections/outlook');
    await send('DELETE', '/connections/google');
    expect(cancelled).toEqual(['outlook', 'google']);
    // the classic page's disconnect too
    cancelled.length = 0;
    await legacyConnectionAction({ action: 'disconnect-outlook' });
    expect(cancelled).toEqual(['outlook']);
  });
  it('Tailscale: the name alone can change (the key kept), and an empty name goes back to the default, on both paths', async () => {
    expect((await send('PUT', '/connections/tailscale', { hostname: 'barn' })).body.error.code).toBe('bad_auth_key'); // no key saved yet
    await send('PUT', '/connections/tailscale', { authKey: TS_KEY, hostname: 'barn' });
    const r = await send('PUT', '/connections/tailscale', { hostname: 'stable' });
    expect(r.status).toBe(200);
    expect(r.body.message).toBe('Saved. The name stable takes effect after your helper restarts.');
    expect(env.get('TAILSCALE_AUTHKEY')).toBe(TS_KEY);
    const c = await send('PUT', '/connections/tailscale', { hostname: '' });
    expect(c.body.message).toMatch(/The name mwa \(the default\) takes effect after your helper restarts/);
    expect(env.has('TAILSCALE_HOSTNAME')).toBe(false);
    expect(c.body.connections.tailscale).toEqual({ keySaved: true, hostname: null });
    expect((await send('PUT', '/connections/tailscale', {})).body.error.code).toBe('bad_auth_key'); // nothing to change
    env.set('TAILSCALE_HOSTNAME', 'barn');
    const l = await legacyConnectionSave({ which: 'tailscale', key: TS_KEY, hostname: '' });
    expect(l.ok).toBe(true);
    expect(env.has('TAILSCALE_HOSTNAME')).toBe(false);
    env.set('TAILSCALE_HOSTNAME', 'barn');
    await legacyConnectionSave({ which: 'tailscale', key: TS_KEY }); // no name given: kept
    expect(env.get('TAILSCALE_HOSTNAME')).toBe('barn');
  });
  it('saving or removing the Tailscale key says it takes effect after a restart', async () => {
    expect((await send('PUT', '/connections/tailscale', { authKey: TS_KEY })).body.message).toMatch(/takes effect after your helper restarts/);
    expect((await send('DELETE', '/connections/tailscale')).body.message).toBe('Tailscale key removed. It takes effect after a restart: until then your helper stays on your tailnet.');
  });
  it('a disconnected value the host also sets says it comes back after a restart unless removed there', async () => {
    env.set('TELEGRAM_BOT_TOKEN', BOT); hostSet.add('TELEGRAM_BOT_TOKEN');
    const r = await send('DELETE', '/connections/telegram');
    expect(r.body.message).toBe('Telegram disconnected. TELEGRAM_BOT_TOKEN is also set in your server’s own settings (for example a Railway variable), so it comes back when your helper restarts. Remove it there too.');
    expect(r.text).not.toContain(BOT);
    hostSet.add('TAILSCALE_AUTHKEY'); hostSet.add('TAILSCALE_HOSTNAME');
    expect((await send('DELETE', '/connections/tailscale')).body.message).toMatch(/TAILSCALE_AUTHKEY and TAILSCALE_HOSTNAME are also set .* they come back/);
    expect((await send('DELETE', '/connections/outlook')).body.message).toBe('Outlook disconnected. Its sign-in was removed from your helper.'); // nothing from the host
  });
});
