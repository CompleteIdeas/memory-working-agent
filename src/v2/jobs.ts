/**
 * v2 slice A3a: Jobs and Tries — the server owns what a piece of work IS and how it stands.
 *
 * A Job is one thing the person handed over: a background hand-off, a recurring check, a reminder, a planned run, a
 * chat whose work outlived the request. A Try is one run of it: the first, each automatic continuation after a run
 * ran out of room, the person's Continue or Start over, each fire of a recurring job, a resume after a restart.
 * Before this, the web app guessed both from conversation turns (web/src/tasks.ts), so an automatic continuation was
 * an unlinked scheduled task, hidden from /api/schedule, and the job it continued said FAILED while it ran (SR-F02).
 *
 * The memory store still decides WHEN (a scheduled-task engram is the clock); app.db says WHICH job and which try.
 * Scheduled tasks are linked to Jobs in two ways:
 *   - v2 code creates the Try first and tags the task `v2try=` (and `v2job=`), so the scheduler claims that Try;
 *   - anything else that schedules (the model's tools, older code) is mapped by the store hook (storeHooks.scheduled)
 *     from the task's own lineage: `resumeof=`, its goal's own continuation, or a new Job.
 *
 * Claims (review of A3a, H1/H2/M7). A Try is claimed by a process instance (src/transcript.ts INSTANCE, the same id
 * whose heartbeat file says it is alive). One scheduled fire — (task, due) — gets ONE Try for good, finished ones
 * included, so a second process with a stale task list cannot run it again; only a Try reaped from a dead claimer
 * frees its fire. A `running` Try whose claimer stopped beating is reaped (ended, "cut off"), never left "working".
 *
 * Every write bumps `updated_seq` through recordEvent in the same transaction (the sync cursor, slice A4).
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { appDb, registerMigrations, recordEvent, type AppDb, type Migration } from './db.js';
import { storeHooks, type ScheduleOpts, type ScheduledTask, type GoalStatus } from '../awm.js';
import { jobStatus, normalizeRemaining, type JobStatus } from './status.js';
import { estimateJob, estimateForTrigger, stepCost, defaultCapUsd, firstGuess, fireCapUsd, CAP_MAX_USD, type JobEstimate, type StepCost } from './estimate.js';
import { reserveForFollowUp, spendLedger, type Ledger } from '../spend.js';
import { readTail, tokenLogPath } from '../billing.js';
import { priceFor, UNKNOWN_PRICE } from '../model-prices.js';
import { INSTANCE, instanceAlive, startHeartbeat, transcriptsDir } from '../transcript.js';

export type JobKind = 'background' | 'recurring' | 'reminder' | 'plan' | 'live';
export type TryTrigger = 'first' | 'auto-continue' | 'continue' | 'start-over' | 'fire' | 'resume-after-restart';
export type TryState = 'queued' | 'running' | 'ended';
export type JobLifecycle = 'active' | 'paused' | 'cancelled';
/** Who ended a Try when its own run did not: the person, a cancel, the model itself, its goal being done, the reaper. */
export type EndedBy = 'person' | 'cancel' | 'self' | 'goal-done' | 'reaper' | 'duplicate';

export const JOBS_MIGRATION: Migration = {
  name: '002-jobs',
  sql: `
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('background','recurring','reminder','plan','live')),
      title TEXT NOT NULL,
      request TEXT,
      person TEXT,
      created_at INTEGER NOT NULL,
      updated_seq INTEGER NOT NULL DEFAULT 0,
      schedule_id TEXT,
      legacy_goal_id TEXT,
      cap_usd REAL,
      model_tier TEXT,
      progress_done REAL,
      progress_total REAL,
      progress_unit TEXT,
      remaining TEXT,
      where_it_stands TEXT,
      stands_trust TEXT CHECK (stands_trust IS NULL OR stands_trust IN ('high','medium','untrusted')),
      result_ref TEXT,
      seen_at INTEGER,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','cancelled')),
      archived INTEGER NOT NULL DEFAULT 0,
      -- where it reports and works (a Continue runs in the same folder), and the key that makes migration idempotent
      session TEXT,
      dir TEXT,
      legacy_key TEXT UNIQUE
    );
    CREATE INDEX IF NOT EXISTS jobs_schedule ON jobs(schedule_id);
    CREATE INDEX IF NOT EXISTS jobs_goal ON jobs(legacy_goal_id);
    CREATE INDEX IF NOT EXISTS jobs_seq ON jobs(updated_seq);
    CREATE TABLE IF NOT EXISTS tries (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      n INTEGER NOT NULL,
      trigger TEXT NOT NULL CHECK (trigger IN ('first','auto-continue','continue','start-over','fire','resume-after-restart')),
      run_id TEXT,
      live_key TEXT,
      state TEXT NOT NULL CHECK (state IN ('queued','running','ended')),
      due_at INTEGER,
      claimed_by TEXT,
      started_at INTEGER,
      ended_at INTEGER,
      reason TEXT,
      outcome TEXT,
      progress_done REAL,
      progress_total REAL,
      progress_unit TEXT,
      remaining TEXT,
      cost_usd REAL,
      steps INTEGER,
      tool_calls INTEGER,
      cap_hit TEXT,
      summary TEXT,
      tainted INTEGER NOT NULL DEFAULT 0,
      staged TEXT,
      est_usd REAL,
      est_ms INTEGER,
      updated_seq INTEGER NOT NULL DEFAULT 0,
      -- the scheduled-task engram that runs it, pages it read, and the migration key
      schedule_id TEXT,
      pages_read INTEGER,
      legacy_key TEXT UNIQUE,
      UNIQUE (job_id, n)
    );
    CREATE INDEX IF NOT EXISTS tries_job ON tries(job_id, n);
    CREATE INDEX IF NOT EXISTS tries_state ON tries(state, due_at);
    CREATE INDEX IF NOT EXISTS tries_schedule ON tries(schedule_id);
    CREATE INDEX IF NOT EXISTS tries_live ON tries(live_key);
    -- one unfinished Try per scheduled fire: two processes firing the same task cannot both run it
    CREATE UNIQUE INDEX IF NOT EXISTS tries_one_per_fire ON tries(schedule_id, due_at) WHERE state != 'ended' AND schedule_id IS NOT NULL AND due_at IS NOT NULL;`,
};

/**
 * Review of A3a (2026-10-26). Who ended a Try and whether its result reached the person; the fire id (so a re-run
 * migration recognises a fire recorded live); a recurring job's next run and who stopped a job; 8-character task
 * prefixes as indexed columns (a resume names its job by one); one Try per scheduled fire FOR GOOD (finished ones
 * included; only a reaped Try frees its fire); and a per-job reservation held across an action's awaits.
 */
export const JOBS_FIX_MIGRATION: Migration = {
  name: '003-jobs-claims',
  sql: `
    ALTER TABLE tries ADD COLUMN ended_by TEXT;
    ALTER TABLE tries ADD COLUMN delivered INTEGER;
    ALTER TABLE tries ADD COLUMN fire_id TEXT;
    ALTER TABLE jobs ADD COLUMN next_due_at INTEGER;
    ALTER TABLE jobs ADD COLUMN stopped_by TEXT;
    ALTER TABLE jobs ADD COLUMN schedule_prefix TEXT GENERATED ALWAYS AS (substr(schedule_id, 1, 8)) VIRTUAL;
    ALTER TABLE tries ADD COLUMN schedule_prefix TEXT GENERATED ALWAYS AS (substr(schedule_id, 1, 8)) VIRTUAL;
    CREATE INDEX IF NOT EXISTS jobs_schedule_prefix ON jobs(schedule_prefix);
    CREATE INDEX IF NOT EXISTS tries_schedule_prefix ON tries(schedule_prefix);
    CREATE INDEX IF NOT EXISTS tries_fire ON tries(fire_id);
    CREATE INDEX IF NOT EXISTS tries_claimed ON tries(state, claimed_by);
    -- older duplicates of one fire (recorded before this step) keep their data but stop counting as the fire's Try
    UPDATE tries SET ended_by = 'duplicate' WHERE state = 'ended' AND schedule_id IS NOT NULL AND due_at IS NOT NULL
      AND EXISTS (SELECT 1 FROM tries t2 WHERE t2.schedule_id = tries.schedule_id AND t2.due_at = tries.due_at AND t2.rowid > tries.rowid);
    DROP INDEX IF EXISTS tries_one_per_fire;
    CREATE UNIQUE INDEX IF NOT EXISTS tries_one_per_fire ON tries(schedule_id, due_at)
      WHERE schedule_id IS NOT NULL AND due_at IS NOT NULL AND (ended_by IS NULL OR ended_by NOT IN ('reaper','duplicate'));
    CREATE TABLE IF NOT EXISTS job_locks (job_id TEXT PRIMARY KEY, holder TEXT NOT NULL, at INTEGER NOT NULL);`,
};
/**
 * Slice A3b: the first estimate a job was given when it started, so a finished job can say "I guessed about $0.35 ·
 * it cost $0.41". (004 and 005 are the calendar and mail slices' steps.)
 */
