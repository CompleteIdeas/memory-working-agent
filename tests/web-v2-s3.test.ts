// v2 build, slice S3: Settings › Connections in fixture mode (web/src/v2/dev/fixtures-connections.ts) answers with the
// contract's shapes and the server's rules (who may change what, secrets never sent back, the input checks, Connect
// landing on this screen instead of the classic app), the Settings list agrees with it, and the page's words
// (screens/settings/useConnections.ts) say what stops working before a disconnect. The page itself runs in the
// browser: scripts/v2-s3-smoke.mjs.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { FixtureServer } from '../web/src/v2/dev/fixtures';
import {
  browserNote, codeLeft, disconnectWarning, googleLine, openConnectionsAt, outlookLine, providerOfAccount, tailscaleLine, takeConnectionsAt,
} from '../web/src/v2/screens/settings/useConnections';
import type { Connections } from '../web/src/v2/api/client';

const spec = parse(readFileSync(new URL('../api/openapi.yaml', import.meta.url), 'utf8'));
const ajv = new (Ajv2020 as unknown as typeof Ajv2020.default)({ strict: false, allErrors: true });
(addFormats as unknown as typeof addFormats.default)(ajv);
ajv.addSchema({ $id: 'spec', components: spec.components });
function valid(path: string, method: string, res: { status: number; body: unknown }) {
  const op = spec.paths[path][method];
  const r = op.responses[String(res.status)] ?? op.responses.default;
  const resolved = r.$ref ? spec.components.responses[r.$ref.split('/').pop()] : r;
  const fn = ajv.compile(JSON.parse(JSON.stringify(resolved.content['application/json'].schema).replace(/"#\/components\//g, '"spec#/components/')));
  expect(fn(res.body) ? null : `${method.toUpperCase()} ${path} ${res.status}: ${ajv.errorsText(fn.errors)}`).toBeNull();
  return res as { status: number; body: any };
}
const H = { 'x-mwa-client': 'web/1.0.0' };
let k = 0;
const call = (s: FixtureServer, method: string, path: string, body?: unknown) =>
  s.handle({ method, path, query: new URLSearchParams(), headers: { ...H, 'idempotency-key': `s3-key-${++k}` }, body });
const get = (s: FixtureServer, path: string) => s.handle({ method: 'GET', path, query: new URLSearchParams(), headers: H, body: undefined });
const PASSWORD = 'abcd efgh ijkl mnop';
const TOKEN = '123456789:AAHexampleTOKENexampleTOKEN0123456';
const SECRET = 'GOCSPX-typedInFixture';
const TS = 'tskey-auth-typedInFixture123';

describe('S3 fixture mode answers like the server', () => {
  it('the connections, every change and its refusals have the contract\'s shapes; no secret comes back', () => {
    const s = new FixtureServer('N00');
    const c = valid('/connections', 'get', get(s, '/connections')).body as Connections;
    expect(c).toMatchObject({ google: { connected: true, method: 'sign-in', appSaved: true, signIn: 'ready' }, outlook: { connected: false, code: true }, telegram: { connected: false }, tailscale: { keySaved: true } });
    const tg = valid('/connections/telegram', 'put', call(s, 'PUT', '/connections/telegram', { token: TOKEN }));
    expect(tg.body.connections.telegram.connected).toBe(true);
    expect(valid('/connections/telegram', 'put', call(s, 'PUT', '/connections/telegram', { token: '123456789:AAHbadTOKENexampleTOKEN01234567' })).body.error.code).toBe('check_failed');
    expect(valid('/connections/telegram', 'put', call(s, 'PUT', '/connections/telegram', { token: 'nope' })).body.error.code).toBe('bad_token');
    const ga = valid('/connections/google/app', 'put', call(s, 'PUT', '/connections/google/app', { clientId: '123-abc.apps.googleusercontent.com', clientSecret: SECRET }));
    expect(ga.body.message).toBe('Saved. Now sign in with Google.');
    expect(valid('/connections/google/app', 'put', call(s, 'PUT', '/connections/google/app', { clientId: 'nope', clientSecret: 'x' })).body.error.code).toBe('bad_client_id');
    expect(valid('/connections/outlook/app', 'put', call(s, 'PUT', '/connections/outlook/app', { clientId: '11111111-2222-3333-4444-555555555555', tenant: 'common' })).body.connections.outlook).toMatchObject({ appSaved: true, browser: 'ready', tenant: 'common' });
    expect(valid('/connections/outlook/app', 'put', call(s, 'PUT', '/connections/outlook/app', { clientId: 'nope' })).body.error.code).toBe('bad_client_id');
    const ts = valid('/connections/tailscale', 'put', call(s, 'PUT', '/connections/tailscale', { authKey: TS, hostname: 'Barn' }));
    expect(ts.body.connections.tailscale).toEqual({ keySaved: true, hostname: 'barn' });
    expect(valid('/connections/tailscale', 'put', call(s, 'PUT', '/connections/tailscale', { authKey: 'tskey-api-x' })).body.error.code).toBe('bad_auth_key');
    const off = valid('/connections/{service}', 'delete', call(s, 'DELETE', '/connections/google'));
    expect(off.body.connections.google).toMatchObject({ connected: false, appSaved: false });
    const gm = valid('/connections/gmail/app-password', 'post', call(s, 'POST', '/connections/gmail/app-password', { address: 'me@gmail.com', appPassword: PASSWORD }));
    expect(gm.body.connections.google).toMatchObject({ connected: true, method: 'app-password', address: 'me@gmail.com' });
    expect(valid('/connections/gmail/app-password', 'post', call(s, 'POST', '/connections/gmail/app-password', { address: 'me@gmail.com', appPassword: 'badbadbadbadbadx' })).body.error.code).toBe('check_failed');
    expect(valid('/connections/{service}', 'delete', call(s, 'DELETE', '/connections/nope')).status).toBe(404);
    const all = JSON.stringify([tg.body, ga.body, ts.body, gm.body, get(s, '/connections').body]);
    for (const x of [PASSWORD, PASSWORD.replace(/ /g, ''), TOKEN, SECRET, TS]) expect(all).not.toContain(x);
  });
  it('the Settings list (/accounts) is read from the same state', () => {
    const s = new FixtureServer('N00');
    call(s, 'DELETE', '/connections/google');
    expect(valid('/accounts', 'get', get(s, '/accounts')).body.accounts[0]).toMatchObject({ provider: 'google', connected: false, connect: 'setup' });
    call(s, 'POST', '/connections/gmail/app-password', { address: 'me@gmail.com', appPassword: PASSWORD });
    expect(get(s, '/accounts').body).toMatchObject({ accounts: [{ provider: 'google', connected: true, method: 'app-password' }, { provider: 'outlook' }] });
  });
  it('Connect: a setup lands on this screen (never the classic app); Outlook\'s code or browser window', () => {
    const s = new FixtureServer('conn-setup');
    const g = valid('/accounts/{provider}/connect', 'post', call(s, 'POST', '/accounts/google/connect'));
    expect(g.body).toMatchObject({ kind: 'setup', url: '/?view=connections&at=google' });
    expect(JSON.stringify(g.body)).not.toContain('ui=v1');
    expect(valid('/accounts/{provider}/connect', 'post', call(s, 'POST', '/accounts/outlook/connect', { method: 'code' })).body).toMatchObject({ kind: 'setup', url: '/?view=connections&at=outlook' });
    const n = new FixtureServer('N00');
    expect(valid('/accounts/{provider}/connect', 'post', call(n, 'POST', '/accounts/outlook/connect', { method: 'code', readOnly: true })).body).toMatchObject({ kind: 'code', code: 'QWER-TY12' });
    expect(valid('/accounts/{provider}/connect', 'post', call(n, 'POST', '/accounts/google/connect', { method: 'code' })).body.error.code).toBe('bad_method');
    expect(get(n, '/connections').body.outlook.connected).toBe(true);
  });
  it('scenarios: reconnect, hosted', () => {
    expect(get(new FixtureServer('reconnect'), '/connections').body.google.needsReconnect).toBe(true);
    const h = valid('/connections', 'get', get(new FixtureServer('hosted'), '/connections')).body as Connections;
    expect(h).toMatchObject({ hosted: true, host: 'Railway', google: { signIn: 'server', method: 'app-password' }, outlook: { browser: 'server', code: true } });
  });
  it('a paired phone reads them, and every change is 403', () => {
    const s = new FixtureServer('phone');
    expect(get(s, '/connections').status).toBe(200);
    for (const [m, p, b] of [['PUT', '/connections/telegram', { token: TOKEN }], ['DELETE', '/connections/google'], ['POST', '/connections/gmail/app-password', {}], ['PUT', '/connections/tailscale', { authKey: TS }], ['POST', '/accounts/outlook/connect']] as const) {
      expect(call(s, m, p, b).status, `${m} ${p}`).toBe(403);
    }
  });
});

describe('S3 words', () => {
  const base = (): Connections => new FixtureServer('N00').handle({ method: 'GET', path: '/connections', query: new URLSearchParams(), headers: H, body: undefined }).body as Connections;
  it('says how each account is connected, and what a reconnect means', () => {
    const c = base();
    expect(googleLine(c)).toMatch(/^Connected with Google sign-in: Gmail and Google Calendar.*never send/);
    expect(googleLine({ ...c, google: { ...c.google, method: 'app-password', address: 'me@gmail.com', connected: true } })).toMatch(/app password \(me@gmail.com\): Gmail only.*Calendar needs Google sign-in/);
    expect(googleLine({ ...c, google: { ...c.google, needsReconnect: true } })).toMatch(/stopped working/);
    expect(outlookLine(c)).toBe('Not connected.');
    expect(tailscaleLine(c)).toMatch(/Key saved\. Name on your tailnet: mwa/);
  });
  it('a disconnect says what stops working first', () => {
    const c = base();
    expect(disconnectWarning('google', c)).toMatch(/stop sorting your mail.*Google events leave Today and the Calendar.*sign-in app is removed too/);
    expect(disconnectWarning('google', { ...c, google: { ...c.google, method: 'app-password', appSaved: false } })).not.toMatch(/Calendar|sign-in app/);
    expect(disconnectWarning('outlook', c)).toMatch(/Outlook events leave Today and the Calendar/);
    expect(disconnectWarning('telegram', c)).toMatch(/stop answering you on Telegram/);
    expect(disconnectWarning('tailscale', c)).toMatch(/leaves your tailnet/);
  });
  it('why a browser sign-in isn\'t offered', () => {
    expect(browserNote('ready', 'google', 'Railway')).toBeNull();
    expect(browserNote('server', 'google', 'Railway')).toMatch(/can’t work on your Railway server\. Use an app password/);
    expect(browserNote('setup', 'google', 'x')).toMatch(/own Google sign-in app first/);
    expect(browserNote('server', 'outlook', 'Railway')).toMatch(/Use the code instead/);
  });
  it('the code\'s time left', () => {
    expect(codeLeft(1_000 + 15 * 60_000, 1_000)).toBe('This code works for 15 more minutes.');
    expect(codeLeft(1_000 + 30_000, 1_000)).toBe('This code works for about 1 more minute.');
    expect(codeLeft(1_000, 2_000)).toMatch(/run out/);
  });
  it('where a link lands: asked in the app first, then ?at=, once', () => {
    expect(providerOfAccount('google:robert@gmail.com')).toBe('google');
    expect(providerOfAccount('outlook:robert@outlook.com')).toBe('outlook');
    expect(providerOfAccount('gmail')).toBe('google');
    expect(providerOfAccount(null)).toBeNull();
    openConnectionsAt('outlook');
    expect(takeConnectionsAt('?view=connections&at=google')).toBe('outlook');
    expect(takeConnectionsAt('?view=connections&at=google')).toBe('google');
    expect(takeConnectionsAt('?view=connections&at=evil')).toBeNull();
    expect(takeConnectionsAt('')).toBeNull();
  });
});
