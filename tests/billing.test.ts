/**
 * Billing and token tracking (Robert, 2026-10-27): the sums of the model-call log, a monthly budget that warns at
 * 80% and holds unattended jobs at 100%, the CSV, and the provider's balance.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCalls, billingSummary, monthlyBudget, setMonthlyBudget, budgetHold, callsCsv, providerBalance, _resetBalanceCache, dayOf, monthStart } from '../src/billing.js';
import { tickScheduler } from '../src/scheduler.js';

const NOW = new Date(2026, 9, 27, 14, 0).getTime(); // Tue 27 Oct 2026, local
const row = (ts: number, session: string, model: string, cost: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ts, session, model, route: 'openai', served: 'OpenAI', in: 1000, cached: 200, out: 50, reasoning: 0, cost, ...extra });

function withLog(lines: string[], fn: (path: string, dir: string) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'mwa-billing-'));
  const path = join(dir, 'tokens.jsonl');
  writeFileSync(path, lines.join('\n') + '\n');
  return Promise.resolve(fn(path, dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe('the model-call log, summed', () => {
  it('sums the month so far by model and by conversation or job, and the last 30 days by day', async () => {
    await withLog([
      row(new Date(2026, 8, 30).getTime(), 'web-a', 'openai/gpt-6-luna', 0.5), // September: not this month, within 30 days
      row(new Date(2026, 9, 2).getTime(), 'web-a', 'openai/gpt-6-luna', 0.02),
      row(new Date(2026, 9, 2).getTime(), 'web-a', 'openai/gpt-6.1-sol', 0.3),
      row(new Date(2026, 9, 26).getTime(), 'job_abc', 'openai/gpt-6-luna', 0.04, { job: 'abc12345' }),
      '{not json',
      row(new Date(2026, 9, 27, 9).getTime(), 'web-b', 'openai/gpt-6-luna', 0.01),
    ], (path) => {
      const calls = readCalls(path, 0);
      expect(calls).toHaveLength(5);
      const s = billingSummary(calls, NOW, 40, false, null, path);
      expect(s.month).toMatchObject({ cost: 0.37, calls: 4, label: 'October 2026', from: monthStart(NOW) });
      expect(s.month.tokens).toEqual({ in: 4000, cached: 800, out: 200, reasoning: 0 });
      expect(s.byModel.map((m) => [m.model, m.cost, m.calls])).toEqual([['openai/gpt-6.1-sol', 0.3, 1], ['openai/gpt-6-luna', 0.07, 3]]);
      expect(s.bySession.map((x) => [x.session, x.kind, x.cost])).toEqual([['web-a', 'chat', 0.32], ['job_abc', 'job', 0.04], ['web-b', 'chat', 0.01]]);
      expect(s.days).toHaveLength(30);
      expect(s.days[29]).toEqual({ day: dayOf(NOW), cost: 0.01, calls: 1 });
      expect(s.days.find((d) => d.day === '2026-09-30')).toEqual({ day: '2026-09-30', cost: 0.5, calls: 1 }); // in the 30 days, not in the month
      expect(s.budget).toEqual({ monthlyUsd: 40, usedUsd: 0.37, pct: 1, state: 'ok', fixed: false });
    });
  });
  it('the budget states: none, ok, warn at 80%, over at 100%', async () => {
    await withLog([row(new Date(2026, 9, 5).getTime(), 'web-a', 'm', 36)], (path) => {
      const calls = readCalls(path, 0);
      expect(billingSummary(calls, NOW, null, false, null, path).budget.state).toBe('none');
      expect(billingSummary(calls, NOW, 100, false, null, path).budget).toMatchObject({ pct: 36, state: 'ok' });
      expect(billingSummary(calls, NOW, 40, false, null, path).budget).toMatchObject({ pct: 90, state: 'warn' });
      expect(billingSummary(calls, NOW, 30, false, null, path).budget).toMatchObject({ pct: 120, state: 'over' });
    });
  });
  it('writes a CSV with one row per call', async () => {
    await withLog([row(new Date(2026, 9, 27, 9).getTime(), 'web-b', 'openai/gpt-6-luna', 0.0123, { bg: true })], (path) => {
      const csv = callsCsv(readCalls(path, 0));
      expect(csv.split('\n')[0]).toBe('time,session,job,model,route,host,background,tokens_in,tokens_cached,tokens_out,tokens_reasoning,cost_usd');
      expect(csv.split('\n')[1]).toMatch(/^2026-10-27T\d\d:00:00\.000Z,web-b,,openai\/gpt-6-luna,openai,OpenAI,yes,1000,200,50,0,0\.012300$/);
    });
  });
});

describe('the monthly budget', () => {
  it('is set in the config file, read back, turned off, and fixed by the environment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mwa-budget-'));
    const cfg = join(dir, 'mwa.config.json');
    writeFileSync(cfg, JSON.stringify({ notify: { quietHours: '22:00-07:00' } }));
    vi.stubEnv('MWA_CONFIG_PATH', cfg);
    try {
      expect(monthlyBudget({})).toEqual({ usd: null, fixed: false });
      expect(setMonthlyBudget('40', {})).toMatchObject({ ok: true });
      expect(monthlyBudget({})).toEqual({ usd: 40, fixed: false });
      expect(JSON.parse(readFileSync(cfg, 'utf8'))).toEqual({ notify: { quietHours: '22:00-07:00' }, billing: { monthlyUsd: 40 } }); // other settings kept
      expect(setMonthlyBudget('$1,250', {})).toMatchObject({ ok: true });
      expect(monthlyBudget({}).usd).toBe(1250);
      expect(setMonthlyBudget('lots', {}).ok).toBe(false);
      expect(setMonthlyBudget('off', {})).toMatchObject({ ok: true, message: 'Monthly budget off.' });
      expect(monthlyBudget({})).toEqual({ usd: null, fixed: false });
      expect(monthlyBudget({ MWA_MONTHLY_BUDGET_USD: '25' })).toEqual({ usd: 25, fixed: true });
      expect(setMonthlyBudget('40', { MWA_MONTHLY_BUDGET_USD: '25' }).ok).toBe(false);
    } finally { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('holds unattended jobs at the budget, an hour at a time, and chats are told', async () => {
    await withLog([row(new Date(2026, 9, 5).getTime(), 'web-a', 'm', 41)], async (path, dir) => {
      const cfg = join(dir, 'mwa.config.json');
      writeFileSync(cfg, JSON.stringify({ billing: { monthlyUsd: 40 } }));
      vi.stubEnv('MWA_CONFIG_PATH', cfg);
      try {
        expect(budgetHold(NOW, path)).toEqual({ held: true, usedUsd: 41, budgetUsd: 40 });
        expect(budgetHold(new Date(2026, 10, 1).getTime(), path)).toEqual({ held: false, usedUsd: 0, budgetUsd: 40 }); // next month
        // the scheduler: a due task is put back an hour, the agent never runs
        const rescheduled: [string, number][] = []; const ran: unknown[] = [];
        await tickScheduler({
          memory: { async pendingScheduled() { return [{ id: 'job00001', instruction: 'Check the price page', due: 1, person: 'p' }]; }, async completeScheduled() { /* */ }, async rescheduleTask(id: string, due: number) { rescheduled.push([id, due]); }, async setScheduledSignature() { /* */ } } as never,
          brain: {} as never, worker: {} as never, outRoot: join(dir, 'out'), now: () => NOW, checksAllowed: false,
          onFire: async () => { /* */ }, runAgent: (async (o: unknown) => { ran.push(o); return { summary: 'ok', reason: 'done' }; }) as never,
          budgetHold: () => ({ held: true, usedUsd: 41, budgetUsd: 40 }),
        });
        expect(ran).toHaveLength(0);
        expect(rescheduled).toEqual([['job00001', NOW + 3_600_000]]);
      } finally { vi.unstubAllEnvs(); }
    });
  });
  it('reads the provider balance once per ten minutes, and gives nothing without a key', async () => {
    _resetBalanceCache();
    expect(await providerBalance({}, (async () => { throw new Error('no call'); }) as never)).toBeNull();
    _resetBalanceCache();
    let calls = 0;
    const fetchFn = (async () => { calls++; return { json: async () => ({ data: { total_credits: 100, total_usage: 74.74 } }) }; }) as never;
    expect(await providerBalance({ OPENROUTER_API_KEY: 'k' }, fetchFn)).toMatchObject({ provider: 'openrouter', remainingUsd: 25.26 });
    expect(await providerBalance({ OPENROUTER_API_KEY: 'k' }, fetchFn)).toMatchObject({ remainingUsd: 25.26 });
    expect(calls).toBe(1);
    _resetBalanceCache();
  });
});
