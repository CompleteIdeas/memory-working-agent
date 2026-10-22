/**
 * BL-68 — the five unwanted messages of the BL-66/67 USEA reruns, all from two "tell me only when X" watches.
 *  - "outcome no-change" sent to the person, three times: a wrap-up whose outcome marker was never read (the run
 *    defaulted to "changed"), and a reworded reading ("LAPSED" → "LAPSED; renewal payment PENDING") that overrode
 *    the run's own no-change.
 *  - "Confirmed finished, so this job has stopped." with the whole message again, twice: the confirming check's page
 *    read counted as an action, so the BL-62 quiet stop never applied.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { takeOutcomeMark } from '../src/agent.js';
import { tickScheduler } from '../src/scheduler.js';

describe('an outcome written into the answer', () => {
  it('is read at the end or the start, and leaves the message', () => {
    expect(takeOutcomeMark('outcome no-change')).toEqual({ outcome: 'no-change', rest: '' });
    expect(takeOutcomeMark('Active through Nov 30, 2027. outcome complete')).toEqual({ outcome: 'complete', rest: 'Active through Nov 30, 2027.' });
    expect(takeOutcomeMark('Outcome: **no-change**. The page reported **LAPSED**, not Active.')).toEqual({ outcome: 'no-change', rest: 'The page reported **LAPSED**, not Active.' });
    expect(takeOutcomeMark('**Outcome:** changed')).toMatchObject({ outcome: 'changed' });
  });
  it('is not read from prose', () => {
    expect(takeOutcomeMark('The outcome changed nothing for Tessa, who is still LAPSED.')).toBeNull();
    expect(takeOutcomeMark('Results are provisional; the final outcome is not yet posted.')).toBeNull();
  });
});

const runJob = async (script: Record<string, unknown>[], wrapUp = '') => {
  const { runAgent } = await import('../src/agent.js');
  const { MwaMemory } = await import('../src/awm.js');
  const dir = mkdtempSync(join(tmpdir(), 'mwa-noise-'));
  const mem = new MwaMemory('noise', join(dir, 'm.db'));
  let i = 0;
  const brain = { id: 's', model: 's', price: [0, 0] as [number, number], chat: async (input: { system?: string }) => {
    const sys = String(input.system ?? '');
    if (sys.startsWith('You are wrapping up')) return { text: wrapUp, usage: { input: 1, output: 1 } };
    if (!sys.includes('TRUST BOUNDARY')) return { text: '{}', usage: { input: 1, output: 1 } };
    const r = script[Math.min(i++, script.length - 1)];
    return { text: '', toolCalls: [{ name: String(r.action), args: Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'action')) }], usage: { input: 1, output: 1 } };
  } };
  const tools = { defs: () => [{ name: 'web__open_page', description: 'o', parameters: { type: 'object', properties: {} } }], has: (x: string) => x === 'web__open_page', call: async () => 'Riverbend Fall HT — RESULTS: PROVISIONAL' } as never;
  const prev = process.env.MWA_FAST_CHAT; process.env.MWA_FAST_CHAT = '0';
  try {
    return await runAgent({ instruction: 'Check https://results.riverbend.example/fall and tell me only when the results are marked final', dir, memory: mem as never, brain, worker: brain, tools, interactive: false, plan: false, jobId: 'watch941', jobRecur: 'daily:10:00', jobDeliver: 'changed', jobUntil: 'the results are marked final', budget: { maxSteps: 8, maxWallMs: 20_000 } } as never);
  } finally {
    if (prev === undefined) delete process.env.MWA_FAST_CHAT; else process.env.MWA_FAST_CHAT = prev;
    mem.close(); rmSync(dir, { recursive: true, force: true });
  }
};

describe('a job run that states its outcome in words', () => {
  it('done with only "outcome no-change" is no-change, and the marker is not the message', async () => {
    const r = await runJob([
      { action: 'web__open_page', url: 'https://results.riverbend.example/fall' },
      { action: 'done', summary: 'outcome no-change', value: 'RESULTS: PROVISIONAL' },
    ]);
    expect(r.outcome).toBe('no-change');
    expect(r.outcomeDeclared).toBe(true);
    expect(r.summary).not.toMatch(/outcome/i);
  }, 60_000);
  it('a wrap-up that says "outcome no-change" is no-change, not the "changed" a read would default to', async () => {
    const page = { action: 'web__open_page', url: 'https://results.riverbend.example/fall' };
    const r = await runJob([page, page, page, page, page, page, page, page], 'outcome no-change');
    expect(r.reason).toBe('done');
    expect(r.outcome).toBe('no-change');
    expect(r.summary).not.toMatch(/outcome/i);
  }, 60_000);
  it('a page read is an action, but not one that stayed on this machine', async () => {
    const r = await runJob([
      { action: 'web__open_page', url: 'https://results.riverbend.example/fall' },
      { action: 'done', summary: 'Still provisional.', outcome: 'no-change', value: 'RESULTS: PROVISIONAL' },
    ]);
    expect(r.actionsTaken).toBe(1);
    expect(r.localActions).toBeUndefined();
  }, 60_000);
});

describe('the scheduler', () => {
  const fire = async (task: Record<string, unknown>, result: Record<string, unknown>) => {
    const outRoot = mkdtempSync(join(tmpdir(), 'mwa-noise-sched-'));
    const calls = { onFire: [] as Record<string, unknown>[], lastRun: [] as Record<string, unknown>[], completed: 0 };
    const memory = {
      enabled: false,
      async pendingScheduled() { return [task]; },
      async completeScheduled() { calls.completed++; },
      async rescheduleTask() { /* */ },
      async setScheduledSignature() { /* */ },
      async setPendingComplete() { /* */ },
      async setJobLastRun(_id: string, rec: Record<string, unknown>) { calls.lastRun.push(rec); },
      async setJobFails() { /* */ },
    } as never;
    try {
      await tickScheduler({
        memory, brain: {} as never, worker: {} as never, outRoot, now: () => 10_000, checksAllowed: false,
        onFire: async (_t, r) => { calls.onFire.push(r as unknown as Record<string, unknown>); },
        runAgent: (async () => ({ reason: 'done', steps: 2, toolCalls: 1, costUsd: 0, durationMs: 1, ...result })) as never,
      });
    } finally { try { rmSync(outRoot, { recursive: true, force: true }); } catch { /* */ } }
    return calls;
  };
  const watch = { id: '14fa0629', instruction: 'Check Tessa Morrow’s membership status and tell me only when it is Active', due: 1, recur: 'daily:09:00', deliver: 'changed',
    lastRun: { at: 1, summary: 'x', value: 'LAPSED (expired 2026-10-31)', valueAt: 1 } };
  const reworded = { summary: 'Still lapsed.', outcome: 'no-change', outcomeDeclared: true, watchValue: 'LAPSED (expired 2026-10-31); renewal payment PENDING', actionsTaken: 1 };

  it('a "tell me when" watch whose run answered no-change stays quiet when the reading is only reworded, and keeps the new reading', async () => {
    const c = await fire({ ...watch, until: 'her membership shows Active' }, reworded);
    expect(c.onFire).toHaveLength(0);
    expect(c.lastRun[0]).toMatchObject({ value: reworded.watchValue });
  });
  it('a watch that reports changes still hears a moved reading the run called no-change (BL-40 kept)', async () => {
    const c = await fire(watch, reworded);
    expect(c.onFire).toHaveLength(1);
    expect(String(c.onFire[0].summary)).toMatch(/Changed since/);
  });
  it('...and so does a "tell me when" watch whose no-change was not the run’s own word', async () => {
    const c = await fire({ ...watch, until: 'her membership shows Active' }, { ...reworded, outcomeDeclared: false });
    expect(c.onFire).toHaveLength(1);
  });

  const confirming = { ...watch, until: 'her membership shows Active', pendingComplete: true, lastRun: { at: 1, summary: 'x', value: 'ACTIVE (through 2027-11-30)', valueAt: 1 } };
  const confirmed = { summary: 'Tessa is verified Active through Nov 30, 2027.', outcome: 'complete', outcomeDeclared: true, watchValue: 'ACTIVE (through 2027-11-30)' };
  it('the confirming check stops quietly although it read the page through an outward call', async () => {
    const c = await fire(confirming, { ...confirmed, actionsTaken: 1 });
    expect(c.completed).toBe(1);
    expect(c.onFire).toHaveLength(0);
  });
  it('...but not when it did something on this machine, or left something staged', async () => {
    expect((await fire(confirming, { ...confirmed, actionsTaken: 2, localActions: 1 })).onFire).toHaveLength(1);
    expect((await fire(confirming, { ...confirmed, staged: ['draft-1'] })).onFire).toHaveLength(1);
  });
});
