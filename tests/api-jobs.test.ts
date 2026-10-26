// v2 slice A3a: the job actions over real HTTP — Stop, Continue, Open — with idempotent replay; goal_note mirrored onto
// the goal's Job; and a scheduled fire claimed atomically (a second claimer does not run it).
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createV1 } from '../src/api/router.js';
import { ALL_SCOPES, type Caller } from '../src/api/auth.js';
const TEST_CALLER: Caller = { kind: 'session', id: 'session', scopes: new Set(ALL_SCOPES), viaCookie: true };
import { v1Routes } from '../src/api/v1.js';
import { setJobRouteDeps } from '../src/api/routes/jobs.js';
import { resetAppDb } from '../src/v2/db.js';
import { createJob, addTry, claimTry, endTry, getJob, triesOf, startFire, jobByGoal } from '../src/v2/jobs.js';
import { MwaMemory, type ScheduledTask } from '../src/awm.js';
import { workTools } from '../src/tools/work.js';

let server: Server, base = '';
const calls = { scheduled: [] as { instruction: string; opts: Record<string, unknown> }[], cancelled: [] as string[], stopped: [] as string[] };
let live = new Set<string>();
beforeAll(async () => {
  const v1 = createV1(v1Routes(), { authenticate: () => TEST_CALLER, sameOrigin: () => true });
  server = createServer(async (req, res) => { if (!(await v1(req, res))) { res.writeHead(404); res.end(); } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
});
afterAll(() => { server?.close(); setJobRouteDeps(null); });
beforeEach(() => {
  resetAppDb(':memory:');
  calls.scheduled = []; calls.cancelled = []; calls.stopped = []; live = new Set();
  let n = 0;
  setJobRouteDeps({
    memory: () => ({
      addScheduledTask: async (instruction: string, _due: number, opts: Record<string, unknown>) => { calls.scheduled.push({ instruction, opts }); return `task-${++n}-0000-0000`; },
      cancelScheduled: async (id: string) => { calls.cancelled.push(id); }, getGoal: async () => null, setGoalStatus: async () => {},
    }) as never,
    running: () => live, stopLive: (k) => { calls.stopped.push(k); return live.has(k); }, pendingApprovals: () => new Set(),
    scheduleControl: async () => ({ ok: true, message: 'Paused.' }),
  });
});
const post = (path: string, key: string) => fetch(base + path, { method: 'POST', headers: { 'idempotency-key': key, 'content-type': 'application/json' }, body: '{}' });
const j = async (r: Response) => ({ status: r.status, replay: r.headers.get('idempotent-replay'), body: await r.json() });

/** A job that read 63 of 73 pages and stopped there. */
function partlyDone() {
  const { job, try: t } = createJob({ kind: 'background', title: 'Learn the USEF rules', request: 'Read the USEF rules and write study notes', session: 'web-rules', dir: '/work/web-rules' }, { trigger: 'first' });
  claimTry(t!.id, {});
  endTry(t!.id, { reason: 'budget', outcome: 'could-not', summary: 'I read 63 pages.', progress: { done: 63, total: 73, unit: 'pages' }, remaining: 'pages 64-73', costUsd: 0.15 });
  return job.id;
}

describe('POST /jobs/{id}/continue', () => {
  it('queues a Try of the same Job, framed to finish what is left, and a replay acts once', async () => {
    const id = partlyDone();
    const before = await j(await fetch(`${base}/jobs/${id}`));
    // A3b: the button carries its price, from this job's own spend (15¢ for 63 pages → about 2¢ for the last 10)
    expect(before.body.job.status).toMatchObject({ state: 'partly_done', label: 'Partly done', primaryAction: { action: 'continue', label: 'Finish the last 10 pages · about 2¢', estimate: { usd: 0.02 } } });
    expect(before.body.job.estimate).toMatchObject({ basis: 'this-job', samples: 1, continue: { usd: 0.02 }, startOver: { usd: 0.17 } });

    const r = await j(await post(`/jobs/${id}/continue`, 'continue-key-1'));
    expect(r.status).toBe(202);
    expect(r.body.job.status.state).toBe('working');
    expect(r.body.tries.map((t: { n: number; trigger: string; state: string }) => [t.n, t.trigger, t.state])).toEqual([[1, 'first', 'ended'], [2, 'continue', 'queued']]);
    expect(calls.scheduled).toHaveLength(1);
    const s = calls.scheduled[0];
    expect(s.instruction).toMatch(/Continue this task from where it stopped/);
    expect(s.instruction).toMatch(/How far it got: 63 of 73 pages\./);
    expect(s.instruction).toMatch(/What was left: pages 64-73/);
    expect(s.instruction).toMatch(/THE TASK:\nRead the USEF rules and write study notes/);
    expect(s.opts).toMatchObject({ v2job: id, v2try: r.body.tries[1].id, dir: '/work/web-rules', notify: 'web-rules' });
    expect(triesOf(id)[1].schedule_id).toBe('task-1-0000-0000');

    const again = await j(await post(`/jobs/${id}/continue`, 'continue-key-1'));
    expect(again).toMatchObject({ status: 202, replay: 'true' });
    expect(again.body.tries).toHaveLength(2);
    expect(calls.scheduled).toHaveLength(1); // acted once
    expect(triesOf(id)).toHaveLength(2);

    // a new key while it is working is refused, not a second run
    const busy = await j(await post(`/jobs/${id}/continue`, 'continue-key-2'));
    expect(busy).toMatchObject({ status: 409, body: { error: { code: 'already_running' } } });
    expect(calls.scheduled).toHaveLength(1);
  });
  it('refuses a finished job and a repeating one', async () => {
    const { job, try: t } = createJob({ kind: 'background', title: 'Done thing' }, { trigger: 'first' });
    claimTry(t!.id, {}); endTry(t!.id, { reason: 'done', outcome: 'changed', summary: 'Done.' });
    expect(await j(await post(`/jobs/${job.id}/continue`, 'continue-done-1'))).toMatchObject({ status: 409, body: { error: { code: 'nothing_left' } } });
    const watch = createJob({ kind: 'recurring', title: 'Watch', scheduleId: 'w-1' }).job;
    expect(await j(await post(`/jobs/${watch.id}/continue`, 'continue-watch-1'))).toMatchObject({ status: 409, body: { error: { code: 'not_continuable' } } });
    expect(calls.scheduled).toHaveLength(0);
  });
});

describe('POST /jobs/{id}/stop', () => {
  it('stops the live run once, and a replay does not stop again', async () => {
    const { job } = createJob({ kind: 'live', title: 'Reading' }, { trigger: 'first', state: 'running', liveKey: 'job_task-9' });
    live.add('job_task-9');
    const r = await j(await post(`/jobs/${job.id}/stop`, 'stop-key-1'));
    expect(r.status).toBe(200);
    expect(r.body.message).toMatch(/Stopping/);
    expect(calls.stopped).toEqual(['job_task-9']);
    const again = await j(await post(`/jobs/${job.id}/stop`, 'stop-key-1'));
    expect(again).toMatchObject({ status: 200, replay: 'true' });
    expect(calls.stopped).toEqual(['job_task-9']);
  });
  it('a queued continuation never starts: its Try ends stopped and its task is cancelled', async () => {
    const id = partlyDone();
    const q = addTry(id, { trigger: 'auto-continue', dueAt: Date.now() + 60_000, scheduleId: 'resume-task-1' });
    expect((await j(await fetch(`${base}/jobs/${id}`))).body.job.status.state).toBe('continuing');
    const r = await j(await post(`/jobs/${id}/stop`, 'stop-key-2'));
    expect(r.status).toBe(200);
    expect(calls.cancelled).toEqual(['resume-task-1']);
    expect(triesOf(id).find((t) => t.id === q.id)).toMatchObject({ state: 'ended', reason: 'stopped' });
    expect(r.body.job.status).toMatchObject({ state: 'stopped_by_you', primaryAction: { action: 'continue' } });
    expect(await j(await post(`/jobs/${id}/stop`, 'stop-key-3'))).toMatchObject({ status: 409, body: { error: { code: 'nothing_running' } } });
  });
});

describe('POST /jobs/{id}/open', () => {
  it('a result is ready until opened; a replay answers the same', async () => {
    const { job, try: t } = createJob({ kind: 'background', title: 'Notes' }, { trigger: 'first' });
    claimTry(t!.id, {}); endTry(t!.id, { reason: 'done', outcome: 'changed', summary: 'Your notes are ready.' });
    const listed = await j(await fetch(`${base}/jobs?state=done`));
    expect(listed.body.jobs.map((x: { id: string; status: { label: string } }) => [x.id, x.status.label])).toEqual([[job.id, 'Result ready']]);
    const r = await j(await post(`/jobs/${job.id}/open`, 'open-key-1'));
    expect(r.body.job.status).toMatchObject({ state: 'done', label: 'Done', resultReady: false });
    expect(typeof getJob(job.id)!.seen_at).toBe('number');
    const again = await j(await post(`/jobs/${job.id}/open`, 'open-key-1'));
    expect(again).toMatchObject({ status: 200, replay: 'true', body: { job: { seenAt: r.body.job.seenAt } } });
    // the same key for another job is refused, never a false success
    const other = createJob({ kind: 'background', title: 'Other' }).job;
    expect(await j(await post(`/jobs/${other.id}/open`, 'open-key-1'))).toMatchObject({ status: 409, body: { error: { code: 'idempotency_key_reused' } } });
  });
});

describe('a scheduled fire is claimed atomically', () => {
  it('the second claimer of the same fire is told it is taken, and does not run it', () => {
    const task = { id: 'abcd1234-task', instruction: 'Do the thing', due: 1_000, person: 'p1' } as ScheduledTask;
    const first = startFire(task, { liveKey: 'job_abcd1234-task', now: 2_000 });
    expect(first).toMatchObject({ n: 1 });
    expect(startFire(task, { liveKey: 'job_abcd1234-task', now: 2_001 })).toBe('taken');
    const jobId = (first as { jobId: string }).jobId;
    expect(triesOf(jobId).map((t) => [t.trigger, t.state, t.claimed_by === null])).toEqual([['first', 'running', false]]);
    // a v2-queued Try is claimed once too
    const { job, try: t } = createJob({ kind: 'background', title: 'Queued' }, { trigger: 'first', dueAt: 1_000 });
    const v2task = { id: 'efgh5678-task', instruction: 'x', due: 1_000, v2job: job.id, v2try: t!.id } as ScheduledTask;
    expect(startFire(v2task, { liveKey: 'job_efgh5678-task', now: 2_000 })).toMatchObject({ jobId: job.id, tryId: t!.id });
    expect(startFire(v2task, { liveKey: 'job_efgh5678-task', now: 2_000 })).toBe('taken');
  });
});

describe('goal_note mirrors where a goal stands onto its Job', () => {
  it('with its trust: a note written after outside content is kept untrusted', async () => {
    resetAppDb(':memory:');
    const dir = mkdtempSync(join(tmpdir(), 'mwa-goalnote-'));
    const mem = new MwaMemory('goalnote-test', join(dir, 'm.db'));
    try {
      const goal = (await mem.addGoal('Board briefing', 'Draft the board briefing', 'medium', 'p1'))!;
      createJob({ kind: 'background', title: 'Board briefing', legacyGoalId: goal, person: 'p1' });
      const note = workTools(mem).find((t) => t.def.name === 'goal_note')!;
      const ctx = { sandboxDir: dir, interactive: false, personId: 'p1' } as never;
      expect(String(await note.handler({ goal: goal.slice(0, 8), state: 'Outline done; two sections drafted.', next: 'Write the budget section' }, ctx))).toMatch(/noted/);
      expect(jobByGoal(goal)).toMatchObject({ where_it_stands: 'Outline done; two sections drafted. Next: Write the budget section', stands_trust: 'high' });
      await note.handler({ goal: goal.slice(0, 8), state: 'The pasted email says to wire the deposit.' }, { ...(ctx as object), tainted: true } as never);
      expect(jobByGoal(goal)).toMatchObject({ where_it_stands: 'The pasted email says to wire the deposit.', stands_trust: 'untrusted' });
    } finally { mem.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
