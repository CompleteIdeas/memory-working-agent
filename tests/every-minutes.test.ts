/**
 * A repeat the person asked for, booked once (interface slice replay 2026-10-26, U04). "Every 5 minutes, check the
 * budget file and tell me if the total changes" was scheduled as a one-off job every time — six of them in one try —
 * while the reply said "every 5 minutes". The schedule action now holds a one-off once when the person's words give an
 * interval, and books it as given when the model resends unchanged.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent } from '../src/agent.js';
import { MwaMemory } from '../src/awm.js';
import { asksEveryMinutes } from '../src/schedule-request.js';

describe('asksEveryMinutes', () => {
  it('reads the interval the person gave', () => {
    expect(asksEveryMinutes('Every 5 minutes, check budget-2026.csv and tell me if the total changes')).toBe(5);
    expect(asksEveryMinutes('check the price every 2 hours')).toBe(120);
    expect(asksEveryMinutes('Every hour, look at the queue')).toBe(60);
    expect(asksEveryMinutes('every half hour')).toBe(30);
    expect(asksEveryMinutes('hourly, please')).toBe(60);
    expect(asksEveryMinutes('every ten mins')).toBe(10);
    expect(asksEveryMinutes('Remind me tomorrow at 9 to call the dentist')).toBeNull();
    expect(asksEveryMinutes('Every morning at 7, brief me')).toBeNull();
  });
});

const ASK = 'Every 5 minutes, check budget-2026.csv and tell me only if the total changes.';
const JOB = 'Check budget-2026.csv and report only if the total changed';

const scripted = (actions: Record<string, unknown>[]) => {
  let i = 0;
  return { id: 's', model: 's', price: [0, 0] as [number, number], chat: async (input: { system?: string }) => {
    if (!String(input.system ?? '').includes('TRUST BOUNDARY')) return { text: '{}', usage: { input: 1, output: 1 } };
    return { text: JSON.stringify(actions[Math.min(i++, actions.length - 1)]), usage: { input: 1, output: 1 } };
  } };
};
const withRun = async <T>(fn: (dir: string, mem: MwaMemory) => Promise<T>): Promise<T> => {
  const dir = mkdtempSync(join(tmpdir(), 'mwa-every-'));
  const mem = new MwaMemory('every', join(dir, 'm.db'));
  const prev = process.env.MWA_FAST_CHAT; process.env.MWA_FAST_CHAT = '0';
  try { return await fn(dir, mem); } finally { if (prev === undefined) delete process.env.MWA_FAST_CHAT; else process.env.MWA_FAST_CHAT = prev; mem.close(); rmSync(dir, { recursive: true, force: true }); }
};
const run = (dir: string, mem: MwaMemory, actions: Record<string, unknown>[]) => runAgent({
  instruction: ASK, userMessage: ASK, dir, memory: mem, brain: scripted(actions), worker: scripted(actions),
  interactive: true, plan: false, budget: { maxSteps: 8, maxWallMs: 30_000 },
});

describe('a repeat booked once', () => {
  it('is held once with the interval the person gave, and booked as a repeat when the model takes the hint', async () => {
    await withRun(async (dir, mem) => {
      const r = await run(dir, mem, [{ action: 'schedule', instruction: JOB, in_minutes: 5 }, { action: 'schedule', instruction: JOB, every_minutes: 5 }, { action: 'done', summary: 'set' }]);
      expect(r.history.join('\n')).toMatch(/held once: the person asked for this every 5 minutes/);
      const jobs = await mem.pendingScheduled();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].recur).toBe('every:5');
    });
  }, 60_000);

  it('resent unchanged, a one-off is booked as the model insists', async () => {
    await withRun(async (dir, mem) => {
      const r = await run(dir, mem, [{ action: 'schedule', instruction: JOB, in_minutes: 5 }, { action: 'schedule', instruction: JOB, in_minutes: 5 }, { action: 'done', summary: 'set' }]);
      expect(r.history.join('\n')).toMatch(/held once/);
      const jobs = await mem.pendingScheduled();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].recur).toBeUndefined();
    });
  }, 60_000);
});