export const ESTIMATES_MIGRATION: Migration = {
  name: '006-estimates',
  sql: `
    ALTER TABLE jobs ADD COLUMN est_usd_first REAL;
    ALTER TABLE jobs ADD COLUMN est_ms_first INTEGER;
    -- pages read, fetched or in the browser (estimates price work by them), and the allowance the Try's run was given
    ALTER TABLE tries ADD COLUMN reads INTEGER;
    ALTER TABLE tries ADD COLUMN cap_usd REAL;
    -- a repeating follow-up of a capped run: the most all its fires together may spend (A3b re-review)
    ALTER TABLE jobs ADD COLUMN cap_total_usd REAL;`,
};
/**
 * Slice A6 (review): how much a job has to read, known before it starts — the big-ask plan counted its attached files
 * the way read_document reads them. Without it a capped job's Continue was priced from the agent's own plan steps
 * ("Finish the last 3 steps · about 30¢" on a 149-page read).
 */
export const JOB_SIZE_MIGRATION: Migration = {
  name: '012-job-size',
  sql: `
    ALTER TABLE jobs ADD COLUMN size_reads INTEGER;
    ALTER TABLE jobs ADD COLUMN size_pages INTEGER;`,
};
registerMigrations([JOBS_MIGRATION, JOBS_FIX_MIGRATION, ESTIMATES_MIGRATION, JOB_SIZE_MIGRATION]);

export interface JobRow {
  id: string; project_id: string | null; kind: JobKind; title: string; request: string | null; person: string | null;
  created_at: number; updated_seq: number; schedule_id: string | null; legacy_goal_id: string | null;
  cap_usd: number | null; model_tier: string | null; progress_done: number | null; progress_total: number | null;
  progress_unit: string | null; remaining: string | null; where_it_stands: string | null; stands_trust: string | null;
  result_ref: string | null; seen_at: number | null; status: JobLifecycle; archived: number;
  session: string | null; dir: string | null; legacy_key: string | null;
  next_due_at: number | null; stopped_by: string | null; schedule_prefix: string | null;
  est_usd_first: number | null; est_ms_first: number | null;
  cap_total_usd?: number | null;
  /** A6: read_document calls and pages its attached files take (known before it starts), or null */
  size_reads?: number | null; size_pages?: number | null;
}
export interface TryRow {
  id: string; job_id: string; n: number; trigger: TryTrigger; run_id: string | null; live_key: string | null;
  state: TryState; due_at: number | null; claimed_by: string | null; started_at: number | null; ended_at: number | null;
  reason: string | null; outcome: string | null; progress_done: number | null; progress_total: number | null;
  progress_unit: string | null; remaining: string | null; cost_usd: number | null; steps: number | null;
  tool_calls: number | null; cap_hit: string | null; summary: string | null; tainted: number; staged: string | null;
  est_usd: number | null; est_ms: number | null; updated_seq: number; schedule_id: string | null;
  pages_read: number | null; legacy_key: string | null; ended_by: EndedBy | null; delivered: number | null;
  fire_id: string | null; schedule_prefix: string | null;
  reads: number | null; cap_usd: number | null;
}

export interface NewJob {
  kind: JobKind; title: string; request?: string; person?: string; createdAt?: number; scheduleId?: string;
  legacyGoalId?: string; capUsd?: number; session?: string; dir?: string; legacyKey?: string; status?: JobLifecycle;
  whereItStands?: string; standsTrust?: string; nextDueAt?: number;
  /** the project it works for; left out, a `p-<id>` session names it (A5) */
  projectId?: string | null;
}
export interface NewTry {
  trigger: TryTrigger; state?: TryState; dueAt?: number; scheduleId?: string; liveKey?: string; runId?: string;
  startedAt?: number; claimedBy?: string; legacyKey?: string;
}
/** What a run reports at its end (from AgentResult, or a migrated notification). */
export interface TryEnd {
  reason?: string; outcome?: string; costUsd?: number; steps?: number; toolCalls?: number; summary?: string;
  progress?: { done: number; total: number; unit?: string }; remaining?: string; capHit?: string; tainted?: boolean;
  staged?: string[]; pagesRead?: number; reads?: number; endedAt?: number; startedAt?: number; runId?: string;
  /** false: the scheduler kept this result quiet (deliver=changed and nothing new) — not "result ready" */
  delivered?: boolean; fireId?: string; endedBy?: EndedBy;
}

/** Who claims a Try: this process instance — the id whose heartbeat (src/transcript.ts) says it is alive. */
export const CLAIMER = INSTANCE;

/**
 * Is the process that claimed a Try still alive? This one is. Another is alive while its heartbeat is fresh
 * (STALE_MS), and — on this machine — while the pid its heartbeat names still exists, so a crashed process's Tries are
 * reaped at the next start instead of three minutes later. (A heartbeat from another machine sharing the folder is
 * judged by freshness alone only if its pid check cannot be made; see `pidGone`.)
 */
