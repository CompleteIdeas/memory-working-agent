/**
 * BL-05 — goals own work; a fan-out budget for scheduling (H-8).
 *
 * A run's `schedule` ends the run, so one run schedules once — but every fire of a recurring job
 * could add another job, and every new job could do the same, so the count compounded. The limits are
 * structural (lineage and counts), not textual:
 *   depth ≤ 2, ≤ 2 pending children per job, ≤ 3 jobs per run (a plan's steps share one run id),
 *   ≤ 5 jobs per goal, and no unattended or tainted scheduling at ≥ 50 pending jobs.
 * A goal is an AWM task: done stops its jobs, blocked pauses them, and only an attended, clean
 * conversation may create or change one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent } from '../src/agent.js';
import { tickScheduler } from '../src/scheduler.js';
import { MwaMemory } from '../src/awm.js';
import { fanoutRefusal, newJobDepth, MAX_PENDING } from '../src/fanout.js';
import { workTools } from '../src/tools/work.js';
import type { Provider, ChatResult, ChatInput } from '../src/provider.js';

const prevFast = process.env.MWA_FAST_CHAT;
beforeAll(() => { process.env.MWA_FAST_CHAT = '0'; });
afterAll(() => { if (prevFast === undefined) delete process.env.MWA_FAST_CHAT; else process.env.MWA_FAST_CHAT = prevFast; });

async function withMemory<T>(fn: (dir: string, mem: MwaMemory) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'mwa-fanout-'));
  const mem = new MwaMemory('fanout-test', join(dir, 'f.db'));
  try { return await fn(dir, mem); } finally { mem.close(); rmSync(dir, { recursive: true, force: true }); }
}
/** A brain that schedules once, then finishes. */
function schedulingBrain(sched: Record<string, unknown>): Provider {
  let n = 0;
  return {
    id: 'stub', model: 'stub', price: [0, 0],
    chat: async (input: ChatInput): Promise<ChatResult> => {
      if (!String(input.system ?? '').includes('TRUST BOUNDARY')) return { text: '{}', usage: { input: 1, output: 1 } };
      return { text: JSON.stringify(n++ === 0 ? { action: 'schedule', ...sched } : { action: 'done', summary: 'Checked.', outcome: 'no-change' }), usage: { input: 1, output: 1 } };
    },
  };
}
const base = { depth: 0, childrenOfThisJob: 0, byThisRun: 0, pending: 0, unattendedOrTainted: false, isFire: false };

describe('fanoutRefusal', () => {
  it('allows the ordinary cases', () => {
    expect(fanoutRefusal(base)).toBeNull();
    expect(fanoutRefusal({ ...base, isFire: true, depth: 1, childrenOfThisJob: 1, unattendedOrTainted: true, pending: 10 })).toBeNull();
    expect(fanoutRefusal({ ...base, pending: 500 })).toBeNull(); // a person in a clean, attended chat always may
  });
  it.each([
    ['depth 3', { depth: 3 }, /levels/],
    ['a job with 2 children', { isFire: true, depth: 1, childrenOfThisJob: 2 }, /follow-up jobs/],
    ['a run that scheduled 3', { byThisRun: 3 }, /already scheduled 3/],
    ['a goal with 5 jobs', { goalJobs: 5 }, /that goal already has 5/],
    ['a finished goal', { goalClosed: true }, /finished or no longer exists/],
    ['unattended at the pending cap', { unattendedOrTainted: true, pending: MAX_PENDING }, /already waiting/],
  ])('refuses %s', (_n, over, re) => {
    expect(fanoutRefusal({ ...base, ...over })).toMatch(re);
  });
  it('derives depth from lineage', () => {
    expect(newJobDepth({ isFire: false, interactive: true })).toBe(0);
    expect(newJobDepth({ isFire: false, interactive: false })).toBe(1); // mailbox / inbox
    expect(newJobDepth({ isFire: true, jobDepth: 0 })).toBe(1);
    expect(newJobDepth({ isFire: true, jobDepth: 2 })).toBe(3);
  });
});

