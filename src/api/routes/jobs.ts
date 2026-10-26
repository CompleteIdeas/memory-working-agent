/**
 * /api/v1/jobs (v2 slice A3a): what the helper is working on, with honest status, and the person's controls on it.
 *
 * Status comes from the server (src/v2/status.ts), never from a client's guess. The actions are the ones the approved
 * design offers: Stop, Continue ("Finish the last 10 pages"), Start over, Open (a result is "ready" until opened), and
 * for a recurring job Pause, Resume and Cancel through the existing schedule control (the same ownership and timing
 * rules as the model's tools).
 *
 * Slice A3b: every job carries its estimates (Continue = what is left x its rate, Start over = the whole job; see
 * src/v2/estimate.ts) and, once done, what was guessed against what it cost. Continue and Start over take an optional
 * `capUsd` - the most the new run may spend (default twice the estimate, at least 5 cents; at most $20). A run that
 * reaches it waits for the person; it never continues by itself.
 *
 * Review of A3a: every caller of /api/v1 is the owner (the password session, this machine, or a device paired by the
 * owner), so a caller sees and acts on the owner's jobs only — another person's (a Telegram contact's) are "No such
 * job" (M10). Continue and Start over reserve the job synchronously before any await, and anything queued counts as
 * busy (H4). The list is batched and paged.
 */
import { ApiError, type Route, type RouteCtx } from '../router.js';
import {
  getJob, listJobs, viewJob, viewJobs, addTry, linkTry, dropQueuedTry, endQueued, updateJob, reserveJob, releaseJob,
  ownerOwns, claimerAlive, personAction, stampEstimates, defaultCapFor, CLAIMER,
  type JobRow, type TryRow, type JobView, type ViewCtx,
} from '../../v2/jobs.js';
import { JOB_STATES, type JobState } from '../../v2/status.js';
import { aboutUsd, usdText, CAP_MAX_USD, type JobEstimate } from '../../v2/estimate.js';
export { CAP_MAX_USD };
import type { MwaMemory } from '../../awm.js';

/** What the job routes need from the running server. serve.ts sets it; tests set fakes. */
export interface JobRouteDeps {
  /** a memory store for one request (closed after) */
  memory: () => Pick<MwaMemory, 'addScheduledTask' | 'cancelScheduled' | 'getGoal' | 'setGoalStatus'> & { close?: () => void };
  /** live keys of the runs going now (chat sessions, `job_<task id>`) */
  running: () => Set<string>;
  /** the person's Stop on a live run; false when nothing by that key is running here */
  stopLive: (key: string) => boolean;
  /** ids of approvals still waiting */
  pendingApprovals: () => Set<string>;
  /** the existing schedule control (pause, resume, cancel), for a recurring job's own task, as `person` */
  scheduleControl: (person: string, action: 'pause' | 'resume' | 'cancel', scheduleId: string) => Promise<{ ok: boolean; message: string }>;
  /** a goal's Continue (handoff.ts continueGoal) — a goal's Job continues the goal's way */
  continueGoal?: (goalId: string, personId: string) => Promise<{ jobId: string; already?: boolean } | null>;
  now?: () => number;
}
let deps: JobRouteDeps | null = null;
export function setJobRouteDeps(d: JobRouteDeps | null): void { deps = d; }
function need(): JobRouteDeps {
  if (!deps) throw new ApiError(503, 'unavailable', 'Jobs are not available on this server.');
  return deps;
}

// ── Shapes (api/openapi.yaml: Job, Try, JobStatus) ──────────────────────────────────────────────────────────────

const progressOf = (done: number | null, total: number | null, unit: string | null) =>
  done != null && total != null ? { done, total, unit: unit ?? 'parts' } : null;

