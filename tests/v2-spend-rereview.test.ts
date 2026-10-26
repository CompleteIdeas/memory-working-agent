// v2 slice A3b, second review (scratchpad/a3b-rereview/p6–p8): what the spend meter and the caps must also get right.
// Each case is a regression test asserting the CORRECT behaviour.
//   1 (HIGH) follow-ups scheduled by a capped run share its allowance — never multiply it;
//   2 a repeating follow-up gets a per-fire limit AND a total, and stops firing when the total is spent;
//   3–4 per-model list prices (an escalation is projected at the strong tier's price; sol at $2/$10; cache tokens
//       priced; an unpriced model is not free under a cap; a local model is);
//   5 a reaped Try's spend from token-log lines that carry no cost is priced from their tokens;
//   6 a call that throws after paying is billed; a call that lands after its Try reported is added to the Try;
//   7 the scheduler forgets a running Try's live spend even when its run throws;
//   8 finish grace is one last step, not every step up to 1.25×;
//   9 a planned job the person stops is not retried and does not go on to its next step.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MwaMemory } from '../src/awm.js';
import { runAgent } from '../src/agent.js';
import { RoutedProvider } from '../src/model-router.js';
import { resolveProvider, listPrice } from '../src/provider.js';
import { tickScheduler } from '../src/scheduler.js';
import { resetAppDb } from '../src/v2/db.js';
import { createJob, addTry, claimTry, endTry, getJob, triesOf, runCapUsd, fireBudget, jobBySchedule, loggedSpend, addTryCost, runningSpend, linkTry } from '../src/v2/jobs.js';
import { resetEstimateCache } from '../src/v2/estimate.js';
import { metered, newLedger, withLedger, closeLedger, callCostUsd, allowanceLeft } from '../src/spend.js';
import { priceFor } from '../src/model-prices.js';
import type { Provider, ChatInput, ChatResult } from '../src/provider.js';

