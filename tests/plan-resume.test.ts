/**
 * Cost test 2026-10-23: a planned background job whose research step used the whole budget never wrote the
 * newsletter, and nothing picked it up. A planned run that runs out of room now queues a resume, as a direct run
 * does; and a goal's one-off job gets a bigger budget than a check.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent } from '../src/agent.js';
import { MwaMemory } from '../src/awm.js';
import { jobBudget } from '../src/scheduler.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { Provider, ChatInput, ChatResult } from '../src/provider.js';

const prevFast = process.env.MWA_FAST_CHAT;
beforeAll(() => { process.env.MWA_FAST_CHAT = '0'; });
afterAll(() => { if (prevFast === undefined) delete process.env.MWA_FAST_CHAT; else process.env.MWA_FAST_CHAT = prevFast; });

describe('a planned run that runs out of room', () => {
  it('queues a resume with the plan, for the same goal and conversation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mwa-planres-'));
    const mem = new MwaMemory('plan-resume-test', join(dir, 'm.db'));
    try {
      const goal = (await mem.addGoal('Get the newsletter out', ''))!;
      const reg = new ToolRegistry();
      reg.registerAll([{ def: { name: 'portal__fetch', description: 'read a page', parameters: { type: 'object', properties: {} } }, handler: async () => 'a page about AI agents' }]);
      const brain: Provider = { id: 'p', model: 'p', price: [0, 0], chat: async (input: ChatInput): Promise<ChatResult> => {
        const sys = String(input.system ?? '');
        if (sys.includes('You are the PLANNER')) return { text: JSON.stringify({ steps: [{ task: 'research the week', done_when: 'notes saved' }, { task: 'write the newsletter', done_when: 'file saved' }] }), usage: { input: 1, output: 1 } };
        if (!sys.includes('TRUST BOUNDARY')) return { text: '{}', usage: { input: 1, output: 1 } };
        return { text: JSON.stringify({ action: 'portal__fetch' }), usage: { input: 1, output: 1 } }; // keeps researching, never done
      } };
      const r = await runAgent({ instruction: 'Research AI news and write the newsletter', dir, memory: mem, brain, worker: brain, tools: reg,
        interactive: false, plan: true, jobId: 'job-1', jobGoal: goal, session: 'web-news', budget: { maxSteps: 6, maxWallMs: 60_000 },
        now: (() => { let t = 1_800_000_000_000; return () => (t += 7_000); })() }); // time runs out before the writing step
      expect(r.reason).toBe('budget');
      expect(r.resumeQueued).toBe(true);
      expect(r.summary).toMatch(/continuing in the background/);
      const resume = (await mem.pendingScheduled()).find((t) => t.resumeAttempt === 1)!;
      expect(resume.instruction).toMatch(/1\. research the week[\s\S]*2\. write the newsletter \(not started\)/);
      expect(resume).toMatchObject({ goal, notify: 'web-news' });
    } finally { mem.close(); rmSync(dir, { recursive: true, force: true }); }
  }, 90_000);
});

describe('jobBudget', () => {
  it('gives a goal\'s one-off job a whole piece of work, a recurring fire a check', () => {
    expect(jobBudget({ goal: 'g' }, {}, {})).toMatchObject({ maxSteps: 60, maxWallMs: 20 * 60_000 });
    expect(jobBudget({ goal: 'g', recur: 'daily' }, {}, {}).maxSteps).toBeLessThanOrEqual(16);
    expect(jobBudget({}, { maxSteps: 30, maxMin: 8 }, {})).toMatchObject({ maxSteps: 30, maxWallMs: 8 * 60_000 });
    expect(jobBudget({ goal: 'g' }, {}, { MWA_GOAL_JOB_STEPS: '80' }).maxSteps).toBe(80);
  });
});
