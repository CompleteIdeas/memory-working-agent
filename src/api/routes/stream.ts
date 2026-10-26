/**
 * Live updates and offline catch-up (v2 build, slice A4, 2026-10-26).
 *
 * One sequence (app.db `events`, written in the same transaction as every change) drives both:
 *   - GET /stream — server-sent events. Replays what changed after `cursor` (or the Last-Event-ID a reconnecting
 *     EventSource sends), then follows along. A job or one of its tries changing sends the job's current view; a
 *     running try's progress is forwarded at most once a second per run. When the cursor is older than what is kept
 *     (7 days), it sends `reset` and the client re-syncs. A comment every 15 s keeps proxies from closing it.
 *   - GET /sync?since= — what changed since a cursor, as current objects and deletions: the phone's offline cache
 *     catches up with one request. `since` absent, 0, or too old → a full snapshot with `reset: true`.
 * The stream polls the table (once a second) rather than relying on in-process signals: the Telegram process
 * writes app.db too.
 *
 * Visibility: device changes (names, revocations) go to admin callers only (A2 review note). Jobs: the owner's only,
 * as in /jobs (A3a review M10) — another person's job is never sent, not even as an id.
 *
 * Calendar (A7): a cached event or a draft changing is sent as entity 'calendar' with the item as it is now (or a
 * deletion — a removed draft, a cancelled event, or a confirmed draft once its event is in the cache); /sync has a
 * 'calendar' collection.
 */
import type { ServerResponse, IncomingMessage } from 'node:http';
import { ApiError, type Route } from '../router.js';
import { appDb } from '../../v2/db.js';
import { getJob, listJobs, viewJob, viewJobs } from '../../v2/jobs.js';
import { apiJob, visibleJob } from './jobs.js';
import { liveRuns, type LiveEvent } from '../../live-runs.js';
import type { Caller } from '../auth.js';
import { calendarItemById, calendarItems } from '../../v2/calendar.js';

export const EVENT_RETENTION_MS = 7 * 24 * 3_600_000;
const POLL_MS = 1_000, KEEPALIVE_MS = 15_000, BATCH = 500, STEP_EVERY_MS = 1_000;

export interface StreamDeps {
  running: () => Set<string>;
  pending: () => Set<string>;
}
let deps: StreamDeps = { running: () => new Set(), pending: () => new Set() };
export function setStreamDeps(d: StreamDeps): void { deps = d; }

interface EventRow { seq: number; ts: number; entity: string; entity_id: string; op: 'upsert' | 'delete'; payload: string | null }

