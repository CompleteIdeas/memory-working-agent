// v2 build, slice S6: getting going in fixture mode (web/src/v2/dev/fixtures-setup.ts) answers with the contract's
// shapes and the server's rules (a phone reads and may close a card but changes nothing; the inbox scan and the storage
// change ask first; a folder must pass the folder rules; values typed into a card and a database address never come
// back; saving a brain in first run makes it work), and the screens' words (screens/setup/words.ts). The screens
// themselves run in the browser: scripts/v2-s6-smoke.mjs.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { FixtureServer } from '../web/src/v2/dev/fixtures';
import { brainBar, cardAsk, cardStateLine, cardsWaitingLine, inboxRunning, inboxStateLine, storageLines, urlProblem } from '../web/src/v2/screens/setup/words';
import type { InboxScan, SetupCard, StorageView } from '../web/src/v2/api/client';

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
  s.handle({ method, path, query: new URLSearchParams(), headers: { ...H, 'idempotency-key': `s6-key-${++k}` }, body }) as { status: number; body: any };
const get = (s: FixtureServer, path: string) => s.handle({ method: 'GET', path, query: new URLSearchParams(), headers: H, body: undefined }) as { status: number; body: any };

describe('S6 fixture mode answers like the server', () => {
  it('the state, the inbox scan and the cards have the contract’s shapes', () => {
    const s = new FixtureServer('setup-card');
    const st = valid('/setup', 'get', get(s, '/setup'));
    expect(st.body).toMatchObject({ brain: { ready: true }, cardsWaiting: 2 });
    valid('/setup/inbox', 'get', get(s, '/setup/inbox'));
    const c = valid('/setup/cards', 'get', get(s, '/setup/cards'));
    expect(c.body.canSubmit).toBe(true);
    expect(c.body.cards.map((x: SetupCard) => x.id)).toEqual(['setup_tg', 'setup_vault']);
  });
  it('fresh: no brain until one is saved, then it works', () => {
    const s = new FixtureServer('fresh');
    expect(get(s, '/settings').body.firstRunDone).toBe(false);
    expect(get(s, '/setup').body.brain).toMatchObject({ ready: false, model: '' });
    expect(get(s, '/setup').body.brain.missing).toMatch(/No AI brain/);
    valid('/assistant/brain', 'put', call(s, 'PUT', '/assistant/brain', { provider: 'openrouter', model: 'openai/gpt-6.1-sol', key: 'sk-or-example-1234' }));
    expect(get(s, '/setup').body.brain).toMatchObject({ ready: true, missing: null });
    expect(JSON.stringify(get(s, '/setup').body)).not.toContain('sk-or-example-1234');
  });
  it('no-brain: the brain has no key; a phone is told where to set it up', () => {
    const s = new FixtureServer('no-brain');
    expect(get(s, '/setup').body.brain).toMatchObject({ ready: false, provider: 'openrouter' });
  });
  it('a folder must pass the rules; notes are saved from that reading only', () => {
    const s = new FixtureServer('N00');
    expect(call(s, 'POST', '/setup/folder/scan', { path: 'Documents' }).body.error.code).toBe('bad_folder');
    expect(call(s, 'POST', '/setup/folder/scan', { path: '/Users/robert/missing' }).body.error.code).toBe('not_found');
    expect(call(s, 'POST', '/setup/folder/scan', { path: '/Users/robert/mwa' }).body.error.code).toBe('refused');
    const r = valid('/setup/folder/scan', 'post', call(s, 'POST', '/setup/folder/scan', { path: '/Users/robert/Documents/Barn' }));
    expect(call(s, 'POST', '/setup/folder/save', { scanId: r.body.scanId, keep: [{ id: 'c9' }] }).status).toBe(400);
    const saved = valid('/setup/folder/save', 'post', call(s, 'POST', '/setup/folder/save', { scanId: r.body.scanId, keep: [{ id: 'c1' }, { id: 'c2' }] }));
    expect(saved.body).toMatchObject({ saved: 2 });
    expect(call(s, 'POST', '/setup/folder/save', { scanId: r.body.scanId, keep: [{ id: 'c1' }] }).body.error.code).toBe('scan_expired');
  });
  it('the inbox scan asks first, runs a round per read, and can be stopped', () => {
    const s = new FixtureServer('N00');
    const ask = call(s, 'POST', '/setup/inbox', { days: 30 });
    expect(ask.status).toBe(409);
    expect(ask.body.error.message).toMatch(/68¢/);
    valid('/setup/inbox', 'post', call(s, 'POST', '/setup/inbox', { days: 30, confirmed: true }));
    for (let i = 0; i < 4; i++) get(s, '/setup/inbox');
    const done = valid('/setup/inbox', 'get', get(s, '/setup/inbox'));
    expect(done.body).toMatchObject({ state: 'done', emails: 46 });
    expect(done.body.learned.length).toBeGreaterThan(2);
    valid('/setup/inbox', 'post', call(s, 'POST', '/setup/inbox', { confirmed: true }));
    valid('/setup/inbox/stop', 'post', call(s, 'POST', '/setup/inbox/stop'));
    expect(get(s, '/setup/inbox').body.state).toBe('stopped');
  });
  it('a card’s values never come back; a phone can close it but not fill it', () => {
    const s = new FixtureServer('setup-card');
    const bad = call(s, 'POST', '/setup/cards/setup_tg/submit', { values: { TELEGRAM_BOT_TOKEN: '123:badTOKENvalue' } });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toContain('badTOKENvalue');
    const ok = valid('/setup/cards/{id}/submit', 'post', call(s, 'POST', '/setup/cards/setup_tg/submit', { values: { TELEGRAM_BOT_TOKEN: '123:goodTOKENvalue' } }));
    expect(JSON.stringify(ok.body)).not.toContain('goodTOKENvalue');
    expect(JSON.stringify(get(s, '/setup/cards').body)).not.toContain('goodTOKENvalue');
    const phone = new FixtureServer('phone');
    phone.settings.setup.cards = new FixtureServer('setup-card').settings.setup.cards;
    expect(get(phone, '/setup/cards').body.canSubmit).toBe(false);
    expect(call(phone, 'POST', '/setup/cards/setup_tg/submit', { values: { TELEGRAM_BOT_TOKEN: 'x' } }).status).toBe(403);
    valid('/setup/cards/{id}/cancel', 'post', call(phone, 'POST', '/setup/cards/setup_vault/cancel'));
    for (const [m, p] of [['POST', '/setup/inbox'], ['POST', '/setup/folder/scan'], ['PUT', '/setup/storage'], ['POST', '/setup/warm']]) expect(call(phone, m, p, {}).status, p).toBe(403);
  });
  it('where memory is kept: asks first; the address never comes back, only the server’s name', () => {
    const s = new FixtureServer('N00');
    expect(call(s, 'PUT', '/setup/storage', { kind: 'postgres', url: 'postgres://u:pw-SECRET@db.example/mwa' }).status).toBe(409);
    const r = call(s, 'PUT', '/setup/storage', { kind: 'postgres', url: 'postgres://u:pw-SECRET@db.example/mwa', confirmed: true, bringMemory: true });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain('pw-SECRET');
    expect(r.body.storage).toMatchObject({ next: 'postgres', restartNeeded: true, nextServer: 'db.example' });
    expect(JSON.stringify(get(s, '/setup').body)).not.toContain('pw-SECRET');
  });
});

