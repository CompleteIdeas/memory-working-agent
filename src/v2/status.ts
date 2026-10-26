/**
 * v2 slice A3a: a Job's status, from its Tries — a PURE function, so the server and every client say the same thing.
 *
 * The baseline guessed: the web app derived "status" from how the last run ENDED (web/src/tasks.ts statusOf), so a
 * budget-ended run showed FAILED while its automatic continuation was running (SR-F02), an incomplete run said DONE
 * (SR-F16), and nothing offered Continue after a budget end (SR-F05). Here the order is fixed and the first match
 * wins:
 *
 *   1. a Try is running (or one the person asked for is due and about to start)  → working
 *   2. a pending approval staged by a Try, or the last Try hit the dollar cap     → waiting (for you)
 *   3. a queued automatic continuation (budget resume, or after a restart)        → continuing — never "failed"
 *   4. the last Try was stopped by the person (or the job was paused/cancelled)   → stopped_by_you
 *   5. the last Try left something: `remaining`, progress short of its total, or
 *      it ran out of room (budget/stuck) with no continuation left               → partly_done
 *   6. the last Try could not do it and made no progress                          → stopped
 *   (nothing has ended yet, nothing running or due                                → scheduled)
 *   7. otherwise                                                                  → done (+ result ready until opened)
 *
 * The words follow the approved prototype (prototype-v2, N04/N06): "Waiting for you", "It reached the 15¢ limit you
 * set. Finish the last 10 pages?", "Stopped by you — kept 3 stories", "Finished", "Result ready".
 */

export type JobState = 'working' | 'waiting' | 'continuing' | 'stopped_by_you' | 'partly_done' | 'stopped' | 'scheduled' | 'done';
export const JOB_STATES: readonly JobState[] = ['working', 'waiting', 'continuing', 'stopped_by_you', 'partly_done', 'stopped', 'scheduled', 'done'];

export type JobActionName = 'stop' | 'continue' | 'start-over' | 'open' | 'review' | 'resume';
export interface JobStatus {
  state: JobState;
  /** the heading a person reads ("Partly done", "Result ready") */
  label: string;
  /** one plain sentence: why, and what is left */
  detail: string;
  primaryAction?: { action: JobActionName; label: string };
  /** done, and not opened since the last Try ended */
  resultReady?: boolean;
}

/** The fields of a Job the status reads (a row of `jobs`). */
export interface StatusJob {
  kind: string;
  status?: string | null; // lifecycle: active | paused | cancelled
  cap_usd?: number | null;
  seen_at?: number | null;
  progress_unit?: string | null;
}
/** The fields of a Try the status reads (a row of `tries`). */
export interface StatusTry {
  n: number;
  trigger: string;
  state: 'queued' | 'running' | 'ended' | string;
  live_key?: string | null;
  due_at?: number | null;
  ended_at?: number | null;
  reason?: string | null;
  outcome?: string | null;
  progress_done?: number | null;
  progress_total?: number | null;
  progress_unit?: string | null;
  remaining?: string | null;
  cap_hit?: string | null;
  cost_usd?: number | null;
  summary?: string | null;
  est_usd?: number | null;
}
export interface StatusCtx {
  /** live keys of the runs going right now in this process (liveRuns) */
  running: Set<string>;
  /** approvals still pending that a Try of this job staged */
  pendingApprovals: number;
  /** now (ms) — a queued Try due later is scheduled, not working */
  now?: number;
}

const AUTO = new Set(['auto-continue', 'resume-after-restart']);

/** 15¢, $1.20 */
export function money(usd: number): string {
  return usd < 1 ? `${Math.max(0, Math.round(usd * 100))}¢` : `$${usd.toFixed(2)}`;
}
const num = (x: number) => (Number.isInteger(x) ? String(x) : String(Math.round(x * 10) / 10));
const firstSentence = (s?: string | null) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  const m = /^(.{8,200}?[.!?])(\s|$)/.exec(t);
  return (m ? m[1] : t.slice(0, 200)).trim();
};

/** What is left, in numbers, from a Try's progress: { left: 10, unit: 'pages' } — or null when it did not say. */
function leftOf(t: StatusTry | undefined, job: StatusJob): { done: number; total: number; left: number; unit: string } | null {
  if (!t || t.progress_done == null || t.progress_total == null || !(t.progress_total > 0)) return null;
  const unit = (t.progress_unit ?? job.progress_unit ?? 'parts').trim() || 'parts';
  return { done: t.progress_done, total: t.progress_total, left: Math.max(0, t.progress_total - t.progress_done), unit };
}
function finishLabel(l: ReturnType<typeof leftOf>): string {
  return l && l.left > 0 ? `Finish the last ${num(l.left)} ${l.unit}` : 'Finish the rest';
}