export function apiTry(t: TryRow) {
  let staged: string[] = [];
  try { staged = t.staged ? JSON.parse(t.staged) : []; } catch { staged = []; }
  return {
    id: t.id, n: t.n, trigger: t.trigger, state: t.state, dueAt: t.due_at, startedAt: t.started_at, endedAt: t.ended_at,
    reason: t.reason, outcome: t.outcome, progress: progressOf(t.progress_done, t.progress_total, t.progress_unit), remaining: t.remaining,
    costUsd: t.cost_usd, steps: t.steps, toolCalls: t.tool_calls, capHit: t.cap_hit, summary: t.summary, tainted: t.tainted === 1,
    staged, estUsd: t.est_usd, estMs: t.est_ms, pagesRead: t.pages_read, endedBy: t.ended_by, delivered: t.delivered == null ? null : t.delivered === 1,
  };
}
/** The estimates as the API gives them (null for a repeating job). */
export function apiEstimate(e: JobEstimate | null) {
  if (!e) return null;
  return { ...(e.continue ? { continue: e.continue } : {}), ...(e.startOver ? { startOver: e.startOver } : {}), basis: e.basis, samples: e.samples };
}
/** A finished job: its first guess against what it cost - "I guessed about $0.35 · it cost $0.41". */
export function estimateVsActual(v: JobView, spent: number) {
  const j = v.job;
  if (v.status.state !== 'done' || j.est_usd_first == null) return null;
  const actual = Math.round(spent * 10_000) / 10_000;
  return { estimatedUsd: j.est_usd_first, actualUsd: actual, text: `I guessed ${aboutUsd(j.est_usd_first)} · it cost ${usdText(actual)}` };
}
export function apiJob(v: JobView) {
  const j = v.job;
  const spent = v.tries.reduce((s, t) => s + (t.cost_usd ?? 0), 0);
  return {
    id: j.id, kind: j.kind, title: j.title, request: j.request, projectId: j.project_id, createdAt: j.created_at, updatedSeq: j.updated_seq,
    status: v.status, lifecycle: j.status, progress: progressOf(j.progress_done, j.progress_total, j.progress_unit), remaining: j.remaining,
    whereItStands: j.where_it_stands ? { text: j.where_it_stands, trust: j.stands_trust ?? 'high' } : null,
    seenAt: j.seen_at, capUsd: j.cap_usd, costUsd: Math.round(spent * 10_000) / 10_000, tries: v.tries.length, archived: j.archived === 1,
    scheduleId: j.schedule_id, goalId: j.legacy_goal_id, session: j.session, nextRunAt: j.next_due_at,
    estimate: apiEstimate(v.estimate), estimateVsActual: estimateVsActual(v, spent),
  };
}

/** The live context a status needs, read once per request. */
export function viewCtx(): ViewCtx {
  const d = need();
  return { running: d.running(), pending: d.pendingApprovals(), now: (d.now ?? Date.now)() };
}
/** Whether a caller may see a job: every v1 caller acts for the owner, so the owner's jobs only (review M10). */
export function visibleJob(job: JobRow): boolean { return ownerOwns(job.person); }

function view(job: JobRow, ctx: ViewCtx = viewCtx()): JobView { return viewJob(job, ctx); }
function load(ctx: RouteCtx): JobView {
  const job = getJob(ctx.params.id);
  if (!job || !visibleJob(job)) throw new ApiError(404, 'not_found', 'No such job.');
  return view(job);
}
const full = (v: JobView) => ({ job: apiJob(v), tries: v.tries.map(apiTry) });
/** The person the caller acts as for the schedule's ownership check: the owner, under the identity that owns this
 *  job (the owner may appear as `unknown` or `web-<name>`). Never another person's identity: load() refused those. */
const actingPerson = (job: JobRow) => job.person ?? 'unknown';