describe('S6 words', () => {
  it('the bar without a brain says what is missing, and where to fix it on a phone', () => {
    expect(brainBar({ ready: true, provider: 'openrouter', model: 'x', missing: null }, true)).toBeNull();
    expect(brainBar({ ready: false, provider: '', model: '', missing: 'x' }, true)).toEqual({ text: 'Your helper has no AI brain yet, so it can’t answer, sort your mail or do jobs.', action: 'Set it up' });
    expect(brainBar({ ready: false, provider: 'openrouter', model: 'x', missing: 'x' }, false)!.text).toMatch(/\(openrouter has no key saved\).*on your computer, in Settings › Your assistant/);
  });
  it('cards, the inbox, storage and the address check', () => {
    const c: SetupCard = { id: 'a', name: 'Telegram', howTo: '', where: 'General', fields: [], state: 'waiting', message: '', expiresInSec: 61, vault: null };
    expect(cardStateLine(c)).toBe('Waiting for you · closes in 1 minute');
    expect(cardStateLine({ ...c, state: 'expired' })).toBe('Expired');
    expect(cardAsk({ ...c, vault: { site: 'bookings.example' } })).toMatch(/used only on bookings\.example/);
    expect(cardsWaitingLine(2)).toBe('Your helper needs 2 passwords or keys');
    const scan = { state: 'running', message: '' } as InboxScan;
    expect(inboxRunning(scan)).toBe(true);
    expect(inboxStateLine(scan)).toBe('Reading your email…');
    const v: StorageView = { running: 'sqlite', next: 'postgres', restartNeeded: true, fixed: false, hosted: false, host: 'this computer', server: null, nextServer: 'db.example' };
    expect(storageLines(v)).toEqual({ now: 'This computer · private to it', next: 'After your helper restarts: A database server (Postgres) (db.example).' });
    expect(urlProblem('mysql://x')).toMatch(/postgres:\/\//);
    expect(urlProblem('postgres://u:p@h/d')).toBeNull();
  });
});
