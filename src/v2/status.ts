/**
 * v2 slice A3a: a Job's status, from its Tries — a PURE function, so the server and every client say the same thing.
 *
 * The baseline guessed: the web app derived "status" from how the last run ENDED (web/src/tasks.ts statusOf), so a
 * budget-ended run showed FAILED while its automatic continuation was running (SR-F02), an incomplete run said DONE
 * (SR-F16), and nothing offered Continue after a budget end (SR-F05). Here the order is fixed and the first match
 * wins:
 *
 *   1. a Try is running (in this process, or claimed by a process that is still alive)        → working
 *   2. the person paused it, or a recurring job was cancelled                                   → stopped_by_you / stopped
 *   3. a Try the person asked for (first, continue, start over) is due now                      → working ("Starting now")
 *   4. a pending approval staged by a Try, or the last Try hit the dollar cap                   → waiting (for you)
 *   5. a queued automatic continuation (budget resume, or after a restart)                      → continuing — never "failed"
 *   6. a Try the person asked for is queued but put off (budget hold, a paused goal)             → scheduled ("Waiting to continue")
 *   7. a recurring job between fires: what the last fire did, and when the next one is          → scheduled (never Continue)
 *   8. the last Try was stopped by the person                                                   → stopped_by_you
 *      … or ended because its goal was marked done, or the job cancelled itself                 → done ("Finished") / stopped ("Stopped itself")
 *   (nothing has ended yet, nothing running or due                                              → scheduled)
 *   9. the last Try left something: `remaining`, progress short of its total, or ran out of room → partly_done
 *  10. the last Try could not do it and made no progress                                        → stopped
 *  11. otherwise                                                                                → done (+ result ready until opened)
 *
 * A Try marked `running` whose claimer is gone (a crash) and that is not live here is read as cut off — never as
 * "working" forever (review H1). "Result ready" comes only from a result that was delivered (review M5).
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
  /** a delivered result the person has not opened since it arrived */
  resultReady?: boolean;
}

/** The fields of a Job the status reads (a row of `jobs`). */
export interface StatusJob {
  kind: string;
  status?: string | null; // lifecycle: active | paused | cancelled
  cap_usd?: number | null;
  seen_at?: number | null;
  progress_unit?: string | null;
  /** who stopped it for good: 'person' (an action in the app) or 'self' (the model's own tool) */
  stopped_by?: string | null;
  /** a recurring job's next run */
  next_due_at?: number | null;
}
/** The fields of a Try the status reads (a row of `tries`). */
export interface StatusTry {
  n: number;
  trigger: string;
  state: 'queued' | 'running' | 'ended' | string;
  live_key?: string | null;
  claimed_by?: string | null;
  due_at?: number | null;
  started_at?: number | null;
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
  /** who ended it, when not its own run: 'person', 'cancel' (cancelled before it started), 'self', 'goal-done', 'reaper' */
  ended_by?: string | null;
  /** 0 when the scheduler kept its result quiet (deliver=changed, nothing new) */
  delivered?: number | null;
}
export interface StatusCtx {
  /** live keys of the runs going right now in this process (liveRuns) */
  running: Set<string>;
  /** approvals still pending that a Try of this job staged */
  pendingApprovals: number;
  /** now (ms) — a queued Try due later is scheduled, not working */
  now?: number;
  /** whether the process that claimed a Try is still alive (its heartbeat); absent = trust the row */
  claimerAlive?: (claimer: string) => boolean;
}

const AUTO = new Set(['auto-continue', 'resume-after-restart']);

/** "none", "n/a", "nothing", "-" or empty: nothing is left (review M6). */
export function normalizeRemaining(s: unknown): string | null {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (/^(?:none|n\/?a|na|nil|null|no|nothing|nothing (?:left|remains?|else)|no(?:thing)? remaining|-+|—|–|\.+)[.!]?$/i.test(t)) return null;
  return t;
}

