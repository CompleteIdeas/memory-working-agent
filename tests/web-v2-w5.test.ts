// v2 build, slice W5: fixture mode for sign-in, pairing, first run and Settings (web/src/v2/dev/fixtures-settings.ts)
// answers with the contract's shapes — every response validated against api/openapi.yaml — and behaves like the
// server (who may do what, refusals in its words); Settings' data layer (screens/settings/useSettings.ts) and its
// words; the store's resume/signedOut; and the screens rendered in node (react-dom/server). Interactions run in the
// browser: scripts/v2-w5-smoke.mjs.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { createElement as h, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FixtureServer, fixtureFetch } from '../web/src/v2/dev/fixtures';
import { FIXTURE_PAIR_CODE, FIXTURE_PASSWORD } from '../web/src/v2/dev/fixtures-settings';
import { FIXTURE_NOW } from '../web/src/v2/dev/fixture-data';
import { MwaClient, type Device, type Spending, type Account } from '../web/src/v2/api/client';
import { V2Store, type StoreState } from '../web/src/v2/store/core';
import { MemoryCache } from '../web/src/v2/store/cache';
import { StoreProvider } from '../web/src/v2/store/react';
import {
  loadSettingsData, isAdmin, money, spendLine, backgroundLine, lastUsed, accountLine, activeDevices, guessDeviceName, guessPlatform, normalizeCode, codeFromHash,
} from '../web/src/v2/screens/settings/useSettings';
import { timeLeft, PairCodeCard } from '../web/src/v2/screens/settings/PairNewDevice';
import { SignInScreen, PairScreen, isPairLocation } from '../web/src/v2/screens/start/Start';
import { chooseUi } from '../web/src/v2/choose';

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
  return res;
}
const H = { 'x-mwa-client': 'web/1.0.0' };
let k = 0;
const call = (s: FixtureServer, method: string, path: string, body?: unknown, q = '') =>
  s.handle({ method, path, query: new URLSearchParams(q), headers: { ...H, 'idempotency-key': `w5-key-${++k}` }, body });
const get = (s: FixtureServer, path: string, q = '') => s.handle({ method: 'GET', path, query: new URLSearchParams(q), headers: H, body: undefined });

