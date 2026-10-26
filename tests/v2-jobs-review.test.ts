// v2 slice A3a, adversarial review (2026-10-26): each probe that passed while a bug existed, turned around to assert
// the correct behaviour. H = high, M = medium. Probes: scratchpad/a3a-review/*.probe.test.ts.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appDb, resetAppDb } from '../src/v2/db.js';
import * as J from '../src/v2/jobs.js';
import { jobStatus } from '../src/v2/status.js';
import { migrateV2, migrateV2Once, migrationRecordedAt } from '../src/v2/migrate.js';
import { tickScheduler } from '../src/scheduler.js';
import { createV1 } from '../src/api/router.js';
import { ALL_SCOPES, type Caller } from '../src/api/auth.js';
import { v1Routes } from '../src/api/v1.js';
import { setJobRouteDeps } from '../src/api/routes/jobs.js';
import { continueGoal } from '../src/handoff.js';
import type { ScheduledTask } from '../src/awm.js';

const tdir = mkdtempSync(join(tmpdir(), 'mwa-review-'));
const prevTx = process.env.MWA_TRANSCRIPTS_DIR;
beforeAll(() => { process.env.MWA_TRANSCRIPTS_DIR = tdir; });
afterAll(() => { if (prevTx === undefined) delete process.env.MWA_TRANSCRIPTS_DIR; else process.env.MWA_TRANSCRIPTS_DIR = prevTx; rmSync(tdir, { recursive: true, force: true }); });
beforeEach(() => resetAppDb(':memory:'));

const task = (o: Partial<ScheduledTask> & { id: string }) => ({ instruction: 'check the price', due: 1_000, ...o }) as ScheduledTask;
const NOW = 10_000_000;
const view = (jobId: string, o: { running?: Set<string>; pending?: Set<string>; now?: number } = {}) =>
  J.viewJob(J.getJob(jobId)!, { running: o.running ?? new Set(), pending: o.pending ?? new Set(), now: o.now ?? NOW });
/** A process that crashed: its claim stays in app.db, its heartbeat is gone. */
const crashed = (tryId: string) => appDb().prepare(`UPDATE tries SET claimed_by = 'deadbeef0000' WHERE id = ?`).run(tryId);
/** Another process, alive (fresh heartbeat naming a live pid). */
const ALIVE = 'a11ce0a11ce0';
const aliveElsewhere = () => writeFileSync(join(tdir, `.instance-${ALIVE}`), String(process.pid));

