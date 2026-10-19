/**
 * BL-45 — a correction reaches the job it is about. Measured in BL-40: "From now on, morning brief format
 * should have a separate heading: Team" got "Got it, I'll make the morning brief use a separate Team
 * heading" after listing the schedule four times; the heading never appeared. Sam's 3-bullet rule held only
 * when a recall happened to bring it up.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asksToChangeJob } from '../src/schedule-request.js';
import { workTools } from '../src/tools/work.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { MwaMemory } from '../src/awm.js';

const MAYA_FIX = 'From now on, morning brief format should have a separate heading: Team.';

describe('reading a correction to a job', () => {
  it('the BL-40 corrections, and their usual shapes', () => {
    for (const m of [MAYA_FIX, 'Keep the morning plan to 3 bullets from now on.', 'Can you keep the plan to three bullets?', 'Put wedding inquiries first in the daily brief.', 'Going forward, skip the weather in my morning summary.'])
      expect(asksToChangeJob(m), m).toBe(true);
  });
  it('not a one-off request, a question or a new job', () => {
    for (const m of ['Summarize this report', 'What was in this morning\'s brief?', 'Set a weekday 8:00 AM brief for me', 'Add a heading to notes.md', 'From now on call me Rob'])
      expect(asksToChangeJob(m), m).toBe(false);
  });
});

async function withStore<T>(fn: (mem: MwaMemory, reg: ToolRegistry, jobId: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'mwa-bl45-'));
  const mem = new MwaMemory('bl45', join(dir, 'm.db'));
  try {
    await mem.addScheduledTask('Check what came in that needs attention, rank it, and send a short brief with wedding inquiries first.', Date.now() + 3_600_000, { recur: 'daily:08:00', person: 'maya', request: 'Set a weekday 8:00 AM brief for me: what came in that needs me, ranked, wedding inquiries first.' });
    const [job] = await mem.pendingScheduled();
    const reg = new ToolRegistry(); reg.registerAll(workTools(mem));
    return await fn(mem, reg, job.id);
  } finally { mem.close(); rmSync(dir, { recursive: true, force: true }); }
}

describe('schedule_update', () => {
  const NEW = 'Check what came in that needs attention, rank it, and send a short brief with wedding inquiries first and staff requests under a separate heading "Team".';

  it('rewrites the job in place and keeps the person\'s words with it', async () => {
    await withStore(async (mem, reg, id) => {
      const out = await reg.call('schedule_update', { id: id.slice(0, 8), instruction: NEW }, { sandboxDir: '.', interactive: true, personId: 'maya', personMessage: MAYA_FIX } as never);
      expect(out).toMatch(/^updated .* — now: "Check what came in/);
      const [job] = await mem.pendingScheduled();
      expect(job.id).toBe(id);
      expect(job.instruction).toBe(NEW);
      expect(job.recur).toBe('daily:08:00');
      expect(job.request).toBe(`Set a weekday 8:00 AM brief for me: what came in that needs me, ranked, wedding inquiries first.\n[later] ${MAYA_FIX}`);
    });
  });

  it('a new daily time moves the job', async () => {
    await withStore(async (mem, reg, id) => {
      await reg.call('schedule_update', { id: id.slice(0, 8), instruction: NEW, daily_at: '7:30' }, { sandboxDir: '.', interactive: true, personId: 'maya' } as never);
      const [job] = await mem.pendingScheduled();
      expect(job.recur).toBe('daily:07:30');
      expect(new Date(job.due).getHours()).toBe(7);
      expect(new Date(job.due).getMinutes()).toBe(30);
    });
  });

  it('refused unattended and for someone else\'s job; after outside content it is changed but marked', async () => {
    await withStore(async (mem, reg, id) => {
      expect(await reg.call('schedule_update', { id: id.slice(0, 8), instruction: NEW }, { sandboxDir: '.', interactive: false, personId: 'maya' } as never)).toMatch(/refused: a scheduled job is changed only while the person is present/);
      expect(await reg.call('schedule_update', { id: id.slice(0, 8), instruction: NEW }, { sandboxDir: '.', interactive: true, personId: 'sam' } as never)).toMatch(/no scheduled task with id/);
      expect((await mem.pendingScheduled())[0].instruction).not.toBe(NEW);
      expect(await reg.call('schedule_update', { id: id.slice(0, 8), instruction: NEW }, { sandboxDir: '.', interactive: true, tainted: true, personId: 'maya' } as never)).toMatch(/^updated/);
      const [job] = await mem.pendingScheduled();
      expect(job.instruction).toBe(NEW);
      expect(job.tainted).toBe(true);
    });
  });
});

describe('a correction answered with a promise is sent back once', () => {
  const run = async (mem: MwaMemory, reg: ToolRegistry, actions: Record<string, unknown>[]) => {
    const { runAgent } = await import('../src/agent.js');
    const dir = mkdtempSync(join(tmpdir(), 'mwa-bl45r-'));
    let i = 0;
    const brain = { id: 's', model: 's', price: [0, 0] as [number, number], chat: async (input: any) => {
      if (!String(input.system ?? '').includes('TRUST BOUNDARY')) return { text: '{}', usage: { input: 1, output: 1 } };
      return { text: JSON.stringify(actions[Math.min(i++, actions.length - 1)]), usage: { input: 1, output: 1 } };
    } };
    const prev = process.env.MWA_FAST_CHAT; process.env.MWA_FAST_CHAT = '0';
    try {
      return await runAgent({ instruction: MAYA_FIX, userMessage: MAYA_FIX, dir, memory: mem as any, brain, worker: brain, interactive: true, personId: 'maya', plan: false, tools: reg, budget: { maxSteps: 8, maxWallMs: 20_000 } } as any);
    } finally {
      if (prev === undefined) delete process.env.MWA_FAST_CHAT; else process.env.MWA_FAST_CHAT = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const PROMISE = { action: 'done', summary: 'Got it, I\'ll make the morning brief use a separate Team heading.' };

  it('the BL-40 shape: listed, promised — pushed, then the job is updated', async () => {
    await withStore(async (mem, reg, id) => {
      const r = await run(mem, reg, [{ action: 'schedule_list' }, PROMISE, { action: 'schedule_update', id: id.slice(0, 8), instruction: 'Brief with a separate Team heading for staff requests.' }, { action: 'done', summary: 'Updated your 8:00 brief: staff requests now go under Team.' }]);
      expect(r.history.join('\n')).toMatch(/a job correction with no job changed — asked to update it/);
      const [job] = await mem.pendingScheduled();
      expect(job.instruction).toBe('Brief with a separate Team heading for staff requests.');
      expect(r.summary).toMatch(/Updated your 8:00 brief/);
    });
  }, 60_000);

  it('once only', async () => {
    await withStore(async (_mem, reg) => {
      const r = await run(_mem, reg, [{ action: 'schedule_list' }, PROMISE, PROMISE]);
      expect(r.history.filter((h) => /a job correction with no job changed/.test(h))).toHaveLength(1);
    });
  }, 60_000);
});
