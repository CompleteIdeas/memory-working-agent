/**
 * One job per request (usability review 2026-10-24, F04). "Remind me tomorrow at 9am to call Harbour Works about the
 * dock quote" made four reminders (8:59, 9:00, 9:10, 9:10): five `schedule` actions in one run, one after each re-ask
 * by the am-pm and missing-output gates. The schedule action now refuses a twin — the same words at the same time,
 * whether created earlier in this run or already waiting in the store — and holds the same words at another time
 * once (usually a move, for schedule_update), adding it only when the model resends unchanged.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent } from '../src/agent.js';
import { MwaMemory } from '../src/awm.js';

const REMIND = 'Call Harbour Works about the dock repair quote';

/** A brain whose main loop plays `actions` in order (then the last one again). */
const scripted = (actions: Record<string, unknown>[]) => {
  let i = 0;
  return { id: 's', model: 's', price: [0, 0] as [number, number], chat: async (input: { system?: string }) => {
    if (!String(input.system ?? '').includes('TRUST BOUNDARY')) return { text: '{}', usage: { input: 1, output: 1 } };
    return { text: JSON.stringify(actions[Math.min(i++, actions.length - 1)]), usage: { input: 1, output: 1 } };
  } };
};

const withRun = async <T>(fn: (dir: string, mem: MwaMemory) => Promise<T>): Promise<T> => {
  const dir = mkdtempSync(join(tmpdir(), 'mwa-twin-'));
  const mem = new MwaMemory('twin', join(dir, 'm.db'));
  const prev = process.env.MWA_FAST_CHAT; process.env.MWA_FAST_CHAT = '0';
  try { return await fn(dir, mem); } finally {
    if (prev === undefined) delete process.env.MWA_FAST_CHAT; else process.env.MWA_FAST_CHAT = prev;
    mem.close(); rmSync(dir, { recursive: true, force: true });
  }
};

const run = (dir: string, mem: MwaMemory, actions: Record<string, unknown>[]) => runAgent({
  instruction: 'Set the reminders the person asked for.', dir, memory: mem, brain: scripted(actions), worker: scripted(actions),
  interactive: false, budget: { maxSteps: 8, maxWallMs: 30_000 },
});

describe('one job per request', () => {
  it('the same words at the same time, already waiting in the store, are not added again', async () => {
    await withRun(async (dir, mem) => {
      const now = Date.now();
      await mem.addScheduledTask(REMIND, now + 1005 * 60_000, {});
      const r = await run(dir, mem, [{ action: 'schedule', instruction: REMIND, in_minutes: 1000 }, { action: 'done', summary: 'set' }]);
      expect(r.reason).toBe('done');
      expect(await mem.pendingScheduled()).toHaveLength(1);
      expect(r.history.join('\n')).toMatch(/already scheduled as [0-9a-f]{8} — not added twice/);
    });
  }, 60_000);

  it('the same words twice in one run, minutes apart, make one job', async () => {
    await withRun(async (dir, mem) => {
      const r = await run(dir, mem, [
        { action: 'schedule', instruction: REMIND, in_minutes: 1000 },
        { action: 'schedule', instruction: REMIND, in_minutes: 1010 },
        { action: 'done', summary: 'set' },
      ]);
      expect(r.reason).toBe('done');
      expect(await mem.pendingScheduled()).toHaveLength(1);
      expect(r.history.join('\n')).toMatch(/already scheduled in this run — not added twice/);
    });
  }, 60_000);

  it('the same words at another time are held once, then added when resent unchanged', async () => {
    await withRun(async (dir, mem) => {
      await mem.addScheduledTask(REMIND, Date.now() + 1000 * 60_000, {});
      const r = await run(dir, mem, [{ action: 'schedule', instruction: REMIND, in_minutes: 3000 }, { action: 'schedule', instruction: REMIND, in_minutes: 3000 }, { action: 'done', summary: 'set' }]);
      expect(r.history.join('\n')).toMatch(/schedule held once: a job with these words exists at/);
      expect(await mem.pendingScheduled()).toHaveLength(2);
    });
  }, 60_000);

  it('different words at the same time are two jobs', async () => {
    await withRun(async (dir, mem) => {
      await run(dir, mem, [
        { action: 'schedule', instruction: REMIND, in_minutes: 1000 },
        { action: 'schedule', instruction: 'Send the board the dock repair decision', in_minutes: 1000 },
        { action: 'done', summary: 'set' },
      ]);
      expect(await mem.pendingScheduled()).toHaveLength(2);
    });
  }, 60_000);
});