export function claimerAlive(claimer: string | null | undefined, now = Date.now()): boolean {
  if (!claimer) return false;
  if (claimer === CLAIMER) return true;
  if (!instanceAlive(claimer, now)) return false;
  return !pidGone(claimer);
}
function pidGone(claimer: string): boolean {
  try {
    const pid = Number.parseInt(readFileSync(join(transcriptsDir(), `.instance-${claimer}`), 'utf8').trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH'; }
  } catch { return false; }
}

// ── The person's own actions (review M8) ─────────────────────────────────────────────────────────────────────────
// A cancel or a goal marked done reaches the store the same way whether the person tapped it in the app or the model
// called its own tool. The app's controls run inside personAction(), so the hooks below can tell "stopped by you"
// from "it stopped itself".
const personCtx = new AsyncLocalStorage<boolean>();
export function personAction<T>(fn: () => T): T { return personCtx.run(true, fn); }
const byPerson = () => personCtx.getStore() === true;

const newId = (p: 'j' | 't') => `${p}_${randomBytes(8).toString('hex')}`;

/** A Job's title: the first sentence of the person's words, trimmed (the framing of a hand-off is not a title). */
export function titleOf(text: string): string {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  const first = t.split(/(?<=[.!?])\s/)[0] ?? t;
  return (first.length > 100 ? `${first.slice(0, 97).replace(/\s+\S*$/, '')}…` : first) || 'Untitled job';
}

function bumpJob(d: AppDb, jobId: string, person?: string | null): number {
  const seq = recordEvent({ entity: 'job', id: jobId, person: person ?? undefined }, d);
  d.prepare('UPDATE jobs SET updated_seq = ? WHERE id = ?').run(seq, jobId);
  return seq;
}
function bumpTry(d: AppDb, tryId: string, jobId: string): void {
  const seq = recordEvent({ entity: 'try', id: tryId, payload: { job: jobId } }, d);
  d.prepare('UPDATE tries SET updated_seq = ? WHERE id = ?').run(seq, tryId);
  bumpJob(d, jobId);
}

export function getJob(id: string, d: AppDb = appDb()): JobRow | undefined {
  return d.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
}
export function getTry(id: string, d: AppDb = appDb()): TryRow | undefined {
  return d.prepare('SELECT * FROM tries WHERE id = ?').get(id) as TryRow | undefined;
}
export function triesOf(jobId: string, d: AppDb = appDb()): TryRow[] {
  return d.prepare('SELECT * FROM tries WHERE job_id = ? ORDER BY n').all(jobId) as TryRow[];
}
/** Jobs, most recently changed first; a page at a time (`before`: an updated_seq cursor). */
export function listJobs(o: { archived?: boolean; limit?: number; before?: number } = {}, d: AppDb = appDb()): JobRow[] {
  const where = [o.archived ? '' : 'archived = 0', o.before != null ? 'updated_seq < @before' : ''].filter(Boolean);
  return d.prepare(`SELECT * FROM jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_seq DESC ${o.limit ? 'LIMIT @limit' : ''}`)
    .all({ ...(o.before != null ? { before: o.before } : {}), ...(o.limit ? { limit: o.limit } : {}) }) as JobRow[];
}
/** A project's jobs, most recently changed first (A5). General also holds the jobs no project claims. */
export function projectJobs(projectId: string, o: { limit?: number } = {}, d: AppDb = appDb()): JobRow[] {
  return d.prepare(`SELECT * FROM jobs WHERE archived = 0 AND (project_id = @p OR (@p = 'general' AND project_id IS NULL)) ORDER BY updated_seq DESC LIMIT @limit`)
    .all({ p: projectId, limit: Math.max(1, Math.min(500, o.limit ?? 100)) }) as JobRow[];
}
export function jobByGoal(goalId: string, d: AppDb = appDb()): JobRow | undefined {
  return d.prepare('SELECT * FROM jobs WHERE legacy_goal_id = ? ORDER BY created_at LIMIT 1').get(goalId) as JobRow | undefined;
}
/** The Job a scheduled task belongs to: the job it is the clock of, or the job of a Try it runs. */
export function jobBySchedule(scheduleId: string, d: AppDb = appDb()): JobRow | undefined {
  return (d.prepare('SELECT * FROM jobs WHERE schedule_id = ? OR legacy_key = ? LIMIT 1').get(scheduleId, `sched:${scheduleId}`) as JobRow | undefined)
    ?? (d.prepare('SELECT j.* FROM jobs j JOIN tries t ON t.job_id = j.id WHERE t.schedule_id = ? LIMIT 1').get(scheduleId) as JobRow | undefined);
}
/** A resume names its job by an 8-character prefix (`resumeof=`): the job whose task, or one of whose Tries' tasks,
 *  starts with it — an exact match on an indexed column, not a LIKE scan (review). */
export function jobByPrefix(prefix: string, d: AppDb = appDb()): JobRow | undefined {
  const p = String(prefix ?? '').slice(0, 8);
  if (p.length < 8) return undefined;
  return (d.prepare(`SELECT * FROM jobs WHERE schedule_prefix = ? OR legacy_key = ? ORDER BY created_at LIMIT 1`).get(p, `sched:${p}`) as JobRow | undefined)
    ?? (d.prepare('SELECT j.* FROM jobs j JOIN tries t ON t.job_id = j.id WHERE t.schedule_prefix = ? ORDER BY t.n LIMIT 1').get(p) as JobRow | undefined);
}

function projectFor(d: AppDb, id: string | null): string | null {
  if (!id) return null;
  try {
    const p = d.prepare('SELECT archived FROM projects WHERE id = ?').get(id) as { archived: number } | undefined;
    return p && !p.archived ? id : 'general';
  } catch { return null; /* no projects table in this database */ }
}
function insertJob(d: AppDb, j: NewJob): JobRow {
  const id = newId('j');
  // A5: a Job made from a project's thread (its session is `p-<project id>`) works for that project — one that exists;
  // a session naming none (deleted, made up) or an archived one makes it General's.
  const projectId = projectFor(d, j.projectId ?? (j.session && j.session.startsWith('p-') && j.session.length > 2 ? j.session.slice(2) : null));
  d.prepare(`INSERT INTO jobs (id, project_id, kind, title, request, person, created_at, schedule_id, legacy_goal_id, cap_usd, session, dir, legacy_key, status, where_it_stands, stands_trust, next_due_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, projectId, j.kind, j.title.slice(0, 300), j.request?.slice(0, 4000) ?? null, j.person ?? null,
    j.createdAt ?? Date.now(), j.scheduleId ?? null, j.legacyGoalId ?? null, j.capUsd ?? null, j.session ?? null, j.dir ?? null,
    j.legacyKey ?? null, j.status ?? 'active', j.whereItStands ?? null, j.standsTrust ?? null, j.nextDueAt ?? null);
  bumpJob(d, id, j.person);
  return getJob(id, d)!;
}
function insertTry(d: AppDb, jobId: string, t: NewTry): TryRow {
  const id = newId('t');
  const n = ((d.prepare('SELECT MAX(n) m FROM tries WHERE job_id = ?').get(jobId) as { m: number | null }).m ?? 0) + 1;
  if (t.state === 'running' || t.claimedBy) startHeartbeat(); // a claimer must beat, or another process reaps it
  d.prepare(`INSERT INTO tries (id, job_id, n, trigger, state, due_at, schedule_id, live_key, run_id, started_at, claimed_by, legacy_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, jobId, n, t.trigger, t.state ?? 'queued', t.dueAt ?? null, t.scheduleId ?? null,
    t.liveKey ?? (t.scheduleId ? `job_${t.scheduleId}` : null), t.runId ?? null, t.startedAt ?? null, t.claimedBy ?? null, t.legacyKey ?? null);
  bumpTry(d, id, jobId);
  return getTry(id, d)!;
}

/** Create a Job (and optionally its first Try) in one transaction. A Job whose legacy key exists is returned as it is. */
export function createJob(j: NewJob, first?: NewTry, d: AppDb = appDb()): { job: JobRow; try?: TryRow } {
  return d.transaction(() => {
    if (j.legacyKey) {
      const had = d.prepare('SELECT * FROM jobs WHERE legacy_key = ?').get(j.legacyKey) as JobRow | undefined;
      if (had) return { job: had };
    }
    const job = insertJob(d, j);
    return { job, ...(first ? { try: insertTry(d, job.id, first) } : {}) };
  }).immediate();
}
/** Add a Try to a Job (numbered after the last one). */
export function addTry(jobId: string, t: NewTry, d: AppDb = appDb()): TryRow {
  return d.transaction(() => insertTry(d, jobId, t)).immediate();
}
/** Remove a queued Try that was never scheduled (its task could not be written). */
export function dropQueuedTry(tryId: string, d: AppDb = appDb()): void {
  d.transaction(() => {
    const t = getTry(tryId, d);
    if (!t || t.state !== 'queued') return;
    d.prepare('DELETE FROM tries WHERE id = ?').run(tryId);
    recordEvent({ entity: 'try', id: tryId, op: 'delete', payload: { job: t.job_id } }, d);
    bumpJob(d, t.job_id);
  }).immediate();
}
/** Link a queued Try to the scheduled task that will run it. */
export function linkTry(tryId: string, scheduleId: string, dueAt: number | undefined, d: AppDb = appDb()): void {
  d.transaction(() => {
    const t = getTry(tryId, d);
    if (!t) return;
    d.prepare('UPDATE tries SET schedule_id = ?, live_key = ?, due_at = COALESCE(?, due_at) WHERE id = ?').run(scheduleId, `job_${scheduleId}`, dueAt ?? null, tryId);
    const job = getJob(t.job_id, d);
    if (job && !job.schedule_id && job.kind !== 'recurring') d.prepare('UPDATE jobs SET schedule_id = ? WHERE id = ?').run(scheduleId, job.id);
    bumpTry(d, tryId, t.job_id);
  }).immediate();
  const t = getTry(tryId, d);
  if (t) stampEstimates(t.job_id, d);
}

/** Claim a queued Try for this process: `UPDATE … WHERE state='queued' RETURNING`. Null when someone else has it. */
export function claimTry(tryId: string, c: { runId?: string; liveKey?: string; scheduleId?: string; now?: number; claimedBy?: string }, d: AppDb = appDb()): TryRow | null {
  startHeartbeat();
  return d.transaction(() => {
    const row = d.prepare(`UPDATE tries SET state = 'running', claimed_by = ?, started_at = ?, run_id = COALESCE(?, run_id), live_key = COALESCE(?, live_key),
      schedule_id = COALESCE(schedule_id, ?) WHERE id = ? AND state = 'queued' RETURNING *`)
      .get(c.claimedBy ?? CLAIMER, c.now ?? Date.now(), c.runId ?? null, c.liveKey ?? null, c.scheduleId ?? null, tryId) as TryRow | undefined;
    if (!row) return null;
    bumpTry(d, row.id, row.job_id);
    return row;
  }).immediate();
}

const clampText = (s: unknown, n: number) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t ? t.slice(0, n) : null; };
const finite = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** End a Try with what the run reported, and mirror its progress and what is left onto the Job. */
export function endTry(tryId: string, e: TryEnd, d: AppDb = appDb()): TryRow | null {
  return d.transaction(() => {
    const t = getTry(tryId, d);
    if (!t || t.state === 'ended') return null;
    const p = e.progress && Number.isFinite(e.progress.done) && Number.isFinite(e.progress.total) && e.progress.total > 0 ? e.progress : undefined;
    const ended = e.endedAt ?? Date.now();
    const remaining = normalizeRemaining(e.remaining);
    d.prepare(`UPDATE tries SET state = 'ended', ended_at = ?, started_at = COALESCE(started_at, ?), run_id = COALESCE(?, run_id), reason = ?, outcome = ?, cost_usd = ?, steps = ?, tool_calls = ?,
      progress_done = ?, progress_total = ?, progress_unit = ?, remaining = ?, cap_hit = ?, summary = ?, tainted = ?, staged = ?, pages_read = ?, reads = ?, delivered = ?, fire_id = COALESCE(?, fire_id), ended_by = ? WHERE id = ?`)
      .run(ended, e.startedAt ?? null, e.runId ?? null, e.reason ?? null, e.outcome ?? null, finite(e.costUsd), finite(e.steps), finite(e.toolCalls),
        p ? p.done : null, p ? p.total : null, p ? clampText(p.unit, 40) : null, remaining ? remaining.slice(0, 400) : null, e.capHit ?? null,
        e.summary ? String(e.summary).slice(0, 4000) : null, e.tainted ? 1 : 0, e.staged?.length ? JSON.stringify(e.staged.slice(0, 50)) : null, finite(e.pagesRead), finite(e.reads ?? e.pagesRead),
        e.delivered === undefined ? null : e.delivered ? 1 : 0, e.fireId ?? null, e.endedBy ?? null, tryId);
    // The Job shows the latest word: this Try's progress and what it left (none said = none known now).
    d.prepare('UPDATE jobs SET progress_done = ?, progress_total = ?, progress_unit = COALESCE(?, progress_unit), remaining = ? WHERE id = ?')
      .run(p ? p.done : null, p ? p.total : null, p ? clampText(p.unit, 40) : null, remaining ? remaining.slice(0, 400) : null, t.job_id);
    bumpTry(d, tryId, t.job_id);
    return getTry(tryId, d)!;
  }).immediate();
}

function endQueuedRows(d: AppDb, rows: TryRow[], by: EndedBy, summary: string): void {
  for (const t of rows) {
    d.prepare(`UPDATE tries SET state = 'ended', ended_at = ?, reason = 'stopped', summary = ?, ended_by = ? WHERE id = ? AND state = 'queued'`).run(Date.now(), summary, by, t.id);
    bumpTry(d, t.id, t.job_id);
  }
}
/** The person's Stop: every queued Try of a Job ends, stopped by the person. Returns the tasks they waited on. */
export function endQueued(jobId: string, summary: string, d: AppDb = appDb()): string[] {
  return d.transaction(() => {
    const q = d.prepare(`SELECT * FROM tries WHERE job_id = ? AND state = 'queued'`).all(jobId) as TryRow[];
    endQueuedRows(d, q, 'person', summary);
    return q.map((t) => t.schedule_id).filter((x): x is string => !!x);
  }).immediate();
}

/** End the queued Tries waiting on one scheduled task (its goal is done, so it will not run). Best-effort. */
export function endScheduleTries(scheduleId: string, by: EndedBy, summary: string): void {
  try {
    const d = appDb();
    d.transaction(() => endQueuedRows(d, d.prepare(`SELECT * FROM tries WHERE schedule_id = ? AND state = 'queued'`).all(scheduleId) as TryRow[], by, summary)).immediate();
  } catch { /* bookkeeping never blocks the scheduler */ }
}

/** Set some of a Job's own fields (seen_at, lifecycle, where it stands…). */
export function updateJob(jobId: string, f: Partial<Pick<JobRow, 'seen_at' | 'status' | 'where_it_stands' | 'stands_trust' | 'archived' | 'schedule_id' | 'session' | 'dir' | 'result_ref' | 'cap_usd' | 'next_due_at' | 'stopped_by' | 'model_tier' | 'size_reads' | 'size_pages' | 'est_usd_first' | 'est_ms_first'>>, d: AppDb = appDb()): JobRow | undefined {
  const keys = Object.keys(f).filter((k) => (f as Record<string, unknown>)[k] !== undefined);
  if (!keys.length) return getJob(jobId, d);
  return d.transaction(() => {
    d.prepare(`UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => (f as Record<string, unknown>)[k]), jobId);
    bumpJob(d, jobId);
    return getJob(jobId, d);
  }).immediate();
}

// ── A per-job reservation for the person's actions (review H4b) ─────────────────────────────────────────────────

/** What makes a Job busy for Continue and Start over: anything queued (whatever its due time) or running. */
export function busyReason(jobId: string, d: AppDb = appDb()): 'running' | 'queued' | null {
  const rows = d.prepare(`SELECT state, claimed_by FROM tries WHERE job_id = ? AND state != 'ended'`).all(jobId) as { state: string; claimed_by: string | null }[];
  if (rows.some((r) => r.state === 'running' && claimerAlive(r.claimed_by))) return 'running';
  if (rows.some((r) => r.state === 'queued')) return 'queued';
  return null;
}
const LOCK_STALE_MS = 2 * 60_000;
/** Reserve a Job for one action, synchronously, before any await: refused when it is busy or another action holds
 *  it. Release it in a finally. A reservation older than two minutes (a crashed request) is taken over. */
export function reserveJob(jobId: string, holder: string, d: AppDb = appDb()): { ok: true } | { ok: false; why: 'running' | 'queued' | 'locked' } {
  return d.transaction((): { ok: true } | { ok: false; why: 'running' | 'queued' | 'locked' } => {
    const busy = busyReason(jobId, d);
    if (busy) return { ok: false, why: busy };
    const lock = d.prepare('SELECT holder, at FROM job_locks WHERE job_id = ?').get(jobId) as { holder: string; at: number } | undefined;
    if (lock && Date.now() - lock.at < LOCK_STALE_MS) return { ok: false, why: 'locked' };
    d.prepare('INSERT OR REPLACE INTO job_locks (job_id, holder, at) VALUES (?, ?, ?)').run(jobId, holder, Date.now());
    return { ok: true };
  }).immediate();
}
export function releaseJob(jobId: string, holder: string, d: AppDb = appDb()): void {
  try { d.prepare('DELETE FROM job_locks WHERE job_id = ? AND holder = ?').run(jobId, holder); } catch { /* */ }
}
/** A Job reserved by an action in flight (the legacy Continue checks it too). */
export function jobLocked(jobId: string, d: AppDb = appDb()): boolean {
  const lock = d.prepare('SELECT at FROM job_locks WHERE job_id = ?').get(jobId) as { at: number } | undefined;
  return !!lock && Date.now() - lock.at < LOCK_STALE_MS;
}

// ── Estimates and the dollar cap (slice A3b) ────────────────────────────────────────────────────────────────────

/**
 * Stamp the Tries of a Job that have not run to the end and carry no estimate yet with what they are expected to cost
 * (est_usd, est_ms: a fresh start the whole job, anything else what is left), and give a Job that is only now starting
 * its first estimate (est_usd_first), kept for "I guessed about $0.35 · it cost $0.41". Best-effort: an estimate never
 * blocks the work it describes.
 */
export function stampEstimates(jobId: string, d: AppDb = appDb()): void {
  try {
    const job = getJob(jobId, d);
    if (!job) return;
    const tries = triesOf(jobId, d);
    const open = tries.filter((t) => t.state !== 'ended' && t.est_usd == null);
    if (!open.length) return;
    const e = estimateJob(job, tries);
    d.transaction(() => {
      for (const t of open) {
        const a = estimateForTrigger(e, t.trigger);
        if (!a) continue;
        d.prepare('UPDATE tries SET est_usd = ?, est_ms = ? WHERE id = ? AND est_usd IS NULL').run(a.usd, a.ms, t.id);
        bumpTry(d, t.id, jobId);
      }
      // The first estimate: a one-off job starting (nothing has ended yet). A repeating job has no "whole job" to guess.
      const first = open[0];
      const a = estimateForTrigger(e, first.trigger);
      if (a && job.est_usd_first == null && job.kind !== 'recurring' && job.kind !== 'reminder' && !tries.some((t) => t.state === 'ended')) {
        d.prepare('UPDATE jobs SET est_usd_first = ?, est_ms_first = ? WHERE id = ? AND est_usd_first IS NULL').run(a.usd, a.ms, jobId);
        bumpJob(d, jobId);
      }
    }).immediate();
  } catch (e) { console.error('[v2] could not estimate a job:', (e as Error).message.slice(0, 160)); }
}

/** Who authorises spending: the person's own start (first, continue, start over) or a scheduled fire. An automatic
 *  continuation or a resume after a restart spends from the same authorisation. */
const AUTHORISING = new Set<TryTrigger>(['first', 'continue', 'start-over', 'fire']);

/** The spend of the Tries running in THIS process, live (the scheduler registers each fire's ledger). */
export const runningSpend = new Map<string, Ledger>();

/** What the token log says a Try's run spent: its task's calls (tagged with the task's 8-character id) inside the
 *  Try's window — each call's own cost, or, for a line without one (openai:, gemini: direct), its tokens at the
 *  model's list price (an unpriced model conservatively). Null when the log has no such calls at all. */
export function loggedSpend(t: Pick<TryRow, 'schedule_id' | 'started_at' | 'ended_at'>, now = Date.now()): number | null {
  if (!t.schedule_id || t.started_at == null) return null;
  try {
    const job = t.schedule_id.slice(0, 8);
    const to = (t.ended_at ?? now) + 5000, from = t.started_at - 1000;
    let found = 0, usd = 0;
    for (const line of (readTail(tokenLogPath()) ?? '').split('\n')) {
      if (!line.includes(job)) continue;
      let d: Record<string, unknown>;
      try { d = JSON.parse(line); } catch { continue; }
      const ts = Number(d.ts);
      if (d.job !== job || !(ts >= from && ts <= to)) continue;
      found++;
      if (typeof d.cost === 'number' && Number.isFinite(d.cost)) { usd += d.cost; continue; }
      const p = priceFor(String(d.model ?? '')) ?? UNKNOWN_PRICE;
      usd += (Number(d.in) || 0) / 1e6 * p.in + (Number(d.out) || 0) / 1e6 * p.out;
    }
    return found ? usd : null;
  } catch { return null; }
}

/** A call that landed after its Try reported (the lesson judge past its timeout): added to the Try's cost. */
export function addTryCost(tryId: string, usd: number, d: AppDb = appDb()): void {
  if (!(usd > 0)) return;
  try {
    d.transaction(() => {
      const t = getTry(tryId, d);
      if (!t) return;
      d.prepare('UPDATE tries SET cost_usd = COALESCE(cost_usd, 0) + ? WHERE id = ?').run(usd, tryId);
      bumpTry(d, tryId, t.job_id);
    }).immediate();
  } catch { /* bookkeeping */ }
}

/** What a Try has spent, as well as it can be known: its recorded cost; for one still running here, its live ledger;
 *  for one reaped or running elsewhere, the token log — and when nothing says, the whole allowance it was given
 *  (`Infinity` when that is unknown too), so a restart or a second process never gets the allowance again. */
function spendOf(t: TryRow): number {
  if (t.state === 'ended' && typeof t.cost_usd === 'number') return Math.max(0, t.cost_usd);
  if (t.state === 'queued') return 0;
  const live = runningSpend.get(t.id);
  if (live) return live.usd;
  if (t.state === 'ended' && t.ended_by !== 'reaper' && !t.started_at) return 0; // stopped before it started
  const logged = loggedSpend(t);
  if (logged !== null) return logged;
  return typeof t.cap_usd === 'number' ? t.cap_usd : Infinity;
}

/**
 * The dollar cap for a Try's run: the Job's `cap_usd` (a repeating job without one: the per-fire default,
 * MWA_FIRE_CAP_USD) less what the Tries since the person last said go have spent — ended, reaped and still running
 * ones alike — so a job capped at 15¢ that ran out of steps at 11¢ continues automatically with 4¢, not another 15¢.
 * Undefined: no cap. 0: nothing is left to spend.
 */
export function runCapUsd(jobId: string, tryId: string | undefined, d: AppDb = appDb()): number | undefined {
  try {
    const job = getJob(jobId, d);
    if (!job) return undefined;
    const recurring = job.kind === 'recurring';
    const cap = job.cap_usd != null && job.cap_usd > 0 ? job.cap_usd : recurring ? fireCapUsd() : undefined;
    if (cap === undefined) return undefined;
    const tries = triesOf(jobId, d);
    const me = tryId ? tries.find((t) => t.id === tryId) : undefined;
    const upTo = me ? me.n : Infinity;
    const before = tries.filter((t) => t.n < upTo && t.ended_by !== 'duplicate');
    const auth = me && AUTHORISING.has(me.trigger) ? me : [...before].reverse().find((t) => AUTHORISING.has(t.trigger));
    // a repeating job's fire is its own go-ahead: earlier fires do not count against it
    const since = recurring && me?.trigger === 'fire' ? [] : before.filter((t) => t.state !== 'queued' && (!auth || t.n >= auth.n));
    const spent = since.reduce((s, t) => s + spendOf(t), 0);
    if (!Number.isFinite(spent)) return 0;
    let left = cap - spent;
    // ...unless it carries a total (a repeating follow-up of a capped run): all its fires together stay inside it
    if (job.cap_total_usd != null) {
      const all = before.filter((t) => t.state !== 'queued').reduce((s, t) => s + spendOf(t), 0);
      left = Math.min(left, Number.isFinite(all) ? job.cap_total_usd - all : 0);
    }
    return Math.max(0, Math.round(left * 1e6) / 1e6);
  } catch { return undefined; }
}

/** Record the allowance a Try's run was given (so a crash cannot hand the same allowance out twice). */
export function setTryAllowance(tryId: string, usd: number | undefined, d: AppDb = appDb()): void {
  try { d.prepare('UPDATE tries SET cap_usd = ? WHERE id = ?').run(usd ?? null, tryId); } catch { /* bookkeeping */ }
}

/** What one step of this job costs (the scheduler projects the first step with it, and the default limits use it). */
export function jobStepCost(jobId: string, d: AppDb = appDb()): StepCost | null {
  try { const job = getJob(jobId, d); return job ? stepCost(job, triesOf(jobId, d)) : null; } catch { return null; }
}

/**
 * The default limit for a run of this job (policy, review of A3b): room for the estimate twice over, or for it plus
 * three of the job's largest steps and the wrap-up, whichever is more; at least 25¢ (50¢ for a first guess); at most
 * $5 for a hand-off's first run and $20 for a Continue or Start over.
 */
export function defaultCapFor(job: JobRow, tries: TryRow[], which: 'first' | 'continue' | 'start-over', e: JobEstimate | null = estimateOf(job, tries)): number {
  const est = which === 'continue' ? (e?.continue?.usd ?? e?.startOver?.usd ?? 0) : (e?.startOver?.usd ?? 0);
  return defaultCapUsd(est, stepCost(job, tries), !e || firstGuess(e), which === 'first' ? HANDOFF_FIRST_MAX : CAP_MAX_USD);
}
const HANDOFF_FIRST_MAX = 5;
const d0 = () => appDb();

/**
 * The dollar side of a Try's run budget (the scheduler's): the allowance (runCapUsd), the expected cost of one step
 * (the first step is projected with it), and whether a last unit may finish past the cap. An allowance below one
 * step's worth — or 1¢, whichever is more — is no allowance (`wait`): the job waits for the person (review M4).
 */
export function fireBudget(jobId: string, tryId: string, d: AppDb = appDb()): { maxUsd?: number; stepUsd?: number; finishGrace?: boolean; wait: boolean; exhausted?: boolean } {
  const maxUsd = runCapUsd(jobId, tryId, d);
  if (maxUsd === undefined) return { wait: false };
  const step = jobStepCost(jobId, d);
  const stepUsd = step?.usd;
  // a repeating job whose total allowance is used up stops firing (the scheduler pauses it)
  if (maxUsd < Math.max(0.01, stepUsd ?? 0)) return { maxUsd, wait: true, ...(getJob(jobId, d)?.cap_total_usd != null ? { exhausted: true } : {}) };
  const tries = triesOf(jobId, d);
  const me = tries.find((t) => t.id === tryId);
  const last = [...tries].reverse().find((t) => t.state === 'ended' && t.progress_total != null && t.progress_done != null);
  const finishGrace = !!me && me.trigger !== 'first' && me.trigger !== 'start-over' && me.trigger !== 'fire' && !!last && (last.progress_total! - last.progress_done!) <= 1;
  return { maxUsd, ...(stepUsd ? { stepUsd } : {}), ...(finishGrace ? { finishGrace } : {}), wait: false };
}

// ── The scheduler's side ────────────────────────────────────────────────────────────────────────────────────────

/** A scheduled task's Job kind. */
export function kindOfTask(t: { recur?: string; kind?: string }): JobKind {
  return t.kind === 'reminder' ? 'reminder' : t.recur ? 'recurring' : 'background';
}
/** A one-off on a goal belongs to the goal's Job only when it IS the goal's own continuation (a hand-off or its
 *  Continue), not any follow-up the model scheduled under the goal (review). */
export function goalContinuation(t: { task?: string; instruction: string }): boolean {
  return /^Continue: /.test(t.task ?? '') || /^Continue working on the person's goal/.test(t.instruction) || /^The person asked for this in a chat and chose to have you work on it in the background/.test(t.instruction);
}
function jobForTask(d: AppDb, task: ScheduledTask): JobRow {
  const found = (task.v2job ? getJob(task.v2job, d) : undefined) ?? jobBySchedule(task.id, d)
    ?? (task.resumeOf ? jobByPrefix(task.resumeOf, d) : undefined)
    ?? (task.goal && !task.recur && task.kind !== 'reminder' && goalContinuation(task) ? jobByGoal(task.goal, d) : undefined);
  if (found) return found;
  return insertJob(d, { kind: kindOfTask(task), title: titleOf(task.request ?? task.task ?? task.instruction), request: task.request ?? task.task ?? task.instruction,
    person: task.person, scheduleId: task.id, legacyGoalId: !task.recur && goalContinuation(task) ? task.goal : undefined, session: task.notify, dir: task.dir,
    legacyKey: `sched:${task.id}`, status: task.paused ? 'paused' : 'active', ...(task.recur ? { nextDueAt: task.due } : {}) });
}

/**
 * The scheduler is about to run a task: claim its Try. The Try is the one v2 queued for it (`v2try=`), else the queued
 * Try linked to this task, else a new one on the task's Job — claimed in the same transaction. One fire, (task, due),
 * gets one Try for good: when any Try of this fire exists that was not reaped, the answer is 'taken' and the caller
 * does not run it (a second process with a stale task list; review H2). Null when app.db could not be used (the
 * caller runs anyway: bookkeeping never blocks the person's work).
 */
export function startFire(task: ScheduledTask, o: { liveKey: string; runId?: string; now: number }, d?: AppDb): { jobId: string; tryId: string; n: number } | 'taken' | null {
  try {
    const db = d ?? appDb();
    startHeartbeat();
    const out = db.transaction((): { jobId: string; tryId: string; n: number } | 'taken' => {
      const claim = (t: TryRow): { jobId: string; tryId: string; n: number } | 'taken' => {
        // another Try of this same fire (not reaped) means it is someone else's, or already done
        const other = db.prepare(`SELECT 1 FROM tries WHERE schedule_id = ? AND due_at = ? AND id != ? AND (ended_by IS NULL OR ended_by NOT IN ('reaper','duplicate'))`).get(task.id, task.due, t.id);
        if (other) return 'taken';
        const row = db.prepare(`UPDATE tries SET state = 'running', claimed_by = ?, started_at = ?, run_id = COALESCE(?, run_id), live_key = ?, schedule_id = ?, due_at = ?
          WHERE id = ? AND state = 'queued' RETURNING *`).get(CLAIMER, o.now, o.runId ?? null, o.liveKey, task.id, task.due, t.id) as TryRow | undefined;
        if (!row) return 'taken';
        bumpTry(db, row.id, row.job_id);
        return { jobId: row.job_id, tryId: row.id, n: row.n };
      };
      if (task.v2try) {
        const t = getTry(task.v2try, db);
        // a Try reaped from a dead claimer frees its fire: the task (still pending) gets a new Try below
        if (t && !(t.state === 'ended' && t.ended_by === 'reaper')) return t.state === 'queued' ? claim(t) : 'taken';
      }
      const queued = db.prepare(`SELECT * FROM tries WHERE schedule_id = ? AND state = 'queued' ORDER BY n LIMIT 1`).get(task.id) as TryRow | undefined;
      if (queued) return claim(queued);
      if (db.prepare(`SELECT 1 FROM tries WHERE schedule_id = ? AND due_at = ? AND (ended_by IS NULL OR ended_by NOT IN ('reaper','duplicate'))`).get(task.id, task.due)) return 'taken';
      const job = jobForTask(db, task);
      const hasEnded = !!db.prepare(`SELECT 1 FROM tries WHERE job_id = ? AND state = 'ended' LIMIT 1`).get(job.id);
      // this same fire's earlier Try was reaped (its process died before it finished): this run picks it up again
      const rerun = !!db.prepare(`SELECT 1 FROM tries WHERE schedule_id = ? AND due_at = ? AND ended_by = 'reaper'`).get(task.id, task.due);
      const trigger: TryTrigger = task.recur ? 'fire' : rerun || (task.resumeAttempt && /cut off by a restart/.test(task.instruction)) ? 'resume-after-restart'
        : task.resumeAttempt ? 'auto-continue' : hasEnded ? 'continue' : 'first';
      const t = insertTry(db, job.id, { trigger, state: 'queued', dueAt: task.due, scheduleId: task.id, liveKey: o.liveKey });
      return claim(t);
    }).immediate();
    if (out !== 'taken') stampEstimates(out.jobId, db);
    return out;
  } catch (e) {
    console.error('[v2] could not claim a try:', (e as Error).message.slice(0, 160));
    return null;
  }
}

/** What an AgentResult says, as a Try's end. */
export function tryEndFromResult(r: { reason?: string; outcome?: string; costUsd?: number; steps?: number; toolCalls?: number; summary?: string; progress?: { done: number; total: number; unit?: string }; remaining?: string; capHit?: string; tainted?: boolean; staged?: string[] }, extra: Partial<TryEnd> = {}): TryEnd {
  return { reason: r.reason, outcome: r.outcome, costUsd: r.costUsd, steps: r.steps, toolCalls: r.toolCalls, summary: r.summary, progress: r.progress,
    remaining: r.remaining, capHit: r.capHit, tainted: r.tainted, staged: r.staged, ...extra };
}

/** End a Try best-effort (never throws into the run that reports it). */
export function finishTry(tryId: string | undefined, e: TryEnd): void {
  if (!tryId) return;
  try { endTry(tryId, e); } catch (err) { console.error('[v2] could not end a try:', (err as Error).message.slice(0, 160)); }
}

/**
 * An automatic continuation (a run out of room queues a resume): a queued Try on the run's Job, created BEFORE its
 * scheduled task so the scheduler always finds it. A chat run has no Job yet — its work now outlives the request, so
 * one is made (kind `live`, or `plan` for a planned run) with the chat run itself as its first Try, which the run
 * ends when it returns (`created`).
 */
export function queueContinuation(o: {
  jobId?: string; dueAt: number; trigger?: TryTrigger;
  chat?: { kind: 'live' | 'plan'; title: string; request: string; person?: string; session?: string; dir?: string; runId?: string; startedAt: number };
}): { jobId: string; tryId: string; created?: { tryId: string } } | null {
  try {
    const d = appDb();
    return d.transaction(() => {
      let jobId = o.jobId && getJob(o.jobId, d) ? o.jobId : undefined;
      let created: { tryId: string } | undefined;
      if (!jobId && o.chat) {
        const job = insertJob(d, { kind: o.chat.kind, title: titleOf(o.chat.title), request: o.chat.request, person: o.chat.person, session: o.chat.session, dir: o.chat.dir });
        const first = insertTry(d, job.id, { trigger: 'first', state: 'running', liveKey: o.chat.session, runId: o.chat.runId, startedAt: o.chat.startedAt, claimedBy: CLAIMER });
        jobId = job.id; created = { tryId: first.id };
      }
      if (!jobId) return null;
      const t = insertTry(d, jobId, { trigger: o.trigger ?? 'auto-continue', state: 'queued', dueAt: o.dueAt });
      return { jobId, tryId: t.id, ...(created ? { created } : {}) };
    }).immediate();
  } catch (e) {
    console.error('[v2] could not queue a continuation:', (e as Error).message.slice(0, 160));
    return null;
  }
}

/**
 * Tries a dead process left `running` (a crash, a kill): ended "cut off", so nothing shows working forever and the
 * fire can be claimed again (review H1). Only Tries whose claimer is gone — never another live process's (M7).
 * Returns the reaped Tries. The scheduler calls this every tick and at start; serve at start.
 */
export function reapDeadTries(now = Date.now(), d: AppDb = appDb()): TryRow[] {
  try {
    const running = d.prepare(`SELECT * FROM tries WHERE state = 'running'`).all() as TryRow[];
    const alive = new Map<string, boolean>();
    const dead = running.filter((t) => {
      const c = t.claimed_by ?? '';
      if (!alive.has(c)) alive.set(c, claimerAlive(c, now));
      return !alive.get(c);
    });
    if (!dead.length) return [];
    d.transaction(() => {
      for (const t of dead) {
        d.prepare(`UPDATE tries SET state = 'ended', ended_at = ?, reason = 'error', outcome = 'could-not', summary = 'Cut off: the process running it stopped.', ended_by = 'reaper'
          WHERE id = ? AND state = 'running'`).run(now, t.id);
        bumpTry(d, t.id, t.job_id);
      }
    }).immediate();
    return dead;
  } catch (e) { console.error('[v2] could not reap tries:', (e as Error).message.slice(0, 160)); return []; }
}

/** A run cut off by a restart (its transcript was recovered): its Try ends if its claimer is dead — never a live
 *  process's Try of the same task (review M7) — and the Job is returned so the resume is a Try of it. */
export function restartCutOff(scheduleId: string, now = Date.now()): { jobId: string } | null {
  try {
    const d = appDb();
    return d.transaction(() => {
      const running = (d.prepare(`SELECT * FROM tries WHERE live_key = ? AND state = 'running'`).all(`job_${scheduleId}`) as TryRow[]).filter((t) => !claimerAlive(t.claimed_by, now));
      for (const t of running) {
        d.prepare(`UPDATE tries SET state = 'ended', ended_at = ?, reason = 'error', outcome = 'could-not', summary = 'Cut off by a restart.', ended_by = 'reaper' WHERE id = ?`).run(now, t.id);
        bumpTry(d, t.id, t.job_id);
      }
      const job = jobBySchedule(scheduleId, d);
      return job ? { jobId: job.id } : null;
    }).immediate();
  } catch { return null; }
}

// ── The store hooks: anything that schedules, pauses or notes a goal keeps app.db in step ────────────────────────

/** A scheduled task was written. */
export function onScheduled(id: string, instruction: string, dueMs: number, opts: ScheduleOpts, d: AppDb = appDb()): void {
  d.transaction(() => {
    if (opts.v2try) {
      const t = getTry(opts.v2try, d);
      if (t) {
        d.prepare('UPDATE tries SET schedule_id = ?, live_key = ?, due_at = COALESCE(due_at, ?) WHERE id = ?').run(id, `job_${id}`, dueMs, t.id);
        const job = getJob(t.job_id, d);
        if (job && !job.schedule_id && job.kind !== 'recurring') d.prepare('UPDATE jobs SET schedule_id = ? WHERE id = ?').run(id, job.id);
        bumpTry(d, t.id, t.job_id);
        return;
      }
    }
    if (jobBySchedule(id, d)) return; // already mapped (a dedupe returned the same task)
    const task = { id, instruction, ...opts };
    if (opts.resumeAttempt || opts.v2job) {
      const job = (opts.v2job ? getJob(opts.v2job, d) : undefined) ?? (opts.resumeOf ? jobByPrefix(opts.resumeOf, d) : undefined)
        ?? (opts.goal ? jobByGoal(opts.goal, d) : undefined) ?? insertJob(d, { kind: 'background', title: titleOf(opts.request ?? opts.task ?? instruction),
          request: opts.request ?? opts.task ?? instruction, person: opts.person, legacyGoalId: opts.goal, session: opts.notify, dir: opts.dir, legacyKey: `sched:${id}` });
      insertTry(d, job.id, { trigger: opts.resumeAttempt ? (/cut off by a restart/.test(instruction) ? 'resume-after-restart' : 'auto-continue') : 'continue', state: 'queued', dueAt: dueMs, scheduleId: id });
      return;
    }
    if (opts.recur || opts.kind === 'reminder') {
      const job = insertJob(d, { kind: kindOfTask(opts), title: titleOf(opts.request ?? opts.task ?? instruction), request: opts.request ?? opts.task ?? instruction,
        person: opts.person, scheduleId: id, session: opts.notify, dir: opts.dir, legacyKey: `sched:${id}`, ...(opts.recur ? { nextDueAt: dueMs } : {}) });
      if (!opts.recur) insertTry(d, job.id, { trigger: 'first', state: 'queued', dueAt: dueMs, scheduleId: id });
      return;
    }
    // A one-off: the goal's own continuation is a Try of the goal's Job; anything else is a Job of its own.
    const goalJob = opts.goal && goalContinuation(task) ? jobByGoal(opts.goal, d) : undefined;
    const job = goalJob ?? insertJob(d, { kind: 'background', title: titleOf(opts.request ?? opts.task ?? instruction), request: opts.request ?? opts.task ?? instruction,
      person: opts.person, scheduleId: id, legacyGoalId: opts.goal && goalContinuation(task) ? opts.goal : undefined, session: opts.notify, dir: opts.dir, legacyKey: `sched:${id}` });
    const hasTries = !!d.prepare('SELECT 1 FROM tries WHERE job_id = ? LIMIT 1').get(job.id);
    insertTry(d, job.id, { trigger: hasTries ? 'continue' : 'first', state: 'queued', dueAt: dueMs, scheduleId: id });
  }).immediate();
}

/** A scheduled task was paused, resumed, moved, cancelled or restored (the schedule controls, the model's tools). */
export function onScheduleChanged(id: string, change: 'paused' | 'resumed' | 'canceled' | 'uncanceled' | 'moved', due?: number, d: AppDb = appDb()): void {
  d.transaction(() => {
    const job = jobBySchedule(id, d);
    const queued = d.prepare(`SELECT * FROM tries WHERE schedule_id = ? AND state = 'queued'`).all(id) as TryRow[];
    // A queued Try waits on its task: when the task moves (rescheduled, edited, resumed), so does the Try (review M3).
    if ((change === 'moved' || change === 'resumed') && due != null) {
      for (const t of queued) { d.prepare('UPDATE tries SET due_at = ? WHERE id = ?').run(due, t.id); bumpTry(d, t.id, t.job_id); }
      if (job?.kind === 'recurring' && job.schedule_id === id) { d.prepare('UPDATE jobs SET next_due_at = ? WHERE id = ?').run(due, job.id); bumpJob(d, job.id); }
    }
    const who: EndedBy = byPerson() ? 'person' : 'self';
    // A cancelled task's queued Try will never run: it ends — by the person, or by the job itself (review M8).
    if (change === 'canceled') endQueuedRows(d, queued, who === 'person' ? 'person' : 'cancel', 'Cancelled before it started.');
    // Undo of a cancel: the Try it ended is queued again, so the restored task runs (review H3).
    if (change === 'uncanceled') {
      const back = d.prepare(`SELECT * FROM tries WHERE schedule_id = ? AND state = 'ended' AND ended_by IN ('person','cancel','self') ORDER BY n DESC LIMIT 1`).get(id) as TryRow | undefined;
      if (back) {
        d.prepare(`UPDATE tries SET state = 'queued', ended_at = NULL, reason = NULL, summary = NULL, ended_by = NULL WHERE id = ?`).run(back.id);
        bumpTry(d, back.id, back.job_id);
      }
    }
    if (!job) return;
    // The job's lifecycle follows the task that is its clock, or the task its next Try waits on.
    const clock = job.schedule_id === id || queued.length > 0 || change === 'uncanceled';
    if (!clock) return;
    const recurring = job.kind === 'recurring' || job.kind === 'reminder';
    const status: JobLifecycle | undefined = change === 'paused' ? 'paused'
      : change === 'canceled' ? (recurring ? 'cancelled' : undefined)
      : change === 'resumed' || change === 'uncanceled' ? 'active' : undefined;
    if (status && status !== job.status) {
      d.prepare('UPDATE jobs SET status = ?, stopped_by = ? WHERE id = ?').run(status, status === 'cancelled' ? who : null, job.id);
      bumpJob(d, job.id);
    }
  }).immediate();
}

/** Where a goal stands (goal_note, or a run's end) mirrors onto the goal's Job, with its trust. */
export function onGoalRecord(goalId: string, rec: { state: string; next?: string; untrusted?: boolean }, d: AppDb = appDb()): void {
  d.transaction(() => {
    const jobs = d.prepare('SELECT id FROM jobs WHERE legacy_goal_id = ?').all(goalId) as { id: string }[];
    const text = [rec.state.replace(/\s+/g, ' ').trim().slice(0, 700), rec.next ? `Next: ${rec.next.replace(/\s+/g, ' ').trim().slice(0, 300)}` : ''].filter(Boolean).join(' ');
    for (const j of jobs) {
      d.prepare('UPDATE jobs SET where_it_stands = ?, stands_trust = ? WHERE id = ?').run(text, rec.untrusted ? 'untrusted' : 'high', j.id);
      bumpJob(d, j.id);
    }
  }).immediate();
}
/** A goal marked done: who did it — the person in the app, or the model's own tool (review M8). */
export function onGoalStatus(goalId: string, status: GoalStatus, d: AppDb = appDb()): void {
  d.transaction(() => {
    const jobs = d.prepare('SELECT id FROM jobs WHERE legacy_goal_id = ?').all(goalId) as { id: string }[];
    for (const j of jobs) {
      d.prepare('UPDATE jobs SET stopped_by = ? WHERE id = ?').run(status === 'done' ? (byPerson() ? 'person' : 'self') : null, j.id);
      bumpJob(d, j.id);
    }
  }).immediate();
}

storeHooks.scheduled = (id, instruction, due, opts) => {
  onScheduled(id, instruction, due, opts);
  const job = jobBySchedule(id);
  if (!job) return;
  // A one-off follow-up scheduled by a run that has a dollar cap carries what is left of that run's allowance as its
  // own cap (review of A3b, M6): otherwise "schedule the rest for later" would be a way around the person's limit.
  // A separate Job, not a Try of the same one: the follow-up is new work with its own time and words, and the person
  // sees, stops or continues it on its own; linking it would make the capped job look "working" until it fires.
  //
  // Review of A3b (HIGH): the allowance is RESERVED, not copied — half of what is left (after one call's worth kept
  // for the run's own wrap-up) moves to the follow-up and out of the run's cap, so a run and all its follow-ups
  // together can never be authorised past the run's cap. A repeating follow-up gets a per-fire limit of
  // min(the default fire limit, its share) and its share as a TOTAL: it stops firing (paused) once that is spent.
  // (The alternative — sending repeating follow-ups of a capped run to the person for approval — would make every
  // "check this again tomorrow" a card to tap; a bounded total keeps the limit without the interruption.)
  if (!opts.resumeAttempt && !opts.v2try && opts.kind !== 'reminder' && job.cap_usd == null && (!opts.recur || job.schedule_id === id)) {
    const l = spendLedger.getStore();
    const share = reserveForFollowUp(l, l && l.calls ? l.usd / l.calls : 0.01);
    if (share !== undefined) {
      const cap = Math.max(0.0001, share);
      if (opts.recur) d0().prepare('UPDATE jobs SET cap_total_usd = ? WHERE id = ?').run(cap, job.id);
      updateJob(job.id, { cap_usd: opts.recur ? Math.max(0.0001, Math.min(fireCapUsd() ?? cap, cap)) : cap });
    }
  }
  stampEstimates(job.id);
};
storeHooks.scheduleChanged = (id, change, due) => onScheduleChanged(id, change, due);
storeHooks.goalRecord = (goalId, rec) => onGoalRecord(goalId, rec);
storeHooks.goalStatus = (goalId, status) => onGoalStatus(goalId, status);

// ── Whose jobs (review M10) ─────────────────────────────────────────────────────────────────────────────────────
// MWA has one owner (standing decision). The password session and this machine ARE the owner; a paired device acts
// for the owner. The owner's jobs are the ones with no person, the shared `unknown` profile, the web app's people
// (`web-…`) and any id in MWA_OWNER_PERSON (comma-separated; e.g. the owner's own Telegram id). Other people's jobs —
// a Telegram contact's — are not shown or acted on through /api/v1.

export function ownerIds(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(String(env.MWA_OWNER_PERSON ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}
export function ownerOwns(person: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!person || person === 'unknown' || person.startsWith('web-')) return true;
  return ownerIds(env).has(person.toLowerCase());
}

// ── Reading a Job with its status ───────────────────────────────────────────────────────────────────────────────

export interface JobView { job: JobRow; tries: TryRow[]; status: JobStatus; estimate: JobEstimate | null; caps: { continue?: number; startOver?: number } }
export interface ViewCtx { running: Set<string>; pending: Set<string>; now?: number }

function statusOf(job: JobRow, tries: TryRow[], ctx: ViewCtx, estimate: JobEstimate | null): JobStatus {
  const staged = tries.flatMap((t) => { try { return t.staged ? (JSON.parse(t.staged) as string[]) : []; } catch { return []; } });
  const pendingApprovals = staged.filter((s) => ctx.pending.has(s)).length;
  const alive = new Map<string, boolean>();
  const claimerAliveCached = (c: string) => { if (!alive.has(c)) alive.set(c, claimerAlive(c, ctx.now)); return alive.get(c)!; };
  const caps = estimate ? capsOf(job, tries, estimate) : {};
  return jobStatus(job, tries, { running: ctx.running, pendingApprovals, now: ctx.now, claimerAlive: claimerAliveCached,
    ...(estimate ? { estimates: { ...estimate, continueCap: caps.continue, startOverCap: caps.startOver } } : {}) });
}
/** The limits a Continue and a Start over would get by default (shown on their buttons: "up to 40¢"). */
function capsOf(job: JobRow, tries: TryRow[], e: JobEstimate): { continue?: number; startOver?: number } {
  try { return { continue: defaultCapFor(job, tries, 'continue', e), startOver: defaultCapFor(job, tries, 'start-over', e) }; } catch { return {}; }
}
/** A Job's estimates (null for a repeating job, or when they cannot be made). */
function estimateOf(job: JobRow, tries: TryRow[]): JobEstimate | null {
  if (job.kind === 'recurring' || job.kind === 'reminder') return null;
  try { return estimateJob(job, tries); } catch { return null; }
}
/** A Job, its Tries and its status. `running`: the live keys of runs going now; `pending`: approvals still waiting. */
export function viewJob(job: JobRow, ctx: ViewCtx, d: AppDb = appDb()): JobView {
  const tries = triesOf(job.id, d);
  const estimate = estimateOf(job, tries);
  return { job, tries, status: statusOf(job, tries, ctx, estimate), estimate, caps: estimate ? capsOf(job, tries, estimate) : {} };
}
/** Many Jobs at once: one query for all their Tries (no N+1). */
export function viewJobs(jobs: JobRow[], ctx: ViewCtx, d: AppDb = appDb()): JobView[] {
  if (!jobs.length) return [];
  const byJob = new Map<string, TryRow[]>(jobs.map((j) => [j.id, []]));
  const ids = jobs.map((j) => j.id);
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const t of d.prepare(`SELECT * FROM tries WHERE job_id IN (${chunk.map(() => '?').join(',')}) ORDER BY job_id, n`).all(...chunk) as TryRow[]) byJob.get(t.job_id)!.push(t);
  }
  return jobs.map((job) => { const tries = byJob.get(job.id) ?? []; const estimate = estimateOf(job, tries); return { job, tries, status: statusOf(job, tries, ctx, estimate), estimate, caps: estimate ? capsOf(job, tries, estimate) : {} }; });
}
