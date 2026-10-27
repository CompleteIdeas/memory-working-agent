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
 *
 * Mail (A8): /sync's 'mail' collection carries headers only — bodies are never synced. On the stream a mail change is
 * a notice without data (catch up with /sync?collections=mail).
 *
 * Important (A9): an item changing is sent as entity 'item' with the item as it is now (or a deletion once it is gone,
 * someone else's, or aged out); /sync has an 'important' collection. Ownership as for jobs: the owner's items only —
 * in a single-owner app that is all of them.
 * Projects (A5): a project or a thread's turn changing is sent with its current shape; /sync has 'projects' (all of
 * them, archived included, so an archive reaches the phone) and 'turns' (a snapshot holds each active project's latest
 * 50; a delta holds every turn changed since the cursor, a moved one included with its new project).
 * Today (A10): /sync has a 'today' collection — one document, the Today composite for this caller (a snapshot always
 * holds it; a delta holds it when anything Today is made of changed). On the stream, a coarse notice without data
 * (entity 'today') when a job, try, calendar event or draft, item or action changed — or, checked every 5 s, an
 * approval, a sync's state or the part of the day (midnight, 05:00, noon, 17:00) — at most once every 5 s; the
 * person's own check-in and wrap marks are sent as they happen.
 *
 * Approvals (S4): an approval staged, decided, run or expired is sent as entity 'approval' with its current view (the
 * same shape as GET /approvals/{id}), whichever app or channel changed it.
 *
 * Asks (A6): an ask changing (planned, chosen, answered) is sent as entity 'ask' with its current shape; its run's
 * progress is the project's `live` events and its answer the thread's turn.
 */
import type { ServerResponse, IncomingMessage } from 'node:http';
import { ApiError, type Route } from '../router.js';
import { appDb } from '../../v2/db.js';
import { getJob, listJobs, viewJob, viewJobs } from '../../v2/jobs.js';
import { apiJob, visibleJob } from './jobs.js';
import { liveRuns, type LiveEvent } from '../../live-runs.js';
import type { Caller } from '../auth.js';
import { calendarItemById, calendarItems } from '../../v2/calendar.js';
import { mailSnapshot, mailDelta } from '../../v2/mail.js';
import { importantSnapshot, itemForStream } from '../../v2/important.js';
import { triageNow, triageTz } from '../../v2/triage.js';
import { apiProject, apiTurn, getProject, getTurn, listProjects, recentTurns } from '../../v2/projects.js';
import { buildToday, todaySignature, TODAY_SOURCES } from '../../v2/today.js';
import { apiAsk, getAsk } from '../../v2/ask.js';
import { approvalView } from '../../v2/approvals.js';