const saved = { fast: process.env.MWA_FAST_CHAT, plan: process.env.MWA_PLAN, runlog: process.env.MWA_RUNLOG, tokens: process.env.MWA_TOKEN_LOG, gate: process.env.MWA_LESSON_GATE, key: process.env.OPENROUTER_API_KEY };
let logDir = '', dir = '', mem: MwaMemory;
beforeAll(() => {
  process.env.MWA_FAST_CHAT = '0'; process.env.MWA_PLAN = 'off'; process.env.MWA_LESSON_GATE = 'off';
  logDir = mkdtempSync(join(tmpdir(), 'mwa-a3b2-logs-'));
  process.env.MWA_RUNLOG = join(logDir, 'runs.jsonl'); process.env.MWA_TOKEN_LOG = join(logDir, 'tokens.jsonl');
  dir = mkdtempSync(join(tmpdir(), 'mwa-a3b2-'));
  mem = new MwaMemory('a3b-rereview', join(dir, 'm.db'));
});
afterAll(() => {
  mem.close();
  for (const [k, v] of Object.entries({ MWA_FAST_CHAT: saved.fast, MWA_PLAN: saved.plan, MWA_RUNLOG: saved.runlog, MWA_TOKEN_LOG: saved.tokens, MWA_LESSON_GATE: saved.gate, OPENROUTER_API_KEY: saved.key })) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(logDir, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => { resetAppDb(':memory:'); resetEstimateCache(); });

const msg = { system: 'x', messages: [{ role: 'user' as const, content: 'x' }] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const later = (i: number) => mem.addScheduledTask(`Finish part ${i} tomorrow`, Date.now() + 86_400_000, { task: `Finish part ${i}`, request: `Finish part ${i}` });

/** A scripted model at 1¢ a call taking local recall steps; `onStep(n, input)` runs inside the run (its ledger). */
function model(o: { onStep?: (n: number, input: ChatInput) => Promise<void> | void; finishAt?: number; read?: boolean } = {}) {
  let n = 0, calls = 0;
  const p: Provider & { calls: () => number } = { id: 'stub', model: 'stub', price: [10, 0], calls: () => calls, chat: async (input: ChatInput): Promise<ChatResult> => {
    calls++;
    const usage = { input: 1000, output: 0 };
    const sys = String(input.system ?? '');
    if (sys.startsWith('You are wrapping up a task.')) return { text: 'Read part of the rules so far.', usage };
    if (!sys.includes('TRUST BOUNDARY')) return { text: '{}', usage };
    n++;
    await o.onStep?.(n, input);
    if (o.finishAt && n >= o.finishAt) return { text: JSON.stringify({ action: 'done', summary: 'The rules say a dressage test is ridden in a 20 by 60 metre arena.', outcome: 'no-change' }), usage };
    // `read` steps (a local file each time) count as progress, so a long run is not ended as stuck
    if (o.read) return { text: JSON.stringify({ action: 'read', path: `rules-part-${n}.txt` }), usage };
    return { text: JSON.stringify({ action: 'recall', query: `eventing dressage rule number ${n}` }), usage };
  } };
  return p;
}
const run = (brain: Provider, jobId: string, budget: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  runAgent({ instruction: 'What do the eventing rules say about dressage tests?', dir, memory: mem, brain, worker: brain, interactive: false, plan: false, jobId, dueNow: true,
    budget: { maxSteps: 40, maxWallMs: 60_000, ...budget }, ...extra } as Parameters<typeof runAgent>[0]);

// ── 1 (HIGH) ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('follow-ups share the run\'s allowance (review p6 §6: 20¢ became 77¢)', () => {
  it('three follow-ups scheduled by a 20¢ run, which then spends what it may: at most 20¢ authorised in all', async () => {
    const ids: string[] = [];
    const brain = model({ onStep: async (n) => { if (n <= 3) ids.push((await later(n))!); } });
    const r = await run(brain, 'follow01-0000', { maxUsd: 0.2, stepUsd: 0.01 });
    const caps = ids.map((id) => jobBySchedule(id)!.cap_usd!);
    expect(caps).toHaveLength(3);
    for (const c of caps) expect(c).toBeGreaterThan(0);
    expect(r.capHit).toBe('usd');
    expect(r.costUsd).toBeCloseTo(brain.calls() / 100, 9);
    expect(r.costUsd + caps.reduce((s, c) => s + c, 0)).toBeLessThanOrEqual(0.2 + 1e-9);
  }, 60_000);
  it('at the ledger: each follow-up takes a share, and spent + reserved + what is left is the cap', async () => {
    const l = newLedger({ cap: 0.2 });
    l.usd = 0.01;
    const ids = await withLedger(l, async () => [await later(1), await later(2), await later(3)]);
    const caps = ids.map((id) => jobBySchedule(id!)!.cap_usd!);
    expect(caps[0]).toBeGreaterThan(caps[1]);
    expect(l.reserved).toBeCloseTo(caps.reduce((s, c) => s + c, 0), 6);
    expect(l.usd + l.reserved + allowanceLeft(l)!).toBeCloseTo(0.2, 6);
    l.usd = 0.2; // whatever the run does next, its own cap check counts the reservations (the run test above)
    expect(allowanceLeft(l)).toBe(0);
  });
});

// ── 2 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('a repeating follow-up of a capped run', () => {
  it('gets a per-fire limit of min(25¢, its share) and its share as a total; it stops firing once that is spent', async () => {
    const l = newLedger({ cap: 0.2 });
    const rid = await withLedger(l, () => mem.addScheduledTask('Check the page every hour', Date.now() + 3_600_000, { task: 'Check the page', request: 'Check the page', recur: 'hourly' } as never));
    const job = jobBySchedule(rid!)!;
    expect(job.cap_total_usd).toBeCloseTo(0.095, 6); // half of (20¢ − one call's worth)
    expect(job.cap_usd).toBeCloseTo(0.095, 6); // min(25¢ fire default, the share)
    expect(l.reserved).toBeCloseTo(0.095, 6);
    const f1 = addTry(job.id, { trigger: 'fire' });
    expect(runCapUsd(job.id, f1.id)).toBeCloseTo(0.095, 6);
    claimTry(f1.id, {}); endTry(f1.id, { reason: 'done', costUsd: 0.06, steps: 3 });
    const f2 = addTry(job.id, { trigger: 'fire' });
    expect(runCapUsd(job.id, f2.id)).toBeCloseTo(0.035, 6); // what is left of the total
    claimTry(f2.id, {}); endTry(f2.id, { reason: 'done', costUsd: 0.034, steps: 3 });
    const f3 = addTry(job.id, { trigger: 'fire' });
    expect(fireBudget(job.id, f3.id)).toMatchObject({ wait: true, exhausted: true });
  });
  it('the scheduler pauses it when the total is spent', async () => {
    const l = newLedger({ cap: 0.04 });
    const rid = await withLedger(l, () => mem.addScheduledTask('Check the entries page every hour', Date.now() + 60_000, { task: 'Check the entries page', request: 'Check the entries page', recur: 'hourly' } as never));
    const job = jobBySchedule(rid!)!;
    const f0 = addTry(job.id, { trigger: 'fire' });
    claimTry(f0.id, {}); endTry(f0.id, { reason: 'done', costUsd: 0.015, steps: 1 });
    const ran: string[] = [];
    await tickScheduler({ memory: mem, brain: {} as never, worker: {} as never, outRoot: join(dir, 'sched'), checksAllowed: false, watchGate: null, now: () => Date.now() + 120_000,
      budgetHold: () => ({ held: false, usedUsd: 0, budgetUsd: null }), onFire: async () => { /* */ }, runAgent: (async (o: { jobId: string }) => { ran.push(o.jobId); return { summary: 'ok', reason: 'done', steps: 1, toolCalls: 1, costUsd: 0, durationMs: 0 }; }) as never });
    expect(ran).toHaveLength(0);
    const task = (await mem.pendingScheduled(Date.now() + 10 * 86_400_000)).find((t) => t.id === rid) ?? (await mem.listScheduled?.())?.find?.((t: { id: string }) => t.id === rid);
    expect(getJob(job.id)!.status === 'paused' || (task as { paused?: boolean } | undefined)?.paused === true).toBe(true);
  });
});

