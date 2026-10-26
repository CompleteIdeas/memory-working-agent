/**
 * Billing and token tracking (Robert, 2026-10-27: "there should be a billing and token tracking feature too").
 * Every model call is already logged (provider.ts logCall → tokens.jsonl: model, route, tokens in / cached / out /
 * reasoning, cost, the session and job it served) and every run carries its cost. This adds the sums the person
 * wants to see — the month so far, the last 30 days by day, by model, the costliest conversations and jobs — a
 * monthly budget that warns at 80% and holds unattended jobs at 100% (chats still run and say so), the provider's own
 * balance where its API gives one, and a CSV for an expense claim.
 */
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runLogPath } from './paths.js';
import { configPath } from './config.js';

export interface Call {
  ts: number; session?: string; job?: string; run?: string; model: string; route?: string; served?: string; bg?: boolean;
  in: number; cached: number; out: number; reasoning: number; cost: number;
}
export interface Tokens { in: number; cached: number; out: number; reasoning: number }
export interface Bucket { cost: number; calls: number; tokens: Tokens }
export interface BillingSummary {
  now: number;
  month: Bucket & { from: number; label: string };
  days: { day: string; cost: number; calls: number }[];
  byModel: ({ model: string } & Bucket)[];
  bySession: ({ session: string; kind: 'chat' | 'job' | 'other' } & Bucket)[];
  budget: { monthlyUsd: number | null; usedUsd: number; pct: number | null; state: 'none' | 'ok' | 'warn' | 'over'; fixed: boolean };
  balance: { provider: string; remainingUsd: number; at: number } | null;
  logPath: string;
}

export function tokenLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.MWA_TOKEN_LOG && env.MWA_TOKEN_LOG !== '0' ? env.MWA_TOKEN_LOG : join(dirname(runLogPath(env)), 'tokens.jsonl');
}

const MAX_READ = 16 * 1024 * 1024; // the log only grows: the last 16 MB is months of calls
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);

/** The last `max` bytes of a log that only grows, whole lines only; null when it is missing or unreadable.
 *  (Shared with v2/estimate.ts, which reads runs.jsonl and tokens.jsonl the same way.) */
export function readTail(path: string, max = MAX_READ): string | null {
  if (!existsSync(path)) return null;
  try {
    const size = statSync(path).size;
    if (size <= max) return readFileSync(path, 'utf8');
    const fd = openSync(path, 'r');
    try { const buf = Buffer.alloc(max); readSync(fd, buf, 0, max, size - max); const text = buf.toString('utf8'); return text.slice(text.indexOf('\n') + 1); }
    finally { closeSync(fd); }
  } catch { return null; }
}

/** The calls logged since `sinceMs`, oldest first. A line that is not JSON is skipped. */
export function readCalls(path = tokenLogPath(), sinceMs = 0): Call[] {
  const text = readTail(path);
  if (text === null) return [];
  const out: Call[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let d: Record<string, unknown>;
    try { d = JSON.parse(line); } catch { continue; }
    const ts = num(d.ts);
    if (!ts || ts < sinceMs) continue;
    out.push({ ts, session: typeof d.session === 'string' ? d.session : undefined, job: typeof d.job === 'string' ? d.job : undefined, run: typeof d.run === 'string' ? d.run : undefined,
      model: String(d.model ?? 'unknown'), route: typeof d.route === 'string' ? d.route : undefined, served: typeof d.served === 'string' ? d.served : undefined, bg: d.bg === true,
      in: num(d.in), cached: num(d.cached), out: num(d.out), reasoning: num(d.reasoning), cost: num(d.cost) });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

const emptyBucket = (): Bucket => ({ cost: 0, calls: 0, tokens: { in: 0, cached: 0, out: 0, reasoning: 0 } });
const add = (b: Bucket, c: Call) => { b.cost += c.cost; b.calls++; b.tokens.in += c.in; b.tokens.cached += c.cached; b.tokens.out += c.out; b.tokens.reasoning += c.reasoning; };
const round = (n: number) => Number(n.toFixed(4));
const finish = (b: Bucket) => ({ ...b, cost: round(b.cost) });

/** "YYYY-MM-DD" in local time. */
export const dayOf = (ms: number): string => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
/** The first instant of the local calendar month `ms` is in. */
export const monthStart = (ms: number): number => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); };