describe('a scheduled fire scheduling more jobs', () => {
  const fire = (mem: MwaMemory, dir: string, jobId: string, jobDepth: number, sched: Record<string, unknown> = { instruction: 'Send a follow-up note tomorrow', in_minutes: 1440 }) =>
    runAgent({ instruction: 'Check the supplier inbox', dir, memory: mem, brain: schedulingBrain(sched), worker: schedulingBrain(sched),
      interactive: false, dueNow: true, jobId, jobDepth, budget: { maxSteps: 4, maxWallMs: 20_000 } });

  it('creates a child at depth + 1, tagged with its parent', async () => {
    await withMemory(async (dir, mem) => {
      await fire(mem, dir, 'aaaaaaaa-1111', 1);
      const kids = await mem.pendingScheduled();
      expect(kids).toHaveLength(1);
      expect(kids[0].depth).toBe(2);
      expect(kids[0].parent).toBe('aaaaaaaa');
    });
  }, 30_000);

  it('is refused beyond depth 2 — a budget limit, so it doesn’t turn the fire into a failure', async () => {
    await withMemory(async (dir, mem) => {
      const r = await fire(mem, dir, 'bbbbbbbb-2222', 2);
      expect(await mem.pendingScheduled()).toHaveLength(0);
      expect(r.outcome).toBe('no-change'); // not could-not: a monitor at its cap must not message every fire
      expect(r.history.join(' ')).toMatch(/refused: scheduling another job/);
    });
  }, 30_000);

  it('is refused once its job already has two follow-ups waiting', async () => {
    await withMemory(async (dir, mem) => {
      for (const i of [1, 2]) await mem.addScheduledTask(`Earlier follow-up ${i}`, Date.now() + 3_600_000, { parent: 'cccccccc', depth: 1 });
      await fire(mem, dir, 'cccccccc-3333', 0);
      expect(await mem.pendingScheduled()).toHaveLength(2);
    });
  }, 30_000);

  it('counts a planned run as one run: a fourth job from the same run is refused', async () => {
    await withMemory(async (dir, mem) => {
      for (const i of [1, 2, 3]) await mem.addScheduledTask(`Step job ${i}`, Date.now() + 3_600_000, { byRun: 'dddddddd' });
      await runAgent({ instruction: 'Plan my week', dir, memory: mem, brain: schedulingBrain({ instruction: 'One more', in_minutes: 60 }), worker: schedulingBrain({ instruction: 'x', in_minutes: 60 }),
        interactive: true, rootRunId: 'dddddddd-4444-run', budget: { maxSteps: 4, maxWallMs: 20_000 } });
      expect(await mem.pendingScheduled()).toHaveLength(3);
    });
  }, 30_000);
});