// ── 3–4 ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('list prices per model', () => {
  it('resolveProvider prices each model: luna → sol is projected dearer (review p7)', () => {
    process.env.OPENROUTER_API_KEY = 'sk-fake';
    const luna = resolveProvider('openrouter:openai/gpt-6-luna'), sol = resolveProvider('openrouter:openai/gpt-6.1-sol');
    expect(sol.price).toEqual([2, 10]);
    const r = new RoutedProvider(luna, sol);
    expect(r.priceRatio('fetch', 'reason')).toBeGreaterThan(1);
    expect(callCostUsd(sol.price, { input: 100_000, output: 10_000 })).toBeCloseTo(0.3, 9);
    // a provider built with the flat OpenRouter price is still projected by its model's row
    const flatLuna: Provider = { id: 'a', model: 'openai/gpt-6-luna', price: [0.5, 1.5], chat: async () => ({ text: '', usage: { input: 0, output: 0 } }) };
    const flatSol: Provider = { id: 'b', model: 'openai/gpt-6.1-sol', price: [0.5, 1.5], chat: async () => ({ text: '', usage: { input: 0, output: 0 } }) };
    expect(new RoutedProvider(flatLuna, flatSol).priceRatio('fetch', 'reason')).toBeGreaterThan(2);
  });
  it('Opus is priced as Opus; Anthropic cache reads and writes at their rates (review p6 §5)', () => {
    expect(priceFor('claude-opus-5-5')).toMatchObject({ in: 4, out: 20 });
    expect(priceFor('anthropic/claude-opus-4.1')).toMatchObject({ in: 15, out: 75 });
    expect(listPrice('claude-sonnet-4-6')).toEqual([3, 15]);
    const want = (200 * 3 + 300 * 15 + 40_000 * 0.3 + 10_000 * 3.75) / 1e6;
    expect(callCostUsd([3, 15], { input: 200, output: 300, cacheRead: 40_000, cacheWrite: 10_000 })).toBeCloseTo(want, 12);
    // OpenAI-style: cached tokens are inside `input`, not added again
    expect(callCostUsd([2, 10], { input: 1_000_000, output: 0, cacheRead: 500_000, cacheInInput: true })).toBeCloseTo(2, 12);
    // the provider's own bill wins
    expect(callCostUsd([2, 10], { input: 1_000_000, output: 0, cost: 0.123 }, { model: 'openai/gpt-6.1-sol' })).toBe(0.123);
  });
  it('an unpriced model is not free under a cap (counted at $10/$30); a local model is', async () => {
    expect(callCostUsd([0, 0], { input: 1_000_000, output: 0 }, { model: 'mystery-9', capped: true })).toBeCloseTo(10, 9);
    expect(callCostUsd([0, 0], { input: 1_000_000, output: 0 }, { model: 'mystery-9', capped: false })).toBe(0);
    expect(callCostUsd([0, 0], { input: 1_000_000, output: 0 }, { model: 'llama', local: true, capped: true })).toBe(0);
    const unknown: Provider = { id: 'x:mystery-9', model: 'mystery-9', price: [0, 0], chat: async () => ({ text: '', usage: { input: 1_000_000, output: 0 } }) };
    const local: Provider = { id: 'ollama:llama', model: 'llama', price: [0, 0], chat: async () => ({ text: '', usage: { input: 1_000_000, output: 0 } }) };
    const capped = newLedger({ cap: 50 });
    await withLedger(capped, async () => { await metered(unknown).chat(msg); await metered(local).chat(msg); });
    expect(capped.usd).toBeCloseTo(10, 9);
    expect(listPrice('mystery-9')).toEqual([10, 30]); // resolveProvider's price for an unknown model
  });
});

