/**
 * The calendar cache and MWA-held drafts (v2 build, slice A7, 2026-10-26).
 *
 *   cal_events  — what the connected calendars hold over a window (yesterday … two weeks ahead), synced by
 *                 src/sync/calendar.ts. One row per event instance (recurring events are expanded).
 *   cal_drafts  — events the helper (or the person) proposed. They live HERE until the person confirms one: nothing is
 *                 written to Google or Outlook before Confirm (it used to insert a real "[Proposed]" event).
 *   sync_state  — per account and resource ('calendar', and 'mail' in slice A8): cursor, window (INTEGER ms), last success,
 *                 last error, needs_reconnect. Shared with A8, which creates the same table IF NOT EXISTS.
 *
 * Accounts: 'google:<address>' / 'outlook:<address>' once the signed-in address is known, else 'google' / 'outlook'
 * (a sign-in made before addresses were kept). The provider is the part before the first ':'.
 *
 * Times are UTC ISO strings (toISOString, so they sort as text). An all-day event's start and end are the local
 * midnights of its dates in its zone (`tz`), so a window query in instants finds it on the right day anywhere.
 * Every write records an event in the same transaction (entity 'cal_event' / 'cal_draft'), which drives the live
 * stream and /sync.
 */
import { randomBytes } from 'node:crypto';
import { appDb, recordEvent, registerMigrations, type AppDb } from './db.js';
import { localDate, iso } from '../sync/tz.js';

registerMigrations([{
  name: '004-calendar',
  sql: `
    CREATE TABLE IF NOT EXISTS cal_events (
      account TEXT NOT NULL, provider TEXT NOT NULL CHECK (provider IN ('google','outlook')), provider_id TEXT NOT NULL,
      calendar_id TEXT, etag TEXT, start_utc TEXT NOT NULL, end_utc TEXT NOT NULL, all_day INTEGER NOT NULL DEFAULT 0,
      tz TEXT, title TEXT NOT NULL DEFAULT '', location TEXT, status TEXT NOT NULL DEFAULT 'confirmed', recurring_id TEXT,
      is_helper_confirmed INTEGER NOT NULL DEFAULT 0, updated_seq INTEGER,
      PRIMARY KEY (account, provider_id));
    CREATE INDEX IF NOT EXISTS cal_events_start ON cal_events(start_utc);
    CREATE INDEX IF NOT EXISTS cal_events_series ON cal_events(account, recurring_id);
    -- origin: 'you' (the person's own input) or 'helper'; suggested_after_outside: the helper's run had read outside
    -- content (an email, a web page) before proposing it; origin_note: a plain line saying so.
    -- confirm_lease/confirm_token: one confirm at a time; orphan_provider_id: an event that reached the calendar for a
    -- draft removed meanwhile and could not be taken off again (the person is told).
    CREATE TABLE IF NOT EXISTS cal_drafts (
      id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, start_utc TEXT NOT NULL, end_utc TEXT NOT NULL,
      all_day INTEGER NOT NULL DEFAULT 0, tz TEXT, location TEXT, notes TEXT, source_item TEXT, created_by_try TEXT,
      origin TEXT NOT NULL DEFAULT 'helper' CHECK (origin IN ('you','helper')), suggested_after_outside INTEGER NOT NULL DEFAULT 0,
      origin_note TEXT,
      state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','confirmed','removed')),
      provider TEXT CHECK (provider IS NULL OR provider IN ('google','outlook')), account TEXT, provider_id TEXT, confirmed_at INTEGER,
      confirm_lease INTEGER, confirm_token TEXT, orphan_provider_id TEXT,
      created_at INTEGER NOT NULL, changed_at INTEGER, updated_seq INTEGER);
    CREATE INDEX IF NOT EXISTS cal_drafts_start ON cal_drafts(start_utc);
    CREATE TABLE IF NOT EXISTS sync_state (
      account TEXT NOT NULL, resource TEXT NOT NULL, cursor TEXT, window_from INTEGER, window_to INTEGER,
      last_ok INTEGER, last_error TEXT, needs_reconnect INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (account, resource));`,
}]);