/** Drop events older than the retention window (cheap: indexed by ts). */
export function trimEvents(now = Date.now()): void {
  appDb().prepare('DELETE FROM events WHERE ts < ?').run(now - EVENT_RETENTION_MS);
}
export function headSeq(): number { return (appDb().prepare('SELECT COALESCE(MAX(seq), 0) s FROM events').get() as { s: number }).s; }
/** The oldest sequence still kept, or null when nothing is. A cursor below oldest-1 has missed trimmed events. */
function oldestSeq(): number | null { return (appDb().prepare('SELECT MIN(seq) s FROM events').get() as { s: number | null }).s; }
function eventsAfter(seq: number, limit = BATCH): EventRow[] {
  return appDb().prepare('SELECT seq, ts, entity, entity_id, op, payload FROM events WHERE seq > ? ORDER BY seq LIMIT ?').all(seq, limit) as EventRow[];
}
/** True when events after `cursor` were trimmed away (the client must take a full snapshot). */
export function cursorTooOld(cursor: number): boolean {
  const o = oldestSeq();
  if (o === null) return cursor < headSeqFloor();
  return cursor < o - 1;
}
// With every event trimmed, sqlite's AUTOINCREMENT still remembers the last seq: a cursor below it missed events.
function headSeqFloor(): number {
  const r = appDb().prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'events'`).get() as { seq: number } | undefined;
  return r?.seq ?? 0;
}

const ctx = () => ({ running: deps.running(), pending: deps.pending() });
function jobOut(id: string, c: ReturnType<typeof ctx>) {
  const j = getJob(id);
  return j ? apiJob(viewJob(j, c)) : null;
}
const jobIdOf = (e: EventRow): string | null => {
  if (e.entity === 'job') return e.entity_id;
  if (e.entity === 'try') { try { return (JSON.parse(e.payload ?? '{}') as { job?: string }).job ?? null; } catch { return null; } }
  return null;
};

/** Turn a batch of raw events into what a caller may see: one current view per job, deletions, other entities. */
function present(rows: EventRow[], who: Caller | null) {
  const c = ctx();
  const out: { seq: number; entity: string; id: string; op: 'upsert' | 'delete'; data?: unknown }[] = [];
  const lastForJob = new Map<string, number>();
  rows.forEach((e, i) => { const j = jobIdOf(e); if (j) lastForJob.set(j, i); });
  // calendar (A7): an event or a draft changing sends the item as it is now (or its deletion), once per batch
  const lastForCal = new Map<string, number>();
  rows.forEach((e, i) => { if (CAL_ENTITIES.has(e.entity)) lastForCal.set(e.entity_id, i); });
  rows.forEach((e, i) => {
    if (e.entity === 'device' && !who?.scopes.has('admin')) return;
    if (CAL_ENTITIES.has(e.entity)) {
      if (lastForCal.get(e.entity_id) !== i) return;
      const data = e.op === 'delete' ? null : calendarItemById(e.entity_id);
      out.push({ seq: e.seq, entity: 'calendar', id: e.entity_id, op: data ? 'upsert' : 'delete', ...(data ? { data } : {}) });
      return;
    }
    const j = jobIdOf(e);
    if (j) {
      if (lastForJob.get(j) !== i) return; // one message per job per batch: its latest state
      const row = getJob(j);
      if (row && !visibleJob(row)) return; // not the owner's: never sent
      const data = e.entity === 'job' && e.op === 'delete' ? null : jobOut(j, c);
      out.push({ seq: e.seq, entity: 'job', id: j, op: data ? 'upsert' : 'delete', ...(data ? { data } : {}) });
      return;
    }
    out.push({ seq: e.seq, entity: e.entity, id: e.entity_id, op: e.op });
  });
  return out;
}

const CAL_ENTITIES = new Set(['cal_event', 'cal_draft']);
/** The calendar collection's full snapshot: every cached event and every draft not removed. */
const calendarSnapshot = () => calendarItems('0000-01-01T00:00:00.000Z', '9999-12-31T23:59:59.999Z');
const COLLECTIONS = ['jobs', 'calendar'];

function parseCursor(v: string | null | undefined): number {
  if (v === null || v === undefined || v === '') return 0;
  if (!/^\d{1,15}$/.test(v)) throw new ApiError(400, 'bad_cursor', 'The cursor must be a number the server gave you.');
  return Number(v);
}

function openStream(res: ServerResponse, req: IncomingMessage, start: number, who: Caller | null): void {
  let cursor = start, closed = false, lastSent = Date.now();
  const write = (chunk: string) => { if (closed) return; try { res.write(chunk); lastSent = Date.now(); } catch { close(); } };
  const send = (event: string, data: unknown, id?: number) => write(`${id !== undefined ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const lastStep = new Map<string, number>();
  const untap = liveRuns.tap((session: string, e: LiveEvent) => {
    if (e.type !== 'step' && e.type !== 'plan_step' && e.type !== 'stopping') return;
    const now = Date.now();
    if (e.type !== 'stopping' && now - (lastStep.get(session) ?? 0) < STEP_EVERY_MS) return;
    lastStep.set(session, now);
    send('live', { session, type: e.type, stage: e.data, at: e.at });
  });
  const pump = () => {
    if (closed) return;
    try {
      if (cursorTooOld(cursor)) { send('reset', { cursor: headSeq(), reason: 'Too much changed while you were away. Sync again.' }); cursor = headSeq(); return; }
      for (;;) {
        const rows = eventsAfter(cursor);
        if (!rows.length) break;
        for (const m of present(rows, who)) send('change', m, m.seq);
        cursor = rows[rows.length - 1].seq;
        write(`id: ${cursor}\n\n`); // an id with no data: the client's Last-Event-ID advances past events it may not see
        if (rows.length < BATCH) break;
      }
      if (Date.now() - lastSent >= KEEPALIVE_MS) write(': keepalive\n\n');
    } catch { /* the database is busy: try again next tick */ }
  };
  const timer = setInterval(pump, POLL_MS);
  timer.unref?.();
  function close() { if (closed) return; closed = true; clearInterval(timer); untap(); try { res.end(); } catch { /* gone */ } }
  req.on('close', close);
  res.on('error', close);
  write('retry: 3000\n\n');
  send('hello', { cursor: start, head: headSeq() });
  pump();
}

export const streamRoutes: Route[] = [
  {
    method: 'GET', path: '/stream', scope: 'read',
    handler: ({ req, url, who }) => {
      const start = parseCursor((req.headers['last-event-id'] as string | undefined) ?? url.searchParams.get('cursor'));
      return { stream: (res, rq) => openStream(res, rq, start, who) };
    },
  },
  {
    method: 'GET', path: '/sync', scope: 'read',
    handler: ({ url, who }) => {
      trimEvents();
      const since = parseCursor(url.searchParams.get('since'));
      const wanted = (url.searchParams.get('collections') ?? 'jobs').split(',').map((s) => s.trim()).filter(Boolean);
      const unknown = wanted.filter((w) => !COLLECTIONS.includes(w));
      if (unknown.length) throw new ApiError(400, 'unknown_collection', `Unknown collection: ${unknown.join(', ')}. Available: ${COLLECTIONS.join(', ')}.`);
      const want = new Set(wanted);
      const cursor = headSeq();
      const c = ctx();
      const upserts: Record<string, unknown[]> = {}, deletes: Record<string, string[]> = {};
      if (since === 0 || cursorTooOld(since)) {
        if (want.has('jobs')) { upserts.jobs = viewJobs(listJobs({}).filter(visibleJob), c).map(apiJob); deletes.jobs = []; }
        if (want.has('calendar')) { upserts.calendar = calendarSnapshot(); deletes.calendar = []; }
        return { body: { cursor, reset: true, upserts, deletes } };
      }
      const rows = appDb().prepare('SELECT seq, ts, entity, entity_id, op, payload FROM events WHERE seq > ? AND seq <= ? ORDER BY seq').all(since, cursor) as EventRow[];
      const ups = { jobs: new Map<string, unknown>(), calendar: new Map<string, unknown>() };
      const dels = { jobs: new Set<string>(), calendar: new Set<string>() };
      for (const m of present(rows, who)) {
        const k = m.entity === 'job' ? 'jobs' : m.entity === 'calendar' ? 'calendar' : null;
        if (!k || !want.has(k)) continue;
        if (m.op === 'delete') { dels[k].add(m.id); ups[k].delete(m.id); } else { ups[k].set(m.id, m.data); dels[k].delete(m.id); }
      }
      for (const k of ['jobs', 'calendar'] as const) if (want.has(k)) { upserts[k] = [...ups[k].values()]; deletes[k] = [...dels[k]]; }
      return { body: { cursor, reset: false, upserts, deletes } };
    },
  },
];