// ── 5 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('a reaped Try\'s spend from the token log (review p6 §7)', () => {
  it('lines without a cost are priced from their tokens; no lines at all is null (unknown), not 0', () => {
    const t0 = 100_000;
    writeFileSync(process.env.MWA_TOKEN_LOG!, Array.from({ length: 10 }, (_, i) => JSON.stringify({ ts: t0 + i * 1000, job: 'abcdef12', model: 'gemini-3.8-flash', in: 50_000, out: 2000 })).join('\n') + '\n');
    try {
      const v = loggedSpend({ schedule_id: 'abcdef12-xxxx', started_at: t0 - 10, ended_at: t0 + 20_000 });
      expect(v).toBeCloseTo(10 * (50_000 * 0.3 + 2000 * 2.5) / 1e6, 9);
      expect(loggedSpend({ schedule_id: 'zzzzzzzz-xxxx', started_at: t0, ended_at: t0 + 20_000 })).toBeNull();
      // ...so a reaped Try with no record counts its whole allowance (not free)
      const { job: j, try: t1 } = createJob({ kind: 'background', title: 'r', capUsd: 0.2 }, { trigger: 'first', scheduleId: 'zzzzzzzz-xxxx' });
      claimTry(t1!.id, { now: t0 }); endTry(t1!.id, { reason: 'error', outcome: 'could-not', endedBy: 'reaper', endedAt: t0 + 5_000, startedAt: t0 });
      expect(runCapUsd(j.id, addTry(j.id, { trigger: 'resume-after-restart' }).id)).toBe(0);
    } finally { writeFileSync(process.env.MWA_TOKEN_LOG!, ''); }
  });
});

// ── 6 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('calls that are paid for but not returned (review p6 §2, §3)', () => {
  it('a call that throws after the provider paid for tokens is billed before the error goes on', async () => {
    const p: Provider = { id: 'e', model: 'e', price: [10, 0], chat: async () => { throw Object.assign(new Error('502 after a paid retry'), { usage: { input: 1000, output: 0 } }); } };
    const l = newLedger();
    await withLedger(l, async () => { await expect(metered(p).chat(msg)).rejects.toThrow(/502/); });
    expect(l.usd).toBeCloseTo(0.01, 9);
  });
  it('a call landing after its Try reported (the lesson judge past its timeout) is added to the Try', async () => {
    const { job: j, try: t } = createJob({ kind: 'background', title: 'late' }, { trigger: 'first' });
    claimTry(t!.id, {});
    const slow: Provider = { id: 's', model: 's', price: [0, 0], chat: async () => { await sleep(40); return { text: 'x', usage: { input: 1, output: 1, cost: 0.05 } }; } };
    const fire = newLedger();
    await withLedger(fire, async () => {
      const call = metered(slow).chat(msg); // raced and abandoned
      await Promise.race([call, sleep(5)]);
    });
    endTry(t!.id, { reason: 'done', costUsd: fire.usd }); // the run reports (0 so far)
    closeLedger(fire, (usd) => addTryCost(t!.id, usd));
    await sleep(80);
    expect(triesOf(j.id)[0].cost_usd).toBeCloseTo(0.05, 9);
  });
});