export type CalProvider = 'google' | 'outlook';

/** 'google:me@example.com' → 'google' (and 'google' → 'google'). */
export const providerOfAccount = (account: string): CalProvider => (account.split(':')[0] === 'outlook' ? 'outlook' : 'google');

export interface CalEventRow {
  account: string; provider: CalProvider; provider_id: string; calendar_id: string | null; etag: string | null;
  start_utc: string; end_utc: string; all_day: number; tz: string | null; title: string; location: string | null;
  status: string; recurring_id: string | null; is_helper_confirmed: number; updated_seq: number | null;
}
export interface CalDraftRow {
  id: string; project_id: string | null; title: string; start_utc: string; end_utc: string; all_day: number; tz: string | null;
  location: string | null; notes: string | null; source_item: string | null; created_by_try: string | null;
  origin: 'you' | 'helper'; suggested_after_outside: number; origin_note: string | null;
  state: 'draft' | 'confirmed' | 'removed'; provider: CalProvider | null; account: string | null; provider_id: string | null; confirmed_at: number | null;
  confirm_lease: number | null; confirm_token: string | null; orphan_provider_id: string | null;
  created_at: number; changed_at: number | null; updated_seq: number | null;
}
export interface SyncStateRow {
  account: string; resource: string; cursor: string | null; window_from: number | null; window_to: number | null;
  last_ok: number | null; last_error: string | null; needs_reconnect: number;
}

/** An event as the sync hands it over (already in UTC). */
export interface CalEventIn {
  provider_id: string; calendar_id?: string | null; etag?: string | null; start_utc: string; end_utc: string;
  all_day: boolean; tz?: string | null; title: string; location?: string | null; status?: string; recurring_id?: string | null;
}

/** An event's API id: '<account>:<provider id>'. The account may itself hold a ':' (google:me@x) — split at the last. */
export const eventItemId = (account: string, providerId: string) => `${account}:${providerId}`;

// ── events ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Insert or update one cached event. Unchanged (same etag and fields) → no write, no event. Returns true if written. */
export function upsertCalEvent(account: string, provider: CalProvider, e: CalEventIn, d: AppDb = appDb()): boolean {
  const cur = d.prepare('SELECT * FROM cal_events WHERE account = ? AND provider_id = ?').get(account, e.provider_id) as CalEventRow | undefined;
  const next = {
    calendar_id: e.calendar_id ?? null, etag: e.etag ?? null, start_utc: e.start_utc, end_utc: e.end_utc, all_day: e.all_day ? 1 : 0,
    tz: e.tz ?? null, title: e.title ?? '', location: e.location ?? null, status: e.status ?? 'confirmed', recurring_id: e.recurring_id ?? null,
  };
  if (cur && (Object.keys(next) as (keyof typeof next)[]).every((k) => cur[k] === next[k])) return false;
  const seq = recordEvent({ entity: 'cal_event', id: eventItemId(account, e.provider_id) }, d);
  d.prepare(`INSERT INTO cal_events (account, provider, provider_id, calendar_id, etag, start_utc, end_utc, all_day, tz, title, location, status, recurring_id, is_helper_confirmed, updated_seq)
    VALUES (@account, @provider, @provider_id, @calendar_id, @etag, @start_utc, @end_utc, @all_day, @tz, @title, @location, @status, @recurring_id, 0, @seq)
    ON CONFLICT (account, provider_id) DO UPDATE SET calendar_id = excluded.calendar_id, etag = excluded.etag, start_utc = excluded.start_utc,
      end_utc = excluded.end_utc, all_day = excluded.all_day, tz = excluded.tz, title = excluded.title, location = excluded.location,
      status = excluded.status, recurring_id = excluded.recurring_id, updated_seq = excluded.updated_seq`)
    .run({ account, provider, provider_id: e.provider_id, ...next, seq });
  return true;
}

