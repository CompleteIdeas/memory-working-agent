/**
 * The cached prefix must be byte-identical on every step of a run (H-2, 2026-10-13).
 *
 * An agent loop re-sends the system prompt and every tool schema on each step. Before this
 * change MWA also concatenated the instruction, working dir, standing preferences and the
 * whole domain pack into the per-step USER message, so the prefix changed every step and no
 * provider could cache any of it.
 *
 * The failure mode this test exists to catch is silent. If someone later moves a varying
 * value back into `runSystem` — a step counter, a timestamp, the recalled block — the cache
 * misses on every call, costs go back up, and NOTHING else fails: the agent still works, the
 * tests still pass, and the only evidence is a bill. So the invariant is asserted directly.
 *
 * Run: npx vitest run tests/prompt-cache.test.ts
 */

import { describe, it, expect } from 'vitest';
import { runAgent } from '../src/agent.js';
import { NullMemory } from '../src/awm.js';
import type { Provider, ChatInput, ChatResult } from '../src/provider.js';

/** Records every system string and cache flag it is asked to send. */
class RecordingProvider implements Provider {
  id = 'test:recording';
  model = 'test-model';
  price: [number, number] = [0, 0];
  systems: string[] = [];
  cacheFlags: (boolean | undefined)[] = [];
  userMessages: string[] = [];
  private calls = 0;

  async chat(input: ChatInput): Promise<ChatResult> {
    this.systems.push(input.system ?? '');
    this.cacheFlags.push(input.cache);
    this.userMessages.push(input.messages.map((m) => m.content).join('\n'));
    this.calls++;
    // Take a couple of steps, then finish, so the loop runs more than one iteration.
    if (this.calls < 3) {
      return {
        text: '',
        toolCalls: [{ name: 'list_files', args: { path: '.' } }],
        usage: { input: 10, output: 5, cacheRead: this.calls > 1 ? 1000 : 0, cacheWrite: this.calls === 1 ? 1000 : 0 },
      };
    }
    return {
      text: '',
      toolCalls: [{ name: 'done', args: { summary: 'finished the test task' } }],
      usage: { input: 10, output: 5, cacheRead: 1000, cacheWrite: 0 },
    };
  }
}

async function run(provider: RecordingProvider) {
  return await runAgent({
    instruction: 'List the files and then stop.',
    dir: process.cwd(),
    brain: provider,
    // A second recorder stands in for the codegen worker: runAgent requires one, and this
    // test never dispatches, so it is only here to satisfy the cost accounting at the end.
    worker: new RecordingProvider(),
    memory: new NullMemory(),
    budget: { maxSteps: 6, maxWallMs: 30_000 },
  } as Parameters<typeof runAgent>[0]);
}

describe('prompt cache boundary', () => {
  it('sends a byte-identical system prefix on every step', async () => {
    const p = new RecordingProvider();
    await run(p);
    expect(p.systems.length).toBeGreaterThan(1);
    const unique = new Set(p.systems);
    // The whole point: one distinct prefix, however many steps ran.
    expect(unique.size).toBe(1);
  });

  it('asks the provider to cache that prefix', async () => {
    const p = new RecordingProvider();
    await run(p);
    expect(p.cacheFlags.every((f) => f === true)).toBe(true);
  });

  it('carries the run-invariant sections in the system block, not the per-step message', async () => {
    const p = new RecordingProvider();
    await run(p);
    const system = p.systems[0];
    // These are constant for a run and were previously re-sent in every user message.
    expect(system).toContain('INSTRUCTION:');
    expect(system).toContain('WORKING DIR:');
    expect(p.userMessages[0]).not.toContain('INSTRUCTION:');
    expect(p.userMessages[0]).not.toContain('WORKING DIR:');
  });

  it('keeps the volatile tail OUT of the cached prefix', async () => {
    const p = new RecordingProvider();
    await run(p);
    // RECENT STEPS changes every step by construction; if it ever lands in the system
    // block the prefix stops being stable and every call misses the cache.
    for (const s of p.systems) expect(s).not.toContain('RECENT STEPS');
    expect(p.userMessages.some((m) => m.includes('RECENT STEPS') || m.includes('No steps yet'))).toBe(true);
  });

  it('reports cache read/write so a silently-missing cache is visible', async () => {
    const p = new RecordingProvider();
    const res = await run(p);
    // Without this accounting a broken prefix is indistinguishable from no caching.
    expect(res.usage.cacheRead).toBeGreaterThan(0);
    expect(res.usage.cacheWrite).toBeGreaterThan(0);
  });
});
