/**
 * v2 slice A3b: what a job will cost and how long it will take — always "about" — and the default spending limits.
 *
 * The approved design (SCENARIOS N04, N06) prices every choice it offers: "Finish the last 10 pages? About 3¢",
 * "Start over · about 90¢", "This is a big read, about 20 minutes", and afterwards "I guessed about $0.35 · it cost
 * $0.41". An estimate comes from the best evidence there is, in this order:
 *
 *   1. this job's own Tries — what it has spent per unit of progress ("63 of 73 pages" for 15¢), or per Try;
 *   2. history — the median $ and ms per page read over earlier runs (runs.jsonl `reads`: fetched pages AND browser
 *      pages; older rows' `pagesRead`), or per step for runs that read nothing, split by model tier: a run whose
 *      model calls were background calls (tokens.jsonl `bg`) is priced apart from one on the main model;
 *   3. a conservative default (a little above what the real logs showed: ~4¢ a page, ~20 s a page).
 *
 * Review of A3b (2026-10-26), what an estimate must never do:
 *   - blow up: a progress total is a model's claim, so it is held to a sanity ceiling (2000 units, and at most ten
 *     times the units seen so far); "0 of N" never multiplies the spend by N; every estimate is at most $20;
 *   - be steered: a Try that read outside content (tainted) may have had its PROGRESS line written by that content, so
 *     its progress claim is not used to price anything — the estimate falls back to measured spend and history.
 *
 * Every number is rounded the way it is said: to the cent under $1 ("about 3¢"), to 5 cents above ("about $1.25").
 *
 * History is read incrementally (review M7): the parsed rows are kept with each log's size and mtime; when a log grows
 * only the appended bytes are parsed; it is looked at no more than once a minute, and then off the request path.
 */
import { statSync, openSync, readSync, closeSync } from 'node:fs';
import { readTail, tokenLogPath } from '../billing.js';
import { runLogPath } from '../paths.js';
import type { JobRow, TryRow } from './jobs.js';

export type Basis = 'this-job' | 'history' | 'default';
export type Tier = 'main' | 'background';
export interface Amount { usd: number; ms: number }
export interface Estimate extends Amount { basis: Basis; samples: number }
export interface JobEstimate {
  /** finish what is left (absent until something has run, and for a job with nothing left to do) */
  continue?: Amount;
  /** the whole job again from the beginning */
  startOver?: Amount;
  basis: Basis;
  samples: number;
}

/** Conservative fallbacks: real logs (2026-10) showed medians of 3.5–4.2¢ and 10–21 s a page on the main model. */
export const DEFAULT_RATE = { usdPerPage: 0.05, msPerPage: 30_000, pagesPerRun: 6 } as const;
/** One step (one model call and its tools) when nothing better is known; the largest one seen is about twice that. */
export const DEFAULT_STEP = { usd: 0.02, largest: 0.05, ms: 15_000 } as const;
/** Fewer history rows than this in a tier is not history, it is an anecdote. */
export const MIN_HISTORY = 3;
/** No estimate is above this, whatever the arithmetic says. */
export const ESTIMATE_MAX_USD = 20;
/** A progress total above this is not believed (and never more than ten times the units seen). */
export const SANE_TOTAL = 2000;
const HISTORY_ROWS = 400;
const HISTORY_BYTES = 4 * 1024 * 1024;
const TOKENS_BYTES = 16 * 1024 * 1024;

// ── Rounding: every estimate is "about" ─────────────────────────────────────────────────────────────────────────

/** Round a dollar amount the way it is said: whole cents under $1 (at least 1¢), 5-cent steps from $1. */
export function roundUsd(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) return 0.01;
  if (usd < 0.995) return Math.max(1, Math.round(usd * 100)) / 100;
  return Math.round(usd * 20) / 20;
}
/** "3¢", "$1.25" — a rounded estimate as a person reads it. */
export function usdText(usd: number): string {
  const r = roundUsd(usd);
  return r < 1 ? `${Math.round(r * 100)}¢` : `$${r.toFixed(2)}`;
}
/** "about 3¢" */
export const aboutUsd = (usd: number): string => `about ${usdText(usd)}`;
/** "under a minute", "about 4 minutes", "about 1 hour 20 minutes" */
export function aboutTime(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (!Number.isFinite(ms) || min < 1) return 'under a minute';
  if (min < 60) return `about ${min} minute${min === 1 ? '' : 's'}`;
  const h = Math.floor(min / 60), m = Math.round((min % 60) / 5) * 5;
  return `about ${h} hour${h === 1 ? '' : 's'}${m ? ` ${m} minutes` : ''}`;
}
/** A rounded amount: dollars as said (never above ESTIMATE_MAX_USD, never NaN), time to the second. */
const rounded = (usd: number, ms: number): Amount => ({
  usd: roundUsd(Math.min(ESTIMATE_MAX_USD, Number.isFinite(usd) ? Math.max(0, usd) : 0)),
  ms: Math.max(1000, Math.round((Number.isFinite(ms) ? Math.max(0, ms) : 0) / 1000) * 1000),
});
/** A first guess: the default, or a single sample — said as such ("a first guess, about 30¢"). */
export const firstGuess = (e: Pick<JobEstimate, 'basis' | 'samples'>): boolean => e.basis === 'default' || e.samples < 2;

