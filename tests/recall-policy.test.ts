/**
 * BL-31 — recall like Claude Code + AWM (Robert, 2026-10-16): recalling is cheap and a different question
 * is welcome ("not the same exact query, but rather additional context"). Only an exact repeat is
 * skipped; one empty recall is free, and the nudges no longer tell the agent to stop recalling.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function run(queries: string[]) {
  const { runAgent } = await import('../src/agent.js');
  const { MwaMemory } = await import('../src/awm.js');
  const dir = mkdtempSync(join(tmpdir(), 'mwa-recall-'));
  const mem = new MwaMemory('recall-policy-test', join(dir, 'm.db')); // empty store: every recall finds nothing
  const prompts: string[] = [];
  let n = 0;
  const brain = { id: 's', model: 's', price: [0, 0] as [number, number], chat: async (input: any) => {
    if (!String(input.system ?? '').includes('TRUST BOUNDARY')) return { text: '{}', usage: { input: 1, output: 1 } };
    prompts.push(String(input.messages?.[0]?.content ?? ''));
    const q = queries[n++];
    return { text: JSON.stringify(q !== undefined ? { action: 'recall', query: q } : { action: 'done', summary: 'ok', outcome: 'no-change' }), usage: { input: 1, output: 1 } };
  } };
  const prev = process.env.MWA_FAST_CHAT; process.env.MWA_FAST_CHAT = '0';
  try {
    const r = await runAgent({ instruction: 'find the account details', dir, memory: mem as any, brain, worker: brain, interactive: false, plan: false, budget: { maxSteps: 12, maxWallMs: 30_000 } } as any);
    return { prompts, history: (r as any).history as string[] ?? [], reason: String(r.reason) };
  } finally { if (prev === undefined) delete process.env.MWA_FAST_CHAT; else process.env.MWA_FAST_CHAT = prev; mem.close(); rmSync(dir, { recursive: true, force: true }); }
}

describe('the recall policy (BL-31)', () => {
  it('two different questions that share a long prefix both run — only the whole query decides a repeat', async () => {
    const a = 'what is the apex account deadline and the budget';
    const b = 'what is the apex account deadline and the main contact';
    expect(a.slice(0, 40)).toBe(b.slice(0, 40)); // the old 40-character signature called these the same
    const { prompts } = await run([a, b]);
    const all = prompts.join('\n');
    expect(all).toContain('recall("what is the apex account deadline and the budget")');
    expect(all).toContain('recall("what is the apex account deadline and the main contact")');
    expect(all).not.toMatch(/skipped repeat recall/);
  }, 60_000);

  it('the exact same query is still skipped, with a nudge to ask for different context', async () => {
    const { prompts } = await run(['apex deadline', 'Apex  deadline!']);
    const all = prompts.join('\n');
    expect(all).toMatch(/skipped repeat recall "Apex {2}deadline!"/);
    expect(all).toMatch(/You already ran that exact recall\. Ask for different context/);
    expect(all).not.toMatch(/Stop re-asking your memory/);
  }, 60_000);

  it('one empty recall invites a rephrase; a second empty one in a row says memory has nothing more', async () => {
    const { prompts } = await run(['apex deadline', 'APX-31 due date']);
    expect(prompts[1]).toMatch(/try once more with different wording or the exact name or identifier/);
    expect(prompts[2]).toMatch(/Memory has nothing more on this/);
  }, 60_000);

  it('the recall tool tells the model a rephrase is cheap and an exact repeat is not', async () => {
    const { BRAIN_TOOLS } = await import('../src/brain.js');
    const d = BRAIN_TOOLS.find((t) => t.name === 'recall')!.description;
    expect(d).toMatch(/different wording or the exact name or identifier/);
    expect(d).toMatch(/Never repeat the same query/);
  });
});

describe('the primed pool can follow the topic (BL-31 experiment option, off by default)', () => {
  it('primeDecayFrom accepts only a factor in (0, 1]; anything else is off', async () => {
    const { primeDecayFrom } = await import('../src/agent.js');
    expect(primeDecayFrom(undefined, undefined)).toBe(1);
    expect(primeDecayFrom(undefined, '')).toBe(1);
    expect(primeDecayFrom(undefined, '0.8')).toBe(0.8);
    expect(primeDecayFrom(0.5, '0.8')).toBe(0.5); // the run option wins over the env
    for (const bad of ['0', '-1', '1.5', 'abc']) expect(primeDecayFrom(undefined, bad)).toBe(1);
  });

  /**
   * A run with a scripted memory: recall answers by query from a fixed table, so every score is
   * known and nothing depends on the models. The model's moves are scripted too.
   */
  type Mem = { id: string; concept: string; content: string; score: number };
  const mem = (id: string, score: number): Mem => ({ id, concept: `${id} fact`, content: `the ${id} fact`, score });
  async function scripted(o: { start: Mem[]; byQuery: Record<string, Mem[]>; moves: any[]; primeDecay?: number; primeCap?: number; files?: Record<string, string>; maxSteps?: number }) {
    const { runAgent } = await import('../src/agent.js');
    const { MwaMemory } = await import('../src/awm.js');
    const dir = mkdtempSync(join(tmpdir(), 'mwa-pool-'));
    for (const [f, t] of Object.entries(o.files ?? {})) writeFileSync(join(dir, f), t);
    const m = new MwaMemory('pool-test', join(dir, 'm.db'));
    const INSTR = 'work the account desk';
    (m as any).recall = async (q: string) => (q === INSTR ? o.start : o.byQuery[q] ?? []).map((x) => ({ ...x }));
    const prompts: string[] = [];
    let n = 0;
    const brain = { id: 's', model: 's', price: [0, 0] as [number, number], chat: async (input: any) => {
      if (!String(input.system ?? '').includes('TRUST BOUNDARY')) return { text: '{}', usage: { input: 1, output: 1 } };
      prompts.push(String(input.messages?.[0]?.content ?? ''));
      const mv = o.moves[n++] ?? { action: 'done', summary: 'ok', outcome: 'no-change' };
      return { text: JSON.stringify(mv), usage: { input: 1, output: 1 } };
    } };
    const prev = { fast: process.env.MWA_FAST_CHAT, bridge: process.env.MWA_ENTITY_BRIDGE };
    process.env.MWA_FAST_CHAT = '0'; process.env.MWA_ENTITY_BRIDGE = '0';
    try {
      const r = await runAgent({ instruction: INSTR, dir, memory: m as any, brain, worker: brain, interactive: false, plan: false, primeCap: o.primeCap ?? 2, primeDecay: o.primeDecay, budget: { maxSteps: o.maxSteps ?? 12, maxWallMs: 60_000 } } as any);
      const pool = (p: string) => p.slice(p.indexOf('PRIOR KNOWLEDGE'), p.indexOf('PRIOR KNOWLEDGE') >= 0 ? undefined : 0);
      return { pools: prompts.map(pool), reason: String(r.reason), prompts };
    } finally {
      for (const [k, v] of [['MWA_FAST_CHAT', prev.fast], ['MWA_ENTITY_BRIDGE', prev.bridge]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      m.close(); rmSync(dir, { recursive: true, force: true });
    }
  }

  // Account A at task start; the run moves to B, then back to A (BL-30's return-to-first-account).
  const switching = {
    start: [mem('alpha-deadline', 0.9), mem('alpha-budget', 0.8)],
    byQuery: {
      'beta contact': [mem('beta-contact', 0.5), mem('beta-renewal', 0.4)],
      'beta renewal': [mem('beta-renewal', 0.5)],
      'alpha deadline again': [mem('alpha-deadline', 0.6), mem('alpha-budget', 0.55)],
    },
    // A is worked for three steps first, so with a fade its weights are tiny by the time B pushes it
    // out: a memory that kept that stale weight could never come back on its fresh score.
    files: { 'a1.txt': 'item one', 'a2.txt': 'item two', 'a3.txt': 'item three' },
    moves: [
      { action: 'read', path: 'a1.txt' }, { action: 'read', path: 'a2.txt' }, { action: 'read', path: 'a3.txt' },
      { action: 'recall', query: 'beta contact' }, { action: 'recall', query: 'beta renewal' }, { action: 'recall', query: 'alpha deadline again' },
    ],
  };

  it('with a fade, the pool follows the run to B and comes back to A, ranked by fresh scores, not stale fades', async () => {
    const { pools } = await scripted({ ...switching, primeDecay: 0.3 });
    // After the first B recall (move 4), B holds the pool.
    expect(pools[4]).toContain('beta-contact fact');
    expect(pools[4]).not.toContain('alpha-deadline fact');
    // Back on A: its memories return by their new scores. A stale fade would keep B in the pool.
    const last = pools[pools.length - 1];
    expect(last).toContain('alpha-deadline fact');
    expect(last).toContain('alpha-budget fact');
    expect(last).not.toContain('beta-');
  }, 60_000);

  it('a recall that returns a memory the pool already holds gives it its weight back, so it is not the one evicted', async () => {
    // Faded once (x0.3): alpha-deadline 0.27, alpha-budget 0.24. The recall returns alpha-budget
    // again at 0.7 and a new beta-contact at 0.25. Refreshed, alpha-budget (0.7) and alpha-deadline
    // (0.27) keep the two places; without the refresh alpha-budget (0.24) would lose to beta (0.25).
    const { pools } = await scripted({
      start: [mem('alpha-deadline', 0.9), mem('alpha-budget', 0.8)],
      byQuery: { 'alpha budget and the new contact': [mem('alpha-budget', 0.7), mem('beta-contact', 0.25)] },
      moves: [{ action: 'recall', query: 'alpha budget and the new contact' }],
      primeDecay: 0.3,
    });
    expect(pools[1]).toContain('alpha-budget fact');
    expect(pools[1]).toContain('alpha-deadline fact');
    expect(pools[1]).not.toContain('beta-contact fact');
  }, 60_000);

  it('without a fade, ranking is by score as before: the higher-scored start-of-task memories never leave', async () => {
    const { pools } = await scripted(switching);
    for (const p of pools) {
      expect(p).toContain('alpha-deadline fact');
      expect(p).toContain('alpha-budget fact');
      expect(p).not.toContain('beta-');
    }
  }, 60_000);

  it('recalls that only re-find memories the cap cuts are not progress: the run still ends stuck', async () => {
    const byQuery: Record<string, Mem[]> = {};
    const moves: any[] = [];
    for (let i = 0; i < 10; i++) { byQuery[`question ${i}`] = [mem(`minor-${i}`, 0.1)]; moves.push({ action: 'recall', query: `question ${i}` }); }
    const { reason, prompts } = await scripted({ start: [mem('alpha-deadline', 0.9), mem('alpha-budget', 0.8)], byQuery, moves, maxSteps: 12 });
    expect(reason).toBe('stuck');
    expect(prompts.join('\n')).toMatch(/recall\("question 0"\) -> \+0/);
  }, 60_000);

  it('"two empty recalls in a row" means in a row: another action in between starts the count over', async () => {
    const { prompts } = await scripted({
      start: [], byQuery: {}, files: { 'notes.txt': 'nothing here' },
      moves: [{ action: 'recall', query: 'first question' }, { action: 'read', path: 'notes.txt' }, { action: 'recall', query: 'second question' }],
    });
    expect(prompts[3]).toMatch(/try once more with different wording/);
    expect(prompts[3]).not.toMatch(/Memory has nothing more on this/);
  }, 60_000);
});