/** 15¢, $1.20 */
export function money(usd: number): string {
  return usd < 1 ? `${Math.max(0, Math.round(usd * 100))}¢` : `$${usd.toFixed(2)}`;
}
/** A time a person reads: "10:40 AM" today, else "Tue 10:40 AM". */
export function when(ms: number, now: number): string {
  const d = new Date(ms);
  const t = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return new Date(now).toDateString() === d.toDateString() ? t : `${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}, ${t}`;
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
const CUT_OFF = 'It was cut off when the helper stopped.';

export function jobStatus(job: StatusJob, input: StatusTry[], ctx: StatusCtx): JobStatus {
  const now = ctx.now ?? Date.now();
  // A running Try whose claimer is gone and that is not live here was cut off by a crash: read it as ended.
  const tries = input.map((t) => (t.state === 'running' && !(t.live_key && ctx.running.has(t.live_key)) && t.claimed_by && ctx.claimerAlive && !ctx.claimerAlive(t.claimed_by)
    ? { ...t, state: 'ended', reason: 'error', outcome: 'could-not', summary: CUT_OFF, ended_by: 'reaper', ended_at: t.started_at ?? t.due_at ?? 0 } : t));
  const byN = [...tries].sort((a, b) => a.n - b.n);
  const ended = byN.filter((t) => t.state === 'ended');
  const last = ended[ended.length - 1];
  const queued = byN.filter((t) => t.state === 'queued');
  const live = byN.find((t) => t.state === 'running' || (t.state !== 'ended' && !!t.live_key && ctx.running.has(t.live_key)));
  const lastLeft = leftOf(last, job);
  const recurring = job.kind === 'recurring';
  // Result ready: the newest result that reached the person, not opened since (review M5: a quiet fire is not news).
  const delivered = [...ended].reverse().find((t) => t.delivered !== 0 && t.ended_by == null && t.reason !== 'stopped');
  const resultReady = !!delivered && (job.seen_at == null || (delivered.ended_at != null && job.seen_at < delivered.ended_at));
  const next = job.next_due_at != null ? ` Next run ${when(job.next_due_at, now)}.` : '';

  // 1. working: a Try is running.
  if (live) {
    return { state: 'working', label: 'Working', detail: lastLeft && live.trigger !== 'start-over' && !recurring ? `Working on it — ${num(lastLeft.done)} of ${num(lastLeft.total)} ${lastLeft.unit} done so far.` : 'Working on it now.', primaryAction: { action: 'stop', label: 'Stop' } };
  }
  // 2. paused or cancelled: before anything that would say it is starting (review M3).
  if (job.status === 'paused') return { state: 'stopped_by_you', label: 'Paused', detail: 'Paused. It keeps its settings and will not run until you resume it.', primaryAction: { action: 'resume', label: 'Resume' } };
  if (job.status === 'cancelled') {
    if (job.stopped_by === 'self') return { state: 'stopped', label: 'Stopped itself', detail: last?.summary ? `It stopped itself: ${firstSentence(last.summary)}` : 'It stopped itself. It will not run again.' };
    return { state: 'stopped_by_you', label: 'Stopped by you', detail: 'Cancelled. It will not run again.' };
  }
  // 3. a Try the person asked for, due now.
  const starting = queued.find((t) => !AUTO.has(t.trigger) && (t.due_at == null || t.due_at <= now));
  if (starting) return { state: 'working', label: 'Working', detail: 'Starting now.', primaryAction: { action: 'stop', label: 'Stop' } };

  // 4. waiting for you: an approval it staged, or the dollar limit the person set.
  if (ctx.pendingApprovals > 0) {
    const n = ctx.pendingApprovals;
    return { state: 'waiting', label: 'Waiting for you', detail: n === 1 ? 'It needs your OK before it goes on.' : `${n} things need your OK before it goes on.`, primaryAction: { action: 'review', label: 'Review' } };
  }
  if (last?.cap_hit === 'usd' && !recurring && !queued.some((t) => !AUTO.has(t.trigger))) {
    const cap = job.cap_usd != null ? `the ${money(job.cap_usd)} limit you set` : 'the spending limit you set';
    const ask = lastLeft && lastLeft.left > 0 ? ` Finish the last ${num(lastLeft.left)} ${lastLeft.unit}?` : ' Finish the rest?';
    const about = last.est_usd != null ? ` About ${money(last.est_usd)}.` : '';
    return { state: 'waiting', label: 'Waiting for you', detail: `It reached ${cap}.${ask}${about}`, primaryAction: { action: 'continue', label: finishLabel(lastLeft) } };
  }

  // 5. continuing: an automatic continuation is queued. Whatever the last Try's reason, this is never "failed".
  const auto = queued.find((t) => AUTO.has(t.trigger));
  if (auto) {
    const why = auto.trigger === 'resume-after-restart' ? 'A restart cut it off' : 'It ran out of room';
    const so = lastLeft ? ` after ${num(lastLeft.done)} of ${num(lastLeft.total)} ${lastLeft.unit}` : '';
    return { state: 'continuing', label: 'Continuing', detail: `${why}${so}, so it's picking up where it left off.`, primaryAction: { action: 'stop', label: 'Stop' } };
  }
  // 6. a Try the person asked for, put off (the monthly budget, a paused goal): it will run — no second Continue.
  const later = queued.find((t) => !AUTO.has(t.trigger));
  if (later) {
    const at = later.due_at != null ? when(later.due_at, now) : 'later';
    return last
      ? { state: 'scheduled', label: 'Waiting to continue', detail: `On hold until ${at}; it will pick up where it stopped.`, primaryAction: { action: 'stop', label: 'Stop' } }
      : { state: 'scheduled', label: 'Scheduled', detail: `Not started yet — due ${at}.`, primaryAction: { action: 'stop', label: 'Stop' } };
  }

  // 7. a recurring job between fires: what its last fire did, and when it runs next. Never Continue or Start over.
  if (recurring) {
    const what = !last ? 'It has not run yet.'
      : last.ended_by === 'reaper' || /cut off/i.test(last.summary ?? '') ? 'The last run was cut off by a restart.'
      : last.reason === 'budget' || last.reason === 'stuck' ? 'The last run ran out of room before it finished.'
      : last.reason === 'stopped' ? 'You stopped the last run.'
      : last.outcome === 'could-not' ? `The last run couldn't finish: ${firstSentence(last.summary) || 'no reason given.'}`
      : `Last run: ${firstSentence(delivered?.summary ?? last.summary) || 'done.'}`;
    return { state: 'scheduled', label: resultReady ? 'Result ready' : 'Scheduled', detail: `${what}${next}`, resultReady, ...(resultReady ? { primaryAction: { action: 'open' as const, label: 'Open' } } : {}) };
  }

  // 8. who ended the last Try: the person, its goal being marked done, or the job itself.
  if (last?.ended_by === 'goal-done') {
    return job.stopped_by === 'person'
      ? { state: 'stopped_by_you', label: 'Stopped by you', detail: 'You marked it done.' }
      : { state: 'done', label: 'Finished', detail: 'Finished — it decided it was done.', resultReady, ...(resultReady ? { primaryAction: { action: 'open' as const, label: 'Open' } } : {}) };
  }
  if (last?.ended_by === 'self') return { state: 'stopped', label: 'Stopped itself', detail: last.summary ? `It stopped itself: ${firstSentence(last.summary)}` : 'It stopped itself.' };
  if (last?.reason === 'stopped' || last?.ended_by === 'person' || last?.ended_by === 'cancel') {
    return { state: 'stopped_by_you', label: 'Stopped by you', detail: lastLeft && lastLeft.done > 0 ? `Kept ${num(lastLeft.done)} ${lastLeft.unit}.` : 'Kept what it had so far.', primaryAction: { action: 'continue', label: 'Continue' } };
  }

  // Nothing has finished yet, and nothing is running or due.
  if (!last) return { state: 'scheduled', label: 'Scheduled', detail: 'Not started yet.' };

  // 9. partly done: the last Try said what is left, fell short of its total, or ran out of room with no continuation.
  const remaining = normalizeRemaining(last.remaining);
  const short = lastLeft !== null && lastLeft.left > 0;
  const outOfRoom = last.reason === 'budget' || last.reason === 'stuck';
  if (remaining || short || outOfRoom) {
    const got = lastLeft ? `Got through ${num(lastLeft.done)} of ${num(lastLeft.total)} ${lastLeft.unit}.` : outOfRoom ? 'It ran out of room before it finished.' : 'Not everything got done.';
    const rest = remaining ? ` Still to do: ${remaining.replace(/[.\s]+$/, '')}.` : '';
    return { state: 'partly_done', label: 'Partly done', detail: `${got}${rest}`, primaryAction: { action: 'continue', label: finishLabel(lastLeft) } };
  }

  // 10. stopped: it could not do it, and it made no progress. A crash is said as such, and picked up with Continue.
  if (last.outcome === 'could-not' && !(lastLeft && lastLeft.done > 0)) {
    if (last.ended_by === 'reaper' || last.summary === CUT_OFF) return { state: 'stopped', label: 'Stopped', detail: CUT_OFF, primaryAction: { action: 'continue', label: 'Continue' } };
    const why = firstSentence(last.summary);
    return { state: 'stopped', label: 'Stopped', detail: why ? `It couldn't finish: ${why}` : "It couldn't finish.", primaryAction: { action: 'start-over', label: 'Try again' } };
  }

  // 11. done — and a result is ready until the person opens it.
  const what = firstSentence(last.summary);
  return { state: 'done', label: resultReady ? 'Result ready' : 'Done', detail: what || 'Finished.', resultReady, primaryAction: { action: 'open', label: 'Open' } };
}