describe('H1 a Try stranded by a crash is reaped, never "working" forever', () => {
  it('a recurring fire: status is not working, the reaper ends it, and the fire can run again', () => {
    J.onScheduled('aaaaaaaa-1111', 'check the price', 1_000, { recur: 'every:60' });
    const t = task({ id: 'aaaaaaaa-1111', recur: 'every:60' });
    const first = J.startFire(t, { liveKey: 'job_aaaaaaaa-1111', now: 2_000 }) as { jobId: string; tryId: string };
    crashed(first.tryId); // the process dies before rescheduling and finishing
    expect(view(first.jobId).status.state).not.toBe('working');
    expect(J.reapDeadTries().map((x) => x.id)).toEqual([first.tryId]);
    expect(J.getTry(first.tryId)).toMatchObject({ state: 'ended', ended_by: 'reaper', reason: 'error' });
    const again = J.startFire(t, { liveKey: 'job_aaaaaaaa-1111', now: 9_000_000 });
    expect(again).toMatchObject({ jobId: first.jobId, n: 2 });
    expect(J.getTry((again as { tryId: string }).tryId)!.trigger).toBe('fire');
  });
  it('a v2 one-off (v2try=): the restored fire is claimed by a new Try, picking up after the restart', () => {
    const { job, try: tr } = J.createJob({ kind: 'background', title: 'x' }, { trigger: 'first', dueAt: 1_000 });
    J.onScheduled('bbbbbbbb-1111', 'do x', 1_000, { v2job: job.id, v2try: tr!.id });
    const t = task({ id: 'bbbbbbbb-1111', v2job: job.id, v2try: tr!.id });
    const c = J.startFire(t, { liveKey: 'job_bbbbbbbb-1111', now: 2_000 }) as { tryId: string };
    crashed(c.tryId);
    J.reapDeadTries();
    const again = J.startFire(t, { liveKey: 'job_bbbbbbbb-1111', now: 9_000_000 }) as { tryId: string };
    expect(J.getTry(again.tryId)).toMatchObject({ n: 2, trigger: 'resume-after-restart', state: 'running' });
  });
  it('a chat whose run died: its first Try is reaped, and the job offers Continue, not "working"', () => {
    const q = J.queueContinuation({ dueAt: NOW + 60_000, chat: { kind: 'live', title: 'Read it all', request: 'Read it all', session: 'web-x', startedAt: 1 } })!;
    crashed(q.created!.tryId);
    J.endQueued(q.jobId, 'x'); // (its continuation was stopped too)
    J.reapDeadTries();
    const v = view(q.jobId);
    expect(v.status).toMatchObject({ state: 'stopped_by_you' });
    expect(J.getTry(q.created!.tryId)).toMatchObject({ state: 'ended', ended_by: 'reaper' });
  });
  it('the status reads a dead claimer\'s running Try as cut off even before the reaper runs', () => {
    const st = jobStatus({ kind: 'background' }, [{ n: 1, trigger: 'first', state: 'running', claimed_by: 'gone', started_at: 5 }], { running: new Set(), pendingApprovals: 0, now: NOW, claimerAlive: () => false });
    expect(st).toMatchObject({ state: 'stopped', detail: 'It was cut off when the helper stopped.', primaryAction: { action: 'continue' } });
    // …but a live claimer elsewhere is working
    const live = jobStatus({ kind: 'background' }, [{ n: 1, trigger: 'first', state: 'running', claimed_by: 'other' }], { running: new Set(), pendingApprovals: 0, now: NOW, claimerAlive: () => true });
    expect(live.state).toBe('working');
  });
});

describe('M7 restart recovery reaps only dead claimers', () => {
  it('a live process\'s Try of the same recurring task is left running, and its real end is recorded', () => {
    aliveElsewhere();
    const id = 'abababab-1';
    J.onScheduled(id, 'check', 1_000, { recur: 'every:60' });
    const old = J.startFire(task({ id, recur: 'every:60' }), { liveKey: `job_${id}`, now: 2_000 }) as { tryId: string };
    crashed(old.tryId); // serve, crashed
    const tg = J.startFire(task({ id, due: 3_600_000, recur: 'every:60' }), { liveKey: `job_${id}`, now: 3_600_000 }) as { tryId: string };
    appDb().prepare('UPDATE tries SET claimed_by = ? WHERE id = ?').run(ALIVE, tg.tryId); // Telegram, running now
    J.restartCutOff(id, 3_700_000);
    expect(J.getTry(old.tryId)!.state).toBe('ended');
    expect(J.getTry(tg.tryId)!.state).toBe('running');
    expect(J.endTry(tg.tryId, { reason: 'done', outcome: 'changed', summary: 'real result' })).toMatchObject({ summary: 'real result' });
    expect(J.reapDeadTries()).toEqual([]);
  });
});

