/**
 * v2 slice A3a: existing work becomes Jobs and Tries (`mwa migrate-v2 [--dry-run]`, and once on first start).
 *
 *   goals                                    → Jobs (kind background), with where they stand
 *   pending recurring tasks (and reminders)  → Jobs of kind recurring / reminder
 *   notifications.jsonl lines with job+fire  → ended Tries, enriched from the runs.jsonl row of the same run
 *   pending one-off tasks                    → a queued Try (of the goal's Job when they work on a goal)
 *   tasks with resume=                       → a queued auto-continue Try of the Job their `resumeof=` names
 *   a done or paused goal that never ran here → one ended Try saying so (from the goal's own status)
 *
 * Lossless: nothing it reads is changed (the memory store, notifications.jsonl and runs.jsonl stay as they are).
 * Idempotent: every Job and Try it makes carries a legacy key (goal:<id>, sched:<id>, fire:<id>), so a second run
 * finds them and changes nothing. A dry run does the whole migration inside a transaction and rolls it back, so the
 * counts it prints are the ones a real run would produce. Conversations are not migrated here (slice A5).
 */
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { appDb, type AppDb } from './db.js';
import { createJob, jobByGoal, jobByPrefix, jobBySchedule, titleOf, type JobKind, type JobRow, type TryTrigger } from './jobs.js';
import { recordEvent } from './db.js';
import type { Goal, GoalRecord, ScheduledTask } from '../awm.js';

export const DATA_MIGRATION = 'data-002-jobs';

/** What the migration reads from the memory store (MwaMemory, or a fixture). */
export interface MigrateMemory {
  listGoals(): Promise<Goal[]>;
  listGoalRecords(): Promise<GoalRecord[]>;
  pendingScheduled(): Promise<ScheduledTask[]>;
  getScheduled(id: string): Promise<{ id: string; status: string; person?: string; instruction: string; recur?: string; due: number; goal?: string; notify?: string; dir?: string; kind?: 'reminder'; task?: string; request?: string } | null>;
}

export interface MigrateReport {
  dryRun: boolean;
  jobs: { goals: number; recurring: number; reminders: number; oneOff: number; fromResults: number; orphanResumes: number };
  tries: { ended: number; enriched: number; queued: number; resumes: number; fromGoalStatus: number };
  /** already migrated: legacy keys that were there before this run */
  skipped: number;
  /** notification lines without a job and fire (inbox runs, interruptions): not Tries */
  ignoredLines: number;
  orphans: { kind: 'resume' | 'result'; id: string; why: string }[];
}

type Notif = { ts: number; job?: string; fire?: string; instruction?: string; summary?: string; reason?: string; outcome?: string; steps?: number; toolCalls?: number; costUsd?: number; durationMs?: number; title?: string; session?: string; dir?: string };
type RunRow = { ts: number; job?: string; instruction?: string; reason?: string; outcome?: string; steps?: number; toolCalls?: number; costUsd?: number; durationMs?: number; pagesRead?: number; summary?: string };

function readJsonl<T>(file?: string): T[] {
  if (!file || !existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { try { return JSON.parse(l) as T; } catch { return null; } }).filter((x): x is T => x !== null);
}

class Rollback extends Error {}

/** The runs.jsonl row of the same run as a notification: the same job (or the same instruction), ending when it fired. */
function runFor(n: Notif, runs: RunRow[]): RunRow | undefined {
  const j8 = String(n.job ?? '').slice(0, 8);
  const inst = String(n.instruction ?? '').slice(0, 60);
  let best: RunRow | undefined; let gap = Infinity;
  for (const r of runs) {
    const sameJob = !!r.job && (r.job === n.job || r.job.slice(0, 8) === j8);
    const sameWords = !!inst && String(r.instruction ?? '').slice(0, 60) === inst;
    if (!sameJob && !sameWords) continue;
    const end = Number(r.ts) + Number(r.durationMs ?? 0);
    const g = Math.abs(end - Number(n.ts));
    if (g <= 10 * 60_000 && g < gap) { best = r; gap = g; }
  }
  return best;
}

