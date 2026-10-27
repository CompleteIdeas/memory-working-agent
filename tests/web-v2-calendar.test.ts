// v2 build, slice W2: the Calendar screen's logic (web/src/v2/store/calendar-ops.ts) — Confirm / Remove shown at once
// and rolled back when refused (also through the real store against the fixture server), queued taps cleared once
// their action leaves the outbox, the double-booking's words and markers, honest states from the accounts, the New
// event form, the calendar file, Monday-first weeks.
import { describe, it, expect } from 'vitest';
import { MwaClient, type CalendarItem } from '../web/src/v2/api/client';
import { V2Store, type ActResult, type OutboxEntry, type StoreEnv, type StreamLike } from '../web/src/v2/store/core';
import { MemoryCache } from '../web/src/v2/store/cache';
import { FixtureServer, FixtureEventSource, fixtureFetch } from '../web/src/v2/dev/fixtures';
import {
  PendingDrafts, displayItems, conflictsOnDay, overlapsOf, conflictTitle, conflictText, calendarHonesty, draftInput, draftIcs, icsName,
  weekStart, weekLabel, itemsOnDay, addDays, startOfDay, type CalendarAccount, type CalendarConflict,
} from '../web/src/v2/store/calendar-ops';

const draft = (id: string, extra: Partial<CalendarItem> = {}): CalendarItem => ({
  id, kind: 'draft', title: 'Book fair', start: new Date(2026, 10, 14, 15).toISOString(), end: new Date(2026, 10, 14, 18).toISOString(), allDay: false,
  location: 'Oakwood Elementary', provider: 'google', state: 'draft', confirmedAt: null, origin: 'helper-after-reading', originNote: 'From a school email.', ...extra,
});
const ev = (id: string, h: number, m: number, mins: number, title = id): CalendarItem => ({
  id, kind: 'event', title, start: new Date(2026, 10, 12, h, m).toISOString(), end: new Date(new Date(2026, 10, 12, h, m).getTime() + mins * 60_000).toISOString(),
  allDay: false, location: null, provider: 'google', addedByHelper: false,
});
function actor(results: ActResult[]) {
  const seen: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  return {
    seen, release,
    act: async (kind: string, args: { id: string }) => { seen.push(`${kind}:${args.id}`); await gate; return results.shift()!; },
  };
}

