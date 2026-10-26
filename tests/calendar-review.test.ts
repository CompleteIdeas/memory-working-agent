// v2 build, slice A7 — regression tests for the independent review of 0a695f1 (probes P1–P6 and proxy-probe.mjs in
// scratchpad/a7-review, turned into assertions of the CORRECT behaviour), plus the review's other findings.
// Against FAKE Google and Graph servers over real HTTP (tests/fakes); nothing reaches Google or Microsoft.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { resetAppDb, appDb } from '../src/v2/db.js';
import {
  getDraft, setSyncState, getSyncState, draftItem, upsertCalEvent, getCalEvent, allCalEvents, createDraft, updateDraft, pruneOldDrafts,
  takeConfirmLease, CONFIRM_LEASE_MS,
} from '../src/v2/calendar.js';
import { addDraft, confirmDraft, removeDraft, setDraftProviders, DEFAULT_PROVIDERS, googleEventIdFor, draftFromInput, AFTER_READING_NOTE, CONFIRM_RECEIPT } from '../src/sync/drafts.js';
import { listEvents } from '../src/sync/calendar-tool.js';
import { googleTools, googleOAuthClient, recordGoogleSignIn, googleAccountKey, disconnectGoogle } from '../src/connectors/google.js';
import { recordMicrosoftSignIn, outlookAccountKey } from '../src/connectors/microsoft.js';
import { buildIcs, parseIcs } from '../src/sync/ics.js';
import { syncCalendar, refresh, setCalendarSyncDeps, startCalendarSync } from '../src/sync/calendar.js';
import { flagOn, v2DraftsOn, calendarSyncOn } from '../src/sync/flags.js';
import { classifyTool } from '../src/tools/governance.js';
import { parseWhen, zonedToUtc } from '../src/sync/tz.js';
import { createV1, ApiError, type Route } from '../src/api/router.js';
import { v1Routes } from '../src/api/v1.js';
import { ALL_SCOPES, type Caller } from '../src/api/auth.js';
import { calendarFakes, type CalendarFakes } from './fakes/calendar-env.js';

const NY = 'America/New_York';
const NOW = Date.parse('2026-11-10T15:00:00Z'); // Tue Nov 10 2026, 10:00 New York
let f: CalendarFakes;
let now = NOW;
beforeEach(async () => {
  resetAppDb(':memory:');
  f = await calendarFakes();
  now = NOW;
  setCalendarSyncDeps({ now: () => now, tz: () => NY });
});
afterEach(async () => { setCalendarSyncDeps(null); setDraftProviders(null); await f.done(); });
const ctx = {} as never;