export function deleteCalEvent(account: string, providerId: string, d: AppDb = appDb()): boolean {
  const r = d.prepare('DELETE FROM cal_events WHERE account = ? AND provider_id = ?').run(account, providerId);
  if (!r.changes) return false;
  recordEvent({ entity: 'cal_event', id: eventItemId(account, providerId), op: 'delete' }, d);
  return true;
}

/** A recurring series went (its master was cancelled or deleted): every cached instance of it goes too. */
export function deleteCalSeries(account: string, masterId: string, d: AppDb = appDb()): number {
  const ids = (d.prepare('SELECT provider_id FROM cal_events WHERE account = ? AND recurring_id = ?').all(account, masterId) as { provider_id: string }[]).map((r) => r.provider_id);
  let n = 0;
  for (const id of ids) if (deleteCalEvent(account, id, d)) n++;
  return n;
}

/** Drop an account's cached events that are not in `keep` (after a COMPLETE full sync). Returns how many went. */
export function pruneCalEvents(account: string, keep: Set<string>, d: AppDb = appDb()): number {
  const ids = (d.prepare('SELECT provider_id FROM cal_events WHERE account = ?').all(account) as { provider_id: string }[]).map((r) => r.provider_id);
  let n = 0;
  for (const id of ids) if (!keep.has(id) && deleteCalEvent(account, id, d)) n++;
  return n;
}

/** Forget an account's whole cache (disconnected). */
export function clearCalAccount(account: string, d: AppDb = appDb()): number {
  return pruneCalEvents(account, new Set(), d);
}

/**
 * A provider was connected, disconnected or switched to another address: everything cached from it goes — its events
 * (whatever account key they were stored under) and its calendar sync state (cursor, window, errors). The next sync
 * starts from nothing, so one person's events never sit under another's sign-in. Mail sync state is left alone.
 */
export function resetCalendarProvider(provider: CalProvider, d: AppDb = appDb()): number {
  return d.transaction(() => {
    const accounts = (d.prepare('SELECT DISTINCT account FROM cal_events WHERE provider = ?').all(provider) as { account: string }[]).map((r) => r.account);
    let n = 0;
    for (const a of accounts) n += clearCalAccount(a, d);
    d.prepare(`DELETE FROM sync_state WHERE resource = 'calendar' AND (account = ? OR account LIKE ?)`).run(provider, `${provider}:%`);
    return n;
  })();
}

export function getCalEvent(account: string, providerId: string): CalEventRow | null {
  return (appDb().prepare('SELECT * FROM cal_events WHERE account = ? AND provider_id = ?').get(account, providerId) as CalEventRow | undefined) ?? null;
}

/** Cached events overlapping [from, to) (UTC ISO), cancelled ones excluded. */
export function eventsBetween(from: string, to: string): CalEventRow[] {
  return appDb().prepare(`SELECT * FROM cal_events WHERE start_utc < ? AND end_utc > ? AND status != 'cancelled' ORDER BY start_utc, end_utc, account, provider_id`)
    .all(to, from) as CalEventRow[];
}
export function allCalEvents(): CalEventRow[] {
  return appDb().prepare(`SELECT * FROM cal_events WHERE status != 'cancelled' ORDER BY start_utc, end_utc, account, provider_id`).all() as CalEventRow[];
}

// ── drafts ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface DraftIn {
  title: string; startMs: number; endMs: number; allDay: boolean; tz?: string | null; location?: string | null; notes?: string | null;
  provider?: CalProvider | null; projectId?: string | null; sourceItem?: string | null; createdByTry?: string | null;
  origin?: 'you' | 'helper'; suggestedAfterOutside?: boolean; originNote?: string | null;
}

