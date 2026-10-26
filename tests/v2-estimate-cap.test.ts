// v2 slice A3b: the dollar cap on a run, and what a job will cost ("about").
//
// N06 in the approved design: a hand-off with a limit stops AT the limit and waits for the person — "It reached the 15¢
// limit you set. Finish the last 10 pages? About 3¢." — and never continues by itself. Estimates come from the job's
// own tries, else from history (runs.jsonl × tokens.jsonl, by model tier), else a conservative default; every one is
// rounded the way it is said. A finished job carries what was guessed against what it cost.
//
// The review of A3b (scratchpad/a3b-review/p1…p5) found the spend meter under-counting, estimates that blew up or could
// be steered, a first step that always ran, spend checked late, ways around a cap, and a history read that blocked
// the event loop. Each probe is a regression test here, asserting the CORRECT behaviour.
// Real agent loop, real scheduler, real memory store and real HTTP; only the model is scripted (a fixed price a call).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MwaMemory } from '../src/awm.js';
import { runAgent } from '../src/agent.js';
import { RoutedProvider } from '../src/model-router.js';
import { tickScheduler } from '../src/scheduler.js';
import { startBackgroundWork, continueGoal } from '../src/handoff.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { resetAppDb } from '../src/v2/db.js';
import { createJob, addTry, claimTry, endTry, getJob, triesOf, viewJob, runCapUsd, stampEstimates, linkTry, fireBudget, runningSpend, setTryAllowance, updateJob, defaultCapFor, jobBySchedule, type JobRow, type TryRow } from '../src/v2/jobs.js';
import { estimateJob, historyStats, refreshHistory, roundUsd, usdText, aboutUsd, aboutTime, estimateWork, resetEstimateCache, defaultCapUsd, fireCapUsd, DEFAULT_RATE, ESTIMATE_MAX_USD, type HistoryStats } from '../src/v2/estimate.js';
import { metered, newLedger, withLedger } from '../src/spend.js';
import { createV1 } from '../src/api/router.js';
import { ALL_SCOPES, type Caller } from '../src/api/auth.js';
import { v1Routes } from '../src/api/v1.js';
import { setJobRouteDeps, capFor } from '../src/api/routes/jobs.js';
import { jobStatus } from '../src/v2/status.js';
import type { Provider, ChatInput, ChatResult } from '../src/provider.js';

