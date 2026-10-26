/**
 * Google Calendar → the cache (v2 build, slice A7).
 *
 * Full sync: events.list on the primary calendar with singleEvents=true (recurring events arrive as their
 * instances) over the window (yesterday … 14 days ahead), every page, then the cache is made to match — anything
 * cached and no longer listed is dropped. The last page's nextSyncToken is kept.
 * Incremental: events.list with that syncToken (Google refuses timeMin/timeMax beside it) returns only what changed;
 * a cancelled event (or instance) is removed from the cache; one that moved out of the window is dropped.
 * 410 Gone (the token expired or was invalidated) → a full sync of the window.
 * A new day moves the window, which also means a full sync.
 *
 * All-day events carry dates; they are stored as the local midnights of those dates in the calendar's zone (the
 * list response's timeZone). Timed events carry an offset (or a timeZone) and are stored in UTC.
 */
import type { calendar_v3 } from 'googleapis';
import { appDb } from '../v2/db.js';
import { upsertCalEvent, deleteCalEvent, pruneCalEvents, getSyncState, setSyncState, type CalEventIn } from '../v2/calendar.js';
import { parseWhen, localMidnight, iso, validTz } from './tz.js';

export const GOOGLE_ACCOUNT = 'google';

export interface CalWindow { from: string; to: string; fromMs: number; toMs: number }

export interface GoogleCalDeps {
  /** a Calendar API client (google.calendar v3), already signed in */
  calendar: () => Promise<calendar_v3.Calendar>;
  window: CalWindow;
  /** the zone to read all-day dates in when the calendar does not say */
  tz: string;
  calendarId?: string;
}

export interface SyncResult { account: string; mode: 'full' | 'incremental'; upserted: number; deleted: number; pages: number; resynced?: boolean }

const statusOf = (e: calendar_v3.Schema$Event): string => {
  const self = e.attendees?.find((a) => a.self);
  if (self?.responseStatus === 'declined') return 'declined';
  return e.status ?? 'confirmed';
};

/** One Google event (or instance) → the cache's shape, or null when it cannot be placed in time. */
export function mapGoogleEvent(e: calendar_v3.Schema$Event, calTz: string, calendarId: string): CalEventIn | null {
  if (!e.id) return null;
  const tz = e.start?.timeZone && validTz(e.start.timeZone) ? e.start.timeZone : calTz;
  let startMs: number, endMs: number, allDay = false;
  if (e.start?.date) {
    allDay = true;
    startMs = localMidnight(e.start.date, calTz);
    endMs = e.end?.date ? localMidnight(e.end.date, calTz) : startMs + 86_400_000;
  } else if (e.start?.dateTime) {
    startMs = parseWhen(e.start.dateTime, tz).ms;
    const endTz = e.end?.timeZone && validTz(e.end.timeZone) ? e.end.timeZone : tz;
    endMs = e.end?.dateTime ? parseWhen(e.end.dateTime, endTz).ms : startMs;
  } else return null;
  if (endMs < startMs) endMs = startMs;
  return {
    provider_id: e.id, calendar_id: calendarId, etag: e.etag ?? null, start_utc: iso(startMs), end_utc: iso(endMs), all_day: allDay,
    tz: allDay ? calTz : tz, title: e.summary ?? '(no title)', location: e.location ?? null, status: statusOf(e),
    recurring_id: e.recurringEventId ?? null,
  };
}

function httpStatus(err: unknown): number | undefined {
  const e = err as { code?: unknown; status?: unknown; response?: { status?: number } };
  const n = Number(e?.response?.status ?? e?.status ?? e?.code);
  return Number.isFinite(n) ? n : undefined;
}

export async function syncGoogleCalendar(deps: GoogleCalDeps): Promise<SyncResult> {
  const account = GOOGLE_ACCOUNT, calendarId = deps.calendarId ?? 'primary';
  const st = getSyncState(account, 'calendar');
  const sameWindow = st?.window_from === deps.window.from && st?.window_to === deps.window.to;
  if (st?.cursor && sameWindow) {
    try { return await incremental(deps, st.cursor, calendarId); } catch (e) {
      if (httpStatus(e) !== 410) throw e;
      setSyncState(account, 'calendar', { cursor: null });
      return { ...(await full(deps, calendarId)), resynced: true };
    }
  }
  return full(deps, calendarId);
}

async function full(deps: GoogleCalDeps, calendarId: string): Promise<SyncResult> {
  const cal = await deps.calendar();
  const seen = new Map<string, CalEventIn>();
  const gone = new Set<string>();
  let pageToken: string | undefined, syncToken: string | undefined, pages = 0;
  do {
    const r = await cal.events.list({
      calendarId, singleEvents: true, timeMin: deps.window.from, timeMax: deps.window.to, maxResults: 250, pageToken,
    });
    pages++;
    const calTz = r.data.timeZone && validTz(r.data.timeZone) ? r.data.timeZone : deps.tz;
    for (const e of r.data.items ?? []) {
      if (!e.id) continue;
      if (e.status === 'cancelled') { gone.add(e.id); seen.delete(e.id); continue; }
      const m = mapGoogleEvent(e, calTz, calendarId);
      if (m) seen.set(e.id, m);
    }
    pageToken = r.data.nextPageToken ?? undefined;
    syncToken = r.data.nextSyncToken ?? syncToken;
  } while (pageToken && pages < 200);
  const d = appDb();
  let upserted = 0, deleted = 0;
  d.transaction(() => {
    for (const m of seen.values()) if (upsertCalEvent(GOOGLE_ACCOUNT, 'google', m, d)) upserted++;
    deleted = pruneCalEvents(GOOGLE_ACCOUNT, new Set(seen.keys()), d);
    setSyncState(GOOGLE_ACCOUNT, 'calendar', { cursor: syncToken ?? null, window_from: deps.window.from, window_to: deps.window.to }, d);
  })();
  return { account: GOOGLE_ACCOUNT, mode: 'full', upserted, deleted, pages };
}

async function incremental(deps: GoogleCalDeps, token: string, calendarId: string): Promise<SyncResult> {
  const cal = await deps.calendar();
  const changes: calendar_v3.Schema$Event[] = [];
  let pageToken: string | undefined, next: string | undefined, pages = 0, calTz = deps.tz;
  do {
    // singleEvents must match the request that produced the token
    const r = await cal.events.list({ calendarId, singleEvents: true, syncToken: token, maxResults: 250, pageToken });
    pages++;
    if (r.data.timeZone && validTz(r.data.timeZone)) calTz = r.data.timeZone;
    changes.push(...(r.data.items ?? []));
    pageToken = r.data.nextPageToken ?? undefined;
    next = r.data.nextSyncToken ?? next;
  } while (pageToken && pages < 200);
  const d = appDb();
  let upserted = 0, deleted = 0;
  d.transaction(() => {
    for (const e of changes) {
      if (!e.id) continue;
      const m = e.status === 'cancelled' ? null : mapGoogleEvent(e, calTz, calendarId);
      const inWindow = m && m.start_utc < deps.window.to && m.end_utc > deps.window.from;
      if (m && inWindow) { if (upsertCalEvent(GOOGLE_ACCOUNT, 'google', m, d)) upserted++; }
      else if (deleteCalEvent(GOOGLE_ACCOUNT, e.id, d)) deleted++;
    }
    setSyncState(GOOGLE_ACCOUNT, 'calendar', { cursor: next ?? token }, d);
  })();
  return { account: GOOGLE_ACCOUNT, mode: 'incremental', upserted, deleted, pages };
}
