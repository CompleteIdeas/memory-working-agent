/**
 * v2 slice A3b: what a job will cost and how long it will take — always "about".
 *
 * The approved design (SCENARIOS N04, N06) prices every choice it offers: "Finish the last 10 pages? About 3¢",
 * "Start over · about 90¢", "This is a big read, about 20 minutes", and afterwards "I guessed about $0.35 · it cost
 * $0.41". An estimate comes from the best evidence there is, in this order:
 *
 *   1. this job's own Tries — what it has spent per unit of progress ("63 of 73 pages" for 15¢), or per page read;
 *   2. history — the median $/page and ms/page over earlier runs that read pages (runs.jsonl rows with pagesRead > 0),
 *      split by model tier: a run whose model calls were background calls (tokens.jsonl `bg`) is priced apart from
 *      one on the main model, because the two differ by an order of magnitude (provider.ts BackgroundSwitch);
 *   3. a conservative default (a little above what the real logs showed: ~4¢ a page, ~20 s a page).
 *
 * Continue = what is left × the rate; Start over = the whole job × the rate. When a job has not said how far it got,
 * a "typical run" stands in for the amount of work (the median pages a run reads, times the rate).
 *
 * Every number is rounded the way it is said: to the cent under $1 ("about 3¢"), to 5 cents above ("about $1.25").
 * The history read is cached (keyed on the logs' size and mtime) and reads only the tail of each log, the way
 * billing.ts does: tokens.jsonl can be megabytes.
 */
import { statSync } from 'node:fs';
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
/** Fewer history rows than this in a tier is not history, it is an anecdote. */
export const MIN_HISTORY = 3;
const HISTORY_ROWS = 400;
const HISTORY_BYTES = 4 * 1024 * 1024;

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
/** A rounded amount: dollars as said, time to the second. */
const rounded = (usd: number, ms: number): Amount => ({ usd: roundUsd(usd), ms: Math.max(1000, Math.round(ms / 1000) * 1000) });

// ── History: runs.jsonl × tokens.jsonl ──────────────────────────────────────────────────────────────────────────

export interface TierStats { usdPerPage: number; msPerPage: number; pagesPerRun: number; samples: number }
export interface HistoryStats { main: TierStats | null; background: TierStats | null }
export interface HistorySource { runs: string; tokens: string }

/** Where history is read from: the run log and the token log beside it. Under vitest, nothing unless a test says so
 *  (a test must not read the developer's own logs). */
export function historySource(env: NodeJS.ProcessEnv = process.env): HistorySource | null {
  if (env.VITEST && !env.MWA_RUNLOG) return null;
  return { runs: runLogPath(env), tokens: tokenLogPath(env) };
}

const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const fileKey = (p: string) => { try { const s = statSync(p); return `${p}:${s.size}:${s.mtimeMs}`; } catch { return `${p}:-`; } };
const finiteNum = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);

let cache: { key: string; stats: HistoryStats; src: string; checked: number } | null = null;
const RECHECK_MS = 5_000; // a list of 200 jobs asks 200 times in one request: look at the files at most every 5 s
/** Tests: forget the cached history. */
export function resetEstimateCache(): void { cache = null; }

/** Median $/page, ms/page and pages per run over recent runs that read pages, by model tier. Cached on the logs'
 *  size and mtime: a new run invalidates it; reads in between cost two stat calls. */
export function historyStats(src: HistorySource | null = historySource()): HistoryStats {
  if (!src) return { main: null, background: null };
  const srcKey = `${src.runs}|${src.tokens}`;
  if (cache?.src === srcKey && Date.now() - cache.checked < RECHECK_MS) return cache.stats;
  const key = `${fileKey(src.runs)}|${fileKey(src.tokens)}`;
  if (cache?.key === key) { cache.checked = Date.now(); return cache.stats; }
  const stats = computeHistory(src);
  cache = { key, stats, src: srcKey, checked: Date.now() };
  return stats;
}

