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
 *     from the task's own lineage: `resumeof=`, its goal, or a new Job.
 *
 * Every write bumps `updated_seq` through recordEvent in the same transaction (the sync cursor, slice A4).
 */
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { appDb, registerMigrations, recordEvent, type AppDb, type Migration } from './db.js';
import { storeHooks, type ScheduleOpts, type ScheduledTask } from '../awm.js';
import { jobStatus, type JobStatus } from './status.js';

export type JobKind = 'background' | 'recurring' | 'reminder' | 'plan' | 'live';
export type TryTrigger = 'first' | 'auto-continue' | 'continue' | 'start-over' | 'fire' | 'resume-after-restart';
export type TryState = 'queued' | 'running' | 'ended';
export type JobLifecycle = 'active' | 'paused' | 'cancelled';

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
registerMigrations([JOBS_MIGRATION]);

export interface JobRow {
  id: string; project_id: string | null; kind: JobKind; title: string; request: string | null; person: string | null;
  created_at: number; updated_seq: number; schedule_id: string | null; legacy_goal_id: string | null;
  cap_usd: number | null; model_tier: string | null; progress_done: number | null; progress_total: number | null;
  progress_unit: string | null; remaining: string | null; where_it_stands: string | null; stands_trust: string | null;
  result_ref: string | null; seen_at: number | null; status: JobLifecycle; archived: number;
  session: string | null; dir: string | null; legacy_key: string | null;
}
export interface TryRow {
  id: string; job_id: string; n: number; trigger: TryTrigger; run_id: string | null; live_key: string | null;
  state: TryState; due_at: number | null; claimed_by: string | null; started_at: number | null; ended_at: number | null;
  reason: string | null; outcome: string | null; progress_done: number | null; progress_total: number | null;
  progress_unit: string | null; remaining: string | null; cost_usd: number | null; steps: number | null;
  tool_calls: number | null; cap_hit: string | null; summary: string | null; tainted: number; staged: string | null;
  est_usd: number | null; est_ms: number | null; updated_seq: number; schedule_id: string | null;
  pages_read: number | null; legacy_key: string | null;
}

export interface NewJob {
  kind: JobKind; title: string; request?: string; person?: string; createdAt?: number; scheduleId?: string;
  legacyGoalId?: string; capUsd?: number; session?: string; dir?: string; legacyKey?: string; status?: JobLifecycle;
  whereItStands?: string; standsTrust?: string;
}
export interface NewTry {
  trigger: TryTrigger; state?: TryState; dueAt?: number; scheduleId?: string; liveKey?: string; runId?: string;
  startedAt?: number; claimedBy?: string; legacyKey?: string;
}
/** What a run reports at its end (from AgentResult, or a migrated notification). */
export interface TryEnd {
  reason?: string; outcome?: string; costUsd?: number; steps?: number; toolCalls?: number; summary?: string;
  progress?: { done: number; total: number; unit?: string }; remaining?: string; capHit?: string; tainted?: boolean;
  staged?: string[]; pagesRead?: number; endedAt?: number; startedAt?: number; runId?: string;
}