export const EVENT_RETENTION_MS = 7 * 24 * 3_600_000;
const POLL_MS = 1_000, KEEPALIVE_MS = 15_000, BATCH = 500, STEP_EVERY_MS = 1_000;
/** The coarse "today changed" notice: at most one per this many ms per stream. */
export const TODAY_NOTICE_EVERY_MS = 5_000;

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
  const lastForItem = new Map<string, number>();
  rows.forEach((e, i) => { if (e.entity === 'item') lastForItem.set(e.entity_id, i); });
  const lastForProject = new Map<string, number>(), lastForTurn = new Map<string, number>();
  rows.forEach((e, i) => { if (e.entity === 'project') lastForProject.set(e.entity_id, i); else if (e.entity === 'turn') lastForTurn.set(e.entity_id, i); });
  rows.forEach((e, i) => {
    if (e.entity === 'device' && !who?.scopes.has('admin')) return;
    if (e.entity === 'item') {
      if (lastForItem.get(e.entity_id) !== i) return;
      const data = itemForStream(e.entity_id, triageNow(), triageTz());
      if (data === undefined) return; // not the owner's: never sent
      out.push({ seq: e.seq, entity: 'item', id: e.entity_id, op: data ? 'upsert' : 'delete', ...(data ? { data } : {}) });
      return;
    }
    if (CAL_ENTITIES.has(e.entity)) {
      if (lastForCal.get(e.entity_id) !== i) return;
      const data = e.op === 'delete' ? null : calendarItemById(e.entity_id);
      out.push({ seq: e.seq, entity: 'calendar', id: e.entity_id, op: data ? 'upsert' : 'delete', ...(data ? { data } : {}) });
      return;
    }
    if (e.entity === 'project' || e.entity === 'turn') {
      const last = e.entity === 'project' ? lastForProject : lastForTurn;
      if (last.get(e.entity_id) !== i) return; // one message per project or turn per batch: as it is now
      const data = e.op === 'delete' ? null : e.entity === 'project' ? (() => { const p = getProject(e.entity_id); return p ? apiProject(p) : null; })()
        : (() => { const t = getTurn(e.entity_id); return t ? apiTurn(t, undefined, { summary: true }) : null; })();
      out.push({ seq: e.seq, entity: e.entity, id: e.entity_id, op: data ? 'upsert' : 'delete', ...(data ? { data } : {}) });
      return;
    }
    if (e.entity === 'approval') {
      // S4: an approval as it is now (staged, decided, done, expired); one per approval per batch
      if (rows.findLastIndex((x) => x.entity === 'approval' && x.entity_id === e.entity_id) !== i) return;
      const v = approvalView(e.entity_id);
      out.push({ seq: e.seq, entity: 'approval', id: e.entity_id, op: v ? 'upsert' : 'delete', ...(v ? { data: v } : {}) });
      return;
    }
    if (e.entity === 'ask') {
      // A6: an ask as it is now (its plan, its choice, its answer); one per ask per batch
      if (rows.findLastIndex((x) => x.entity === 'ask' && x.entity_id === e.entity_id) !== i) return;
      const a = getAsk(e.entity_id);
      out.push({ seq: e.seq, entity: 'ask', id: e.entity_id, op: a ? 'upsert' : 'delete', ...(a ? { data: apiAsk(a) } : {}) });
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
const COLLECTIONS = ['jobs', 'calendar', 'mail', 'projects', 'turns', 'important', 'today'];
/** A /sync delta answers at most this many events, and stops early near this many bytes (`more: true`). */
export const SYNC_PAGE = 500;
export const SYNC_MAX_BYTES = 5 * 1024 * 1024;

function parseCursor(v: string | null | undefined): number {
  if (v === null || v === undefined || v === '') return 0;
  if (!/^\d{1,15}$/.test(v)) throw new ApiError(400, 'bad_cursor', 'The cursor must be a number the server gave you.');
  return Number(v);
}

function openStream(res: ServerResponse, req: IncomingMessage, start: number, who: Caller | null): void {
  let cursor = start, closed = false, lastSent = Date.now();
  // Today (A10): a change to what Today is made of marks it dirty; the notice goes out at most every 5 s
  let todayDirty = 0, todaySentAt = 0, todaySig = '', todaySigAt = 0;
  try { todaySig = todaySignature(); } catch { /* checked again on the timer */ }
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
        if (rows.some((e) => TODAY_SOURCES.has(e.entity))) todayDirty = cursor;
        write(`id: ${cursor}\n\n`); // an id with no data: the client's Last-Event-ID advances past events it may not see
        if (rows.length < BATCH) break;
      }
      if (Date.now() - todaySigAt >= TODAY_NOTICE_EVERY_MS) {
        todaySigAt = Date.now();
        try { const sig = todaySignature(); if (sig !== todaySig) { todaySig = sig; todayDirty = todayDirty || Math.max(cursor, 1); } } catch { /* next tick */ }
      }
      if (todayDirty && Date.now() - todaySentAt >= TODAY_NOTICE_EVERY_MS) {
        send('change', { seq: todayDirty, entity: 'today', id: 'today', op: 'upsert' });
        todayDirty = 0; todaySentAt = Date.now();
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
    handler: async ({ url, who, caller }) => {
      trimEvents();
      const since = parseCursor(url.searchParams.get('since'));
      const wanted = (url.searchParams.get('collections') ?? 'jobs').split(',').map((s) => s.trim()).filter(Boolean);
      const unknown = wanted.filter((w) => !COLLECTIONS.includes(w));
      if (unknown.length) throw new ApiError(400, 'unknown_collection', `Unknown collection: ${unknown.join(', ')}. Available: ${COLLECTIONS.join(', ')}.`);
      const want = new Set(wanted);
      const head = headSeq();
      const c = ctx();
      const upserts: Record<string, unknown[]> = {}, deletes: Record<string, string[]> = {};
      if (since === 0 || cursorTooOld(since)) {
        if (want.has('jobs')) { upserts.jobs = viewJobs(listJobs({}).filter(visibleJob), c).map(apiJob); deletes.jobs = []; }
        if (want.has('calendar')) { upserts.calendar = calendarSnapshot(); deletes.calendar = []; }
        if (want.has('mail')) { upserts.mail = mailSnapshot(); deletes.mail = []; }
        if (want.has('projects')) { upserts.projects = listProjects({ archived: true }).map(apiProject); deletes.projects = []; }
        if (want.has('turns')) { upserts.turns = recentTurns(50).map((t) => apiTurn(t, undefined, { summary: true })); deletes.turns = []; }
        if (want.has('important')) { upserts.important = importantSnapshot(triageNow(), triageTz()); deletes.important = []; }
        if (want.has('today')) { upserts.today = [await buildToday(caller)]; deletes.today = []; }
        return { body: { cursor: head, reset: true, more: false, upserts, deletes } };
      }
      // A page of at most SYNC_PAGE events and about SYNC_MAX_BYTES of answer (review of A5: a delta across the
      // conversation import was 127 MB). `more: true` — call again with the returned cursor.
      const page = appDb().prepare('SELECT seq, ts, entity, entity_id, op, payload FROM events WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ?').all(since, head, SYNC_PAGE + 1) as EventRow[];
      let more = page.length > SYNC_PAGE;
      const fetched = page.slice(0, SYNC_PAGE);
      const rows: EventRow[] = [];
      const presented: ReturnType<typeof present> = [];
      let bytes = 0;
      for (let i = 0; i < fetched.length; i += 100) {
        const chunk = fetched.slice(i, i + 100);
        const out = present(chunk, who);
        rows.push(...chunk); presented.push(...out);
        bytes += JSON.stringify(out).length;
        if (bytes >= SYNC_MAX_BYTES && i + 100 < fetched.length) { more = true; break; }
      }
      const cursor = more && rows.length ? rows[rows.length - 1].seq : head;
      const KEYS = ['jobs', 'calendar', 'projects', 'turns', 'important'] as const;
      const COLL: Record<string, (typeof KEYS)[number]> = { job: 'jobs', calendar: 'calendar', project: 'projects', turn: 'turns', item: 'important' };
      const ups = Object.fromEntries(KEYS.map((k) => [k, new Map<string, unknown>()])) as Record<(typeof KEYS)[number], Map<string, unknown>>;
      const dels = Object.fromEntries(KEYS.map((k) => [k, new Set<string>()])) as Record<(typeof KEYS)[number], Set<string>>;
      for (const m of presented) {
        const k = COLL[m.entity];
        if (!k || !want.has(k)) continue;
        if (m.op === 'delete') { dels[k].add(m.id); ups[k].delete(m.id); } else { ups[k].set(m.id, m.data); dels[k].delete(m.id); }
      }
      for (const k of KEYS) if (want.has(k)) { upserts[k] = [...ups[k].values()]; deletes[k] = [...dels[k]]; }
      if (want.has('mail')) { const d = mailDelta(rows); upserts.mail = d.upserts; deletes.mail = d.deletes; }
      if (want.has('today')) { upserts.today = rows.some((e) => TODAY_SOURCES.has(e.entity) || e.entity === 'today') ? [await buildToday(caller)] : []; deletes.today = []; }
      return { body: { cursor, reset: false, more, upserts, deletes } };
    },
  },
];
