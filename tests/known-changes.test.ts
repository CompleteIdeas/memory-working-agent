/**
 * BL-56 — a brief carries what its sources announced had changed. BL-53/54: the email moving Max's dentist to
 * Thursday 4:00 was read once; every later morning plan read the calendar's Wednesday 3:30 and said that, and the
 * chat answered from those plans. The change was in memory, but the plan's recall runs on "create a daily plan…".
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MOVED = "Max's dentist cleaning moved to Thu Nov 12 at 4:00 PM, from Wed Nov 11 at 3:30 PM — email from Bright Smile Dental";

const withMem = async <T>(fn: (dir: string, mem: import('../src/awm.js').MwaMemory) => Promise<T>): Promise<T> => {
  const { MwaMemory } = await import('../src/awm.js');
  const dir = mkdtempSync(join(tmpdir(), 'mwa-bl56-'));
  const mem = new MwaMemory('bl56', join(dir, 'm.db'));
  const prev = process.env.MWA_FAST_CHAT; process.env.MWA_FAST_CHAT = '0';
  try { return await fn(dir, mem); } finally {
    if (prev === undefined) delete process.env.MWA_FAST_CHAT; else process.env.MWA_FAST_CHAT = prev;
    mem.close(); rmSync(dir, { recursive: true, force: true });
  }
};

/** A brain whose main loop plays `actions`; the change-learning pass answers `learned`, every other side call {}. */
const scripted = (actions: Record<string, unknown>[], learned: unknown[] = []) => {
  const systems: string[] = []; let i = 0;
  return {
    systems,
    brain: { id: 's', model: 's', price: [0, 0] as [number, number], chat: async (input: { system?: string }) => {
      const system = String(input.system ?? ''); systems.push(system);
      if (/Extract ONLY CHANGES/.test(system)) return { text: JSON.stringify({ facts: learned }), usage: { input: 1, output: 1 } };
      if (!system.includes('TRUST BOUNDARY')) return { text: '{}', usage: { input: 1, output: 1 } };
      return { text: JSON.stringify(actions[Math.min(i++, actions.length - 1)]), usage: { input: 1, output: 1 } };
    } },
  };
};
const calendar = { defs: () => [{ name: 'calendar__list_events', description: 'list events', parameters: { type: 'object', properties: {} } }], has: (x: string) => x === 'calendar__list_events', call: async () => 'Wed 2026-11-11 15:30 Max - dentist cleaning' } as never;
const fire = (personId: string) => ({ instruction: 'Create a daily morning plan', personId, interactive: false, plan: false, jobId: 'plan1234', jobRecur: 'daily:07:00', tools: calendar, budget: { maxSteps: 4, maxWallMs: 20_000 } });

describe('the changes a person\'s sources announced', () => {
  it('are listed for that person, newest first, recent, current and once each', async () => {
    await withMem(async (_dir, mem) => {
      const w = (content: string, tags: string[]) => mem.write(content.slice(0, 40), content, ['topic=world', ...tags], { canonical: true });
      await w('Lily zoo trip moved to Fri Nov 13.', ['kind=change', 'for=sam']);
      await w(MOVED, ['kind=change', 'for=sam']);
      await w(MOVED, ['kind=change', 'for=sam']); // learned again by a later fire
      await w('Rose price changed to $1.45.', ['kind=change', 'for=maya']); // someone else's
      await w('Max has a dentist cleaning on Wed Nov 11.', ['for=sam']); // not a change
      const got = await mem.listChanges({ sinceMs: Date.now() - 86_400_000, person: 'sam' });
      expect(got.map((c) => c.content)).toEqual([MOVED, 'Lily zoo trip moved to Fri Nov 13.']);
      expect(await mem.listChanges({ sinceMs: Date.now() + 60_000, person: 'sam' })).toEqual([]); // outside the window
    });
  }, 60_000);

  it('a recurring fire tags what it learns as a change for its person, and the next fire is shown it, fenced', async () => {
    await withMem(async (dir, mem) => {
      const { runAgent } = await import('../src/agent.js');
      const first = scripted([{ action: 'calendar__list_events' }, { action: 'done', summary: 'Max: dentist moved to Thursday 4:00.' }], [{ concept: 'Max dentist moved', content: MOVED }]);
      await runAgent({ ...fire('sam'), dir, memory: mem, brain: first.brain, worker: first.brain } as never);
      expect((await mem.listChanges({ sinceMs: 0, person: 'sam' })).map((c) => c.content)).toEqual([MOVED]);

      const next = scripted([{ action: 'calendar__list_events' }, { action: 'done', summary: 'ok' }]);
      await runAgent({ ...fire('sam'), dir, memory: mem, brain: next.brain, worker: next.brain } as never);
      const main = next.systems.find((s) => s.includes('TRUST BOUNDARY'))!;
      expect(main).toMatch(/CHANGES THIS PERSON'S SOURCES ANNOUNCED[^]*⚠ EXTERNAL CONTENT from known_changes[^]*moved to Thu Nov 12 at 4:00 PM[^]*has not caught up/);

      // Not another person's job, and not a chat.
      const other = scripted([{ action: 'done', summary: 'ok' }]);
      await runAgent({ ...fire('maya'), dir, memory: mem, brain: other.brain, worker: other.brain } as never);
      expect(other.systems.find((s) => s.includes('TRUST BOUNDARY'))).not.toMatch(/SOURCES ANNOUNCED/);
      const chat = scripted([{ action: 'done', summary: 'ok' }]);
      await runAgent({ instruction: 'When is the dentist?', userMessage: 'When is the dentist?', personId: 'sam', interactive: true, plan: false, dir, memory: mem, brain: chat.brain, worker: chat.brain, budget: { maxSteps: 3, maxWallMs: 20_000 } } as never);
      expect(chat.systems.find((s) => s.includes('TRUST BOUNDARY'))).not.toMatch(/SOURCES ANNOUNCED/);
    });
  }, 90_000);
});
