/**
 * Google Calendar → the cache (v2 build, slice A7).
 *
 * Full sync: events.list on the primary calendar with singleEvents=true (recurring events arrive as their
 * instances) over the window (yesterday … 14 days ahead), every page, then the cache is made to match — anything
 * cached and no longer listed is dropped. The last page's nextSyncToken is kept.
 * Incremental: events.list with that syncToken (Google refuses timeMin/timeMax beside it) returns only what changed;
 * a cancelled event (or instance) is removed from the cache, and a cancelled series master takes its instances with
 * it; one that moved out of the window is dropped.
 * 410 Gone (the token expired or was invalidated) → a full sync of the window. A new day moves the window: a full sync.
 *
 * Paging is bounded (review of A7): a page token seen twice, or more than MAX_PAGES pages, stops the listing. A full
 * sync cut short that way prunes nothing (it did not see everything) and keeps no cursor, so the next one starts over;
 * an incremental one cut short keeps its old cursor (re-applying changes is harmless).
 *
 * All-day events carry dates; they are stored as the local midnights of those dates in the calendar's zone (the
 * list response's timeZone). Timed events carry an offset (or a timeZone) and are stored in UTC.
 */
import type { calendar_v3 } from 'googleapis';
import { appDb } from '../v2/db.js';
import { upsertCalEvent, deleteCalEvent, deleteCalSeries, pruneCalEvents, getSyncState, setSyncState, type CalEventIn } from '../v2/calendar.js';
import { parseWhen, localMidnight, iso, validTz } from './tz.js';
import { errorStatus } from './errors.js';

export const GOOGLE_ACCOUNT = 'google';
export const MAX_PAGES = 200;

export interface CalWindow { from: string; to: string; fromMs: number; toMs: number }

export interface GoogleCalDeps {
  /** a Calendar API client (google.calendar v3), already signed in */
  calendar: () => Promise<calendar_v3.Calendar>;
  window: CalWindow;
  /** the zone to read all-day dates in when the calendar does not say */
  tz: string;
  /** the cache's account key ('google:<address>', or 'google') */
  account?: string;
  calendarId?: string;
}

export interface SyncResult { account: string; mode: 'full' | 'incremental'; upserted: number; deleted: number; pages: number; resynced?: boolean; truncated?: boolean }

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
  try {
    if (e.start?.date) {
      allDay = true;
      startMs = localMidnight(e.start.date, calTz);
      endMs = e.end?.date ? localMidnight(e.end.date, calTz) : startMs + 86_400_000;
    } else if (e.start?.dateTime) {
      startMs = parseWhen(e.start.dateTime, tz).ms;
      const endTz = e.end?.timeZone && validTz(e.end.timeZone) ? e.end.timeZone : tz;
      endMs = e.end?.dateTime ? parseWhen(e.end.dateTime, endTz).ms : startMs;
    } else return null;
  } catch { return null; } // a time that does not exist: skip it rather than store a wrong one
  if (endMs < startMs) endMs = startMs;
  return {
    provider_id: e.id, calendar_id: calendarId, etag: e.etag ?? null, start_utc: iso(startMs), end_utc: iso(endMs), all_day: allDay,
    tz: allDay ? calTz : tz, title: e.summary ?? '(no title)', location: e.location ?? null, status: statusOf(e),
    recurring_id: e.recurringEventId ?? null,
  };
}

export async function syncGoogleCalendar(deps: GoogleCalDeps): Promise<SyncResult> {
  const account = deps.account ?? GOOGLE_ACCOUNT, calendarId = deps.calendarId ?? 'primary';
  const st = getSyncState(account, 'calendar');
  const sameWindow = st?.window_from === deps.window.fromMs && st?.window_to === deps.window.toMs;
  if (st?.cursor && sameWindow) {
    try { return await incremental(deps, account, st.cursor, calendarId); } catch (e) {
      if (errorStatus(e) !== 410) throw e;
      setSyncState(account, 'calendar', { cursor: null });
      return { ...(await full(deps, account, calendarId)), resynced: true };
    }
  }
  return full(deps, account, calendarId);
}