// ── 7 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('the scheduler and a run that throws', () => {
  it('forgets the Try\'s live spend (finally) and records what the fire spent before it threw', async () => {
    const { job: j, try: t } = createJob({ kind: 'background', title: 'thrower', capUsd: 1 }, { trigger: 'first', dueAt: 1000 });
    const id = await mem.addScheduledTask('Do the thing', 1000, { task: 'Do the thing', request: 'Do the thing', v2job: j.id, v2try: t!.id } as never);
    linkTry(t!.id, id!, 1000);
    const paid: Provider = { id: 'p', model: 'p', price: [0, 0], chat: async () => ({ text: '', usage: { input: 1, output: 1, cost: 0.02 } }) };
    let seenLive = false;
    await tickScheduler({ memory: mem, brain: {} as never, worker: {} as never, outRoot: join(dir, 'sched2'), now: () => 5_000, checksAllowed: false, watchGate: null,
      budgetHold: () => ({ held: false, usedUsd: 0, budgetUsd: null }), onFire: async () => { /* */ },
      runAgent: (async () => { await metered(paid).chat(msg); seenLive = runningSpend.has(t!.id); throw new Error('boom'); }) as never });
    expect(seenLive).toBe(true);
    expect(runningSpend.has(t!.id)).toBe(false);
    expect(triesOf(j.id)[0]).toMatchObject({ state: 'ended', reason: 'error' });
    expect(triesOf(j.id)[0].cost_usd).toBeCloseTo(0.02, 9);
  });
});

// ── 8 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('finish grace is one last step (review p8)', () => {
  it('a run that never finishes stops one step past the cap at most, not at 1.25×', async () => {
    const strict = model({ read: true }), graced = model({ read: true });
    const a = await run(strict, 'grace0a1-0000', { maxUsd: 0.2, stepUsd: 0.01 });
    const b = await run(graced, 'grace0b1-0000', { maxUsd: 0.2, stepUsd: 0.01, finishGrace: true });
    expect(a.capHit).toBe('usd');
    expect(b.capHit).toBe('usd');
    // one more step (1¢; a step that also folds history into its summary costs one call more), never 1.25× the cap
    expect(b.costUsd - a.costUsd).toBeGreaterThanOrEqual(0.01 - 1e-9);
    expect(b.costUsd - a.costUsd).toBeLessThanOrEqual(0.02 + 1e-9);
    expect(b.costUsd).toBeLessThan(0.2 * 1.25);
  }, 60_000);
});

// ── 9 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('Stop during a planned job (found in the live check)', () => {
  beforeAll(() => { process.env.MWA_PLAN = 'on'; });
  afterAll(() => { process.env.MWA_PLAN = 'off'; });
  it('Stop in step 2 of 3: no retry, no step 3, "stopped", and the cost is what was spent', async () => {
    const ctl = new AbortController();
    const seen: string[] = [];
    let calls = 0;
    const brain: Provider = { id: 'p', model: 'p', price: [10, 0], chat: async (input: ChatInput): Promise<ChatResult> => {
      calls++;
      const usage = { input: 1000, output: 0 };
      const sys = String(input.system ?? ''), user = `${sys} ${JSON.stringify(input.messages)}`;
      if (sys.includes('You are the PLANNER')) return { text: JSON.stringify({ steps: [{ task: 'Read the dressage rules' }, { task: 'Read the jumping rules' }, { task: 'Write the study notes' }] }), usage };
      if (!sys.includes('TRUST BOUNDARY')) return { text: '{}', usage };
      const step = /This is step (\d) of 3/.exec(user)?.[1] ?? '?';
      seen.push(step + (/A previous attempt did not finish this step/.test(user) ? 'retry' : ''));
      if (step === '1') return { text: JSON.stringify({ action: 'done', summary: 'The dressage rules say a test is ridden in a 20 by 60 metre arena.', outcome: 'no-change' }), usage };
      if (step === '2') ctl.abort(); // the person presses Stop while step 2 is working
      return { text: JSON.stringify({ action: 'recall', query: `jumping rule ${calls}` }), usage };
    } };
    const r = await runAgent({ instruction: 'Read the dressage rules, then read the jumping rules, then write the study notes', dir, memory: mem, brain, worker: brain, interactive: false, plan: true, jobId: 'stopplan-0000', dueNow: true,
      signal: ctl.signal, budget: { maxSteps: 30, maxWallMs: 60_000 } } as Parameters<typeof runAgent>[0]);
    expect(r.reason).toBe('stopped');
    expect(seen.some((s) => s.startsWith('3'))).toBe(false);
    expect(seen.some((s) => s.endsWith('retry'))).toBe(false);
    expect(r.costUsd).toBeCloseTo(calls / 100, 9);
    expect(r.summary).toMatch(/^Stopped after 2 of 3 planned steps/);
  }, 60_000);
});
