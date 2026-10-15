import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent } from '../src/agent.js';
import type { Provider, ChatResult } from '../src/provider.js';
import { MwaMemory } from '../src/awm.js';

/**
 * The self-reschedule guard, driven through the REAL loop (2026-10-14).
 *
 * A fired task whose stored instruction kept "do not do it now; just schedule it for later" read
 * that and tried to schedule itself again — on a recurring task, a loop that never does the work.
 * The guard refuses that. Its first version was keyed on `interactive === false`, which also covers
 * the mailbox: a dropped file saying "summarize my inbox daily" would have had its legitimate
 * `schedule("Summarize my inbox")` refused (Jaccard 0.67 against its own instruction). The
 * predicate was tested; the CONDITION was not, which is how that got through. These test the
 * condition: refuse on a scheduled fire, allow on any other unattended run.
 */
describe('self-reschedule guard condition', () => {
  const prev = process.env.MWA_FAST_CHAT;
  beforeAll(() => { process.env.MWA_FAST_CHAT = '0'; });
  afterAll(() => { if (prev === undefined) delete process.env.MWA_FAST_CHAT; else process.env.MWA_FAST_CHAT = prev; });

  /** A brain that tries to schedule `again` first, then finishes. */
  const brainThatReschedules = (again: string): Provider => {
    let n = 0;
    return {
      id: 'stub', model: 'stub', price: [0, 0],
      chat: async (): Promise<ChatResult> => ({
        text: JSON.stringify(n++ === 0
          ? { action: 'schedule', instruction: again, every_minutes: 1440 }
          : { action: 'done', summary: 'did the work' }),
        usage: { input: 1, output: 1 },
      }),
    };
  };

  const run = async (instruction: string, again: string, extra: Record<string, unknown>) => {
    const dir = mkdtempSync(join(tmpdir(), 'mwa-guard-'));
    const mem = new MwaMemory('guard-test', join(dir, 'guard.db'));
    try {
      const brain = brainThatReschedules(again);
      const r = await runAgent({
        instruction, dir, memory: mem, brain, worker: brain, interactive: false,
        budget: { maxSteps: 6, maxWallMs: 30_000 }, ...extra,
      });
      return { r, pending: await mem.pendingScheduled() };
    } finally {
      mem.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('refuses a SCHEDULED FIRE re-creating its own task, and the run carries on', async () => {
    const { r, pending } = await run(
      'In 124 minutes, write a file called note-2.txt saying check 2 ran. Do not do it now; just schedule it for later.',
      'write a file called note-2.txt saying check 2 ran',
      { dueNow: true },
    );
    expect(pending).toHaveLength(0);           // nothing re-created
    expect(r.summary).toBe('did the work');    // it went on to finish rather than stopping
  }, 60_000);

  it('ALLOWS an unattended mailbox run to create the recurring task it was asked for', async () => {
    const { pending } = await run(
      'summarize my inbox daily',
      'Summarize my inbox',
      {}, // interactive:false, but NOT a scheduled fire — the mailbox / resolver case
    );
    expect(pending).toHaveLength(1);
    expect(pending[0].instruction).toBe('Summarize my inbox');
    expect(pending[0].recur).toBe('every:1440');
  }, 60_000);

  it('allows a scheduled fire to schedule something genuinely DIFFERENT', async () => {
    const { pending } = await run(
      'check whether the deploy finished',
      'email Sarah the release notes once it is out',
      { dueNow: true },
    );
    expect(pending).toHaveLength(1);
  }, 60_000);
});
