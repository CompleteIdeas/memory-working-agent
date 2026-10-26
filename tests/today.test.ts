// v2 build, slice A10: Today — the home screen, the morning check-in and the evening wrap, in one read. The clock is
// frozen (Date is faked and Today's clock injected) at the prototype's days in New York; the calendar, mail and
// approvals are in-memory fakes. No model may be called: the provider module is replaced by one that throws.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { parse } from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const modelCalls = vi.hoisted(() => [] as string[]);
vi.mock('../src/provider.js', async (orig) => {
  const real = await orig<typeof import('../src/provider.js')>();
  return {
    ...real,
    getProvider: (...a: unknown[]) => { modelCalls.push(`getProvider ${String(a[0])}`); throw new Error('Today must not call a model'); },
    resolveProvider: (...a: unknown[]) => { modelCalls.push(`resolveProvider ${String(a[0])}`); throw new Error('Today must not call a model'); },
  };
});

import { createV1 } from '../src/api/router.js';
import { v1Routes } from '../src/api/v1.js';
import { ALL_SCOPES, type Caller } from '../src/api/auth.js';
import { resetAppDb, recordEvent } from '../src/v2/db.js';
import { upsertCalEvent, createDraft, updateDraft } from '../src/v2/calendar.js';
import { setSyncState } from '../src/v2/sync-state.js';
import { setCalendarSyncDeps } from '../src/sync/calendar.js';
import { setMailProviders } from '../src/sync/mail.js';
import type { MailProvider } from '../src/sync/mail-types.js';
import { createJob, claimTry, endTry } from '../src/v2/jobs.js';
import { upsertItem, itemByKey, setItemState, itemId } from '../src/v2/important.js';
import { rebuildItems, setTriageDeps } from '../src/v2/triage.js';
import { setTodayDeps, buildToday, dayBounds, weekText, markSeen, fakeNow, type ActionLite, type Today } from '../src/v2/today.js';
import { statusPill } from '../src/v2/status.js';
import { zonedToUtc, iso } from '../src/sync/tz.js';
import type { PendingView } from '../src/tools/approval.js';

const TZ = 'America/New_York';
const ACCT = 'google:me@example.com';
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const at = (day: string, hm: string, tz = TZ) => zonedToUtc(`${day}T${hm}`, tz);
const MON = '2026-11-09', TUE = '2026-11-10', THU = '2026-11-12', SUN = '2026-11-08';