/** The words a Continue runs: the job's own request, how far it got and what is left — never a fresh start. */
export function continueInstruction(v: JobView): { instruction: string; tainted: boolean } {
  const last = [...v.tries].reverse().find((t) => t.state === 'ended');
  const tainted = v.tries.some((t) => t.tainted === 1) || v.job.stands_trust === 'untrusted';
  const p = last?.progress_done != null && last.progress_total != null ? `${last.progress_done} of ${last.progress_total} ${last.progress_unit ?? 'parts'}` : '';
  const lines = ['Continue this task from where it stopped — the person asked you to finish it. FIRST recall what you already did and check what is already in the working folder (with list_files and read_file, not a shell command) and keep it; then do ONLY the remaining work and finish. Do not start over.'];
  if (p) lines.push(`How far it got: ${p}.`);
  if (last?.remaining) lines.push(`What was left: ${last.remaining}`);
  // A run that read outside content: its own words are not repeated as instructions (the task starts tainted).
  if (last?.summary && !tainted) lines.push(`Its last word was: "${last.summary.replace(/\s+/g, ' ').slice(0, 600)}"`);
  if (v.job.where_it_stands && v.job.stands_trust !== 'untrusted') lines.push(`Where it stands: ${v.job.where_it_stands}`);
  lines.push('', 'THE TASK:', (v.job.request ?? v.job.title).slice(0, 4000));
  return { instruction: lines.join('\n'), tainted };
}

/** Queue a Try and the scheduled task that runs it (due now). Called with the job reserved. */
async function queueRun(v: JobView, trigger: 'continue' | 'start-over'): Promise<void> {
  const d = need();
  const now = (d.now ?? Date.now)();
  const job = v.job;
  const { instruction, tainted } = trigger === 'continue' ? continueInstruction(v)
    : { instruction: `Start this task over from the beginning — the person asked for a fresh start. Do the whole task.\n\nTHE TASK:\n${(job.request ?? job.title).slice(0, 4000)}`, tainted: v.tries.some((t) => t.tainted === 1) };
  const t = addTry(job.id, { trigger, dueAt: now });
  const m = d.memory();
  try {
    if (job.legacy_goal_id) {
      const g = await m.getGoal(job.legacy_goal_id).catch(() => null);
      if (g && g.status !== 'in_progress') await m.setGoalStatus(g.id, 'in_progress');
    }
    const id = await m.addScheduledTask(instruction, now, {
      notify: job.session ?? undefined, ...(trigger === 'continue' && job.dir ? { dir: job.dir } : {}), person: job.person ?? undefined,
      goal: job.legacy_goal_id ?? undefined, task: job.request ?? job.title, request: job.request ?? undefined, depth: 0,
      ...(tainted ? { tainted: true } : {}), v2job: job.id, v2try: t.id,
    });
    if (!id) { dropQueuedTry(t.id); throw new ApiError(503, 'not_queued', 'I could not set that up just now. Try again in a moment.'); }
    linkTry(t.id, id, now);
  } catch (e) {
    if (!(e instanceof ApiError)) dropQueuedTry(t.id);
    throw e;
  } finally { m.close?.(); }
}

const RECURRING = new Set(['recurring', 'reminder']);
/** Continue and Start over: refused while anything is running or queued (whatever its due time), and the job is
 *  reserved synchronously before any await, so two taps cannot both pass the check (review H4). */
async function withReservation<T>(v: JobView, fn: () => Promise<T>): Promise<T> {
  const holder = `${CLAIMER}:${Math.random().toString(36).slice(2)}`;
  const r = reserveJob(v.job.id, holder);
  if (!r.ok) {
    throw new ApiError(409, 'already_running', r.why === 'running' ? 'It is already working on this.'
      : r.why === 'queued' ? 'It is already set to run (it may be waiting its turn). Stop it first to change that.'
        : 'Another request for this job is being handled. Try again in a moment.');
  }
  try { return await fn(); } finally { releaseJob(v.job.id, holder); }
}

/**
 * The `capUsd` of a Continue or Start over: the given one (a number above 0, at most $20 — anything else is refused),
 * else the default policy (review of A3b): twice the estimate, or the estimate plus three of the job's largest steps
 * and the wrap-up, whichever is more; at least 25¢, 50¢ for a first guess; never above $20.
 */