/** Every page of one listing; stops on a repeated page token or at MAX_PAGES (then `truncated`). */
async function pages(list: (pageToken?: string) => Promise<calendar_v3.Schema$Events>): Promise<{ items: calendar_v3.Schema$Event[]; syncToken?: string; timeZone?: string; pages: number; truncated: boolean }> {
  const items: calendar_v3.Schema$Event[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined, syncToken: string | undefined, timeZone: string | undefined, n = 0;
  for (;;) {
    const data = await list(pageToken);
    n++;
    items.push(...(data.items ?? []));
    if (data.timeZone) timeZone = data.timeZone;
    syncToken = data.nextSyncToken ?? syncToken;
    const next = data.nextPageToken ?? undefined;
    if (!next) return { items, syncToken, timeZone, pages: n, truncated: false };
    if (seen.has(next) || n >= MAX_PAGES) return { items, timeZone, pages: n, truncated: true };
    seen.add(next);
    pageToken = next;
  }
}

async function full(deps: GoogleCalDeps, account: string, calendarId: string): Promise<SyncResult> {
  const cal = await deps.calendar();
  const r = await pages(async (pageToken) => (await cal.events.list({
    calendarId, singleEvents: true, timeMin: deps.window.from, timeMax: deps.window.to, maxResults: 250, pageToken,
  })).data);
  const calTz = r.timeZone && validTz(r.timeZone) ? r.timeZone : deps.tz;
  const seen = new Map<string, CalEventIn>();
  const cancelled = new Set<string>();
  for (const e of r.items) {
    if (!e.id) continue;
    if (e.status === 'cancelled') { cancelled.add(e.id); seen.delete(e.id); continue; }
    const m = mapGoogleEvent(e, calTz, calendarId);
    if (m) seen.set(e.id, m);
  }
  const d = appDb();
  let upserted = 0, deleted = 0;
  d.transaction(() => {
    for (const m of seen.values()) if (upsertCalEvent(account, 'google', m, d)) upserted++;
    for (const id of cancelled) { if (deleteCalEvent(account, id, d)) deleted++; deleted += deleteCalSeries(account, id, d); }
    if (!r.truncated) deleted += pruneCalEvents(account, new Set(seen.keys()), d);
    setSyncState(account, 'calendar', {
      cursor: r.truncated ? null : r.syncToken ?? null, window_from: deps.window.fromMs, window_to: deps.window.toMs,
      ...(r.truncated ? { last_error: 'The calendar listing was cut short; nothing was removed. It will be read again.' } : {}),
    }, d);
  })();
  return { account, mode: 'full', upserted, deleted, pages: r.pages, ...(r.truncated ? { truncated: true } : {}) };
}

async function incremental(deps: GoogleCalDeps, account: string, token: string, calendarId: string): Promise<SyncResult> {
  const cal = await deps.calendar();
  // singleEvents must match the request that produced the token
  const r = await pages(async (pageToken) => (await cal.events.list({ calendarId, singleEvents: true, syncToken: token, maxResults: 250, pageToken })).data);
  const calTz = r.timeZone && validTz(r.timeZone) ? r.timeZone : deps.tz;
  const d = appDb();
  let upserted = 0, deleted = 0;
  d.transaction(() => {
    for (const e of r.items) {
      if (!e.id) continue;
      if (e.status === 'cancelled') {
        if (deleteCalEvent(account, e.id, d)) deleted++;
        deleted += deleteCalSeries(account, e.id, d); // a cancelled series master: all its instances
        continue;
      }
      const m = mapGoogleEvent(e, calTz, calendarId);
      const inWindow = m && m.start_utc < deps.window.to && m.end_utc > deps.window.from;
      if (m && inWindow) { if (upsertCalEvent(account, 'google', m, d)) upserted++; }
      else if (deleteCalEvent(account, e.id, d)) deleted++;
    }
    setSyncState(account, 'calendar', { cursor: r.truncated ? token : r.syncToken ?? token }, d);
  })();
  return { account, mode: 'incremental', upserted, deleted, pages: r.pages, ...(r.truncated ? { truncated: true } : {}) };
}