export function createDraft(x: DraftIn, d: AppDb = appDb()): CalDraftRow {
  const title = x.title.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!title) throw new Error('A draft needs a title.');
  if (!(x.endMs > x.startMs)) throw new Error('The end must be after the start.');
  const id = `cd_${randomBytes(9).toString('base64url').replace(/[-_]/g, 'x')}`;
  return d.transaction(() => {
    const seq = recordEvent({ entity: 'cal_draft', id }, d);
    const now = Date.now();
    d.prepare(`INSERT INTO cal_drafts (id, project_id, title, start_utc, end_utc, all_day, tz, location, notes, source_item, created_by_try,
        origin, suggested_after_outside, origin_note, state, provider, created_at, changed_at, updated_seq)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`).run(
      id, x.projectId ?? null, title, iso(x.startMs), iso(x.endMs), x.allDay ? 1 : 0, x.tz ?? null, x.location?.trim() || null,
      x.notes?.trim() || null, x.sourceItem ?? null, x.createdByTry ?? null, x.origin ?? 'helper', x.suggestedAfterOutside ? 1 : 0,
      x.originNote ?? null, x.provider ?? null, now, now, seq);
    return getDraft(id, d)!;
  })();
}

export function getDraft(id: string, d: AppDb = appDb()): CalDraftRow | null {
  return (d.prepare('SELECT * FROM cal_drafts WHERE id = ?').get(id) as CalDraftRow | undefined) ?? null;
}

/** Drafts (not removed) overlapping [from, to). */
export function draftsBetween(from: string, to: string): CalDraftRow[] {
  return appDb().prepare(`SELECT * FROM cal_drafts WHERE state != 'removed' AND start_utc < ? AND end_utc > ? ORDER BY start_utc, end_utc, id`).all(to, from) as CalDraftRow[];
}
export function openDrafts(): CalDraftRow[] {
  return appDb().prepare(`SELECT * FROM cal_drafts WHERE state = 'draft' ORDER BY start_utc, id`).all() as CalDraftRow[];
}

type DraftSet = Partial<Pick<CalDraftRow, 'state' | 'provider' | 'account' | 'provider_id' | 'confirmed_at' | 'confirm_lease' | 'confirm_token' | 'orphan_provider_id'>>;

/** Change a draft's fields in one transaction with its event. */
export function updateDraft(id: string, set: DraftSet, d: AppDb = appDb()): CalDraftRow {
  return d.transaction(() => {
    const seq = recordEvent({ entity: 'cal_draft', id, op: 'upsert' }, d);
    const cols = Object.keys(set) as (keyof DraftSet)[];
    d.prepare(`UPDATE cal_drafts SET ${cols.map((c) => `${c} = @${c}`).join(', ')}${cols.length ? ', ' : ''}changed_at = @now, updated_seq = @seq WHERE id = @id`)
      .run({ ...set, seq, id, now: Date.now() });
    return getDraft(id, d)!;
  })();
}

/**
 * How long a confirm may hold a draft. Every provider call a confirm makes has a 60 s timeout and a confirm makes at
 * most three (look up, insert, fetch), so a lease older than this belongs to a process that died — never to one still
 * waiting on Google or Outlook.
 */
export const CONFIRM_LEASE_MS = 10 * 60_000;

/**
 * Take the right to confirm a draft: one confirm at a time, across requests (and processes). Returns the draft and a
 * token when this caller holds the lease, or why not. A dead lease (older than CONFIRM_LEASE_MS) can be taken over —
 * safe, because the provider insert is idempotent (Google: a fixed event id; Outlook: a tagged event looked up first).
 */
export function takeConfirmLease(id: string, now = Date.now()):
  { ok: true; draft: CalDraftRow; token: string } | { ok: false; why: 'missing' | 'confirmed' | 'removed' | 'busy'; draft?: CalDraftRow } {
  const d = appDb();
  return d.transaction(() => {
    const cur = getDraft(id, d);
    if (!cur) return { ok: false as const, why: 'missing' as const };
    if (cur.state === 'confirmed') return { ok: false as const, why: 'confirmed' as const, draft: cur };
    if (cur.state === 'removed') return { ok: false as const, why: 'removed' as const, draft: cur };
    if (cur.confirm_lease && now - cur.confirm_lease < CONFIRM_LEASE_MS) return { ok: false as const, why: 'busy' as const, draft: cur };
    const token = randomBytes(8).toString('hex');
    d.prepare('UPDATE cal_drafts SET confirm_lease = ?, confirm_token = ? WHERE id = ?').run(now, token, id);
    return { ok: true as const, draft: { ...cur, confirm_lease: now, confirm_token: token }, token };
  }).immediate();
}
/** Give the lease back — only if it is still ours (a takeover's lease is not ours to drop). */
export function releaseConfirmLease(id: string, token: string): void {
  appDb().prepare('UPDATE cal_drafts SET confirm_lease = NULL, confirm_token = NULL WHERE id = ? AND confirm_token = ?').run(id, token);
}