describe('W5 fixture mode answers with the contract\'s shapes', () => {
  it('every read Settings and the start screens use, in every scenario', () => {
    for (const sc of ['N00', 'first-run', 'phone']) {
      const s = new FixtureServer(sc);
      valid('/me', 'get', get(s, '/me'));
      valid('/settings', 'get', get(s, '/settings'));
      valid('/spending', 'get', get(s, '/spending'));
      valid('/accounts', 'get', get(s, '/accounts'));
      valid('/files', 'get', get(s, '/files', 'projectId=eventing'));
      if (sc !== 'phone') { valid('/devices', 'get', get(s, '/devices')); valid('/vault', 'get', get(s, '/vault')); }
    }
    for (const sc of ['signed-out', 'unpaired']) valid('/me', 'get', get(new FixtureServer(sc), '/me'));
  });
  it('every write, and its refusals', () => {
    const s = new FixtureServer('N00');
    valid('/pair/codes', 'post', call(s, 'POST', '/pair/codes'));
    valid('/devices/{id}', 'patch', call(s, 'PATCH', '/devices/dev_pixel', { name: 'Pixel 9' }));
    valid('/devices/{id}', 'patch', call(s, 'PATCH', '/devices/dev_pixel', { name: ' ' }));
    valid('/devices/{id}', 'delete', call(s, 'DELETE', '/devices/dev_ipad'));
    valid('/devices/{id}', 'delete', call(s, 'DELETE', '/devices/dev_ipad'));
    valid('/settings', 'patch', call(s, 'PATCH', '/settings', { helperName: 'Juniper', ownerName: 'Robert', timeZone: 'Europe/London', features: { sorting: false } }));
    valid('/settings', 'patch', call(s, 'PATCH', '/settings', { timeZone: 'Mars/Olympus' }));
    valid('/spending', 'patch', call(s, 'PATCH', '/spending', { monthlyUsd: 30, perFireUsd: 0.5 }));
    valid('/spending', 'patch', call(s, 'PATCH', '/spending', { monthlyUsd: 0.2 }));
    valid('/accounts/{provider}/connect', 'post', call(s, 'POST', '/accounts/outlook/connect'));
    valid('/accounts/{provider}/connect', 'post', call(s, 'POST', '/accounts/google/connect'));
    valid('/vault/forget', 'post', call(s, 'POST', '/vault/forget', { name: 'USEF' }));
    valid('/vault/forget', 'post', call(s, 'POST', '/vault/forget', { name: 'USEF' }));
    valid('/files', 'post', call(s, 'POST', '/files', undefined, 'projectId=eventing&name=../notes.pdf'));
    valid('/session', 'delete', call(s, 'DELETE', '/session'));
  });
  it('signed out: 401 everywhere but the public routes; the password signs in; a wrong one is 401 in the server\'s words', () => {
    const s = new FixtureServer('signed-out');
    expect(get(s, '/meta').status).toBe(200);
    expect(get(s, '/sync').status).toBe(401);
    expect(get(s, '/settings').status).toBe(401);
    expect(get(s, '/me').body).toMatchObject({ signedIn: false, passwordSet: true });
    const bad = valid('/session', 'post', s.handle({ method: 'POST', path: '/session', query: new URLSearchParams(), headers: H, body: { password: 'nope' } }));
    expect(bad).toMatchObject({ status: 401, body: { error: { code: 'wrong_password', message: 'That password isn’t right. Try again.' } } });
    const ok = valid('/session', 'post', s.handle({ method: 'POST', path: '/session', query: new URLSearchParams(), headers: H, body: { password: FIXTURE_PASSWORD } }));
    expect(ok.status).toBe(200);
    expect(get(s, '/sync').status).toBe(200);
  });
  it('a phone with no password pairs with a code, once; then it is a device without admin', () => {
    const s = new FixtureServer('unpaired');
    expect(get(s, '/me').body).toMatchObject({ signedIn: false, passwordSet: false });
    const pair = (code: string) => s.handle({ method: 'POST', path: '/pair', query: new URLSearchParams(), headers: H, body: { code, name: 'Robert’s Pixel' } });
    expect(valid('/pair', 'post', pair('AAAA-AAAA')).body).toMatchObject({ error: { code: 'pair_code_invalid' } });
    expect(valid('/pair', 'post', pair(FIXTURE_PAIR_CODE.toLowerCase())).status).toBe(201);
    expect(pair(FIXTURE_PAIR_CODE).status).toBe(400); // spent
    expect(get(s, '/me').body).toMatchObject({ signedIn: true, kind: 'device', deviceName: 'Robert’s Pixel', scopes: ['read', 'act', 'approve'] });
    expect(get(s, '/devices').status).toBe(403);
    expect(call(s, 'PATCH', '/settings', { helperName: 'x' }).status).toBe(403);
    expect(get(s, '/settings').status).toBe(200);
    expect(valid('/devices/me/sign-out', 'post', call(s, 'POST', '/devices/me/sign-out')).status).toBe(200);
    expect(get(s, '/sync').status).toBe(401);
  });
  it('a code made on the computer pairs a phone', () => {
    const s = new FixtureServer('N00');
    const code = (call(s, 'POST', '/pair/codes').body as { code: string }).code;
    expect(s.handle({ method: 'POST', path: '/pair', query: new URLSearchParams(), headers: H, body: { code } }).status).toBe(201);
  });
});