// ── History: runs.jsonl × tokens.jsonl ──────────────────────────────────────────────────────────────────────────

export interface TierStats {
  /** per page read (fetched or browser): median $, ms, pages a run; `samples` runs that read pages */
  usdPerPage: number; msPerPage: number; pagesPerRun: number; samples: number;
  /** per step, over runs that took steps (whatever they read): the fallback unit */
  usdPerStep: number; msPerStep: number; stepsPerRun: number; stepSamples: number;
}
export interface HistoryStats { main: TierStats | null; background: TierStats | null }
export interface HistorySource { runs: string; tokens: string }

/** Where history is read from: the run log and the token log beside it. Under vitest, nothing unless a test says so
 *  (a test must not read the developer's own logs). */
export function historySource(env: NodeJS.ProcessEnv = process.env): HistorySource | null {
  if (env.VITEST && !env.MWA_RUNLOG) return null;
  return { runs: runLogPath(env), tokens: tokenLogPath(env) };
}

const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const finiteNum = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);

interface RunRow { ts: number; job?: string; session?: string; costUsd: number; durationMs: number; reads: number; steps: number }
interface Call { ts: number; bg: boolean }
interface FileState { size: number; mtime: number; offset: number }
interface HistoryState {
  runs: FileState; tokens: FileState; rows: RunRow[];
  byJob: Map<string, Call[]>; bySession: Map<string, Call[]>;
  stats: HistoryStats; checked: number; refreshing: boolean;
}
const states = new Map<string, HistoryState>();
/** Look at the logs at most this often (and then in the background). */
export const HISTORY_RECHECK_MS = 60_000;
/** Tests: forget the cached history. */
export function resetEstimateCache(): void { states.clear(); }

const statOf = (p: string): { size: number; mtime: number } | null => { try { const s = statSync(p); return { size: s.size, mtime: s.mtimeMs }; } catch { return null; } };
/** Bytes [from, to) of a file as text, whole lines only; returns the text and where the next read starts. */
function readRange(path: string, from: number, to: number): { text: string; next: number } {
  if (to <= from) return { text: '', next: from };
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(to - from);
    const n = readSync(fd, buf, 0, to - from, from);
    const s = buf.subarray(0, n).toString('utf8');
    const cut = s.lastIndexOf('\n');
    return cut < 0 ? { text: '', next: from } : { text: s.slice(0, cut + 1), next: from + Buffer.byteLength(s.slice(0, cut + 1)) };
  } finally { closeSync(fd); }
}