/**
 * Record a confirmed draft — only from the confirming state this caller holds: state 'draft' with our lease token.
 * Never over 'removed' (the person removed it while it was being added) and never over someone else's takeover.
 * Returns the confirmed draft, or why it was not recorded.
 */
export function recordConfirmed(draftId: string, token: string, provider: CalProvider, providerId: string, account: string):
  { ok: true; draft: CalDraftRow } | { ok: false; why: 'removed' | 'not_ours' | 'missing'; draft?: CalDraftRow } {
  const d = appDb();
  return d.transaction(() => {
    const cur = getDraft(draftId, d);
    if (!cur) return { ok: false as const, why: 'missing' as const };
    if (cur.state === 'removed') return { ok: false as const, why: 'removed' as const, draft: cur };
    if (cur.state !== 'draft' || cur.confirm_token !== token) return { ok: false as const, why: 'not_ours' as const, draft: cur };
    upsertCalEvent(account, provider, {
      provider_id: providerId, start_utc: cur.start_utc, end_utc: cur.end_utc, all_day: cur.all_day === 1, tz: cur.tz,
      title: cur.title, location: cur.location, status: 'confirmed', calendar_id: 'primary',
    }, d);
    d.prepare('UPDATE cal_events SET is_helper_confirmed = 1 WHERE account = ? AND provider_id = ?').run(account, providerId);
    const draft = updateDraft(draftId, { state: 'confirmed', provider, account, provider_id: providerId, confirmed_at: Date.now(), confirm_lease: null, confirm_token: null }, d);
    return { ok: true as const, draft };
  }).immediate();
}

/** Confirmed and removed drafts whose last change is older than `maxAgeMs` (30 days) are forgotten. Returns how many. */
export const DRAFT_KEEP_MS = 30 * 86_400_000;
export function pruneOldDrafts(now = Date.now(), maxAgeMs = DRAFT_KEEP_MS): number {
  const d = appDb();
  return d.transaction(() => {
    const ids = (d.prepare(`SELECT id FROM cal_drafts WHERE state IN ('confirmed','removed') AND COALESCE(changed_at, created_at) < ? AND orphan_provider_id IS NULL`)
      .all(now - maxAgeMs) as { id: string }[]).map((r) => r.id);
    for (const id of ids) {
      d.prepare('DELETE FROM cal_drafts WHERE id = ?').run(id);
      recordEvent({ entity: 'cal_draft', id, op: 'delete' }, d);
    }
    return ids.length;
  })();
}

// ── sync state ───────────────────────────────────────────────────────────────────────────────────────────────────

export function getSyncState(account: string, resource: string): SyncStateRow | null {
  return (appDb().prepare('SELECT * FROM sync_state WHERE account = ? AND resource = ?').get(account, resource) as SyncStateRow | undefined) ?? null;
}
export function setSyncState(account: string, resource: string, set: Partial<Omit<SyncStateRow, 'account' | 'resource'>>, d: AppDb = appDb()): void {
  d.prepare(`INSERT INTO sync_state (account, resource) VALUES (?, ?) ON CONFLICT (account, resource) DO NOTHING`).run(account, resource);
  const cols = Object.keys(set);
  if (!cols.length) return;
  d.prepare(`UPDATE sync_state SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE account = @account AND resource = @resource`).run({ ...set, account, resource });
}
export function syncStates(resource: string): SyncStateRow[] {
  return appDb().prepare('SELECT * FROM sync_state WHERE resource = ? ORDER BY account').all(resource) as SyncStateRow[];
}

