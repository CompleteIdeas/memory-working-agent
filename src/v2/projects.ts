/**
 * v2 slice A5: Projects and their threads.
 *
 * A Project is one of the person's groupings — Eventing, Family & school, AI newsletter — plus General, which always
 * exists and catches whatever has no better home. Each project has ONE continuous thread (its `turns`), its files (the
 * thread's folder) and the jobs working for it (jobs.project_id). A thread's session is `p-<projectId>`: the live run,
 * the working folder (serve/p-<id>) and the memory's `session=` tag all use it, so a memory written during a project's
 * runs says which project it came from.
 *
 * Turns live in app.db. A chat turn holds the person's message AND the reply, so moving it moves both. A `running`
 * turn is the same row its finished turn later fills in (by run id), so a turn keeps its id from the moment it is sent.
 *
 * Order (review of A5). A thread is ordered by (ord, grp, n): `ord` is the time it was sent (for a conversation
 * imported from before projects: that conversation's start, shared by all its turns), `grp` keeps one imported
 * conversation's turns together when two start in the same millisecond (0 for a live turn), and `n` is the insertion
 * order — so two turns in one millisecond keep the order they were written in. A page cursor is that triple, which
 * stays valid when the turn it came from is moved away.
 *
 * Routing (suggestProject) and cross-talk provenance (crossTalk) are below. Every write records an event (the sync
 * cursor) in the same transaction.
 */
import { randomBytes } from 'node:crypto';
import { appDb, registerMigrations, recordEvent, type AppDb, type Migration } from './db.js';
import { loadEmbeddings } from '../awm-api.js';

export const GENERAL = 'general';

export const PROJECTS_MIGRATION: Migration = {
  name: '008-projects',
  sql: `
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT,
      created_at INTEGER NOT NULL,
      sort INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      -- decision D6 is deferred; until then a private project is never named as another answer's source
      private INTEGER NOT NULL DEFAULT 0,
      updated_seq INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS projects_seq ON projects(updated_seq);
    CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY,
      -- insertion order (the last tie-break of the thread order)
      n INTEGER NOT NULL UNIQUE,
      project_id TEXT NOT NULL REFERENCES projects(id),
      -- p-<projectId>
      session TEXT NOT NULL,
      -- the older conversation (before projects, or an older client's) it belongs to; cleared when it is moved out
      legacy_session TEXT,
      -- the older conversation it came from, kept after a move: its folder's files stay listed
      origin_session TEXT,
      ts INTEGER NOT NULL,
      ord REAL NOT NULL,
      grp INTEGER NOT NULL DEFAULT 0,
      kind TEXT NOT NULL CHECK (kind IN ('chat','result','offer','running','divider')),
      message TEXT NOT NULL DEFAULT '',
      reply TEXT NOT NULL DEFAULT '',
      reason TEXT,
      -- 1: it read outside content (carried back only fenced); NULL: no record (older turns count as tainted)
      tainted INTEGER,
      run_id TEXT,
      try_id TEXT,
      about_kind TEXT,
      about_id TEXT,
      -- [{projectId, n}] or [{earlier: true, n}]: where the memories this answer used came from
      provenance TEXT,
      -- {offer, resumes, job, archivedFrom, untitled}
      meta TEXT,
      moved_from TEXT,
      updated_seq INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS turns_thread ON turns(project_id, ord, grp, n);
    CREATE INDEX IF NOT EXISTS turns_session ON turns(session, legacy_session, ord, grp, n);
    CREATE INDEX IF NOT EXISTS turns_legacy ON turns(legacy_session, ord, grp, n);
    CREATE INDEX IF NOT EXISTS turns_origin ON turns(origin_session);
    CREATE INDEX IF NOT EXISTS turns_run ON turns(run_id);
    CREATE INDEX IF NOT EXISTS turns_seq ON turns(updated_seq);
    CREATE INDEX IF NOT EXISTS turns_kind ON turns(kind) WHERE kind IN ('running', 'divider');
    -- the conversation list: one group per conversation, newest first, without reading bodies
    CREATE INDEX IF NOT EXISTS turns_conv ON turns(COALESCE(legacy_session, session), ts) WHERE kind != 'divider';
    CREATE INDEX IF NOT EXISTS turns_recent ON turns(ts, COALESCE(legacy_session, session)) WHERE kind != 'divider';
    -- the waiting offers of a thread or of an older conversation
    CREATE INDEX IF NOT EXISTS turns_offer_thread ON turns(session, ord) WHERE kind = 'offer' AND legacy_session IS NULL;
    CREATE INDEX IF NOT EXISTS turns_offer_legacy ON turns(legacy_session, ord) WHERE kind = 'offer';
    -- the conversation import (src/v2/migrate-conversations.ts): every line it took (content hash + line number), and
    -- how far into each log it has read
    CREATE TABLE IF NOT EXISTS conv_import_lines (key TEXT PRIMARY KEY, turn_id TEXT);
    CREATE TABLE IF NOT EXISTS conv_import_state (file TEXT PRIMARY KEY, offset INTEGER NOT NULL, line INTEGER NOT NULL, head TEXT, updated_at INTEGER, report TEXT);
    INSERT OR IGNORE INTO projects (id, name, icon, created_at, sort) VALUES ('general', 'General', 'chat', CAST(strftime('%s','now') AS INTEGER) * 1000, 0);
    INSERT INTO events (ts, entity, entity_id, op) VALUES (CAST(strftime('%s','now') AS INTEGER) * 1000, 'project', 'general', 'upsert');
    UPDATE projects SET updated_seq = last_insert_rowid() WHERE id = 'general';`,
};
registerMigrations([PROJECTS_MIGRATION]);

