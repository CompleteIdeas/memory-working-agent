// v2 build, slice A7: calendar sync from Google and Outlook into app.db, against FAKE Google and Graph servers over
// real HTTP (tests/fakes). The real connectors (googleapis + google-auth-library, graph()) are used, pointed at the
// fakes by test-only base-URL variables. Nothing here reaches Google or Microsoft.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetAppDb, appDb } from '../src/v2/db.js';
import { allCalEvents, getCalEvent, getSyncState, calendarItems, eventItem, createDraft } from '../src/v2/calendar.js';
import { syncCalendar, refresh, calendarWindow, calendarAccounts, setCalendarSyncDeps } from '../src/sync/calendar.js';
import { detectConflicts, findConflicts, type Timed } from '../src/sync/conflicts.js';
import { zonedToUtc, localMidnight, localDate, offsetMinutes, parseWhen } from '../src/sync/tz.js';
import { reconnectNeeded } from '../src/sync/errors.js';
import { calendarFakes, type CalendarFakes } from './fakes/calendar-env.js';

const NY = 'America/New_York';
const NOW = Date.parse('2026-11-10T15:00:00Z'); // Tuesday, Nov 10 2026, 10:00 New York
let f: CalendarFakes;
let now = NOW;

beforeEach(async () => {
  resetAppDb(':memory:');
  f = await calendarFakes();
  now = NOW;
  setCalendarSyncDeps({ now: () => now, tz: () => NY });
});
afterEach(async () => { setCalendarSyncDeps(null); await f.done(); });

const ev = (account: string, id: string) => getCalEvent(account, id);