describe('Settings\' data and words', () => {
  it('loads everything for admin, and leaves the admin parts out for a phone', async () => {
    const admin = await loadSettingsData(new MwaClient({ fetch: fixtureFetch(new FixtureServer('N00')) }));
    expect(isAdmin(admin.me)).toBe(true);
    expect(admin.devices?.length).toBe(3);
    expect(admin.vault?.length).toBe(2);
    expect(admin.settings?.helperName).toBe('Juniper');
    const phone = await loadSettingsData(new MwaClient({ fetch: fixtureFetch(new FixtureServer('phone')) }));
    expect(isAdmin(phone.me)).toBe(false);
    expect(phone.devices).toBeNull();
    expect(phone.vault).toBeNull();
    expect(phone.me?.deviceId).toBe('dev_pixel');
  });
  it('says money, spending and the background line plainly', () => {
    expect(money(0.25)).toBe('25¢'); expect(money(5)).toBe('$5'); expect(money(1.5)).toBe('$1.50');
    const s: Spending = { month: { label: 'November 2026', usd: 1.29, calls: 1 }, limit: { usd: 20, fixed: false, state: 'ok', pct: 6 }, background: [{ purpose: 'triage-headers', label: 'Sorting your mail', usd: 0.31, calls: 4 }], defaults: { handoffMaxUsd: 5, continueMaxUsd: 20, perFireUsd: 0.25, perFireFixed: false } };
    expect(spendLine(s)).toBe('$1.29 of your $20 limit');
    expect(spendLine({ ...s, limit: { ...s.limit, usd: null } })).toBe('$1.29 so far · no monthly limit');
    expect(backgroundLine(s)).toBe('In the background: sorting your mail 31¢');
    expect(backgroundLine({ ...s, background: [] })).toBeNull();
  });
  it('says when a device was used, which is this one, and what an account needs', () => {
    const now = FIXTURE_NOW;
    expect(lastUsed(now - 30_000, now)).toBe('Used just now');
    expect(lastUsed(now - 10 * 60_000, now)).toBe('Used 10 minutes ago');
    expect(lastUsed(now - 3 * 3_600_000, now)).toBe('Used 3 hours ago');
    expect(lastUsed(now - 26 * 3_600_000, now)).toBe('Used yesterday');
    expect(lastUsed(null, now)).toBe('Not used yet');
    const d = (id: string, lastSeen: number, revokedAt: number | null = null): Device => ({ id, name: id, platform: null, scopes: [], createdAt: 0, lastSeen, revokedAt });
    expect(activeDevices([d('a', 5), d('b', 9), d('me', 1), d('gone', 10, 3)], 'me').map((x) => x.id)).toEqual(['me', 'b', 'a']);
    const a: Account = { provider: 'google', label: 'Google', what: 'Calendar and Gmail.', connected: true, needsReconnect: true, method: 'sign-in', connect: 'browser' };
    expect(accountLine(a)).toMatch(/^The sign-in stopped working/);
    expect(accountLine({ ...a, needsReconnect: false })).toBe('Calendar and Gmail.');
    expect(accountLine({ ...a, connected: false, needsReconnect: false })).toBe('Not connected.');
  });
  it('reads a pairing code typed or from the link, and names the phone', () => {
    expect(normalizeCode('k7pq m4xz')).toBe('K7PQ-M4XZ');
    expect(normalizeCode('K7PQ-M4X')).toBeNull();
    expect(codeFromHash('#c=K7PQ-M4XZ')).toBe('K7PQ-M4XZ');
    expect(codeFromHash('#x=1&c=k7pqm4xz')).toBe('K7PQ-M4XZ');
    expect(codeFromHash('#nothing')).toBeNull();
    expect(guessDeviceName('Mozilla/5.0 (Linux; Android 14; Pixel 9) Mobile Safari')).toBe('Android phone');
    expect(guessDeviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)')).toBe('iPhone');
    expect(guessPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)')).toBe('ios');
    expect(timeLeft(FIXTURE_NOW + 9 * 60_000 + 41_000, FIXTURE_NOW)).toBe('9:41');
    expect(timeLeft(FIXTURE_NOW - 1, FIXTURE_NOW)).toBe('expired');
  });
  it('the pairing link opens the v2 app, even on a phone that never chose it', () => {
    expect(chooseUi('', null, '/pair')).toBe('v2');
    expect(chooseUi('', 'v1', '/pair/')).toBe('v2');
    expect(chooseUi('', null, '/')).toBe('v1');
    expect(isPairLocation({ pathname: '/pair', search: '' })).toBe(true);
    expect(isPairLocation({ pathname: '/', search: '?view=pair' })).toBe(true);
    expect(isPairLocation({ pathname: '/', search: '?view=settings' })).toBe(false);
  });
});

describe('the store after sign-in and sign-out', () => {
  it('resume() forgets the 401 and catches up; signedOut() shows the sign-in screens', async () => {
    const fx = new FixtureServer('signed-out');
    const store = new V2Store({ client: new MwaClient({ fetch: fixtureFetch(fx) }), cache: new MemoryCache(), stream: () => ({ readyState: 1, addEventListener() {}, onerror: null, close() {} }), now: () => FIXTURE_NOW, fixtures: true,
      env: { online: () => true, visible: () => true, on: () => () => {}, setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t as never) } });
    await store.start();
    expect(store.getState().auth).toBe('signin');
    await store.client.signIn(FIXTURE_PASSWORD);
    await store.resume();
    expect(store.getState().auth).toBe('ok');
    expect(Object.keys(store.getState().jobs).length).toBeGreaterThan(0);
    store.signedOut();
    expect(store.getState().auth).toBe('signin');
    store.stop();
  });
});