// ── Rows and shapes ─────────────────────────────────────────────────────────────────────────────────────────────

export interface ProjectRow { id: string; name: string; icon: string | null; created_at: number; sort: number; archived: number; private: number; updated_seq: number }
export type TurnKind = 'chat' | 'result' | 'offer' | 'running' | 'divider';
export interface TurnRow {
  id: string; n: number; project_id: string; session: string; legacy_session: string | null; origin_session: string | null; ts: number; ord: number; grp: number;
  kind: TurnKind; message: string; reply: string; reason: string | null; tainted: number | null; run_id: string | null; try_id: string | null;
  about_kind: string | null; about_id: string | null; provenance: string | null; meta: string | null; moved_from: string | null; updated_seq: number;
}
/** Where an answer's memories came from: another project, or a conversation from before projects. */
export type Provenance = { projectId: string; n: number } | { earlier: true; n: number };
export interface TurnMeta {
  offer?: { answered: 'background' | 'now'; goal?: string; at: number };
  resumes?: number;
  /** the Job this turn's run (or its offer) made: moving the turn moves the job */
  job?: string;
  /** it was meant for a project that is archived, and was kept in General */
  archivedFrom?: string;
  /** an imported conversation's divider still waits for the first thing the person typed, to be titled by it */
  untitled?: boolean;
}

export const sessionOf = (projectId: string) => `p-${projectId}`;
/** The project a thread session names (`p-<id>`), or null for any other session. */
export function projectOfSession(session: string | null | undefined): string | null {
  return session && session.startsWith('p-') && session.length > 2 ? session.slice(2) : null;
}
/** An older conversation's id, as stored (long ids are cut at 80 characters, the old log's own limit). */
export const legacyId = (session: string) => session.slice(0, 80);

const MAX_TEXT = 20_000;
/** /sync and the live stream send turns as summaries; the thread endpoint has them whole. */
export const SUMMARY_CHARS = 500;
const newId = (p: 'pr' | 'tu') => `${p}_${randomBytes(6).toString('hex')}`;
const parse = <T>(s: string | null): T | null => { if (!s) return null; try { return JSON.parse(s) as T; } catch { return null; } };
export const THREAD_ORDER = 'ord, grp, n';
export const THREAD_ORDER_DESC = 'ord DESC, grp DESC, n DESC';
export const EARLIER = 'an earlier conversation';

