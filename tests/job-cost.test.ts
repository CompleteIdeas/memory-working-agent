/**
 * BL-46 — cost. BL-40: MWA cost 13x the plain loop for the same score; Maya's broken price watch spent 13 to
 * 26 steps a morning (up to $0.25 a fire) and its "resume and finish" runs cost as much again. Its causes are
 * fixed at the root (BL-44: the job keeps the link; BL-49: open the page); these bound what any broken
 * recurring job can spend.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tickScheduler, RECURRING_MAX_STEPS } from '../src/scheduler.js';

describe('a recurring fire is bounded', () => {
  const fire = async (task: Record<string, unknown>) => {
    const outRoot = mkdtempSync(join(tmpdir(), 'mwa-bl46-'));
    const seen: Record<string, any>[] = [];
    try {
      await tickScheduler({
        memory: { async pendingScheduled() { return [task]; }, async completeScheduled() { /* */ }, async rescheduleTask() { /* */ } } as never,
        brain: {} as never, worker: {} as never, outRoot, now: () => 10_000, checksAllowed: false, onFire: async () => { /* */ },
        runAgent: (async (o: Record<string, any>) => { seen.push(o); return { summary: 'ok', reason: 'done', steps: 1, toolCalls: 1, costUsd: 0, durationMs: 0 }; }) as never,
      });
    } finally { rmSync(outRoot, { recursive: true, force: true }); }
    return seen[0];
  };
  it(`to ${RECURRING_MAX_STEPS} steps and no planning; a one-off keeps the full budget`, async () => {
    const rec = await fire({ id: 'rec12345', instruction: 'Check the price', due: 1, recur: 'daily:07:00' });
    expect(rec.budget.maxSteps).toBe(RECURRING_MAX_STEPS);
    expect(rec.plan).toBe(false);
    const once = await fire({ id: 'one12345', instruction: 'Check the price', due: 1 });
    expect(once.budget.maxSteps).toBe(30);
    expect(once.plan).toBeUndefined();
  });
});

describe('a recurring fire that runs out of steps is left to its next fire', () => {
  const run = async (extra: Record<string, unknown>) => {
    const { runAgent } = await import('../src/agent.js');
    const { MwaMemory } = await import('../src/awm.js');
    const dir = mkdtempSync(join(tmpdir(), 'mwa-bl46r-'));
    const mem = new MwaMemory('bl46', join(dir, 'm.db'));
    let n = 0;
    const brain = { id: 's', model: 's', price: [0, 0] as [number, number], chat: async (input: any) => {
      if (!String(input.system ?? '').includes('TRUST BOUNDARY')) return { text: '{}', usage: { input: 1, output: 1 } };
      return { text: JSON.stringify({ action: 'list_active_tools', page: n++ }), usage: { input: 1, output: 1 } };
    } };
    const tools = { defs: () => [{ name: 'list_active_tools', description: 'list', parameters: { type: 'object', properties: {} } }], has: (x: string) => x === 'list_active_tools', call: async () => 'tools' }; // a read: an outward tool would pause the unattended run first
    const prev = process.env.MWA_FAST_CHAT; process.env.MWA_FAST_CHAT = '0';
    try {
      const r = await runAgent({ instruction: 'Check the rose price page', dir, memory: mem as any, brain, worker: brain, interactive: false, plan: false, tools: tools as any, jobId: 'watch123', dueNow: true, budget: { maxSteps: 4, maxWallMs: 20_000 }, ...extra } as any);
      return { r, resumes: (await mem.pendingScheduled()).filter((t) => t.resumeAttempt) };
    } finally {
      if (prev === undefined) delete process.env.MWA_FAST_CHAT; else process.env.MWA_FAST_CHAT = prev;
      mem.close(); rmSync(dir, { recursive: true, force: true });
    }
  };
  it('no resume for a recurring job; a one-off still gets one', async () => {
    const rec = await run({ jobRecur: 'daily:07:00' });
    expect(rec.r.reason).toBe('budget');
    expect(rec.resumes).toHaveLength(0);
    const once = await run({});
    expect(once.resumes).toHaveLength(1);
  }, 60_000);
});
