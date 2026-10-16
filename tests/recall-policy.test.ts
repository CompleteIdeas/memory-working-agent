/**
 * BL-31 — recall like Claude Code + AWM (Robert, 2026-10-16): recalling is cheap and a different question
 * is welcome ("not the same exact query, but rather additional context"). Only an exact repeat is
 * skipped; one empty recall is free, and the nudges no longer tell the agent to stop recalling.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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
