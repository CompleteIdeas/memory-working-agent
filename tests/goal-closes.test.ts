/**
 * F05 (usability review 2026-10-24): "Work on it" set a goal `in_progress` and nothing ever set it `done`, so the Work
 * tab said WORKING ON IT 17 minutes after the result was in the chat. The scheduler now closes a goal when its last
 * one-off job finishes, pauses it when the job could not finish or waits for an approval, and leaves it alone when
 * another job of the goal is still waiting, a resume was queued, or the model already changed its status.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tickScheduler } from '../src/scheduler.js';

type Run = { summary: string; reason: string; outcome?: string; resumeQueued?: boolean };

const fire = async (o: { task: Record<string, unknown>; run: Run; goalStatus?: string; others?: Record<string, unknown>[] }) => {
  const outRoot = mkdtempSync(join(tmpdir(), 'mwa-goal-'));
  const set: string[] = [];
  let pending = [o.task, ...(o.others ?? [])];
  const memory = {
    async pendingScheduled() { return pending; },
    async completeScheduled(id: string) { pending = pending.filter((t) => t.id !== id); },
    async rescheduleTask() { /* */ },
    async setScheduledSignature() { /* */ },
    async getGoal(id: string) { return { id, title: 'Board briefing', status: o.goalStatus ?? 'in_progress', priority: 'medium' }; },
    async setGoalStatus(_id: string, status: string) { set.push(status); },
  } as never;
  try {
    await tickScheduler({ memory, brain: {} as never, worker: {} as never, outRoot, now: () => 10_000, checksAllowed: false, watchGate: null,
      onFire: async () => { /* */ }, runAgent: (async () => o.run) as never });
  } finally { try { rmSync(outRoot, { recursive: true, force: true }); } catch { /* */ } }
  return set;
};
const job = { id: 'job00001', instruction: 'Research and write the board briefing', due: 1, goal: 'g1', person: 'p' };

describe('a goal closes with its job', () => {
  it('a finished one-off job marks its goal done', async () => {
    expect(await fire({ task: job, run: { summary: 'written', reason: 'done', outcome: 'changed' } })).toEqual(['done']);
    expect(await fire({ task: job, run: { summary: 'written', reason: 'done' } })).toEqual(['done']);
  });
  it('a job that could not finish, or waits for an approval, pauses the goal', async () => {
    expect(await fire({ task: job, run: { summary: 'no access', reason: 'done', outcome: 'could-not' } })).toEqual(['blocked']);
    expect(await fire({ task: job, run: { summary: 'card waiting', reason: 'done', outcome: 'blocked' } })).toEqual(['blocked']);
    expect(await fire({ task: job, run: { summary: 'out of steps', reason: 'budget' } })).toEqual(['blocked']);
  });
  it('leaves the goal alone when another of its jobs waits, a resume is queued, it repeats, or the model set the status', async () => {
    expect(await fire({ task: job, run: { summary: 'part one', reason: 'done' }, others: [{ id: 'job00002', instruction: 'part two', due: 99_999, goal: 'g1' }] })).toEqual([]);
    expect(await fire({ task: job, run: { summary: 'continuing', reason: 'done', resumeQueued: true } })).toEqual([]);
    expect(await fire({ task: { ...job, recur: 'every:60' }, run: { summary: 'checked', reason: 'done' } })).toEqual([]);
    expect(await fire({ task: job, run: { summary: 'done', reason: 'done' }, goalStatus: 'done' })).toEqual([]);
    expect(await fire({ task: job, run: { summary: 'done', reason: 'done' }, goalStatus: 'blocked' })).toEqual([]);
  });
});