describe('P1 list_events never says "no events" when it does not know', () => {
  it('never synced: says so and offers to sync', () => {
    const out = listEvents({});
    expect(out).not.toMatch(/^No events/);
    expect(out).toMatch(/^I can't confirm that range is empty\./);
    expect(out).toMatch(/Google Calendar hasn't synced yet, so I can't tell what is on it\. I can sync it now/);
  });
  it('the sign-in needs renewing: says so (the probe got "No events in that range.")', () => {
    setSyncState('google', 'calendar', { needs_reconnect: 1, last_error: 'invalid_grant', last_ok: NOW - 3_600_000 });
    const out = listEvents({});
    expect(out).not.toMatch(/^No events/);
    expect(out).toMatch(/Google Calendar: the sign-in needs renewing \(reconnect it in Settings\), so I can't see changes since 9:00 AM/);
  });
  it('after a successful sync of every calendar covering the range: empty, with how fresh it is', async () => {
    await refresh();
    now = NOW + 30 * 60_000; // asked half an hour later
    const out = listEvents({ from: '2026-11-11', to: '2026-11-12' });
    expect(out).toBe('No events in that range. (Google Calendar: as of 10:00 AM. Outlook: as of 10:00 AM.)');
  });
  it('a range outside what is kept is not called empty', async () => {
    await refresh();
    const out = listEvents({ from: '2026-12-20', to: '2026-12-21' });
    expect(out).toMatch(/^I can't confirm that range is empty\. Google Calendar: I only keep yesterday through two weeks ahead/);
  });
  it('events listed: the freshness line comes with them; a calendar that failed makes it "may be incomplete"', async () => {
    f.google.put({ id: 'lunch', summary: 'Lunch with Sam', start: { dateTime: '2026-11-11T12:00:00-05:00' }, end: { dateTime: '2026-11-11T13:00:00-05:00' } });
    await refresh();
    expect(listEvents({ from: '2026-11-11', to: '2026-11-11' })).toMatch(/Lunch with Sam\n\nGoogle Calendar: as of 10:00 AM\. Outlook: as of 10:00 AM\.$/);
    setSyncState('outlook', 'calendar', { needs_reconnect: 1 });
    expect(listEvents({ from: '2026-11-11', to: '2026-11-11' })).toMatch(/This may be incomplete\. .*Outlook: the sign-in needs renewing/);
  });
  it('"today" is the person\'s calendar day across the end of DST: Sun Nov 1 at 11:30 PM is still Nov 1', async () => {
    now = Date.parse('2026-11-02T04:30:00Z'); // 11:30 PM EST on Sunday Nov 1
    upsertCalEvent('google', 'google', { provider_id: 'a', title: 'Late Sunday', start_utc: '2026-11-02T04:00:00.000Z', end_utc: '2026-11-02T04:45:00.000Z', all_day: false });
    upsertCalEvent('google', 'google', { provider_id: 'b', title: 'Saturday', start_utc: '2026-11-01T02:00:00.000Z', end_utc: '2026-11-01T03:00:00.000Z', all_day: false });
    upsertCalEvent('google', 'google', { provider_id: 'c', title: 'Next Sunday 00:30', start_utc: '2026-11-08T05:30:00.000Z', end_utc: '2026-11-08T06:00:00.000Z', all_day: false });
    upsertCalEvent('google', 'google', { provider_id: 'd', title: 'Saturday Nov 7 late', start_utc: '2026-11-08T04:00:00.000Z', end_utc: '2026-11-08T04:30:00.000Z', all_day: false });
    const out = listEvents({}); // default: today through 7 days ahead
    expect(out).toContain('Sun, Nov 1 | 11:00 PM–11:45 PM | Late Sunday');
    expect(out).toContain('Sat, Nov 7 | 11:00 PM–11:30 PM | Saturday Nov 7 late');
    expect(out).not.toContain('Saturday |'); // Oct 31 is before today
    expect(out).not.toContain('Next Sunday 00:30'); // Nov 8 is the 8th day
  });
});

describe('P2 provenance on drafts', () => {
  it('a draft from a tainted run records the run and says it came after outside reading', async () => {
    const t = googleTools().find((x) => x.def.name === 'propose_event')!;
    await t.handler({ summary: 'URGENT: call IT +1-555-0100 to keep your account', start: '2026-11-14T15:00', end: '2026-11-14T16:00', description: 'Visit http://evil.example/login' }, { tainted: true, runId: 'r1', session: 's1' } as never);
    const row = appDb().prepare('SELECT * FROM cal_drafts').get() as any;
    expect([row.created_by_try, row.origin, row.suggested_after_outside]).toEqual(['r1', 'helper', 1]);
    expect(draftItem(row)).toMatchObject({ origin: 'helper-after-reading', originNote: AFTER_READING_NOTE });
  });
  it('a clean run: origin helper, the job recorded when there is no run id; the person\'s own: origin you', async () => {
    const t = googleTools().find((x) => x.def.name === 'propose_event')!;
    await t.handler({ summary: 'Dentist', start: '2026-11-11T15:30', end: '2026-11-11T16:15' }, { jobId: 'j_9' } as never);
    const row = appDb().prepare('SELECT * FROM cal_drafts').get() as any;
    expect(row.created_by_try).toBe('job:j_9');
    expect(draftItem(row)).toMatchObject({ origin: 'helper' });
    expect(draftItem(row).originNote).toBeUndefined();
    const mine = addDraft({ title: 'Book fair', start: '2026-11-14T15:00', origin: 'you' }).draft;
    expect(draftItem(mine).origin).toBe('you');
  });
  it('the same proposal again after outside reading keeps the warning (it is never lost)', async () => {
    const t = googleTools().find((x) => x.def.name === 'propose_event')!;
    await t.handler({ summary: 'Book fair', start: '2026-11-14T15:00', end: '2026-11-14T18:00' }, {} as never);
    await t.handler({ summary: 'Book fair', start: '2026-11-14T15:00', end: '2026-11-14T18:00' }, { tainted: true } as never);
    const rows = appDb().prepare('SELECT * FROM cal_drafts').all() as any[];
    expect(rows.length).toBe(1);
    expect(draftItem(rows[0]).origin).toBe('helper-after-reading');
  });
});

describe('P3 Remove versus a confirm in flight', () => {
  it('Remove refuses while any confirm holds the draft — even past the old 120 s — and the confirm then completes', async () => {
    const { draft } = addDraft({ title: 'Dentist', start: '2026-11-14T15:00', provider: 'google' });
    let finish!: (id: string) => void; let inserts = 0;
    setDraftProviders({ connected: () => true, insert: () => { inserts++; return new Promise<string>((r) => { finish = r; }); } });
    const p = confirmDraft(draft.id);
    await new Promise((r) => setTimeout(r, 10));
    appDb().prepare('UPDATE cal_drafts SET confirm_lease = ? WHERE id = ?').run(Date.now() - 121_000, draft.id); // 2 min later
    expect(() => removeDraft(draft.id)).toThrow('Adding it right now — try again in a moment.');
    finish('evt1');
    const r = await p;
    expect(r.message).toBe(CONFIRM_RECEIPT);
    expect(getDraft(draft.id)!.state).toBe('confirmed');
    expect(inserts).toBe(1);
  });
  it('a dead lease (older than any call can take) does not block Remove; the late insert is then taken off the calendar again', async () => {
    const { draft } = addDraft({ title: 'Dentist', start: '2026-11-14T15:00', provider: 'google' });
    let finish!: (id: string) => void;
    const removed: string[] = [];
    setDraftProviders({ connected: () => true, insert: () => new Promise<string>((r) => { finish = r; }), remove: async (_p, id) => { removed.push(id); } });
    const p = confirmDraft(draft.id);
    await new Promise((r) => setTimeout(r, 10));
    appDb().prepare('UPDATE cal_drafts SET confirm_lease = ? WHERE id = ?').run(Date.now() - CONFIRM_LEASE_MS - 1, draft.id);
    expect(removeDraft(draft.id).message).toMatch(/Removed/);
    finish('evt-late');
    await expect(p).rejects.toMatchObject({ code: 'removed', message: expect.stringMatching(/took it off Google Calendar again/) });
    expect(getDraft(draft.id)!.state).toBe('removed'); // never recorded over 'removed'
    expect(removed).toEqual(['evt-late']);
  });
  it('… and when taking it off fails, the draft keeps the event id and the person is told to delete it', async () => {
    const { draft } = addDraft({ title: 'Dentist', start: '2026-11-14T15:00', provider: 'google' });
    let finish!: (id: string) => void;
    setDraftProviders({ connected: () => true, insert: () => new Promise<string>((r) => { finish = r; }), remove: async () => { throw new Error('Backend Error'); } });
    const p = confirmDraft(draft.id);
    await new Promise((r) => setTimeout(r, 10));
    appDb().prepare('UPDATE cal_drafts SET confirm_lease = ? WHERE id = ?').run(Date.now() - CONFIRM_LEASE_MS - 1, draft.id);
    removeDraft(draft.id);
    finish('evt-stuck');
    await expect(p).rejects.toMatchObject({ code: 'removed_but_added', message: expect.stringMatching(/please delete "Dentist" there/) });
    expect(getDraft(draft.id)).toMatchObject({ state: 'removed', orphan_provider_id: 'evt-stuck' });
  });
  it('with the real Google fake: the late event is deleted in Google with no notifications', async () => {
    const { draft } = addDraft({ title: 'Dentist', start: '2026-11-14T15:00', provider: 'google' });
    // the person removes it between the insert and the record
    setDraftProviders({ insert: async (p, d) => { const id = await DEFAULT_PROVIDERS.insert(p, d); appDb().prepare(`UPDATE cal_drafts SET state = 'removed' WHERE id = ?`).run(d.id); return id; } });
    await expect(confirmDraft(draft.id)).rejects.toMatchObject({ code: 'removed' });
    expect(f.google.deletes).toEqual([{ id: googleEventIdFor(draft.id), query: expect.objectContaining({ sendUpdates: 'none' }) }]);
    expect(f.google.get(googleEventIdFor(draft.id))!.status).toBe('cancelled');
  });
  it('a takeover of a dead lease cannot be undone by the first confirm: only the lease holder records', () => {
    const { draft } = addDraft({ title: 'X', start: '2026-11-14T15:00' });
    const a = takeConfirmLease(draft.id, Date.now() - CONFIRM_LEASE_MS - 5);
    const b = takeConfirmLease(draft.id);
    expect(a.ok && b.ok && a.token !== b.token).toBe(true);
  });
});
describe('P4 dates are checked, not rolled over', () => {
  it('Feb 30, month 13, hour 25, an offset of +15:00 are refused; Feb 29 2028 is fine', () => {
    expect(() => draftFromInput({ title: 'x', start: '2026-02-30T10:00' })).toThrow(/not a real date/);
    expect(() => draftFromInput({ title: 'y', start: '2026-13-01' })).toThrow(/not a real date/);
    expect(() => draftFromInput({ title: 'z', start: '2026-11-14T25:00' })).toThrow(/not a real date/);
    expect(() => draftFromInput({ title: 'z', start: '2026-02-30T10:00:00Z' })).toThrow(/not a real date/);
    expect(() => parseWhen('2026-11-14T10:00:00+15:00', NY)).toThrow(/offset/);
    expect(() => zonedToUtc('2026-04-31T10:00', NY)).toThrow(/no such date/);
    expect(new Date(draftFromInput({ title: 'leap', start: '2028-02-29T10:00' }).startMs).toISOString()).toBe('2028-02-29T15:00:00.000Z');
  });
  it('the API refuses them too', async () => {
    const v1 = createV1(v1Routes(), { authenticate: () => ADMIN, sameOrigin: () => true });
    const srv = createServer(async (req, res) => { if (!(await v1(req, res))) { res.writeHead(404); res.end(); } });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}/api/v1`;
    try {
      const r = await fetch(`${base}/calendar/drafts`, { method: 'POST', headers: { 'idempotency-key': 'k-date-0001', 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x', start: '2026-02-30T10:00' }) });
      expect([r.status, (await r.json()).error.code]).toEqual([400, 'bad_draft']);
      const g = await fetch(`${base}/calendar?from=2026-13-01`);
      expect(g.status).toBe(400);
    } finally { srv.close(); }
  });
});

describe('P5 / P6', () => {
  it('P5 the Google event id is valid base32hex, 5–1024 chars', () => {
    expect(googleEventIdFor('cd_abc')).toMatch(/^[a-v0-9]{5,1024}$/);
  });
  it('P6 control characters never reach the .ics (tab is kept)', () => {
    const ics = buildIcs({ uid: 'u@mwa', title: 'a\u0007b', allDay: false, start: 0, end: 3600000, notes: 'x\u0000y\u001bz;,\tq\u007f' });
    const bad = [...ics].filter((c) => (c.charCodeAt(0) < 32 && c !== '\r' && c !== '\n' && c !== '\t') || c.charCodeAt(0) === 127);
    expect(bad).toEqual([]);
    const e = parseIcs(ics).events[0];
    expect(e.SUMMARY.value).toBe('ab');
    expect(e.DESCRIPTION.value).toBe('xyz;,\tq');
  });
});

describe('the Google transport (proxy-probe): gaxios’s own, so HTTPS_PROXY is honoured', () => {
  it('a request through the OAuth client goes via the proxy', async () => {
    const proxied: string[] = [];
    const proxy = createServer((req, res) => { proxied.push(`${req.method} ${req.url}`); res.writeHead(502); res.end(); });
    proxy.on('connect', (req, sock) => { proxied.push(`CONNECT ${req.url}`); sock.end('HTTP/1.1 502 no\r\n\r\n'); });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    const saved = { HTTPS_PROXY: process.env.HTTPS_PROXY, HTTP_PROXY: process.env.HTTP_PROXY, NO_PROXY: process.env.NO_PROXY, https_proxy: process.env.https_proxy, http_proxy: process.env.http_proxy, no_proxy: process.env.no_proxy };
    process.env.HTTPS_PROXY = process.env.HTTP_PROXY = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    process.env.NO_PROXY = ''; delete process.env.no_proxy;
    try {
      const o = googleOAuthClient();
      o.setCredentials({ access_token: 't', expiry_date: Date.now() + 3600e3 });
      await o.request({ url: 'http://example.invalid.test:9/x', retry: false, timeout: 3000 }).catch(() => undefined);
      expect(proxied.length).toBeGreaterThan(0);
      expect(proxied[0]).toMatch(/example\.invalid\.test:9/);
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      proxy.close();
    }
  });
});

describe('Outlook and Google confirm-once without relying on replay', () => {
  it('Google: the id is taken because the person deleted that event in Google → not recorded as confirmed; they are told', async () => {
    const { draft } = addDraft({ title: 'Book fair', start: '2026-11-14T15:00', end: '2026-11-14T18:00', provider: 'google' });
    f.google.put({ id: googleEventIdFor(draft.id), status: 'cancelled', summary: 'Book fair', start: { dateTime: '2026-11-14T20:00:00Z' }, end: { dateTime: '2026-11-14T23:00:00Z' } });
    await expect(confirmDraft(draft.id)).rejects.toMatchObject({ code: 'deleted_in_calendar', message: expect.stringMatching(/deleted there, so I didn't add it again/) });
    expect(getDraft(draft.id)).toMatchObject({ state: 'removed', provider_id: null });
    expect(getCalEvent('google', googleEventIdFor(draft.id))).toBeNull();
  });
});

describe('account switching', () => {
  it('a new Google sign-in clears the calendar cache and sync state, and keys the account by its address', async () => {
    f.google.put({ id: 'lunch', summary: 'Lunch', start: { dateTime: '2026-11-11T12:00:00-05:00' }, end: { dateTime: '2026-11-11T13:00:00-05:00' } });
    await syncCalendar('google');
    expect(getCalEvent('google', 'lunch')).not.toBeNull();
    setSyncState('google', 'mail', { cursor: 'mail-cursor' }); // A8's mail state is not the calendar's to clear
    recordGoogleSignIn({ access_token: f.google.accessToken, refresh_token: 'x', expiry_date: Date.now() + 3_600_000 }, 'Robert@Example.com');
    expect(allCalEvents().length).toBe(0);
    expect(getSyncState('google', 'calendar')).toBeNull();
    expect(getSyncState('google', 'mail')!.cursor).toBe('mail-cursor');
    expect(googleAccountKey()).toBe('google:robert@example.com');
    await syncCalendar('google');
    expect(getCalEvent('google:robert@example.com', 'lunch')).not.toBeNull();
    expect(getSyncState('google:robert@example.com', 'calendar')!.last_ok).toBe(NOW);
    const items = (await import('../src/v2/calendar.js')).calendarItems('2026-11-11T00:00:00.000Z', '2026-11-12T00:00:00.000Z');
    expect(items[0].id).toBe('google:robert@example.com:lunch');
    expect((await import('../src/v2/calendar.js')).calendarItemById('google:robert@example.com:lunch')?.title).toBe('Lunch');
    disconnectGoogle();
    expect(allCalEvents().length).toBe(0);
    expect(getSyncState('google:robert@example.com', 'calendar')).toBeNull();
  });
  it('Outlook too; and refresh() clears rows left under an old key for the same provider', async () => {
    f.graph.put({ id: 'o1', subject: 'Board call', start: { dateTime: '2026-11-11T19:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-11-11T20:00:00.0000000', timeZone: 'UTC' } });
    await syncCalendar('outlook');
    expect(getCalEvent('outlook', 'o1')).not.toBeNull();
    recordMicrosoftSignIn('me@outlook.example');
    expect(outlookAccountKey()).toBe('outlook:me@outlook.example');
    expect(getCalEvent('outlook', 'o1')).toBeNull();
    // an old key's leftovers (say app.db was busy at sign-in) go at the next refresh
    upsertCalEvent('outlook', 'outlook', { provider_id: 'stale', title: 'Someone else', start_utc: '2026-11-11T19:00:00.000Z', end_utc: '2026-11-11T20:00:00.000Z', all_day: false });
    await refresh();
    expect(getCalEvent('outlook', 'stale')).toBeNull();
    expect(getCalEvent('outlook:me@outlook.example', 'o1')).not.toBeNull();
  });
});

describe('recurring series', () => {
  it('Google: a cancelled series master removes its instances', async () => {
    for (const d of ['12', '19']) f.google.put({ id: `prac_202611${d}`, summary: 'Practice', recurringEventId: 'prac', start: { dateTime: `2026-11-${d}T16:00:00-05:00` }, end: { dateTime: `2026-11-${d}T17:00:00-05:00` } });
    await syncCalendar('google');
    expect(allCalEvents().length).toBe(2);
    f.google.put({ id: 'prac', status: 'cancelled', start: { dateTime: '2026-11-12T16:00:00-05:00' }, end: { dateTime: '2026-11-12T17:00:00-05:00' } });
    const r = await syncCalendar('google');
    expect(r.result).toMatchObject({ mode: 'incremental', deleted: 2 });
    expect(allCalEvents().length).toBe(0);
  });
  it('Outlook: a removed series master removes its occurrences', async () => {
    for (const d of ['16', '23']) f.graph.put({ id: `occ${d}`, subject: 'Lesson', type: 'occurrence', seriesMasterId: 'series1', start: { dateTime: `2026-11-${d}T14:00:00.0000000`, timeZone: 'UTC' }, end: { dateTime: `2026-11-${d}T15:00:00.0000000`, timeZone: 'UTC' } });
    f.graph.put({ id: 'series1', subject: 'Lesson', type: 'seriesMaster', start: { dateTime: '2026-11-16T14:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-11-16T15:00:00.0000000', timeZone: 'UTC' } });
    await syncCalendar('outlook');
    expect(allCalEvents().length).toBe(2);
    f.graph.remove('series1');
    await syncCalendar('outlook');
    expect(allCalEvents().length).toBe(0);
  });
});

describe('paging that never ends', () => {
  it('Google: a repeated page token stops the listing; a cut-short full sync prunes nothing and keeps no cursor', async () => {
    upsertCalEvent('google', 'google', { provider_id: 'kept', title: 'Cached before', start_utc: '2026-11-12T15:00:00.000Z', end_utc: '2026-11-12T16:00:00.000Z', all_day: false });
    for (let i = 0; i < 6; i++) f.google.put({ id: `e${i}`, summary: `E${i}`, start: { dateTime: `2026-11-1${i}T10:00:00-05:00` }, end: { dateTime: `2026-11-1${i}T11:00:00-05:00` } });
    f.google.pageSize = 2; f.google.stuckPaging = true;
    const r = await syncCalendar('google');
    expect(r).toMatchObject({ ok: true, result: { mode: 'full', truncated: true } });
    expect(f.google.requests.filter((q) => q.method === 'GET').length).toBe(2); // stopped at the repeat
    expect(getCalEvent('google', 'kept')).not.toBeNull(); // not pruned: the listing was incomplete
    expect(getSyncState('google', 'calendar')).toMatchObject({ cursor: null });
    expect(getSyncState('google', 'calendar')!.last_error).toMatch(/cut short/);
    f.google.stuckPaging = false;
    const again = await syncCalendar('google');
    expect(again.result).toMatchObject({ mode: 'full' });
    expect(again.result?.truncated).toBeUndefined();
    expect(getCalEvent('google', 'kept')).toBeNull(); // a complete listing prunes
    expect(getSyncState('google', 'calendar')!.last_error).toBeNull();
  });
  it('Outlook: a repeated nextLink stops it the same way', async () => {
    upsertCalEvent('outlook', 'outlook', { provider_id: 'kept', title: 'Cached before', start_utc: '2026-11-12T15:00:00.000Z', end_utc: '2026-11-12T16:00:00.000Z', all_day: false });
    for (let i = 0; i < 5; i++) f.graph.put({ id: `o${i}`, subject: `O${i}`, start: { dateTime: `2026-11-1${i}T14:00:00.0000000`, timeZone: 'UTC' }, end: { dateTime: `2026-11-1${i}T15:00:00.0000000`, timeZone: 'UTC' } });
    f.graph.pageSize = 2; f.graph.stuckPaging = true;
    const r = await syncCalendar('outlook');
    expect(r.result).toMatchObject({ truncated: true });
    expect(getCalEvent('outlook', 'kept')).not.toBeNull();
    expect(getSyncState('outlook', 'calendar')!.cursor).toBeNull();
  });
});

describe('transient refusals are not remembered against the Idempotency-Key', () => {
  const ADMIN_ = (): Caller => ({ kind: 'session', id: 'session', scopes: new Set(ALL_SCOPES), viaCookie: true });
  async function serve(routes: Route[]) {
    const v1 = createV1(routes, { authenticate: ADMIN_, sameOrigin: () => true });
    const srv: Server = createServer(async (req, res) => { if (!(await v1(req, res))) { res.writeHead(404); res.end(); } });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    return { srv, base: `http://127.0.0.1:${(srv.address() as { port: number }).port}/api/v1` };
  }
  const post = (base: string, path: string, key: string) => fetch(base + path, { method: 'POST', headers: { 'idempotency-key': key, 'content-type': 'application/json' }, body: '{}' });

  it('the router: a reply or ApiError marked transient releases the key; an ordinary refusal is remembered', async () => {
    let n = 0;
    const { srv, base } = await serve([
      { method: 'POST', path: '/t-reply', scope: 'act', handler: () => (++n < 2 ? { status: 409, body: { error: { code: 'busy', message: 'later' } }, transient: true } : { body: { ok: n } }) },
      { method: 'POST', path: '/t-throw', scope: 'act', handler: () => { if (++n < 4) throw new ApiError(409, 'busy', 'later', true); return { body: { ok: n } }; } },
      { method: 'POST', path: '/kept', scope: 'act', handler: () => { ++n; throw new ApiError(409, 'no', 'no'); } },
    ]);
    try {
      expect((await post(base, '/t-reply', 'key-reply-1')).status).toBe(409);
      const ok = await post(base, '/t-reply', 'key-reply-1');
      expect([ok.status, ok.headers.get('idempotent-replay')]).toEqual([200, null]); // ran again
      expect((await post(base, '/t-throw', 'key-throw-1')).status).toBe(409);
      expect((await post(base, '/t-throw', 'key-throw-1')).status).toBe(200);
      const before = n;
      expect((await post(base, '/kept', 'key-kept-01')).status).toBe(409);
      const again = await post(base, '/kept', 'key-kept-01');
      expect([again.status, again.headers.get('idempotent-replay'), n]).toEqual([409, 'true', before + 1]); // replayed, not re-run
    } finally { srv.close(); }
  });

  it('confirm: no calendar, then connected — the same key adds it; a provider 5xx, then the same key adds it', async () => {
    const { srv, base } = await serve(v1Routes());
    try {
      const { draft } = addDraft({ title: 'Book fair', start: '2026-11-14T15:00', end: '2026-11-14T18:00', provider: 'google' });
      f.disconnect('google');
      const r1 = await post(base, `/calendar/drafts/${draft.id}/confirm`, 'confirm-key-01');
      expect([r1.status, (await r1.json()).error.code]).toEqual([409, 'no_calendar']);
      f.googleToken();
      const r2 = await post(base, `/calendar/drafts/${draft.id}/confirm`, 'confirm-key-01');
      expect([r2.status, r2.headers.get('idempotent-replay')]).toEqual([200, null]);
      expect(f.google.inserts.length).toBe(1);

      const second = addDraft({ title: 'Dentist', start: '2026-11-11T15:30', provider: 'google' }).draft;
      f.google.failInserts = { status: 503, times: 1 };
      const r3 = await post(base, `/calendar/drafts/${second.id}/confirm`, 'confirm-key-02');
      expect(r3.status).toBe(502);
      const r4 = await post(base, `/calendar/drafts/${second.id}/confirm`, 'confirm-key-02');
      expect(r4.status).toBe(200);
      expect(getDraft(second.id)!.state).toBe('confirmed');
    } finally { srv.close(); }
  });
});

describe('old drafts are forgotten; flags read one way', () => {
  it('confirmed and removed drafts untouched for 30 days go (and the stream hears a deletion); open and recent ones stay', async () => {
    const old = Date.now() - 31 * 86_400_000;
    const mk = (title: string) => createDraft({ title, startMs: Date.parse('2026-09-01T15:00:00Z'), endMs: Date.parse('2026-09-01T16:00:00Z'), allDay: false });
    const a = mk('old removed'), b = mk('old confirmed'), c = mk('recent removed'), d = mk('old open');
    updateDraft(a.id, { state: 'removed' }); updateDraft(b.id, { state: 'confirmed' }); updateDraft(c.id, { state: 'removed' });
    appDb().prepare('UPDATE cal_drafts SET changed_at = ? WHERE id IN (?, ?, ?)').run(old, a.id, b.id, d.id);
    expect(pruneOldDrafts()).toBe(2);
    expect([getDraft(a.id), getDraft(b.id)]).toEqual([null, null]);
    expect(getDraft(c.id)).not.toBeNull();
    expect(getDraft(d.id)).not.toBeNull(); // an open draft is the person's to decide
    expect(appDb().prepare(`SELECT COUNT(*) n FROM events WHERE entity = 'cal_draft' AND op = 'delete'`).get()).toEqual({ n: 2 });
  });
  it('0/false/off/no and 1/true/on/yes, everywhere', () => {
    for (const v of ['0', 'false', 'OFF', ' no ']) expect(flagOn(v, true)).toBe(false);
    for (const v of ['1', 'true', 'On', 'yes']) expect(flagOn(v, false)).toBe(true);
    expect(flagOn('maybe', true)).toBe(true);
    expect(flagOn(undefined, false)).toBe(false);
    process.env.MWA_V2_DRAFTS = 'no';
    expect([v2DraftsOn(), classifyTool('propose_event')]).toEqual([false, 'external']);
    process.env.MWA_V2_DRAFTS = 'on';
    expect([v2DraftsOn(), classifyTool('propose_event')]).toEqual([true, 'write-local']);
    delete process.env.MWA_V2_DRAFTS;
    process.env.MWA_CALENDAR_SYNC = 'off';
    expect(calendarSyncOn()).toBe(false);
    const stop = startCalendarSync({ firstAfterMs: 0 });
    stop();
    process.env.MWA_CALENDAR_SYNC = '0';
  });
});

const ADMIN: Caller = { kind: 'session', id: 'session', scopes: new Set(ALL_SCOPES), viaCookie: true };
