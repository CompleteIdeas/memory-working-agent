// v2 slice A3b: the dollar cap on a run, and what a job will cost ("about").
//
// N06 in the approved design: a hand-off with a limit stops AT the limit and waits for the person — "It reached the 15¢
// limit you set. Finish the last 10 pages? About 3¢." — and never continues by itself. Estimates come from the job's
// own tries, else from history (runs.jsonl × tokens.jsonl, by model tier), else a conservative default; every one is
// rounded the way it is said. A finished job carries what was guessed against what it cost.
// Real agent loop, real scheduler, real memory store and real HTTP; only the model is scripted (a fixed price a call).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MwaMemory } from '../src/awm.js';
import { runAgent, spendMeter } from '../src/agent.js';
import { RoutedProvider } from '../src/model-router.js';
import { tickScheduler } from '../src/scheduler.js';
import { startBackgroundWork, continueGoal } from '../src/handoff.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { resetAppDb } from '../src/v2/db.js';
import { createJob, addTry, claimTry, endTry, getJob, triesOf, viewJob, runCapUsd, stampEstimates, linkTry, type JobRow, type TryRow } from '../src/v2/jobs.js';
import { estimateJob, historyStats, roundUsd, usdText, aboutUsd, aboutTime, estimateWork, resetEstimateCache, DEFAULT_RATE, type HistoryStats } from '../src/v2/estimate.js';
import { createV1 } from '../src/api/router.js';
import { ALL_SCOPES, type Caller } from '../src/api/auth.js';
import { v1Routes } from '../src/api/v1.js';
import { setJobRouteDeps, capFor } from '../src/api/routes/jobs.js';
import type { Provider, ChatInput, ChatResult } from '../src/provider.js';