export function jobStatus(job: StatusJob, tries: StatusTry[], ctx: StatusCtx): JobStatus {
  const now = ctx.now ?? Date.now();
  const byN = [...tries].sort((a, b) => a.n - b.n);
  const ended = byN.filter((t) => t.state === 'ended');
  const last = ended[ended.length - 1];
  const queued = byN.filter((t) => t.state === 'queued');
  const live = byN.find((t) => t.state === 'running' || (t.state !== 'ended' && !!t.live_key && ctx.running.has(t.live_key)));
  const lastLeft = leftOf(last, job);

  // 1. working: a Try is running, or one the person asked for (first, continue, start over, a fire) is due now.
  if (live) {
    const p = leftOf(last, job);
    return { state: 'working', label: 'Working', detail: p && live.trigger !== 'start-over' ? `Working on it — ${num(p.done)} of ${num(p.total)} ${p.unit} done so far.` : 'Working on it now.', primaryAction: { action: 'stop', label: 'Stop' } };
  }
  const starting = queued.find((t) => !AUTO.has(t.trigger) && (t.due_at == null || t.due_at <= now));
  if (starting) return { state: 'working', label: 'Working', detail: 'Starting now.', primaryAction: { action: 'stop', label: 'Stop' } };

  // 2. waiting for you: an approval it staged, or the dollar limit the person set.
  if (ctx.pendingApprovals > 0) {
    const n = ctx.pendingApprovals;
    return { state: 'waiting', label: 'Waiting for you', detail: n === 1 ? 'It needs your OK before it goes on.' : `${n} things need your OK before it goes on.`, primaryAction: { action: 'review', label: 'Review' } };
  }
  if (last?.cap_hit === 'usd') {
    const cap = job.cap_usd != null ? `the ${money(job.cap_usd)} limit you set` : 'the spending limit you set';
    const ask = lastLeft && lastLeft.left > 0 ? ` Finish the last ${num(lastLeft.left)} ${lastLeft.unit}?` : ' Finish the rest?';
    const about = last.est_usd != null ? ` About ${money(last.est_usd)}.` : '';
    return { state: 'waiting', label: 'Waiting for you', detail: `It reached ${cap}.${ask}${about}`, primaryAction: { action: 'continue', label: finishLabel(lastLeft) } };
  }

  // 3. continuing: an automatic continuation is queued. Whatever the last Try's reason, this is never "failed".
  const auto = queued.find((t) => AUTO.has(t.trigger));
  if (auto) {
    const why = auto.trigger === 'resume-after-restart' ? 'A restart cut it off' : 'It ran out of room';
    const so = lastLeft ? ` after ${num(lastLeft.done)} of ${num(lastLeft.total)} ${lastLeft.unit}` : '';
    return { state: 'continuing', label: 'Continuing', detail: `${why}${so}, so it's picking up where it left off.`, primaryAction: { action: 'stop', label: 'Stop' } };
  }

  // 4. stopped by you: the person's Stop, or a paused/cancelled recurring job.
  if (job.status === 'paused') return { state: 'stopped_by_you', label: 'Paused', detail: 'Paused. It keeps its settings and will not run until you resume it.', primaryAction: { action: 'resume', label: 'Resume' } };
  if (job.status === 'cancelled') return { state: 'stopped_by_you', label: 'Stopped by you', detail: 'Cancelled. It will not run again.' };
  if (last?.reason === 'stopped') {
    return { state: 'stopped_by_you', label: 'Stopped by you', detail: lastLeft && lastLeft.done > 0 ? `Kept ${num(lastLeft.done)} ${lastLeft.unit}.` : 'Kept what it had so far.', primaryAction: { action: 'continue', label: 'Continue' } };
  }

  // Nothing has finished yet, and nothing is running or due.
  if (!last) {
    const next = queued[0];
    return { state: 'scheduled', label: 'Scheduled', detail: next?.due_at != null ? 'Not started yet.' : job.kind === 'recurring' ? 'It has not run yet.' : 'Not started yet.' };
  }

  // 5. partly done: the last Try said what is left, fell short of its total, or ran out of room with no continuation.
  const remaining = (last.remaining ?? '').trim();
  const short = lastLeft !== null && lastLeft.left > 0;
  const outOfRoom = last.reason === 'budget' || last.reason === 'stuck';
  if (remaining || short || outOfRoom) {
    const got = lastLeft ? `Got through ${num(lastLeft.done)} of ${num(lastLeft.total)} ${lastLeft.unit}.` : outOfRoom ? 'It ran out of room before it finished.' : 'Not everything got done.';
    const rest = remaining ? ` Still to do: ${remaining.replace(/[.\s]+$/, '')}.` : '';
    return { state: 'partly_done', label: 'Partly done', detail: `${got}${rest}`, primaryAction: { action: 'continue', label: finishLabel(lastLeft) } };
  }

  // 6. stopped: it could not do it, and it made no progress.
  if (last.outcome === 'could-not' && !(lastLeft && lastLeft.done > 0)) {
    const why = firstSentence(last.summary);
    return { state: 'stopped', label: 'Stopped', detail: why ? `It couldn't finish: ${why}` : "It couldn't finish.", primaryAction: { action: 'start-over', label: 'Try again' } };
  }

  // 7. done — and a result is ready until the person opens it.
  const resultReady = job.seen_at == null || (last.ended_at != null && job.seen_at < last.ended_at);
  const what = firstSentence(last.summary);
  return { state: 'done', label: resultReady ? 'Result ready' : 'Done', detail: what || 'Finished.', resultReady, primaryAction: { action: 'open', label: 'Open' } };
}
