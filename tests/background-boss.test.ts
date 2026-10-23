/**
 * BL-73 — a background worker and its boss (src/agent.ts, src/provider.ts). Robert, 2026-10-23: "a solid citizen that
 * can just run on short, ongoing tasks … when it does [complex work], it can have a coworker or a boss that can
 * review the work". With MWA_BACKGROUND_MODEL set, a scheduled run starts on it whatever its length, and the usual
 * strong model takes over when the worker ignores a check, gives up, stalls, or nears the step limit.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoutedProvider } from '../src/model-router.js';

const TOOLS = ['gmail__search_email', 'gmail__read_email', 'calendar__list_events'];
// Longer than 220 characters, as the jobs Sol writes are: before BL-73 it started on the strong tier.
const BRIEF = 'Prepare a concise morning brief for the user in America/New_York: what came in by email that needs their personal attention, plus today\'s calendar, ranked most important first. Check open items, then email since the last brief, then the calendar.';

const scripted = (name: string, actions: Record<string, unknown>[]) => {
  let i = 0; const seen: string[] = [];
  return { seen, p: { id: name, model: name, price: [0, 0] as [number, number], chat: async (input: any) => {
    if (!String(input.system ?? '').includes('TRUST BOUNDARY')) return { text: '{}', usage: { input: 1, output: 1 } };
    seen.push(String(input.messages?.[0]?.content ?? ''));
    return { text: JSON.stringify(actions[Math.min(i++, actions.length - 1)]), usage: { input: 1, output: 1 } };
  } } };
};

const run = async (workerActions: Record<string, unknown>[], bossActions: Record<string, unknown>[], extra: Record<string, unknown> = {}) => {
  const { runAgent } = await import('../src/agent.js');
  const dir = mkdtempSync(join(tmpdir(), 'mwa-bl73-'));
  const worker = scripted('worker', workerActions); const boss = scripted('boss', bossActions);
  const brain = new RoutedProvider(worker.p, boss.p);
  const calls: string[] = [];
  const tools = { defs: () => TOOLS.map((name) => ({ name, description: name, parameters: { type: 'object', properties: {} } })), has: (n: string) => TOOLS.includes(n),
    call: async (n: string, a: Record<string, unknown>) => { calls.push(`${n}:${JSON.stringify(a)}`); return `${n}: id: ${String(a.id ?? "e1")} | Mon 2026-11-02 | Subject: hello`; } };
  vi.stubEnv('MWA_FAST_CHAT', '0');
  try {
    const r = await runAgent({ instruction: BRIEF, dir, memory: { enabled: false, async recall() { return []; }, async listPolicies() { return []; }, setSessionId() { /* */ }, async addScheduledTask() { return null; }, async logAction() { return null; } } as any,
      brain, worker: brain, interactive: false, plan: false, tools: tools as any, jobId: 'brief123', dueNow: true, budget: { maxSteps: 16, maxWallMs: 30_000 }, ...extra } as any);
    return { r, worker: worker.seen, boss: boss.seen, calls, history: r.history.join('\n') };
  } finally { rmSync(dir, { recursive: true, force: true }); }
};

const DONE = { action: 'done', summary: '1. Nothing urgent in the inbox.\n2. No events today.', outcome: 'changed' };
const READ = [{ action: 'gmail__search_email', query: 'newer_than:1d' }, { action: 'calendar__list_events' }];

describe('with a background model (the worker) and the usual model (the boss)', () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  const workerOn = () => { vi.stubEnv('MWA_BACKGROUND_MODEL', 'openrouter:deepseek/deepseek-v4.1-flash-1017'); vi.stubEnv('MWA_BACKGROUND_BOSS', 'on'); };

  it('a long job starts on the worker and the worker finishes it', async () => {
    workerOn();
    const { r, boss, worker } = await run([...READ, DONE], [DONE]);
    expect(r.reason).toBe('done');
    expect(worker.length).toBeGreaterThan(0);
    expect(boss).toHaveLength(0);
  }, 30_000);

  it('a worker that ignores the push to read its sources hands the run to the boss', async () => {
    workerOn();
    const { r, boss, history } = await run([{ action: 'calendar__list_events' }, DONE, DONE], [{ action: 'gmail__search_email', query: 'newer_than:1d' }, DONE]);
    expect(history).toMatch(/a stronger model took over: a source the job needs is still unread/);
    expect(boss.length).toBeGreaterThan(0);
    expect(r.reason).toBe('done');
  }, 30_000);

  it('a worker about to end with "could not" hands the run to the boss, once', async () => {
    workerOn();
    const gaveUp = { action: 'done', summary: 'I couldn\'t read the open-items list, so this brief is incomplete.', outcome: 'could-not' };
    const { history, boss } = await run([...READ, gaveUp], [gaveUp]);
    expect(history).toMatch(/a stronger model took over: the run was about to end with "could not"/);
    expect(boss.some((p) => /A stronger model has taken over this job/.test(p))).toBe(true);
    expect(history.match(/took over/g)).toHaveLength(1); // the boss may conclude the same
  }, 30_000);

  it('"Tessa can\'t compete" is news, not the run giving up', async () => {
    workerOn();
    const { boss } = await run([...READ, { action: 'done', summary: 'Tessa Morrow can\'t compete Saturday unless her renewal clears by noon Thursday.' }], [DONE]);
    expect(boss).toHaveLength(0);
  }, 30_000);

  it('the same search asked for 10, then 20, then 25 results is a repeat, and three of them bring the boss in', async () => {
    workerOn();
    const s = (max: number) => ({ action: 'gmail__search_email', query: 'after:2026/11/03', max });
    const { history, boss } = await run([s(10), s(20), s(25), s(15), s(5), DONE], [{ action: 'calendar__list_events' }, DONE]);
    expect(history).toMatch(/a stronger model took over: no progress in 3 steps/);
    expect(boss.length).toBeGreaterThan(0);
  }, 30_000);

  it('a worker still reading past step 8 keeps its run: no hand-off for length alone', async () => {
    workerOn();
    const reads = Array.from({ length: 20 }, (_, n) => ({ action: 'gmail__read_email', id: `e${n}` }));
    const { history, worker } = await run([{ action: 'gmail__search_email', query: 'newer_than:1d' }, { action: 'calendar__list_events' }, ...reads], [DONE]);
    expect(history).not.toMatch(/took over/);
    expect(worker.length).toBeGreaterThanOrEqual(12); // past LONG_TASK_STEPS (8), and reading a different email each step is progress
  }, 30_000);

  it('without MWA_BACKGROUND_BOSS=on (the default): a long job starts on the strong tier, as before', async () => {
    workerOn(); vi.stubEnv('MWA_BACKGROUND_BOSS', '');
    const { worker, boss } = await run([...READ, DONE], [...READ, DONE]);
    expect(worker).toHaveLength(0);
    expect(boss.length).toBeGreaterThan(0);
  }, 30_000);
});

describe('without a background model', () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  it('a long job starts on the strong tier, as before', async () => {
    vi.stubEnv('MWA_BACKGROUND_MODEL', '');
    const { worker, boss } = await run([...READ, DONE], [...READ, DONE]);
    expect(worker).toHaveLength(0);
    expect(boss.length).toBeGreaterThan(0);
  }, 30_000);
});