function parseRuns(text: string, into: RunRow[]): void {
  for (const line of text.split('\n')) {
    if (!line || !line.includes('costUsd')) continue;
    let d: Record<string, unknown>;
    try { d = JSON.parse(line); } catch { continue; }
    const usd = finiteNum(d.costUsd), ms = finiteNum(d.durationMs), ts = finiteNum(d.ts);
    if (!(usd > 0) || !(ms > 0) || !(ts > 0)) continue;
    const reads = finiteNum(d.reads) >= 0 ? finiteNum(d.reads) : finiteNum(d.pagesRead) >= 0 ? finiteNum(d.pagesRead) : 0;
    const steps = finiteNum(d.steps) > 0 ? finiteNum(d.steps) : 0;
    into.push({ ts, costUsd: usd, durationMs: ms, reads, steps, job: typeof d.job === 'string' ? d.job : undefined, session: typeof d.session === 'string' ? d.session : undefined });
  }
}
function parseTokens(text: string, st: Pick<HistoryState, 'byJob' | 'bySession'>, from: number): void {
  for (const line of text.split('\n')) {
    if (!line) continue;
    let d: Record<string, unknown>;
    try { d = JSON.parse(line); } catch { continue; }
    const ts = finiteNum(d.ts);
    if (!(ts >= from)) continue;
    const c = { ts, bg: d.bg === true };
    if (typeof d.job === 'string') { const a = st.byJob.get(d.job) ?? []; a.push(c); st.byJob.set(d.job, a); }
    else if (typeof d.session === 'string') { const a = st.bySession.get(d.session) ?? []; a.push(c); st.bySession.set(d.session, a); }
  }
}
function computeStats(st: Pick<HistoryState, 'rows' | 'byJob' | 'bySession'>): HistoryStats {
  // Which tier each run used: its model calls in tokens.jsonl (the same job, or the same session, inside the run's
  // window) — background when most of them were background calls. A run with no logged calls is judged by what it
  // was: a scheduled job runs unattended (background calls), a chat does not.
  const tiers: Record<Tier, RunRow[]> = { main: [], background: [] };
  for (const r of st.rows) {
    const calls = (r.job ? st.byJob.get(r.job.slice(0, 8)) : r.session ? st.bySession.get(r.session) : undefined) ?? [];
    let n = 0, bgN = 0;
    for (const c of calls) if (c.ts >= r.ts - 1000 && c.ts <= r.ts + r.durationMs + 5000) { n++; if (c.bg) bgN++; }
    tiers[(n ? bgN * 2 > n : !!r.job) ? 'background' : 'main'].push(r);
  }
  const stat = (rs: RunRow[]): TierStats | null => {
    const read = rs.filter((r) => r.reads > 0), stepped = rs.filter((r) => r.steps > 0);
    if (read.length < MIN_HISTORY && stepped.length < MIN_HISTORY) return null;
    const ok = read.length >= MIN_HISTORY, okS = stepped.length >= MIN_HISTORY;
    return {
      usdPerPage: ok ? median(read.map((r) => r.costUsd / r.reads)) : NaN, msPerPage: ok ? median(read.map((r) => r.durationMs / r.reads)) : NaN,
      pagesPerRun: ok ? median(read.map((r) => r.reads)) : NaN, samples: ok ? read.length : 0,
      usdPerStep: okS ? median(stepped.map((r) => r.costUsd / r.steps)) : NaN, msPerStep: okS ? median(stepped.map((r) => r.durationMs / r.steps)) : NaN,
      stepsPerRun: okS ? median(stepped.map((r) => r.steps)) : NaN, stepSamples: okS ? stepped.length : 0,
    };
  };
  return { main: stat(tiers.main), background: stat(tiers.background) };
}
/** Drop rows past the window and token calls older than the oldest run kept (bounded memory). */
function trim(st: HistoryState): void {
  if (st.rows.length > HISTORY_ROWS) st.rows = st.rows.slice(-HISTORY_ROWS);
  const from = st.rows.length ? st.rows[0].ts - 1000 : Infinity;
  for (const m of [st.byJob, st.bySession]) for (const [k, v] of m) { const keep = v.filter((c) => c.ts >= from); if (keep.length) m.set(k, keep); else m.delete(k); }
}
function build(src: HistorySource): HistoryState {
  const rs = statOf(src.runs), ts = statOf(src.tokens);
  const st: HistoryState = { runs: { size: rs?.size ?? 0, mtime: rs?.mtime ?? 0, offset: rs?.size ?? 0 }, tokens: { size: ts?.size ?? 0, mtime: ts?.mtime ?? 0, offset: ts?.size ?? 0 },
    rows: [], byJob: new Map(), bySession: new Map(), stats: { main: null, background: null }, checked: Date.now(), refreshing: false };
  // Cold read, newest first: the last HISTORY_ROWS runs, then only the token calls inside their window (both logs are
  // in time order, so the walk back stops at the first line older than it needs).
  const runLines = (readTail(src.runs, HISTORY_BYTES) ?? '').split('\n');
  for (let i = runLines.length - 1; i >= 0 && st.rows.length < HISTORY_ROWS; i--) parseRuns(runLines[i], st.rows);
  st.rows.reverse();
  if (st.rows.length) {
    const from = st.rows[0].ts - 1000;
    const lines = (readTail(src.tokens, TOKENS_BYTES) ?? '').split('\n');
    let first = lines.length;
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = /"ts":(\d+(?:\.\d+)?)/.exec(lines[i]);
      if (m && Number(m[1]) < from) break;
      first = i;
    }
    parseTokens(lines.slice(first).join('\n'), st, from);
  }
  st.stats = computeStats(st);
  return st;
}