// ── the contract, for every Today this file reads ──────────────────────────────────────────────────────────────
const spec = parse(readFileSync(new URL('../api/openapi.yaml', import.meta.url), 'utf8'));
const ajv = new (Ajv2020 as unknown as typeof Ajv2020.default)({ strict: false, allErrors: true });
(addFormats as unknown as typeof addFormats.default)(ajv);
ajv.addSchema({ $id: 'spec', components: spec.components });
const compile = (name: string) => ajv.compile(JSON.parse(JSON.stringify(spec.components.schemas[name]).replace(/"#\/components\//g, '"spec#/components/')));
const validToday = compile('Today'), validAck = compile('TodayAck');

// ── the world ───────────────────────────────────────────────────────────────────────────────────────────────────
let clock = 0;
let approvals: PendingView[] = [];
let actions: ActionLite[] = [];
let running = new Set<string>();
function setClock(ms: number) { clock = ms; vi.setSystemTime(ms); }

type CalState = 'ok' | 'none' | 'never' | 'reconnect' | 'stale';
function calendar(state: CalState) {
  setCalendarSyncDeps({ connected: (p) => state !== 'none' && p === 'google', accountKey: (p) => (p === 'google' ? ACCT : 'outlook'), now: () => clock, tz: () => TZ });
  if (state === 'ok') setSyncState(ACCT, 'calendar', { last_ok: clock - 10 * MIN, needs_reconnect: 0 });
  if (state === 'stale') setSyncState(ACCT, 'calendar', { last_ok: clock - 3 * HOUR, needs_reconnect: 0 });
  if (state === 'reconnect') setSyncState(ACCT, 'calendar', { last_ok: clock - HOUR, needs_reconnect: 1, last_error: 'invalid_grant' });
}
let n = 0;
function ev(day: string, start: string, end: string, title: string, id = `e${++n}`): string {
  upsertCalEvent(ACCT, 'google', { provider_id: id, start_utc: iso(at(day, start)), end_utc: iso(at(day, end)), all_day: false, title });
  return `${ACCT}:${id}`;
}
function seedMonday() {
  ev(MON, '08:15', '08:45', 'School drop-off');
  ev(MON, '10:00', '10:30', 'Call with Dana');
  ev(MON, '12:30', '13:30', 'Lunch with Sam');
  ev(MON, '16:00', '17:15', 'Riley’s soccer practice');
  ev(MON, '17:45', '18:45', 'Lesson with Ellen');
  ev(TUE, '08:15', '08:45', 'School drop-off');
  ev(TUE, '11:00', '12:00', 'Newsletter writing block');
}
function clash() {
  ev(THU, '16:00', '17:15', 'Riley’s soccer practice', 'thu-practice');
  ev(THU, '16:00', '17:00', 'Farrier at the barn', 'thu-farrier');
}
function finishedJob(title: string, endedAt: number, o: { unit?: string; person?: string; kind?: 'background' | 'recurring' } = {}) {
  const j = createJob({ kind: o.kind ?? 'background', title, request: title, person: o.person }, { trigger: 'first' });
  claimTry(j.try!.id, { now: endedAt - MIN });
  endTry(j.try!.id, { reason: 'done', outcome: 'changed', summary: 'All done.', endedAt, ...(o.unit ? { progress: { done: 12, total: 12, unit: o.unit } } : {}) });
  return j.job;
}
function waitingJob(title: string, person?: string) {
  const j = createJob({ kind: 'background', title, request: title, person, capUsd: 0.15 }, { trigger: 'first' });
  claimTry(j.try!.id, { now: clock - 2 * HOUR });
  endTry(j.try!.id, { reason: 'budget', outcome: 'changed', summary: 'Read 63 pages.', capHit: 'usd', progress: { done: 63, total: 73, unit: 'pages' }, remaining: 'pages 64-73', endedAt: clock - HOUR });
  return j.job;
}
const action = (id: string, tool: string, when: number): ActionLite => ({ id, verb: tool, tool, at: when });

// ── HTTP ────────────────────────────────────────────────────────────────────────────────────────────────────────
const OWNER: Caller = { kind: 'session', id: 'session', scopes: new Set(ALL_SCOPES), viaCookie: true };
const PHONE: Caller = { kind: 'device', id: 'dev_phone', scopes: new Set(['read', 'act', 'approve']), viaCookie: false };
let who: Caller = OWNER;
let server: Server, base = '';
let key = 0;
async function today(as: Caller = OWNER): Promise<Today> {
  who = as;
  const r = await fetch(`${base}/today`);
  expect(r.status).toBe(200);
  const body = await r.json() as Today;
  expect(validToday(body) ? null : ajv.errorsText(validToday.errors)).toBeNull();
  return body;
}
async function post(path: string, as: Caller = OWNER, body = '{}') {
  who = as;
  const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'idempotency-key': `today-key-${++key}`, 'content-type': 'application/json' }, body });
  return { status: r.status, body: await r.json() as Record<string, any> };
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  process.env.MWA_RUNLOG = 'nonexistent-a10-runs.jsonl';
  process.env.MWA_TOKEN_LOG = 'nonexistent-a10-tokens.jsonl';
  const v1 = createV1(v1Routes(), { authenticate: () => who, sameOrigin: () => true });
  server = createServer(async (req, res) => { if (!(await v1(req, res))) { res.writeHead(404); res.end(); } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
});
afterAll(() => {
  server?.close(); vi.useRealTimers(); setTodayDeps(null); setCalendarSyncDeps(null); setMailProviders(null); setTriageDeps(null);
  delete process.env.MWA_RUNLOG; delete process.env.MWA_TOKEN_LOG;
});
beforeEach(() => {
  resetAppDb(':memory:');
  approvals = []; actions = []; running = new Set(); who = OWNER;
  setClock(at(MON, '09:10'));
  setTodayDeps({
    now: () => clock, tz: () => TZ, running: () => running, pendingApprovals: () => approvals, recentActions: () => actions,
    greetingName: () => 'Robert', month: () => ({ usedUsd: 1.29, limitUsd: 20, state: 'ok' }),
  });
  setTriageDeps({ now: () => clock, tz: () => TZ, pendingApprovals: () => approvals, running: () => running, model: () => { modelCalls.push('triage model'); throw new Error('no model'); } });
  setMailProviders(() => []);
  calendar('ok');
});

describe('morning, midday and evening', () => {
  it('N05: at 7:30 the check-in counts what is below — events, what needs you, what was done overnight — and says nothing twice', async () => {
    setClock(at(SUN, '21:00')); markSeen('session');
    setClock(at(SUN, '22:00')); createDraft({ title: 'Riley — dentist', startMs: at('2026-11-11', '15:30'), endMs: at('2026-11-11', '16:15'), allDay: false, origin: 'helper' });
    setClock(at(MON, '07:30'));
    calendar('ok'); seedMonday(); clash();
    finishedJob('Gather this week’s AI news', at(MON, '03:00'));
    actions = [action('a1', 'draft_email', at(MON, '06:00'))];
    rebuildItems(clock, TZ);
    const t = await today();
    expect(t.part).toBe('morning');
    expect(t.greeting).toBe('Good morning, Robert');
    expect(t.date).toBe(MON);
    expect(t.dateLabel).toBe('Monday, November 9');
    expect(t.wrap).toBeNull();
    expect(t.checkin!.counts).toEqual({ events: 5, needsYou: 1, overnight: 3 });
    expect(t.checkin!.text).toBe('Here’s your Monday: 5 things on your calendar, 1 thing needs you, and I did 3 things overnight. It’s all below.');
    expect(t.checkin!.spoken).toContain('School drop-off at 8:15 AM, then Call with Dana at 10 AM');
    // the clash appears once: as a Needs-you card, not in the check-in text and not in Worth a look
    expect(t.needsYou.map((c) => c.kind)).toEqual(['conflict']);
    expect(t.needsYou[0].title).toBe('Thu Nov 12 at 4pm is double-booked');
    expect(t.checkin!.text).not.toMatch(/double|farrier/i);
    expect(t.worthALook.map((i) => i.id)).not.toContain(t.needsYou[0].itemId);
    // Next up: the next three, with "See your whole day" for the rest
    expect(t.nextUp.map((e) => [e.title, e.startLabel, e.soon])).toEqual([['School drop-off', '8:15 AM', 'in 45 min'], ['Call with Dana', '10 AM', null], ['Lunch with Sam', '12:30 PM', null]]);
    expect(t.nextUpMore).toBe(2);
    expect(t.agenda).toHaveLength(5);
    // Done for you: plain lines, newest first, each opening the thing in place
    expect(t.doneForYou.map((d) => d.kind)).toEqual(['reply-drafted', 'job-finished', 'draft-event']);
    expect(t.doneForYou[1].text).toBe('I finished “Gather this week’s AI news”.');
    expect(t.doneForYou[1].open.kind).toBe('job');
    expect(t.doneForYou[2].text).toBe('I added “Riley — dentist” on Wed Nov 11 at 3:30pm as a draft. Confirm it when you see it.');
    expect(t.doneForYou[2].open).toMatchObject({ kind: 'calendar', date: '2026-11-11' });
    expect(t.month).toEqual({ usedUsd: 1.29, limitUsd: 20, state: 'ok' });
  });

  it('the check-in is shown once a day: Done — show my day removes it everywhere, and it is back the next morning', async () => {
    setClock(at(MON, '07:30')); calendar('ok'); seedMonday();
    expect((await today()).checkin).not.toBeNull();
    const r = await post('/today/checkin/done');
    expect(r.status).toBe(200);
    expect(validAck(r.body) ? null : ajv.errorsText(validAck.errors)).toBeNull();
    expect(r.body.message).toBe('Morning check-in done. Have a good Monday.');
    expect(r.body.today.checkin).toBeNull();
    expect((await today()).checkin).toBeNull();
    expect((await today(PHONE)).checkin).toBeNull(); // the person did it; the phone does not ask again
    setClock(at(MON, '11:59')); expect((await today()).checkin).toBeNull();
    setClock(at(TUE, '07:30')); calendar('ok');
    const tue = await today();
    expect(tue.checkin!.text).toMatch(/^Here’s your Tuesday: 2 things on your calendar/);
  });

  it('no check-in before 5:00 or from noon; midday has neither card', async () => {
    seedMonday();
    setClock(at(MON, '04:59')); calendar('ok');
    let t = await today();
    expect([t.part, t.checkin, t.wrap]).toEqual(['night', null, null]);
    setClock(at(MON, '12:00')); calendar('ok');
    t = await today();
    expect([t.part, t.checkin, t.wrap, t.greeting]).toEqual(['afternoon', null, null, 'Good afternoon, Robert']);
    setClock(at(MON, '13:00')); calendar('ok');
    t = await today();
    expect(t.nextUp[0]).toMatchObject({ title: 'Lunch with Sam', soon: 'Now' }); // still going
    expect(t.nextUp.map((e) => e.title)).toEqual(['Lunch with Sam', 'Riley’s soccer practice', 'Lesson with Ellen']);
  });

  it('N09: from 17:00 the wrap says what got done today and how tomorrow starts; Good night removes it', async () => {
    seedMonday();
    setClock(at(MON, '09:00'));
    const d = createDraft({ title: 'Book fair', startMs: at('2026-11-14', '15:00'), endMs: at('2026-11-14', '18:00'), allDay: false, origin: 'you' });
    updateDraft(d.id, { state: 'confirmed', confirmed_at: at(MON, '09:05') });
    actions = [action('r1', 'draft_email', at(MON, '10:00')), action('r2', 'draft_outlook', at(MON, '14:00')), action('old', 'draft_email', at(SUN, '14:00'))];
    setClock(at(MON, '16:59')); calendar('ok');
    expect((await today()).wrap).toBeNull();
    setClock(at(MON, '18:20')); calendar('ok');
    const t = await today();
    expect(t.part).toBe('evening');
    expect(t.greeting).toBe('Good evening, Robert');
    expect(t.checkin).toBeNull();
    expect(t.wrap!.title).toBe('That’s Monday');
    expect(t.wrap!.lines).toEqual(['You confirmed 1 event and I drafted 2 replies today.', 'Tomorrow starts with School drop-off at 8:15 AM, then Newsletter writing block at 11 AM.']);
    expect(t.wrap!.counts).toEqual({ eventsConfirmed: 1, repliesDrafted: 2, jobsFinished: 0, doneToday: 3 });
    const r = await post('/today/wrap/done');
    expect(r.body.message).toBe('See you in the morning.');
    expect(r.body.today.wrap).toBeNull();
    expect((await today(PHONE)).wrap).toBeNull();
  });

  it('no wrap on a day with no activity, and an honest tomorrow line when the calendar is unknown', async () => {
    setClock(at(MON, '18:20')); calendar('ok'); seedMonday();
    expect((await today()).wrap).toBeNull();
    actions = [action('r1', 'draft_email', at(MON, '10:00'))];
    setTodayDeps({ now: () => clock, tz: () => TZ, pendingApprovals: () => approvals, recentActions: () => actions, greetingName: () => null, month: () => ({ usedUsd: 0, limitUsd: null, state: 'none' }) });
    resetAppDb(':memory:'); calendar('never');
    const t = await today();
    expect(t.greeting).toBe('Good evening');
    expect(t.wrap!.lines).toEqual(['I drafted 1 reply today.', "I can't see tomorrow's calendar yet."]);
  });
});

describe('Needs you', () => {
  it('a double-booking shown as a card is not repeated in Worth a look; a second one stays there, and a dismissed one is not a card', async () => {
    clash();
    ev('2026-11-13', '09:00', '10:00', 'Vet visit', 'fri-a');
    ev('2026-11-13', '09:30', '10:30', 'Dentist call', 'fri-b');
    rebuildItems(clock, TZ); // (its mail pass would retire a mail item no synced message backs, so that comes after)
    upsertItem({ source: 'mail', dedupeKey: 'mail:m_ellen', ts: clock - HOUR, from: 'Coach Ellen', title: 'Saturday schooling — are you in?', why: 'From someone you know.', trust: 'untrusted' }, TZ, clock);
    let t = await today();
    const card = t.needsYou.find((c) => c.kind === 'conflict')!;
    expect(card.count).toBe(2);
    expect(card.text).toBe('Farrier at the barn and Riley’s soccer practice overlap. 1 more double-booking in the next two weeks.');
    expect(card.itemId).toBeTruthy();
    expect(card.open).toMatchObject({ kind: 'item', id: card.itemId, date: THU });
    const worth = t.worthALook.map((i) => i.id);
    expect(worth).not.toContain(card.itemId);
    expect(t.worthALook.some((i) => i.source === 'calendar-conflict')).toBe(true); // Friday's, not shown as a card
    expect(worth).toContain(itemByKey('mail:m_ellen')!.id);
    expect(t.worthALookTotal).toBe(3);
    // the person handled Thursday's: the card moves to Friday's
    setItemState(card.itemId!, 'handled', clock);
    t = await today();
    const next = t.needsYou.find((c) => c.kind === 'conflict')!;
    expect(next.title).toBe('Fri Nov 13 at 9:30am is double-booked');
    expect(next.count).toBe(1);
    expect(t.worthALook.some((i) => i.source === 'calendar-conflict')).toBe(false);
  });

  it('a phishing-flagged item never becomes a Needs-you card (it stays on the list with its caution)', async () => {
    approvals = [
      { id: 'ap_phish', tool: 'http_request', summary: 'Pay the overdue invoice', expiresInSec: 600, expiresAt: clock + 600_000, tainted: true, readLocal: false, kind: 'tool', createdAt: clock - 2 * HOUR },
      { id: 'ap_ok', tool: 'write_file', summary: 'Save the file report.txt', expiresInSec: 600, expiresAt: clock + 600_000, tainted: false, readLocal: false, kind: 'tool', createdAt: clock - HOUR },
    ];
    upsertItem({ source: 'approval', sourceRef: 'ap_phish', dedupeKey: 'approval:ap_phish', ts: clock - 2 * HOUR, from: 'Your helper', title: 'Pay the overdue invoice', trust: 'untrusted', caution: 'phishing' }, TZ, clock);
    upsertItem({ source: 'mail', dedupeKey: 'mail:m_phish', ts: clock - 30 * MIN, from: 'PayPal', fromAddr: 'security@paypa1-alerts.example', title: 'Your account is locked — act now', why: "Sent from security@paypa1-alerts.example. Don't use its links.", trust: 'untrusted', caution: 'phishing', action: { kind: 'review-reply', payload: { mailId: 'm_phish' } } }, TZ, clock);
    const t = await today();
    expect(t.needsYou).toHaveLength(1);
    expect(t.needsYou[0]).toMatchObject({ kind: 'approval', count: 1, title: 'Save the file report.txt', open: { kind: 'approval', id: 'ap_ok' } });
    const cards = JSON.stringify(t.needsYou);
    expect(cards).not.toMatch(/paypa1|locked|invoice|ap_phish/i);
    expect(t.worthALook.find((i) => i.caution === 'phishing')!.title).toBe('Your account is locked — act now');
  });

  it('jobs waiting for you and accounts to reconnect: one card each, with a count', async () => {
    waitingJob('Learn the USEF eventing rules');
    waitingJob('Read the stewards manual');
    setSyncState('imap:me@gmail.com', 'mail', { needs_reconnect: 1, last_ok: clock - DAY });
    calendar('reconnect');
    const t = await today();
    const jobs = t.needsYou.find((c) => c.kind === 'job')!;
    expect(jobs).toMatchObject({ count: 2, title: '2 jobs are waiting for you', open: { kind: 'jobs', id: 'waiting' } });
    const re = t.needsYou.find((c) => c.kind === 'reconnect')!;
    expect(re).toMatchObject({ count: 1, title: 'Google Calendar needs to be reconnected', open: { kind: 'reconnect', id: ACCT, resource: 'calendar' } });
    expect(t.status).toEqual({ text: '2 waiting for you', tone: 'needs', working: 0, waiting: 2, ready: 0 });
  });
});

describe('freshness: a day that is not known is not a free day', () => {
  it('not connected, never synced, needs reconnecting, stale, fine', async () => {
    seedMonday();
    calendar('none');
    let t = await today();
    expect([t.freshness.calendar, t.nextUp, t.freshness.calendarAsOf]).toEqual(['not_connected', [], null]);
    expect(t.freshness.calendarNote).toBe("Your calendar isn't connected, so I can't show what's next.");

    resetAppDb(':memory:'); seedMonday(); calendar('never');
    setClock(at(MON, '07:30'));
    t = await today();
    expect(t.freshness.calendar).toBe('not_synced');
    expect(t.nextUp).toEqual([]);
    expect(t.freshness.calendarNote).toMatch(/hasn't synced yet.*doesn't mean your day is free/);
    expect(t.checkin!.text).toMatch(/^Here’s your Monday: I can't see your calendar yet, nothing needs you/);

    resetAppDb(':memory:'); seedMonday(); setClock(at(MON, '09:10')); calendar('reconnect');
    t = await today();
    expect(t.freshness.calendar).toBe('reconnect');
    expect(t.nextUp.map((e) => e.title)[0]).toBe('Call with Dana'); // what was cached, said to be possibly out of date
    expect(t.freshness.calendarNote).toBe('Google Calendar needs to be reconnected, so your day may be out of date (last updated 8:10 AM).');
    expect(t.freshness.needsReconnect).toEqual([{ account: ACCT, resource: 'calendar', label: 'Google Calendar' }]);

    resetAppDb(':memory:'); seedMonday(); calendar('stale');
    t = await today();
    expect([t.freshness.calendar, t.freshness.calendarNote, t.freshness.calendarAsOf]).toEqual(['stale', 'Your calendar was last updated 6:10 AM.', clock - 3 * HOUR]);

    resetAppDb(':memory:'); seedMonday(); calendar('ok');
    t = await today();
    expect([t.freshness.calendar, t.freshness.calendarNote]).toEqual(['ok', null]);
  });

  it('mail: not connected, then synced', async () => {
    let t = await today();
    expect([t.freshness.mail, t.freshness.mailAsOf]).toEqual(['not_connected', null]);
    const fake = { prefix: 'google', provider: 'gmail', label: 'Gmail', resolveAccount: async () => 'google:me@example.com' } as unknown as MailProvider;
    setMailProviders(() => [fake]);
    setSyncState('google', 'mail', { last_ok: clock - 5 * MIN });
    t = await today();
    expect([t.freshness.mail, t.freshness.mailAsOf]).toEqual(['ok', clock - 5 * MIN]);
  });
});

describe('Done for you, since the person last looked', () => {
  it('lists what came after "seen", per caller', async () => {
    setClock(at(MON, '06:00')); finishedJob('Sort the receipts', clock);
    setClock(at(MON, '07:00')); createDraft({ title: 'Farrier', startMs: at(THU, '17:30'), endMs: at(THU, '18:00'), allDay: false, origin: 'helper', suggestedAfterOutside: true });
    actions = [action('a1', 'draft_email', at(MON, '08:00')), action('a2', 'browser_open', at(MON, '08:01')), action('a3', 'send_email', at(MON, '08:30'))];
    setClock(at(MON, '09:00'));
    let t = await today();
    expect(t.doneForYou.map((d) => d.kind)).toEqual(['email-sent', 'reply-drafted', 'draft-event']); // a read is not "done for you"
    expect(t.doneMore).toBe(1);
    expect(t.doneForYou[2].trust).toBe('untrusted'); // proposed after reading outside content
    expect(t.doneSince).toBe(clock - DAY); // a first look: the last day
    const r = await post('/today/seen');
    expect(r.body.seenAt).toBe(clock);
    setClock(at(MON, '10:00')); const j = finishedJob('Find three AI stories', clock);
    setClock(at(MON, '10:05'));
    t = await today();
    expect(t.doneForYou.map((d) => d.text)).toEqual(['I finished “Find three AI stories”.']);
    expect(t.doneForYou[0].open).toEqual({ kind: 'job', id: j.id });
    // the phone has not looked: it still has everything
    expect((await today(PHONE)).doneForYou.length).toBe(3);
    expect((await today(PHONE)).doneMore).toBe(2);
    // a reminder set
    const rem = createJob({ kind: 'reminder', title: 'Enter Stable View', nextDueAt: at('2026-11-13', '09:00') });
    t = await today();
    expect(t.doneForYou[0]).toMatchObject({ kind: 'reminder', text: 'I set a reminder: “Enter Stable View”, Fri Nov 13 at 9am.', open: { kind: 'job', id: rem.job.id } });
  });
});

describe('the week line', () => {
  it('counts the last seven days, honestly', async () => {
    for (const [i, ago] of [[1, DAY], [2, 3 * DAY], [3, 8 * DAY]] as const) {
      setClock(at(MON, '09:10') - ago - HOUR);
      const d = createDraft({ title: `Event ${i}`, startMs: clock + DAY, endMs: clock + DAY + HOUR, allDay: false });
      updateDraft(d.id, { state: 'confirmed', confirmed_at: clock });
    }
    setClock(at(MON, '09:10'));
    actions = [action('a', 'draft_email', clock - HOUR), action('b', 'draft_outlook', clock - 2 * DAY), action('c', 'draft_email', clock - 6 * DAY), action('d', 'draft_email', clock - 9 * DAY), action('e', 'send_email', clock - HOUR)];
    finishedJob('Learn the rules PDF', clock - 2 * DAY, { unit: 'pages' });
    finishedJob('Compare gutter quotes', clock - DAY);
    finishedJob('Old job', clock - 10 * DAY);
    finishedJob('Price watch', clock - DAY, { kind: 'recurring' });
    const t = await today();
    expect(t.weekLine.counts).toEqual({ repliesDrafted: 3, eventsAdded: 2, documentsLearned: 1, jobsFinished: 2 });
    expect(t.weekLine.text).toBe('This week: 3 replies drafted, 2 events added, 1 document learned, 2 jobs finished.');
  });
  it('an empty week says so', () => {
    expect(weekText({ repliesDrafted: 0, eventsAdded: 0, documentsLearned: 0, jobsFinished: 0 })).toBe('This week: nothing yet — I’ll keep count here.');
  });
});

describe('time zone and daylight saving', () => {
  it('Sunday Nov 1 2026 in New York is 25 hours long; its events are its own', async () => {
    const b = dayBounds(Date.UTC(2026, 10, 1, 13), TZ);
    expect([b.day, iso(b.start), iso(b.end), (b.end - b.start) / HOUR]).toEqual(['2026-11-01', '2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z', 25]);
    const spring = dayBounds(Date.UTC(2026, 2, 8, 17), TZ);
    expect((spring.end - spring.start) / HOUR).toBe(23);
    const ids = {
      prev: '2026-11-01T03:30:00.000Z', // Sat Oct 31 11:30 PM EDT
      early: '2026-11-01T04:30:00.000Z', // Sun 12:30 AM EDT
      repeat: '2026-11-01T06:30:00.000Z', // Sun 1:30 AM EST (the repeated hour)
      late: '2026-11-02T04:30:00.000Z', // Sun 11:30 PM EST
      next: '2026-11-02T05:30:00.000Z', // Mon 12:30 AM EST
    };
    for (const [id, s] of Object.entries(ids)) upsertCalEvent(ACCT, 'google', { provider_id: id, start_utc: s, end_utc: new Date(Date.parse(s) + 30 * MIN).toISOString(), all_day: false, title: id });
    setClock(Date.UTC(2026, 10, 1, 9, 50)); calendar('ok'); // 4:50 AM EST (5:50 by the summer offset)
    let t = await today();
    expect([t.date, t.weekday, t.checkin, t.part]).toEqual(['2026-11-01', 'Sunday', null, 'night']);
    expect(t.agenda.map((x) => x.title)).toEqual(['early', 'repeat', 'late']);
    setClock(Date.UTC(2026, 10, 1, 10, 10)); calendar('ok'); // 5:10 AM EST
    t = await today();
    expect(t.checkin!.text).toMatch(/^Here’s your Sunday: 3 things on your calendar/);
    setClock(Date.UTC(2026, 10, 2, 3)); calendar('ok'); // 10 PM EST
    t = await today();
    expect(t.nextUp.map((e) => [e.title, e.startLabel])).toEqual([['late', '11:30 PM']]);
  });
  it('MWA_FAKE_NOW freezes the clock (ISO or ms); anything else is ignored', () => {
    expect(fakeNow({ MWA_FAKE_NOW: '2026-11-09T14:10:00Z' })).toBe(Date.UTC(2026, 10, 9, 14, 10));
    expect(fakeNow({ MWA_FAKE_NOW: String(Date.UTC(2026, 10, 9)) })).toBe(Date.UTC(2026, 10, 9));
    expect(fakeNow({ MWA_FAKE_NOW: 'tomorrow' })).toBeNull();
    expect(fakeNow({})).toBeNull();
  });
});

describe('ownership: only the owner’s data', () => {
  it('another person’s jobs, approvals and items are not counted or shown; a phone sees the owner’s', async () => {
    waitingJob('Owner job');
    waitingJob('Contact job', 'tg-999');
    finishedJob('Contact finished', clock - HOUR, { person: 'tg-999' });
    approvals = [
      { id: 'ap_contact', tool: 'send_email', summary: 'Email the contact list', expiresInSec: 600, expiresAt: clock + 600_000, tainted: false, readLocal: false, kind: 'tool', createdAt: clock - HOUR, personId: 'tg-999' },
      { id: 'ap_owner', tool: 'write_file', summary: 'Save notes.md', expiresInSec: 600, expiresAt: clock + 600_000, tainted: false, readLocal: false, kind: 'tool', createdAt: clock - HOUR, personId: 'web-robert' },
    ];
    upsertItem({ source: 'job-result', dedupeKey: 'job:x', ts: clock - HOUR, from: 'Your helper', title: 'Ready: contact thing', trust: 'trusted', person: 'tg-999' }, TZ, clock);
    upsertItem({ source: 'mail', dedupeKey: 'mail:m_owner', ts: clock - HOUR, from: 'Dana', title: 'Top 3 stories?', trust: 'untrusted' }, TZ, clock);
    for (const as of [OWNER, PHONE]) {
      const t = await today(as);
      const text = JSON.stringify(t);
      expect(text).not.toMatch(/Contact job|Contact finished|contact list|ap_contact|contact thing/);
      expect(t.needsYou.map((c) => [c.kind, c.title])).toEqual([['approval', 'Save notes.md'], ['job', 'Owner job']]);
      expect(t.status.waiting).toBe(1);
      expect(t.worthALookTotal).toBe(1);
    }
  });
});

describe('the status pill', () => {
  it('is one computation: working, waiting for you, results ready', async () => {
    expect(statusPill([])).toEqual({ text: 'Helper is resting', tone: 'resting', working: 0, waiting: 0, ready: 0 });
    expect(statusPill([{ state: 'working' }]).text).toBe('Working on 1 thing');
    expect(statusPill([{ state: 'working' }, { state: 'continuing' }]).text).toBe('Working on 2 things');
    expect(statusPill([{ state: 'working' }, { state: 'waiting' }, { state: 'done', resultReady: true }])).toEqual({ text: 'Working on 1 · 1 waiting for you · 1 result ready', tone: 'needs', working: 1, waiting: 1, ready: 1 });
    createJob({ kind: 'live', title: 'Gathering AI news' }, { trigger: 'first', state: 'running', liveKey: 'live-1' });
    running = new Set(['live-1']);
    waitingJob('Learn the rules');
    finishedJob('Gutter quotes', clock - HOUR);
    expect((await today()).status.text).toBe('Working on 1 · 1 waiting for you · 1 result ready');
  });
});

describe('/sync and the stream', () => {
  it('/sync has a today collection: in a snapshot always, in a delta when something it is made of changed', async () => {
    who = OWNER;
    recordEvent({ entity: 'device', id: 'dev_first' }); // a cursor above 0: a later since= is a delta, not a snapshot
    const snap = await (await fetch(`${base}/sync?collections=today`)).json() as { cursor: number; upserts: { today: Today[] } };
    expect(snap.upserts.today).toHaveLength(1);
    expect(snap.upserts.today[0].id).toBe('today');
    recordEvent({ entity: 'device', id: 'dev_x' });
    const quiet = await (await fetch(`${base}/sync?since=${snap.cursor}&collections=today`)).json() as { cursor: number; upserts: { today: Today[] } };
    expect(quiet.upserts.today).toEqual([]);
    finishedJob('A new result', clock - MIN);
    const moved = await (await fetch(`${base}/sync?since=${quiet.cursor}&collections=today`)).json() as { upserts: { today: Today[] } };
    expect(moved.upserts.today).toHaveLength(1);
    expect(moved.upserts.today[0].doneForYou[0].text).toBe('I finished “A new result”.');
  });

  it('the stream sends a coarse "today changed" notice', async () => {
    who = OWNER;
    const ctl = new AbortController();
    const r = await fetch(`${base}/stream`, { signal: ctl.signal });
    const reader = r.body!.getReader();
    const dec = new TextDecoder();
    let text = '';
    finishedJob('Something changed', clock - MIN);
    const until = performance.now() + 5_000;
    let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
    while (!text.includes('"entity":"today"') && performance.now() < until) {
      pending ??= reader.read();
      const got = await Promise.race([pending, new Promise<null>((res) => setTimeout(() => res(null), 500))]);
      if (!got) continue;
      pending = null;
      if (got.value) text += dec.decode(got.value);
      if (got.done) break;
    }
    ctl.abort();
    expect(text).toMatch(/event: change\ndata: \{"seq":\d+,"entity":"today","id":"today","op":"upsert"\}/);
  });
});

describe('no model calls', () => {
  it('Today, the marks and /sync never reach a model (the provider stub throws, and was never called)', async () => {
    setClock(at(MON, '07:30')); calendar('ok'); seedMonday(); clash();
    actions = [action('a1', 'draft_email', clock - HOUR)];
    await today(); await post('/today/seen'); await post('/today/checkin/done'); await post('/today/wrap/done');
    await buildToday('device:x');
    await (await fetch(`${base}/sync?collections=today`)).json();
    expect(modelCalls).toEqual([]);
  });
});