export function apiProject(p: ProjectRow) {
  return { id: p.id, name: p.name, icon: p.icon, createdAt: p.created_at, sort: p.sort, archived: p.archived === 1, general: p.id === GENERAL, updatedSeq: p.updated_seq };
}
export function apiProvenance(prov: Provenance[], d: AppDb = appDb()) {
  // the names travel with the ids: "using what I know from Eventing" needs no second request
  return prov.map((p) => ('earlier' in p ? { projectId: null, name: EARLIER, n: p.n } : { projectId: p.projectId, name: getProject(p.projectId, d)?.name ?? p.projectId, n: p.n }));
}
export function apiTurn(t: TurnRow, d: AppDb = appDb(), o: { summary?: boolean } = {}) {
  const meta = parse<TurnMeta>(t.meta) ?? {};
  const cut = (s: string) => (o.summary && s.length > SUMMARY_CHARS ? s.slice(0, SUMMARY_CHARS) : s);
  return {
    id: t.id, projectId: t.project_id, kind: t.kind, ts: t.ts, message: cut(t.message), reply: cut(t.reply), reason: t.reason,
    truncated: !!o.summary && (t.message.length > SUMMARY_CHARS || t.reply.length > SUMMARY_CHARS),
    tainted: t.tainted == null ? null : t.tainted === 1, runId: t.run_id, tryId: t.try_id,
    about: t.about_kind && t.about_id ? { kind: t.about_kind, id: t.about_id } : null,
    provenance: apiProvenance(parse<Provenance[]>(t.provenance) ?? [], d),
    offer: meta.offer ?? null, legacySession: t.legacy_session ?? t.origin_session, movedFrom: t.moved_from, updatedSeq: t.updated_seq,
  };
}

// ── Projects ────────────────────────────────────────────────────────────────────────────────────────────────────

function bumpProject(d: AppDb, id: string): void {
  const seq = recordEvent({ entity: 'project', id }, d);
  d.prepare('UPDATE projects SET updated_seq = ? WHERE id = ?').run(seq, id);
}
function bumpTurn(d: AppDb, id: string, projectId: string): void {
  const seq = recordEvent({ entity: 'turn', id, payload: { project: projectId } }, d);
  d.prepare('UPDATE turns SET updated_seq = ? WHERE id = ?').run(seq, id);
}

export function getProject(id: string, d: AppDb = appDb()): ProjectRow | undefined {
  return d.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
}
/** Projects in the person's order (General first), archived ones only when asked. */
export function listProjects(o: { archived?: boolean } = {}, d: AppDb = appDb()): ProjectRow[] {
  return d.prepare(`SELECT * FROM projects ${o.archived ? '' : 'WHERE archived = 0'} ORDER BY (id = 'general') DESC, sort, created_at`).all() as ProjectRow[];
}

export class ProjectError extends Error { constructor(public code: 'bad_name' | 'name_taken' | 'not_found' | 'general' | 'archived', message: string) { super(message); } }

const cleanName = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
const cleanIcon = (s: unknown) => { const v = String(s ?? '').trim(); return /^[a-z0-9-]{1,24}$/i.test(v) ? v : null; };
function nameTaken(d: AppDb, name: string, except?: string): boolean {
  return !!d.prepare(`SELECT 1 FROM projects WHERE archived = 0 AND lower(name) = lower(?) AND id != ?`).get(name, except ?? '');
}

export function createProject(p: { name: string; icon?: string | null; now?: number; private?: boolean }, d: AppDb = appDb()): ProjectRow {
  const name = cleanName(p.name);
  if (!name) throw new ProjectError('bad_name', 'Give the project a name.');
  return d.transaction(() => {
    if (nameTaken(d, name)) throw new ProjectError('name_taken', `You already have a project called ${name}.`);
    const id = newId('pr');
    const sort = ((d.prepare('SELECT MAX(sort) m FROM projects').get() as { m: number | null }).m ?? 0) + 1;
    d.prepare('INSERT INTO projects (id, name, icon, created_at, sort, private) VALUES (?, ?, ?, ?, ?, ?)').run(id, name, cleanIcon(p.icon), p.now ?? Date.now(), sort, p.private ? 1 : 0);
    bumpProject(d, id);
    return getProject(id, d)!;
  }).immediate();
}

/** Rename, change the icon, archive or restore. General can be renamed but never archived. */
export function updateProject(id: string, f: { name?: string; icon?: string | null; archived?: boolean; sort?: number }, d: AppDb = appDb()): ProjectRow {
  return d.transaction(() => {
    const p = getProject(id, d);
    if (!p) throw new ProjectError('not_found', 'No such project.');
    const sets: string[] = [], vals: unknown[] = [];
    if (f.name !== undefined) {
      const name = cleanName(f.name);
      if (!name) throw new ProjectError('bad_name', 'Give the project a name.');
      if (nameTaken(d, name, id)) throw new ProjectError('name_taken', `You already have a project called ${name}.`);
      sets.push('name = ?'); vals.push(name);
    }
    if (f.icon !== undefined) { sets.push('icon = ?'); vals.push(f.icon === null ? null : cleanIcon(f.icon)); }
    if (f.sort !== undefined && Number.isInteger(f.sort)) { sets.push('sort = ?'); vals.push(f.sort); }
    if (f.archived !== undefined) {
      if (id === GENERAL && f.archived) throw new ProjectError('general', 'General is where everything without a project goes. It cannot be archived.');
      if (!f.archived && nameTaken(d, p.name, id)) throw new ProjectError('name_taken', `Another project is called ${p.name} now. Rename one of them first.`);
      sets.push('archived = ?'); vals.push(f.archived ? 1 : 0);
    }
    if (sets.length) {
      d.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
      bumpProject(d, id);
    }
    return getProject(id, d)!;
  }).immediate();
}