describe('Confirm / Remove: shown at once, rolled back when refused', () => {
  it('confirm: "Adding to your calendar…" while it goes; gone from the overlay once the store has the answer', async () => {
    const p = new PendingDrafts();
    const a = actor([{ ok: true, queued: false, message: 'Added by your helper just now. No invites were sent.' }]);
    const run = p.run(a, 'confirm', draft('cd_1'), 5);
    expect(displayItems([draft('cd_1')], p.getState().ops)[0].pending).toEqual({ kind: 'confirm', queued: false });
    a.release();
    expect((await run).ok).toBe(true);
    expect(p.getState().ops).toEqual({});
    expect(p.getState().receipt).toEqual({ id: 'cd_1', text: 'Added by your helper just now. No invites were sent.', at: 5 });
  });

  it('remove: the draft leaves the list at once; a refusal puts it back', async () => {
    const p = new PendingDrafts();
    const a = actor([{ ok: false, queued: false, message: 'That draft is already on your calendar.', code: 'confirmed' }]);
    const run = p.run(a, 'remove', draft('cd_1'));
    expect(displayItems([draft('cd_1'), ev('e1', 9, 0, 30)], p.getState().ops).map((i) => i.id)).toEqual(['e1']);
    a.release();
    const r = await run;
    expect(r).toMatchObject({ ok: false, queued: false, message: 'That draft is already on your calendar.' });
    expect(displayItems([draft('cd_1')], p.getState().ops)).toEqual([draft('cd_1')]); // rolled back
    expect(p.getState().receipt).toBeNull();
  });

  it('a confirmed draft shows once: as its event when the calendar has it, else as an event added by the helper', () => {
    const conf = draft('cd_1', { state: 'confirmed', confirmedAt: 1 });
    const evt: CalendarItem = { ...ev('google:1', 15, 0, 180, 'Book fair'), start: conf.start, end: conf.end };
    expect(displayItems([conf, evt], {}).map((i) => i.id)).toEqual(['google:1']);
    expect(displayItems([conf], {})).toEqual([{ ...conf, kind: 'event', addedByHelper: true }]);
    expect(displayItems([draft('cd_2', { state: 'removed' })], {})).toEqual([]);
  });

  it('offline: the tap stays shown as waiting until its action has left the outbox; a second tap is not sent twice', async () => {
    const p = new PendingDrafts();
    const a = actor([{ ok: false, queued: true, message: 'You’re offline.' }]);
    const run = p.run(a, 'confirm', draft('cd_1'));
    expect((await p.run(a, 'confirm', draft('cd_1'))).message).toBe('Already on its way.');
    a.release();
    await run;
    expect(p.getState().ops.cd_1).toEqual({ kind: 'confirm', queued: true });
    const waiting = [{ id: 'o1', key: 'k', kind: 'draft.confirm', args: { id: 'cd_1' }, label: '', createdAt: 0, attempts: 0 }] as OutboxEntry[];
    p.reconcile(waiting);
    expect(p.getState().ops.cd_1).toBeTruthy();
    p.reconcile([]);
    expect(p.getState().ops).toEqual({});
    expect(a.seen).toEqual(['draft.confirm:cd_1']);
  });

  it('through the store against the fixture server: confirm lands (the draft becomes an event); remove after it is refused (409) and rolled back', async () => {
    const server = new FixtureServer('N00');
    const ls = new Map<string, Set<() => void>>();
    const env: StoreEnv = { online: () => true, visible: () => true, on(e, fn) { if (!ls.has(e)) ls.set(e, new Set()); ls.get(e)!.add(fn); return () => ls.get(e)!.delete(fn); },
      setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) };
    const store = new V2Store({ client: new MwaClient({ fetch: fixtureFetch(server), sleep: async () => {} }), cache: new MemoryCache(), env, stream: (u) => new FixtureEventSource(server, u) as unknown as StreamLike });
    await store.start();
    const d = store.getState().calendar.cd_e9;
    expect(d.kind).toBe('draft');
    const p = new PendingDrafts();
    const r = await p.run(store, 'confirm', d);
    expect(r.ok).toBe(true);
    expect(p.getState().receipt?.text).toBe('Added by your helper just now. No invites were sent.');
    // the stream/answer brought the event; a Remove on the old draft is refused, rolled back, and the server's state shows
    const r2 = await p.run(store, 'remove', d);
    expect(r2).toMatchObject({ ok: false, queued: false });
    expect(p.getState().ops).toEqual({});
    await store.idle();
    expect(store.getState().calendar['google:e9']?.addedByHelper).toBe(true);
    expect(store.getState().notices.some((n) => n.tone === 'error')).toBe(true);
    store.stop();
  });

  it('New event through the store: draft.create makes a "Your draft" draft, and offline it waits with its key', async () => {
    const server = new FixtureServer('N00');
    let online = true;
    const base = fixtureFetch(server);
    const f = (async (i: RequestInfo | URL, init?: RequestInit) => { if (!online) throw new TypeError('offline'); return base(i, init); }) as typeof fetch;
    const ls = new Map<string, Set<() => void>>();
    const env: StoreEnv = { online: () => online, visible: () => true, on(e, fn) { if (!ls.has(e)) ls.set(e, new Set()); ls.get(e)!.add(fn); return () => ls.get(e)!.delete(fn); },
      setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) };
    const store = new V2Store({ client: new MwaClient({ fetch: f, sleep: async () => {} }), cache: new MemoryCache(), env, stream: (u) => new FixtureEventSource(server, u) as unknown as StreamLike });
    await store.start();
    const body = draftInput({ title: 'Book fair', date: '2026-11-14', allDay: false, start: '15:00', end: '18:00', location: 'Oakwood Elementary' });
    if (!body.ok) throw new Error(body.error);
    const r = await store.act('draft.create', { draft: body.body }, 'Add “Book fair”');
    expect(r.ok).toBe(true);
    const made = (r.data as { draft: CalendarItem }).draft;
    expect(made).toMatchObject({ kind: 'draft', origin: 'you', state: 'draft', title: 'Book fair' });
    expect(new Date(made.start).getHours()).toBe(15);
    expect(store.getState().calendar[made.id]).toBeTruthy();
    online = false; for (const fn of ls.get('offline') ?? []) fn();
    const q = await store.act('draft.create', { draft: { title: 'Farrier', start: '2026-11-13' } }, 'Add “Farrier”');
    expect(q.queued).toBe(true);
    const key = store.getState().outbox[0].key;
    online = true; for (const fn of ls.get('online') ?? []) fn();
    for (let i = 0; i < 200 && store.getState().outbox.length; i++) await new Promise((x) => setTimeout(x, 10));
    expect(store.getState().outbox).toHaveLength(0);
    expect([...server.calendar.values()].some((c) => c.title === 'Farrier' && c.allDay)).toBe(true);
    expect(key).toMatch(/^[0-9A-Z]{26}$/);
    store.stop();
  });
});