describe('H2 one fire runs once, even for a second process with a stale list', () => {
  it('a one-off the model scheduled (no v2try): finished by A, B is told it is taken', () => {
    J.onScheduled('cccccccc-1111', 'write the report', 1_000, { person: 'p' });
    const t = task({ id: 'cccccccc-1111', instruction: 'write the report' });
    const a = J.startFire(t, { liveKey: 'job_cccccccc-1111', now: 2_000 }) as { tryId: string; jobId: string };
    J.finishTry(a.tryId, { reason: 'done', outcome: 'changed', summary: 'done' });
    expect(J.startFire(t, { liveKey: 'job_cccccccc-1111', now: 3_000 })).toBe('taken');
    expect(J.triesOf(a.jobId)).toHaveLength(1);
  });
  it('a recurring fire at the same due, already finished: taken', () => {
    J.onScheduled('dddddddd-1111', 'check', 1_000, { recur: 'every:60' });
    const t = task({ id: 'dddddddd-1111', recur: 'every:60' });
    const a = J.startFire(t, { liveKey: 'job_dddddddd-1111', now: 2_000 }) as { tryId: string };
    J.finishTry(a.tryId, { reason: 'done', outcome: 'changed' });
    expect(J.startFire(t, { liveKey: 'job_dddddddd-1111', now: 3_000 })).toBe('taken');
  });
  it('the scheduler reads the task again before claiming: one already fired elsewhere is not run', async () => {
    const t = task({ id: 'eeeeeeee-2222', instruction: 'write the report' });
    let runs = 0;
    const memory = {
      async pendingScheduled() { return [t]; }, // a stale list
      async getScheduled() { return { id: t.id, status: 'done', instruction: t.instruction, due: t.due, paused: false }; }, // fired by the other process
      async completeScheduled() { /* */ }, async rescheduleTask() { /* */ }, async setScheduledSignature() { /* */ },
    } as never;
    const outRoot = mkdtempSync(join(tmpdir(), 'mwa-h2-'));
    try {
      await tickScheduler({ memory, brain: {} as never, worker: {} as never, outRoot, now: () => 10_000, checksAllowed: false, watchGate: null,
        budgetHold: () => ({ held: false, usedUsd: 0, budgetUsd: null }), onFire: async () => { /* */ }, runAgent: (async () => { runs++; return { summary: 'ok', reason: 'done' }; }) as never });
    } finally { rmSync(outRoot, { recursive: true, force: true }); }
    expect(runs).toBe(0);
  });
});

describe('H3 cancel then Undo: the restored task runs', () => {
  it('the cancelled Try is queued again and claimed', () => {
    const { job, try: tr } = J.createJob({ kind: 'background', title: 'x' }, { trigger: 'first', dueAt: 1_000 });
    J.onScheduled('ffffffff-1111', 'do x', 1_000, { v2job: job.id, v2try: tr!.id });
    J.onScheduleChanged('ffffffff-1111', 'canceled');
    expect(J.getTry(tr!.id)!.state).toBe('ended');
    J.onScheduleChanged('ffffffff-1111', 'uncanceled');
    expect(J.getTry(tr!.id)!.state).toBe('queued');
    expect(J.startFire(task({ id: 'ffffffff-1111', v2job: job.id, v2try: tr!.id }), { liveKey: 'job_ffffffff-1111', now: 2_000 })).toMatchObject({ tryId: tr!.id });
  });
});