/** A session's kind from its name: the web app's conversations are `web-…`, fired jobs run under `job_<id>`. */
const kindOf = (c: Call): 'chat' | 'job' | 'other' => (c.job || /^job_/.test(c.session ?? '') ? 'job' : /^(web|tg|telegram|chat|mail)/i.test(c.session ?? '') ? 'chat' : 'other');

/** The sums for the app, from the calls since the start of the month or the last 30 days, whichever is earlier. */
export function billingSummary(calls: Call[], nowMs = Date.now(), budgetUsd: number | null = monthlyBudget().usd, fixed = monthlyBudget().fixed, balance: BillingSummary['balance'] = null, logPath = tokenLogPath()): BillingSummary {
  const from = monthStart(nowMs);
  const month = emptyBucket();
  const byModel = new Map<string, Bucket>();
  const bySession = new Map<string, Bucket & { kind: 'chat' | 'job' | 'other' }>();
  const byDay = new Map<string, { cost: number; calls: number }>();
  const since30 = nowMs - 30 * 86_400_000;
  for (const c of calls) {
    if (c.ts >= from) {
      add(month, c);
      const m = byModel.get(c.model) ?? emptyBucket(); add(m, c); byModel.set(c.model, m);
      const key = c.session ?? '(no session)';
      const s = bySession.get(key) ?? { ...emptyBucket(), kind: kindOf(c) }; add(s, c); bySession.set(key, s);
    }
    if (c.ts >= since30) { const day = dayOf(c.ts); const d = byDay.get(day) ?? { cost: 0, calls: 0 }; d.cost += c.cost; d.calls++; byDay.set(day, d); }
  }
  const days: BillingSummary['days'] = [];
  for (let i = 29; i >= 0; i--) { const day = dayOf(nowMs - i * 86_400_000); const d = byDay.get(day); days.push({ day, cost: round(d?.cost ?? 0), calls: d?.calls ?? 0 }); }
  const used = round(month.cost);
  const pct = budgetUsd && budgetUsd > 0 ? Math.round((used / budgetUsd) * 100) : null;
  const state: BillingSummary['budget']['state'] = pct === null ? 'none' : pct >= 100 ? 'over' : pct >= 80 ? 'warn' : 'ok';
  const d = new Date(nowMs);
  return {
    now: nowMs,
    month: { ...finish(month), from, label: d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) },
    days,
    byModel: [...byModel.entries()].map(([model, b]) => ({ model, ...finish(b) })).sort((a, b) => b.cost - a.cost),
    bySession: [...bySession.entries()].map(([session, b]) => ({ session, kind: b.kind, ...finish(b) })).sort((a, b) => b.cost - a.cost).slice(0, 10),
    budget: { monthlyUsd: budgetUsd, usedUsd: used, pct, state, fixed },
    balance,
    logPath,
  };
}

/** The monthly budget: MWA_MONTHLY_BUDGET_USD fixes it; else `billing.monthlyUsd` in mwa.config.json; else none. */
export function monthlyBudget(env: NodeJS.ProcessEnv = process.env): { usd: number | null; fixed: boolean } {
  const fromEnv = Number(env.MWA_MONTHLY_BUDGET_USD);
  if (env.MWA_MONTHLY_BUDGET_USD !== undefined && env.MWA_MONTHLY_BUDGET_USD.trim() !== '') return { usd: fromEnv > 0 ? fromEnv : null, fixed: true };
  // read from the file itself: loadConfig() merges only the keys it knows
  let cfg: { monthlyUsd?: unknown } = {};
  try { if (existsSync(configPath())) cfg = (JSON.parse(readFileSync(configPath(), 'utf8')) as { billing?: { monthlyUsd?: unknown } }).billing ?? {}; } catch { /* no config, or not JSON */ }
  const v = Number(cfg.monthlyUsd);
  return { usd: v > 0 ? v : null, fixed: false };
}