/**
 * Bring the cached history up to date: a log that grew is read from where the last read stopped (only the appended
 * bytes are parsed); one that shrank or was rewritten is read again. Synchronous; callers off the request path.
 */
export function refreshHistory(src: HistorySource | null = historySource()): HistoryStats {
  if (!src) return { main: null, background: null };
  const key = `${src.runs}|${src.tokens}`;
  const st = states.get(key);
  if (!st) { const b = build(src); states.set(key, b); return b.stats; }
  st.checked = Date.now();
  const rs = statOf(src.runs), ts = statOf(src.tokens);
  const rewritten = (f: FileState, s: { size: number; mtime: number } | null) => !!s && (s.size < f.offset || (s.size === f.size && s.mtime !== f.mtime));
  if (rewritten(st.runs, rs) || rewritten(st.tokens, ts)) { const b = build(src); states.set(key, b); return b.stats; }
  let changed = false;
  if (rs && rs.size > st.runs.offset) {
    const { text, next } = readRange(src.runs, st.runs.offset, rs.size);
    const before = st.rows.length;
    parseRuns(text, st.rows);
    st.runs = { size: rs.size, mtime: rs.mtime, offset: next };
    changed ||= st.rows.length !== before;
  }
  if (ts && ts.size > st.tokens.offset) {
    const { text, next } = readRange(src.tokens, st.tokens.offset, ts.size);
    parseTokens(text, st, st.rows.length ? st.rows[0].ts - 1000 : 0);
    st.tokens = { size: ts.size, mtime: ts.mtime, offset: next };
    changed = true;
  }
  if (changed) { trim(st); st.stats = computeStats(st); }
  return st.stats;
}

/**
 * Median $/page, ms/page, pages per run (and the same per step) over recent runs, by model tier. Returns the cached
 * value; the first call for a source reads the logs (their tails), later ones schedule an incremental refresh at most
 * once a minute, in the background — a request never parses a log that only grew.
 */
export function historyStats(src: HistorySource | null = historySource()): HistoryStats {
  if (!src) return { main: null, background: null };
  const key = `${src.runs}|${src.tokens}`;
  const st = states.get(key);
  if (!st) return refreshHistory(src);
  if (!st.refreshing && Date.now() - st.checked >= HISTORY_RECHECK_MS) {
    st.refreshing = true;
    const t = setTimeout(() => { try { refreshHistory(src); } catch { /* keep the cached value */ } finally { st.refreshing = false; } }, 0);
    (t as { unref?: () => void }).unref?.();
  }
  return st.stats;
}

// ── Steps: what one step costs (the first step's projection, and the default limits' reserve) ─────────────────

export interface StepCost { usd: number; largest: number; ms: number; basis: Basis }
/** What one step of this job costs: its own Tries (spend over steps), else history per step, else the default. */
export function stepCost(job: Pick<JobRow, 'model_tier'>, tries: TryRow[], o: { history?: HistoryStats } = {}): StepCost {
  const own = tries.filter((t) => (t.cost_usd ?? 0) > 0 && (t.steps ?? 0) > 0);
  if (own.length) {
    const usd = own.reduce((s, t) => s + t.cost_usd!, 0) / own.reduce((s, t) => s + t.steps!, 0);
    const largest = Math.max(usd, ...own.map((t) => t.cost_usd! / t.steps!));
    const ms = own.reduce((s, t) => s + msOf(t), 0) / own.reduce((s, t) => s + t.steps!, 0);
    return { usd, largest: Math.max(largest, usd * 1.5), ms: ms || DEFAULT_STEP.ms, basis: 'this-job' };
  }
  const h = (o.history ?? historyStats())[jobTier(job)];
  if (h && h.stepSamples >= MIN_HISTORY) return { usd: h.usdPerStep, largest: h.usdPerStep * 2.5, ms: h.msPerStep, basis: 'history' };
  return { usd: DEFAULT_STEP.usd, largest: DEFAULT_STEP.largest, ms: DEFAULT_STEP.ms, basis: 'default' };
}

// ── A job's estimate ────────────────────────────────────────────────────────────────────────────────────────────

/** The tier a job's next run uses: what the job says, else background — a Continue, a Start over and every scheduled
 *  fire run unattended, and unattended calls go to the background model (provider.ts). */
export function jobTier(job: Pick<JobRow, 'model_tier'>): Tier {
  return job.model_tier === 'main' ? 'main' : 'background';
}