describe('statuses (H4c, M3, M4, M5, M6, M8)', () => {
  const ctx = { running: new Set<string>(), pendingApprovals: 0, now: NOW };
  it('H4c a person\'s Continue put off by a budget hold: "Waiting to continue", no second Continue', () => {
    const st = jobStatus({ kind: 'background' }, [{ n: 1, trigger: 'first', state: 'ended', reason: 'stopped', ended_at: 5 }, { n: 2, trigger: 'continue', state: 'queued', due_at: NOW + 3_600_000 }], ctx);
    expect(st).toMatchObject({ state: 'scheduled', label: 'Waiting to continue', primaryAction: { action: 'stop' } });
    expect(st.detail).toMatch(/^On hold until .+; it will pick up where it stopped\.$/);
  });
  it('M3 a paused one-off with a past-due queued Try is paused, not "Starting now"', () => {
    const st = jobStatus({ kind: 'background', status: 'paused' }, [{ n: 1, trigger: 'first', state: 'queued', due_at: 1 }], ctx);
    expect(st).toMatchObject({ state: 'stopped_by_you', label: 'Paused', primaryAction: { action: 'resume' } });
  });
  it('M4 a recurring job never offers Continue or Start over: budget and restart fires say what happened and the next run', () => {
    const next = NOW + 3_600_000;
    const budget = jobStatus({ kind: 'recurring', status: 'active', next_due_at: next }, [{ n: 1, trigger: 'fire', state: 'ended', reason: 'budget', ended_at: 5 }], ctx);
    expect(budget).toMatchObject({ state: 'scheduled' });
    expect(budget.detail).toMatch(/^The last run ran out of room before it finished\. Next run .+\.$/);
    const cut = jobStatus({ kind: 'recurring', status: 'active', next_due_at: next }, [{ n: 1, trigger: 'fire', state: 'ended', reason: 'error', outcome: 'could-not', summary: 'Cut off by a restart.', ended_by: 'reaper', ended_at: 5 }], ctx);
    expect(cut.detail).toMatch(/^The last run was cut off by a restart\. Next run /);
    for (const s of [budget, cut]) expect(['continue', 'start-over']).not.toContain(s.primaryAction?.action);
  });
  it('M5 a quiet fire (not delivered) does not make the job "Result ready" again', () => {
    const id = 'cdcdcdcd-1';
    J.onScheduled(id, 'watch', 1_000, { recur: 'every:15', deliver: 'changed' });
    const job = J.jobBySchedule(id)!;
    J.updateJob(job.id, { seen_at: 2_500 });
    const f = J.startFire(task({ id, instruction: 'watch', due: 3_000, recur: 'every:15' }), { liveKey: `job_${id}`, now: 3_000 }) as { tryId: string };
    J.finishTry(f.tryId, { reason: 'done', outcome: 'no-change', summary: 'Same price.', endedAt: 4_000, delivered: false });
    expect(view(job.id, { now: 5_000 }).status.resultReady).toBe(false);
    const g = J.startFire(task({ id, instruction: 'watch', due: 5_000, recur: 'every:15' }), { liveKey: `job_${id}`, now: 5_000 }) as { tryId: string };
    J.finishTry(g.tryId, { reason: 'done', outcome: 'changed', summary: 'Price dropped to $1.10.', endedAt: 6_000, delivered: true });
    expect(view(job.id, { now: 7_000 }).status).toMatchObject({ resultReady: true, label: 'Result ready' });
  });
  it('M6 "None", "n/a", "nothing", "-" or empty remaining is no remaining', () => {
    for (const r of ['None', 'n/a', 'nothing', '-', '', 'Nothing left.']) {
      const st = jobStatus({ kind: 'background' }, [{ n: 1, trigger: 'first', state: 'ended', reason: 'done', outcome: 'changed', remaining: r, ended_at: 5 }], ctx);
      expect(`${r}: ${st.state}`).toBe(`${r}: done`);
    }
    const { try: t } = J.createJob({ kind: 'background', title: 'x' }, { trigger: 'first' });
    J.claimTry(t!.id, {});
    expect(J.endTry(t!.id, { reason: 'done', remaining: 'N/A' })!.remaining).toBe(null);
  });
  it('M8 a watch that cancelled itself says so; the person\'s cancel says "Stopped by you"', () => {
    J.onScheduled('11111111-aaaa', 'watch', 1_000, { recur: 'every:60' });
    J.onScheduled('22222222-aaaa', 'watch', 1_000, { recur: 'every:60' });
    J.onScheduleChanged('11111111-aaaa', 'canceled'); // the model's schedule_cancel
    J.personAction(() => J.onScheduleChanged('22222222-aaaa', 'canceled')); // the app's Cancel
    expect(view(J.jobBySchedule('11111111-aaaa')!.id).status).toMatchObject({ state: 'stopped', label: 'Stopped itself' });
    expect(view(J.jobBySchedule('22222222-aaaa')!.id).status).toMatchObject({ state: 'stopped_by_you', label: 'Stopped by you' });
  });
  it('M8 a goal the model marked done ends its waiting Try as "Finished — it decided it was done"; the person\'s mark says so', () => {
    for (const [goal, person] of [['g-model', false], ['g-person', true]] as const) {
      const { job, try: t } = J.createJob({ kind: 'background', title: goal, legacyGoalId: goal }, { trigger: 'continue', dueAt: NOW + 3_600_000, scheduleId: `${goal}-task-0001` });
      if (person) J.personAction(() => J.onGoalStatus(goal, 'done')); else J.onGoalStatus(goal, 'done');
      J.endScheduleTries(`${goal}-task-0001`, 'goal-done', 'Its goal was marked done, so it did not run.');
      expect(J.getTry(t!.id)!.ended_by).toBe('goal-done');
      expect(view(job.id).status).toMatchObject(person ? { state: 'stopped_by_you', detail: 'You marked it done.' } : { state: 'done', label: 'Finished', detail: 'Finished — it decided it was done.' });
    }
  });
});

