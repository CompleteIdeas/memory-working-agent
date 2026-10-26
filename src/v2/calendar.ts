/**
 * The calendar cache and MWA-held drafts (v2 build, slice A7, 2026-10-26).
 *
 *   cal_events  — what the connected calendars hold over a window (yesterday … two weeks ahead), synced by
 *                 src/sync/calendar.ts. One row per event instance (recurring events are expanded).
 *   cal_drafts  — events the helper proposed. They live HERE until the person confirms one: nothing is written to
 *                 Google or Outlook before Confirm (it used to insert a real "[Proposed]" event).
 *   sync_state  — per account and resource ('calendar', and 'mail' in slice A8): cursor, window, last success,
 *                 last error, needs_reconnect. Shared with A8, which creates the same table IF NOT EXISTS.
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
    CREATE TABLE IF NOT EXISTS cal_drafts (
      id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, start_utc TEXT NOT NULL, end_utc TEXT NOT NULL,
      all_day INTEGER NOT NULL DEFAULT 0, tz TEXT, location TEXT, notes TEXT, source_item TEXT, created_by_try TEXT,
      state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','confirmed','removed')),
      provider TEXT CHECK (provider IS NULL OR provider IN ('google','outlook')), provider_id TEXT, confirmed_at INTEGER,
      confirm_lease INTEGER, created_at INTEGER NOT NULL, updated_seq INTEGER);
    CREATE INDEX IF NOT EXISTS cal_drafts_start ON cal_drafts(start_utc);
    CREATE TABLE IF NOT EXISTS sync_state (
      account TEXT NOT NULL, resource TEXT NOT NULL, cursor TEXT, window_from TEXT, window_to TEXT,
      last_ok INTEGER, last_error TEXT, needs_reconnect INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (account, resource));`,
}]);

export type CalProvider = 'google' | 'outlook';

export interface CalEventRow {
  account: string; provider: CalProvider; provider_id: string; calendar_id: string | null; etag: string | null;
  start_utc: string; end_utc: string; all_day: number; tz: string | null; title: string; location: string | null;
  status: string; recurring_id: string | null; is_helper_confirmed: number; updated_seq: number | null;
}
export interface CalDraftRow {
  id: string; project_id: string | null; title: string; start_utc: string; end_utc: string; all_day: number; tz: string | null;
  location: string | null; notes: string | null; source_item: string | null; created_by_try: string | null;
  state: 'draft' | 'confirmed' | 'removed'; provider: CalProvider | null; provider_id: string | null; confirmed_at: number | null;
  confirm_lease: number | null; created_at: number; updated_seq: number | null;
}
export interface SyncStateRow {
  account: string; resource: string; cursor: string | null; window_from: string | null; window_to: string | null;
  last_ok: number | null; last_error: string | null; needs_reconnect: number;
}

/** An event as the sync hands it over (already in UTC). */
export interface CalEventIn {
  provider_id: string; calendar_id?: string | null; etag?: string | null; start_utc: string; end_utc: string;
  all_day: boolean; tz?: string | null; title: string; location?: string | null; status?: string; recurring_id?: string | null;
}

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

/** Drop an account's cached events that are not in `keep` (after a full sync). Returns how many went. */
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
}