/** Who claims a Try: this process (serve and the Telegram process share app.db). */
export const CLAIMER = `${hostname()}:${process.pid}:${Date.now().toString(36)}`;

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
export function listJobs(o: { archived?: boolean } = {}, d: AppDb = appDb()): JobRow[] {
  return d.prepare(`SELECT * FROM jobs ${o.archived ? '' : 'WHERE archived = 0'} ORDER BY updated_seq DESC`).all() as JobRow[];
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
 *  starts with it. */
export function jobByPrefix(prefix: string, d: AppDb = appDb()): JobRow | undefined {
  const p = String(prefix ?? '').slice(0, 8);
  if (p.length < 4 || /[%_]/.test(p)) return undefined;
  return (d.prepare(`SELECT * FROM jobs WHERE schedule_id LIKE ? OR legacy_key LIKE ? ORDER BY created_at LIMIT 1`).get(`${p}%`, `sched:${p}%`) as JobRow | undefined)
    ?? (d.prepare('SELECT j.* FROM jobs j JOIN tries t ON t.job_id = j.id WHERE t.schedule_id LIKE ? ORDER BY t.n LIMIT 1').get(`${p}%`) as JobRow | undefined);
}

function insertJob(d: AppDb, j: NewJob): JobRow {
  const id = newId('j');
  d.prepare(`INSERT INTO jobs (id, kind, title, request, person, created_at, schedule_id, legacy_goal_id, cap_usd, session, dir, legacy_key, status, where_it_stands, stands_trust)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, j.kind, j.title.slice(0, 300), j.request?.slice(0, 4000) ?? null, j.person ?? null,
    j.createdAt ?? Date.now(), j.scheduleId ?? null, j.legacyGoalId ?? null, j.capUsd ?? null, j.session ?? null, j.dir ?? null,
    j.legacyKey ?? null, j.status ?? 'active', j.whereItStands ?? null, j.standsTrust ?? null);
  bumpJob(d, id, j.person);
  return getJob(id, d)!;
}
function insertTry(d: AppDb, jobId: string, t: NewTry): TryRow {
  const id = newId('t');
  const n = ((d.prepare('SELECT MAX(n) m FROM tries WHERE job_id = ?').get(jobId) as { m: number | null }).m ?? 0) + 1;
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
}

/** Claim a queued Try for this process: `UPDATE … WHERE state='queued' RETURNING`. Null when someone else has it. */
export function claimTry(tryId: string, c: { runId?: string; liveKey?: string; scheduleId?: string; now?: number; claimedBy?: string }, d: AppDb = appDb()): TryRow | null {
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
    d.prepare(`UPDATE tries SET state = 'ended', ended_at = ?, started_at = COALESCE(started_at, ?), run_id = COALESCE(?, run_id), reason = ?, outcome = ?, cost_usd = ?, steps = ?, tool_calls = ?,
      progress_done = ?, progress_total = ?, progress_unit = ?, remaining = ?, cap_hit = ?, summary = ?, tainted = ?, staged = ?, pages_read = ? WHERE id = ?`)
      .run(ended, e.startedAt ?? null, e.runId ?? null, e.reason ?? null, e.outcome ?? null, finite(e.costUsd), finite(e.steps), finite(e.toolCalls),
        p ? p.done : null, p ? p.total : null, p ? clampText(p.unit, 40) : null, clampText(e.remaining, 400), e.capHit ?? null,
        e.summary ? String(e.summary).slice(0, 4000) : null, e.tainted ? 1 : 0, e.staged?.length ? JSON.stringify(e.staged.slice(0, 50)) : null, finite(e.pagesRead), tryId);
    // The Job shows the latest word: this Try's progress and what it left (none said = none known now).
    d.prepare('UPDATE jobs SET progress_done = ?, progress_total = ?, progress_unit = COALESCE(?, progress_unit), remaining = ? WHERE id = ?')
      .run(p ? p.done : null, p ? p.total : null, p ? clampText(p.unit, 40) : null, clampText(e.remaining, 400), t.job_id);
    bumpTry(d, tryId, t.job_id);
    return getTry(tryId, d)!;
  }).immediate();
}

/** End every queued Try of a Job (the person's Stop, a cancel). Returns the schedule ids they were waiting on. */
export function endQueued(jobId: string, reason: 'stopped' | 'error', summary: string, d: AppDb = appDb()): string[] {
  return d.transaction(() => {
    const q = d.prepare(`SELECT * FROM tries WHERE job_id = ? AND state = 'queued'`).all(jobId) as TryRow[];
    for (const t of q) {
      d.prepare(`UPDATE tries SET state = 'ended', ended_at = ?, reason = ?, outcome = ?, summary = ? WHERE id = ?`).run(Date.now(), reason, reason === 'stopped' ? null : 'could-not', summary, t.id);
      bumpTry(d, t.id, jobId);
    }
    return q.map((t) => t.schedule_id).filter((x): x is string => !!x);
  }).immediate();
}

/** End the queued Tries waiting on one scheduled task (its goal finished, so it will not run). Best-effort. */
export function endScheduleTries(scheduleId: string, reason: 'stopped' | 'error', summary: string): void {
  try {
    const d = appDb();
    d.transaction(() => {
      const q = d.prepare(`SELECT * FROM tries WHERE schedule_id = ? AND state = 'queued'`).all(scheduleId) as TryRow[];
      for (const t of q) {
        d.prepare(`UPDATE tries SET state = 'ended', ended_at = ?, reason = ?, summary = ? WHERE id = ?`).run(Date.now(), reason, summary, t.id);
        bumpTry(d, t.id, t.job_id);
      }
    }).immediate();
  } catch { /* bookkeeping never blocks the scheduler */ }
}
/** A queued Try whose task was put off (the monthly budget, a paused goal) is due when the task is. Best-effort. */
export function deferScheduleTries(scheduleId: string, dueAt: number): void {
  try {
    const d = appDb();
    d.transaction(() => {
      const q = d.prepare(`SELECT * FROM tries WHERE schedule_id = ? AND state = 'queued'`).all(scheduleId) as TryRow[];
      for (const t of q) {
        d.prepare('UPDATE tries SET due_at = ? WHERE id = ?').run(Math.round(dueAt), t.id);
        bumpTry(d, t.id, t.job_id);
      }
    }).immediate();
  } catch { /* bookkeeping never blocks the scheduler */ }
}

/** Set some of a Job's own fields (seen_at, lifecycle, where it stands…). */
export function updateJob(jobId: string, f: Partial<Pick<JobRow, 'seen_at' | 'status' | 'where_it_stands' | 'stands_trust' | 'archived' | 'schedule_id' | 'session' | 'dir' | 'result_ref' | 'cap_usd'>>, d: AppDb = appDb()): JobRow | undefined {
  const keys = Object.keys(f).filter((k) => (f as Record<string, unknown>)[k] !== undefined);
  if (!keys.length) return getJob(jobId, d);
  return d.transaction(() => {
    d.prepare(`UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => (f as Record<string, unknown>)[k]), jobId);
    bumpJob(d, jobId);
    return getJob(jobId, d);
  }).immediate();
}

