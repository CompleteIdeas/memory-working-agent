/**
 * Sampled answers (experience pilot, 2026-10-24; src/agent.ts answerSamples / mergePrompt / readMerge). A question
 * answered from memory came out right two times in three on four of eighteen questions. With MWA_ANSWER_SAMPLES set,
 * the answer is drafted that many times from the same context and merged into one that keeps every figure any draft
 * gave; when the drafts disagree or all hedge, a stronger tier takes over (Robert: "if it fails multiple times,
 * escalate to Sol"), or, with none above, the merge stands.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoutedProvider } from '../src/model-router.js';
import { answerSamples, mergePrompt, readMerge } from '../src/agent.js';

const Q = 'What are the BL-05 fan-out limits: the maximum depth, and the pending follow-ups per job, per run and per goal?';
const DONE = 'BL-05 limits: depth at most 2; pending follow-ups capped at 2 per job and 3 per run. Unattended scheduling stops at 50 pending jobs.';
const DRAFT = 'BL-05 caps depth at 2, follow-ups at 2 per job, 3 per run and 5 per goal; unattended scheduling stops at 50 pending jobs.';
const MERGED = 'BL-05 limits: depth at most 2; pending follow-ups at most 2 per job, 3 per run and 5 per goal; unattended or tainted scheduling stops once the person has 50 or more pending jobs.';

type Script = { done: string; draft: string; merge: string };
const fake = (name: string, s: Script) => {
  const seen: { kind: string; prompt: string }[] = [];
  const usage = { input: 1, output: 1 };
  const p = { id: name, model: name, price: [0, 0] as [number, number], chat: async (input: any) => {
    const sys = String(input.system ?? ''); const msg = String(input.messages?.[0]?.content ?? '');
    if (sys.startsWith('You merge')) { seen.push({ kind: 'merge', prompt: msg }); return { text: s.merge, usage }; }
    if (!sys.includes('TRUST BOUNDARY')) return { text: '{}', usage };
    if (/Write your final answer now as plain text/.test(msg)) { seen.push({ kind: 'draft', prompt: msg }); return { text: s.draft, usage }; }
    seen.push({ kind: 'step', prompt: msg });
    return { text: JSON.stringify({ action: 'done', summary: s.done }), usage };
  } };
  return { p, seen };
};
const memoryOff = { enabled: false, async recall() { return []; }, async listPolicies() { return []; }, setSessionId() { /* */ }, async addScheduledTask() { return null; }, async logAction() { return null; } };

const run = async (brain: any, extra: Record<string, unknown> = {}) => {
  const { runAgent } = await import('../src/agent.js');
  const dir = mkdtempSync(join(tmpdir(), 'mwa-samples-'));
  vi.stubEnv('MWA_FAST_CHAT', '0');
  try {
    return await runAgent({ instruction: Q, dir, memory: memoryOff as any, brain, worker: brain, interactive: true, plan: false, budget: { maxSteps: 10, maxWallMs: 30_000 }, ...extra } as any);
  } finally { rmSync(dir, { recursive: true, force: true }); }
};

describe('the merge helpers', () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  it('MWA_ANSWER_SAMPLES is 1 (off) by default and clamped to 1..5', () => {
    expect(answerSamples({})).toBe(1);
    expect(answerSamples({ MWA_ANSWER_SAMPLES: '3' })).toBe(3);
    expect(answerSamples({ MWA_ANSWER_SAMPLES: '12' })).toBe(5);
    expect(answerSamples({ MWA_ANSWER_SAMPLES: 'many' })).toBe(1);
    expect(answerSamples({ MWA_ANSWER_SAMPLES: '0' })).toBe(1);
  });
  it('the prompt carries the question, every draft and the figure-keeping and verdict rules', () => {
    const p = mergePrompt(Q, ['one', 'two', 'three']);
    expect(p).toContain(`QUESTION: ${Q}`);
    expect(p).toContain('DRAFT 3:\nthree');
    expect(p).toMatch(/Keep every specific figure/);
    expect(p).toMatch(/Never average verdicts into "modify"/);
    expect(p).toMatch(/DRAFTS: agree \| DRAFTS: disagree \| DRAFTS: hedge/);
  });
  it('readMerge strips the marker line and reads the verdict; no marker reads as agree', () => {
    expect(readMerge(`${MERGED}\n\nDRAFTS: disagree`)).toEqual({ answer: MERGED, drafts: 'disagree' });
    expect(readMerge(`${MERGED}\n**DRAFTS: hedge**`)).toEqual({ answer: MERGED, drafts: 'hedge' });
    expect(readMerge(`${MERGED}\nDrafts: Agree`)).toEqual({ answer: MERGED, drafts: 'agree' });
    expect(readMerge(MERGED)).toEqual({ answer: MERGED, drafts: 'agree' });
  });
});

