/**
 * Today (v2 build, slice A10, 2026-10-26): the home screen, the morning check-in and the evening wrap, in one read.
 *
 * GET /api/v1/today composes what the other slices keep — no model call, no network, nothing written:
 *   - needsYou   at most one card each: approvals waiting, jobs waiting for the person, the next double-booking, an
 *                account to reconnect. Built from those sources, never from mail, so a phishing-flagged message can
 *                never be one; a card whose Important item carries the phishing caution is dropped as well.
 *   - nextUp     today's remaining events (timed, from the calendar cache, in the person's zone), at most three; the
 *                whole local day is in `agenda` for the desktop's right-hand column. A calendar that is not connected,
 *                never synced (each calendar by name) or needs reconnecting is SAID (freshness), never shown as a free
 *                or complete day.
 *   - doneForYou what the helper did since this caller last looked (POST /today/seen): drafts it made, events added,
 *                jobs finished, reminders set, and the actions it took (app.db `actions`, src/v2/actions.ts — one row
 *                per action; the AWM action log merges similar entries and cannot be counted), as plain sentences
 *                that open the thing in place. Each draft is said once, as it stands now.
 *   - worthALook the top three open Important items, minus what a Needs-you card already shows.
 *   - checkin    05:00–12:00 local, until the person taps "Done — show my day" (POST /today/checkin/done): counts only.
 *   - wrap       from 17:00 local when the day had activity, until "Good night" (POST /today/wrap/done).
 *   - weekLine   counts over the last seven days (replies drafted, events added, documents learned, jobs finished).
 *   - month      spend so far against the monthly budget (billing.ts), memoised for a minute.
 *   - status     the pill (src/v2/pill.ts statusPill — the one the web app uses too).
 *
 * Words the helper SAYS (the check-in, the wrap, "Read it to me") never carry text that came from outside — an
 * invitation's title, a staged action's summary — as the helper's own: spoken text is counts and times only, and a
 * title shown in the wrap is quoted as "an event called “…”" (60 characters, filtered) with `trust: untrusted`.
 * Every line and card also comes as PARTS (W2 review): `[{text, outside}]`, the outside ones filtered (plainWhy) with
 * any quote marks inside them made plain, so a screen renders someone else's words as theirs without ever parsing
 * quotes out of a string (a title holding "”" could otherwise break out of its quote). `text` stays for older clients.
 *
 * Ownership: every v1 caller acts for the owner (jobs.ts ownerOwns), so another person's jobs, items, approvals and
 * actions are never counted or shown. "Last looked" is per caller (the password session, this machine, each paired
 * device); the check-in and the wrap are the person's, so dismissing one on the phone dismisses it everywhere.
 *
 * Time: the person's zone is the calendar's (MWA_TZ, else the machine's); day boundaries are real local midnights, so
 * a day across a clock change is 23 or 25 hours. MWA_FAKE_NOW (ISO or ms) freezes the clock ONLY under a test run
 * (NODE_ENV=test or VITEST); a stored "last looked" is never later than the real clock.
 */
import { createHash } from 'node:crypto';
import { appDb, recordEvent, registerMigrations } from './db.js';
import { calendarItems, type CalDraftRow, type CalendarItem } from './calendar.js';
import { findConflicts } from '../sync/conflicts.js';
import { calendarAccounts, calendarNow, calendarTz } from '../sync/calendar.js';
import { mailAccounts } from '../sync/mail.js';
import { listJobs, viewJobs, ownerOwns, type JobView } from './jobs.js';
import { statusPill, type StatusPill } from './pill.js';
import { itemId, apiItem, visibleItem, phishingSource, type ApiItem, type ItemRow } from './important.js';
import { atLabel, plainWhy } from './triage.js';
import { actionsBetween, type ActionRow } from './actions.js';
import { billingSummary, readCalls, monthStart, monthlyBudget, tokenLogPath } from '../billing.js';
import { localDate, localMidnight, addDays, zonedToUtc, iso } from '../sync/tz.js';
import { listPendingActions, type PendingView } from '../tools/approval.js';
import { existsSync, readFileSync } from 'node:fs';
import { configPath } from '../config.js';

registerMigrations([{
  name: '011-today',
  sql: `
    -- when each caller (session, local, device:<id>) last looked at Today: "Done for you" lists what came after
    CREATE TABLE IF NOT EXISTS today_seen (caller TEXT PRIMARY KEY, seen_at INTEGER NOT NULL);
    -- the person's own dismissals, one per kind ('checkin', 'wrap'), for the local day they were made on
    CREATE TABLE IF NOT EXISTS today_marks (what TEXT PRIMARY KEY CHECK (what IN ('checkin','wrap')), day TEXT NOT NULL, at INTEGER NOT NULL);`,
}]);

export const CHECKIN_FROM_MIN = 5 * 60, CHECKIN_UNTIL_MIN = 12 * 60, WRAP_FROM_MIN = 17 * 60;
export const NEXT_UP_MAX = 3, DONE_MAX = 3, WORTH_MAX = 3;
/** "Done for you" looks back at most this far (and 24 hours for a caller that never looked). */
export const DONE_LOOKBACK_MS = 7 * 86_400_000;
export const FIRST_LOOK_MS = 24 * 3_600_000;
export const CALENDAR_STALE_MS = 2 * 3_600_000, MAIL_STALE_MS = 3_600_000;
/** A title quoted in the wrap: at most this long. */
export const QUOTE_MAX = 60;
const MONTH_TTL_MS = 60_000;
const CONFLICT_AHEAD_MS = 14 * 86_400_000;

// ── dependencies ────────────────────────────────────────────────────────────────────────────────────────────────

export interface MonthLine { usedUsd: number; limitUsd: number | null; state: 'none' | 'ok' | 'warn' | 'over' }
export interface TodayDeps {
  now: () => number;
  tz: () => string;
  /** live keys of the runs going now (job status) */
  running: () => Set<string>;
  /** approvals waiting for the person */
  pendingApprovals: () => PendingView[];
  /** the name in the greeting ("Good morning, Robert"), or null */
  greetingName: () => string | null;
  /** this month's spend and budget */
  month: (now: number) => MonthLine;
}