describe('goals', () => {
  it('round-trip, and mirror into AWM’s native task fields', async () => {
    await withMemory(async (_dir, mem) => {
      const id = (await mem.addGoal('Ship the Q3 newsletter', 'sent to the list', 'high', 'robert'))!;
      expect((await mem.getGoal(id.slice(0, 8)))?.status).toBe('open');
      await mem.setGoalStatus(id, 'blocked');
      const g = await mem.getGoal(id);
      expect(g).toMatchObject({ title: 'Ship the Q3 newsletter', detail: 'sent to the list', status: 'blocked', priority: 'high', person: 'robert' });
      const native = (mem as unknown as { store: { getTasks?: (a: string) => { id: string; taskStatus: string }[] } }).store;
      expect(typeof native.getTasks).toBe('function'); // the pinned AWM has it: the mirror must really happen
      expect(native.getTasks!('fanout-test').find((t) => t.id === id)?.taskStatus).toBe('blocked');
    });
  }, 30_000);

  it('the tools: only an attended, clean conversation may set or change a goal', async () => {
    await withMemory(async (_dir, mem) => {
      const t = Object.fromEntries(workTools(mem).map((x) => [x.def.name, x]));
      expect(await t.goal_add.handler({ title: 'Keep the inbox at zero' }, { sandboxDir: '.', interactive: false })).toMatch(/refused: .*unattended/);
      expect(await t.goal_add.handler({ title: 'Keep the inbox at zero' }, { sandboxDir: '.', interactive: true, tainted: true })).toMatch(/refused: .*outside content/);
      const ok = await t.goal_add.handler({ title: 'Keep the inbox at zero', priority: 'high' }, { sandboxDir: '.', interactive: true });
      const short = /goal recorded: (\S+)/.exec(ok)![1];
      expect(await t.goal_list.handler({}, { sandboxDir: '.', interactive: false })).toContain('Keep the inbox at zero');
      // a pasted email can't close the person's goal and stop their jobs
      expect(await t.goal_update.handler({ goal: short, status: 'done' }, { sandboxDir: '.', interactive: true, tainted: true })).toMatch(/refused/);
      expect((await mem.getGoal(short))?.status).toBe('open');
      expect(await t.goal_update.handler({ goal: short, status: 'done' }, { sandboxDir: '.', interactive: true })).toMatch(/now done/);
    });
  }, 30_000);

  it('a job scheduled for a goal is owned by it; a finished goal accepts no more jobs', async () => {
    await withMemory(async (dir, mem) => {
      const id = (await mem.addGoal('Watch the release', ''))!;
      const run = () => runAgent({ instruction: 'watch the release daily', dir, memory: mem, brain: schedulingBrain({ instruction: 'Check the release page', every_minutes: 1440, goal: id.slice(0, 8) }), worker: schedulingBrain({ instruction: 'x', in_minutes: 1 }),
        interactive: true, budget: { maxSteps: 4, maxWallMs: 20_000 } });
      await run();
      expect((await mem.pendingScheduled())[0].goal).toBe(id);
      await mem.setGoalStatus(id, 'done');
      await run();
      expect(await mem.pendingScheduled()).toHaveLength(1); // the second was refused
    });
  }, 30_000);

  it('the scheduler stops a done goal’s jobs, pauses a blocked goal’s, and runs an open goal’s', async () => {
    await withMemory(async (dir, mem) => {
      const [gDone, gBlocked, gOpen] = [await mem.addGoal('A', ''), await mem.addGoal('B', ''), await mem.addGoal('C', '')] as string[];
      await mem.setGoalStatus(gDone, 'done'); await mem.setGoalStatus(gBlocked, 'blocked');
      const past = Date.now() - 1000;
      const tDone = (await mem.addScheduledTask('job of a done goal', past, { goal: gDone, recur: 'every:60' }))!;
      const tBlocked = (await mem.addScheduledTask('job of a blocked goal', past, { goal: gBlocked, recur: 'every:120' }))!;
      await mem.addScheduledTask('job of an open goal', past, { goal: gOpen });
      const ran: string[] = [];
      await tickScheduler({
        memory: mem, brain: {} as never, worker: {} as never, outRoot: dir, onFire: async () => { /* delivered */ },
        runAgent: (async (o: { instruction: string }) => { ran.push(o.instruction); return { summary: 'ok', reason: 'done', outcome: 'changed', steps: 1, toolCalls: 0, costUsd: 0, durationMs: 1 }; }) as never,
      });
      expect(ran).toEqual(['job of an open goal']);
      const left = await mem.pendingScheduled();
      expect(left.find((t) => t.id === tDone)).toBeUndefined();                          // stopped
      expect(left.find((t) => t.id === tBlocked)!.due).toBeGreaterThan(Date.now() + 100 * 60_000); // backed off ~120 min
    });
  }, 30_000);
});

