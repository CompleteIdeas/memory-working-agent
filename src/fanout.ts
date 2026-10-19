/**
 * Fan-out budget for scheduling (BL-05, H-8). A run may schedule several jobs (BL-43: "two reminders" is
 * two calls), every fire of a recurring job can create another job, and every new job can do the same,
 * so the job count compounds; and a planned run's steps can each schedule.
 * Not a ban: a monitor legitimately schedules a one-off follow-up. These limits are STRUCTURAL (job
 * lineage, counts), not textual, so rewording "check back tomorrow" can't slip past them.
 *
 *   depth      a job a person scheduled is depth 0; a job created by a scheduled fire is its
 *              parent's depth + 1, and by any other unattended run (mailbox, inbox) depth 1.
 *              Nothing deeper than MAX_JOB_DEPTH.
 *   children   one job may have at most MAX_CHILDREN pending jobs it created.
 *   per run    a run — a planned run counts all its steps and retries — schedules at most MAX_PER_RUN,
 *              or MAX_PER_RUN_ATTENDED when a person is present in a clean chat ("set four reminders").
 *   pending    a run nobody watched, or one that read outside content, may not schedule while
 *              MAX_PENDING jobs are already waiting. A person in an attended, clean chat always may.
 *   per goal   a goal owns at most MAX_JOBS_PER_GOAL pending jobs, and a finished goal owns none.
 */
export const MAX_JOB_DEPTH = 2;
export const MAX_CHILDREN = 2;
export const MAX_PER_RUN = 3;
export const MAX_PER_RUN_ATTENDED = 8;
/** An attended chat that has read outside content keeps the attended per-run cap until this many jobs wait (BL-53). */
export const MAX_PENDING_TAINTED_CHAT = 20;
export const MAX_PENDING = 50;
export const MAX_JOBS_PER_GOAL = 5;

export interface FanoutInput {
  /** the new job's depth (see newJobDepth) */
  depth: number;
  /** pending jobs this run's job already created (0 when the run is not a scheduled fire) */
  childrenOfThisJob: number;
  /** pending jobs this run (all its steps) has already created */
  byThisRun: number;
  /** all pending jobs */
  pending: number;
  /** pending jobs owned by the goal the new job would belong to (undefined = no goal) */
  goalJobs?: number;
  /** the goal is finished or missing */
  goalClosed?: boolean;
  /** nobody watched this run, or it read outside content */
  unattendedOrTainted: boolean;
  /** this run is a scheduled fire */
  isFire: boolean;
}

/** Depth for a job created by this run. */
export function newJobDepth(o: { isFire: boolean; jobDepth?: number; interactive?: boolean }): number {
  if (o.isFire) return (o.jobDepth ?? 0) + 1;
  return o.interactive === false ? 1 : 0;
}

/** Why this run may not schedule another job, or null when it may. */
export function fanoutRefusal(i: FanoutInput): string | null {
  if (i.goalClosed) return 'the goal this job would belong to is finished or no longer exists';
  if (i.depth > MAX_JOB_DEPTH) return `jobs created by jobs stop at ${MAX_JOB_DEPTH} levels — this would be level ${i.depth}`;
  if (i.isFire && i.childrenOfThisJob >= MAX_CHILDREN) return `this job already has ${i.childrenOfThisJob} follow-up jobs waiting (at most ${MAX_CHILDREN})`;
  const perRun = i.unattendedOrTainted ? MAX_PER_RUN : MAX_PER_RUN_ATTENDED;
  if (i.byThisRun >= perRun) return `this run already scheduled ${i.byThisRun} jobs (at most ${perRun})`;
  if (i.goalJobs !== undefined && i.goalJobs >= MAX_JOBS_PER_GOAL) return `that goal already has ${i.goalJobs} jobs waiting (at most ${MAX_JOBS_PER_GOAL})`;
  if (i.unattendedOrTainted && i.pending >= MAX_PENDING) return `${i.pending} jobs are already waiting (an unattended run may add more only below ${MAX_PENDING})`;
  return null;
}
