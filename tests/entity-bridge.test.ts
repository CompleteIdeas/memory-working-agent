/**
 * Pilot G1P/C2 (2026-10-27, prime log): the question's own results held the answer, and the entity bridge —
 * recalling for capitalised words found in them — merged memories that outscored them and pushed the answer out of
 * the ten. A bridged memory is a guess at a second hop: at most MWA_BRIDGE_SLOTS of them, in the last slots.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Mem = { id: string; concept: string; content: string; score: number };
const INSTR = 'What is the current cost cap for the build loop?';
// ten results of the question's own, the answer among them; each names "Gauntlet", a word the bridge will follow
const own: Mem[] = Array.from({ length: 10 }, (_, i) => ({ id: `own${i}`, concept: `cap note ${i}`, content: i === 3 ? 'the cap is $40 since the Gauntlet review' : `a note ${i} about spend near the Gauntlet`, score: 0.6 - i * 0.03 }));
// what "Gauntlet" recalls: six memories that outscore every one of the question's own
const bridged: Mem[] = Array.from({ length: 6 }, (_, i) => ({ id: `br${i}`, concept: `Gauntlet design ${i}`, content: `the Gauntlet benchmark holds the harness fixed, part ${i}`, score: 0.95 - i * 0.01 }));

async function primeOf(env: Record<string, string | undefined>): Promise<string[]> {
  const { runAgent } = await import('../src/agent.js');
  const { MwaMemory } = await import('../src/awm.js');
  const dir = mkdtempSync(join(tmpdir(), 'mwa-bridge-'));
  const m = new MwaMemory('bridge-test', join(dir, 'm.db'));
  (m as any).recall = async (q: string) => (q === INSTR ? own : q === 'Gauntlet' ? bridged : []).map((x) => ({ ...x }));
  (m as any).sourcesOf = undefined;
  let system = '';
  const brain = { id: 's', model: 's', price: [0, 0] as [number, number], chat: async (input: any) => {
    const sys = String(input.system ?? '');
    if (!sys.includes('TRUST BOUNDARY')) return { text: '{}', usage: { input: 1, output: 1 } };
    system ||= `${sys}\n${String(input.messages?.[0]?.content ?? '')}`; // the PRIOR KNOWLEDGE block rides in the first message
    return { text: JSON.stringify({ action: 'done', summary: 'ok', outcome: 'no-change' }), usage: { input: 1, output: 1 } };
  } };
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries({ MWA_FAST_CHAT: '0', ...env })) { prev[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try {
    await runAgent({ instruction: INSTR, dir, memory: m as any, brain, worker: brain, interactive: false, plan: false, budget: { maxSteps: 4, maxWallMs: 20_000 } } as any);
    const block = system.slice(system.indexOf('PRIOR KNOWLEDGE'));
    return [...block.matchAll(/^\d+\. \[([^\]]+)\]/gm)].map((x) => x[1]);
  } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    m.close(); rmSync(dir, { recursive: true, force: true });
  }
}

describe('the entity bridge stays under the question\'s own results', () => {
  it('fills at most two of the ten, in the last slots, however high its own results score', async () => {
    const concepts = await primeOf({ MWA_ENTITY_BRIDGE: undefined, MWA_BRIDGE_SLOTS: undefined });
    expect(concepts).toHaveLength(10);
    expect(concepts.slice(0, 8)).toEqual(own.slice(0, 8).map((o) => o.concept)); // the question's own, in its own order
    expect(concepts).toContain('cap note 3'); // the answer stays in
    expect(concepts.slice(8)).toEqual(['Gauntlet design 0', 'Gauntlet design 1']); // two second hops, last
  }, 60_000);
  it('with no slots for it, the prime is the question\'s own ten; off, likewise', async () => {
    expect(await primeOf({ MWA_BRIDGE_SLOTS: '0' })).toEqual(own.map((o) => o.concept));
    expect(await primeOf({ MWA_ENTITY_BRIDGE: '0' })).toEqual(own.map((o) => o.concept));
  }, 60_000);
});