const isPages = (unit: string | null | undefined) => /^pages?$/i.test(String(unit ?? '').trim());
const msOf = (t: TryRow) => (t.ended_at != null && t.started_at != null && t.ended_at > t.started_at ? t.ended_at - t.started_at : 0);
const costOf = (t: TryRow) => (typeof t.cost_usd === 'number' && t.cost_usd > 0 ? t.cost_usd : 0);
const readsOf = (t: TryRow) => Math.max(0, Number((t as { reads?: number | null }).reads ?? t.pages_read ?? 0) || 0);

/** A rate from history (per page when the tier has page samples, else a typical run by steps), or the default. */
function historyRate(h: TierStats | null): { usdPerPage: number; msPerPage: number; pagesPerRun: number; basis: Basis; samples: number } {
  if (h && h.samples >= MIN_HISTORY) return { usdPerPage: h.usdPerPage, msPerPage: h.msPerPage, pagesPerRun: h.pagesPerRun, basis: 'history', samples: h.samples };
  if (h && h.stepSamples >= MIN_HISTORY) {
    // no page samples: a typical run is its steps × the cost of a step, spread over the default's pages
    const run = h.stepsPerRun * h.usdPerStep, runMs = h.stepsPerRun * h.msPerStep;
    return { usdPerPage: run / DEFAULT_RATE.pagesPerRun, msPerPage: runMs / DEFAULT_RATE.pagesPerRun, pagesPerRun: DEFAULT_RATE.pagesPerRun, basis: 'history', samples: h.stepSamples };
  }
  return { ...DEFAULT_RATE, basis: 'default', samples: 0 };
}

/** Estimate the work of something not yet started: `pages` when known, else a typical run. */
export function estimateWork(o: { pages?: number; tier?: Tier; history?: HistoryStats } = {}): Estimate {
  const r = historyRate((o.history ?? historyStats())[o.tier ?? 'background']);
  const pages = o.pages && o.pages > 0 ? Math.min(o.pages, SANE_TOTAL) : r.pagesPerRun;
  return { ...rounded(pages * r.usdPerPage, pages * r.msPerPage), basis: r.basis, samples: r.samples };
}

/**
 * A job's estimates: Continue (what is left) and Start over (the whole job), with the evidence they rest on.
 * `tries` in any order. A recurring job is priced per fire (startOver = one fire).
 */