describe('BL-05 review fixes', () => {
  it('a RESUME of a depth-2 job keeps its lineage: it cannot schedule a deeper job', async () => {
    await withMemory(async (dir, mem) => {
      await runAgent({ instruction: 'Resume and finish this task', dir, memory: mem, brain: schedulingBrain({ instruction: 'Follow up', every_minutes: 1440 }), worker: schedulingBrain({ instruction: 'x', in_minutes: 1 }),
        interactive: false, jobId: 'resume01-aaaa', jobLineage: 'eeeeeeee-orig', jobDepth: 2, budget: { maxSteps: 4, maxWallMs: 20_000 } });
      expect(await mem.pendingScheduled()).toHaveLength(0);
    });
  }, 30_000);

  it('a resume counts toward the ORIGINAL job’s children', async () => {
    await withMemory(async (dir, mem) => {
      for (const i of [1, 2]) await mem.addScheduledTask(`child ${i}`, Date.now() + 3_600_000, { parent: 'ffffffff', depth: 1 });
      await runAgent({ instruction: 'Resume and finish this task', dir, memory: mem, brain: schedulingBrain({ instruction: 'Another child', in_minutes: 60 }), worker: schedulingBrain({ instruction: 'x', in_minutes: 1 }),
        interactive: false, jobId: 'resume02-bbbb', jobLineage: 'ffffffff-orig', jobDepth: 0, budget: { maxSteps: 4, maxWallMs: 20_000 } });
      expect(await mem.pendingScheduled()).toHaveLength(2);
    });
  }, 30_000);

  it('a job cannot be attached to another person’s goal', async () => {
    await withMemory(async (dir, mem) => {
      const alice = (await mem.addGoal('Alice’s goal', '', 'medium', 'alice'))!;
      await runAgent({ instruction: 'watch it', dir, memory: mem, brain: schedulingBrain({ instruction: 'Watch', every_minutes: 60, goal: alice.slice(0, 8) }), worker: schedulingBrain({ instruction: 'x', in_minutes: 1 }),
        interactive: true, personId: 'bob', budget: { maxSteps: 4, maxWallMs: 20_000 } });
      expect(await mem.pendingScheduled()).toHaveLength(0);
    });
  }, 30_000);

  it('a conversation that read a local document cannot change a goal', async () => {
    await withMemory(async (_dir, mem) => {
      const t = Object.fromEntries(workTools(mem).map((x) => [x.def.name, x]));
      const id = (await mem.addGoal('Finish the report', ''))!;
      expect(await t.goal_update.handler({ goal: id.slice(0, 8), status: 'done' }, { sandboxDir: '.', interactive: true, readLocal: true })).toMatch(/refused/);
      expect((await mem.getGoal(id))?.status).toBe('open');
    });
  }, 30_000);

  it('the scheduler never stops a job because its goal could not be read, or has gone', async () => {
    await withMemory(async (dir, mem) => {
      const past = Date.now() - 1000;
      const tGone = (await mem.addScheduledTask('job whose goal is gone', past, { goal: 'gone0000-0000-0000' }))!;
      const ran: string[] = [];
      const deps = (memory: unknown) => ({ memory, brain: {} as never, worker: {} as never, outRoot: dir, onFire: async () => { /* */ },
        runAgent: (async (o: { instruction: string }) => { ran.push(o.instruction); return { summary: 'ok', reason: 'done', outcome: 'changed', steps: 1, toolCalls: 0, costUsd: 0, durationMs: 1 }; }) as never });
      // the store can't be read: skip this tick, keep the job
      const broken = Object.create(mem, { getGoal: { value: async () => { throw new Error('SQLITE_BUSY'); } } });
      await tickScheduler(deps(broken) as never);
      expect(ran).toEqual([]);
      expect((await mem.pendingScheduled()).map((t) => t.id)).toContain(tGone);
      // the goal is gone: the job runs, unowned
      await tickScheduler(deps(mem) as never);
      expect(ran).toEqual(['job whose goal is gone']);
    });
  }, 30_000);

  it('a blocked goal pauses a daily job until its own next slot, not a random hour', async () => {
    await withMemory(async (dir, mem) => {
      const g = (await mem.addGoal('Paused work', ''))!;
      await mem.setGoalStatus(g, 'blocked');
      const t = (await mem.addScheduledTask('daily job', Date.now() - 1000, { goal: g, recur: 'daily:07:00' }))!;
      await tickScheduler({ memory: mem, brain: {} as never, worker: {} as never, outRoot: dir, onFire: async () => { /* */ }, runAgent: (async () => ({ summary: '', reason: 'done', steps: 0, toolCalls: 0, costUsd: 0, durationMs: 0 })) as never });
      const due = new Date((await mem.pendingScheduled()).find((x) => x.id === t)!.due);
      expect([due.getHours(), due.getMinutes()]).toEqual([7, 0]);
    });
  }, 30_000);

  it('scheduling the same recurring job again for a goal re-tags it instead of making a second copy', async () => {
    await withMemory(async (_dir, mem) => {
      const g = (await mem.addGoal('Inbox zero', ''))!;
      const a = await mem.addScheduledTask('Sort the inbox', Date.now() + 60_000, { recur: 'every:60' });
      const b = await mem.addScheduledTask('Sort the inbox', Date.now() + 60_000, { recur: 'every:60', goal: g });
      expect(b).toBe(a);
      const jobs = await mem.pendingScheduled();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].goal).toBe(g);
    });
  }, 30_000);
});