describe('M3 the job follows its tasks', () => {
  it('pausing a goal\'s later task pauses the job; moving a task moves its queued Try', () => {
    const { job } = J.createJob({ kind: 'background', title: 'Newsletter', legacyGoalId: 'g-1', scheduleId: 'first-task-0001' });
    const t = J.addTry(job.id, { trigger: 'continue', dueAt: 5_000, scheduleId: 'later-task-0001' });
    J.onScheduleChanged('later-task-0001', 'paused');
    expect(J.getJob(job.id)!.status).toBe('paused');
    J.onScheduleChanged('later-task-0001', 'moved', 77_000);
    expect(J.getTry(t.id)!.due_at).toBe(77_000);
    J.onScheduleChanged('later-task-0001', 'resumed', 88_000);
    expect(J.getJob(job.id)!.status).toBe('active');
    expect(J.getTry(t.id)!.due_at).toBe(88_000);
  });
  it('a recurring job knows its next run', () => {
    J.onScheduled('33333333-aaaa', 'watch', 1_000, { recur: 'every:60' });
    J.onScheduleChanged('33333333-aaaa', 'moved', 3_601_000);
    expect(J.jobBySchedule('33333333-aaaa')!.next_due_at).toBe(3_601_000);
  });
});

describe('lows: goal follow-ups and prefixes', () => {
  it('a follow-up the model scheduled under a goal is its own Job; the goal\'s own Continue is a Try of the goal\'s Job', () => {
    const { job } = J.createJob({ kind: 'background', title: 'Board briefing', legacyGoalId: 'goal-1' });
    J.onScheduled('44444444-aaaa', 'Remind Dana about the board deck', NOW, { goal: 'goal-1' });
    expect(J.jobBySchedule('44444444-aaaa')!.id).not.toBe(job.id);
    J.onScheduled('55555555-aaaa', 'Continue working on the person\'s goal "Board briefing"', NOW, { goal: 'goal-1', task: 'Continue: Board briefing' });
    expect(J.jobBySchedule('55555555-aaaa')!.id).toBe(job.id);
  });
  it('a resume finds its job by the exact 8-character prefix (an indexed column), not a LIKE pattern', () => {
    J.onScheduled('66666666-aaaa-bbbb', 'long task', 1_000, {});
    expect(J.jobByPrefix('66666666')!.schedule_id).toBe('66666666-aaaa-bbbb');
    expect(J.jobByPrefix('6666666%')).toBe(undefined);
    expect(J.jobByPrefix('666666')).toBe(undefined);
    const plan = appDb().prepare(`EXPLAIN QUERY PLAN SELECT * FROM jobs WHERE schedule_prefix = ?`).all('66666666') as { detail: string }[];
    expect(plan.map((p) => p.detail).join(' ')).toMatch(/jobs_schedule_prefix/);
  });
});