const TEST_CALLER: Caller = { kind: 'session', id: 'session', scopes: new Set(ALL_SCOPES), viaCookie: true };
const saved = { fast: process.env.MWA_FAST_CHAT, plan: process.env.MWA_PLAN, runlog: process.env.MWA_RUNLOG, tokens: process.env.MWA_TOKEN_LOG };
let logDir = '';
beforeAll(() => {
  process.env.MWA_FAST_CHAT = '0'; process.env.MWA_PLAN = 'off';
  // The runs these tests make log to a scratch run log, never the developer's own (and history reads that).
  logDir = mkdtempSync(join(tmpdir(), 'mwa-a3b-logs-'));
  process.env.MWA_RUNLOG = join(logDir, 'runs.jsonl'); process.env.MWA_TOKEN_LOG = join(logDir, 'tokens.jsonl');
});
afterAll(() => {
  for (const [k, v] of [['MWA_FAST_CHAT', saved.fast], ['MWA_PLAN', saved.plan], ['MWA_RUNLOG', saved.runlog], ['MWA_TOKEN_LOG', saved.tokens]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(logDir, { recursive: true, force: true });
});
beforeEach(() => { resetAppDb(':memory:'); resetEstimateCache(); });

// ── Rounding: every estimate is "about" ─────────────────────────────────────────────────────────────────────────

describe('rounding', () => {
  it('to the cent under $1 (at least 1¢), to 5 cents from $1', () => {
    expect([0.0004, 0.004, 0.026, 0.034, 0.15, 0.994].map(roundUsd)).toEqual([0.01, 0.01, 0.03, 0.03, 0.15, 0.99]);
    expect([0.996, 1.0, 1.02, 1.03, 1.124, 1.126, 3.99].map(roundUsd)).toEqual([1, 1, 1, 1.05, 1.1, 1.15, 4]);
    expect([usdText(0.031), usdText(0.9), usdText(1.23), usdText(0.35)]).toEqual(['3¢', '90¢', '$1.25', '35¢']);
    expect(aboutUsd(0.026)).toBe('about 3¢');
  });
  it('times read as a person says them', () => {
    expect([aboutTime(20_000), aboutTime(4 * 60_000), aboutTime(20 * 60_000), aboutTime(80 * 60_000), aboutTime(60 * 60_000)])
      .toEqual(['under a minute', 'about 4 minutes', 'about 20 minutes', 'about 1 hour 20 minutes', 'about 1 hour']);
  });
});

// ── Estimates ───────────────────────────────────────────────────────────────────────────────────────────────────

const job = (o: Partial<JobRow> = {}): JobRow => ({ id: 'j_x', project_id: null, kind: 'background', title: 't', request: 't', person: null, created_at: 0, updated_seq: 0, schedule_id: null,
  legacy_goal_id: null, cap_usd: null, model_tier: null, progress_done: null, progress_total: null, progress_unit: null, remaining: null, where_it_stands: null, stands_trust: null,
  result_ref: null, seen_at: null, status: 'active', archived: 0, session: null, dir: null, legacy_key: null, next_due_at: null, stopped_by: null, schedule_prefix: null,
  est_usd_first: null, est_ms_first: null, ...o });
const tr = (n: number, o: Partial<TryRow> = {}): TryRow => ({ id: `t_${n}`, job_id: 'j_x', n, trigger: n === 1 ? 'first' : 'continue', run_id: null, live_key: null, state: 'ended', due_at: null,
  claimed_by: null, started_at: 1_000, ended_at: 61_000, reason: 'budget', outcome: 'could-not', progress_done: null, progress_total: null, progress_unit: null, remaining: null,
  cost_usd: null, steps: null, tool_calls: null, cap_hit: null, summary: null, tainted: 0, staged: null, est_usd: null, est_ms: null, updated_seq: 0, schedule_id: null,
  pages_read: null, legacy_key: null, ended_by: null, delivered: null, fire_id: null, schedule_prefix: null, ...o });
const noHistory: HistoryStats = { main: null, background: null };

describe('estimates', () => {
  it('from this job: its spend per unit of progress (N06: 63 of 73 pages for 15¢ → about 2¢ to finish, 17¢ again)', () => {
    const e = estimateJob(job(), [tr(1, { cost_usd: 0.15, progress_done: 63, progress_total: 73, progress_unit: 'pages', started_at: 0, ended_at: 630_000 })], { history: noHistory });
    expect(e.basis).toBe('this-job');
    expect(e.samples).toBe(1);
    expect(e.continue).toEqual({ usd: 0.02, ms: 100_000 });
    expect(e.startOver).toEqual({ usd: 0.17, ms: 730_000 });
  });
  it('from this job without a progress figure: what a try of it costs', () => {
    const e = estimateJob(job(), [tr(1, { cost_usd: 0.1, remaining: 'the appendix' }), tr(2, { cost_usd: 0.2, remaining: 'the index' })], { history: noHistory });
    expect(e).toMatchObject({ basis: 'this-job', samples: 2, continue: { usd: 0.15 }, startOver: { usd: 0.45 } });
  });
  it('from this job when it counted its work but finished none yet (0 of 2 steps): what it spent is a floor per unit', () => {
    const e = estimateJob(job(), [tr(1, { cost_usd: 0.03, cap_hit: 'usd', progress_done: 0, progress_total: 2, progress_unit: 'steps', started_at: 0, ended_at: 50_000 })], { history: noHistory });
    expect(e).toMatchObject({ basis: 'this-job', samples: 1, continue: { usd: 0.06, ms: 100_000 }, startOver: { usd: 0.06 } });
  });
  it('a start over resets what counts: only the tries since it', () => {
    const e = estimateJob(job(), [tr(1, { cost_usd: 5, progress_done: 1, progress_total: 10, progress_unit: 'pages' }), tr(2, { trigger: 'start-over', cost_usd: 0.1, progress_done: 5, progress_total: 10, progress_unit: 'pages' })], { history: noHistory });
    expect(e).toMatchObject({ basis: 'this-job', samples: 1, continue: { usd: 0.1 }, startOver: { usd: 0.2 } });
  });
  it('a finished job has nothing to continue', () => {
    const e = estimateJob(job(), [tr(1, { reason: 'done', outcome: 'changed', cost_usd: 0.3, progress_done: 10, progress_total: 10, progress_unit: 'pages' })], { history: noHistory });
    expect(e.continue).toBeUndefined();
    expect(e.startOver?.usd).toBe(0.3);
  });
  it('from history, split by model tier (the background tier priced apart from the main model)', () => {
    const runs = join(logDir, 'h-runs.jsonl'), tokens = join(logDir, 'h-tokens.jsonl');
    const rowsMain = [0.04, 0.05, 0.06, 0.07].map((perPage, i) => ({ ts: 1000 * (i + 1), session: `web-${i}`, pagesRead: 10, costUsd: perPage * 10, durationMs: 200_000 }));
    const rowsBg = [0.002, 0.003, 0.004, 0.005].map((perPage, i) => ({ ts: 10_000 * (i + 1), job: `jobtask${i}-0000`, session: `job_x${i}`, pagesRead: 4, costUsd: perPage * 4, durationMs: 40_000 }));
    const skip = [{ ts: 1, pagesRead: 0, costUsd: 1, durationMs: 1 }, { ts: 2, pagesRead: 3, costUsd: 0, durationMs: 1 }]; // read nothing / cost nothing
    writeFileSync(runs, [...skip, ...rowsMain, ...rowsBg].map((r) => JSON.stringify(r)).join('\n') + '\nnot json\n');
    // the bg flag decides the tier: one chat run's calls were background calls (thinking time), so it counts there
    const calls = [
      ...rowsMain.map((r, i) => ({ ts: r.ts + 10, session: r.session, bg: i === 2 })),
      ...rowsBg.map((r, i) => ({ ts: r.ts + 10, job: `jobtask${i}`, session: r.session, bg: true })),
    ];
    writeFileSync(tokens, calls.map((c) => JSON.stringify(c)).join('\n') + '\n');
    const h = historyStats({ runs, tokens });
    expect(h.main).toMatchObject({ samples: 3, pagesPerRun: 10 });
    expect(h.main!.usdPerPage).toBeCloseTo(0.05, 6);
    expect(h.background).toMatchObject({ samples: 5, pagesPerRun: 4 });
    expect(h.background!.usdPerPage).toBeCloseTo(0.004, 6);
    expect(historyStats({ runs, tokens })).toBe(h); // cached until a log changes
    // a job that counts pages: what is left × the median rate of its tier (background: a Continue runs unattended)
    const e = estimateJob(job(), [tr(1, { cost_usd: 0, progress_done: 0, progress_total: 50, progress_unit: 'pages' })], { history: h });
    expect(e).toMatchObject({ basis: 'history', samples: 5, startOver: { usd: 0.2 }, continue: { usd: 0.2 } });
    // the main tier when the job says so; a job that does not count pages is a typical run
    const m = estimateJob(job({ model_tier: 'main' }), [], { history: h });
    expect(m).toMatchObject({ basis: 'history', samples: 3, startOver: { usd: 0.5 } });
    expect(m.continue).toBeUndefined(); // nothing has run yet
    expect(estimateWork({ pages: 30, tier: 'main', history: h })).toMatchObject({ usd: 1.5, basis: 'history' });
  });
  it('with fewer than three runs in a tier, the conservative default', () => {
    const runs = join(logDir, 'd-runs.jsonl'), tokens = join(logDir, 'd-tokens.jsonl');
    writeFileSync(runs, JSON.stringify({ ts: 5, job: 'aaaaaaaa-1', pagesRead: 2, costUsd: 0.001, durationMs: 1000 }) + '\n');
    writeFileSync(tokens, '');
    const h = historyStats({ runs, tokens });
    expect(h.background).toBeNull();
    const e = estimateJob(job(), [], { history: h });
    expect(e).toMatchObject({ basis: 'default', samples: 0, startOver: { usd: roundUsd(DEFAULT_RATE.usdPerPage * DEFAULT_RATE.pagesPerRun), ms: DEFAULT_RATE.msPerPage * DEFAULT_RATE.pagesPerRun } });
    expect(historyStats(null)).toEqual({ main: null, background: null }); // no logs at all
  });
  it('queued tries are stamped with their estimate, and a starting job keeps its first one', () => {
    const { job: j, try: t } = createJob({ kind: 'background', title: 'Read the rules', request: 'Read the rules' }, { trigger: 'first' });
    linkTry(t!.id, 'sched-1-xxxxxxxx', Date.now());
    const first = getJob(j.id)!;
    expect(first.est_usd_first).toBeGreaterThan(0);
    expect(triesOf(j.id)[0].est_usd).toBe(first.est_usd_first);
    claimTry(t!.id, {});
    endTry(t!.id, { reason: 'budget', outcome: 'could-not', costUsd: 0.12, progress: { done: 3, total: 12, unit: 'pages' } });
    const c = addTry(j.id, { trigger: 'continue', dueAt: Date.now() });
    stampEstimates(j.id);
    expect(triesOf(j.id)[1].est_usd).toBe(0.36); // 9 pages left at 4¢ a page, from this job
    expect(getJob(j.id)!.est_usd_first).toBe(first.est_usd_first); // the first guess stays
    expect(c.id).toBeTruthy();
  });
});

// ── The cap for a run ───────────────────────────────────────────────────────────────────────────────────────────

describe('the dollar cap a run gets', () => {
  it('is the job cap less what was spent since the person last said go', () => {
    const { job: j, try: t1 } = createJob({ kind: 'background', title: 'x', capUsd: 0.15 }, { trigger: 'first' });
    expect(runCapUsd(j.id, t1!.id)).toBe(0.15);
    claimTry(t1!.id, {}); endTry(t1!.id, { reason: 'budget', capHit: 'steps', costUsd: 0.11 });
    const t2 = addTry(j.id, { trigger: 'auto-continue' }); // an automatic continuation spends from the same go-ahead
    expect(runCapUsd(j.id, t2.id)).toBeCloseTo(0.04, 6);
    claimTry(t2.id, {}); endTry(t2.id, { reason: 'budget', capHit: 'usd', costUsd: 0.04 });
    const t3 = addTry(j.id, { trigger: 'auto-continue' });
    expect(runCapUsd(j.id, t3.id)).toBe(0); // used up: the scheduler does not start it
    const t4 = addTry(j.id, { trigger: 'continue' }); // the person's Continue is a new go-ahead
    expect(runCapUsd(j.id, t4.id)).toBe(0.15);
    const free = createJob({ kind: 'background', title: 'y' }, { trigger: 'first' });
    expect(runCapUsd(free.job.id, free.try!.id)).toBeUndefined();
  });
  it('capUsd on Continue / Start over: given and checked, else twice the estimate and at least 5¢', () => {
    expect(capFor({}, 0.02)).toBe(0.05);
    expect(capFor({}, 0.4)).toBe(0.8);
    expect(capFor(undefined, undefined)).toBe(0.05);
    expect(capFor({ capUsd: 0.5 }, 0.02)).toBe(0.5);
    for (const bad of [0, -1, 20.01, '1', Number.NaN, Infinity]) expect(() => capFor({ capUsd: bad }, 0.02)).toThrow(/capUsd/);
    expect(capFor({ capUsd: 20 }, 0)).toBe(20);
  });
});

// ── The run itself: a scripted model at a fixed price per call ──────────────────────────────────────────────────

/** A model that reads one page per step until told it may finish; each call costs `cents` (1000 input tokens at
 *  $10/M = 1¢). Its wrap-up at the cap says how far it got. */
function pricedModel(o: { cents?: number; finish?: () => boolean; pagesTotal?: number } = {}) {
  const per = o.cents ?? 1;
  let page = 0, calls = 0;
  const brain: Provider & { calls: () => number } = {
    id: 'stub', model: 'stub', price: [10, 0], calls: () => calls,
    chat: async (input: ChatInput): Promise<ChatResult> => {
      calls++;
      const usage = { input: 1000 * per, output: 0 };
      const sys = String(input.system ?? '');
      if (sys.startsWith('You are wrapping up a task.')) {
        return { text: `I read ${page} pages of the rules so far.\nPROGRESS: ${page} of ${o.pagesTotal ?? 12} pages\nREMAINING: pages ${page + 1}-${o.pagesTotal ?? 12}`, usage };
      }
      if (!sys.includes('TRUST BOUNDARY')) return { text: '{}', usage };
      if (o.finish?.()) return { text: JSON.stringify({ action: 'done', summary: `I read all ${o.pagesTotal ?? 12} pages and wrote the notes.`, outcome: 'changed', progress: { done: o.pagesTotal ?? 12, total: o.pagesTotal ?? 12, unit: 'pages' } }), usage };
      return { text: JSON.stringify({ action: 'portal__fetch', page: ++page }), usage };
    },
  };
  return brain;
}
function pagesTool() {
  let pages = 0;
  const reg = new ToolRegistry();
  reg.registerAll([{ def: { name: 'portal__fetch', description: 'read a page', parameters: { type: 'object', properties: { page: { type: 'number' } } } }, handler: async () => `page ${++pages} of the rules` }]);
  return reg;
}

describe('a run at its dollar cap', () => {
  it('stops at the cap (one small wrap-up call past it at most), says how far it got, and queues no continuation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mwa-a3b-run-'));
    const mem = new MwaMemory('a3b-run', join(dir, 'm.db'));
    try {
      const brain = pricedModel();
      const r = await runAgent({ instruction: 'Read the eventing rules and write study notes', dir, memory: mem, brain, worker: brain, tools: pagesTool(), interactive: false, plan: false, jobId: 'capjob01-0000', dueNow: true,
        budget: { maxSteps: 30, maxWallMs: 60_000, maxUsd: 0.03 } });
      expect(r).toMatchObject({ reason: 'budget', capHit: 'usd', outcome: 'could-not', progress: { done: 3, total: 12, unit: 'pages' }, remaining: 'pages 4-12' });
      expect(r.costUsd).toBeLessThanOrEqual(0.03 + 0.01 + 1e-9); // the cap, plus the one wrap-up call
      expect(r.costUsd).toBeGreaterThanOrEqual(0.03 - 1e-9);
      expect(r.summary).toMatch(/I read 3 pages/);
      expect(r.summary).not.toMatch(/PROGRESS:|REMAINING:/);
      expect(r.summary).toMatch(/3¢ spending limit/);
      expect(r.resumeQueued).toBeUndefined();
      expect((await mem.pendingScheduled()).filter((t) => t.resumeAttempt)).toHaveLength(0);
      // the same run without a cap reads on (the cap, not something else, stopped it)
      const free = pricedModel();
      const r2 = await runAgent({ instruction: 'Read the eventing rules and write study notes', dir, memory: mem, brain: free, worker: free, tools: pagesTool(), interactive: false, plan: false, jobId: 'capjob02-0000', dueNow: true,
        budget: { maxSteps: 6, maxWallMs: 60_000 } });
      expect(r2.capHit).not.toBe('usd');
      expect(r2.costUsd).toBeGreaterThan(0.04);
    } finally { mem.close(); rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);

  it('a planned run: the cap covers the plan, its steps and their retries; it stops there and queues no resume', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mwa-a3b-plan-'));
    const mem = new MwaMemory('a3b-plan', join(dir, 'm.db'));
    process.env.MWA_PLAN = 'on'; // planning is off for the rest of this file
    try {
      const inner = pricedModel();
      const brain: Provider = { id: 'p', model: 'p', price: [10, 0], chat: async (i) => String(i.system ?? '').includes('You are the PLANNER')
        ? { text: JSON.stringify({ steps: [{ task: 'Read the rules pages one by one' }, { task: 'Write study notes from them' }, { task: 'Check the notes cite pages' }] }), usage: { input: 1000, output: 0 } }
        : inner.chat(i) };
      const r = await runAgent({ instruction: 'Read the eventing rules, then write study notes, then check them', dir, memory: mem, brain, worker: brain, tools: pagesTool(), interactive: false, plan: true, jobId: 'planjob1-0000', dueNow: true,
        budget: { maxSteps: 30, maxWallMs: 60_000, maxUsd: 0.04 } });
      expect(r).toMatchObject({ reason: 'budget', capHit: 'usd', outcome: 'could-not' });
      expect(r.resumeQueued).toBeUndefined();
      expect(r.costUsd).toBeLessThanOrEqual(0.04 + 0.01 + 1e-9);
      expect(r.history[0]).toMatch(/^planned 3 steps/);
      expect(r.summary).toMatch(/4¢ spending limit/);
      expect(r.summary.match(/spending limit/g)).toHaveLength(1); // said once, with the plan's own limit
      expect((await mem.pendingScheduled()).filter((t) => t.resumeAttempt)).toHaveLength(0);
    } finally { process.env.MWA_PLAN = 'off'; mem.close(); rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);

  it('counts each run\'s own spend: two runs in sequence on one provider object', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mwa-a3b-seq-'));
    const mem = new MwaMemory('a3b-seq', join(dir, 'm.db'));
    try {
      // a router over two priced stubs reports each call's own bill (usage.cost), as OpenRouter does
      const stub = pricedModel();
      const billed: Provider = { id: 'b', model: 'b', price: [0, 0], chat: async (i) => { const out = await stub.chat(i); return { ...out, usage: { ...out.usage, cost: 0.01 } }; } };
      const router = new RoutedProvider(billed, billed);
      const go = (jobId: string) => runAgent({ instruction: 'Read the eventing rules and write study notes', dir, memory: mem, brain: router, worker: router, tools: pagesTool(), interactive: false, plan: false, jobId, dueNow: true,
        budget: { maxSteps: 30, maxWallMs: 60_000, maxUsd: 0.03 } });
      const a = await go('seqjob01-0000');
      const b = await go('seqjob02-0000');
      for (const r of [a, b]) {
        expect(r.capHit).toBe('usd');
        expect(r.progress?.done).toBeGreaterThanOrEqual(2); // the second run was not stopped by the first one's spend
        expect(r.costUsd).toBeGreaterThanOrEqual(0.03 - 1e-9);
        expect(r.costUsd).toBeLessThanOrEqual(0.04 + 1e-9);
      }
      expect(b.costUsd).toBeCloseTo(a.costUsd, 6);
      // the meter itself: a provider that already spent (another run's calls) starts this run at zero, and a reset
      // by another run counts from zero again instead of going negative
      const r2 = new RoutedProvider(billed, billed);
      await r2.chat({ system: 'x', messages: [{ role: 'user', content: 'x' }] });
      const meter = spendMeter(r2, () => ({ in: 0, out: 0 }));
      expect(meter()).toBe(0);
      await r2.chat({ system: 'x', messages: [{ role: 'user', content: 'x' }] });
      expect(meter()).toBeCloseTo(0.01, 9);
      r2.reset();
      await r2.chat({ system: 'x', messages: [{ role: 'user', content: 'x' }] });
      expect(meter()).toBeCloseTo(0.02, 9);
    } finally { mem.close(); rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);
});

// ── End to end: hand off with a cap, wait at it, Continue with a priced cap, finish, estimate vs actual ─────────────

describe('a hand-off with a 3¢ limit', () => {
  let server: Server, base = '';
  afterAll(() => { server?.close(); setJobRouteDeps(null); });

  it('stops at the limit and waits for you with a priced Finish; Continue finishes it; the result shows guess vs cost', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mwa-a3b-e2e-'));
    const mem = new MwaMemory('a3b-e2e', join(dir, 'm.db'));
    try {
      let finish = false;
      const brain = pricedModel({ finish: () => finish });
      const reg = pagesTool();
      const started = await startBackgroundWork(mem, { message: 'Read the eventing rules and write me study notes with page numbers.', session: 'web-rules', personId: 'web-p1', workspace: dir, capUsd: 0.03 });
      const jobId = started!.v2JobId!;
      expect(getJob(jobId)).toMatchObject({ cap_usd: 0.03 });
      const firstGuess = getJob(jobId)!.est_usd_first;
      expect(firstGuess).toBeGreaterThan(0); // the first estimate, kept from the start
      const view = () => viewJob(getJob(jobId)!, { running: new Set(), pending: new Set(), now: Date.now() + 10 * 60 * 60_000 });

      let clock = Date.now();
      const tick = async () => {
        clock += 5 * 60_000;
        return tickScheduler({ memory: mem, brain, worker: brain, tools: reg, outRoot: join(dir, 'scheduled'), now: () => clock, checksAllowed: false, watchGate: null, maxSteps: 30,
          budgetHold: () => ({ held: false, usedUsd: 0, budgetUsd: null }), onFire: async () => { /* */ } });
      };
      expect(await tick()).toBe(1);
      const t1 = triesOf(jobId);
      expect(t1).toHaveLength(1);
      expect(t1[0]).toMatchObject({ state: 'ended', reason: 'budget', cap_hit: 'usd', progress_done: 3, progress_total: 12, progress_unit: 'pages' });
      expect(t1[0].cost_usd!).toBeLessThanOrEqual(0.04 + 1e-9);
      // no automatic continuation: nothing queued here or in the store, and another tick runs nothing
      expect((await mem.pendingScheduled()).filter((t) => t.resumeAttempt)).toHaveLength(0);
      expect(await tick()).toBe(0);
      const waiting = view();
      expect(waiting.status).toMatchObject({ state: 'waiting', label: 'Waiting for you', primaryAction: { action: 'continue' } });
      expect(waiting.status.detail).toMatch(/^It reached the 3¢ limit you set\. Finish the last 9 pages\? About \d+¢\.$/);
      expect(waiting.status.primaryAction!.label).toMatch(/^Finish the last 9 pages · about \d+¢$/);
      expect(waiting.estimate).toMatchObject({ basis: 'this-job', samples: 1 });
      const finishUsd = waiting.estimate!.continue!.usd;
      expect(finishUsd).toBeCloseTo(roundUsd((t1[0].cost_usd! / 3) * 9), 6);

      // The person's Continue, over HTTP, with no cap given: twice the estimate, at least 5¢.
      const v1 = createV1(v1Routes(), { authenticate: () => TEST_CALLER, sameOrigin: () => true });
      server = createServer(async (req, res) => { if (!(await v1(req, res))) { res.writeHead(404); res.end(); } });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
      setJobRouteDeps({
        memory: () => ({ addScheduledTask: (i: string, d: number, o: never) => mem.addScheduledTask(i, d, o), cancelScheduled: (id: string) => mem.cancelScheduled(id), getGoal: (id: string) => mem.getGoal(id), setGoalStatus: (id: string, s: never) => mem.setGoalStatus(id, s) }) as never,
        running: () => new Set(), stopLive: () => false, pendingApprovals: () => new Set(), scheduleControl: async () => ({ ok: true, message: '' }),
        continueGoal: (goalId, personId) => continueGoal(mem, { goalId, personId, workspace: dir, holdsReservation: true }),
      });
      const est = await (await fetch(`${base}/jobs/${jobId}/estimate`)).json();
      expect(est).toEqual({ continue: waiting.estimate!.continue, startOver: waiting.estimate!.startOver, basis: 'this-job', samples: 1 });
      const bad = await fetch(`${base}/jobs/${jobId}/continue`, { method: 'POST', headers: { 'idempotency-key': 'a3b-continue-bad', 'content-type': 'application/json' }, body: JSON.stringify({ capUsd: 25 }) });
      expect(bad.status).toBe(400);
      expect(getJob(jobId)!.cap_usd).toBe(0.03); // a refused Continue changes nothing
      const ok = await fetch(`${base}/jobs/${jobId}/continue`, { method: 'POST', headers: { 'idempotency-key': 'a3b-continue-ok1', 'content-type': 'application/json' }, body: '{}' });
      expect(ok.status).toBe(202);
      expect(getJob(jobId)!.cap_usd).toBe(Math.max(0.05, roundUsd(2 * finishUsd)));
      const t2 = triesOf(jobId)[1];
      expect(t2).toMatchObject({ trigger: 'continue', state: 'queued', est_usd: finishUsd });

      finish = true;
      expect(await tick()).toBe(1);
      const doneView = await (await fetch(`${base}/jobs/${jobId}`)).json();
      expect(doneView.job.status).toMatchObject({ state: 'done' });
      const spent = triesOf(jobId).reduce((s, t) => s + (t.cost_usd ?? 0), 0);
      expect(doneView.job.estimateVsActual).toEqual({ estimatedUsd: firstGuess, actualUsd: Math.round(spent * 10_000) / 10_000, text: `I guessed ${aboutUsd(firstGuess!)} · it cost ${usdText(spent)}` });
      expect(doneView.job.estimate.continue).toBeUndefined(); // nothing left to finish
      const after = await (await fetch(`${base}/jobs/${jobId}/estimate`)).json();
      expect(after.continue).toBeUndefined();
      expect(after.startOver.usd).toBeGreaterThan(0);
    } finally { mem.close(); rmSync(dir, { recursive: true, force: true }); }
  }, 120_000);
});