export async function migrateV2(memory: MigrateMemory, o: { notifyFile?: string; runsFile?: string; dryRun?: boolean; record?: boolean; d?: AppDb } = {}): Promise<MigrateReport> {
  const d = o.d ?? appDb();
  // Everything async is read first: a SQLite transaction cannot wait on the memory store.
  const [goals, records, pending] = await Promise.all([memory.listGoals(), memory.listGoalRecords(), memory.pendingScheduled()]);
  const notifs = readJsonl<Notif>(o.notifyFile);
  const runs = readJsonl<RunRow>(o.runsFile);
  const withJob = notifs.filter((n) => n.job && n.fire);
  const groups = new Map<string, Notif[]>();
  for (const n of withJob) { const k = String(n.job).slice(0, 8); groups.set(k, [...(groups.get(k) ?? []), n]); }
  const fullIdOf = (g: Notif[]) => g.map((n) => String(n.job)).find((j) => j.length > 8);
  const scheduled = new Map<string, Awaited<ReturnType<MigrateMemory['getScheduled']>>>();
  for (const g of groups.values()) { const id = fullIdOf(g); if (id && !pending.some((t) => t.id === id)) scheduled.set(id, await memory.getScheduled(id).catch(() => null)); }

  const report: MigrateReport = { dryRun: o.dryRun === true, jobs: { goals: 0, recurring: 0, reminders: 0, oneOff: 0, fromResults: 0, orphanResumes: 0 },
    tries: { ended: 0, enriched: 0, queued: 0, resumes: 0, fromGoalStatus: 0 }, skipped: 0, ignoredLines: notifs.length - withJob.length, orphans: [] };

  const keyExists = (table: 'jobs' | 'tries', key: string) => !!d.prepare(`SELECT 1 FROM ${table} WHERE legacy_key = ?`).get(key);
  const bump = (jobId: string) => { const seq = recordEvent({ entity: 'job', id: jobId }, d); d.prepare('UPDATE jobs SET updated_seq = ? WHERE id = ?').run(seq, jobId); };
  const nextN = (jobId: string) => ((d.prepare('SELECT MAX(n) m FROM tries WHERE job_id = ?').get(jobId) as { m: number | null }).m ?? 0) + 1;
  const tryId = () => `t_${randomBytes(8).toString('hex')}`;
  /** a Job with a legacy key: made, or found (counted as skipped) */
  const job = (key: string, make: Parameters<typeof createJob>[0], count?: () => void): JobRow => {
    const had = d.prepare('SELECT * FROM jobs WHERE legacy_key = ?').get(key) as JobRow | undefined;
    if (had) { report.skipped++; return had; }
    count?.();
    return createJob({ ...make, legacyKey: key }, undefined, d).job;
  };
  const insertTry = (jobId: string, t: { key: string; trigger: TryTrigger; state: 'queued' | 'ended'; dueAt?: number | null; scheduleId?: string | null; startedAt?: number | null; endedAt?: number | null;
    reason?: string | null; outcome?: string | null; costUsd?: number | null; steps?: number | null; toolCalls?: number | null; summary?: string | null; pagesRead?: number | null }) => {
    const id = tryId();
    d.prepare(`INSERT INTO tries (id, job_id, n, trigger, state, due_at, schedule_id, live_key, started_at, ended_at, reason, outcome, cost_usd, steps, tool_calls, summary, pages_read, legacy_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, jobId, nextN(jobId), t.trigger, t.state, t.dueAt ?? null, t.scheduleId ?? null, t.scheduleId ? `job_${t.scheduleId}` : null,
      t.startedAt ?? null, t.endedAt ?? null, t.reason ?? null, t.outcome ?? null, t.costUsd ?? null, t.steps ?? null, t.toolCalls ?? null, t.summary ? t.summary.slice(0, 4000) : null, t.pagesRead ?? null, t.key);
    const seq = recordEvent({ entity: 'try', id, payload: { job: jobId } }, d);
    d.prepare('UPDATE tries SET updated_seq = ? WHERE id = ?').run(seq, id);
    bump(jobId);
    return id;
  };
  const taskKind = (t: { recur?: string; kind?: string }): JobKind => (t.kind === 'reminder' ? 'reminder' : t.recur ? 'recurring' : 'background');
  const words = (t: { request?: string; task?: string; instruction: string }) => t.request ?? t.task ?? t.instruction;
  const v2Native = (t: ScheduledTask) => !!(t.v2job || t.v2try);

  try {
    d.transaction(() => {
      // 1. goals
      for (const g of goals) {
        const rec = records.find((r) => r.goalId === g.id);
        const state = rec ? (rec.text.split('\n')[0] ?? '').replace(/^Where we are on "[^"]*" \(goal [^)]*\): /, '').slice(0, 700) : undefined;
        job(`goal:${g.id}`, { kind: 'background', title: titleOf(g.title), request: g.detail ? `${g.title}\n\n${g.detail}` : g.title, person: g.person, createdAt: g.createdAt,
          legacyGoalId: g.id, ...(state ? { whereItStands: state, standsTrust: rec?.trust === 'untrusted' ? 'untrusted' : 'high' } : {}) }, () => report.jobs.goals++);
      }
      // 2. pending recurring tasks and recurring reminders: Jobs whose task is the clock
      for (const t of pending.filter((x) => x.recur && !x.resumeAttempt && !v2Native(x))) {
        job(`sched:${t.id}`, { kind: taskKind(t), title: titleOf(words(t)), request: words(t), person: t.person, scheduleId: t.id, session: t.notify, dir: t.dir, status: t.paused ? 'paused' : 'active' },
          () => (t.kind === 'reminder' ? report.jobs.reminders++ : report.jobs.recurring++));
      }
      // 3. results: each notification with a job and a fire is an ended Try
      for (const [j8, group] of groups) {
        const fullId = fullIdOf(group);
        const info = fullId ? (pending.find((t) => t.id === fullId) ?? scheduled.get(fullId) ?? null) : null;
        let target: JobRow | undefined = (fullId ? jobBySchedule(fullId, d) : undefined) ?? jobByPrefix(j8, d);
        if (!target && info?.goal && !info.recur) target = jobByGoal(info.goal, d);
        if (!target) {
          const first = group[0];
          const reminder = info?.kind === 'reminder' || /^Reminder: /.test(String(first.summary ?? ''));
          const kind: JobKind = reminder ? 'reminder' : info?.recur ? 'recurring' : 'background';
          if (!info) report.orphans.push({ kind: 'result', id: fullId ?? j8, why: 'its scheduled task is no longer in the store; the Job is made from its results' });
          target = job(`sched:${fullId ?? j8}`, { kind, title: titleOf(first.title ?? (info ? words(info) : String(first.instruction ?? 'Scheduled job'))), request: info ? words(info) : String(first.instruction ?? ''),
            person: info?.person, scheduleId: fullId, session: first.session ?? info?.notify, dir: first.dir ?? info?.dir }, () => report.jobs.fromResults++);
        }
        for (const n of [...group].sort((a, b) => a.ts - b.ts)) {
          const key = `fire:${n.fire}`;
          if (keyExists('tries', key)) { report.skipped++; continue; }
          const run = runFor(n, runs);
          if (run) report.tries.enriched++;
          const resume = /^Resume and finish this task/.test(String(n.instruction ?? ''));
          const hasEnded = !!d.prepare(`SELECT 1 FROM tries WHERE job_id = ? AND state = 'ended' LIMIT 1`).get(target.id);
          const trigger: TryTrigger = resume ? (/cut off by a restart/.test(String(n.instruction)) ? 'resume-after-restart' : 'auto-continue')
            : target.kind === 'recurring' || target.kind === 'reminder' ? 'fire' : hasEnded ? 'continue' : 'first';
          const dur = Number(n.durationMs ?? run?.durationMs ?? 0);
          insertTry(target.id, { key, trigger, state: 'ended', scheduleId: !resume && String(n.job).length > 8 ? String(n.job) : null, startedAt: run?.ts ?? (dur ? n.ts - dur : null), endedAt: n.ts,
            reason: n.reason ?? run?.reason ?? null, outcome: n.outcome ?? run?.outcome ?? null, costUsd: n.costUsd ?? run?.costUsd ?? null,
            steps: n.steps ?? run?.steps ?? null, toolCalls: n.toolCalls ?? run?.toolCalls ?? null, summary: n.summary ?? run?.summary ?? null, pagesRead: run?.pagesRead ?? null });
          report.tries.ended++;
        }
        // A job whose last result the person has seen in the old app counts as opened: results were shown there.
        if (target.seen_at == null) { d.prepare('UPDATE jobs SET seen_at = ? WHERE id = ?').run(Math.max(...group.map((n) => n.ts)), target.id); bump(target.id); }
      }
      // 4. pending one-off tasks: a queued Try (the goal's Job when they work on a goal)
      for (const t of pending.filter((x) => !x.recur && !x.resumeAttempt && !v2Native(x))) {
        const key = `sched:${t.id}`;
        if (keyExists('tries', key) || d.prepare(`SELECT 1 FROM tries WHERE schedule_id = ?`).get(t.id)) { report.skipped++; continue; }
        const target = (t.goal && t.kind !== 'reminder' ? jobByGoal(t.goal, d) : undefined)
          ?? job(key, { kind: taskKind(t), title: titleOf(words(t)), request: words(t), person: t.person, scheduleId: t.id, legacyGoalId: t.goal, session: t.notify, dir: t.dir },
            () => (t.kind === 'reminder' ? report.jobs.reminders++ : report.jobs.oneOff++));
        if (!target.schedule_id) { d.prepare('UPDATE jobs SET schedule_id = ?, session = COALESCE(session, ?), dir = COALESCE(dir, ?) WHERE id = ?').run(t.id, t.notify ?? null, t.dir ?? null, target.id); }
        const hasEnded = !!d.prepare(`SELECT 1 FROM tries WHERE job_id = ? AND state = 'ended' LIMIT 1`).get(target.id);
        insertTry(target.id, { key, trigger: hasEnded ? 'continue' : 'first', state: 'queued', dueAt: t.due, scheduleId: t.id });
        report.tries.queued++;
      }
      // 5. resumes: a queued auto-continue Try of the Job their lineage names
      for (const t of pending.filter((x) => x.resumeAttempt && !v2Native(x))) {
        const key = `sched:${t.id}`;
        if (keyExists('tries', key) || d.prepare(`SELECT 1 FROM tries WHERE schedule_id = ?`).get(t.id)) { report.skipped++; continue; }
        let target = (t.resumeOf ? jobByPrefix(t.resumeOf, d) : undefined) ?? (t.goal ? jobByGoal(t.goal, d) : undefined);
        if (!target) {
          report.orphans.push({ kind: 'resume', id: t.id, why: t.resumeOf ? `no job matches resumeof=${t.resumeOf}` : 'it names no job it continues' });
          target = job(`sched:${t.id}:job`, { kind: 'background', title: titleOf(words(t)), request: words(t), person: t.person, legacyGoalId: t.goal, session: t.notify, dir: t.dir }, () => report.jobs.orphanResumes++);
        }
        insertTry(target.id, { key, trigger: /cut off by a restart/.test(t.instruction) ? 'resume-after-restart' : 'auto-continue', state: 'queued', dueAt: t.due, scheduleId: t.id });
        report.tries.resumes++;
      }
      // 6. a goal that is done or paused, with nothing that ran here: one ended Try from the goal's own status
      for (const g of goals.filter((x) => x.status === 'done' || x.status === 'blocked')) {
        const j = d.prepare('SELECT * FROM jobs WHERE legacy_key = ?').get(`goal:${g.id}`) as JobRow | undefined;
        if (!j) continue;
        const key = `goalstatus:${g.id}`;
        if (keyExists('tries', key)) { report.skipped++; continue; }
        if (d.prepare('SELECT 1 FROM tries WHERE job_id = ? LIMIT 1').get(j.id)) continue;
        const rec = records.find((r) => r.goalId === g.id);
        insertTry(j.id, { key, trigger: 'first', state: 'ended', endedAt: rec?.at ?? g.createdAt ?? null,
          reason: g.status === 'done' ? 'done' : 'stuck', outcome: g.status === 'done' ? 'changed' : 'could-not',
          summary: j.where_it_stands ?? (g.status === 'done' ? 'Marked done.' : 'Paused partway.') });
        if (g.status === 'done') { d.prepare('UPDATE jobs SET seen_at = COALESCE(seen_at, ?) WHERE id = ?').run(rec?.at ?? g.createdAt ?? Date.now(), j.id); }
        report.tries.fromGoalStatus++;
      }
      if (o.dryRun) throw new Rollback('dry run');
      if (o.record !== false && !d.prepare('SELECT 1 FROM migrations WHERE name = ?').get(DATA_MIGRATION)) {
        d.prepare('INSERT INTO migrations (name, at, report) VALUES (?, ?, ?)').run(DATA_MIGRATION, Date.now(), JSON.stringify(report));
      }
    }).immediate();
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return report;
}

/** Run once on first start (recorded in `migrations` as data-002-jobs). Returns the report, or null when already done. */
export async function migrateV2Once(memory: MigrateMemory, o: { notifyFile?: string; runsFile?: string; d?: AppDb } = {}): Promise<MigrateReport | null> {
  const d = o.d ?? appDb();
  if (d.prepare('SELECT 1 FROM migrations WHERE name = ?').get(DATA_MIGRATION)) return null;
  return migrateV2(memory, { ...o, d, record: true });
}

/** The report in plain lines, for the CLI. */
export function describeReport(r: MigrateReport): string {
  const lines = [
    `${r.dryRun ? 'Dry run — nothing was written.' : 'Migrated.'}`,
    `Jobs: ${r.jobs.goals} from goals, ${r.jobs.recurring} recurring, ${r.jobs.reminders} reminders, ${r.jobs.oneOff} one-off, ${r.jobs.fromResults} from results only, ${r.jobs.orphanResumes} for orphaned resumes.`,
    `Tries: ${r.tries.ended} ended (from results; ${r.tries.enriched} matched to their run), ${r.tries.queued} queued, ${r.tries.resumes} queued continuations, ${r.tries.fromGoalStatus} from a goal's status.`,
    `Already migrated (skipped): ${r.skipped}. Result lines without a job (not tries): ${r.ignoredLines}.`,
    r.orphans.length ? `Orphans (${r.orphans.length}):\n${r.orphans.map((x) => `  - ${x.kind} ${x.id}: ${x.why}`).join('\n')}` : 'Orphans: none.',
  ];
  return lines.join('\n');
}