describe('M1/M2 migration', () => {
  it('a re-run does not count a fire that v2 recorded live (cost not doubled)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mwa-m1-'));
    const notifyFile = join(dir, 'notifications.jsonl');
    const id = 'ffffffff-1111-2222-3333-444444444444';
    J.onScheduled(id, 'check the price', 1_000, { recur: 'every:60' });
    const t = task({ id, recur: 'every:60' });
    const a = J.startFire(t, { liveKey: `job_${id}`, now: 2_000 }) as { tryId: string; jobId: string };
    const fire = `${id.slice(0, 8)}-3000`;
    J.finishTry(a.tryId, { reason: 'done', outcome: 'changed', summary: 'Price is $1', endedAt: 3_000, costUsd: 0.02, fireId: fire, delivered: true });
    writeFileSync(notifyFile, JSON.stringify({ ts: 3_000, job: id, fire, instruction: 'check the price', summary: 'Price is $1', reason: 'done', outcome: 'changed', costUsd: 0.02 }) + '\n');
    // an older live fire with no fire id (recorded before the fire id existed), matched by its job and time
    const b = J.startFire({ ...t, due: 50_000 }, { liveKey: `job_${id}`, now: 50_000 }) as { tryId: string };
    J.finishTry(b.tryId, { reason: 'done', outcome: 'changed', endedAt: 51_000, costUsd: 0.03 });
    writeFileSync(notifyFile, JSON.stringify({ ts: 51_500, job: id, fire: `${id.slice(0, 8)}-51500`, instruction: 'check the price', summary: 'x', reason: 'done', costUsd: 0.03 }) + '\n', { flag: 'a' });
    const mem = { listGoals: async () => [], listGoalRecords: async () => [], pendingScheduled: async () => [{ ...t, due: 3_600_000 }], getScheduled: async () => null };
    await migrateV2(mem as never, { notifyFile });
    await migrateV2(mem as never, { notifyFile });
    expect(J.triesOf(a.jobId).map((x) => x.cost_usd)).toEqual([0.02, 0.03]);
    rmSync(dir, { recursive: true, force: true });
  });
  it('a store that cannot be read: the migration fails and does NOT record itself done; the next start does it', async () => {
    let broken = true;
    const mem = {
      listGoals: async () => [], listGoalRecords: async () => [], pendingScheduled: async () => [], getScheduled: async () => null,
      listGoalsStrict: async () => { if (broken) throw new Error('database is locked'); return []; },
      listGoalRecordsStrict: async () => [], pendingScheduledStrict: async () => [],
    };
    await expect(migrateV2Once(mem as never, {})).rejects.toThrow(/locked/);
    expect(migrationRecordedAt()).toBe(null);
    broken = false;
    const r = await migrateV2Once(mem as never, {});
    expect(r?.dryRun).toBe(false);
    expect(typeof migrationRecordedAt()).toBe('number');
    expect(await migrateV2Once(mem as never, {})).toBe(null);
  });
});