// ── The scheduler's side ────────────────────────────────────────────────────────────────────────────────────────

/** A scheduled task's Job kind. */
export function kindOfTask(t: { recur?: string; kind?: string }): JobKind {
  return t.kind === 'reminder' ? 'reminder' : t.recur ? 'recurring' : 'background';
}
function jobForTask(d: AppDb, task: ScheduledTask): JobRow {
  const found = (task.v2job ? getJob(task.v2job, d) : undefined) ?? jobBySchedule(task.id, d)
    ?? (task.resumeOf ? jobByPrefix(task.resumeOf, d) : undefined)
    ?? (task.goal && !task.recur && task.kind !== 'reminder' ? jobByGoal(task.goal, d) : undefined);
  if (found) return found;
  return insertJob(d, { kind: kindOfTask(task), title: titleOf(task.request ?? task.task ?? task.instruction), request: task.request ?? task.task ?? task.instruction,
    person: task.person, scheduleId: task.id, legacyGoalId: !task.recur ? task.goal : undefined, session: task.notify, dir: task.dir,
    legacyKey: `sched:${task.id}`, status: task.paused ? 'paused' : 'active' });
}

/**
 * The scheduler is about to run a task: claim its Try. The Try is the one v2 queued for it (`v2try=`), else the queued
 * Try linked to this task, else a new one on the task's Job — claimed in the same transaction. Returns 'taken' when
 * another process already claimed this fire (the caller does not run it), or null when app.db could not be used
 * (the caller runs anyway: bookkeeping never blocks the person's work).
 */
