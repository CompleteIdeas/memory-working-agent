// v2 build, slice A7: /api/v1/calendar over real HTTP with real device tokens and scopes, against FAKE Google and
// Graph servers (tests/fakes). The N02 flow: a draft from the person's words → the calendar shows it as a draft →
// Confirm (once, no invites, the receipt) → the calendar shows the event; the .ics file; /sync's calendar collection.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createV1 } from '../src/api/router.js';
import { v1Routes } from '../src/api/v1.js';
import { makeAuthenticate, createPairCode, redeemPairCode } from '../src/api/auth.js';
import { resetAppDb } from '../src/v2/db.js';
import { setCalendarSyncDeps } from '../src/sync/calendar.js';
import { parseIcs } from '../src/sync/ics.js';
import { calendarFakes, type CalendarFakes } from './fakes/calendar-env.js';

let f: CalendarFakes, server: Server, base = '';
let READER = '', ACTOR = '';
const NOW = Date.parse('2026-11-10T15:00:00Z');

beforeAll(async () => {
  f = await calendarFakes();
  const v1 = createV1(v1Routes(), { authenticate: makeAuthenticate({ passwordSet: true, sessionValid: () => false }), sameOrigin: () => true });
  server = createServer(async (req, res) => { if (!(await v1(req, res))) { res.writeHead(404); res.end(); } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
});
afterAll(async () => { server?.close(); setCalendarSyncDeps(null); await f.done(); });
beforeEach(() => {
  resetAppDb(':memory:');
  f.google.clear(); f.graph.clear(); f.googleToken(); f.outlookToken();
  setCalendarSyncDeps({ now: () => NOW, tz: () => 'America/New_York' });
  READER = redeemPairCode(createPairCode('test', ['read']).code, 'Old tablet')!.token;
  ACTOR = redeemPairCode(createPairCode('test', ['read', 'act', 'approve']).code, 'Phone')!.token;
});

let n = 0;
const call = async (token: string, method: string, path: string, body?: unknown, key?: string) => {
  const r = await fetch(base + path, {
    method, headers: { authorization: `Bearer ${token}`, ...(method !== 'GET' ? { 'idempotency-key': key ?? `k-${Date.now()}-${++n}`, 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const ct = r.headers.get('content-type') ?? '';
  return { status: r.status, headers: r.headers, body: ct.includes('json') ? await r.json() : await r.text() };
};

describe('/api/v1/calendar', () => {
  it('N02: put the book fair on my calendar → a draft → Confirm → on the calendar, once, no invites', async () => {
    f.google.put({ id: 'lunch', summary: 'Lunch with Sam', start: { dateTime: '2026-11-14T12:00:00-05:00' }, end: { dateTime: '2026-11-14T13:00:00-05:00' } });
    expect((await call(ACTOR, 'POST', '/calendar/refresh')).status).toBe(200);

    const made = await call(ACTOR, 'POST', '/calendar/drafts', { title: 'Book fair', start: '2026-11-14T15:00', end: '2026-11-14T18:00', location: 'Oakwood Elementary' });
    expect(made.status).toBe(201);
    const id = made.body.draft.id;
    expect(made.body.draft).toMatchObject({ kind: 'draft', state: 'draft', title: 'Book fair', start: '2026-11-14T20:00:00.000Z', end: '2026-11-14T23:00:00.000Z', allDay: false });
    expect(f.google.inserts.length).toBe(0);

    // Saturday, November 14: the lunch, then the draft (dashed in the app)
    const sat = await call(READER, 'GET', '/calendar?from=2026-11-14&to=2026-11-14');
    expect(sat.status).toBe(200);
    expect(sat.body.from).toBe('2026-11-14T05:00:00.000Z');
    expect(sat.body.to).toBe('2026-11-15T05:00:00.000Z');
    expect(sat.body.items.map((x: any) => [x.kind, x.title])).toEqual([['event', 'Lunch with Sam'], ['draft', 'Book fair']]);

    // a device with read only cannot confirm
    const no = await call(READER, 'POST', `/calendar/drafts/${id}/confirm`);
    expect(no.status).toBe(403);
    expect(f.google.inserts.length).toBe(0);

    const key = 'confirm-book-fair-1';
    const yes = await call(ACTOR, 'POST', `/calendar/drafts/${id}/confirm`, undefined, key);
    expect(yes.status).toBe(200);
    expect(yes.body.message).toBe('Added by your helper just now. No invites were sent.');
    expect(yes.body.draft.state).toBe('confirmed');
    expect(f.google.inserts.length).toBe(1);
    expect(f.google.inserts[0].query.sendUpdates).toBe('none');

    // the same request again (the phone's retry): replayed, not re-run
    const replay = await call(ACTOR, 'POST', `/calendar/drafts/${id}/confirm`, undefined, key);
    expect(replay.status).toBe(200);
    expect(replay.headers.get('idempotent-replay')).toBe('true');
    // a fresh tap: "already", still one insert
    const again = await call(ACTOR, 'POST', `/calendar/drafts/${id}/confirm`);
    expect(again.body).toMatchObject({ already: true });
    expect(f.google.inserts.length).toBe(1);

    const after = await call(READER, 'GET', '/calendar?from=2026-11-14&to=2026-11-14');
    expect(after.body.items.map((x: any) => [x.kind, x.title, x.addedByHelper ?? false])).toEqual([['event', 'Lunch with Sam', false], ['event', 'Book fair', true]]);
  });

  it('Remove needs act; removed drafts leave the calendar; double-bookings are listed', async () => {
    f.google.put({ id: 'practice', summary: 'Riley — practice', start: { dateTime: '2026-11-12T16:00:00-05:00' }, end: { dateTime: '2026-11-12T17:30:00-05:00' } });
    f.google.put({ id: 'farrier', summary: 'Farrier', start: { dateTime: '2026-11-12T16:00:00-05:00' }, end: { dateTime: '2026-11-12T17:00:00-05:00' } });
    await call(ACTOR, 'POST', '/calendar/refresh');
    const thu = await call(READER, 'GET', '/calendar?from=2026-11-12&to=2026-11-12');
    expect(thu.body.conflicts).toEqual([{ id: 'conflict:google:farrier|google:practice', between: ['google:farrier', 'google:practice'], titles: ['Farrier', 'Riley — practice'], start: '2026-11-12T21:00:00.000Z', end: '2026-11-12T22:00:00.000Z' }]);

    const d = (await call(ACTOR, 'POST', '/calendar/drafts', { title: 'Dentist', start: '2026-11-11T15:30', end: '2026-11-11T16:15' })).body.draft;
    expect((await call(READER, 'POST', `/calendar/drafts/${d.id}/remove`)).status).toBe(403);
    const rm = await call(ACTOR, 'POST', `/calendar/drafts/${d.id}/remove`);
    expect(rm.status).toBe(200);
    expect(rm.body.draft.state).toBe('removed');
    const wed = await call(READER, 'GET', '/calendar?from=2026-11-11&to=2026-11-11');
    expect(wed.body.items).toEqual([]);
    expect((await call(ACTOR, 'POST', `/calendar/drafts/${d.id}/confirm`)).body.error.code).toBe('removed');
  });

  it('the .ics file: a read device may download it; correct headers and content', async () => {
    const d = (await call(ACTOR, 'POST', '/calendar/drafts', { title: 'Book fair', start: '2026-11-14T15:00', end: '2026-11-14T18:00', location: 'Oakwood Elementary, Room 4' })).body.draft;
    const r = await call(READER, 'GET', `/calendar/drafts/${d.id}.ics`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    expect(r.headers.get('content-disposition')).toBe('attachment; filename="book-fair.ics"');
    expect(typeof r.body).toBe('string');
    const text = r.body as string;
    expect(text.split('\r\n').every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
    const e = parseIcs(text).events[0];
    expect(e).toMatchObject({ DTSTART: { value: '20261114T200000Z' }, DTEND: { value: '20261114T230000Z' }, SUMMARY: { value: 'Book fair' }, LOCATION: { value: 'Oakwood Elementary, Room 4' }, UID: { value: `${d.id}@mwa` } });
    expect(text).toContain('LOCATION:Oakwood Elementary\\, Room 4');
    expect((await call(READER, 'GET', '/calendar/drafts/cd_missing.ics')).status).toBe(404);
    // an id may not smuggle a path
    expect((await call(READER, 'GET', '/calendar/drafts/..%2Fetc.ics')).status).toBe(400);
  });

  it('accounts: connected, and which one needs signing in again', async () => {
    f.googleToken({ expired: true });
    f.google.refreshFails = 'invalid_grant';
    const r = await call(ACTOR, 'POST', '/calendar/refresh');
    expect(r.body.results).toEqual([{ account: 'google', ok: false, error: expect.stringMatching(/invalid_grant/) }, { account: 'outlook', ok: true }]);
    const a = await call(READER, 'GET', '/calendar/accounts');
    expect(a.body.accounts.map((x: any) => [x.account, x.connected, x.needsReconnect])).toEqual([['google', true, true], ['outlook', true, false]]);
    f.google.refreshFails = null; f.googleToken();
  });

  it('input is checked: bad range, bad draft, unknown provider', async () => {
    expect((await call(READER, 'GET', '/calendar?from=2026-11-20&to=2026-11-10')).body.error.code).toBe('bad_range');
    expect((await call(READER, 'GET', '/calendar?from=2026-01-01&to=2026-06-01')).body.error.code).toBe('bad_range');
    expect((await call(ACTOR, 'POST', '/calendar/drafts', { title: 'x', start: 'Saturday' })).body.error.code).toBe('bad_draft');
    expect((await call(ACTOR, 'POST', '/calendar/drafts', { title: 'x', start: '2026-11-14T15:00', provider: 'yahoo' })).body.error.code).toBe('bad_provider');
    expect((await call(ACTOR, 'POST', '/calendar/drafts', ['nope'])).body.error.code).toBe('bad_json');
  });

  it('/sync carries the calendar: a snapshot, then deltas (a confirmed draft becomes the event)', async () => {
    f.google.put({ id: 'lunch', summary: 'Lunch with Sam', start: { dateTime: '2026-11-14T12:00:00-05:00' }, end: { dateTime: '2026-11-14T13:00:00-05:00' } });
    await call(ACTOR, 'POST', '/calendar/refresh');
    const d = (await call(ACTOR, 'POST', '/calendar/drafts', { title: 'Book fair', start: '2026-11-14T15:00', end: '2026-11-14T18:00' })).body.draft;
    const snap = await call(READER, 'GET', '/sync?collections=calendar');
    expect(snap.body.reset).toBe(true);
    expect(snap.body.upserts.calendar.map((x: any) => x.id)).toEqual(['google:lunch', d.id]);
    expect(snap.body.upserts.jobs).toBeUndefined();

    await call(ACTOR, 'POST', `/calendar/drafts/${d.id}/confirm`);
    const delta = await call(READER, 'GET', `/sync?since=${snap.body.cursor}&collections=calendar,jobs`);
    expect(delta.body.reset).toBe(false);
    expect(delta.body.upserts.calendar.map((x: any) => [x.kind, x.title, x.addedByHelper ?? false])).toEqual([['event', 'Book fair', true]]);
    expect(delta.body.deletes.calendar).toEqual([d.id]);
    expect(delta.body.upserts.jobs).toEqual([]);
  });
});

describe('the live stream', () => {
  it('a draft appearing and being confirmed is sent as calendar changes with the item', async () => {
    const ac = new AbortController();
    const r = await fetch(`${base}/stream`, { headers: { authorization: `Bearer ${READER}` }, signal: ac.signal });
    const reader = r.body!.getReader(); const dec = new TextDecoder();
    let buf = '';
    const changes: any[] = [];
    let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
    const read = async (until: () => boolean) => {
      const deadline = Date.now() + 6000;
      while (!until() && Date.now() < deadline) {
        pending ??= reader.read(); // one read in flight: a timed-out race must not drop its chunk
        const c = await Promise.race([pending, new Promise<null>((res) => setTimeout(() => res(null), 1500))]);
        if (c) { pending = null; if (c.value) buf += dec.decode(c.value, { stream: true }); }
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          if (/^event: change$/m.test(block)) changes.push(JSON.parse(/^data: (.*)$/m.exec(block)![1]));
        }
      }
    };
    try {
      await read(() => buf.includes('event: hello') || changes.length > 0);
      const d = (await call(ACTOR, 'POST', '/calendar/drafts', { title: 'Book fair', start: '2026-11-14T15:00', end: '2026-11-14T18:00' })).body.draft;
      await read(() => changes.some((c) => c.id === d.id));
      expect(changes.find((c) => c.id === d.id)).toMatchObject({ entity: 'calendar', op: 'upsert', data: { kind: 'draft', title: 'Book fair' } });
      await call(ACTOR, 'POST', `/calendar/drafts/${d.id}/remove`);
      await read(() => changes.some((c) => c.id === d.id && c.op === 'delete'));
      expect(changes.filter((c) => c.id === d.id).at(-1)).toMatchObject({ op: 'delete' });
    } finally { ac.abort(); }
  });
});