// ── over HTTP ───────────────────────────────────────────────────────────────────────────────────────────────────
let server: Server, base = '';
const OWNER: Caller = { kind: 'device', id: 'phone-1', scopes: new Set(ALL_SCOPES), viaCookie: false };
let pending = new Set<string>();
let approvalCalls = 0;
const scheduled: { instruction: string; opts: Record<string, unknown> }[] = [];
const controls: { person: string; action: string; id: string }[] = [];
beforeAll(async () => {
  const v1 = createV1(v1Routes(), { authenticate: () => OWNER, sameOrigin: () => true });
  server = createServer(async (req, res) => { if (!(await v1(req, res))) { res.writeHead(404); res.end(); } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
});
afterAll(() => { server?.close(); setJobRouteDeps(null); });
function routeDeps() {
  scheduled.length = 0; controls.length = 0; pending = new Set(); approvalCalls = 0;
  let n = 0;
  const tick = () => new Promise((r) => setTimeout(r, 15));
  const tasks: Record<string, unknown>[] = [];
  // a goal store that behaves like MwaMemory: async, and addScheduledTask fires the store hook
  const mem = {
    getGoal: async (id: string) => { await tick(); return { id, title: 'Write the newsletter', detail: 'the newsletter', status: 'blocked', person: 'web-robert', priority: 'medium' }; },
    getGoalRecord: async () => { await tick(); return null; },
    pendingScheduled: async () => { await tick(); return tasks; },
    setGoalStatus: async () => { await tick(); },
    addScheduledTask: async (instruction: string, due: number, opts: Record<string, unknown>) => {
      await tick(); const id = `task-${++n}-0000-0000`; tasks.push({ id, instruction, due, ...opts }); scheduled.push({ instruction, opts });
      J.onScheduled(id, instruction, due, opts as never); return id;
    },
    cancelScheduled: async () => {}, close: () => {},
  };
  setJobRouteDeps({
    memory: () => mem as never, running: () => new Set(), stopLive: () => false,
    pendingApprovals: () => { approvalCalls++; return pending; },
    scheduleControl: async (person, action, id) => { controls.push({ person, action, id }); return { ok: true, message: 'ok' }; },
    continueGoal: async (goalId, personId) => continueGoal(mem as never, { goalId, personId, workspace: '/ws', holdsReservation: true }),
  });
}
const post = (path: string, key: string) => fetch(base + path, { method: 'POST', headers: { 'idempotency-key': key, 'content-type': 'application/json' }, body: '{}' });
const j = async (r: Response) => ({ status: r.status, body: await r.json() });

describe('H4 Continue beside a queued run, and two taps at once', () => {
  beforeEach(routeDeps);
  it('(a) an approval pending and an automatic continuation queued: Continue is refused, nothing else is queued', async () => {
    const { job, try: t } = J.createJob({ kind: 'background', title: 'Read the rules', request: 'Read the rules' }, { trigger: 'first' });
    J.claimTry(t!.id, {});
    J.endTry(t!.id, { reason: 'budget', outcome: 'could-not', staged: ['appr-1'] });
    J.queueContinuation({ jobId: job.id, dueAt: Date.now() + 60_000 });
    pending = new Set(['appr-1']);
    const r = await j(await post(`/jobs/${job.id}/continue`, 'k-cont-0001'));
    expect(r).toMatchObject({ status: 409, body: { error: { code: 'already_running' } } });
    expect(J.triesOf(job.id).filter((x) => x.state === 'queued')).toHaveLength(1);
    expect(scheduled).toHaveLength(0);
  });
  it('(b) two Continue taps on a goal job at once: one is accepted, one task is scheduled', async () => {
    const { job, try: t } = J.createJob({ kind: 'background', title: 'Write the newsletter', request: 'the newsletter', legacyGoalId: 'g-1', person: 'web-robert', legacyKey: 'goal:g-1' }, { trigger: 'first' });
    J.claimTry(t!.id, {});
    J.endTry(t!.id, { reason: 'budget', outcome: 'could-not', remaining: 'the writing' });
    const [a, b] = await Promise.all([post(`/jobs/${job.id}/continue`, 'k-goal-0001').then(j), post(`/jobs/${job.id}/continue`, 'k-goal-0002').then(j)]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    expect(scheduled).toHaveLength(1);
    expect(J.triesOf(job.id).map((x) => [x.trigger, x.state])).toEqual([['first', 'ended'], ['continue', 'queued']]);
    // and the legacy Continue (continueGoal) sees the app.db state: already on it
    expect(await continueGoal({ getGoal: async () => ({ id: 'g-1', title: 't', detail: '', status: 'in_progress', person: 'web-robert', priority: 'medium' }), getGoalRecord: async () => null, pendingScheduled: async () => [] } as never,
      { goalId: 'g-1', personId: 'web-robert', workspace: '/ws' })).toMatchObject({ already: true });
  });
  it('a recurring job\'s offered action is never one the route refuses', async () => {
    J.onScheduled('rrrrrrrr-1', 'check', 1_000, { recur: 'every:60' });
    const job = J.jobBySchedule('rrrrrrrr-1')!;
    const f = J.startFire(task({ id: 'rrrrrrrr-1', instruction: 'check', recur: 'every:60' }), { liveKey: 'job_rrrrrrrr-1', now: 2_000 }) as { tryId: string };
    J.finishTry(f.tryId, { reason: 'budget', outcome: 'could-not' });
    const g = await j(await fetch(`${base}/jobs/${job.id}`));
    expect(g.body.job.status.state).toBe('scheduled');
    expect(['continue', 'start-over']).not.toContain(g.body.job.status.primaryAction?.action);
  });
});

describe('M10 a device sees and acts on the owner\'s jobs only', () => {
  beforeEach(routeDeps);
  it('another person\'s job is not listed and is "No such job"; the owner\'s are', async () => {
    const mine = J.createJob({ kind: 'recurring', title: 'My watch', person: 'web-robert', scheduleId: 'mine-task-01' }).job;
    const shared = J.createJob({ kind: 'background', title: 'Untagged', person: undefined }).job;
    const theirs = J.createJob({ kind: 'recurring', title: 'Their watch', person: 'tg-1000000001', scheduleId: 'their-task-1' }).job;
    const list = await j(await fetch(`${base}/jobs`));
    expect(list.body.jobs.map((x: { id: string }) => x.id).sort()).toEqual([mine.id, shared.id].sort());
    expect((await j(await fetch(`${base}/jobs/${theirs.id}`))).status).toBe(404);
    expect((await j(await post(`/jobs/${theirs.id}/pause`, 'k-their-001'))).status).toBe(404);
    expect(controls).toHaveLength(0);
    expect((await j(await post(`/jobs/${mine.id}/pause`, 'k-mine-0001'))).status).toBe(200);
    expect(controls).toEqual([{ person: 'web-robert', action: 'pause', id: 'mine-task-01' }]);
  });
  it('the owner\'s own Telegram id can be named the owner\'s (MWA_OWNER_PERSON)', () => {
    expect(J.ownerOwns('tg-1000000001', { MWA_OWNER_PERSON: 'tg-1000000001' })).toBe(true);
    expect(J.ownerOwns('tg-1000000001', {})).toBe(false);
  });
});

describe('lows: the list is batched and paged; Stop tells the truth about a run elsewhere', () => {
  beforeEach(routeDeps);
  it('GET /jobs reads the approvals once per request, and pages with a cursor', async () => {
    for (let i = 0; i < 7; i++) {
      const { job } = J.createJob({ kind: 'recurring', title: `watch ${i}` });
      for (let k = 0; k < 3; k++) { const t = J.addTry(job.id, { trigger: 'fire', dueAt: k }); J.claimTry(t.id, {}); J.endTry(t.id, { reason: 'done', outcome: 'changed', summary: 'ok' }); }
    }
    const p1 = await j(await fetch(`${base}/jobs?limit=4`));
    expect(approvalCalls).toBe(1);
    expect(p1.body.jobs).toHaveLength(4);
    expect(typeof p1.body.next).toBe('number');
    const p2 = await j(await fetch(`${base}/jobs?limit=4&before=${p1.body.next}`));
    expect(p2.body.jobs).toHaveLength(3);
    expect(p2.body.next).toBe(null);
    expect(new Set([...p1.body.jobs, ...p2.body.jobs].map((x: { id: string }) => x.id)).size).toBe(7);
  });
  it('Stop on a Try running in another live process says it is still finishing there', async () => {
    aliveElsewhere();
    const { job, try: t } = J.createJob({ kind: 'background', title: 'Elsewhere' }, { trigger: 'first', state: 'running', liveKey: 'job_elsewhere', claimedBy: ALIVE });
    const r = await j(await post(`/jobs/${job.id}/stop`, 'k-stop-else1'));
    expect(r).toMatchObject({ status: 409, body: { error: { code: 'running_elsewhere' } } });
    expect(r.body.error.message).toMatch(/still finishing in another MWA process/);
    expect(J.getTry(t!.id)!.state).toBe('running');
  });
});