export function startFire(task: ScheduledTask, o: { liveKey: string; runId?: string; now: number }, d?: AppDb): { jobId: string; tryId: string; n: number } | 'taken' | null {
  try {
    const db = d ?? appDb();
    return db.transaction((): { jobId: string; tryId: string; n: number } | 'taken' => {
      const claim = (t: TryRow): { jobId: string; tryId: string; n: number } | 'taken' => {
        const row = db.prepare(`UPDATE tries SET state = 'running', claimed_by = ?, started_at = ?, run_id = COALESCE(?, run_id), live_key = ?, schedule_id = ?
          WHERE id = ? AND state = 'queued' RETURNING *`).get(CLAIMER, o.now, o.runId ?? null, o.liveKey, task.id, t.id) as TryRow | undefined;
        if (!row) return 'taken';
        bumpTry(db, row.id, row.job_id);
        return { jobId: row.job_id, tryId: row.id, n: row.n };
      };
      if (task.v2try) {
        const t = getTry(task.v2try, db);
        if (t) return t.state === 'queued' ? claim(t) : 'taken';
      }
      const queued = db.prepare(`SELECT * FROM tries WHERE schedule_id = ? AND state = 'queued' ORDER BY n LIMIT 1`).get(task.id) as TryRow | undefined;
      if (queued) return claim(queued);
      if (db.prepare(`SELECT 1 FROM tries WHERE schedule_id = ? AND due_at = ? AND state = 'running'`).get(task.id, task.due)) return 'taken';
      const job = jobForTask(db, task);
      const hasEnded = !!db.prepare(`SELECT 1 FROM tries WHERE job_id = ? AND state = 'ended' LIMIT 1`).get(job.id);
      const trigger: TryTrigger = task.resumeAttempt ? (/cut off by a restart/.test(task.instruction) ? 'resume-after-restart' : 'auto-continue')
        : task.recur ? 'fire' : hasEnded ? 'continue' : 'first';
      const t = insertTry(db, job.id, { trigger, state: 'queued', dueAt: task.due, scheduleId: task.id, liveKey: o.liveKey });
      return claim(t);
    }).immediate();
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

/** A run cut off by a restart: its running Try ends, and a resume (when one is queued) is a Try of the same Job. */
export function restartCutOff(scheduleId: string, now = Date.now()): { jobId: string } | null {
  try {
    const d = appDb();
    return d.transaction(() => {
      const running = d.prepare(`SELECT * FROM tries WHERE live_key = ? AND state = 'running'`).all(`job_${scheduleId}`) as TryRow[];
      for (const t of running) {
        d.prepare(`UPDATE tries SET state = 'ended', ended_at = ?, reason = 'error', outcome = 'could-not', summary = 'Cut off by a restart.' WHERE id = ?`).run(now, t.id);
        bumpTry(d, t.id, t.job_id);
      }
      const job = running[0] ? getJob(running[0].job_id, d) : jobBySchedule(scheduleId, d);
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
    const task = { id, instruction, due: dueMs, ...opts } as ScheduledTask;
    if (opts.resumeAttempt || opts.v2job) {
      const job = (opts.v2job ? getJob(opts.v2job, d) : undefined) ?? (opts.resumeOf ? jobByPrefix(opts.resumeOf, d) : undefined)
        ?? (opts.goal ? jobByGoal(opts.goal, d) : undefined) ?? insertJob(d, { kind: 'background', title: titleOf(opts.request ?? opts.task ?? instruction),
          request: opts.request ?? opts.task ?? instruction, person: opts.person, legacyGoalId: opts.goal, session: opts.notify, dir: opts.dir, legacyKey: `sched:${id}` });
      insertTry(d, job.id, { trigger: opts.resumeAttempt ? (/cut off by a restart/.test(instruction) ? 'resume-after-restart' : 'auto-continue') : 'continue', state: 'queued', dueAt: dueMs, scheduleId: id });
      return;
    }
    if (opts.recur || opts.kind === 'reminder') {
      const job = insertJob(d, { kind: kindOfTask(opts), title: titleOf(opts.request ?? opts.task ?? instruction), request: opts.request ?? opts.task ?? instruction,
        person: opts.person, scheduleId: id, session: opts.notify, dir: opts.dir, legacyKey: `sched:${id}` });
      if (!opts.recur) insertTry(d, job.id, { trigger: 'first', state: 'queued', dueAt: dueMs, scheduleId: id });
      return;
    }
    // A one-off: work for a goal is a Try of the goal's Job; anything else is a Job of its own.
    const goalJob = opts.goal ? jobByGoal(opts.goal, d) : undefined;
    const job = goalJob ?? insertJob(d, { kind: 'background', title: titleOf(opts.request ?? opts.task ?? instruction), request: opts.request ?? opts.task ?? instruction,
      person: opts.person, scheduleId: id, legacyGoalId: opts.goal, session: opts.notify, dir: opts.dir, legacyKey: `sched:${id}` });
    const hasTries = !!d.prepare('SELECT 1 FROM tries WHERE job_id = ? LIMIT 1').get(job.id);
    insertTry(d, job.id, { trigger: hasTries ? 'continue' : 'first', state: 'queued', dueAt: dueMs, scheduleId: id });
    void task;
  }).immediate();
}

/** A scheduled task was paused, resumed, cancelled or restored (the schedule controls, the model's tools). */
export function onScheduleChanged(id: string, change: 'paused' | 'resumed' | 'canceled' | 'uncanceled', d: AppDb = appDb()): void {
  d.transaction(() => {
    const job = d.prepare('SELECT * FROM jobs WHERE schedule_id = ? OR legacy_key = ?').get(id, `sched:${id}`) as JobRow | undefined;
    // A cancelled task's queued Try will never run: it ends, stopped.
    if (change === 'canceled') {
      const q = d.prepare(`SELECT * FROM tries WHERE schedule_id = ? AND state = 'queued'`).all(id) as TryRow[];
      for (const t of q) {
        d.prepare(`UPDATE tries SET state = 'ended', ended_at = ?, reason = 'stopped', summary = 'Cancelled before it started.' WHERE id = ?`).run(Date.now(), t.id);
        bumpTry(d, t.id, t.job_id);
      }
    }
    if (!job) return;
    // Only a job this task is the clock of changes its lifecycle (a recurring job, a reminder, a pending one-off).
    const status: JobLifecycle | undefined = change === 'paused' ? 'paused' : change === 'canceled' ? (job.kind === 'recurring' || job.kind === 'reminder' ? 'cancelled' : undefined) : 'active';
    if (status && status !== job.status) {
      d.prepare('UPDATE jobs SET status = ? WHERE id = ?').run(status, job.id);
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

storeHooks.scheduled = (id, instruction, due, opts) => onScheduled(id, instruction, due, opts);
storeHooks.scheduleChanged = (id, change) => onScheduleChanged(id, change);
storeHooks.goalRecord = (goalId, rec) => onGoalRecord(goalId, rec);

// ── Reading a Job with its status ───────────────────────────────────────────────────────────────────────────────

export interface JobView { job: JobRow; tries: TryRow[]; status: JobStatus }

/** A Job, its Tries and its status. `running`: the live keys of runs going now; `pending`: approvals still waiting. */
export function viewJob(job: JobRow, ctx: { running: Set<string>; pending: Set<string>; now?: number }, d: AppDb = appDb()): JobView {
  const tries = triesOf(job.id, d);
  const staged = tries.flatMap((t) => { try { return t.staged ? (JSON.parse(t.staged) as string[]) : []; } catch { return []; } });
  const pendingApprovals = staged.filter((s) => ctx.pending.has(s)).length;
  return { job, tries, status: jobStatus(job, tries, { running: ctx.running, pendingApprovals, now: ctx.now }) };
}
