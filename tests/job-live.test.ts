/**
 * A fired job is a live run (interface slice replay 2026-10-26): the Work view could only say "handed over 12m ago",
 * because a background run sent no events. The scheduler now tracks each fire under `job_<id>` in the same live-run
 * registry as a chat: its events stream, it can be stopped and steered, and the schedule rows carry its stage.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tickScheduler } from '../src/scheduler.js';
import { liveRuns } from '../src/live-runs.js';

const job = { id: 'job-live-0001', instruction: 'Compare the headlines and write a briefing', due: 1, person: 'p', notify: 'web-conv-1' };

describe('a fired job is a live run', () => {
  it('streams its events under job_<id> while it runs, can be told to stop, and is gone when it ends', async () => {
    const outRoot = mkdtempSync(join(tmpdir(), 'mwa-joblive-'));
    let pending: Record<string, unknown>[] = [job];
    const seen: { during: ReturnType<typeof liveRuns.describe>; signal: boolean; inbox: string[] } = { during: null, signal: false, inbox: [] };
    const memory = {
      async pendingScheduled() { return pending; },
      async completeScheduled(id: string) { pending = pending.filter((t) => t.id !== id); },
      async rescheduleTask() { /* */ }, async setScheduledSignature() { /* */ }, async getGoal() { return null; }, async setGoalStatus() { /* */ },
    } as never;
    const runAgent = async (opts: { onEvent?: (t: string, d: Record<string, unknown>) => void; signal?: AbortSignal; inbox?: () => string[] }) => {
      opts.onEvent?.('step', { n: 1, of: 40, tool: 'browser_open', detail: 'https://www.npr.org/', elapsedMs: 1200 });
      seen.during = liveRuns.describe(`job_${job.id}`);
      liveRuns.steer(`job_${job.id}`, 'only the top two stories');
      seen.inbox = opts.inbox?.() ?? [];
      liveRuns.stop(`job_${job.id}`);
      seen.signal = opts.signal?.aborted === true;
      return { summary: 'Stopped after step 1.', reason: 'stopped', steps: 1, toolCalls: 1, costUsd: 0.01, durationMs: 1500 };
    };
    const received: string[] = [];
    try {
      await tickScheduler({ memory, brain: {} as never, worker: {} as never, outRoot, now: () => 10_000, checksAllowed: false, watchGate: null,
        onFire: async (r: { summary: string }) => { received.push(r.summary); }, runAgent: runAgent as never });
    } finally { try { rmSync(outRoot, { recursive: true, force: true }); } catch { /* */ } }
    expect(seen.during?.stage).toMatchObject({ tool: 'browser_open', detail: 'https://www.npr.org/' });
    expect(seen.during?.message).toBe(job.instruction);
    expect(seen.inbox).toEqual(['only the top two stories']);
    expect(seen.signal).toBe(true);
    expect(liveRuns.describe(`job_${job.id}`)).toBeNull(); // finished and forgotten
    void received; // how the scheduler delivers the result is its own tests' business
  });
});