// ── Turns ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface NewTurn {
  projectId: string; ts: number; kind: TurnKind; message: string; reply: string; reason?: string | null; tainted?: boolean | null;
  runId?: string | null; tryId?: string | null; about?: { kind: string; id: string } | null; provenance?: Provenance[] | null;
  meta?: TurnMeta | null; legacySession?: string | null;
  /** the thread order (default: ts) and the imported conversation it groups with ('self': a divider starting one) */
  ord?: number; grp?: number | 'self';
}

export function getTurn(id: string, d: AppDb = appDb()): TurnRow | undefined {
  return d.prepare('SELECT * FROM turns WHERE id = ?').get(id) as TurnRow | undefined;
}

/** Insert one turn (inside the caller's transaction, or as its own statement). */
export function insertTurn(t: NewTurn, d: AppDb = appDb()): TurnRow {
  const id = newId('tu');
  const n = ((d.prepare('SELECT MAX(n) m FROM turns').get() as { m: number | null }).m ?? 0) + 1;
  const legacy = t.legacySession ? legacyId(t.legacySession) : null;
  d.prepare(`INSERT INTO turns (id, n, project_id, session, legacy_session, origin_session, ts, ord, grp, kind, message, reply, reason, tainted, run_id, try_id, about_kind, about_id, provenance, meta)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, n, t.projectId, sessionOf(t.projectId), legacy, legacy, t.ts, t.ord ?? t.ts,
    t.grp === 'self' ? n : t.grp ?? 0, t.kind, String(t.message ?? '').slice(0, MAX_TEXT), String(t.reply ?? '').slice(0, MAX_TEXT), t.reason ?? null,
    t.tainted == null ? null : t.tainted ? 1 : 0, t.runId ?? null, t.tryId ?? null, t.about?.kind ?? null, t.about?.id ?? null,
    t.provenance?.length ? JSON.stringify(t.provenance) : null, t.meta && Object.keys(t.meta).length ? JSON.stringify(t.meta) : null);
  bumpTurn(d, id, t.projectId);
  return getTurn(id, d)!;
}

/** The unfinished turn of a run (a `running` turn, or one marked interrupted that its run finishes after all). */
export function unfinishedTurnOf(runId: string, d: AppDb = appDb()): TurnRow | undefined {
  return d.prepare(`SELECT * FROM turns WHERE run_id = ? AND (kind = 'running' OR reason = 'interrupted') ORDER BY n DESC LIMIT 1`).get(runId) as TurnRow | undefined;
}
/** Fill a run's unfinished turn in with how it ended: same id, same place in its thread. */
export function finishTurn(row: TurnRow, t: Pick<NewTurn, 'kind' | 'ts' | 'message' | 'reply' | 'reason' | 'tainted' | 'tryId' | 'provenance' | 'meta'>, d: AppDb = appDb()): TurnRow {
  const meta = { ...(parse<TurnMeta>(row.meta) ?? {}), ...(t.meta ?? {}) };
  d.prepare(`UPDATE turns SET kind = ?, ts = ?, message = ?, reply = ?, reason = ?, tainted = ?, try_id = COALESCE(?, try_id), provenance = ?, meta = ? WHERE id = ?`)
    .run(t.kind, t.ts, String(t.message ?? '').slice(0, MAX_TEXT), String(t.reply ?? '').slice(0, MAX_TEXT), t.reason ?? null, t.tainted == null ? null : t.tainted ? 1 : 0,
      t.tryId ?? null, t.provenance?.length ? JSON.stringify(t.provenance) : null, Object.keys(meta).length ? JSON.stringify(meta) : null, row.id);
  bumpTurn(d, row.id, row.project_id);
  return getTurn(row.id, d)!;
}

/**
 * Write a turn. A finished turn whose run already has an unfinished turn fills that same row in (its id stays, its
 * place in the thread stays — and a move made while the answer was being written is kept).
 */
export function writeTurn(t: NewTurn, d: AppDb = appDb()): TurnRow {
  return d.transaction(() => {
    if (t.runId && t.kind !== 'running') {
      const open = unfinishedTurnOf(t.runId, d);
      if (open) return finishTurn(open, t, d);
    }
    return insertTurn(t, d);
  }).immediate();
}

/** Merge into a turn's meta (an offer's answer, the job a run made). */
export function setTurnMeta(id: string, meta: TurnMeta, d: AppDb = appDb()): void {
  d.transaction(() => {
    const t = getTurn(id, d);
    if (!t) return;
    d.prepare('UPDATE turns SET meta = ? WHERE id = ?').run(JSON.stringify({ ...(parse<TurnMeta>(t.meta) ?? {}), ...meta }), id);
    bumpTurn(d, id, t.project_id);
  }).immediate();
}

/**
 * Turns left `running` by a process that is gone (it crashed, or an imported conversation's run never finished): they
 * become "interrupted" chat turns — shown as such, movable, and still filled in if their run's end arrives later.
 * `before`: only turns started before this (a live run started after the server did is never touched).
 */
export function interruptStaleRunning(before: number, live: Set<string> = new Set(), d: AppDb = appDb()): number {
  return d.transaction(() => {
    const rows = d.prepare(`SELECT * FROM turns WHERE kind = 'running' AND ts < ?`).all(before) as TurnRow[];
    let n = 0;
    for (const r of rows) {
      if (r.run_id && live.has(r.run_id)) continue;
      d.prepare(`UPDATE turns SET kind = 'chat', reason = 'interrupted' WHERE id = ?`).run(r.id);
      bumpTurn(d, r.id, r.project_id);
      n++;
    }
    return n;
  }).immediate();
}

/** A page cursor: the thread position (ord, grp, n) of the oldest turn on the page. It does not need that turn to
 *  still be in the thread (review of A5: moving it away used to end paging). */
export function encodeCursor(t: Pick<TurnRow, 'ord' | 'grp' | 'n'>): string { return `${t.ord}:${t.grp}:${t.n}`; }
export function decodeCursor(c: string): { ord: number; grp: number; n: number } | null {
  const m = /^(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?):(\d{1,15}):(\d{1,15})$/i.exec(c);
  if (!m) return null;
  const ord = Number(m[1]);
  return Number.isFinite(ord) ? { ord, grp: Number(m[2]), n: Number(m[3]) } : null;
}

/** A project's thread, oldest first: the `limit` turns before the cursor `before`, or the latest. `next` pages back. */
export function threadPage(projectId: string, o: { before?: string; limit?: number } = {}, d: AppDb = appDb()): { turns: TurnRow[]; next: string | null } {
  const limit = Math.max(1, Math.min(200, o.limit ?? 50));
  let rows: TurnRow[];
  if (o.before) {
    const c = decodeCursor(o.before);
    if (!c) return { turns: [], next: null };
    rows = d.prepare(`SELECT * FROM turns WHERE project_id = @p AND (ord < @o OR (ord = @o AND (grp < @g OR (grp = @g AND n < @n)))) ORDER BY ${THREAD_ORDER_DESC} LIMIT @l`)
      .all({ p: projectId, o: c.ord, g: c.grp, n: c.n, l: limit + 1 }) as TurnRow[];
  } else {
    rows = d.prepare(`SELECT * FROM turns WHERE project_id = ? ORDER BY ${THREAD_ORDER_DESC} LIMIT ?`).all(projectId, limit + 1) as TurnRow[];
  }
  const more = rows.length > limit;
  const page = rows.slice(0, limit).reverse();
  return { turns: page, next: more && page.length ? encodeCursor(page[0]) : null };
}

/** The latest turns of every active project (the /sync snapshot). */
export function recentTurns(perProject = 50, d: AppDb = appDb()): TurnRow[] {
  return listProjects({}, d).flatMap((p) => threadPage(p.id, { limit: perProject }, d).turns);
}

export class MoveError extends Error { constructor(public code: 'not_found' | 'not_movable' | 'running' | 'archived' | 'same', message: string) { super(message); } }

/**
 * Move a turn — the person's message and its answer, which are one row — to another project. The thread it leaves
 * and the one it joins both see the change; `moved_from` remembers where it was, so Undo is a move back.
 *   - A turn of an older conversation leaves that conversation too (its folder's files stay listed with it).
 *   - The Job its run or its offer made moves with it: the job's project, and the thread its results go to.
 */
export function moveTurn(id: string, toProjectId: string, d: AppDb = appDb()): { turn: TurnRow; from: string; legacySession: string | null; job: string | null } {
  return d.transaction(() => {
    const t = getTurn(id, d);
    if (!t) throw new MoveError('not_found', 'No such message.');
    if (t.kind === 'divider') throw new MoveError('not_movable', 'That is a divider, not a message.');
    if (t.kind === 'running') throw new MoveError('running', 'The answer is still being written. Move it once it is done.');
    const to = getProject(toProjectId, d);
    if (!to) throw new MoveError('not_found', 'No such project.');
    if (to.archived) throw new MoveError('archived', `${to.name} is archived. Restore it first.`);
    if (t.project_id === to.id) throw new MoveError('same', `It is already in ${to.name}.`);
    d.prepare('UPDATE turns SET project_id = ?, session = ?, moved_from = ?, legacy_session = NULL WHERE id = ?').run(to.id, sessionOf(to.id), t.project_id, id);
    bumpTurn(d, id, to.id);
    const job = jobOfTurn(t, d);
    if (job) {
      d.prepare('UPDATE jobs SET project_id = ?, session = ? WHERE id = ?').run(to.id, sessionOf(to.id), job);
      const seq = recordEvent({ entity: 'job', id: job }, d);
      d.prepare('UPDATE jobs SET updated_seq = ? WHERE id = ?').run(seq, job);
    }
    return { turn: getTurn(id, d)!, from: t.project_id, legacySession: t.legacy_session, job };
  }).immediate();
}
/** The Job a turn made: recorded on it (a chat run's job), or the goal its offer's "Work on it" started. */
function jobOfTurn(t: TurnRow, d: AppDb): string | null {
  const meta = parse<TurnMeta>(t.meta) ?? {};
  try {
    if (meta.job && d.prepare('SELECT 1 FROM jobs WHERE id = ?').get(meta.job)) return meta.job;
    const goal = meta.offer?.answered === 'background' ? meta.offer.goal : undefined;
    if (goal && /^[0-9a-f-]{8,}$/i.test(goal)) {
      const j = d.prepare(`SELECT id FROM jobs WHERE substr(legacy_goal_id, 1, ?) = ? ORDER BY created_at LIMIT 1`).get(goal.length, goal) as { id: string } | undefined;
      if (j) return j.id;
    }
  } catch { /* no jobs table here */ }
  return null;
}

/** The thread a job's result goes to: its project's, when the job works for one (it may have been moved since its task
 *  was scheduled); else where the task said. */
export function resultSessionFor(notify: string, jobProjectId: string | null | undefined, d: AppDb = appDb()): string {
  if (!jobProjectId) return notify;
  const p = getProject(jobProjectId, d);
  return p && !p.archived ? sessionOf(p.id) : notify;
}

/** The project whose thread a session writes to: its own, or General (an older conversation, an archived or unknown
 *  project). */
export function threadOfSession(session: string, d: AppDb = appDb()): string {
  const pid = projectOfSession(session);
  const p = pid ? getProject(pid, d) : undefined;
  return p && !p.archived ? p.id : GENERAL;
}
/** Of the sessions with a run going, the one writing to this project's thread (one run at a time per project, whatever
 *  session alias started it). */
export function runningIn(projectId: string, liveSessions: string[], d: AppDb = appDb()): string | null {
  return liveSessions.find((s) => threadOfSession(s, d) === projectId) ?? null;
}

// ── Cross-talk provenance ───────────────────────────────────────────────────────────────────────────────────────

/** Whether a session is an older conversation's (one the turns know, or the web app's own `web-…` ids). */
function isEarlierConversation(session: string, d: AppDb): boolean {
  if (session.startsWith('web-')) return true;
  const s = legacyId(session);
  return !!(d.prepare('SELECT 1 FROM turns WHERE legacy_session = ? LIMIT 1').get(s) ?? d.prepare('SELECT 1 FROM turns WHERE origin_session = ? LIMIT 1').get(s));
}

/**
 * Where the memories a run used came from, other than the thread it ran in — most first. A memory from another
 * active project names that project; one from a conversation before projects is "an earlier conversation". Archived
 * and private projects are never named. Memories with no session, or from runs that are not conversations (a job, an
 * import), are not cross-talk.
 */
export function crossTalk(used: { id: string; session?: string | null }[], current: { projectId: string; session?: string }, d: AppDb = appDb()): Provenance[] {
  const projects = new Map<string, Set<string>>();
  const earlier = new Set<string>();
  for (const u of used) {
    if (!u.session) continue;
    if (current.session && legacyId(u.session) === legacyId(current.session)) continue;
    const pid = projectOfSession(u.session);
    if (pid) {
      if (pid === current.projectId) continue;
      const p = getProject(pid, d);
      if (!p || p.archived || p.private) continue;
      const s = projects.get(pid) ?? new Set<string>();
      s.add(u.id); projects.set(pid, s);
    } else if (isEarlierConversation(u.session, d)) earlier.add(u.id);
  }
  const out: Provenance[] = [...projects.entries()].map(([projectId, s]) => ({ projectId, n: s.size }));
  out.sort((a, b) => b.n - a.n || ('projectId' in a && 'projectId' in b ? a.projectId.localeCompare(b.projectId) : 0));
  if (earlier.size) out.push({ earlier: true, n: earlier.size });
  return out;
}

// ── Routing suggestion ──────────────────────────────────────────────────────────────────────────────────────────

export type Embedder = (text: string) => Promise<number[]>;
let embedder: Embedder | null = null;
/** Tests: a stub embedder (null restores the model AWM loads for recall). */
export function setEmbedder(e: Embedder | null): void { embedder = e; vecCache.clear(); }
async function embed(text: string): Promise<number[]> {
  if (embedder) return embedder(text);
  return (await loadEmbeddings()).embed(text);
}

const vecCache = new Map<string, number[]>();
const VEC_CACHE_MAX = 4000;
async function cachedVec(key: string, text: string): Promise<number[]> {
  const hit = vecCache.get(key);
  if (hit) return hit;
  const v = await embed(text);
  if (vecCache.size >= VEC_CACHE_MAX) vecCache.delete(vecCache.keys().next().value as string);
  vecCache.set(key, v);
  return v;
}
function cos(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length && i < b.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** What a project's thread is about: the person's last 20 messages there. */
function recentMessages(projectId: string, d: AppDb): { id: string; text: string }[] {
  return (d.prepare(`SELECT id, message FROM turns WHERE project_id = ? AND kind IN ('chat','offer','running') AND message != '' ORDER BY ${THREAD_ORDER_DESC} LIMIT 20`)
    .all(projectId) as { id: string; message: string }[]).map((r) => ({ id: r.id, text: r.message.slice(0, 500) }));
}

const STOP = new Set(('about after again also and any are been before being but can could did does doing done for from get got had has have '
  + 'her here him his how into its just know like make many more most much need next now off once only other our out over own please same '
  + 'she should some still such than that the their them then there these they thing things this those through today tomorrow too under until '
  + 'very want was week were what when where which while who why will with would you your yours yes okay thanks thank help tell find show '
  + 'remind give send write check look let me my mine ours we us it').split(' '));
/** The words that can tell projects apart: lower case, 3+ letters, no common words, a plural's "s" dropped. */
export function routingTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of String(text).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').match(/[a-z][a-z0-9]{2,}/g) ?? []) {
    if (STOP.has(w)) continue;
    out.add(w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
  }
  return out;
}

/**
 * The weights and thresholds, tuned on tests/fixtures/routing-40.json with bge-small-en-v1.5 (AWM's recall model);
 * scripts/tune-routing.mts prints the grid. A project's score is
 *   NAME_WEIGHT·cos(message, name) + (1−NAME_WEIGHT)·cos(message, centroid of its last 20 messages)
 *   + LEX_WEIGHT·Σ idf(word) over the message's words its name or thread also uses (idf = ln(projects / projects using it)).
 * The lexical part is what lets a vague message stay vague: the embedding alone scores "Thanks, that's helpful" as
 * close to some project as a real request. Then:
 *   SUGGEST — the best score must reach this to be suggested at all;
 *   MARGIN  — and lead the runner-up by this much, or it is "not sure" (General);
 *   HINT    — inside a project, another project is hinted only when it beats this one by this much (and is suggestable).
 */
export const ROUTING = { NAME_WEIGHT: 0.2, LEX_WEIGHT: 0.06, SUGGEST: 0.5, MARGIN: 0.04, HINT: 0.06 };

export interface Suggestion {
  projectId: string;
  confidence: 'suggested' | 'not sure' | 'this project';
  alternatives: { projectId: string; name: string; score: number }[];
}
export interface ProjectScore { project: ProjectRow; byName: number; byThread: number | null; lex: number; score: number }

/** The parts of every active project's score (General aside). Null when the embedding model is unavailable. */
export async function scoreProjects(text: string, d: AppDb = appDb(), w: typeof ROUTING = ROUTING): Promise<ProjectScore[] | null> {
  const projects = listProjects({}, d).filter((p) => p.id !== GENERAL);
  if (!projects.length) return [];
  try {
    const q = await embed(text.slice(0, 1000));
    const words = routingTokens(text);
    const parts: Omit<ProjectScore, 'lex' | 'score'>[] = [];
    const vocab = new Map<string, Set<string>>();
    for (const p of projects) {
      const nameVec = await cachedVec(`name:${p.name}`, p.name);
      const msgs = recentMessages(p.id, d);
      let byThread: number | null = null;
      if (msgs.length) {
        const vecs = await Promise.all(msgs.map((m) => cachedVec(`turn:${m.id}:${m.text.length}`, m.text)));
        byThread = cos(q, vecs[0].map((_, i) => vecs.reduce((s, v) => s + v[i], 0) / vecs.length));
      }
      vocab.set(p.id, routingTokens([p.name, ...msgs.map((m) => m.text)].join(' ')));
      parts.push({ project: p, byName: cos(q, nameVec), byThread });
    }
    const df = (t: string) => projects.filter((p) => vocab.get(p.id)!.has(t)).length;
    const out = parts.map((x) => {
      let lex = 0;
      for (const t of words) if (vocab.get(x.project.id)!.has(t)) lex += Math.log(projects.length / df(t));
      const emb = x.byThread == null ? x.byName : w.NAME_WEIGHT * x.byName + (1 - w.NAME_WEIGHT) * x.byThread;
      return { ...x, lex, score: Math.round((emb + w.LEX_WEIGHT * lex) * 10_000) / 10_000 };
    });
    return out.sort((a, b) => b.score - a.score);
  } catch {
    return null;
  }
}

/** The decision on scored projects (pure: the tuning script and the tests call it with other thresholds). */
export function decide(scored: ProjectScore[] | null, inside: ProjectRow | undefined, w: typeof ROUTING = ROUTING): Suggestion {
  const alt = (x: ProjectScore) => ({ projectId: x.project.id, name: x.project.name, score: x.score });
  if (inside) {
    if (!scored?.length) return { projectId: inside.id, confidence: 'this project', alternatives: [] };
    const here = scored.find((x) => x.project.id === inside.id)?.score ?? 0;
    const others = scored.filter((x) => x.project.id !== inside.id);
    const best = others[0];
    const strong = !!best && best.score >= w.SUGGEST && best.score - here >= w.HINT && best.score - (others[1]?.score ?? 0) >= w.MARGIN;
    return { projectId: inside.id, confidence: 'this project', alternatives: strong ? [alt(best)] : [] };
  }
  if (!scored?.length) return { projectId: GENERAL, confidence: 'not sure', alternatives: [] };
  const [first, second] = scored;
  if (first.score >= w.SUGGEST && (!second || first.score - second.score >= w.MARGIN)) {
    return { projectId: first.project.id, confidence: 'suggested', alternatives: scored.slice(1, 3).map(alt) };
  }
  return { projectId: GENERAL, confidence: 'not sure', alternatives: scored.slice(0, 2).map(alt) };
}

/**
 * Where a message should go. From inside a project (`fromProjectId`, not General) it stays there ('this project'); a
 * strong match for another project comes back as the one alternative — a hint the person may take, never a switch.
 * From Now/Today or General: the best project when it is clearly best ('suggested'), else General ('not sure') with
 * the closest projects as alternatives.
 */
export async function suggestProject(text: string, fromProjectId?: string | null, d: AppDb = appDb()): Promise<Suggestion> {
  const from = fromProjectId && fromProjectId !== GENERAL ? getProject(fromProjectId, d) : undefined;
  const inside = from && !from.archived ? from : undefined;
  const t = String(text ?? '').trim();
  return decide(t ? await scoreProjects(t, d) : [], inside);
}