export function capFor(body: unknown, v: Pick<JobView, 'job' | 'tries' | 'estimate'>, which: 'continue' | 'start-over'): number {
  const raw = body && typeof body === 'object' ? (body as Record<string, unknown>).capUsd : undefined;
  if (raw === undefined || raw === null) return Math.min(CAP_MAX_USD, defaultCapFor(v.job, v.tries, which, v.estimate));
  const n = typeof raw === 'number' ? raw : Number.NaN;
  if (!Number.isFinite(n) || n <= 0 || n > CAP_MAX_USD) throw new ApiError(400, 'bad_cap', `capUsd must be a number of dollars above 0 and at most ${CAP_MAX_USD}.`);
  return Math.min(CAP_MAX_USD, Math.round(n * 10_000) / 10_000);
}
/** Set the job's cap for the run about to be queued; returns a function that puts the old one back. */
export function setCap(job: JobRow, capUsd: number): () => void {
  const before = job.cap_usd;
  updateJob(job.id, { cap_usd: capUsd });
  return () => { try { updateJob(job.id, { cap_usd: before }); } catch { /* */ } };
}

const LIST_MAX = 200;
export const jobRoutes: Route[] = [
  {
    method: 'GET', path: '/jobs', scope: 'read',
    handler: ({ url }) => {
      const want = url.searchParams.get('state');
      if (want && !JOB_STATES.includes(want as JobState)) throw new ApiError(400, 'bad_state', `state must be one of: ${JOB_STATES.join(', ')}.`);
      const limit = Math.min(LIST_MAX, Math.max(1, Number.parseInt(url.searchParams.get('limit') ?? '50', 10) || 50));
      const beforeRaw = url.searchParams.get('before');
      let before = beforeRaw != null && /^\d+$/.test(beforeRaw) ? Number(beforeRaw) : undefined;
      const archived = url.searchParams.get('archived') === '1';
      const ctx = viewCtx(); // running, approvals and now: once per request, not once per job
      const out: JobView[] = [];
      let next: number | null = null;
      // Pages of rows, newest change first, until `limit` jobs match the state (a state is computed, not stored).
      for (let pass = 0; pass < 50 && out.length < limit; pass++) {
        const rows = listJobs({ archived, limit: LIST_MAX, before });
        if (!rows.length) { next = null; break; }
        for (const v of viewJobs(rows.filter(visibleJob), ctx)) {
          if (!want || v.status.state === want) out.push(v);
          if (out.length === limit) break;
        }
        const lastSeq = out.length === limit ? out[out.length - 1].job.updated_seq : rows[rows.length - 1].updated_seq;
        next = rows.length < LIST_MAX && out.length < limit ? null : lastSeq;
        if (rows.length < LIST_MAX) break;
        before = rows[rows.length - 1].updated_seq;
      }
      return { body: { jobs: out.map(apiJob), next } };
    },
  },
  {
    method: 'GET', path: '/jobs/{id}', scope: 'read',
    handler: (ctx) => ({ body: full(load(ctx)) }),
  },
  {
    // What Continue and Start over would cost and take - "about", from this job's own tries, history, or a default.
    method: 'GET', path: '/jobs/{id}/estimate', scope: 'read',
    handler: (ctx) => {
      const v = load(ctx);
      const e = v.estimate;
      if (!e) throw new ApiError(409, 'not_estimable', 'A repeating job is not estimated as a whole; each run is capped on its own.');
      return { body: { ...(e.continue && v.status.state !== 'done' ? { continue: e.continue } : {}), ...(e.startOver ? { startOver: e.startOver } : {}), basis: e.basis, samples: e.samples } };
    },
  },
  {
    method: 'POST', path: '/jobs/{id}/stop', scope: 'act',
    handler: async (ctx) => {
      const v = load(ctx);
      const d = need();
      const running = v.tries.filter((t) => t.state === 'running' && t.live_key);
      const stoppedLive = running.some((t) => d.stopLive(t.live_key!));
      const elsewhere = !stoppedLive && running.some((t) => t.claimed_by !== CLAIMER && claimerAlive(t.claimed_by));
      // Queued Tries will never start: they end, stopped by the person, and their scheduled tasks are cancelled.
      const queuedSchedules = v.tries.filter((t) => t.state === 'queued').map((t) => t.schedule_id).filter((x): x is string => !!x);
      const ended = endQueued(v.job.id, 'Stopped before it started.');
      if (queuedSchedules.length) {
        const m = d.memory();
        try { await personAction(async () => { for (const s of queuedSchedules) await m.cancelScheduled(s); }); } finally { m.close?.(); }
      }
      if (!stoppedLive && !ended.length && !queuedSchedules.length) {
        if (elsewhere) throw new ApiError(409, 'running_elsewhere', 'It is still finishing in another MWA process (the Telegram one, or a second server). It cannot be stopped from here; it will end on its own.');
        throw new ApiError(409, 'nothing_running', 'Nothing is running for this job.');
      }
      const after = view(getJob(v.job.id)!);
      const message = stoppedLive ? 'Stopping. The step that is running finishes; nothing new starts. What it has done so far is kept.'
        : elsewhere ? 'Stopped what was waiting. The run going in another MWA process is still finishing there.' : 'Stopped. It will not start.';
      return { body: { ...full(after), message } };
    },
  },
  {
    method: 'POST', path: '/jobs/{id}/continue', scope: 'act',
    handler: async (ctx) => {
      const v = load(ctx);
      if (RECURRING.has(v.job.kind)) throw new ApiError(409, 'not_continuable', 'A repeating job runs again on its own schedule.');
      const cap = capFor(ctx.body, v, 'continue');
      return withReservation(v, async () => {
        if (v.status.state === 'done') throw new ApiError(409, 'nothing_left', 'It is finished. Start over to do it again.');
        const d = need();
        const undoCap = setCap(v.job, cap);
        try {
          if (v.job.legacy_goal_id && d.continueGoal) {
            // A goal's Job continues the goal's way (its note, its conversation's folder): a Try of this same Job.
            const m = d.memory();
            try { const g = await m.getGoal(v.job.legacy_goal_id).catch(() => null); if (g?.status === 'done') await m.setGoalStatus(g.id, 'in_progress'); } finally { m.close?.(); }
            const c = await d.continueGoal(v.job.legacy_goal_id, actingPerson(v.job));
            if (!c) throw new ApiError(409, 'refused', 'That could not be picked up. Its goal may belong to someone else.');
            stampEstimates(v.job.id);
          } else await queueRun(v, 'continue');
        } catch (e) { undoCap(); throw e; }
        return { status: 202, body: { ...full(view(getJob(v.job.id)!)), message: `Picking it up where it stopped (up to ${usdText(cap)}).` } };
      });
    },
  },
  {
    method: 'POST', path: '/jobs/{id}/start-over', scope: 'act',
    handler: async (ctx) => {
      const v = load(ctx);
      if (RECURRING.has(v.job.kind)) throw new ApiError(409, 'not_continuable', 'A repeating job runs again on its own schedule.');
      const cap = capFor(ctx.body, v, 'start-over');
      return withReservation(v, async () => {
        const undoCap = setCap(v.job, cap);
        try { await queueRun(v, 'start-over'); } catch (e) { undoCap(); throw e; }
        return { status: 202, body: { ...full(view(getJob(v.job.id)!)), message: `Starting it over from the beginning (up to ${usdText(cap)}).` } };
      });
    },
  },
  {
    method: 'POST', path: '/jobs/{id}/open', scope: 'act',
    handler: (ctx) => {
      const v = load(ctx);
      const now = (need().now ?? Date.now)();
      const job = updateJob(v.job.id, { seen_at: now })!;
      return { body: full(view(job)) };
    },
  },
  ...(['pause', 'resume', 'cancel'] as const).map((action): Route => ({
    method: 'POST', path: `/jobs/{id}/${action}`, scope: 'act',
    handler: async (ctx) => {
      const v = load(ctx);
      if (!RECURRING.has(v.job.kind) || !v.job.schedule_id) throw new ApiError(409, 'not_recurring', 'Only a repeating job or a reminder can be paused, resumed or cancelled. Use Stop for this one.');
      const out = await personAction(() => need().scheduleControl(actingPerson(v.job), action, v.job.schedule_id!));
      if (!out.ok) throw new ApiError(409, 'refused', out.message);
      return { body: { ...full(view(getJob(v.job.id)!)), message: out.message } };
    },
  })),
];