describe('time zones (Intl, no dependency)', () => {
  it('Saturday Nov 14 2026 15:00–18:00 in New York is 20:00–23:00 UTC', () => {
    expect(new Date(Date.UTC(2026, 10, 14)).getUTCDay()).toBe(6); // a Saturday
    expect(new Date(zonedToUtc('2026-11-14T15:00', NY)).toISOString()).toBe('2026-11-14T20:00:00.000Z');
    expect(new Date(zonedToUtc('2026-11-14T18:00:00', NY)).toISOString()).toBe('2026-11-14T23:00:00.000Z');
  });
  it('daylight saving ends Sunday Nov 1 2026: EDT before, EST after, a 25-hour day', () => {
    expect(new Date(Date.UTC(2026, 10, 1)).getUTCDay()).toBe(0); // a Sunday
    expect(new Date(zonedToUtc('2026-10-31T15:00', NY)).toISOString()).toBe('2026-10-31T19:00:00.000Z');
    expect(new Date(zonedToUtc('2026-11-02T15:00', NY)).toISOString()).toBe('2026-11-02T20:00:00.000Z');
    expect(new Date(localMidnight('2026-11-01', NY)).toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(new Date(localMidnight('2026-11-02', NY)).toISOString()).toBe('2026-11-02T05:00:00.000Z');
    // 1:30 happens twice: the first (EDT) is taken
    expect(new Date(zonedToUtc('2026-11-01T01:30', NY)).toISOString()).toBe('2026-11-01T05:30:00.000Z');
    expect(offsetMinutes(Date.parse('2026-11-01T05:59:00Z'), NY)).toBe(-240);
    expect(offsetMinutes(Date.parse('2026-11-01T06:00:00Z'), NY)).toBe(-300);
  });
  it('spring forward: 2:30 on Mar 8 2026 never happens and reads as 3:30 EDT', () => {
    expect(new Date(zonedToUtc('2026-03-08T02:30', NY)).toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });
  it('reads offsets, Z, local times and bare dates', () => {
    expect(parseWhen('2026-11-14T15:00:00-05:00', 'UTC').ms).toBe(Date.parse('2026-11-14T20:00:00Z'));
    expect(parseWhen('2026-11-14T20:00:00Z', NY).ms).toBe(Date.parse('2026-11-14T20:00:00Z'));
    expect(parseWhen('2026-11-14T15:00', NY)).toEqual({ ms: Date.parse('2026-11-14T20:00:00Z'), dateOnly: false });
    expect(parseWhen('2026-11-14', NY)).toEqual({ ms: Date.parse('2026-11-14T05:00:00Z'), dateOnly: true });
    expect(localDate(Date.parse('2026-11-15T04:59:00Z'), NY)).toBe('2026-11-14');
  });
  it('the window is yesterday 00:00 through the end of the 14th day ahead, local', () => {
    const w = calendarWindow(NOW, NY);
    expect(w.from).toBe('2026-11-09T05:00:00.000Z');
    expect(w.to).toBe('2026-11-25T05:00:00.000Z');
    const d = calendarWindow(Date.parse('2026-10-31T16:00:00Z'), NY); // across the DST change
    expect(d.from).toBe('2026-10-30T04:00:00.000Z');
    expect(d.to).toBe('2026-11-15T05:00:00.000Z');
  });
});

function seedGoogle(g: CalendarFakes['google']) {
  g.put({ id: 'bookfair', summary: 'Book fair', location: 'Oakwood Elementary', start: { dateTime: '2026-11-14T15:00:00-05:00' }, end: { dateTime: '2026-11-14T18:00:00-05:00' } });
  g.put({ id: 'bday', summary: 'Riley’s birthday', start: { date: '2026-11-12' }, end: { date: '2026-11-13' } });
  for (const day of ['2026-11-12', '2026-11-19']) {
    g.put({ id: `prac_${day.replace(/-/g, '')}`, summary: 'Riley — practice', recurringEventId: 'prac', start: { dateTime: `${day}T16:00:00-05:00`, timeZone: NY }, end: { dateTime: `${day}T17:30:00-05:00`, timeZone: NY } });
  }
  g.put({ id: 'farrier', summary: 'Farrier', start: { dateTime: '2026-11-12T16:00:00-05:00' }, end: { dateTime: '2026-11-12T17:00:00-05:00' } });
  g.put({ id: 'london', summary: 'Call with London', start: { dateTime: '2026-11-16T09:00:00Z', timeZone: 'Europe/London' }, end: { dateTime: '2026-11-16T10:00:00Z', timeZone: 'Europe/London' } });
  g.put({ id: 'december', summary: 'Far away', start: { dateTime: '2026-12-20T15:00:00-05:00' }, end: { dateTime: '2026-12-20T16:00:00-05:00' } });
  g.put({ id: 'declined', summary: 'Optional webinar', attendees: [{ email: 'me@example.com', self: true, responseStatus: 'declined' }], start: { dateTime: '2026-11-12T16:30:00-05:00' }, end: { dateTime: '2026-11-12T17:00:00-05:00' } });
}

describe('Google Calendar sync', () => {
  it('initial sync: every page of singleEvents over the window; all-day, time zones, recurring instances', async () => {
    seedGoogle(f.google);
    f.google.pageSize = 2;
    const r = await syncCalendar('google');
    expect(r).toMatchObject({ ok: true, result: { mode: 'full' } });
    const lists = f.google.requests.filter((q) => q.method === 'GET' && q.path.endsWith('/events'));
    expect(lists.length).toBeGreaterThanOrEqual(4); // 7 in the window at 2 a page
    const first = lists[0].query;
    expect(first).toMatchObject({ singleEvents: 'true', timeMin: '2026-11-09T05:00:00.000Z', timeMax: '2026-11-25T05:00:00.000Z' });
    expect(lists.slice(1).every((q) => q.query.pageToken)).toBe(true);

    const fair = ev('google', 'bookfair')!;
    expect([fair.start_utc, fair.end_utc, fair.all_day, fair.location]).toEqual(['2026-11-14T20:00:00.000Z', '2026-11-14T23:00:00.000Z', 0, 'Oakwood Elementary']);
    const bday = ev('google', 'bday')!;
    expect([bday.start_utc, bday.end_utc, bday.all_day, bday.tz]).toEqual(['2026-11-12T05:00:00.000Z', '2026-11-13T05:00:00.000Z', 1, NY]);
    expect(eventItem(bday)).toMatchObject({ start: '2026-11-12', end: '2026-11-13', allDay: true });
    expect(ev('google', 'prac_20261112')).toMatchObject({ recurring_id: 'prac', start_utc: '2026-11-12T21:00:00.000Z' });
    expect(ev('google', 'prac_20261119')).toMatchObject({ recurring_id: 'prac', start_utc: '2026-11-19T21:00:00.000Z' });
    expect(ev('google', 'london')!.start_utc).toBe('2026-11-16T09:00:00.000Z');
    expect(ev('google', 'declined')!.status).toBe('declined');
    expect(ev('google', 'december')).toBeNull();
    const st = getSyncState('google', 'calendar')!;
    expect(st.cursor).toMatch(/^tok-\d+$/);
    expect([st.window_from, st.needs_reconnect, st.last_error, st.last_ok]).toEqual(['2026-11-09T05:00:00.000Z', 0, null, NOW]);
  });

  it('incremental: only the changes (syncToken, no timeMin); cancelled instance deleted; moved out of the window dropped', async () => {
    seedGoogle(f.google);
    await syncCalendar('google');
    const before = f.google.requests.length;
    f.google.put({ id: 'bookfair', summary: 'Book fair', location: 'Oakwood Elementary', start: { dateTime: '2026-11-14T16:00:00-05:00' }, end: { dateTime: '2026-11-14T18:00:00-05:00' } });
    f.google.cancel('prac_20261119');
    f.google.put({ id: 'lunch', summary: 'Lunch with Sam', start: { dateTime: '2026-11-11T12:00:00-05:00' }, end: { dateTime: '2026-11-11T13:00:00-05:00' } });
    f.google.put({ id: 'london', summary: 'Call with London', start: { dateTime: '2027-01-16T09:00:00Z' }, end: { dateTime: '2027-01-16T10:00:00Z' } });
    const r = await syncCalendar('google');
    expect(r.result).toMatchObject({ mode: 'incremental', upserted: 2, deleted: 2 });
    const q = f.google.requests.slice(before).find((x) => x.method === 'GET')!.query;
    expect(q.syncToken).toMatch(/^tok-/);
    expect(q.timeMin).toBeUndefined();
    expect(ev('google', 'bookfair')!.start_utc).toBe('2026-11-14T21:00:00.000Z');
    expect(ev('google', 'prac_20261119')).toBeNull();
    expect(ev('google', 'prac_20261112')).not.toBeNull(); // the other instance stays
    expect(ev('google', 'lunch')).not.toBeNull();
    expect(ev('google', 'london')).toBeNull();
  });

  it('nothing changed: an incremental sync writes nothing (no events in the log)', async () => {
    seedGoogle(f.google);
    await syncCalendar('google');
    const seq = (appDb().prepare('SELECT MAX(seq) s FROM events').get() as { s: number }).s;
    const r = await syncCalendar('google');
    expect(r.result).toMatchObject({ mode: 'incremental', upserted: 0, deleted: 0 });
    expect((appDb().prepare('SELECT MAX(seq) s FROM events').get() as { s: number }).s).toBe(seq);
  });

  it('410 Gone: a full resync of the window, and the cache matches what is there now', async () => {
    seedGoogle(f.google);
    await syncCalendar('google');
    f.google.cancel('farrier');
    f.google.put({ id: 'new', summary: 'New thing', start: { dateTime: '2026-11-13T09:00:00-05:00' }, end: { dateTime: '2026-11-13T10:00:00-05:00' } });
    f.google.invalidateTokens();
    const r = await syncCalendar('google');
    expect(r).toMatchObject({ ok: true, result: { mode: 'full', resynced: true } });
    expect(f.google.requests.some((x) => x.query.syncToken)).toBe(true); // it tried the token first
    expect(ev('google', 'farrier')).toBeNull();
    expect(ev('google', 'new')).not.toBeNull();
    expect(getSyncState('google', 'calendar')!.cursor).toMatch(/^tok-/);
    // and the next sync is incremental again
    expect((await syncCalendar('google')).result?.mode).toBe('incremental');
  });

  it('a new day moves the window: a full sync of the new window', async () => {
    seedGoogle(f.google);
    await syncCalendar('google');
    now = NOW + 86_400_000;
    const r = await syncCalendar('google');
    expect(r.result?.mode).toBe('full');
    expect(getSyncState('google', 'calendar')!.window_from).toBe('2026-11-10T05:00:00.000Z');
  });

  it('across the end of daylight saving (Nov 1 2026)', async () => {
    now = Date.parse('2026-10-31T16:00:00Z');
    f.google.put({ id: 'sat', summary: 'Saturday ride', start: { dateTime: '2026-10-31T15:00:00-04:00' }, end: { dateTime: '2026-10-31T16:00:00-04:00' } });
    f.google.put({ id: 'mon', summary: 'Monday lesson', start: { dateTime: '2026-11-02T15:00:00-05:00' }, end: { dateTime: '2026-11-02T16:00:00-05:00' } });
    f.google.put({ id: 'sun', summary: 'Clocks change', start: { date: '2026-11-01' }, end: { date: '2026-11-02' } });
    await syncCalendar('google');
    expect(ev('google', 'sat')!.start_utc).toBe('2026-10-31T19:00:00.000Z');
    expect(ev('google', 'mon')!.start_utc).toBe('2026-11-02T20:00:00.000Z');
    const sun = ev('google', 'sun')!;
    expect([sun.start_utc, sun.end_utc]).toEqual(['2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z']);
    expect(Date.parse(sun.end_utc) - Date.parse(sun.start_utc)).toBe(25 * 3_600_000);
    // a day view for Sunday (local) holds the all-day event and nothing from Saturday or Monday
    const day = calendarItems(new Date(localMidnight('2026-11-01', NY)).toISOString(), new Date(localMidnight('2026-11-02', NY)).toISOString());
    expect(day.map((x) => x.title)).toEqual(['Clocks change']);
  });

  it('invalid_grant on refresh: needs_reconnect and last_error, no throw; reconnecting clears it', async () => {
    seedGoogle(f.google);
    f.googleToken({ expired: true });
    f.google.refreshFails = 'invalid_grant';
    const r = await syncCalendar('google');
    expect(r).toMatchObject({ ok: false, needsReconnect: true });
    expect(f.google.requests.some((q) => q.path === '/token')).toBe(true);
    const st = getSyncState('google', 'calendar')!;
    expect(st.needs_reconnect).toBe(1);
    expect(st.last_error).toMatch(/invalid_grant/);
    expect(calendarAccounts().find((a) => a.account === 'google')).toMatchObject({ connected: true, needsReconnect: true });
    f.google.refreshFails = null;
    f.googleToken();
    expect((await syncCalendar('google')).ok).toBe(true);
    expect(getSyncState('google', 'calendar')!.needs_reconnect).toBe(0);
    expect(calendarAccounts().find((a) => a.account === 'google')).toMatchObject({ needsReconnect: false, lastError: null });
  });

  it('a transient failure (server gone) keeps the cache and does not ask to reconnect', async () => {
    seedGoogle(f.google);
    await syncCalendar('google');
    const n = allCalEvents().length;
    process.env.MWA_GOOGLE_API_ROOT = 'http://127.0.0.1:9/'; // nothing listens there
    const r = await syncCalendar('google');
    expect(r).toMatchObject({ ok: false, needsReconnect: false });
    expect(getSyncState('google', 'calendar')).toMatchObject({ needs_reconnect: 0 });
    expect(getSyncState('google', 'calendar')!.last_error).toBeTruthy();
    expect(allCalEvents().length).toBe(n);
  });
});

const utc = (s: string) => ({ dateTime: `${s}.0000000`, timeZone: 'UTC' });

function seedOutlook(g: CalendarFakes['graph']) {
  g.put({ id: 'o-board', subject: 'Board call', start: utc('2026-11-11T19:00:00'), end: utc('2026-11-11T20:00:00'), location: { displayName: 'Zoom' } });
  g.put({ id: 'o-allday', subject: 'School closed', isAllDay: true, start: utc('2026-11-13T00:00:00'), end: utc('2026-11-14T00:00:00') });
  g.put({ id: 'o-occ1', subject: 'Lesson with Ellen', type: 'occurrence', seriesMasterId: 'o-series', start: utc('2026-11-16T14:00:00'), end: utc('2026-11-16T15:00:00') });
  g.put({ id: 'o-occ2', subject: 'Lesson with Ellen', type: 'occurrence', seriesMasterId: 'o-series', start: utc('2026-11-23T14:00:00'), end: utc('2026-11-23T15:00:00') });
  g.put({ id: 'o-cancelled', subject: 'Called off', isCancelled: true, start: utc('2026-11-12T14:00:00'), end: utc('2026-11-12T15:00:00') });
}

describe('Outlook calendar sync (Graph calendarView/delta)', () => {
  it('initial: follows nextLink to the deltaLink, asks for UTC, maps all-day and occurrences', async () => {
    seedOutlook(f.graph);
    f.graph.pageSize = 2;
    const r = await syncCalendar('outlook');
    expect(r).toMatchObject({ ok: true, result: { mode: 'full' } });
    const reqs = f.graph.requests.filter((q) => q.path === '/v1.0/me/calendarView/delta');
    expect(reqs.length).toBe(3);
    expect(decodeURIComponent(reqs[0].search)).toContain('startDateTime=2026-11-09T05:00:00.000Z');
    expect(reqs.every((q) => /outlook\.timezone="UTC"/.test(q.prefer ?? ''))).toBe(true);
    expect(reqs.slice(1).every((q) => q.search.includes('$skiptoken'))).toBe(true);
    expect(ev('outlook', 'o-board')).toMatchObject({ start_utc: '2026-11-11T19:00:00.000Z', end_utc: '2026-11-11T20:00:00.000Z', location: 'Zoom' });
    expect(ev('outlook', 'o-allday')).toMatchObject({ all_day: 1, start_utc: '2026-11-13T05:00:00.000Z', end_utc: '2026-11-14T05:00:00.000Z' });
    expect(eventItem(ev('outlook', 'o-allday')!)).toMatchObject({ start: '2026-11-13', end: '2026-11-14' });
    expect(ev('outlook', 'o-occ2')).toMatchObject({ recurring_id: 'o-series' });
    expect(ev('outlook', 'o-cancelled')).toBeNull();
    expect(getSyncState('outlook', 'calendar')!.cursor).toContain('$deltatoken=');
  });

  it('incremental via the deltaLink: @removed deletes, changes update; 410 → full resync', async () => {
    seedOutlook(f.graph);
    await syncCalendar('outlook');
    f.graph.remove('o-occ1');
    f.graph.put({ id: 'o-board', subject: 'Board call', start: utc('2026-11-12T19:00:00'), end: utc('2026-11-12T20:00:00') });
    const r = await syncCalendar('outlook');
    expect(r.result).toMatchObject({ mode: 'incremental' });
    expect(f.graph.requests.at(-1)!.search).toContain('$deltatoken=');
    expect(ev('outlook', 'o-occ1')).toBeNull();
    expect(ev('outlook', 'o-board')!.start_utc).toBe('2026-11-12T19:00:00.000Z');

    f.graph.remove('o-occ2');
    f.graph.invalidateTokens();
    const again = await syncCalendar('outlook');
    expect(again).toMatchObject({ ok: true, result: { mode: 'full', resynced: true } });
    expect(ev('outlook', 'o-occ2')).toBeNull();
    expect(ev('outlook', 'o-board')).not.toBeNull();
  });

  it('a link outside Graph is never followed with the token', async () => {
    seedOutlook(f.graph);
    await syncCalendar('outlook');
    appDb().prepare(`UPDATE sync_state SET cursor = 'https://evil.example/steal?$deltatoken=1' WHERE account = 'outlook'`).run();
    const r = await syncCalendar('outlook');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/outside Microsoft Graph/);
  });

  it('invalid_grant on token refresh → needs_reconnect; a 401 → needs_reconnect; nothing thrown', async () => {
    f.outlookToken({ expired: true });
    f.graph.refreshFails = 'invalid_grant';
    const r = await syncCalendar('outlook');
    expect(r).toMatchObject({ ok: false, needsReconnect: true });
    expect(getSyncState('outlook', 'calendar')).toMatchObject({ needs_reconnect: 1 });
    expect(getSyncState('outlook', 'calendar')!.last_error).toMatch(/invalid_grant/);

    f.graph.refreshFails = null;
    f.graph.accessToken = 'rotated'; // the stored (unexpired) token no longer works
    f.outlookToken();
    f.graph.accessToken = 'rotated-again';
    const r2 = await syncCalendar('outlook');
    expect(r2).toMatchObject({ ok: false, needsReconnect: true });
    expect(getSyncState('outlook', 'calendar')!.last_error).toMatch(/401/);
  });
});

describe('refresh() and accounts', () => {
  it('syncs every connected calendar; a disconnected one is skipped and its cache cleared', async () => {
    seedGoogle(f.google); seedOutlook(f.graph);
    const out = await refresh();
    expect(out.map((o) => [o.account, o.ok])).toEqual([['google', true], ['outlook', true]]);
    expect(allCalEvents().some((e) => e.account === 'google')).toBe(true);
    f.disconnect('google');
    const out2 = await refresh();
    expect(out2[0]).toMatchObject({ account: 'google', ok: false, skipped: 'not_connected' });
    expect(allCalEvents().some((e) => e.account === 'google')).toBe(false);
    expect(allCalEvents().some((e) => e.account === 'outlook')).toBe(true);
    expect(calendarAccounts().map((a) => [a.account, a.connected])).toEqual([['google', false], ['outlook', true]]);
  });
  it('concurrent refreshes share one run', async () => {
    seedGoogle(f.google);
    const [a, b] = await Promise.all([refresh(), refresh()]);
    expect(a).toBe(b);
    expect(f.google.requests.filter((q) => q.method === 'GET' && !q.query.pageToken).length).toBe(1);
  });
});

describe('conflicts', () => {
  const T = (id: string, s: string, e: string, extra: Partial<Timed> = {}): Timed => ({ id, kind: 'event', title: id, start: `2026-11-12T${s}:00.000Z`, end: `2026-11-12T${e}:00.000Z`, ...extra });
  const FROM = '2026-11-12T00:00:00.000Z', TO = '2026-11-13T00:00:00.000Z';

  it('overlapping timed events are a conflict; touching is not; all-day, declined and cancelled do not count', () => {
    const items = [
      T('practice', '21:00', '22:30'), T('farrier', '21:00', '22:00'), T('after', '22:30', '23:00'),
      T('bday', '05:00', '23:59', { allDay: true }), T('webinar', '21:30', '22:00', { status: 'declined' }), T('gone', '21:00', '22:00', { status: 'cancelled' }),
    ];
    const c = detectConflicts(items, FROM, TO);
    expect(c.map((x) => x.id)).toEqual(['conflict:farrier|practice']);
    expect([c[0].start, c[0].end]).toEqual(['2026-11-12T21:00:00.000Z', '2026-11-12T22:00:00.000Z']);
  });
  it('the same meeting in two calendars is not a double-booking', () => {
    const c = detectConflicts([T('google:x', '15:00', '16:00', { title: 'Board call' }), T('outlook:y', '15:00', '16:00', { title: 'board  call' })], FROM, TO);
    expect(c).toEqual([]);
  });
  it('deterministic: the same answer for any input order; three-way overlaps give each pair once; clipped to the window', () => {
    const items = [T('a', '10:00', '12:00'), T('b', '11:00', '13:00'), T('c', '11:30', '11:45'), T('d', '23:00', '23:59')];
    const want = detectConflicts(items, FROM, TO);
    expect(want.map((x) => x.id)).toEqual(['conflict:a|b', 'conflict:a|c', 'conflict:b|c']);
    for (let i = 0; i < 20; i++) {
      const shuffled = [...items].sort(() => Math.random() - 0.5);
      expect(detectConflicts(shuffled, FROM, TO)).toEqual(want);
    }
    const clipped = detectConflicts([T('a', '10:00', '12:00'), T('b', '10:00', '12:00')], '2026-11-12T11:00:00.000Z', TO);
    expect([clipped[0].start, clipped[0].end]).toEqual(['2026-11-12T11:00:00.000Z', '2026-11-12T12:00:00.000Z']);
  });
  it('over the synced cache: Thursday at 4 is double-booked (practice and farrier), and a draft on top counts', async () => {
    seedGoogle(f.google);
    await syncCalendar('google');
    const from = '2026-11-12T05:00:00.000Z', to = '2026-11-13T05:00:00.000Z';
    expect(findConflicts(from, to).map((c) => c.id)).toEqual(['conflict:google:farrier|google:prac_20261112']);
    const d = createDraft({ title: 'Dentist', startMs: Date.parse('2026-11-12T21:30:00Z'), endMs: Date.parse('2026-11-12T22:00:00Z'), allDay: false, tz: NY });
    const ids = findConflicts(from, to).map((c) => c.id);
    expect(ids).toContain(`conflict:${d.id}|google:farrier`);
    expect(ids).toContain(`conflict:${d.id}|google:prac_20261112`);
  });
});

describe('reconnect classification', () => {
  it('invalid_grant, 401 and permission 403 ask to reconnect; rate limits and 5xx do not', () => {
    expect(reconnectNeeded(Object.assign(new Error('invalid_grant'), { response: { status: 400, data: { error: 'invalid_grant' } } }))).toBe(true);
    expect(reconnectNeeded(Object.assign(new Error('Graph 401: x'), { status: 401 }))).toBe(true);
    expect(reconnectNeeded(Object.assign(new Error('Insufficient Permission'), { status: 403 }))).toBe(true);
    expect(reconnectNeeded(Object.assign(new Error('Rate Limit Exceeded'), { status: 403 }))).toBe(false);
    expect(reconnectNeeded(Object.assign(new Error('Backend Error'), { status: 503 }))).toBe(false);
    expect(reconnectNeeded(new Error('connect ECONNREFUSED'))).toBe(false);
  });
});
