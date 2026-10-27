/**
 * The header pill and the working sheet, computed from the SERVER's job states (v2 build, slice W1).
 *
 * The client never guesses a status (the v1 app did, from words and times): each job carries `status.state`, one of
 * eight, from src/v2/status.ts. This file only counts them:
 *
 *   state            pill                         sheet group
 *   working          working                      Working now
 *   continuing       working (queued to go on)    Working now
 *   waiting          waiting for you              Waiting for you
 *   done + ready     result ready                 Finished
 *   done             –                            Finished (recent)
 *   partly_done      –                            Stopped (recent; it offers Finish the rest)
 *   stopped_by_you   –                            Stopped (recent)
 *   stopped          –                            Stopped (recent)
 *   scheduled        –                            Scheduled
 *
 * Pill words (the prototype's, REPLAY-NOTES.md): "Helper is resting", "Working on 1 thing", "Working on 2 things",
 * "Working on 1 · 1 waiting for you", "Working on 1 · 1 result ready", "1 result ready".
 */
import type { Job, JobState } from '../api/client';

export type PillTone = 'needs' | 'working' | 'resting';
export interface Pill { text: string; tone: PillTone; working: number; waiting: number; ready: number }

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const WORKING: ReadonlySet<JobState> = new Set(['working', 'continuing']);

/** Jobs the pill and the sheet consider: not archived. */
export function activeJobs(jobs: Iterable<Job>): Job[] {
  return [...jobs].filter((j) => !j.archived);
}

export function pillFor(jobs: Iterable<Job>): Pill {
  const list = activeJobs(jobs);
  const working = list.filter((j) => WORKING.has(j.status.state)).length;
  const waiting = list.filter((j) => j.status.state === 'waiting').length;
  const ready = list.filter((j) => j.status.state === 'done' && j.status.resultReady === true).length;
  const parts: string[] = [];
  if (working) parts.push(waiting || ready ? `Working on ${working}` : `Working on ${plural(working, 'thing', 'things')}`);
  if (waiting) parts.push(`${waiting} waiting for you`);
  if (ready) parts.push(plural(ready, 'result', 'results') + ' ready');
  const tone: PillTone = waiting || ready ? 'needs' : working ? 'working' : 'resting';
  return { text: parts.length ? parts.join(' · ') : 'Helper is resting', tone, working, waiting, ready };
}

export type GroupKey = 'waiting' | 'working' | 'finished' | 'stopped' | 'scheduled';
export interface JobGroup { key: GroupKey; title: string; jobs: Job[] }
/** How many finished or stopped jobs the sheet lists (a result not opened yet is always listed). */
export const RECENT = 5;

const newestFirst = (a: Job, b: Job) => b.updatedSeq - a.updatedSeq || b.createdAt - a.createdAt;

/** The working sheet's groups, in the prototype's order; empty groups are left out. */
export function groupJobs(jobs: Iterable<Job>): JobGroup[] {
  const list = activeJobs(jobs).sort(newestFirst);
  const by = (states: JobState[]) => list.filter((j) => states.includes(j.status.state));
  const done = by(['done']);
  const ready = done.filter((j) => j.status.resultReady);
  const finished = [...ready, ...done.filter((j) => !j.status.resultReady).slice(0, Math.max(0, RECENT - ready.length))];
  const groups: JobGroup[] = [
    { key: 'waiting', title: 'Waiting for you', jobs: by(['waiting']) },
    { key: 'working', title: 'Working now', jobs: by(['working', 'continuing']) },
    { key: 'finished', title: 'Finished', jobs: finished },
    { key: 'stopped', title: 'Stopped', jobs: by(['partly_done', 'stopped_by_you', 'stopped']).slice(0, RECENT) },
    { key: 'scheduled', title: 'Scheduled', jobs: by(['scheduled']) },
  ];
  return groups.filter((g) => g.jobs.length);
}

/** "$1.29" / "4¢" */
export function money(usd: number): string {
  return usd < 1 ? `${Math.max(0, Math.round(usd * 100))}¢` : `$${usd.toFixed(2)}`;
}

/**
 * The sheet's first line. The v1 API has no spending summary yet, so this is what the jobs themselves cost this
 * month (archived ones included) and says so; the monthly limit appears once the server reports one.
 */
export function monthLine(jobs: Iterable<Job>, now: number, limitUsd: number | null = null): string {
  const d = new Date(now);
  const from = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const usd = [...jobs].filter((j) => j.createdAt >= from).reduce((a, j) => a + (j.costUsd || 0), 0);
  return `$${usd.toFixed(2)} on jobs this month` + (limitUsd != null ? ` · limit $${Number.isInteger(limitUsd) ? limitUsd : limitUsd.toFixed(2)}` : '');
}

/** The line under a job's title: how far it got ("63 of 73 pages"), else the server's label ("Result ready"). The
 *  group it sits in already says whether it waits, works or stopped. */
export function jobLine(j: Job): string {
  const p = j.progress;
  if (p && p.total > 0) return `${fmtNum(p.done)} of ${fmtNum(p.total)} ${p.unit}`;
  return j.status.label;
}
const fmtNum = (x: number) => (Number.isInteger(x) ? String(x) : String(Math.round(x * 10) / 10));