interface RunRow { ts: number; job?: string; session?: string; costUsd: number; durationMs: number; pagesRead: number }
function computeHistory(src: HistorySource): HistoryStats {
  const rows: RunRow[] = [];
  for (const line of (readTail(src.runs, HISTORY_BYTES) ?? '').split('\n')) {
    if (!line.includes('pagesRead')) continue;
    let d: Record<string, unknown>;
    try { d = JSON.parse(line); } catch { continue; }
    const pages = finiteNum(d.pagesRead), usd = finiteNum(d.costUsd), ms = finiteNum(d.durationMs), ts = finiteNum(d.ts);
    if (!(pages > 0) || !(usd > 0) || !(ms > 0) || !(ts > 0)) continue;
    rows.push({ ts, pagesRead: pages, costUsd: usd, durationMs: ms, job: typeof d.job === 'string' ? d.job : undefined, session: typeof d.session === 'string' ? d.session : undefined });
  }
  const recent = rows.slice(-HISTORY_ROWS);
  if (!recent.length) return { main: null, background: null };
  // Which tier each run used: its model calls in tokens.jsonl (the same job, or the same session, inside the run's
  // window) — background when most of them were background calls. A run with no logged calls is judged by what it
  // was: a scheduled job runs unattended (background calls), a chat does not.
  const from = recent[0].ts;
  const byJob = new Map<string, { ts: number; bg: boolean }[]>(), bySession = new Map<string, { ts: number; bg: boolean }[]>();
  for (const line of (readTail(src.tokens) ?? '').split('\n')) {
    if (!line) continue;
    let d: Record<string, unknown>;
    try { d = JSON.parse(line); } catch { continue; }
    const ts = finiteNum(d.ts);
    if (!(ts >= from)) continue;
    const c = { ts, bg: d.bg === true };
    if (typeof d.job === 'string') { const a = byJob.get(d.job) ?? []; a.push(c); byJob.set(d.job, a); }
    else if (typeof d.session === 'string') { const a = bySession.get(d.session) ?? []; a.push(c); bySession.set(d.session, a); }
  }
  const tiers: Record<Tier, RunRow[]> = { main: [], background: [] };
  for (const r of recent) {
    const calls = (r.job ? byJob.get(r.job.slice(0, 8)) : r.session ? bySession.get(r.session) : undefined) ?? [];
    const inRun = calls.filter((c) => c.ts >= r.ts - 1000 && c.ts <= r.ts + r.durationMs + 5000);
    const bg = inRun.length ? inRun.filter((c) => c.bg).length * 2 > inRun.length : !!r.job;
    tiers[bg ? 'background' : 'main'].push(r);
  }
  const stat = (rs: RunRow[]): TierStats | null => rs.length < MIN_HISTORY ? null : {
    usdPerPage: median(rs.map((r) => r.costUsd / r.pagesRead)), msPerPage: median(rs.map((r) => r.durationMs / r.pagesRead)),
    pagesPerRun: median(rs.map((r) => r.pagesRead)), samples: rs.length,
  };
  return { main: stat(tiers.main), background: stat(tiers.background) };
}

// ── A job's estimate ────────────────────────────────────────────────────────────────────────────────────────────

/** The tier a job's next run uses: what the job says, else background — a Continue, a Start over and every scheduled
 *  fire run unattended, and unattended calls go to the background model (provider.ts). */
export function jobTier(job: Pick<JobRow, 'model_tier'>): Tier {
  return job.model_tier === 'main' ? 'main' : 'background';
}

const isPages = (unit: string | null | undefined) => /^pages?$/i.test(String(unit ?? '').trim());
const msOf = (t: TryRow) => (t.ended_at != null && t.started_at != null && t.ended_at > t.started_at ? t.ended_at - t.started_at : 0);