const TEST_CALLER: Caller = { kind: 'session', id: 'session', scopes: new Set(ALL_SCOPES), viaCookie: true };
const saved = { fast: process.env.MWA_FAST_CHAT, plan: process.env.MWA_PLAN, runlog: process.env.MWA_RUNLOG, tokens: process.env.MWA_TOKEN_LOG, samples: process.env.MWA_ANSWER_SAMPLES, gate: process.env.MWA_LESSON_GATE, fire: process.env.MWA_FIRE_CAP_USD };
let logDir = '';
beforeAll(() => {
  process.env.MWA_FAST_CHAT = '0'; process.env.MWA_PLAN = 'off'; process.env.MWA_LESSON_GATE = 'off';
  // The runs these tests make log to a scratch run log, never the developer's own (and history reads that).
  logDir = mkdtempSync(join(tmpdir(), 'mwa-a3b-logs-'));
  process.env.MWA_RUNLOG = join(logDir, 'runs.jsonl'); process.env.MWA_TOKEN_LOG = join(logDir, 'tokens.jsonl');
});
afterAll(() => {
  for (const [k, v] of [['MWA_FAST_CHAT', saved.fast], ['MWA_PLAN', saved.plan], ['MWA_RUNLOG', saved.runlog], ['MWA_TOKEN_LOG', saved.tokens], ['MWA_ANSWER_SAMPLES', saved.samples], ['MWA_LESSON_GATE', saved.gate], ['MWA_FIRE_CAP_USD', saved.fire]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
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
  pages_read: null, legacy_key: null, ended_by: null, delivered: null, fire_id: null, schedule_prefix: null, reads: null, cap_usd: null, ...o });
const noHistory: HistoryStats = { main: null, background: null };
const typicalDefault = roundUsd(DEFAULT_RATE.usdPerPage * DEFAULT_RATE.pagesPerRun); // 30¢

describe('estimates', () => {
  it('from this job: its spend per unit of progress (N06: 63 of 73 pages for 15¢ → about 2¢ to finish, 17¢ again)', () => {
    const e = estimateJob(job(), [tr(1, { cost_usd: 0.15, progress_done: 63, progress_total: 73, progress_unit: 'pages', started_at: 0, ended_at: 630_000 })], { history: noHistory });
    expect(e.basis).toBe('this-job');
    expect(e.samples).toBe(1);
    expect(e.continue).toEqual({ usd: 0.02, ms: 100_000 });
    expect(e.startOver).toEqual({ usd: 0.17, ms: 730_000 });
  });
  it('without a progress figure: never below what a try of it cost, never below a typical run', () => {
    const cheap = estimateJob(job(), [tr(1, { cost_usd: 0.1, remaining: 'the appendix' }), tr(2, { cost_usd: 0.2, remaining: 'the index' })], { history: noHistory });
    expect(cheap).toMatchObject({ basis: 'default', samples: 0, continue: { usd: typicalDefault }, startOver: { usd: 0.6 } });
    const dear = estimateJob(job(), [tr(1, { cost_usd: 0.8, remaining: 'the appendix' })], { history: noHistory });
    expect(dear).toMatchObject({ basis: 'this-job', samples: 1, continue: { usd: 0.8 }, startOver: { usd: 1.6 } });
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

  // review p2: estimates that blew up, or could be steered
  it('"0 of 73" does not multiply the spend by 73 (review p2a: 15¢ became $10.95)', () => {
    const e = estimateJob(job(), [tr(1, { cost_usd: 0.15, cap_hit: 'usd', progress_done: 0, progress_total: 73, progress_unit: 'pages' })], { history: noHistory });
    expect(e.continue!.usd).toBeLessThan(2);
    expect(e.continue!.usd).toBeGreaterThanOrEqual(0.15); // never below what a try of it cost
    expect(e.startOver!.usd).toBeLessThan(2);
  });
  it('one dear early page does not blow up a long job (review p2b: 1 of 100 pages for 40¢)', () => {
    const e = estimateJob(job(), [tr(1, { cost_usd: 0.4, progress_done: 1, progress_total: 100, progress_unit: 'pages' })], { history: noHistory });
    expect(e.continue!.usd).toBeLessThan(ESTIMATE_MAX_USD);
    expect(e.continue!.usd).toBe(3.6); // the total is held to ten times the units seen: 10 pages, 9 left at 40¢
  });
  it('an injected total ("1 of 1000000") is held to the sanity ceiling, and every estimate is at most $20', () => {
    const e = estimateJob(job(), [tr(1, { cost_usd: 1.5, progress_done: 1, progress_total: 1_000_000, progress_unit: 'pages' })], { history: noHistory });
    expect(e.startOver!.usd).toBeLessThanOrEqual(ESTIMATE_MAX_USD);
    expect(e.continue!.usd).toBeLessThanOrEqual(ESTIMATE_MAX_USD);
  });
  it('a progress claim from a run that read outside content is not used to price (tainted: fall back)', () => {
    const t = tr(1, { cost_usd: 0.15, progress_done: 72, progress_total: 73, progress_unit: 'pages', tainted: 1 });
    const e = estimateJob(job(), [t], { history: noHistory });
    // trusted, this would be "1 page left at 0.2¢": instead, a typical run (and never below what the try cost)
    expect(e).toMatchObject({ basis: 'default', continue: { usd: typicalDefault } });
  });
  it('odd rows do not produce NaN or negative prices (review p2c)', () => {
    const over = estimateJob(job(), [tr(1, { cost_usd: 0.1, progress_done: 12, progress_total: 10, progress_unit: 'pages' })], { history: noHistory });
    expect(Number.isNaN(over.startOver!.usd)).toBe(false);
    const neg = estimateJob(job(), [tr(1, { cost_usd: -0.5 }), tr(2, { cost_usd: 0.2 })], { history: noHistory });
    expect(neg.continue!.usd).toBeGreaterThan(0);
    expect(neg.startOver!.usd).toBeGreaterThan(0);
  });

  it('from history, split by model tier (the background tier priced apart from the main model)', () => {
    const runs = join(logDir, 'h-runs.jsonl'), tokens = join(logDir, 'h-tokens.jsonl');
    const rowsMain = [0.04, 0.05, 0.06, 0.07].map((perPage, i) => ({ ts: 1000 * (i + 1), session: `web-${i}`, pagesRead: 10, costUsd: perPage * 10, durationMs: 200_000 }));
    // browser pages count as pages for estimates (the `reads` field), separately from the page budget
    const rowsBg = [0.002, 0.003, 0.004, 0.005].map((perPage, i) => ({ ts: 10_000 * (i + 1), job: `jobtask${i}-0000`, session: `job_x${i}`, pagesRead: 0, reads: 4, costUsd: perPage * 4, durationMs: 40_000 }));
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
    expect(historyStats({ runs, tokens })).toBe(h); // cached
    // a job that counts pages: what is left × the median rate of its tier (background: a Continue runs unattended),
    // the total held to ten times the units seen
    const e = estimateJob(job(), [tr(1, { cost_usd: 0, progress_done: 4, progress_total: 50, progress_unit: 'pages' })], { history: h });
    expect(e).toMatchObject({ basis: 'history', samples: 5, startOver: { usd: 0.16 }, continue: { usd: 0.14 } });
    // the main tier when the job says so; a job that does not count pages is a typical run
    const m = estimateJob(job({ model_tier: 'main' }), [], { history: h });
    expect(m).toMatchObject({ basis: 'history', samples: 3, startOver: { usd: 0.5 } });
    expect(m.continue).toBeUndefined(); // nothing has run yet
    expect(estimateWork({ pages: 30, tier: 'main', history: h })).toMatchObject({ usd: 1.5, basis: 'history' });
  });
  it('runs that read no pages are priced by their steps (the fallback unit)', () => {
    const runs = join(logDir, 's-runs.jsonl'), tokens = join(logDir, 's-tokens.jsonl');
    writeFileSync(runs, [0.01, 0.02, 0.03].map((perStep, i) => JSON.stringify({ ts: 100 + i, job: `stepjob${i}-0`, steps: 4, costUsd: perStep * 4, durationMs: 40_000 })).join('\n') + '\n');
    writeFileSync(tokens, '');
    const h = historyStats({ runs, tokens });
    expect(h.background).toMatchObject({ samples: 0, stepSamples: 3, stepsPerRun: 4 });
    expect(h.background!.usdPerStep).toBeCloseTo(0.02, 9);
    expect(estimateJob(job(), [], { history: h })).toMatchObject({ basis: 'history', samples: 3, startOver: { usd: 0.08 } }); // 4 steps × 2¢
  });
  it('with fewer than three runs in a tier, the conservative default', () => {
    const runs = join(logDir, 'd-runs.jsonl'), tokens = join(logDir, 'd-tokens.jsonl');
    writeFileSync(runs, JSON.stringify({ ts: 5, job: 'aaaaaaaa-1', pagesRead: 2, costUsd: 0.001, durationMs: 1000 }) + '\n');
    writeFileSync(tokens, '');
    const h = historyStats({ runs, tokens });
    expect(h.background).toBeNull();
    const e = estimateJob(job(), [], { history: h });
    expect(e).toMatchObject({ basis: 'default', samples: 0, startOver: { usd: typicalDefault, ms: DEFAULT_RATE.msPerPage * DEFAULT_RATE.pagesPerRun } });
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
    addTry(j.id, { trigger: 'continue', dueAt: Date.now() });
    stampEstimates(j.id);
    expect(triesOf(j.id)[1].est_usd).toBe(0.36); // 9 pages left at 4¢ a page, from this job
    expect(getJob(j.id)!.est_usd_first).toBe(first.est_usd_first); // the first guess stays
  });
});

// ── History reads stay off the hot path (review p5) ─────────────────────────────────────────────────────────────

describe('history at scale', () => {
  it('a 20 MB token log: warm reads under 50 ms; a grown log is read from where it stopped, not again', () => {
    const runs = join(logDir, 'big-runs.jsonl'), tokens = join(logDir, 'big-tokens.jsonl');
    const r: string[] = [];
    let rsLen = 0;
    for (let i = 0; rsLen < 5 * 1024 * 1024; i++) { const l = JSON.stringify({ ts: 1e12 + i * 60_000, job: `job${String(i).padStart(5, '0')}-x`, session: `job_${i}`, instruction: 'x'.repeat(120), reason: 'done', pagesRead: 1 + (i % 9), steps: 3, costUsd: 0.01 + (i % 7) / 100, durationMs: 30_000, summary: 'y'.repeat(150) }); r.push(l); rsLen += l.length + 1; }
    writeFileSync(runs, r.join('\n') + '\n');
    const t: string[] = [];
    let tsLen = 0;
    for (let k = 0; tsLen < 20 * 1024 * 1024; k++) { const l = JSON.stringify({ ts: 1e12 + k * 600, job: `job${String(Math.floor(k / 10)).padStart(5, '0')}`, session: 's', model: 'anthropic/claude-x', in: 12000, out: 400, cost: 0.004, bg: k % 3 === 0 }); t.push(l); tsLen += l.length + 1; }
    writeFileSync(tokens, t.join('\n') + '\n');
    const src = { runs, tokens };
    const cold = historyStats(src);
    expect(cold.background ?? cold.main).toBeTruthy();
    let t0 = performance.now();
    for (let i = 0; i < 200; i++) historyStats(src); // a list of 200 jobs
    expect(performance.now() - t0).toBeLessThan(50);
    // an active run appends calls and a run row: the refresh parses only what was appended
    appendFileSync(tokens, JSON.stringify({ ts: 2e12, job: 'zzzzzzzz', bg: true, cost: 0.01 }) + '\n');
    appendFileSync(runs, JSON.stringify({ ts: 2e12, job: 'zzzzzzzz-1', pagesRead: 2, steps: 2, costUsd: 0.5, durationMs: 1000 }) + '\n');
    refreshHistory(src); // (the first refresh also warms the code up)
    expect(historyStats(src).background?.samples ?? 0).toBeGreaterThan(0);
    appendFileSync(tokens, JSON.stringify({ ts: 2e12 + 1, job: 'zzzzzzzz', bg: true, cost: 0.01 }) + '\n');
    appendFileSync(runs, JSON.stringify({ ts: 2e12 + 1, job: 'zzzzzzzz-2', pagesRead: 1, steps: 1, costUsd: 0.2, durationMs: 1000 }) + '\n');
    t0 = performance.now();
    refreshHistory(src);
    expect(performance.now() - t0).toBeLessThan(50);
    t0 = performance.now();
    historyStats(src);
    expect(performance.now() - t0).toBeLessThan(50);
  }, 60_000);
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
  it('an overshoot leaves 0, and a resume after a restart shares the go-ahead (review p2d)', () => {
    const { job: j, try: t1 } = createJob({ kind: 'background', title: 'x', capUsd: 0.15 }, { trigger: 'first' });
    claimTry(t1!.id, {}); endTry(t1!.id, { reason: 'budget', capHit: 'steps', costUsd: 0.4 });
    expect(runCapUsd(j.id, addTry(j.id, { trigger: 'auto-continue' }).id)).toBe(0);
    expect(runCapUsd(j.id, addTry(j.id, { trigger: 'resume-after-restart' }).id)).toBe(0);
  });
  it('a Try still running counts: its live spend here, else the token log, else its whole allowance (review M6)', () => {
    const { job: j, try: u1 } = createJob({ kind: 'background', title: 'y', capUsd: 0.15 }, { trigger: 'first' });
    claimTry(u1!.id, {});
    const u2 = addTry(j.id, { trigger: 'auto-continue' });
    expect(runCapUsd(j.id, u2.id)).toBe(0); // nothing says what it spent: assume the worst, never the full cap again
    setTryAllowance(u1!.id, 0.1);
    expect(runCapUsd(j.id, u2.id)).toBeCloseTo(0.05, 6); // it was given 10¢
    const l = newLedger(); l.usd = 0.06;
    runningSpend.set(u1!.id, l);
    expect(runCapUsd(j.id, u2.id)).toBeCloseTo(0.09, 6); // its live ledger here says 6¢
    runningSpend.delete(u1!.id);
  });
  it('a reaped Try with no cost: recovered from the token log by its task, else its allowance (review M6)', () => {
    const { job: j, try: t1 } = createJob({ kind: 'background', title: 'z', capUsd: 0.2 }, { trigger: 'first', scheduleId: 'reapme01-aaaa-bbbb' });
    claimTry(t1!.id, { now: 5_000 });
    endTry(t1!.id, { reason: 'error', outcome: 'could-not', endedBy: 'reaper', endedAt: 9_000, startedAt: 5_000 });
    const t2 = addTry(j.id, { trigger: 'resume-after-restart' });
    expect(runCapUsd(j.id, t2.id)).toBe(0); // no log, no allowance on record: assume it was all spent
    setTryAllowance(t1!.id, 0.12);
    expect(runCapUsd(j.id, t2.id)).toBeCloseTo(0.08, 6);
    writeFileSync(process.env.MWA_TOKEN_LOG!, [JSON.stringify({ ts: 6_000, job: 'reapme01', cost: 0.03 }), JSON.stringify({ ts: 7_000, job: 'reapme01', cost: 0.02 }), JSON.stringify({ ts: 7_500, job: 'other000', cost: 1 })].join('\n') + '\n');
    try { expect(runCapUsd(j.id, t2.id)).toBeCloseTo(0.15, 6); } finally { writeFileSync(process.env.MWA_TOKEN_LOG!, ''); }
  });
  it('an allowance below one step (or 1¢) is no allowance: the job waits instead of starting (review p2d, M4)', () => {
    const { job: j, try: v1 } = createJob({ kind: 'background', title: 'z', capUsd: 0.15 }, { trigger: 'first' });
    claimTry(v1!.id, {}); endTry(v1!.id, { reason: 'budget', capHit: 'steps', costUsd: 0.1499, steps: 10 });
    const v2 = addTry(j.id, { trigger: 'auto-continue' });
    expect(fireBudget(j.id, v2.id)).toMatchObject({ wait: true });
    const { job: k, try: w1 } = createJob({ kind: 'background', title: 'w', capUsd: 0.5 }, { trigger: 'first' });
    expect(fireBudget(k.id, w1!.id)).toMatchObject({ wait: false, maxUsd: 0.5, stepUsd: 0.02 });
  });
  it('a repeating job without a limit gets the per-fire default (25¢, MWA_FIRE_CAP_USD; 0 = none)', () => {
    const { job: w } = createJob({ kind: 'recurring', title: 'watch', scheduleId: 'watch-1' });
    const f1 = addTry(w.id, { trigger: 'fire' });
    claimTry(f1.id, {}); endTry(f1.id, { reason: 'done', costUsd: 0.2 });
    const f2 = addTry(w.id, { trigger: 'fire' });
    expect(runCapUsd(w.id, f2.id)).toBe(0.25); // each fire is its own go-ahead
    process.env.MWA_FIRE_CAP_USD = '0';
    try { expect(runCapUsd(w.id, f2.id)).toBeUndefined(); expect(fireCapUsd()).toBeUndefined(); } finally { delete process.env.MWA_FIRE_CAP_USD; }
    process.env.MWA_FIRE_CAP_USD = '0.1';
    try { expect(runCapUsd(w.id, f2.id)).toBe(0.1); } finally { delete process.env.MWA_FIRE_CAP_USD; }
  });
  it('the default limits: twice the estimate or estimate + 3 large steps + wrap-up; ≥25¢ (50¢ first guess); ≤ $5 / $20', () => {
    const step = { usd: 0.02, largest: 0.05, ms: 1000, basis: 'this-job' as const };
    expect(defaultCapUsd(0.02, step, false, 20)).toBe(0.25);
    expect(defaultCapUsd(0.02, step, true, 20)).toBe(0.5);
    expect(defaultCapUsd(0.4, step, false, 20)).toBe(0.8);
    expect(defaultCapUsd(0.1, { ...step, largest: 0.2 }, false, 20)).toBe(0.72); // 0.1 + 0.6 + 0.02
    expect(defaultCapUsd(15, step, false, 20)).toBe(20); // review p2: the default was not clamped
    expect(defaultCapUsd(15, step, false, 5)).toBe(5);
    expect(defaultCapUsd(Number.NaN, step, true, 20)).toBe(0.5);
  });
  it('capUsd on Continue / Start over: the given one checked; else the default policy, never above $20', () => {
    const v = (tries: TryRow[]) => ({ job: job(), tries, estimate: estimateJob(job(), tries, { history: noHistory }) });
    const huge = v([tr(1, { cost_usd: 15, progress_done: 1, progress_total: 2, progress_unit: 'pages', steps: 3 })]);
    expect(capFor({}, huge, 'continue')).toBeLessThanOrEqual(20);
    expect(capFor({}, huge, 'start-over')).toBe(20);
    const small = v([tr(1, { cost_usd: 0.15, progress_done: 63, progress_total: 73, progress_unit: 'pages', steps: 10 })]);
    expect(capFor({}, small, 'continue')).toBe(0.5); // one sample: a first guess, so at least 50¢
    expect(capFor({ capUsd: 0.07 }, small, 'continue')).toBe(0.07);
    for (const bad of [0, -1, 20.01, '1', Number.NaN, Infinity]) expect(() => capFor({ capUsd: bad }, small, 'continue')).toThrow(/capUsd/);
    expect(capFor({ capUsd: 20 }, small, 'continue')).toBe(20);
  });
  it('the buttons say the price, whether it is a first guess, and the limit ("… · about 16¢, up to 40¢")', () => {
    const base = { running: new Set<string>(), pendingApprovals: 0, now: 10_000 };
    const tries = [{ n: 1, trigger: 'first', state: 'ended', reason: 'budget', cap_hit: 'usd', progress_done: 63, progress_total: 73, progress_unit: 'pages' }];
    const known = jobStatus({ kind: 'background', cap_usd: 0.15 }, tries, { ...base, estimates: { continue: { usd: 0.16, ms: 1 }, basis: 'this-job', samples: 3, continueCap: 0.4 } });
    expect(known.primaryAction).toMatchObject({ label: 'Finish the last 10 pages · about 16¢, up to 40¢', limitUsd: 0.4, firstGuess: false });
    expect(known.detail).toBe('It reached the 15¢ limit you set. Finish the last 10 pages? About 16¢.');
    const guess = jobStatus({ kind: 'background', cap_usd: 0.15 }, tries, { ...base, estimates: { continue: { usd: 0.3, ms: 1 }, basis: 'default', samples: 0, continueCap: 0.6 } });
    expect(guess.primaryAction?.label).toBe('Finish the last 10 pages · a first guess, about 30¢, up to 60¢');
    expect(guess.detail).toBe('It reached the 15¢ limit you set. Finish the last 10 pages? A first guess, about 30¢.');
  });
});

// ── The run itself: a scripted model at a fixed price per call ──────────────────────────────────────────────────

/** A model that reads one page per step until told it may finish; each call costs `cents` (1000 input tokens at
 *  $10/M = 1¢, or its own bill with `billed`). Its wrap-up at the cap says how far it got. */
function pricedModel(o: { cents?: number; finish?: () => boolean; pagesTotal?: number; billed?: boolean; recall?: boolean } = {}) {
  const per = o.cents ?? 1;
  let page = 0, calls = 0;
  const brain: Provider & { calls: () => number } = {
    id: 'stub', model: 'stub', price: [10, 0], calls: () => calls,
    chat: async (input: ChatInput): Promise<ChatResult> => {
      calls++;
      const usage = { input: 1000 * per, output: 0, ...(o.billed ? { cost: per / 100 } : {}) };
      const sys = String(input.system ?? '');
      if (sys.startsWith('You are wrapping up a task.')) {
        return { text: `I read ${page} pages of the rules so far.\nPROGRESS: ${page} of ${o.pagesTotal ?? 12} pages\nREMAINING: pages ${page + 1}-${o.pagesTotal ?? 12}`, usage };
      }
      if (!sys.includes('TRUST BOUNDARY')) return { text: '{}', usage };
      if (o.finish?.()) return { text: JSON.stringify({ action: 'done', summary: o.recall ? 'The rules say a dressage test is ridden in a 20 by 60 metre arena and each movement is marked out of ten.' : `I read all ${o.pagesTotal ?? 12} pages and wrote the notes, which cover every rule.`, outcome: 'changed', progress: { done: o.pagesTotal ?? 12, total: o.pagesTotal ?? 12, unit: 'pages' } }), usage };
      // `recall` steps stay on this machine (the outward-reads pause never fires); page steps read outside content
      if (o.recall) return { text: JSON.stringify({ action: 'recall', query: `eventing dressage rule number ${++page}` }), usage };
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
const ask = (o: { memory: MwaMemory; dir: string; brain: Provider; worker?: Provider; jobId: string; budget: Record<string, unknown>; plan?: boolean; instruction?: string }) =>
  runAgent({ instruction: o.instruction ?? 'Read the eventing rules and write study notes', dir: o.dir, memory: o.memory, brain: o.brain, worker: o.worker ?? o.brain, tools: pagesTool(), interactive: false, plan: o.plan ?? false, jobId: o.jobId, dueNow: true,
    budget: { maxSteps: 30, maxWallMs: 60_000, ...o.budget } } as Parameters<typeof runAgent>[0]);

describe('a run at its dollar cap', () => {
  let dir = '', mem: MwaMemory;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'mwa-a3b-run-')); mem = new MwaMemory('a3b-run', join(dir, 'm.db')); });
  afterAll(() => { mem.close(); rmSync(dir, { recursive: true, force: true }); });

  it('stops at the cap (one small wrap-up call past it at most), says how far it got, and queues no continuation', async () => {
    const brain = pricedModel();
    const r = await ask({ memory: mem, dir, brain, jobId: 'capjob01-0000', budget: { maxUsd: 0.03, stepUsd: 0.01 } });
    expect(r).toMatchObject({ reason: 'budget', capHit: 'usd', outcome: 'could-not', progress: { done: 3, total: 12, unit: 'pages' }, remaining: 'pages 4-12' });
    expect(r.costUsd).toBeCloseTo(brain.calls() / 100, 9); // exactly what was called
    expect(r.costUsd).toBeLessThanOrEqual(0.03 + 0.01 + 1e-9); // the cap, plus the one wrap-up call
    expect(r.summary).toMatch(/I read 3 pages/);
    expect(r.summary).not.toMatch(/PROGRESS:|REMAINING:/);
    expect(r.summary).toMatch(/3¢ spending limit/);
    expect(r.resumeQueued).toBeUndefined();
    expect((await mem.pendingScheduled()).filter((t) => t.resumeAttempt)).toHaveLength(0);
  }, 60_000);

  it('projects the first step: a cap below one step is not spent at all (review p3b: a 1.5¢ cap spent 20¢)', async () => {
    const brain = pricedModel({ cents: 10 });
    const r = await ask({ memory: mem, dir, brain, jobId: 'p3dear01-0000', budget: { maxUsd: 0.015, stepUsd: 0.1 } });
    expect(r).toMatchObject({ reason: 'budget', capHit: 'usd', steps: 0 });
    expect(r.costUsd).toBeLessThanOrEqual(0.015);
    expect(r.costUsd).toBeCloseTo(brain.calls() / 10, 9);
    // with no step cost given, the default step (2¢) is projected: still nothing spent past a 1.5¢ cap
    const b2 = pricedModel({ cents: 10 });
    const r2 = await ask({ memory: mem, dir, brain: b2, jobId: 'p3dear02-0000', budget: { maxUsd: 0.015 } });
    expect(r2.costUsd).toBeLessThanOrEqual(0.015);
  }, 60_000);

  it('skips optional post-run passes it cannot afford (review p3a: a 5.5¢ cap, done at 5¢)', async () => {
    let n = 0;
    const brain = pricedModel({ recall: true, finish: () => ++n > 4 });
    const r = await ask({ memory: mem, dir, brain, jobId: 'p3post01-0000', instruction: 'What do the eventing rules say about dressage tests? Read them and tell me.', budget: { maxUsd: 0.055, stepUsd: 0.01 } });
    expect(r.reason).toBe('done');
    expect(r.costUsd).toBeLessThanOrEqual(0.055 + 1e-9);
    expect(r.costUsd).toBeCloseTo(brain.calls() / 100, 9);
  }, 60_000);

  it('checks the cap before each extra draft of a sampled answer (review M5)', async () => {
    process.env.MWA_ANSWER_SAMPLES = '5';
    try {
      const brain = pricedModel({ finish: () => true });
      const r = await ask({ memory: mem, dir, brain, jobId: 'p3samp01-0000', instruction: 'What do the eventing rules say about dressage tests?', budget: { maxUsd: 0.025, stepUsd: 0.01 } });
      expect(r.costUsd).toBeLessThanOrEqual(0.025 + 1e-9);
      expect(r.costUsd).toBeCloseTo(brain.calls() / 100, 9);
      expect(r.history.join('\n')).toMatch(/no more drafts: the spending limit/);
    } finally { delete process.env.MWA_ANSWER_SAMPLES; }
  }, 60_000);

  it('a last unit may finish past the cap when it needs no more than a quarter of it (finishGrace)', async () => {
    let n = 0;
    const strict = await ask({ memory: mem, dir, brain: pricedModel({ recall: true, finish: () => ++n > 4 }), jobId: 'grace001-0000', budget: { maxUsd: 0.04, stepUsd: 0.005 } });
    expect(strict.capHit).toBe('usd');
    let m = 0;
    const graced = await ask({ memory: mem, dir, brain: pricedModel({ recall: true, finish: () => ++m > 4 }), jobId: 'grace002-0000', budget: { maxUsd: 0.04, stepUsd: 0.005, finishGrace: true } });
    expect(graced.reason).toBe('done'); // its 5th call (1¢, a quarter of the cap) fits in 1.25 × 4¢
    expect(graced.costUsd).toBeLessThanOrEqual(0.05 + 1e-9);
  }, 60_000);

  it('a planned run: the cap covers the plan, its steps and their retries; it stops there and queues no resume', async () => {
    process.env.MWA_PLAN = 'on'; // planning is off for the rest of this file
    try {
      const inner = pricedModel();
      let calls = 0;
      const brain: Provider = { id: 'p', model: 'p', price: [10, 0], chat: async (i) => { calls++; return String(i.system ?? '').includes('You are the PLANNER')
        ? { text: JSON.stringify({ steps: [{ task: 'Read the rules pages one by one' }, { task: 'Write study notes from them' }, { task: 'Check the notes cite pages' }] }), usage: { input: 1000, output: 0 } }
        : inner.chat(i); } };
      const r = await ask({ memory: mem, dir, brain, plan: true, jobId: 'planjob1-0000', instruction: 'Read the eventing rules, then write study notes, then check them', budget: { maxUsd: 0.04, stepUsd: 0.01 } });
      expect(r).toMatchObject({ reason: 'budget', capHit: 'usd', outcome: 'could-not' });
      expect(r.resumeQueued).toBeUndefined();
      expect(r.costUsd).toBeCloseTo(calls / 100, 9);
      expect(r.costUsd).toBeLessThanOrEqual(0.04 + 0.01 + 1e-9);
      expect(r.history[0]).toMatch(/^planned 3 steps/);
      expect(r.summary).toMatch(/4¢ spending limit/);
      expect(r.summary.match(/spending limit/g)).toHaveLength(1); // said once, with the plan's own limit
      expect((await mem.pendingScheduled()).filter((t) => t.resumeAttempt)).toHaveLength(0);
    } finally { process.env.MWA_PLAN = 'off'; }
  }, 60_000);
});

// ── Spend is counted per run, call by call (review p1, p4) ──────────────────────────────────────────────────────

describe('what a run spent', () => {
  let dir = '', mem: MwaMemory;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'mwa-a3b-spend-')); mem = new MwaMemory('a3b-spend', join(dir, 'm.db')); });
  afterAll(() => { mem.close(); rmSync(dir, { recursive: true, force: true }); });

  it('two uncapped runs in sequence on one router: each reports exactly its own calls (review p1: the second said $0)', async () => {
    const stub = pricedModel({ billed: true });
    const router = new RoutedProvider(stub, stub);
    const go = async (jobId: string, steps: number) => { const before = stub.calls(); const r = await ask({ memory: mem, dir, brain: router, jobId, budget: { maxSteps: steps } }); return { r, trueUsd: (stub.calls() - before) / 100 }; };
    const a = await go('p1jobaaa-0000', 4);
    const b = await go('p1jobbbb-0000', 8);
    expect(a.trueUsd).toBeGreaterThan(0);
    expect(a.r.costUsd).toBeCloseTo(a.trueUsd, 9);
    expect(b.r.costUsd).toBeCloseTo(b.trueUsd, 9);
  }, 60_000);

  it('two capped runs at the same time on one router do not count each other\'s calls (review p1b)', async () => {
    const stub = pricedModel({ billed: true, recall: true });
    const router = new RoutedProvider(stub, stub);
    const [x, y] = await Promise.all([ask({ memory: mem, dir, brain: router, jobId: 'p1conc01-0000', budget: { maxUsd: 0.06, stepUsd: 0.01 } }), ask({ memory: mem, dir, brain: router, jobId: 'p1conc02-0000', budget: { maxUsd: 0.06, stepUsd: 0.01 } })]);
    expect(x.costUsd + y.costUsd).toBeCloseTo(stub.calls() / 100, 9);
    for (const r of [x, y]) { expect(r.capHit).toBe('usd'); expect(r.costUsd).toBeLessThanOrEqual(0.07 + 1e-9); expect(r.progress?.done ?? 0).toBeGreaterThanOrEqual(4); }
  }, 60_000);

  it('the metered provider: a call is counted once, in the ledger of the run that made it, whatever the router did', async () => {
    const stub = pricedModel({ billed: true });
    const r = new RoutedProvider(stub, stub);
    const m = metered(r);
    expect(metered(m)).toBe(m);
    expect(m instanceof RoutedProvider).toBe(true);
    const a = newLedger(), b = newLedger();
    await withLedger(a, () => m.chat({ system: 'x', messages: [{ role: 'user', content: 'x' }] }));
    r.reset(); // another run's reset
    await withLedger(b, async () => { await m.chat({ system: 'x', messages: [{ role: 'user', content: 'x' }] }); await m.chat({ system: 'x', messages: [{ role: 'user', content: 'x' }] }); });
    expect([a.usd, b.usd]).toEqual([0.01, 0.02]);
    const child = withLedger(a, () => newLedger());
    await withLedger(child, () => m.chat({ system: 'x', messages: [{ role: 'user', content: 'x' }] }));
    expect([child.usd, a.usd]).toEqual([0.01, 0.02]); // a step's spend is also its plan's
    expect(r.priceRatio('fetch', 'reason')).toBe(1);
  });

  it('an escalation is projected at the price of the strong tier', () => {
    const cheap: Provider = { id: 'c', model: 'c', price: [1, 1], chat: async () => ({ text: '', usage: { input: 0, output: 0 } }) };
    const dear: Provider = { id: 'd', model: 'd', price: [10, 10], chat: async () => ({ text: '', usage: { input: 0, output: 0 } }) };
    const r = new RoutedProvider(cheap, dear);
    expect(r.priceRatio('fetch', 'reason')).toBe(10);
    expect(r.priceRatio('reason', 'fetch')).toBe(0.1);
  });

  it('browser pages count as reads for estimates (not for the page budget)', async () => {
    let n = 0;
    const brain: Provider = { id: 'b', model: 'b', price: [10, 0], chat: async (i) => {
      const sys = String(i.system ?? '');
      if (!sys.includes('TRUST BOUNDARY')) return { text: '{}', usage: { input: 1000, output: 0 } };
      n++;
      if (n === 1) return { text: JSON.stringify({ action: 'browser_open', url: 'https://example.com/rules' }), usage: { input: 1000, output: 0 } };
      if (n === 2) return { text: JSON.stringify({ action: 'browser_page' }), usage: { input: 1000, output: 0 } };
      return { text: JSON.stringify({ action: 'done', summary: 'The rules page says a dressage test is ridden in a 20 by 60 metre arena.', outcome: 'no-change' }), usage: { input: 1000, output: 0 } };
    } };
    const reg = new ToolRegistry();
    reg.registerAll([
      { def: { name: 'browser_open', description: 'open a page', parameters: { type: 'object', properties: { url: { type: 'string' } } } }, handler: async () => 'Rules page' },
      { def: { name: 'browser_page', description: 'read the page', parameters: { type: 'object', properties: {} } }, handler: async () => 'A dressage test is ridden in a 20 by 60 metre arena.' },
    ]);
    const r = await runAgent({ instruction: 'What does the rules page say about the dressage arena?', dir, memory: mem, brain, worker: brain, tools: reg, interactive: false, plan: false, jobId: 'browse01-0000', dueNow: true, budget: { maxSteps: 6, maxWallMs: 60_000 } } as Parameters<typeof runAgent>[0]);
    expect(r.reads).toBe(2);
    expect(r.pagesRead).toBeUndefined();
  }, 60_000);

  describe('planned runs report what their calls cost (review p4)', () => {
    beforeAll(() => { process.env.MWA_PLAN = 'on'; });
    afterAll(() => { process.env.MWA_PLAN = 'off'; });
    function planner(stepsN: number, billed: boolean, finishEvery?: number) {
      let n = 0, calls = 0;
      const inner = pricedModel({ billed, finish: () => finishEvery !== undefined && ++n % finishEvery === 0 });
      const steps = Array.from({ length: stepsN }, (_, i) => ({ task: `Part ${i + 1}: read the rules pages for section ${i + 1}` }));
      const p: Provider & { calls: () => number } = { id: 'p', model: 'p', price: [10, 0], calls: () => calls, chat: async (i) => { calls++; return String(i.system ?? '').includes('You are the PLANNER')
        ? { text: JSON.stringify({ steps }), usage: { input: 1000, output: 0, ...(billed ? { cost: 0.01 } : {}) } }
        : inner.chat(i); } };
      return p;
    }
    const go = async (brain: Provider, counter: { calls: () => number }, jobId: string, maxUsd?: number) => {
      const before = counter.calls();
      const r = await ask({ memory: mem, dir, brain, plan: true, jobId, instruction: 'Read the eventing rules section by section, then write study notes, then check them', budget: { maxSteps: 8, ...(maxUsd ? { maxUsd } : {}) } });
      return { r, trueUsd: (counter.calls() - before) / 100 };
    };
    it('a one-step plan (run directly): the planner call counts', async () => { const b = planner(1, false, 3); const { r, trueUsd } = await go(b, b, 'p4one000-0000'); expect(r.costUsd).toBeCloseTo(trueUsd, 9); }, 60_000);
    it('a three-step plan on a plain provider', async () => { const b = planner(3, false, 3); const { r, trueUsd } = await go(b, b, 'p4three0-0000'); expect(r.history[0]).toMatch(/^planned 3 steps/); expect(r.costUsd).toBeCloseTo(trueUsd, 9); }, 60_000);
    it('a three-step plan on a router, uncapped', async () => { const b = planner(3, true, 3); const { r, trueUsd } = await go(new RoutedProvider(b, b), b, 'p4route0-0000'); expect(r.costUsd).toBeCloseTo(trueUsd, 9); }, 60_000);
    it('a three-step plan on a router, capped at $1', async () => { const b = planner(3, true, 3); const { r, trueUsd } = await go(new RoutedProvider(b, b), b, 'p4routc0-0000', 1); expect(r.costUsd).toBeCloseTo(trueUsd, 9); }, 60_000);
  });
});

