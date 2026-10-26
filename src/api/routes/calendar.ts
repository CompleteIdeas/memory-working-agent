/**
 * /api/v1/calendar (v2 slice A7): the person's calendar — the connected calendars' events from the cache and the
 * drafts MWA holds — and the person's own controls on a draft: Confirm (adds it, no invites), Remove, and a .ics
 * file ("Just give me a file"). Reading needs `read`; anything that changes something needs `act`. Confirm is never a
 * model tool: only the person, through this API, puts a draft on a real calendar.
 */
import { ApiError, type Route } from '../router.js';
import { calendarItems, draftItem, getDraft } from '../../v2/calendar.js';
import { addDraft, confirmDraft, removeDraft, DraftError } from '../../sync/drafts.js';
import { findConflicts } from '../../sync/conflicts.js';
import { calendarAccounts, calendarWindow, calendarTz, refresh } from '../../sync/calendar.js';
import { buildIcs, icsFileName } from '../../sync/ics.js';
import { localDate, parseWhen, iso, localMidnight, addDays } from '../../sync/tz.js';

const MAX_RANGE_MS = 62 * 86_400_000;

function when(v: string | null, name: string): number | null {
  if (v === null || v === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/i.test(v)) throw new ApiError(400, 'bad_range', `${name} must be a date (2026-11-14) or an ISO 8601 time.`);
  try { return parseWhen(v, calendarTz()).ms; } catch { throw new ApiError(400, 'bad_range', `${name} is not a date I can read.`); }
}

const rethrow = (e: unknown): never => {
  if (e instanceof DraftError) throw new ApiError(e.status, e.code, e.message, e.transient);
  throw e;
};

const str = (v: unknown, name: string, max: number, required = false): string | undefined => {
  if (v === undefined || v === null || v === '') { if (required) throw new ApiError(400, 'bad_draft', `${name} is required.`); return undefined; }
  if (typeof v !== 'string') throw new ApiError(400, 'bad_draft', `${name} must be text.`);
  if (v.length > max) throw new ApiError(400, 'bad_draft', `${name} is too long.`);
  return v;
};
const providerOf = (v: unknown): 'google' | 'outlook' | undefined => {
  if (v === undefined || v === null) return undefined;
  if (v !== 'google' && v !== 'outlook') throw new ApiError(400, 'bad_provider', 'provider must be google or outlook.');
  return v;
};
const bodyObj = (b: unknown): Record<string, unknown> => {
  if (b === undefined || b === null) return {};
  if (typeof b !== 'object' || Array.isArray(b)) throw new ApiError(400, 'bad_json', 'Send a JSON object.');
  return b as Record<string, unknown>;
};

function loadDraft(id: string) {
  const d = getDraft(id);
  if (!d) throw new ApiError(404, 'not_found', 'No such draft.');
  return d;
}

export const calendarRoutes: Route[] = [
  {
    method: 'GET', path: '/calendar', scope: 'read',
    handler: ({ url }) => {
      const w = calendarWindow();
      const fromMs = when(url.searchParams.get('from'), 'from') ?? w.fromMs;
      const toRaw = url.searchParams.get('to') ?? '';
      let toMs = when(toRaw, 'to') ?? w.toMs;
      if (/^\d{4}-\d{2}-\d{2}$/.test(toRaw)) toMs = localMidnight(addDays(toRaw, 1), calendarTz()); // a date 'to' includes that day
      if (toMs <= fromMs) throw new ApiError(400, 'bad_range', 'to must be after from.');
      if (toMs - fromMs > MAX_RANGE_MS) throw new ApiError(400, 'bad_range', 'Ask for at most 62 days at a time.');
      const from = iso(fromMs), to = iso(toMs);
      const conflicts = findConflicts(from, to).map((c) => ({ id: c.id, between: [c.a.id, c.b.id], titles: [c.a.title, c.b.title], start: c.start, end: c.end }));
      return { body: { from, to, items: calendarItems(from, to), conflicts } };
    },
  },
  {
    method: 'GET', path: '/calendar/accounts', scope: 'read',
    handler: () => ({ body: { accounts: calendarAccounts() } }),
  },
  {
    method: 'POST', path: '/calendar/refresh', scope: 'act',
    handler: async () => {
      const results = await refresh();
      return { body: { accounts: calendarAccounts(), results: results.map((r) => ({ account: r.account, ok: r.ok, ...(r.skipped ? { skipped: r.skipped } : {}), ...(r.error ? { error: r.error } : {}) })) } };
    },
  },
  {
    method: 'POST', path: '/calendar/drafts', scope: 'act',
    handler: ({ body }) => {
      const b = bodyObj(body);
      if (b.allDay !== undefined && typeof b.allDay !== 'boolean') throw new ApiError(400, 'bad_draft', 'allDay must be true or false.');
      try {
        const { draft, existing } = addDraft({
          title: str(b.title, 'title', 300, true)!, start: str(b.start, 'start', 40, true)!, end: str(b.end, 'end', 40),
          allDay: b.allDay as boolean | undefined, location: str(b.location, 'location', 300), notes: str(b.notes, 'notes', 4000),
          provider: providerOf(b.provider) ?? null, origin: 'you', projectId: str(b.projectId, 'projectId', 100) ?? null,
        });
        return { status: existing ? 200 : 201, body: { draft: draftItem(draft), message: existing ? 'That draft is already there.' : 'Added as a draft. Nothing is on your calendar until you confirm it.' } };
      } catch (e) { return rethrow(e); }
    },
  },
  {
    method: 'POST', path: '/calendar/drafts/{id}/confirm', scope: 'act',
    handler: async ({ params, body }) => {
      const b = bodyObj(body);
      try {
        const r = await confirmDraft(params.id, { provider: providerOf(b.provider) });
        return { body: { draft: draftItem(r.draft), message: r.message, already: r.already } };
      } catch (e) { return rethrow(e); }
    },
  },
  {
    method: 'POST', path: '/calendar/drafts/{id}/remove', scope: 'act',
    handler: ({ params }) => {
      try {
        const r = removeDraft(params.id);
        return { body: { draft: draftItem(r.draft), message: r.message } };
      } catch (e) { return rethrow(e); }
    },
  },
  {
    method: 'GET', path: '/calendar/drafts/{id}.ics', scope: 'read',
    handler: ({ params }) => {
      const d = loadDraft(params.id);
      if (d.state === 'removed') throw new ApiError(404, 'not_found', 'That draft was removed.');
      const tz = d.tz || 'UTC';
      const ics = buildIcs({
        uid: `${d.id}@mwa`, title: d.title, allDay: d.all_day === 1,
        start: d.all_day ? localDate(Date.parse(d.start_utc), tz) : Date.parse(d.start_utc),
        end: d.all_day ? localDate(Date.parse(d.end_utc), tz) : Date.parse(d.end_utc),
        location: d.location, notes: d.notes, stamp: d.created_at,
      });
      return { raw: { contentType: 'text/calendar; charset=utf-8', body: ics }, headers: { 'content-disposition': `attachment; filename="${icsFileName(d.title)}"` } };
    },
  },
];

