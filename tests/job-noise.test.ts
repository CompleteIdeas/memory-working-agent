/**
 * BL-51 — status noise. Measured in BL-40: Maya, memory on, got 13 unwanted messages in 13 days — 8 from one
 * price watch that could not verify its page ("so I did not send an alert" was itself sent each morning), 4
 * weekend briefs (days: tests/schedule-request.test.ts), and a repeated brief.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tickScheduler, textHash } from '../src/scheduler.js';
import type { JobLastRun } from '../src/awm.js';

const fire = async (task: Record<string, unknown>, run: Record<string, unknown>) => {
  const outRoot = mkdtempSync(join(tmpdir(), 'mwa-bl51-'));
  const fired: { summary: string; outcome?: string }[] = []; const fails: number[] = [];
  const mem = {
    enabled: true,
    async pendingScheduled() { return [task]; }, async completeScheduled() { /* */ }, async rescheduleTask() { /* */ },
    async setJobLastRun() { /* */ }, async setJobFails(_id: string, n: number) { fails.push(n); },
  };
  try {
    await tickScheduler({
      memory: mem as never, brain: {} as never, worker: {} as never, outRoot, now: () => 1_800_000_000_000, checksAllowed: false,
      onFire: async (_t, r) => { fired.push(r); },
      runAgent: (async () => ({ reason: 'done', steps: 2, toolCalls: 1, costUsd: 0, durationMs: 0, ...run })) as never,
    });
  } finally { rmSync(outRoot, { recursive: true, force: true }); }
  return { fired, fails };
};
const WATCH = { id: 'watch123', instruction: 'Check the rose price', due: 1, recur: 'daily:07:00', deliver: 'changed' };
const FAIL = { summary: "I couldn't verify the price, so I did not send an alert.", outcome: 'could-not' };

describe('a recurring job that keeps failing', () => {
  it('the first failure is delivered, the second is not, the third is — with the count', async () => {
    const first = await fire(WATCH, FAIL);
    expect(first.fired).toHaveLength(1); expect(first.fails).toEqual([1]);
    const second = await fire({ ...WATCH, fails: 1 }, FAIL);
    expect(second.fired).toHaveLength(0); expect(second.fails).toEqual([2]);
    const third = await fire({ ...WATCH, fails: 2 }, FAIL);
    expect(third.fired).toHaveLength(1);
    expect(third.fired[0].summary).toContain('(This job has not been able to finish 3 times in a row.)');
    for (const [n, heard] of [[3, false], [4, false], [5, false], [6, true], [14, true]] as const) expect((await fire({ ...WATCH, fails: n }, FAIL)).fired.length, `fail ${n + 1}`).toBe(heard ? 1 : 0);
  });

  it('recovering is said, once, and the count starts over', async () => {
    const { fired, fails } = await fire({ ...WATCH, fails: 4, deliver: undefined }, { summary: 'Roses are $1.10.', outcome: 'changed' });
    expect(fired[0].summary).toContain('(The last 4 runs could not finish; this one did.)');
    expect(fails).toEqual([0]);
  });

  it('a one-off that fails is always delivered', async () => {
    const { fired } = await fire({ id: 'once1234', instruction: 'Check once', due: 1, fails: 3 }, FAIL);
    expect(fired).toHaveLength(1);
  });
});

describe('the same message twice', () => {
  const BRIEF = { id: 'brief123', instruction: 'Morning brief', due: 1, recur: 'daily:08:00' };
  const last: JobLastRun = { at: 1, summary: '1. Wedding inquiry from Aisha Nguyen.\n2. Harbor Hotel quote due Friday.', sumHash: textHash('1. Wedding inquiry from Aisha Nguyen.\n2. Harbor Hotel quote due Friday.') };
  it('is not sent again', async () => {
    const { fired } = await fire({ ...BRIEF, lastRun: last }, { summary: '1. Wedding inquiry from Aisha Nguyen. 2. Harbor Hotel quote due Friday.', outcome: 'changed' });
    expect(fired).toHaveLength(0);
  });
  it('a different message is', async () => {
    const { fired } = await fire({ ...BRIEF, lastRun: last }, { summary: '1. New: Carlos and Mei, Sept 18 wedding.', outcome: 'changed' });
    expect(fired).toHaveLength(1);
  });
  it('not when the run acted or staged something, or under the default policy when it is a failure streak (BL-52 review)', async () => {
    expect((await fire({ ...BRIEF, lastRun: last }, { summary: '1. Wedding inquiry from Aisha Nguyen. 2. Harbor Hotel quote due Friday.', outcome: 'changed', staged: ['draft-1'] })).fired).toHaveLength(1);
    expect((await fire({ ...BRIEF, lastRun: last }, { summary: '1. Wedding inquiry from Aisha Nguyen. 2. Harbor Hotel quote due Friday.', outcome: 'changed', actionsTaken: 1 })).fired).toHaveLength(1);
    // deliver=always (the default) follows the failure rule too for a job that runs more often than daily.
    expect((await fire({ ...BRIEF, recur: 'every:60', fails: 1 }, FAIL)).fired).toHaveLength(0);
  });

  it('a daily job the person hears from every time is heard every time, failures included, with the count (BL-54)', async () => {
    // BL-53 second pass: Maya's Nov 3 and Nov 6 briefs were full briefs that ended "could not", each the second
    // failure in a row — never delivered, and two of S1's ten mornings lost.
    const brief = { summary: "1. Wedding inquiry from Aisha Nguyen. I couldn't confirm whether it was already answered.", outcome: 'could-not' };
    for (const fails of [1, 2, 3, 5]) {
      const { fired } = await fire({ ...BRIEF, fails }, brief);
      expect(fired, `failure ${fails + 1}`).toHaveLength(1);
      expect(fired[0].summary).toContain(`not been able to finish ${fails + 1} times in a row`);
    }
    expect((await fire({ ...BRIEF, recur: 'every:1440', fails: 1 }, brief)).fired).toHaveLength(1);
    expect((await fire({ ...BRIEF, recur: 'daily:08:00@12345', fails: 1 }, brief)).fired).toHaveLength(1);
    // Only-changes jobs keep the throttle, daily or not.
    expect((await fire({ ...BRIEF, deliver: 'changed', fails: 1 }, brief)).fired).toHaveLength(0);
  });

  it('a whole message is compared, not its first 600 characters', async () => {
    const head = 'x'.repeat(700);
    const prev: JobLastRun = { at: 1, summary: `${head} tail one`.slice(0, 600), sumHash: textHash(`${head} tail one`) };
    expect((await fire({ ...BRIEF, lastRun: prev }, { summary: `${head} tail two`, outcome: 'changed' })).fired).toHaveLength(1);
  });

  it('a recovery is heard even under "only when something changes"', async () => {
    const { fired } = await fire({ ...WATCH, fails: 4 }, { summary: 'Price checked.', outcome: 'no-change' });
    expect(fired).toHaveLength(1);
    expect(fired[0].summary).toContain('(The last 4 runs could not finish; this one did.)');
  });

  it('a repeated failure is governed by the failure rule, not this one', async () => {
    const { fired } = await fire({ ...BRIEF, lastRun: { at: 1, summary: FAIL.summary } }, FAIL);
    expect(fired).toHaveLength(1);
  });
});