// ── the API shape (api/openapi.yaml: CalendarItem) ───────────────────────────────────────────────────────────────

export type DraftOrigin = 'you' | 'helper' | 'helper-after-reading';
export interface CalendarItem {
  id: string; kind: 'event' | 'draft'; title: string; start: string; end: string; allDay: boolean; location: string | null;
  provider: CalProvider | null; state?: 'draft' | 'confirmed' | 'removed'; addedByHelper?: boolean; confirmedAt?: number | null;
  origin?: DraftOrigin; originNote?: string;
}

/** All-day: the local dates (end exclusive). Timed: UTC instants. */
function whenOut(start: string, end: string, allDay: boolean, tz: string | null): { start: string; end: string } {
  if (!allDay) return { start, end };
  const z = tz || 'UTC';
  return { start: localDate(Date.parse(start), z), end: localDate(Date.parse(end), z) };
}

export function eventItem(r: CalEventRow): CalendarItem {
  return {
    id: eventItemId(r.account, r.provider_id), kind: 'event', title: r.title, ...whenOut(r.start_utc, r.end_utc, r.all_day === 1, r.tz),
    allDay: r.all_day === 1, location: r.location, provider: r.provider, ...(r.is_helper_confirmed ? { addedByHelper: true } : {}),
  };
}
export function draftOrigin(r: Pick<CalDraftRow, 'origin' | 'suggested_after_outside'>): DraftOrigin {
  return r.origin === 'you' ? 'you' : r.suggested_after_outside ? 'helper-after-reading' : 'helper';
}
export function draftItem(r: CalDraftRow): CalendarItem {
  return {
    id: r.id, kind: 'draft', title: r.title, ...whenOut(r.start_utc, r.end_utc, r.all_day === 1, r.tz), allDay: r.all_day === 1,
    location: r.location, provider: r.provider, state: r.state, confirmedAt: r.confirmed_at,
    origin: draftOrigin(r), ...(r.origin_note ? { originNote: r.origin_note } : {}),
  };
}
const sortKey = (r: { start_utc: string; end_utc: string }, id: string) => `${r.start_utc}|${r.end_utc}|${id}`;

/**
 * Events and drafts in [from, to), merged and sorted by start. A confirmed draft is shown once: as the calendar's
 * event (marked addedByHelper) once the cache has it, else as the confirmed draft.
 */
export function calendarItems(from: string, to: string): CalendarItem[] {
  const evs = eventsBetween(from, to);
  const have = new Set(evs.map((e) => `${e.provider}:${e.provider_id}`));
  const drafts = draftsBetween(from, to).filter((x) => !(x.state === 'confirmed' && x.provider && x.provider_id && have.has(`${x.provider}:${x.provider_id}`)));
  const rows: { k: string; item: CalendarItem }[] = [
    ...evs.map((e) => ({ k: sortKey(e, eventItemId(e.account, e.provider_id)), item: eventItem(e) })),
    ...drafts.map((x) => ({ k: sortKey(x, x.id), item: draftItem(x) })),
  ];
  return rows.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0)).map((r) => r.item);
}

/** One item by its API id (an event '<account>:<provider id>' or a draft 'cd_…'), or null when gone. */
export function calendarItemById(id: string): CalendarItem | null {
  if (id.startsWith('cd_')) {
    const x = getDraft(id);
    if (!x || x.state === 'removed') return null;
    // confirmed and already in the cache: the calendar's event stands for it (shown once, as in calendarItems)
    if (x.state === 'confirmed' && x.provider && x.provider_id && appDb().prepare('SELECT 1 FROM cal_events WHERE provider = ? AND provider_id = ?').get(x.provider, x.provider_id)) return null;
    return draftItem(x);
  }
  const i = id.lastIndexOf(':'); // provider ids hold no ':'; an account may ('google:me@example.com')
  if (i < 0) return null;
  const e = getCalEvent(id.slice(0, i), id.slice(i + 1));
  return e && e.status !== 'cancelled' ? eventItem(e) : null;
}