describe('sampled answers in a run', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('off by default: one answer, no drafts, no merge', async () => {
    const b = fake('luna', { done: DONE, draft: DRAFT, merge: `${MERGED}\nDRAFTS: agree` });
    const r = await run(b.p);
    expect(r.reason).toBe('done');
    expect(r.summary).toBe(DONE);
    expect(b.seen.map((s) => s.kind)).toEqual(['step']);
  }, 30_000);

  it('with MWA_ANSWER_SAMPLES=3 the answer is drafted twice more and the merge is the reply', async () => {
    vi.stubEnv('MWA_ANSWER_SAMPLES', '3');
    const b = fake('luna', { done: DONE, draft: DRAFT, merge: `${MERGED}\nDRAFTS: agree` });
    const r = await run(b.p);
    expect(r.reason).toBe('done');
    expect(b.seen.map((s) => s.kind)).toEqual(['step', 'draft', 'draft', 'merge']);
    const merge = b.seen.find((s) => s.kind === 'merge')!.prompt;
    expect(merge).toContain(`DRAFT 1:\n${DONE}`);
    expect(merge).toContain(`DRAFT 3:\n${DRAFT}`);
    expect(r.summary).toBe(MERGED);
    expect(r.history.join('\n')).toMatch(/3 drafts of the answer merged — the drafts agree/);
  }, 30_000);

  it('drafts that disagree hand the run to a stronger model, which answers with the merged draft in hand', async () => {
    vi.stubEnv('MWA_ANSWER_SAMPLES', '2');
    const worker = fake('luna', { done: DONE, draft: DRAFT, merge: `${MERGED}\nDRAFTS: disagree` });
    const boss = fake('sol', { done: 'Sol: ' + MERGED, draft: DRAFT, merge: 'unused' });
    const brain = new RoutedProvider(worker.p, boss.p);
    const r = await run(brain);
    expect(r.reason).toBe('done');
    expect(r.summary).toBe('Sol: ' + MERGED);
    expect(r.history.join('\n')).toMatch(/a stronger model took over: drafts of the answer disagreed/);
    const handed = boss.seen.find((s) => s.kind === 'step')!.prompt;
    expect(handed).toMatch(/A stronger model has taken over: drafts of the answer disagreed/);
    expect(handed).toContain(MERGED); // the merged draft rides along
    expect(boss.seen.filter((s) => s.kind === 'draft')).toHaveLength(0); // sampling happens once per run
  }, 30_000);

  it('with no stronger model above (both tiers the same model) and no memory, the merged answer stands', async () => {
    vi.stubEnv('MWA_ANSWER_SAMPLES', '2');
    const a = fake('luna', { done: DONE, draft: DRAFT, merge: `${MERGED}\nDRAFTS: disagree` });
    const b = fake('luna', { done: 'never reached', draft: DRAFT, merge: 'unused' });
    const brain = new RoutedProvider(a.p, b.p);
    const r = await run(brain);
    expect(r.summary).toBe(MERGED);
    expect(r.history.join('\n')).not.toMatch(/took over/);
    expect(b.seen).toHaveLength(0);
  }, 30_000);

  it('a step of a plan is never sampled', async () => {
    vi.stubEnv('MWA_ANSWER_SAMPLES', '3');
    const b = fake('luna', { done: DONE, draft: DRAFT, merge: `${MERGED}\nDRAFTS: agree` });
    const r = await run(b.p, { planStep: true, subRun: true });
    expect(r.summary).toBe(DONE);
    expect(b.seen.map((s) => s.kind)).toEqual(['step']);
  }, 30_000);
});