/** Estimate the work of something not yet started: `pages` when known, else a typical run. */
export function estimateWork(o: { pages?: number; tier?: Tier; history?: HistoryStats } = {}): Estimate {
  const h = (o.history ?? historyStats())[o.tier ?? 'background'];
  const rate = h ?? { usdPerPage: DEFAULT_RATE.usdPerPage, msPerPage: DEFAULT_RATE.msPerPage, pagesPerRun: DEFAULT_RATE.pagesPerRun, samples: 0 };
  const pages = o.pages && o.pages > 0 ? o.pages : rate.pagesPerRun;
  return { ...rounded(pages * rate.usdPerPage, pages * rate.msPerPage), basis: h ? 'history' : 'default', samples: h?.samples ?? 0 };
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
  const p = [...seg].reverse().find((t) => t.progress_total != null && t.progress_total > 0 && t.progress_done != null);
  const done = p?.progress_done ?? 0, total = p?.progress_total ?? 0;
  const left = p ? Math.max(0, total - done) : null;
  // Nothing left to do: the last Try finished, said nothing remains, and its progress is complete (or it gave none).
  const finished = !!last && last.reason === 'done' && last.outcome !== 'could-not' && !last.remaining && (left === null || left === 0);
  const spent = seg.reduce((s, t) => s + (t.cost_usd ?? 0), 0);
  const spentMs = seg.reduce((s, t) => s + msOf(t), 0);
  const pages = seg.reduce((s, t) => s + (t.pages_read ?? 0), 0);
  const costed = seg.filter((t) => (t.cost_usd ?? 0) > 0);
  const recurring = job.kind === 'recurring' || job.kind === 'reminder';

  // 1. this job: its own spend per unit of progress, per page read, or per Try.
  if (costed.length && spent > 0 && !recurring) {
    const samples = costed.length;
    if (done > 0 && total > 0) {
      const usdPer = spent / done, msPer = (spentMs || 0) / done;
      return { basis: 'this-job', samples, startOver: rounded(usdPer * total, msPer * total),
        ...(left && left > 0 ? { continue: rounded(usdPer * left, msPer * left) } : finished ? {} : { continue: rounded(spent / samples, spentMs / samples) }) };
    }
    if (p && total > 0 && left && left > 0) {
      // It counted its work but finished none of it yet ("0 of 2 steps"): it spent this much on less than one unit,
      // so a unit costs at least that — a floor, and a better one than the price of one more Try.
      return { basis: 'this-job', samples, startOver: rounded(spent * total, spentMs * total), continue: rounded(spent * left, spentMs * left) };
    }
    // No progress figure: what one Try of it costs is the best guess for the next; the whole job is what it took so
    // far plus that, unless it is finished.
    const perTry = rounded(spent / samples, spentMs / samples);
    const usdPerPage = pages > 0 ? spent / pages : null;
    const cont = usdPerPage != null && left && isPages(p?.progress_unit) ? rounded(usdPerPage * left, (spentMs / pages) * left) : perTry;
    return { basis: 'this-job', samples, startOver: rounded(finished ? spent : spent + cont.usd, finished ? spentMs : spentMs + cont.ms), ...(finished ? {} : { continue: cont }) };
  }
  if (recurring && costed.length) {
    // a repeating job: one fire costs about what its recent fires cost
    const recent = costed.slice(-5);
    return { basis: 'this-job', samples: recent.length, startOver: rounded(recent.reduce((s, t) => s + (t.cost_usd ?? 0), 0) / recent.length, recent.reduce((s, t) => s + msOf(t), 0) / recent.length) };
  }

  // 2–3. history, else the default: per page, over the job's pages when it counts pages, else a typical run.
  const h = (o.history ?? historyStats())[jobTier(job)];
  const rate = h ?? { usdPerPage: DEFAULT_RATE.usdPerPage, msPerPage: DEFAULT_RATE.msPerPage, pagesPerRun: DEFAULT_RATE.pagesPerRun, samples: 0 };
  const basis: Basis = h ? 'history' : 'default';
  const samples = h?.samples ?? 0;
  const typical = rate.pagesPerRun;
  const totalPages = p && isPages(p.progress_unit) ? total : typical;
  const leftPages = p && isPages(p.progress_unit) ? left! : p && total > 0 ? typical * (left! / total) : typical;
  const at = (pg: number) => rounded(pg * rate.usdPerPage, pg * rate.msPerPage);
  return { basis, samples, startOver: at(totalPages), ...(!ended.length || finished || recurring || leftPages <= 0 ? {} : { continue: at(leftPages) }) };
}

/** The estimate a queued Try is stamped with: a fresh start costs the whole job, anything else what is left. */
export function estimateForTrigger(e: JobEstimate, trigger: string): Amount | undefined {
  return trigger === 'first' || trigger === 'start-over' || trigger === 'fire' ? e.startOver : (e.continue ?? e.startOver);
}