describe('BL-05 second review', () => {
  it('a refused follow-up reaches the person ONCE per job, even under deliver=changed', async () => {
    await withMemory(async (dir, mem) => {
      const id = (await mem.addScheduledTask('Watch the release page', Date.now() - 1000, { recur: 'every:1', deliver: 'changed', depth: 2 }))!;
      const delivered: string[] = [];
      const deps = { memory: mem, brain: {} as never, worker: {} as never, outRoot: dir, now: () => Date.now() + 120_000,
        onFire: async (_t: unknown, r: { summary: string }) => { delivered.push(r.summary); },
        runAgent: (async () => ({ summary: 'Nothing new.', reason: 'done', outcome: 'no-change', budgetRefusal: 'jobs created by jobs stop at 2 levels', steps: 1, toolCalls: 0, costUsd: 0, durationMs: 1 })) as never };
      await tickScheduler(deps as never);
      await tickScheduler({ ...deps, now: () => Date.now() + 10 * 60_000 } as never);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toMatch(/wanted to schedule a follow-up and was not allowed/);
      expect((await mem.pendingScheduled()).find((t) => t.id === id)?.budgetNotified).toBe(true);
    });
  }, 30_000);

  it('only a person, in a clean attended chat, can put an existing job under a goal', async () => {
    await withMemory(async (_dir, mem) => {
      const g = (await mem.addGoal('Inbox zero', ''))!;
      const a = (await mem.addScheduledTask('Sort the inbox', Date.now() + 60_000, { recur: 'every:60' }))!;
      await mem.addScheduledTask('Sort the inbox', Date.now() + 60_000, { recur: 'every:60', goal: g, depth: 1 }); // a fire's run
      expect((await mem.pendingScheduled()).find((t) => t.id === a)?.goal).toBeUndefined();
    });
  }, 30_000);

  it('a job whose inherited goal is gone can still schedule an (unowned) follow-up', async () => {
    await withMemory(async (dir, mem) => {
      await runAgent({ instruction: 'Check the supplier inbox', dir, memory: mem, brain: schedulingBrain({ instruction: 'Follow up tomorrow', in_minutes: 1440 }), worker: schedulingBrain({ instruction: 'x', in_minutes: 1 }),
        interactive: false, dueNow: true, jobId: 'gggggggg-1111', jobDepth: 0, jobGoal: 'gone0000-0000-0000', budget: { maxSteps: 4, maxWallMs: 20_000 } });
      const jobs = await mem.pendingScheduled();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].goal).toBeUndefined();
    });
  }, 30_000);
});