export function createDraft(x: DraftIn, d: AppDb = appDb()): CalDraftRow {
  const title = x.title.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!title) throw new Error('A draft needs a title.');
  if (!(x.endMs > x.startMs)) throw new Error('The end must be after the start.');
  const id = `cd_${randomBytes(9).toString('base64url').replace(/[-_]/g, 'x')}`;
  return d.transaction(() => {
    const seq = recordEvent({ entity: 'cal_draft', id }, d);
    d.prepare(`INSERT INTO cal_drafts (id, project_id, title, start_utc, end_utc, all_day, tz, location, notes, source_item, created_by_try, state, provider, created_at, updated_seq)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`).run(
      id, x.projectId ?? null, title, iso(x.startMs), iso(x.endMs), x.allDay ? 1 : 0, x.tz ?? null, x.location?.trim() || null,
      x.notes?.trim() || null, x.sourceItem ?? null, x.createdByTry ?? null, x.provider ?? null, Date.now(), seq);
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

/** Change a draft's fields in one transaction with its event. */
export function updateDraft(id: string, set: Partial<Pick<CalDraftRow, 'state' | 'provider' | 'provider_id' | 'confirmed_at' | 'confirm_lease'>>, d: AppDb = appDb()): CalDraftRow {
  return d.transaction(() => {
    const seq = recordEvent({ entity: 'cal_draft', id, op: 'upsert' }, d);
    const cols = Object.keys(set) as (keyof typeof set)[];
    d.prepare(`UPDATE cal_drafts SET ${cols.map((c) => `${c} = @${c}`).join(', ')}${cols.length ? ', ' : ''}updated_seq = @seq WHERE id = @id`).run({ ...set, seq, id });
    return getDraft(id, d)!;
  })();
}

/**
 * Take the right to confirm a draft: one confirm at a time, across requests (and processes). Returns the draft when
 * this caller holds the lease, or why not. A lease older than `leaseMs` (the process died mid-confirm) can be taken
 * again — safe, because the provider insert itself is idempotent (a fixed event id / transactionId).
 */
export function takeConfirmLease(id: string, leaseMs = 120_000, now = Date.now()): { ok: true; draft: CalDraftRow } | { ok: false; why: 'missing' | 'confirmed' | 'removed' | 'busy'; draft?: CalDraftRow } {
  const d = appDb();
  return d.transaction(() => {
    const cur = getDraft(id, d);
    if (!cur) return { ok: false as const, why: 'missing' as const };
    if (cur.state === 'confirmed') return { ok: false as const, why: 'confirmed' as const, draft: cur };
    if (cur.state === 'removed') return { ok: false as const, why: 'removed' as const, draft: cur };
    if (cur.confirm_lease && now - cur.confirm_lease < leaseMs) return { ok: false as const, why: 'busy' as const, draft: cur };
    d.prepare('UPDATE cal_drafts SET confirm_lease = ? WHERE id = ?').run(now, id);
    return { ok: true as const, draft: { ...cur, confirm_lease: now } };
  }).immediate();
}
export function releaseConfirmLease(id: string): void {
  appDb().prepare('UPDATE cal_drafts SET confirm_lease = NULL WHERE id = ?').run(id);
}

/** Mark a confirmed draft's event in the cache as the helper's (and put it there now, before the next sync). */
export function recordConfirmed(draft: CalDraftRow, provider: CalProvider, providerId: string, account: string = provider): CalDraftRow {
  const d = appDb();
  return d.transaction(() => {
    upsertCalEvent(account, provider, {
      provider_id: providerId, start_utc: draft.start_utc, end_utc: draft.end_utc, all_day: draft.all_day === 1, tz: draft.tz,
      title: draft.title, location: draft.location, status: 'confirmed', calendar_id: 'primary',
    }, d);
    d.prepare('UPDATE cal_events SET is_helper_confirmed = 1 WHERE account = ? AND provider_id = ?').run(account, providerId);
    return updateDraft(draft.id, { state: 'confirmed', provider, provider_id: providerId, confirmed_at: Date.now(), confirm_lease: null }, d);
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

export interface CalendarItem {
  id: string; kind: 'event' | 'draft'; title: string; start: string; end: string; allDay: boolean; location: string | null;
  provider: CalProvider | null; state?: 'draft' | 'confirmed' | 'removed'; addedByHelper?: boolean; confirmedAt?: number | null;
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
export function draftItem(r: CalDraftRow): CalendarItem {
  return {
    id: r.id, kind: 'draft', title: r.title, ...whenOut(r.start_utc, r.end_utc, r.all_day === 1, r.tz), allDay: r.all_day === 1,
    location: r.location, provider: r.provider, state: r.state, confirmedAt: r.confirmed_at,
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

/** One item by its API id (an event 'account:provider_id' or a draft 'cd_…'), or null when gone. */
export function calendarItemById(id: string): CalendarItem | null {
  if (id.startsWith('cd_')) {
    const x = getDraft(id);
    if (!x || x.state === 'removed') return null;
    // confirmed and already in the cache: the calendar's event stands for it (shown once, as in calendarItems)
    if (x.state === 'confirmed' && x.provider && x.provider_id && appDb().prepare('SELECT 1 FROM cal_events WHERE provider = ? AND provider_id = ?').get(x.provider, x.provider_id)) return null;
    return draftItem(x);
  }
  const i = id.indexOf(':');
  if (i < 0) return null;
  const e = getCalEvent(id.slice(0, i), id.slice(i + 1));
  return e && e.status !== 'cancelled' ? eventItem(e) : null;
}
