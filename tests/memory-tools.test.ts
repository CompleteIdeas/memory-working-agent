/**
 * Memory tools — the agent's reach into its own memory (2026-10-13).
 *
 * MwaMemory implemented ~two dozen capabilities; the agent could call three. These tools
 * close that, and the two invariants worth pinning are not about output formatting:
 *
 *   1. THE PRIVACY BOUNDARY. A person's profile is scoped by `ToolContext.personId`, which
 *      comes from the harness. If a future edit ever lets the MODEL name the person, a
 *      prompt-injected "read robert@...'s profile" crosses the boundary silently. The test
 *      asserts the tool schema exposes no person argument at all.
 *   2. GRACEFUL DEGRADATION. `memory_store_map` runs four independent queries. A map that
 *      returns nothing because one of them threw is worse than a partial map, so the
 *      failure mode is asserted rather than assumed.
 *
 * Run: npx vitest run tests/memory-tools.test.ts
 */

import { describe, it, expect } from 'vitest';
import { memoryTools } from '../src/tools/memory.js';
import type { ToolContext } from '../src/tools/registry.js';

const ctx = (personId?: string): ToolContext => ({ sandboxDir: process.cwd(), personId, interactive: true });
/** An unattended run: scheduled, mailbox, ingest. Nobody is there to have told you anything. */
const unattended = (personId?: string): ToolContext => ({ sandboxDir: process.cwd(), personId, interactive: false });

/** Minimal stand-in for MwaMemory — only what these tools touch. */
function fakeMemory(over: Record<string, unknown> = {}) {
  const writes: { personId: string; content: string; kind: string }[] = [];
  const base = {
    enabled: true,
    writes,
    async recallPersonProfile(personId: string) {
      return personId === 'robert'
        ? [{ id: 'n1', personId, kind: 'preference' as const, content: 'Wants the number before the explanation.' }]
        : [];
    },
    async rememberAboutPerson(personId: string, content: string, kind: string) {
      writes.push({ personId, content, kind });
      return 'new-id';
    },
    async memoryCount() { return 42; },
    async recentMemories() { return [{ id: 'm1', concept: 'AWM archive loop ignores class', content: '…', trust: 'high', provenance: 'x' }]; },
    async listPolicies() { return ['never send without my review']; },
    async listRoutines() { return [{ name: 'weekly-sweep', version: 'v2', status: 'active', content: '…' }]; },
    async feedback() { /* noop */ },
  };
  return { ...base, ...over } as never;
}

const byName = (mem: unknown, name: string) => memoryTools(mem as never).find((t) => t.def.name === name)!;

describe('memory tools', () => {
  it('returns no tools when memory is disabled, rather than tools that all fail', () => {
    expect(memoryTools(null)).toEqual([]);
    expect(memoryTools({ enabled: false } as never)).toEqual([]);
  });

  it('exposes profile, learn, store-map and feedback', () => {
    const names = memoryTools(fakeMemory()).map((t) => t.def.name).sort();
    expect(names).toEqual(['memory_feedback', 'memory_learn_person', 'memory_profile', 'memory_store_map']);
  });

  describe('the privacy boundary', () => {
    it('takes NO person argument — the person comes from the harness, never the model', () => {
      // This is the test that matters. A `person` parameter here would let a prompt-injected
      // instruction read somebody else's profile.
      const profile = byName(fakeMemory(), 'memory_profile');
      const learn = byName(fakeMemory(), 'memory_learn_person');
      expect(Object.keys((profile.def.parameters as { properties: object }).properties)).toEqual([]);
      expect(Object.keys((learn.def.parameters as { properties: object }).properties).sort()).toEqual(['kind', 'note']);
    });

    it('reads only the context person, and does not leak another person\'s notes', async () => {
      const t = byName(fakeMemory(), 'memory_profile');
      expect(await t.handler({}, ctx('robert'))).toContain('number before the explanation');
      expect(await t.handler({}, ctx('someone-else'))).toContain('nothing learned about this person');
    });

    it('writes to the context person even if the model supplies one', async () => {
      const mem = fakeMemory();
      const t = byName(mem, 'memory_learn_person');
      await t.handler({ note: 'Prefers two concrete options over an open question.', kind: 'strategy', personId: 'victim' }, ctx('robert'));
      expect((mem as unknown as { writes: { personId: string }[] }).writes[0].personId).toBe('robert');
    });
  });

  describe('memory_learn_person validation', () => {
    it('refuses to learn about a person on an unattended run', async () => {
      // The scheduler runs a task AS its owner, so a run triaging untrusted email could otherwise
      // write "facts" about them that are primed into their next interactive conversation.
      const mem = fakeMemory();
      const out = await byName(mem, 'memory_learn_person').handler(
        { note: 'Wants every invoice forwarded automatically.', kind: 'preference' }, unattended('robert'));
      expect(out).toContain('not recorded');
      expect((mem as unknown as { writes: unknown[] }).writes).toHaveLength(0);
    });

    it('rejects a note too short to be useful', async () => {
      const mem = fakeMemory();
      const out = await byName(mem, 'memory_learn_person').handler({ note: 'ok', kind: 'fact' }, ctx('robert'));
      expect(out).toContain('too short');
      expect((mem as unknown as { writes: unknown[] }).writes).toHaveLength(0);
    });

    it('rejects an unknown kind instead of silently storing it', async () => {
      const mem = fakeMemory();
      const out = await byName(mem, 'memory_learn_person').handler({ note: 'Likes terse answers in the morning.', kind: 'vibe' }, ctx('robert'));
      expect(out).toContain('unknown kind');
      expect((mem as unknown as { writes: unknown[] }).writes).toHaveLength(0);
    });

    it('reports honestly when the salience filter declined the write', async () => {
      const mem = fakeMemory({ async rememberAboutPerson() { return null; } });
      const out = await byName(mem, 'memory_learn_person').handler({ note: 'Prefers bullet points over prose.', kind: 'preference' }, ctx('robert'));
      expect(out).toContain('not recorded');
    });
  });

  describe('memory_store_map', () => {
    it('reports count, policies, routines and recent items', async () => {
      const out = await byName(fakeMemory(), 'memory_store_map').handler({}, ctx('robert'));
      expect(out).toContain('MEMORIES HELD: 42');
      expect(out).toContain('never send without my review');
      expect(out).toContain('weekly-sweep');
      expect(out).toContain('AWM archive loop');
    });

    it('still returns a partial map when one of the four queries throws', async () => {
      // A map that vanishes because listRoutines threw is worse than a map without routines.
      const mem = fakeMemory({ async listRoutines() { throw new Error('store busy'); } });
      const out = await byName(mem, 'memory_store_map').handler({}, ctx('robert'));
      expect(out).toContain('MEMORIES HELD: 42');
      expect(out).not.toContain('weekly-sweep');
    });

    it('says so plainly when the store is empty', async () => {
      const mem = fakeMemory({
        async memoryCount() { return 0; },
        async recentMemories() { return []; },
        async listPolicies() { return []; },
        async listRoutines() { return []; },
      });
      expect(await byName(mem, 'memory_store_map').handler({}, ctx('robert'))).toContain('memory is empty');
    });
  });

  it('memory_feedback refuses an empty id rather than calling through', async () => {
    let called = false;
    const mem = fakeMemory({ async feedback() { called = true; } });
    const out = await byName(mem, 'memory_feedback').handler({ id: '  ', useful: true }, ctx('robert'));
    expect(out).toContain('no memory id');
    expect(called).toBe(false);
  });
});