describe('the double-booking', () => {
  const c: CalendarConflict = { id: 'c_a_b', between: ['a', 'b'], titles: ['Riley’s soccer practice', 'Farrier at the barn'], start: new Date(2026, 10, 12, 16).toISOString(), end: new Date(2026, 10, 12, 17).toISOString() };
  const mon = startOfDay(new Date(2026, 10, 9, 9).getTime());
  it('is on its day only, and each event says what it overlaps', () => {
    expect(conflictsOnDay([c], addDays(mon, 3))).toEqual([c]);
    expect(conflictsOnDay([c], addDays(mon, 2))).toEqual([]);
    expect(overlapsOf('a', [c])).toEqual(['Farrier at the barn']);
    expect(overlapsOf('b', [c])).toEqual(['Riley’s soccer practice']);
    expect(overlapsOf('z', [c])).toEqual([]);
  });
  it('says it in our words, the titles as text', () => {
    expect(conflictTitle(c, mon).replace(/ /g, ' ')).toBe('Thursday at 4 PM is double-booked');
    expect(conflictTitle({ ...c, start: new Date(2026, 10, 9, 16, 30).toISOString() }, mon).replace(/ /g, ' ')).toBe('Today at 4:30 PM is double-booked');
    expect(conflictText(c)).toBe('Riley’s soccer practice and Farrier at the barn overlap, 4–5pm.');
  });
  it('the fixture world has the prototype\'s Thursday clash, on /calendar and on Today with the same id', () => {
    const s = new FixtureServer('N00');
    const cal = s.handle({ method: 'GET', path: '/calendar', query: new URLSearchParams({ from: new Date(mon).toISOString(), to: new Date(addDays(mon, 7)).toISOString() }), headers: { 'x-mwa-client': 'web/1.0.0' }, body: undefined }).body as { conflicts: CalendarConflict[] };
    const thu = cal.conflicts.find((x) => x.titles.includes('Farrier at the barn'))!;
    expect(thu.between).toEqual(['google:e10', 'google:e11']);
    const need = s.today.doc().needsYou.find((n) => n.kind === 'conflict')!;
    expect(need.id).toBe(`need:conflict:${thu.id}`);
    expect(need).toMatchObject({ title: 'Thursday at 4 is double-booked', itemId: 'it_clash', action: { kind: 'draft-note', label: 'Draft the note' } });
  });
});

describe('honest states from the accounts', () => {
  const now = new Date(2026, 10, 9, 9, 10).getTime();
  const g: CalendarAccount = { account: 'google:me', provider: 'google', label: 'Google Calendar', connected: true, needsReconnect: false, lastOk: now - 300_000, lastError: null };
  const o: CalendarAccount = { account: 'outlook:me', provider: 'outlook', label: 'Outlook', connected: true, needsReconnect: false, lastOk: null, lastError: null };
  it('not loaded yet: says nothing (never "free")', () => { expect(calendarHonesty(null, now)).toMatchObject({ state: 'unknown', canSayFree: false, note: null }); });
  it('nothing connected', () => { expect(calendarHonesty([{ ...g, connected: false }], now)).toMatchObject({ state: 'not_connected', canSayFree: false }); });
  it('needs reconnecting, named', () => { expect(calendarHonesty([{ ...g, needsReconnect: true }], now).note).toMatch(/^Google Calendar needs to be reconnected/); });
  it('never synced', () => { expect(calendarHonesty([{ ...g, lastOk: null }], now)).toMatchObject({ state: 'not_synced', canSayFree: false }); });
  it('one synced, one never: partial, the missing one named', () => {
    const h = calendarHonesty([g, o], now);
    expect(h).toMatchObject({ state: 'partial', canSayFree: false });
    expect(h.note).toBe('Your Outlook calendar hasn’t synced yet, so your days may be missing things.');
  });
  it('old: stale (what is shown is still the whole picture as of then); fresh: ok', () => {
    expect(calendarHonesty([{ ...g, lastOk: now - 3 * 3_600_000 }], now)).toMatchObject({ state: 'stale', canSayFree: true });
    expect(calendarHonesty([g], now)).toMatchObject({ state: 'ok', canSayFree: true, note: null });
  });
});

