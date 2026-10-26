/**
 * Outlook (Microsoft Graph) calendar → the cache (v2 build, slice A7).
 *
 * Full sync: GET /me/calendarView/delta over the window (occurrences of a series arrive as instances), following
 * @odata.nextLink to the end; the last page's @odata.deltaLink is the cursor, and the cache is made to match.
 * Incremental: GET the deltaLink; an entry with @removed (or isCancelled) is deleted from the cache, and a removed or
 * cancelled series master takes its occurrences with it.
 * 410 Gone (the delta token expired) → a full sync of the window. A new day moves the window: a full sync.
 *
 * Paging is bounded: a link seen twice, or more than MAX_PAGES pages, stops it. A full sync cut short prunes nothing
 * and keeps no cursor; an incremental one cut short keeps its old deltaLink.
 *
 * Times are asked for in UTC (Prefer: outlook.timezone="UTC"). An all-day event's dates are read in the person's
 * zone (its originalStartTimeZone when that is an IANA name). Every Graph call here has a 60 s timeout.
 */
import { appDb } from '../v2/db.js';
import { upsertCalEvent, deleteCalEvent, deleteCalSeries, pruneCalEvents, getSyncState, setSyncState, type CalEventIn } from '../v2/calendar.js';
import { zonedToUtc, localMidnight, iso, validTz } from './tz.js';
import { errorStatus } from './errors.js';
import { MAX_PAGES, type CalWindow, type SyncResult } from './google-calendar.js';

export const OUTLOOK_ACCOUNT = 'outlook';
export const GRAPH_TIMEOUT_MS = 60_000;

export interface OutlookCalDeps {
  /** a Graph call with the signed-in token (src/connectors/microsoft.ts graph) */
  graph: (path: string, init?: RequestInit) => Promise<any>;
  window: CalWindow;
  tz: string;
  /** the cache's account key ('outlook:<address>', or 'outlook') */
  account?: string;
}

const PREFER = { prefer: 'outlook.timezone="UTC", odata.maxpagesize=100' };

/** Graph's "2026-11-14T20:00:00.0000000" in a zone → ms (null when it is not a real time). */
function graphWhen(t: { dateTime?: string; timeZone?: string } | undefined): number | null {
  if (!t?.dateTime) return null;
  const wall = t.dateTime.replace(/Z$/i, '').replace(/\.\d+$/, '');
  const tz = !t.timeZone || /^(utc|coordinated universal time)$/i.test(t.timeZone) || !validTz(t.timeZone) ? 'UTC' : t.timeZone; // we asked for UTC
  try { return zonedToUtc(wall, tz); } catch { return null; }
}