export function estimateJob(job: JobRow, tries: TryRow[], o: { history?: HistoryStats } = {}): JobEstimate {
  const byN = [...tries].sort((a, b) => a.n - b.n);
  const ended = byN.filter((t) => t.state === 'ended' && t.ended_by !== 'duplicate');
  // The current attempt at the job: the Tries since the last Start over that ran (a fresh start resets the progress).
  const lastFresh = [...ended].reverse().find((t) => t.trigger === 'start-over');
  const seg = ended.filter((t) => !lastFresh || t.n >= lastFresh.n);
  const last = seg[seg.length - 1];
  const claimed = [...seg].reverse().find((t) => t.progress_total != null && t.progress_total > 0 && t.progress_done != null);
  // A progress claim from a Try that read outside content may have been written by that content: not used to price.
  const p = claimed && !claimed.tainted ? claimed : undefined;
  const reads = seg.reduce((s, t) => s + readsOf(t), 0);
  const done = p ? Math.max(0, Math.min(p.progress_done!, p.progress_total!)) : 0;
  // The sanity ceiling on a total: 2000 units, and at most ten times the units seen so far (done, or pages read).
  const total = p ? Math.min(p.progress_total!, SANE_TOTAL, 10 * Math.max(1, done, reads)) : 0;
  const left = p ? Math.max(0, total - Math.min(done, total)) : null;
  // Nothing left to do: the last Try finished, said nothing remains, and its progress is complete (or it gave none).
  const claimLeft = claimed ? Math.max(0, claimed.progress_total! - claimed.progress_done!) : null;
  const finished = !!last && last.reason === 'done' && last.outcome !== 'could-not' && !last.remaining && (claimLeft === null || claimLeft === 0);
  const spent = seg.reduce((s, t) => s + costOf(t), 0);
  const spentMs = seg.reduce((s, t) => s + msOf(t), 0);
  const costed = seg.filter((t) => costOf(t) > 0);
  const recurring = job.kind === 'recurring' || job.kind === 'reminder';
  const hr = historyRate((o.history ?? historyStats())[jobTier(job)]);
  const typical = rounded(hr.pagesPerRun * hr.usdPerPage, hr.pagesPerRun * hr.msPerPage);

  if (recurring) {
    // a repeating job: one fire costs about what its recent fires cost
    const recent = costed.slice(-5);
    if (recent.length) return { basis: 'this-job', samples: recent.length, startOver: rounded(recent.reduce((s, t) => s + costOf(t), 0) / recent.length, recent.reduce((s, t) => s + msOf(t), 0) / recent.length) };
    return { basis: hr.basis, samples: hr.samples, startOver: typical };
  }

  // 1. this job: its own spend per unit of progress (believed units only), or per Try.
  if (costed.length) {
    const samples = costed.length;
    if (p && done > 0 && total > 0) {
      const usdPer = spent / done, msPer = spentMs / done;
      return { basis: 'this-job', samples, startOver: rounded(usdPer * total, msPer * total),
        ...(left && left > 0 ? { continue: rounded(usdPer * left, msPer * left) } : finished ? {} : { continue: rounded(spent / samples, spentMs / samples) }) };
    }
    const perTry = { usd: spent / samples, ms: spentMs / samples };
    if (finished) return { basis: 'this-job', samples, startOver: rounded(spent, spentMs) };
    // No believed rate: none of its units is done yet ("0 of 73"), or it gave no progress, or the claim is untrusted.
    // What is left is priced from history/the default (its pages when it counts pages and the count is believed, else
    // a typical run), and never below what one Try of it has cost — a floor, under the $20 ceiling.
    const rest = p && left != null && left > 0 && isPages(p.progress_unit)
      ? { usd: left * hr.usdPerPage, ms: left * hr.msPerPage } : { usd: typical.usd, ms: typical.ms };
    const cont = rounded(Math.max(perTry.usd, rest.usd), Math.max(perTry.ms, rest.ms));
    const basis: Basis = rest.usd > perTry.usd ? hr.basis : 'this-job';
    return { basis, samples: basis === 'this-job' ? samples : hr.samples, startOver: rounded(spent + cont.usd, spentMs + cont.ms), continue: cont };
  }

  // 2–3. history, else the default: per page, over the job's pages when it counts pages, else a typical run.
  const totalPages = p && isPages(p.progress_unit) ? total : hr.pagesPerRun;
  const leftPages = p && isPages(p.progress_unit) ? left! : p && total > 0 ? hr.pagesPerRun * (left! / total) : hr.pagesPerRun;
  const at = (pg: number) => rounded(pg * hr.usdPerPage, pg * hr.msPerPage);
  return { basis: hr.basis, samples: hr.samples, startOver: at(totalPages), ...(!ended.length || finished || leftPages <= 0 ? {} : { continue: at(leftPages) }) };
}

/** The estimate a queued Try is stamped with: a fresh start costs the whole job, anything else what is left. */
export function estimateForTrigger(e: JobEstimate, trigger: string): Amount | undefined {
  return trigger === 'first' || trigger === 'start-over' || trigger === 'fire' ? e.startOver : (e.continue ?? e.startOver);
}

// ── Default spending limits (policy, review of A3b) ─────────────────────────────────────────────────────────────

/** The most a hand-off's default limit may be, and the most any limit may be. */
export const HANDOFF_CAP_MAX_USD = 5;
export const CAP_MAX_USD = 20;
/** Never below this, and never below FIRST_GUESS_FLOOR_USD when the estimate is a first guess. */
export const CAP_MIN_USD = 0.25;
export const FIRST_GUESS_FLOOR_USD = 0.5;
/** A repeating job's per-fire limit when it has none of its own: MWA_FIRE_CAP_USD (0 = none), default 25¢. */
export function fireCapUsd(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.MWA_FIRE_CAP_USD;
  if (raw === undefined || raw.trim() === '') return 0.25;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(n, CAP_MAX_USD) : undefined;
}

/**
 * The default limit for a run whose estimate is `estUsd`: room for the estimate twice over, or for the estimate plus
 * three of its largest steps and the wrap-up — whichever is more — at least 25¢ (50¢ for a first guess), at most `max`.
 */
export function defaultCapUsd(estUsd: number, step: StepCost, guess: boolean, max: number): number {
  const est = Number.isFinite(estUsd) && estUsd > 0 ? estUsd : 0;
  let cap = Math.max(2 * est, est + 3 * step.largest + step.usd, CAP_MIN_USD);
  if (guess) cap = Math.max(cap, FIRST_GUESS_FLOOR_USD);
  return roundUsd(Math.min(max, cap));
}
