/**
 * Outlook (Microsoft Graph) calendar → the cache (v2 build, slice A7).
 *
 * Full sync: GET /me/calendarView/delta over the window (occurrences of a series arrive as instances), following
 * @odata.nextLink to the end; the last page's @odata.deltaLink is the cursor, and the cache is made to match.
 * Incremental: GET the deltaLink; an entry with @removed (or isCancelled) is deleted from the cache.
 * 410 Gone (the delta token expired) → a full sync of the window. A new day moves the window: a full sync.
 *
 * Times are asked for in UTC (Prefer: outlook.timezone="UTC"). An all-day event's dates are read in the person's
 * zone (its originalStartTimeZone when that is an IANA name).
 */
import { appDb } from '../v2/db.js';
import { upsertCalEvent, deleteCalEvent, pruneCalEvents, getSyncState, setSyncState, type CalEventIn } from '../v2/calendar.js';
import { zonedToUtc, localMidnight, iso, validTz } from './tz.js';
import type { CalWindow, SyncResult } from './google-calendar.js';

export const OUTLOOK_ACCOUNT = 'outlook';

export interface OutlookCalDeps {
  /** a Graph call with the signed-in token (src/connectors/microsoft.ts graph) */
  graph: (path: string, init?: RequestInit) => Promise<any>;
  window: CalWindow;
  tz: string;
}

const PREFER = { prefer: 'outlook.timezone="UTC", odata.maxpagesize=100' };

/** Graph's "2026-11-14T20:00:00.0000000" in a zone → ms. */
function graphWhen(t: { dateTime?: string; timeZone?: string } | undefined): number | null {
  if (!t?.dateTime) return null;
  const wall = t.dateTime.replace(/(\.\d{3})\d*$/, '$1').replace(/Z$/i, '');
  const tz = !t.timeZone || /^(utc|coordinated universal time)$/i.test(t.timeZone) ? 'UTC' : t.timeZone;
  if (!validTz(tz)) return zonedToUtc(wall.replace(/\.\d+$/, ''), 'UTC'); // a Windows zone name: we asked for UTC, so it is rare
  return zonedToUtc(wall.replace(/\.\d+$/, ''), tz);
}

export function mapOutlookEvent(e: any, personTz: string): CalEventIn | null {
  if (!e?.id || e.type === 'seriesMaster') return null;
  const tz = typeof e.originalStartTimeZone === 'string' && validTz(e.originalStartTimeZone) ? e.originalStartTimeZone : personTz;
  let startMs: number | null, endMs: number | null;
  const allDay = e.isAllDay === true;
  if (allDay) {
    const sd = String(e.start?.dateTime ?? '').slice(0, 10), ed = String(e.end?.dateTime ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sd)) return null;
    startMs = localMidnight(sd, tz);
    endMs = /^\d{4}-\d{2}-\d{2}$/.test(ed) ? localMidnight(ed, tz) : startMs + 86_400_000;
  } else {
    startMs = graphWhen(e.start); endMs = graphWhen(e.end);
  }
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

const statusOf = (err: unknown): number | undefined => {
  const n = Number((err as { status?: unknown })?.status);
  return Number.isFinite(n) ? n : undefined;
};

export async function syncOutlookCalendar(deps: OutlookCalDeps): Promise<SyncResult> {
  const st = getSyncState(OUTLOOK_ACCOUNT, 'calendar');
  const sameWindow = st?.window_from === deps.window.from && st?.window_to === deps.window.to;
  if (st?.cursor && sameWindow) {
    try { return await pull(deps, st.cursor, 'incremental'); } catch (e) {
      if (statusOf(e) !== 410) throw e;
      setSyncState(OUTLOOK_ACCOUNT, 'calendar', { cursor: null });
      return { ...(await pull(deps, null, 'full')), resynced: true };
    }
  }
  return pull(deps, null, 'full');
}

async function pull(deps: OutlookCalDeps, deltaLink: string | null, mode: 'full' | 'incremental'): Promise<SyncResult> {
  let link: string | null = deltaLink
    ?? `/me/calendarView/delta?startDateTime=${encodeURIComponent(deps.window.from)}&endDateTime=${encodeURIComponent(deps.window.to)}`;
  const upserts = new Map<string, CalEventIn>(), removed = new Set<string>();
  let next: string | null = null, pages = 0;
  while (link && pages < 200) {
    const r = await deps.graph(link, { headers: PREFER });
    pages++;
    for (const e of r.value ?? []) {
      if (!e?.id) continue;
      const id = String(e.id);
      const m = e['@removed'] ? null : mapOutlookEvent(e, deps.tz);
      if (!m || m.status === 'cancelled') { if (e.type !== 'seriesMaster') { removed.add(id); upserts.delete(id); } continue; }
      upserts.set(id, m); removed.delete(id);
    }
    if (r['@odata.deltaLink']) { next = r['@odata.deltaLink']; link = null; }
    else link = r['@odata.nextLink'] ?? null;
  }
  const d = appDb();
  let upserted = 0, deleted = 0;
  d.transaction(() => {
    for (const m of upserts.values()) {
      const inWindow = m.start_utc < deps.window.to && m.end_utc > deps.window.from;
      if (inWindow) { if (upsertCalEvent(OUTLOOK_ACCOUNT, 'outlook', m, d)) upserted++; }
      else if (deleteCalEvent(OUTLOOK_ACCOUNT, m.provider_id, d)) deleted++;
    }
    if (mode === 'full') deleted += pruneCalEvents(OUTLOOK_ACCOUNT, new Set([...upserts.values()].filter((m) => m.start_utc < deps.window.to && m.end_utc > deps.window.from).map((m) => m.provider_id)), d);
    else for (const id of removed) if (deleteCalEvent(OUTLOOK_ACCOUNT, id, d)) deleted++;
    setSyncState(OUTLOOK_ACCOUNT, 'calendar', { cursor: next ?? deltaLink, ...(mode === 'full' ? { window_from: deps.window.from, window_to: deps.window.to } : {}) }, d);
  })();
  return { account: OUTLOOK_ACCOUNT, mode, upserted, deleted, pages };
}