export function mapOutlookEvent(e: any, personTz: string): CalEventIn | null {
  if (!e?.id || e.type === 'seriesMaster') return null;
  const tz = typeof e.originalStartTimeZone === 'string' && validTz(e.originalStartTimeZone) ? e.originalStartTimeZone : personTz;
  let startMs: number | null, endMs: number | null;
  const allDay = e.isAllDay === true;
  try {
    if (allDay) {
      const sd = String(e.start?.dateTime ?? '').slice(0, 10), ed = String(e.end?.dateTime ?? '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(sd)) return null;
      startMs = localMidnight(sd, tz);
      endMs = /^\d{4}-\d{2}-\d{2}$/.test(ed) ? localMidnight(ed, tz) : startMs + 86_400_000;
    } else {
      startMs = graphWhen(e.start); endMs = graphWhen(e.end);
    }
  } catch { return null; }
  if (startMs === null) return null;
  if (endMs === null || endMs < startMs) endMs = startMs;
  const declined = e.responseStatus?.response === 'declined';
  return {
    provider_id: String(e.id), calendar_id: 'primary', etag: e.changeKey ?? e['@odata.etag'] ?? null, start_utc: iso(startMs), end_utc: iso(endMs),
    all_day: allDay, tz: allDay ? tz : 'UTC', title: e.subject ?? '(no title)', location: e.location?.displayName || null,
    status: e.isCancelled ? 'cancelled' : declined ? 'declined' : (e.showAs === 'tentative' ? 'tentative' : 'confirmed'),
    recurring_id: e.seriesMasterId ?? null,
  };
}

export async function syncOutlookCalendar(deps: OutlookCalDeps): Promise<SyncResult> {
  const account = deps.account ?? OUTLOOK_ACCOUNT;
  const st = getSyncState(account, 'calendar');
  const sameWindow = st?.window_from === deps.window.fromMs && st?.window_to === deps.window.toMs;
  if (st?.cursor && sameWindow) {
    try { return await pull(deps, account, st.cursor, 'incremental'); } catch (e) {
      if (errorStatus(e) !== 410) throw e;
      setSyncState(account, 'calendar', { cursor: null });
      return { ...(await pull(deps, account, null, 'full')), resynced: true };
    }
  }
  return pull(deps, account, null, 'full');
}

async function pull(deps: OutlookCalDeps, account: string, deltaLink: string | null, mode: 'full' | 'incremental'): Promise<SyncResult> {
  let link: string | null = deltaLink
    ?? `/me/calendarView/delta?startDateTime=${encodeURIComponent(deps.window.from)}&endDateTime=${encodeURIComponent(deps.window.to)}`;
  const upserts = new Map<string, CalEventIn>(), removed = new Set<string>(), series = new Set<string>();
  const seenLinks = new Set<string>();
  let next: string | null = null, pages = 0, truncated = false;
  while (link) {
    if (seenLinks.has(link) || pages >= MAX_PAGES) { truncated = true; break; }
    seenLinks.add(link);
    const r = await deps.graph(link, { headers: PREFER, signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS) });
    pages++;
    for (const e of r.value ?? []) {
      if (!e?.id) continue;
      const id = String(e.id);
      // a series master removed or cancelled: its occurrences go too (their recurring_id is its id)
      if (e.type === 'seriesMaster' && (e['@removed'] || e.isCancelled)) { series.add(id); continue; }
      if (e['@removed']) { removed.add(id); series.add(id); upserts.delete(id); continue; } // may have been a master
      const m = mapOutlookEvent(e, deps.tz);
      if (!m || m.status === 'cancelled') { if (e.type !== 'seriesMaster') { removed.add(id); upserts.delete(id); } continue; }
      upserts.set(id, m); removed.delete(id);
    }
    if (r['@odata.deltaLink']) { next = r['@odata.deltaLink']; link = null; }
    else link = r['@odata.nextLink'] ?? null;
  }
  const d = appDb();
  let upserted = 0, deleted = 0;
  const inWindow = (m: CalEventIn) => m.start_utc < deps.window.to && m.end_utc > deps.window.from;
  d.transaction(() => {
    for (const m of upserts.values()) {
      if (inWindow(m)) { if (upsertCalEvent(account, 'outlook', m, d)) upserted++; }
      else if (deleteCalEvent(account, m.provider_id, d)) deleted++;
    }
    for (const id of removed) if (deleteCalEvent(account, id, d)) deleted++;
    for (const id of series) deleted += deleteCalSeries(account, id, d);
    if (mode === 'full' && !truncated) deleted += pruneCalEvents(account, new Set([...upserts.values()].filter(inWindow).map((m) => m.provider_id)), d);
    const cursor = truncated ? (mode === 'full' ? null : deltaLink) : next ?? deltaLink;
    setSyncState(account, 'calendar', {
      cursor, ...(mode === 'full' ? { window_from: deps.window.fromMs, window_to: deps.window.toMs } : {}),
      ...(truncated ? { last_error: 'The calendar listing was cut short; nothing was removed. It will be read again.' } : {}),
    }, d);
  })();
  return { account, mode, upserted, deleted, pages, ...(truncated ? { truncated: true } : {}) };
}
