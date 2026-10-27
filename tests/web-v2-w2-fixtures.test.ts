// v2 build, slice W2: fixture mode for Today and the Calendar (web/src/v2/dev/fixtures-today.ts) answers with the
// contract's shapes (validated against api/openapi.yaml) and behaves like the server: the check-in only in the morning
// until Done, the wrap only in the evening until Good night, an unknown day never shown as free, Needs you never made
// from mail (the phishing message is in Worth a look, not in Needs you), Done for you after the last look.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { FixtureServer, FIXTURE_SCENARIOS } from '../web/src/v2/dev/fixtures';
import { TODAY_SCENARIOS } from '../web/src/v2/dev/fixtures-today';
import { scenarioClock } from '../web/src/v2/dev/fixture-clock';
import type { Today } from '../web/src/v2/api/client';

const spec = parse(readFileSync(new URL('../api/openapi.yaml', import.meta.url), 'utf8'));
const ajv = new (Ajv2020 as unknown as typeof Ajv2020.default)({ strict: false, allErrors: true });
(addFormats as unknown as typeof addFormats.default)(ajv);
ajv.addSchema({ $id: 'spec', components: spec.components });
function schemaFor(path: string, method: string, status: number): object {
  const op = spec.paths[path][method];
  const r = op.responses[String(status)] ?? op.responses.default;
  const resolved = r.$ref ? spec.components.responses[r.$ref.split('/').pop()] : r;
  return JSON.parse(JSON.stringify(resolved.content['application/json'].schema).replace(/"#\/components\//g, '"spec#/components/'));
}
function valid(path: string, method: string, res: { status: number; body: unknown }) {
  const fn = ajv.compile(schemaFor(path, method, res.status));
  expect(fn(res.body) ? null : `${method.toUpperCase()} ${path} ${res.status}: ${ajv.errorsText(fn.errors)}`).toBeNull();
}
const H = { 'x-mwa-client': 'web/1.0.0' };
const get = (s: FixtureServer, path: string, q = '') => s.handle({ method: 'GET', path, query: new URLSearchParams(q), headers: H, body: undefined });
let k = 0;
const post = (s: FixtureServer, path: string, body?: unknown) => s.handle({ method: 'POST', path, query: new URLSearchParams(), headers: { ...H, 'idempotency-key': `w2-key-${++k}` }, body });
const today = (s: FixtureServer) => get(s, '/today').body as Today;

describe('Today and the calendar in fixture mode: the contract\'s shapes', () => {
  it('GET /today in every scenario, and the calendar reads', () => {
    for (const sc of FIXTURE_SCENARIOS) {
      if (sc === 'old-client') continue;
      const s = new FixtureServer(sc);
      valid('/today', 'get', get(s, '/today'));
      valid('/calendar/accounts', 'get', get(s, '/calendar/accounts'));
      valid('/calendar', 'get', get(s, '/calendar'));
      valid('/meta', 'get', get(s, '/meta'));
      valid('/sync', 'get', get(s, '/sync', 'collections=jobs,calendar,projects,turns,important'));
    }
  });

  it('the writes: seen, check-in done, wrap done, refresh, a new draft (201, then 200 for the same one, 400 for a bad one)', () => {
    const m = new FixtureServer('N05');
    valid('/today/seen', 'post', post(m, '/today/seen'));
    valid('/today/checkin/done', 'post', post(m, '/today/checkin/done'));
    const e = new FixtureServer('N09');
    valid('/today/wrap/done', 'post', post(e, '/today/wrap/done'));
    for (const sc of TODAY_SCENARIOS) valid('/calendar/refresh', 'post', post(new FixtureServer(sc), '/calendar/refresh'));
    const s = new FixtureServer('N00');
    const a = post(s, '/calendar/drafts', { title: 'Book fair', start: '2026-11-14T15:00', end: '2026-11-14T18:00', location: 'Oakwood Elementary' });
    expect(a.status).toBe(201);
    valid('/calendar/drafts', 'post', a);
    const b = post(s, '/calendar/drafts', { title: 'Book fair', start: '2026-11-14T15:00', end: '2026-11-14T18:00', location: 'Oakwood Elementary' });
    expect(b.status).toBe(200);
    valid('/calendar/drafts', 'post', b);
    const allDay = post(s, '/calendar/drafts', { title: 'Farrier', start: '2026-11-13' });
    valid('/calendar/drafts', 'post', allDay);
    expect((allDay.body as { draft: { allDay: boolean; end: string } }).draft).toMatchObject({ allDay: true, end: '2026-11-14' });
    const bad = post(s, '/calendar/drafts', { title: 'x', start: '2026-11-14T15:00', end: '2026-11-14T14:00' });
    expect(bad.status).toBe(400);
    valid('/calendar/drafts', 'post', bad);
    expect((get(s, '/meta').body as { features: string[] }).features).toContain('today');
  });
});

describe('Today in fixture mode behaves like the server', () => {
  it('the clock per scenario: N05 7:30, midday 12:30, N09 6:30 PM, the rest 9:10 — the prototype\'s Monday', () => {
    expect(today(new FixtureServer('N05')).now).toBe(scenarioClock('N05'));
    expect(new Date(scenarioClock('N09')).getHours()).toBe(18);
    expect(today(new FixtureServer('midday')).part).toBe('afternoon');
    const d = today(new FixtureServer('N00'));
    expect(d).toMatchObject({ date: '2026-11-09', weekday: 'Monday', dateLabel: 'Monday, November 9', greeting: 'Good morning, Robert', part: 'morning' });
  });

  it('N00 (9:10): the prototype\'s Today — no check-in, the clash, next up, three done for you, Worth a look without the clash', () => {
    const d = today(new FixtureServer('N00'));
    expect(d.checkin).toBeNull();
    expect(d.wrap).toBeNull();
    expect(d.needsYou.map((n) => n.title)).toEqual(['Thursday at 4 is double-booked']);
    expect(d.nextUp.map((e) => `${e.startLabel} ${e.title}${e.soon ? ` (${e.soon})` : ''}`)).toEqual(['10 AM Call with Dana (in 50 min)', '12:30 PM Lunch with Sam', '4 PM Riley’s soccer practice']);
    expect(d.nextUpMore).toBe(1);
    expect(d.doneForYou).toHaveLength(3);
    expect(d.worthALook.map((i) => i.id)).not.toContain('it_clash');
    expect(d.worthALook).toHaveLength(3);
    expect(d.status.text).toBe('Working on 1 thing');
  });

  it('a phishing-flagged message is never a Needs-you card (Needs you is never made from mail), though it is in Worth a look', () => {
    for (const sc of TODAY_SCENARIOS) {
      const d = today(new FixtureServer(sc));
      expect(d.needsYou.every((n) => n.kind !== 'approval' || !/PayPal|limited/i.test(n.title))).toBe(true);
      expect(d.needsYou.map((n) => `${n.title} ${n.text}`).join(' ')).not.toMatch(/PayPal|limited|paypa1/i);
    }
    const d = today(new FixtureServer('N00'));
    expect(d.worthALook.find((i) => i.caution === 'phishing')?.title).toBe('Your account has been limited');
  });

  it('N05 (7:30): the counts-only check-in, read aloud without titles; Done takes it away everywhere', () => {
    const s = new FixtureServer('N05');
    const c = today(s).checkin!;
    expect(c.title).toBe('Your morning check-in');
    expect(c.text).toBe('Here’s your Monday: 5 things on your calendar, 1 thing needs you, and I did 3 things overnight. It’s all below.');
    expect(c.spoken).toContain('Your first thing is at 8:15 AM.');
    expect(c.spoken).not.toMatch(/School drop-off|soccer|Farrier/);
    expect(c.trust).toBe('trusted');
    const ack = post(s, '/today/checkin/done').body as { message: string; today: Today };
    expect(ack.message).toBe('Morning check-in done. Have a good Monday.');
    expect(ack.today.checkin).toBeNull();
    expect(today(s).checkin).toBeNull();
  });

  it('N09 (6:30 PM): the wrap quotes a title as one ("an event called …"), trust untrusted; Good night takes it away', () => {
    const s = new FixtureServer('N09');
    const w = today(s).wrap!;
    expect(w.title).toBe('That’s Monday');
    expect(w.lines).toEqual(['You confirmed 1 event and I drafted 2 replies today.', 'Tomorrow starts at 8:15 AM with an event called “School drop-off”, then something at 11 AM.']);
    expect(w.trust).toBe('untrusted');
    expect(today(s).greeting).toBe('Good evening, Robert');
    expect((post(s, '/today/wrap/done').body as { message: string }).message).toBe('See you in the morning.');
    expect(today(s).wrap).toBeNull();
  });

  it('partial: what is known is shown and the missing calendar is named; not connected: no next up, the note instead', () => {
    const p = today(new FixtureServer('partial'));
    expect(p.freshness).toMatchObject({ calendar: 'partial', calendarNote: 'Your Outlook calendar hasn\'t synced yet, so your day may be missing things.' });
    expect(p.nextUp.length).toBeGreaterThan(0);
    const n = new FixtureServer('not-connected');
    const nd = today(n);
    expect(nd.freshness.calendar).toBe('not_connected');
    expect(nd.nextUp).toEqual([]);
    expect(nd.agenda).toEqual([]);
    expect(nd.needsYou.some((x) => x.kind === 'conflict')).toBe(false);
    expect((get(n, '/calendar/accounts').body as { accounts: { connected: boolean }[] }).accounts.every((a) => !a.connected)).toBe(true);
    const acc = get(new FixtureServer('partial'), '/calendar/accounts').body as { accounts: { label: string; lastOk: number | null }[] };
    expect(acc.accounts.map((a) => `${a.label}:${a.lastOk === null ? 'never' : 'ok'}`)).toEqual(['Google Calendar:ok', 'Outlook:never']);
  });

  it('reconnect: a Needs-you card and the note', () => {
    const d = today(new FixtureServer('reconnect'));
    expect(d.needsYou.map((x) => x.kind)).toContain('reconnect');
    expect(d.freshness).toMatchObject({ calendar: 'reconnect', needsReconnect: [{ resource: 'calendar', label: 'Google Calendar' }] });
  });

  it('Done for you lists only what came after the last look; a job waiting is a Needs-you card (N06)', () => {
    const s = new FixtureServer('N00');
    expect(today(s).doneForYou).toHaveLength(3);
    post(s, '/today/seen');
    expect(today(s).doneForYou).toHaveLength(0);
    const w = today(new FixtureServer('N06'));
    expect(w.needsYou[0]).toMatchObject({ kind: 'job', title: 'Learning the USEF eventing rules', action: { kind: 'continue', label: 'Finish the last 10 pages' }, open: { kind: 'job', id: 'j_learn' } });
    expect(w.status.text).toBe('Working on 1 · 1 waiting for you');
  });

  it('the stream says "today changed" (no data) when something Today is made of changes', async () => {
    const s = new FixtureServer('N00');
    s.answerDelay = 0;
    const got: { event: string; data: unknown }[] = [];
    const off = s.openStream(1_000_000, (m) => got.push(m));
    post(s, '/calendar/drafts', { title: 'Book fair', start: '2026-11-14T15:00' });
    await new Promise((r) => setTimeout(r, 10));
    const notice = got.find((m) => (m.data as { entity?: string }).entity === 'today');
    expect(notice).toMatchObject({ event: 'change', data: { entity: 'today', id: 'today', op: 'upsert' } });
    expect((notice!.data as { data?: unknown }).data).toBeUndefined();
    off();
  });
});