describe('the New event form', () => {
  const f = { title: 'Book fair', date: '2026-11-14', allDay: false, start: '15:00', end: '18:00', location: ' Oakwood Elementary ' };
  it('timed: the device wall time with its offset, and its zone; all day: a bare date (with the zone)', () => {
    const r = draftInput(f, 'Europe/Somewhere');
    if (!r.ok) throw new Error(r.error);
    expect(r.body).toMatchObject({ title: 'Book fair', location: 'Oakwood Elementary', tz: 'Europe/Somewhere' });
    expect(r.body.start).toMatch(/^2026-11-14T15:00:00[+-]\d{2}:\d{2}$/);
    expect(Date.parse(r.body.start)).toBe(new Date(2026, 10, 14, 15).getTime());
    expect(Date.parse(r.body.end!)).toBe(new Date(2026, 10, 14, 18).getTime());
    expect(draftInput({ ...f, allDay: true, location: '' }, 'Europe/Somewhere')).toEqual({ ok: true, body: { title: 'Book fair', start: '2026-11-14', allDay: true, tz: 'Europe/Somewhere' } });
    const noEnd = draftInput({ ...f, end: '' });
    expect(noEnd.ok && noEnd.body.end).toBeUndefined();
  });
  it('an end before the start is the next morning (overnight); the same time is refused', () => {
    const r = draftInput({ ...f, start: '22:00', end: '01:00' });
    if (!r.ok) throw new Error(r.error);
    expect(Date.parse(r.body.end!)).toBe(new Date(2026, 10, 15, 1).getTime());
    expect(draftInput({ ...f, end: '15:00' })).toMatchObject({ ok: false, field: 'end', error: 'The end is the same as the start.' });
  });
  it('says what is wrong, in plain words', () => {
    expect(draftInput({ ...f, title: '  ' })).toMatchObject({ ok: false, field: 'title', error: 'Give it a name.' });
    expect(draftInput({ ...f, date: '' })).toMatchObject({ ok: false, field: 'date' });
    expect(draftInput({ ...f, start: '' })).toMatchObject({ ok: false, field: 'start' });
    expect(draftInput({ ...f, end: '9' })).toMatchObject({ ok: false, field: 'end' });
  });
});

describe('the calendar file and the week', () => {
  it('a VCALENDAR with one VEVENT: UTC times, CRLF, escaped and folded', () => {
    const ics = draftIcs(draft('cd_1', { title: 'Book fair; bring cash, and a bag — ' + 'x'.repeat(80) }), Date.UTC(2026, 10, 9));
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(ics).toContain(`DTSTART:${new Date(2026, 10, 14, 15).toISOString().replace(/[-:]/g, '').replace('.000', '')}`);
    expect(ics).toContain('SUMMARY:Book fair\\; bring cash\\, and a bag');
    expect(ics.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(draftIcs(draft('cd_2', { allDay: true, start: '2026-11-14', end: '2026-11-15' }))).toContain('DTSTART;VALUE=DATE:20261114');
    expect(icsName('Book fair')).toBe('book-fair.ics');
    expect(icsName('***')).toBe('event.ics');
  });
  it('weeks start on Monday; labels; items by day (all-day by date)', () => {
    const sat = new Date(2026, 10, 14, 15).getTime();
    expect(new Date(weekStart(sat)).getDate()).toBe(9);
    expect(weekLabel(weekStart(sat))).toBe('November 9–15');
    expect(weekLabel(new Date(2026, 10, 30).getTime())).toBe('November 30–December 6');
    const day = startOfDay(sat);
    const items = [draft('d'), draft('all', { allDay: true, start: '2026-11-14', end: '2026-11-15' }), ev('thu', 16, 0, 60)];
    expect(itemsOnDay(items, day).map((i) => i.id)).toEqual(['d', 'all']);
  });
});
