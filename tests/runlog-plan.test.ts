// A6 review: a planned run wrote one runs.jsonl row per step AND the plan's total row, so anything summing the log (the
// history estimates read) counted a planned job about twice. Now the steps' spend is only in the plan's row, which
// carries the job and the reads; and history built from an older log drops the step rows a plan row spans.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const logDir = mkdtempSync(join(tmpdir(), 'a6-runlog-'));
const saved = { ...process.env };
process.env.MWA_RUNLOG = join(logDir, 'runs.jsonl'); process.env.MWA_TOKEN_LOG = join(logDir, 'tokens.jsonl');
process.env.MWA_FAST_CHAT = '0'; process.env.MWA_LESSON_GATE = 'off'; process.env.MWA_PLAN = 'on';
const { MwaMemory } = await import('../src/awm.js');
const { runAgent } = await import('../src/agent.js');
const { resetAppDb } = await import('../src/v2/db.js');
const { refreshHistory, resetEstimateCache, withoutPlanSteps } = await import('../src/v2/estimate.js');

let dir = '';
let mem: InstanceType<typeof MwaMemory>;
beforeAll(() => { resetAppDb(':memory:'); dir = mkdtempSync(join(tmpdir(), 'a6-rl-')); mem = new MwaMemory('a6-rl', join(dir, 'm.db')); });
afterAll(() => {
  mem.close(); resetEstimateCache();
  for (const k of ['MWA_RUNLOG', 'MWA_TOKEN_LOG', 'MWA_FAST_CHAT', 'MWA_LESSON_GATE', 'MWA_PLAN']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(dir, { recursive: true, force: true }); rmSync(logDir, { recursive: true, force: true });
});

describe('runs.jsonl for a planned job', () => {
  it('one row, whose cost is the true cost, with the job and the reads', async () => {
    const brain: any = { id: 'p', model: 'p', price: [10, 0], chat: async (input: any) => {
      const usage = { input: 1000, output: 0 };
      const sys = String(input.system ?? ''), user = `${sys} ${JSON.stringify(input.messages)}`;
      if (sys.includes('You are the PLANNER')) return { text: JSON.stringify({ steps: [{ task: 'Read the dressage rules' }, { task: 'Read the jumping rules' }, { task: 'Write the study notes' }] }), usage };
      if (!sys.includes('TRUST BOUNDARY')) return { text: '{}', usage };
      const step = /This is step (\d) of 3/.exec(user)?.[1] ?? '?';
      return { text: JSON.stringify({ action: 'done', summary: `Step ${step} finished: the rules say a test is ridden in a 20 by 60 metre arena.`, outcome: 'no-change' }), usage };
    } };
    const r = await runAgent({ instruction: 'Read the dressage rules, then read the jumping rules, then write the study notes', dir, memory: mem, brain, worker: brain, interactive: false, plan: true, jobId: 'plannedjob-0000', dueNow: true, session: 'p-general',
      budget: { maxSteps: 30, maxWallMs: 60_000 } } as any);
    const rows = readFileSync(process.env.MWA_RUNLOG!, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ planned: 3, job: 'plannedjob-0000', reads: 0, pagesRead: 0 });
    const sum = rows.reduce((s: number, x: { costUsd: number }) => s + x.costUsd, 0);
    expect(sum).toBeCloseTo(r.costUsd, 3);
  }, 60_000);

  it('history from an older log (step rows and a plan row) counts the plan once, under its job', () => {
    const t = Date.UTC(2026, 9, 20, 12);
    const old = [
      { ts: t + 1000, session: 's1', job: 'oldjob-1', costUsd: 0.10, durationMs: 5000, steps: 3, reads: 2 },
      { ts: t + 7000, session: 's1', job: 'oldjob-1', costUsd: 0.20, durationMs: 5000, steps: 4, reads: 4 },
      { ts: t, session: 's1', planned: 2, costUsd: 0.31, durationMs: 15_000, steps: 7 },
      { ts: t + 60_000, session: 's2', costUsd: 0.05, durationMs: 4000, steps: 2, reads: 1 },
    ];
    const kept = withoutPlanSteps(old.map((r) => ({ ...r, planned: !!r.planned, reads: r.reads ?? 0 })));
    expect(kept.map((r) => [r.session, r.costUsd, r.job ?? null, r.reads])).toEqual([['s1', 0.31, 'oldjob-1', 6], ['s2', 0.05, null, 1]]);
    expect(kept.reduce((s, r) => s + r.costUsd, 0)).toBeCloseTo(0.36, 6); // the true total, not 0.66
    // and through the history reader itself
    const runs = join(logDir, 'old-runs.jsonl'), tokens = join(logDir, 'old-tokens.jsonl');
    writeFileSync(runs, old.map((r) => JSON.stringify(r)).join('\n') + '\n');
    writeFileSync(tokens, '');
    resetEstimateCache();
    expect(() => refreshHistory({ runs, tokens })).not.toThrow();
  });
});