describe('the start screens and the pairing card, rendered', () => {
  const store = () => {
    const s = new V2Store({ client: new MwaClient({ fetch: fixtureFetch(new FixtureServer('N00')) }), cache: new MemoryCache(), stream: () => { throw new Error('no stream'); }, now: () => FIXTURE_NOW, fixtures: true });
    (s as unknown as { set(p: Partial<StoreState>): void }).set({ ready: true });
    return s;
  };
  const render = (el: ReactElement) => renderToStaticMarkup(h(StoreProvider, { store: store() }, el));
  const noop = () => {};
  it('sign in with a password: a labelled password field, Sign in, and pairing instead', () => {
    const html = render(h(SignInScreen, { me: { signedIn: false, kind: null, deviceId: null, deviceName: null, scopes: [], passwordSet: true }, error: null, onSignedIn: noop, onPair: noop, onRetry: noop }));
    expect(html).toContain('Sign in to your helper');
    expect(html).toMatch(/<label for="signin-pw">Password<\/label><input id="signin-pw"[^>]*type="password"[^>]*autoComplete="current-password"/i);
    expect(html).toContain('>Sign in</button>');
    expect(html).toContain('Pair with a code instead');
  });
  it('no password: pairing only', () => {
    const html = render(h(SignInScreen, { me: { signedIn: false, kind: null, deviceId: null, deviceName: null, scopes: [], passwordSet: false }, error: null, onSignedIn: noop, onPair: noop, onRetry: noop }));
    expect(html).toContain('Pair this device first');
    expect(html).not.toContain('type="password"');
    expect(html).toContain('Type a code');
  });
  it('the helper can\'t be reached: says so, with Try again', () => {
    const html = render(h(SignInScreen, { me: null, error: 'Can’t reach your helper right now. Try again in a moment.', onSignedIn: noop, onPair: noop, onRetry: noop }));
    expect(html).toContain('Can’t reach your helper');
    expect(html).toContain('Try again');
  });
  it('pair this phone: the code and name fields, what the phone may do, Pair and Not now', () => {
    (globalThis as { location?: unknown }).location ??= { hash: '', host: 'mwa.example', pathname: '/pair', search: '' };
    (globalThis as { navigator?: unknown }).navigator ??= { userAgent: 'Mozilla/5.0 (Linux; Android 14) Mobile' };
    const html = render(h(PairScreen, { me: null, onPaired: noop, onCancel: noop }));
    expect(html).toContain('Pair this phone with MWA?');
    expect(html).toContain('<label for="pair-code">Code from your computer</label>');
    expect(html).toContain('<label for="pair-name">Name for this phone</label>');
    expect(html).toContain('It can’t change connections or keys.');
    expect(html).toContain('>Pair</button>');
    expect(html).toContain('Not now');
  });
  it('the pairing card: a QR named for screen readers, the code as text, the time left', () => {
    const html = render(h(PairCodeCard, { code: { code: 'K7PQ-M4XZ', expiresAt: FIXTURE_NOW + 600_000, pairUrl: 'https://mwa.tail1a2b.ts.net/pair#c=K7PQ-M4XZ', scopes: ['read', 'act', 'approve'] }, now: () => FIXTURE_NOW, onNew: noop, onDone: noop }));
    expect(html).toMatch(/<svg class="qr" role="img" aria-label="Pairing code K7PQ-M4XZ, as a QR code"/);
    expect(html).toContain('<rect width="100%" height="100%" fill="#ffffff"></rect>');
    expect(html).toContain('K7PQ-M4XZ');
    expect(html).toContain('mwa.tail1a2b.ts.net/pair');
    expect(html).toContain('for 10:00 more');
    const local = render(h(PairCodeCard, { code: { code: 'K7PQ-M4XZ', expiresAt: FIXTURE_NOW + 600_000, pairUrl: 'http://localhost:7788/pair#c=K7PQ-M4XZ', scopes: [], reachable: false }, now: () => FIXTURE_NOW, onNew: noop, onSetAddress: async () => ({ ok: true }) }));
    expect(local).toContain('Your phone can’t reach “localhost”.');
    expect(local).toContain('<label for="pair-addr" class="sr-only">Your helper’s address</label>');
    const old = render(h(PairCodeCard, { code: { code: 'K7PQ-M4XZ', expiresAt: FIXTURE_NOW - 1, pairUrl: 'https://x/pair#c=K7PQ-M4XZ', scopes: [] }, now: () => FIXTURE_NOW, onNew: noop }));
    expect(old).toContain('This code has expired.');
    expect(old).not.toContain('role="img"');
  });
});