// ── A follow-up a capped run schedules carries what is left (review M6) ─────────────────────────────────────────

describe('a follow-up scheduled under a cap', () => {
  it('becomes its own Job with a share of the allowance as its cap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mwa-a3b-follow-'));
    const mem = new MwaMemory('a3b-follow', join(dir, 'm.db'));
    try {
      const l = newLedger({ cap: 0.2 });
      l.usd = 0.08;
      const id = await withLedger(l, () => mem.addScheduledTask('Finish reading the rules tomorrow', Date.now() + 86_400_000, { task: 'Finish reading the rules', request: 'Finish reading the rules' }));
      expect(viewJobOf(id!).cap_usd).toBeCloseTo(0.055, 6); // half of what is left after one call's worth (re-review: reserved, not copied)
      // scheduled outside any capped run: no cap is invented
      const free = await mem.addScheduledTask('Read the news later', Date.now() + 86_400_000, { task: 'Read the news', request: 'Read the news' });
      expect(viewJobOf(free!).cap_usd).toBeNull();
    } finally { mem.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
function viewJobOf(scheduleId: string): JobRow { return jobBySchedule(scheduleId)!; }

// ── End to end: hand off with a cap, wait at it, Continue under the default policy, finish, guess vs cost ───────

describe('a hand-off with a 3¢ limit', () => {
  let server: Server, base = '';
  afterAll(() => { server?.close(); setJobRouteDeps(null); });

  it('stops at the limit and waits for you with a priced Finish; Continue finishes it; the result shows guess vs cost', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mwa-a3b-e2e-'));
    const mem = new MwaMemory('a3b-e2e', join(dir, 'm.db'));
    const runlog = process.env.MWA_RUNLOG;
    process.env.MWA_RUNLOG = join(dir, 'runs.jsonl'); // no history from the other tests: the default rates, a first guess
    resetEstimateCache();
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
      expect(t1[0]).toMatchObject({ state: 'ended', reason: 'budget', cap_hit: 'usd', progress_done: 3, progress_total: 12, progress_unit: 'pages', cap_usd: 0.03 });
      expect(t1[0].cost_usd!).toBeCloseTo(brain.calls() / 100, 9);
      expect(t1[0].cost_usd!).toBeLessThanOrEqual(0.04 + 1e-9);
      // no automatic continuation: nothing queued here or in the store, and another tick runs nothing
      expect((await mem.pendingScheduled()).filter((t) => t.resumeAttempt)).toHaveLength(0);
      expect(await tick()).toBe(0);
      const waiting = view();
      expect(waiting.status).toMatchObject({ state: 'waiting', label: 'Waiting for you', primaryAction: { action: 'continue' } });
      // the run read outside content, so its "3 of 12" is not used to price: a first guess from the default
      expect(waiting.status.detail).toMatch(/^It reached the 3¢ limit you set\. Finish the last 9 pages\? A first guess, about \d+¢\.$/);
      expect(waiting.status.primaryAction!.label).toMatch(/^Finish the last 9 pages · a first guess, about \d+¢, up to \d+¢$/);
      const finishUsd = waiting.estimate!.continue!.usd;
      const limit = waiting.caps.continue!;
      expect(limit).toBeGreaterThanOrEqual(0.5);

      // The person's Continue, over HTTP, with no cap given: the default policy.
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
      expect(est).toMatchObject({ continue: waiting.estimate!.continue, startOver: waiting.estimate!.startOver, basis: waiting.estimate!.basis });
      const bad = await fetch(`${base}/jobs/${jobId}/continue`, { method: 'POST', headers: { 'idempotency-key': 'a3b-continue-bad', 'content-type': 'application/json' }, body: JSON.stringify({ capUsd: 25 }) });
      expect(bad.status).toBe(400);
      expect(getJob(jobId)!.cap_usd).toBe(0.03); // a refused Continue changes nothing
      const ok = await fetch(`${base}/jobs/${jobId}/continue`, { method: 'POST', headers: { 'idempotency-key': 'a3b-continue-ok1', 'content-type': 'application/json' }, body: '{}' });
      expect(ok.status).toBe(202);
      expect(getJob(jobId)!.cap_usd).toBe(limit);
      const t2 = triesOf(jobId)[1];
      expect(t2).toMatchObject({ trigger: 'continue', state: 'queued', est_usd: finishUsd });

      finish = true;
      expect(await tick()).toBe(1);
      const doneView = await (await fetch(`${base}/jobs/${jobId}`)).json();
      expect(doneView.job.status).toMatchObject({ state: 'done' });
      const spent = triesOf(jobId).reduce((s, t) => s + (t.cost_usd ?? 0), 0);
      expect(spent).toBeCloseTo(brain.calls() / 100, 9); // tries.cost_usd adds up to every call made
      expect(doneView.job.estimateVsActual).toEqual({ estimatedUsd: firstGuess, actualUsd: Math.round(spent * 10_000) / 10_000, text: `I guessed ${aboutUsd(firstGuess!)} · it cost ${usdText(spent)}` });
      expect(doneView.job.estimate.continue).toBeUndefined(); // nothing left to finish
      const after = await (await fetch(`${base}/jobs/${jobId}/estimate`)).json();
      expect(after.continue).toBeUndefined();
      expect(after.startOver.usd).toBeGreaterThan(0);
    } finally { process.env.MWA_RUNLOG = runlog; mem.close(); rmSync(dir, { recursive: true, force: true }); }
  }, 120_000);

  it('a hand-off without a limit gets the default one (≥ 25¢, 50¢ for a first guess, ≤ $5)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mwa-a3b-def-'));
    const mem = new MwaMemory('a3b-def', join(dir, 'm.db'));
    const runlog = process.env.MWA_RUNLOG;
    process.env.MWA_RUNLOG = join(dir, 'runs.jsonl');
    resetEstimateCache();
    try {
      const started = await startBackgroundWork(mem, { message: 'Read the eventing rules and write me study notes.', session: 'web-rules2', personId: 'web-p1', workspace: dir });
      const j = getJob(started!.v2JobId!)!;
      expect(j.cap_usd).toBe(defaultCapFor(j, triesOf(j.id), 'first'));
      expect(j.cap_usd!).toBeGreaterThanOrEqual(0.5); // no history: a first guess
      expect(j.cap_usd!).toBeLessThanOrEqual(5);
      updateJob(j.id, { cap_usd: null });
    } finally { process.env.MWA_RUNLOG = runlog; mem.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