/** Set the monthly budget in mwa.config.json: a number of dollars, or "off". Refused when the deployment fixes it. */
export function setMonthlyBudget(value: string | number, env: NodeJS.ProcessEnv = process.env): { ok: boolean; message: string } {
  if (env.MWA_MONTHLY_BUDGET_USD !== undefined && env.MWA_MONTHLY_BUDGET_USD.trim() !== '') return { ok: false, message: 'The monthly budget is fixed by this deployment (MWA_MONTHLY_BUDGET_USD).' };
  const off = /^\s*(off|none|0)?\s*$/i.test(String(value));
  const usd = off ? null : Number(String(value).replace(/[$,\s]/g, ''));
  if (!off && !(usd! > 0 && usd! < 1_000_000)) return { ok: false, message: 'Give a number of dollars for the month, for example 40, or "off".' };
  let raw: Record<string, unknown> = {};
  if (existsSync(configPath())) {
    try { raw = JSON.parse(readFileSync(configPath(), 'utf8')); }
    catch { return { ok: false, message: `the settings file ${configPath()} isn't valid JSON — fix it first, or the budget would overwrite everything in it` }; }
  }
  const billing = { ...((raw.billing as Record<string, unknown>) ?? {}) };
  if (usd) billing.monthlyUsd = usd; else delete billing.monthlyUsd;
  raw.billing = billing;
  const tmp = `${configPath()}.tmp`;
  writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n');
  renameSync(tmp, configPath());
  return { ok: true, message: usd ? `Monthly budget $${usd}. At 80% the app warns; at 100% unattended jobs wait until next month, and chats say so.` : 'Monthly budget off.' };
}

/** Whether unattended work is held: the month's spend has reached the budget. */
export function budgetHold(nowMs = Date.now(), path = tokenLogPath()): { held: boolean; usedUsd: number; budgetUsd: number | null } {
  const { usd } = monthlyBudget();
  if (!usd) return { held: false, usedUsd: 0, budgetUsd: null };
  const used = readCalls(path, monthStart(nowMs)).reduce((a, c) => a + c.cost, 0);
  return { held: used >= usd, usedUsd: round(used), budgetUsd: usd };
}

/** The calls as CSV: one row per model call. */
export function callsCsv(calls: Call[]): string {
  const esc = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = 'time,session,job,model,route,host,background,tokens_in,tokens_cached,tokens_out,tokens_reasoning,cost_usd';
  return [head, ...calls.map((c) => [new Date(c.ts).toISOString(), c.session, c.job, c.model, c.route, c.served, c.bg ? 'yes' : 'no', c.in, c.cached, c.out, c.reasoning, c.cost.toFixed(6)].map(esc).join(','))].join('\n') + '\n';
}

let balanceCache: { at: number; value: BillingSummary['balance'] } | null = null;
/** The provider's own balance, where its API gives one: OpenRouter's credits. Cached ten minutes; null without a key. */
export async function providerBalance(env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch): Promise<BillingSummary['balance']> {
  if (balanceCache && Date.now() - balanceCache.at < 10 * 60_000) return balanceCache.value;
  let value: BillingSummary['balance'] = null;
  const key = env.OPENROUTER_API_KEY;
  if (key) {
    try {
      const r = await fetchFn('https://openrouter.ai/api/v1/credits', { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5_000) });
      const j = (await r.json()) as { data?: { total_credits?: number; total_usage?: number } };
      if (j.data && typeof j.data.total_credits === 'number') value = { provider: 'openrouter', remainingUsd: round(j.data.total_credits - (j.data.total_usage ?? 0)), at: Date.now() };
    } catch { value = null; }
  }
  balanceCache = { at: Date.now(), value };
  return value;
}
export const _resetBalanceCache = () => { balanceCache = null; };