/**
 * MWA_FAKE_NOW: an ISO time or epoch ms, for replays with a frozen clock — honoured ONLY under a test run (VITEST or
 * NODE_ENV=test). A running server ignores it: a fake clock there would stamp "last looked" in the future and hide
 * real work (A10 review M2). Anything that is not a time is ignored.
 */
export function fakeNow(env: NodeJS.ProcessEnv = process.env): number | null {
  if (!env.VITEST && env.NODE_ENV !== 'test') return null;
  const v = String(env.MWA_FAKE_NOW ?? '').trim();
  if (!v) return null;
  const n = /^\d{10,15}$/.test(v) ? Number(v) : Date.parse(v);
  return Number.isFinite(n) ? n : null;
}

/** The owner's name: MWA_OWNER_NAME, else `owner.name` in mwa.config.json, else none. */
function defaultGreetingName(): string | null {
  // W5 security review: only text counts as a name (an array or object in the settings file is ignored)
  const clean = (s: unknown) => (typeof s === 'string' ? s : '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || null;
  if (process.env.MWA_OWNER_NAME?.trim()) return clean(process.env.MWA_OWNER_NAME);
  try { if (existsSync(configPath())) return clean((JSON.parse(readFileSync(configPath(), 'utf8')) as { owner?: { name?: unknown } }).owner?.name); } catch { /* not JSON */ }
  return null;
}
function defaultMonth(now: number): MonthLine {
  const s = billingSummary(readCalls(tokenLogPath(), monthStart(now)), now, monthlyBudget().usd);
  return { usedUsd: s.budget.usedUsd, limitUsd: s.budget.monthlyUsd, state: s.budget.state };
}

const DEFAULT_DEPS: TodayDeps = {
  now: () => fakeNow() ?? calendarNow(), tz: () => calendarTz(), running: () => new Set(),
  pendingApprovals: () => { try { return listPendingActions(); } catch { return []; } },
  greetingName: defaultGreetingName, month: defaultMonth,
};
let deps: TodayDeps = DEFAULT_DEPS;
/** serve and tests: replace parts (null restores the defaults). Forgets the memoised month and conflicts. */
export function setTodayDeps(d: Partial<TodayDeps> | null): void {
  deps = d ? { ...DEFAULT_DEPS, ...d } : DEFAULT_DEPS;
  monthMemo = null; conflictMemo = null;
}
export const todayNow = (): number => deps.now();
export const todayTz = (): string => deps.tz();

let monthMemo: { at: number; key: string; value: MonthLine } | null = null;
function monthLine(now: number): MonthLine {
  const key = String(monthStart(now));
  if (monthMemo && monthMemo.key === key && Math.abs(now - monthMemo.at) < MONTH_TTL_MS) return monthMemo.value;
  let value: MonthLine;
  try { value = deps.month(now); } catch { value = { usedUsd: 0, limitUsd: null, state: 'none' }; }
  monthMemo = { at: now, key, value };
  return value;
}

// ── time in the person's zone ───────────────────────────────────────────────────────────────────────────────────

const hm = new Map<string, Intl.DateTimeFormat>();
/** Minutes since local midnight (wall clock): 7:30 AM → 450. */
export function localMinutes(ms: number, tz: string): number {
  let f = hm.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); hm.set(tz, f); }
  const p = Object.fromEntries(f.formatToParts(ms).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
  return (p.hour ?? 0) * 60 + (p.minute ?? 0);
}
/** [start, end) of the local day holding `ms`: real midnights (23 or 25 hours across a clock change). */
export function dayBounds(ms: number, tz: string): { day: string; start: number; end: number } {
  const day = localDate(ms, tz);
  return { day, start: localMidnight(day, tz), end: localMidnight(addDays(day, 1), tz) };
}
const weekdayOf = (day: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' }).format(new Date(`${day}T12:00:00Z`));
const dateLabelOf = (day: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(`${day}T12:00:00Z`));
/** "8:15 AM", "11 AM" in the zone. */
export function clockLabel(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(ms).replace(/ /g, ' ').replace(/:00(?=\s)/, '');
}
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** One piece of a line: the helper's own words, or words that came from outside (a title, a summary, a why). */
export interface Part { text: string; outside: boolean }
const QUOTE_MARKS = /[“”„‟"«»]/g;
/** Outside words: filtered, and any quote mark inside made plain (it can never close the quote it is shown in). */
export const outsidePart = (s: string, max = 80): Part => ({ text: (plainWhy(s, max) || 'untitled').replace(QUOTE_MARKS, "'"), outside: true });
const ours = (text: string): Part => ({ text, outside: false });
/** The flat text older clients show: outside parts in typographic quotes, or as they are (`bare`: a card's words). */
export const flatText = (parts: Part[], bare = false): string => parts.map((p) => (p.outside && !bare ? `“${p.text}”` : p.text)).join('');
/** The part of the day: night (before 5), morning (to noon), afternoon (to 17:00), evening. */
const partOf = (mins: number): 'night' | 'morning' | 'afternoon' | 'evening' => (mins < CHECKIN_FROM_MIN ? 'night' : mins < CHECKIN_UNTIL_MIN ? 'morning' : mins < WRAP_FROM_MIN ? 'afternoon' : 'evening');

// ── shapes (api/openapi.yaml Today) ─────────────────────────────────────────────────────────────────────────────

/** Where a line or card opens: the kind of thing and its id (plus the day, for the calendar). */
export interface OpenRef { kind: 'job' | 'jobs' | 'approval' | 'approvals' | 'calendar' | 'item' | 'reconnect' | 'activity' | 'mail'; id: string | null; date?: string; resource?: string }
export interface NeedCard {
  id: string; kind: 'approval' | 'job' | 'conflict' | 'reconnect'; count: number; title: string; text: string;
  /** the same as parts: what came from outside is marked (an approval's summary, a tainted job's title, event titles) */
  titleParts: Part[]; textParts: Part[];
  action: { label: string; kind: string } | null; open: OpenRef; itemId: string | null; trust: 'trusted' | 'untrusted';
}
export interface NextUp { id: string; kind: 'event' | 'draft'; title: string; start: string; end: string; location: string | null; startLabel: string; soon: string | null }
export interface DoneLine { id: string; kind: 'draft-event' | 'event-added' | 'job-finished' | 'reminder' | 'reply-drafted' | 'email-sent' | 'file-saved' | 'preference'; text: string; parts: Part[]; at: number; open: OpenRef; trust: 'trusted' | 'untrusted' }
export interface WeekCounts { repliesDrafted: number; eventsAdded: number; documentsLearned: number; jobsFinished: number }
export type Freshness = 'ok' | 'stale' | 'partial' | 'not_synced' | 'reconnect' | 'not_connected';
export interface Today {
  id: 'today'; date: string; weekday: string; dateLabel: string; tz: string; now: number;
  greetingName: string | null; greeting: string; part: 'morning' | 'afternoon' | 'evening' | 'night';
  checkin: { title: string; text: string; spoken: string; trust: 'trusted' | 'untrusted'; counts: { events: number; needsYou: number; overnight: number } } | null;
  wrap: { title: string; lines: string[]; lineParts: Part[][]; spoken: string; trust: 'trusted' | 'untrusted'; counts: { eventsConfirmed: number; repliesDrafted: number; jobsFinished: number; doneToday: number } } | null;
  needsYou: NeedCard[];
  nextUp: NextUp[]; nextUpMore: number; agenda: CalendarItem[];
  doneForYou: DoneLine[]; doneMore: number; doneSince: number;
  worthALook: ApiItem[]; worthALookTotal: number;
  weekLine: { text: string; counts: WeekCounts };
  month: MonthLine;
  status: StatusPill;
  freshness: {
    calendarAsOf: number | null; mailAsOf: number | null; calendar: Freshness; mail: Freshness;
    calendarNote: string | null; mailNote: string | null;
    needsReconnect: { account: string; resource: 'calendar' | 'mail'; label: string }[];
  };
}

// ── "last looked", the check-in and the wrap ────────────────────────────────────────────────────────────────────

/**
 * When this caller last looked. A mark later than the real clock was stamped by a wrong clock (an old fake clock):
 * it is not believed — read as "never looked", so it cannot hide work — and the next look replaces it.
 */
export function lastSeen(caller: string): number | null {
  const v = (appDb().prepare('SELECT seen_at FROM today_seen WHERE caller = ?').get(caller) as { seen_at: number } | undefined)?.seen_at;
  return v == null || v > Date.now() ? null : v;
}
/** The caller looked at Today now. Per caller: the phone looking does not empty the desktop's "Done for you". */
export function markSeen(caller: string, now = deps.now()): number {
  const at = Math.round(Math.min(now, Date.now()));
  // a later look moves the mark forward; one stored ahead of the real clock (an old fake clock) is pulled back
  appDb().prepare(`INSERT INTO today_seen (caller, seen_at) VALUES (@c, @at) ON CONFLICT (caller) DO UPDATE SET
    seen_at = CASE WHEN today_seen.seen_at > @real THEN @at ELSE MAX(today_seen.seen_at, @at) END`).run({ c: caller, at, real: Date.now() });
  return lastSeen(caller)!;
}
function markDay(what: 'checkin' | 'wrap'): string | null {
  return (appDb().prepare('SELECT day FROM today_marks WHERE what = ?').get(what) as { day: string } | undefined)?.day ?? null;
}
/** The person dismissed the check-in or the wrap for today (everywhere: the stream tells their other devices). */
export function markDone(what: 'checkin' | 'wrap', now = deps.now(), tz = deps.tz()): string {
  const d = appDb();
  const day = localDate(now, tz);
  d.transaction(() => {
    d.prepare('INSERT INTO today_marks (what, day, at) VALUES (?, ?, ?) ON CONFLICT (what) DO UPDATE SET day = excluded.day, at = excluded.at').run(what, day, Math.round(now));
    recordEvent({ entity: 'today', id: 'today', payload: { [what]: day } }, d);
  })();
  return day;
}

// ── the parts ───────────────────────────────────────────────────────────────────────────────────────────────────

const ACCOUNT_LABEL = (account: string, resource: string): string => {
  const p = account.split(':')[0];
  if (resource === 'calendar') return p === 'outlook' ? 'Outlook Calendar' : 'Google Calendar';
  return p === 'outlook' ? 'Outlook mail' : p === 'imap' ? 'Gmail (app password)' : 'Gmail';
};
const CAL_NAME = (account: string) => (account.split(':')[0] === 'outlook' ? 'Outlook calendar' : 'Google calendar');
const whenSaid = (ms: number, now: number, tz: string) => (localDate(ms, tz) === localDate(now, tz) ? clockLabel(ms, tz) : atLabel(ms, tz));

function calendarFreshness(now: number, tz: string) {
  const accounts = calendarAccounts().filter((a) => a.connected);
  const reconnect = accounts.filter((a) => a.needsReconnect);
  const never = accounts.filter((a) => a.lastOk == null && !a.needsReconnect);
  const oks = accounts.map((a) => a.lastOk).filter((x): x is number => x != null);
  const asOf = oks.length ? Math.min(...oks) : null;
  let state: Freshness, note: string | null = null;
  if (!accounts.length) { state = 'not_connected'; note = "Your calendar isn't connected, so I can't show what's next."; }
  else if (reconnect.length) { state = 'reconnect'; note = `${ACCOUNT_LABEL(reconnect[0].account, 'calendar')} needs to be reconnected, so your day may be out of date${asOf ? ` (last updated ${whenSaid(asOf, now, tz)})` : ''}.`; }
  else if (asOf === null) { state = 'not_synced'; note = "Your calendar hasn't synced yet, so I can't tell what's next. That doesn't mean your day is free."; }
  // one calendar synced, another never: what is shown is only part of the day, and the missing one is named
  else if (never.length) { state = 'partial'; note = `Your ${never.map((a) => CAL_NAME(a.account)).join(' and ')} hasn't synced yet, so your day may be missing things.`; }
  else if (now - asOf > CALENDAR_STALE_MS) { state = 'stale'; note = `Your calendar was last updated ${whenSaid(asOf, now, tz)}.`; }
  else state = 'ok';
  return { state, asOf, note, reconnect: reconnect.map((a) => a.account) };
}

function mailFreshness(now: number, tz: string) {
  let accounts: ReturnType<typeof mailAccounts> = [];
  try { accounts = mailAccounts(); } catch { accounts = []; }
  const reconnect = accounts.filter((a) => a.needsReconnect);
  const oks = accounts.map((a) => a.lastOk).filter((x): x is number => x != null);
  const asOf = oks.length ? Math.min(...oks) : null;
  let state: Freshness, note: string | null = null;
  if (!accounts.length) { state = 'not_connected'; note = "Your email isn't connected, so I can't sort it."; }
  else if (reconnect.length) { state = 'reconnect'; note = `${ACCOUNT_LABEL(reconnect[0].account, 'mail')} needs to be reconnected.`; }
  else if (asOf === null) { state = 'not_synced'; note = "Your email hasn't synced yet."; }
  else if (oks.length < accounts.length) { state = 'partial'; note = "One of your mail accounts hasn't synced yet."; }
  else if (now - asOf > MAIL_STALE_MS) { state = 'stale'; note = `Your email was last checked ${whenSaid(asOf, now, tz)}.`; }
  else state = 'ok';
  return { state, asOf, note, reconnect: reconnect.map((a) => a.account) };
}

/** Open items (not gone), newest first, the owner's only. */
function openItems(): ItemRow[] {
  return (appDb().prepare(`SELECT * FROM items WHERE state = 'open' AND gone = 0 ORDER BY ts DESC, id`).all() as ItemRow[]).filter(visibleItem);
}
/** Items by id (any state), for a card's caution and the person's own dismissals. */
function itemsByIds(ids: string[]): Map<string, ItemRow> {
  const out = new Map<string, ItemRow>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    if (!chunk.length) continue;
    for (const r of appDb().prepare(`SELECT * FROM items WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as ItemRow[]) out.set(r.id, r);
  }
  return out;
}

/**
 * The double-bookings from now through two weeks ahead. Memoised until the calendar cache or a draft changes (their
 * newest updated_seq) or the minute turns: Today is read often and the calendar changes only when it syncs, while a
 * busy calendar can hold thousands of overlapping pairs.
 */
let conflictMemo: { key: string; value: ReturnType<typeof findConflicts> } | null = null;
function upcomingConflicts(now: number): ReturnType<typeof findConflicts> {
  const d = appDb();
  const seq = d.prepare(`SELECT (SELECT COALESCE(MAX(updated_seq), 0) FROM cal_events) e, (SELECT COALESCE(MAX(updated_seq), 0) FROM cal_drafts) d, (SELECT COUNT(*) FROM cal_events) n`).get() as { e: number; d: number; n: number };
  const key = `${seq.e}|${seq.d}|${seq.n}|${Math.floor(now / 60_000)}`;
  if (conflictMemo?.key === key) return conflictMemo.value;
  const value = findConflicts(iso(now), iso(now + CONFLICT_AHEAD_MS));
  conflictMemo = { key, value };
  return value;
}

/** S4 review: the owner's approvals waiting that no job staged (a chat's), minus phishing-flagged ones — the pill counts
 *  them as waiting for the person (a job's approval is already its job's "waiting"). */
export function looseApprovals(approvals: PendingView[], views: JobView[]): number {
  const staged = new Set<string>(), runs = new Set<string>();
  for (const v of views) for (const t of v.tries) {
    if (t.run_id) runs.add(t.run_id);
    try { for (const s of (t.staged ? JSON.parse(t.staged) as string[] : [])) staged.add(s); } catch { /* */ }
  }
  const d = appDb();
  const flagged = (id: string) => { try { return (d.prepare('SELECT caution FROM items WHERE id = ?').get(itemId(`approval:${id}`)) as { caution: string | null } | undefined)?.caution === 'phishing'; } catch { return false; } };
  return approvals.filter((a) => ownerOwns(a.personId) && !staged.has(a.id) && !(a.runId && runs.has(a.runId)) && !phishingSource(a.taintSources) && !flagged(a.id)).length;
}

/** A card and the words the helper may SAY for it (counts, times and our own labels — never outside text). */
type Card = NeedCard & { spoken: string };

function needsYou(views: JobView[], approvals: PendingView[], cal: ReturnType<typeof calendarFreshness>, mail: ReturnType<typeof mailFreshness>, now: number, tz: string): Card[] {
  const cards: Card[] = [];
  // the Important items standing for each candidate: a phishing caution drops it; the person's own dismissal of a
  // double-booking (handled, not important, snoozed) is respected. By dedupe key: a busy calendar can have thousands
  // of overlapping pairs, so no per-pair hashing or lookups.
  const conflicts = upcomingConflicts(now);
  const items = new Map<string, ItemRow>();
  for (const r of itemsByIds(approvals.map((a) => itemId(`approval:${a.id}`))).values()) items.set(r.dedupe_key, r);
  for (const r of appDb().prepare(`SELECT * FROM items WHERE source = 'calendar-conflict'`).all() as ItemRow[]) items.set(r.dedupe_key, r);
  const phishing = (key: string) => items.get(key)?.caution === 'phishing';

  // approvals: the owner's, oldest first (the one that has waited longest)
  const mine = approvals.filter((a) => ownerOwns(a.personId) && !phishing(`approval:${a.id}`) && !phishingSource(a.taintSources)).sort((a, b) => a.createdAt - b.createdAt);
  if (mine.length) {
    const a = mine[0];
    // a staged action's summary was written by a run (perhaps after reading outside content): outside words
    const what = plainWhy(a.summary, 120) ? outsidePart(a.summary, 120) : ours('Something needs your OK');
    const titleParts = mine.length === 1 ? [what] : [ours(`${mine.length} things need your OK`)];
    const textParts = mine.length === 1 ? [ours('Your helper needs your OK before it goes on.')] : [ours('The first: '), what];
    cards.push({
      id: 'need:approvals', kind: 'approval', count: mine.length,
      title: flatText(titleParts, true), text: flatText(textParts, true), titleParts, textParts,
      action: { kind: 'review-approval', label: 'Review' }, open: mine.length === 1 ? { kind: 'approval', id: a.id } : { kind: 'approvals', id: null },
      itemId: items.get(`approval:${a.id}`)?.id ?? null, trust: mine.some((x) => x.tainted) ? 'untrusted' : 'trusted',
      spoken: mine.length === 1 ? 'Something needs your OK.' : `${mine.length} things need your OK.`,
    });
  }
  // jobs waiting for the person (an approval it staged, or the dollar limit it reached)
  const waiting = views.filter((v) => v.status.state === 'waiting').sort((a, b) => b.job.updated_seq - a.job.updated_seq);
  if (waiting.length) {
    const v = waiting[0];
    // a job set up from (or that read) outside content: its title is outside words
    const titleOf = (max: number): Part => (jobTrust(v) === 'untrusted' ? outsidePart(v.job.title, max) : ours(plainWhy(v.job.title, max) || 'A job'));
    const titleParts = waiting.length === 1 ? [titleOf(120)] : [ours(`${waiting.length} jobs are waiting for you`)];
    const textParts = waiting.length === 1 ? [ours(v.status.detail)] : [ours('The first: '), titleOf(100), ours(` — ${v.status.detail}`)];
    cards.push({
      id: 'need:jobs', kind: 'job', count: waiting.length,
      title: flatText(titleParts, true), text: flatText(textParts, true), titleParts, textParts,
      action: v.status.primaryAction ? { kind: v.status.primaryAction.action, label: v.status.primaryAction.label } : null,
      open: waiting.length === 1 ? { kind: 'job', id: v.job.id } : { kind: 'jobs', id: 'waiting' }, itemId: null, trust: jobTrust(v),
      spoken: waiting.length === 1 ? 'A job is waiting for you.' : `${waiting.length} jobs are waiting for you.`,
    });
  }
  // the next double-booking the person has not dismissed
  const open = conflicts.filter((c) => { const it = items.get(`conflict:${c.id}`); return !(it && (it.state !== 'open' || it.caution === 'phishing')); });
  if (open.length) {
    const c = open[0];
    const key = `conflict:${c.id}`;
    const it = items.get(key);
    const more = open.length > 1 ? ` ${plural(open.length - 1, 'more double-booking', 'more double-bookings')} in the next two weeks.` : '';
    const when = `${atLabel(Date.parse(c.start), tz)} is double-booked`;
    // event titles came from the calendar (an invitation can say anything); an untrusted item's words likewise
    const itemOutside = !!it && it.trust === 'untrusted';
    const titleParts = it?.title ? [itemOutside ? outsidePart(it.title, 120) : ours(it.title)] : [ours(when)];
    const textParts = it?.why
      ? [itemOutside ? outsidePart(it.why, 200) : ours(it.why), ...(more ? [ours(more)] : [])]
      : [plainWhy(c.a.title, 60) ? outsidePart(c.a.title, 60) : ours('An event'), ours(' and '), plainWhy(c.b.title, 60) ? outsidePart(c.b.title, 60) : ours('another event'), ours(` overlap.${more}`)];
    cards.push({
      id: `need:${key}`, kind: 'conflict', count: open.length,
      title: flatText(titleParts, true), text: flatText(textParts, true), titleParts, textParts,
      // the action runs through its Important item; with none yet, the card only opens the day
      action: it ? { kind: 'draft-note', label: 'Draft the note' } : null,
      open: it ? { kind: 'item', id: it.id, date: localDate(Date.parse(c.start), tz) } : { kind: 'calendar', id: c.a.id, date: localDate(Date.parse(c.start), tz) },
      itemId: it?.id ?? null, trust: 'untrusted', spoken: `${when}.`,
    });
  }
  // an account to sign in to again
  const re = [...cal.reconnect.map((account) => ({ account, resource: 'calendar' as const })), ...mail.reconnect.map((account) => ({ account, resource: 'mail' as const }))];
  if (re.length) {
    const r = re[0];
    const title = re.length === 1 ? `${ACCOUNT_LABEL(r.account, r.resource)} needs to be reconnected` : `${re.length} accounts need to be reconnected`;
    cards.push({
      id: 'need:reconnect', kind: 'reconnect', count: re.length, title,
      text: "I can't check it until you sign in again.", titleParts: [ours(title)], textParts: [ours("I can't check it until you sign in again.")], action: { kind: 'reconnect', label: 'Reconnect' },
      open: { kind: 'reconnect', id: r.account, resource: r.resource }, itemId: null, trust: 'trusted', spoken: `${title}.`,
    });
  }
  return cards;
}

/** Today's agenda (events and drafts, the whole local day) and what is still to come. */
function dayAgenda(now: number, tz: string) {
  const { start, end } = dayBounds(now, tz);
  const agenda = calendarItems(iso(start), iso(end));
  // on the calendar: events, and a confirmed draft not yet in the cache (calendarItems shows it once); open drafts are
  // proposals, not plans
  const onCal = agenda.filter((x) => x.kind === 'event' || x.state === 'confirmed');
  // still ahead: an event that has ended is no longer one of "the things on your calendar" (all-day ones last the day)
  const remaining = onCal.filter((x) => x.allDay || Date.parse(x.end) > now);
  const upcoming = remaining.filter((x) => !x.allDay).sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const nextUp: NextUp[] = upcoming.slice(0, NEXT_UP_MAX).map((x) => {
    const s = Date.parse(x.start);
    const gap = Math.round((s - now) / 60_000);
    return { id: x.id, kind: x.kind, title: x.title, start: x.start, end: x.end, location: x.location, startLabel: clockLabel(s, tz), soon: gap <= 0 ? 'Now' : gap <= 60 ? `in ${gap} min` : null };
  });
  return { agenda, onCal, remaining, nextUp, more: Math.max(0, upcoming.length - nextUp.length) };
}

interface Activity {
  drafts: CalDraftRow[]; confirmed: CalDraftRow[]; finished: JobView[]; reminders: JobView[]; actions: ActionRow[];
}
const REPLY_TOOLS = new Set(['draft_email', 'draft_outlook']);
const ACTION_LINE: Record<string, { kind: DoneLine['kind']; text: string; approved?: string }> = {
  draft_email: { kind: 'reply-drafted', text: 'I drafted an email for you to check. Nothing was sent.' },
  draft_outlook: { kind: 'reply-drafted', text: 'I drafted an email for you to check. Nothing was sent.' },
  send_email: { kind: 'email-sent', text: 'I sent an email.', approved: 'I sent the email you approved.' },
  write_file: { kind: 'file-saved', text: 'I saved a file.', approved: 'I saved the file you approved.' },
  policy_save: { kind: 'preference', text: 'I saved a preference you gave me.' },
};
/** A job's words came from outside when any run of it read outside content, or it was set up from outside content. */
const jobTrust = (v: JobView): 'trusted' | 'untrusted' => (v.job.stands_trust === 'untrusted' || v.tries.some((t) => t.tainted === 1) ? 'untrusted' : 'trusted');

/** What happened in [from, now]: drafts the helper made, drafts confirmed, jobs finished, reminders set, actions. */
function activitySince(from: number, now: number, views: Map<string, JobView>): Activity {
  const d = appDb();
  const confirmed = d.prepare(`SELECT * FROM cal_drafts WHERE state = 'confirmed' AND confirmed_at >= ? AND confirmed_at <= ? ORDER BY confirmed_at DESC`).all(from, now) as CalDraftRow[];
  // a draft is said once, as it stands now: one confirmed meanwhile is "on your calendar", not also "confirm it"
  const added = new Set(confirmed.map((x) => x.id));
  const drafts = (d.prepare(`SELECT * FROM cal_drafts WHERE origin = 'helper' AND state != 'removed' AND created_at >= ? AND created_at <= ? ORDER BY created_at DESC`).all(from, now) as CalDraftRow[])
    .filter((x) => !added.has(x.id));
  const finished: JobView[] = [];
  for (const r of d.prepare(`SELECT job_id, MAX(ended_at) at FROM tries WHERE state = 'ended' AND ended_at >= ? AND ended_at <= ? GROUP BY job_id`).all(from, now) as { job_id: string; at: number }[]) {
    const v = views.get(r.job_id);
    if (!v) continue; // archived, or someone else's
    const recurring = v.job.kind === 'recurring' || v.job.kind === 'reminder';
    if (recurring ? v.status.resultReady === true : v.status.state === 'done') finished.push(v);
  }
  const reminders = [...views.values()].filter((v) => v.job.kind === 'reminder' && v.job.created_at >= from && v.job.created_at <= now);
  const actions = actionsBetween(from, now).filter((a) => ownerOwns(a.person) && ACTION_LINE[a.tool]);
  return { drafts, confirmed, finished, reminders, actions };
}
const lastEnded = (v: JobView) => Math.max(0, ...v.tries.filter((t) => t.state === 'ended').map((t) => t.ended_at ?? 0));

function doneLines(a: Activity, now: number, tz: string): DoneLine[] {
  const lines: DoneLine[] = [];
  const said = (...parts: Part[]) => ({ text: flatText(parts), parts });
  for (const x of a.drafts) {
    const s = Date.parse(x.start_utc);
    lines.push({ id: `draft:${x.id}`, kind: 'draft-event', at: x.created_at, trust: x.suggested_after_outside ? 'untrusted' : 'trusted',
      ...said(ours('I added '), outsidePart(x.title), ours(` ${x.all_day ? `on ${atLabel(s, tz).replace(/ at .*$/, '')}` : `on ${atLabel(s, tz)}`} as a draft. Confirm it when you see it.`)),
      open: { kind: 'calendar', id: x.id, date: localDate(s, x.all_day ? x.tz || tz : tz) } });
  }
  for (const x of a.confirmed) {
    const s = Date.parse(x.start_utc);
    lines.push({ id: `added:${x.id}`, kind: 'event-added', at: x.confirmed_at ?? x.created_at, trust: x.suggested_after_outside ? 'untrusted' : 'trusted',
      ...said(outsidePart(x.title), ours(' is on your calendar now. No invites were sent.')), open: { kind: 'calendar', id: x.id, date: localDate(s, x.all_day ? x.tz || tz : tz) } });
  }
  for (const v of a.finished) {
    const recurring = v.job.kind === 'recurring' || v.job.kind === 'reminder';
    lines.push({ id: `job:${v.job.id}`, kind: 'job-finished', at: lastEnded(v), trust: jobTrust(v),
      ...(recurring ? said(outsidePart(v.job.title), ours(' has a new result.')) : said(ours('I finished '), outsidePart(v.job.title), ours('.'))), open: { kind: 'job', id: v.job.id } });
  }
  for (const v of a.reminders) {
    const j = v.job;
    lines.push({ id: `reminder:${j.id}`, kind: 'reminder', at: j.created_at, trust: jobTrust(v),
      ...said(ours('I set a reminder: '), outsidePart(j.title), ours(`${j.next_due_at ? `, ${whenSaid(j.next_due_at, now, tz)}` : ''}.`)), open: { kind: 'job', id: j.id } });
  }
  for (const x of a.actions) {
    const l = ACTION_LINE[x.tool];
    lines.push({ id: `action:${x.id}`, kind: l.kind, at: x.ts, trust: 'trusted', ...said(ours(x.via === 'approval' && l.approved ? l.approved : l.text)), open: { kind: 'activity', id: String(x.id) } });
  }
  return lines.sort((p, q) => q.at - p.at || (p.id < q.id ? -1 : 1));
}

function weekCounts(from: number, now: number, views: JobView[]): WeekCounts {
  const d = appDb();
  const eventsAdded = (d.prepare(`SELECT COUNT(*) n FROM cal_drafts WHERE state = 'confirmed' AND confirmed_at >= ? AND confirmed_at <= ?`).get(from, now) as { n: number }).n;
  const repliesDrafted = actionsBetween(from, now).filter((a) => ownerOwns(a.person) && REPLY_TOOLS.has(a.tool)).length;
  let jobsFinished = 0, documentsLearned = 0;
  for (const v of views) {
    if (v.status.state !== 'done' || v.job.kind === 'recurring' || v.job.kind === 'reminder') continue;
    const at = lastEnded(v);
    if (at < from || at > now) continue;
    jobsFinished++;
    // a document learned: a finished job that worked through pages (its progress was counted in pages)
    const last = [...v.tries].reverse().find((t) => t.state === 'ended');
    if (/^pages?$/i.test(String(last?.progress_unit ?? v.job.progress_unit ?? '').trim())) documentsLearned++;
  }
  return { repliesDrafted, eventsAdded, documentsLearned, jobsFinished };
}
export function weekText(c: WeekCounts): string {
  const parts = [
    c.repliesDrafted ? `${plural(c.repliesDrafted, 'reply', 'replies')} drafted` : '',
    c.eventsAdded ? `${plural(c.eventsAdded, 'event', 'events')} added` : '',
    c.documentsLearned ? `${plural(c.documentsLearned, 'document', 'documents')} learned` : '',
    c.jobsFinished ? `${plural(c.jobsFinished, 'job', 'jobs')} finished` : '',
  ].filter(Boolean);
  return parts.length ? `In the last 7 days: ${parts.join(', ')}.` : 'In the last 7 days: nothing yet — I’ll keep count here.';
}
const joinAnd = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0] ?? '');

// ── the composite ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Today for one caller. `caller` is the router's key space ('session', 'local', 'device:<id>'): "Done for you" is
 * what came after this caller last looked. Reads only; makes no model call.
 */
export async function buildToday(caller: string, o: { now?: number; tz?: string } = {}): Promise<Today> {
  const now = o.now ?? deps.now(), tz = o.tz ?? deps.tz();
  const { day, start: dayStart } = dayBounds(now, tz);
  const mins = localMinutes(now, tz);
  const part = partOf(mins);
  const name = (() => { try { return deps.greetingName(); } catch { return null; } })();
  const greeting = `${part === 'morning' ? 'Good morning' : part === 'afternoon' ? 'Good afternoon' : 'Good evening'}${name ? `, ${name}` : ''}`;

  // jobs: the owner's, not archived, with their status (one query for all their tries)
  let approvals: PendingView[] = [];
  try { approvals = deps.pendingApprovals(); } catch { approvals = []; }
  const views = viewJobs(listJobs({}).filter((j) => ownerOwns(j.person)), { running: deps.running(), pending: new Set(approvals.map((a) => a.id)), now });
  const byId = new Map(views.map((v) => [v.job.id, v]));

  const cal = calendarFreshness(now, tz);
  const mail = mailFreshness(now, tz);
  const cards = needsYou(views, approvals, cal, mail, now, tz);
  const needs: NeedCard[] = cards.map(({ spoken: _s, ...c }) => c);
  const calKnown = cal.state !== 'not_connected' && cal.state !== 'not_synced';
  const agenda = dayAgenda(now, tz);

  // done for you: since this caller last looked (at most a week back; a day back for a first look)
  const seen = lastSeen(caller);
  const since = Math.max(now - DONE_LOOKBACK_MS, seen ?? now - FIRST_LOOK_MS);
  const done = doneLines(activitySince(since, now, byId), now, tz);

  // worth a look: the top open items, minus what a Needs-you card stands for
  const shown = new Set<string>();
  for (const c of needs) if (c.kind === 'conflict' && c.itemId) shown.add(c.itemId);
  const items = openItems();
  const top = items.filter((r) => !shown.has(r.id) && r.source !== 'approval' && r.source !== 'connection').slice(0, WORTH_MAX).map((r) => apiItem(r, now, tz));

  const counts = weekCounts(now - 7 * 86_400_000, now, views);
  const needCount = needs.reduce((s, c) => s + c.count, 0);

  // the morning check-in: counts only, each thing appears once, in its own card below. Its spoken form adds times and
  // the helper's own card labels — never an event's title or a staged action's summary.
  let checkin: Today['checkin'] = null;
  if (mins >= CHECKIN_FROM_MIN && mins < CHECKIN_UNTIL_MIN && markDay('checkin') !== day) {
    const overnightFrom = Math.max(seen ?? 0, zonedToUtc(`${addDays(day, -1)}T17:00:00`, tz));
    const overnight = doneLines(activitySince(overnightFrom, now, byId), now, tz).length;
    const events = agenda.remaining.length;
    const cal1 = !calKnown ? "I can't see your calendar yet"
      : cal.state === 'partial' ? `${plural(events, 'thing', 'things')} on the calendars I can see`
      : `${plural(events, 'thing', 'things')} on your calendar`;
    const need1 = needCount ? `${plural(needCount, 'thing needs', 'things need')} you` : 'nothing needs you';
    const text = `Here’s your ${weekdayOf(day)}: ${cal1}, ${need1}, and I did ${plural(overnight, 'thing', 'things')} overnight. It’s all below.`;
    const first = calKnown && agenda.nextUp[0] ? ` Your first thing is at ${agenda.nextUp[0].startLabel}.` : '';
    const spoken = `${text.replace(' It’s all below.', '')}${first}${cards[0] ? ` ${cards[0].spoken}` : ''}`;
    checkin = { title: 'Your morning check-in', text, spoken, trust: 'trusted', counts: { events, needsYou: needCount, overnight } };
  }

  // the evening wrap: what got done today (each thing once), and how tomorrow starts
  let wrap: Today['wrap'] = null;
  if (mins >= WRAP_FROM_MIN && markDay('wrap') !== day) {
    const today = activitySince(dayStart, now, byId);
    const doneToday = doneLines(today, now, tz).length;
    const replies = today.actions.filter((x) => REPLY_TOOLS.has(x.tool)).length;
    if (doneToday > 0) {
      const said: string[] = [];
      if (today.confirmed.length) said.push(`you confirmed ${plural(today.confirmed.length, 'event', 'events')}`);
      if (replies) said.push(`I drafted ${plural(replies, 'reply', 'replies')}`);
      if (today.finished.length) said.push(`I finished ${plural(today.finished.length, 'job', 'jobs')}`);
      const other = doneToday - today.confirmed.length - replies - today.finished.length;
      if (other > 0) said.push(`I did ${plural(other, 'other thing', 'other things')}`);
      const joined = joinAnd(said);
      const line1 = joined ? `${joined.charAt(0).toUpperCase()}${joined.slice(1)} today.` : '';
      const t0 = localMidnight(addDays(day, 1), tz), t1 = localMidnight(addDays(day, 2), tz);
      const tomorrow = calendarItems(iso(t0), iso(t1)).filter((x) => (x.kind === 'event' || x.state === 'confirmed') && !x.allDay && Date.parse(x.start) >= t0).slice(0, 2);
      const at = (x: CalendarItem) => clockLabel(Date.parse(x.start), tz);
      const unknown = !calKnown ? "I can't see tomorrow's calendar yet." : !tomorrow.length ? 'Nothing is on your calendar tomorrow yet.' : null;
      // shown: the first event quoted as one ("an event called “…”"), filtered and short; said: times only
      const line2Parts: Part[] = unknown ? [ours(unknown)]
        : [ours(`Tomorrow starts at ${at(tomorrow[0])} with an event called `), outsidePart(tomorrow[0].title, QUOTE_MAX), ours(`${tomorrow[1] ? `, then something at ${at(tomorrow[1])}` : ''}.`)];
      const said2 = unknown ?? `Tomorrow starts at ${at(tomorrow[0])}${tomorrow[1] ? `, then ${at(tomorrow[1])}` : ''}.`;
      const lineParts: Part[][] = [...(line1 ? [[ours(line1)]] : []), line2Parts];
      const lines = lineParts.map((ps) => flatText(ps));
      wrap = {
        title: `That’s ${weekdayOf(day)}`, lines, lineParts, spoken: [line1, said2].filter(Boolean).join(' '), trust: unknown ? 'trusted' : 'untrusted',
        counts: { eventsConfirmed: today.confirmed.length, repliesDrafted: replies, jobsFinished: today.finished.length, doneToday },
      };
    }
  }

  return {
    id: 'today', date: day, weekday: weekdayOf(day), dateLabel: dateLabelOf(day), tz, now,
    greetingName: name, greeting, part,
    checkin, wrap,
    needsYou: needs,
    nextUp: calKnown ? agenda.nextUp : [], nextUpMore: calKnown ? agenda.more : 0, agenda: agenda.agenda,
    doneForYou: done.slice(0, DONE_MAX), doneMore: Math.max(0, done.length - DONE_MAX), doneSince: since,
    worthALook: top, worthALookTotal: items.length,
    weekLine: { text: weekText(counts), counts },
    month: monthLine(now),
    status: statusPill(views.filter((v) => v.job.archived !== 1).map((v) => v.status), looseApprovals(approvals, views)),
    freshness: {
      calendarAsOf: cal.asOf, mailAsOf: mail.asOf, calendar: cal.state, mail: mail.state, calendarNote: cal.note, mailNote: mail.note,
      needsReconnect: [
        ...cal.reconnect.map((account) => ({ account, resource: 'calendar' as const, label: ACCOUNT_LABEL(account, 'calendar') })),
        ...mail.reconnect.map((account) => ({ account, resource: 'mail' as const, label: ACCOUNT_LABEL(account, 'mail') })),
      ],
    },
  };
}

/** Entities whose change can change Today (the stream's coarse "today changed" notice). Mail is not one: a message
 *  reaches Today only as an Important item, which records its own change. */
export const TODAY_SOURCES = new Set(['job', 'try', 'cal_event', 'cal_draft', 'item', 'action', 'approval']);

/**
 * What else changes Today without an app.db event: an approval staged or answered (approvals.db), a sync succeeding
 * or needing a reconnect (sync_state has no events), and the clock crossing midnight, 05:00, noon or 17:00. The
 * stream compares this signature on a timer and sends the "today changed" notice when it moves.
 */
export function todaySignature(now = deps.now(), tz = deps.tz()): string {
  let approvals = '';
  try { approvals = deps.pendingApprovals().map((a) => a.id).sort().join(','); } catch { /* unreadable: no change */ }
  const sync = (appDb().prepare(`SELECT account, resource, last_ok, needs_reconnect FROM sync_state ORDER BY account, resource`).all() as Record<string, unknown>[])
    .map((r) => `${r.account}|${r.resource}|${r.last_ok ?? ''}|${r.needs_reconnect}`).join(';');
  return createHash('sha256').update(`${approvals}\n${sync}\n${localDate(now, tz)}|${partOf(localMinutes(now, tz))}`).digest('base64url').slice(0, 22);
}
