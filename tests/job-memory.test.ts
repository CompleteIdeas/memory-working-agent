/**
 * BL-44 — a job remembers its own last run: a watch its last value (and the values it has changed through),
 * a brief when it last ran and what it said, and every job the person's own words. Measured in BL-40: price
 * and flight changes were reported 0 of 6 times; the first check said "still $1.10, the same as the last
 * check"; the day roses went from $1.10 to $1.45 it said "no change" without opening the page; and the
 * stored job had lost the link the person gave.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jobContext } from '../src/agent.js';
import { tickScheduler, sameReading } from '../src/scheduler.js';
import type { JobLastRun } from '../src/awm.js';

const prevTz = process.env.TZ;
afterEach(() => { if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz; });
const wrap = (label: string, text: string) => `<<${label}:${text}>>`;
const NOV6 = Date.UTC(2026, 10, 6, 12, 0);

describe('what a fire is told about its own job', () => {
  it('nothing for a run that is not a job', () => {
    expect(jobContext({ jobRequest: 'x' }, NOV6, wrap)).toEqual([]);
  });

  it('a watch with no reading yet is told so — no "same as last time" on the first check', () => {
    const lines = jobContext({ jobId: 'j1', jobDeliver: 'changed', jobRequest: 'Set a daily 7:00 AM check on https://bloomfield-wholesale.example/prices — only tell me if standard roses change.' }, NOV6, wrap);
    expect(lines.join('\n')).toContain('https://bloomfield-wholesale.example/prices');
    expect(lines.join('\n')).toMatch(/THIS IS THE JOB'S FIRST READING: there is no earlier value/);
  });

  it('a later check gets the last reading and its history, fenced, and is told to read the source again', () => {
    process.env.TZ = 'America/New_York';
    const last: JobLastRun = { at: NOV6 - 86_400_000, summary: 'Standard roses $1.10 per stem.', value: '$1.10 per stem', valueAt: NOV6 - 86_400_000, history: [{ at: NOV6 - 4 * 86_400_000, value: '$1.10 per stem' }] };
    const text = jobContext({ jobId: 'j1', jobDeliver: 'changed', jobLastRun: last }, NOV6, wrap).join('\n');
    expect(text).toContain('<<last_reading:$1.10 per stem — values it has seen: Mon 2 Nov 2026 at 7:00 AM: $1.10 per stem>>');
    expect(text).toMatch(/a remembered value is not a check/);
    expect(text).toContain('<<last_report:Standard roses $1.10 per stem.>>');
    expect(text).toMatch(/LAST RAN Thu 5 Nov 2026 at 7:00 AM \(24h ago\)/);
    expect(text).not.toMatch(/FIRST READING/);
  });

  it('a resume is not told about "the last run" — it is the same run, continued', () => {
    const last: JobLastRun = { at: NOV6 - 3_600_000, summary: 'x' };
    expect(jobContext({ jobId: 'j1', jobLastRun: last, resumeAttempt: 1 }, NOV6, wrap).join('\n')).not.toMatch(/LAST RAN/);
  });

  it('readings that differ only in case, spacing or a full stop are the same reading', () => {
    expect(sameReading('$1.10 per stem.', ' $1.10  Per stem')).toBe(true);
    expect(sameReading('$1.10 per stem', '$1.45 per stem')).toBe(false);
  });
});

describe('the scheduler keeps the record and reports a change', () => {
  const fire = async (task: Record<string, unknown>, run: Record<string, unknown>) => {
    const outRoot = mkdtempSync(join(tmpdir(), 'mwa-bl44-'));
    const saved: JobLastRun[] = []; const fired: { summary: string; outcome?: string }[] = []; const writes: string[] = []; const supersedes: string[] = []; const seen: Record<string, unknown>[] = [];
    const mem = {
      enabled: true,
      async pendingScheduled() { return [task]; }, async completeScheduled() { /* */ }, async rescheduleTask() { /* */ },
      async setJobLastRun(_id: string, rec: JobLastRun) { saved.push(rec); },
      async write(_c: string, content: string) { writes.push(content); return 'obs-new'; },
      async supersede(old: string, _c: string, content: string) { supersedes.push(`${old}:${content}`); return 'obs-2'; },
    };
    try {
      await tickScheduler({
        memory: mem as never, brain: {} as never, worker: {} as never, outRoot, now: () => NOV6, checksAllowed: false,
        onFire: async (_t, r) => { fired.push(r); },
        runAgent: (async (o: Record<string, unknown>) => { seen.push(o); return { reason: 'done', steps: 3, toolCalls: 2, costUsd: 0, durationMs: 0, ...run }; }) as never,
      });
    } finally { rmSync(outRoot, { recursive: true, force: true }); }
    return { saved, fired, writes, supersedes, seen };
  };
  const WATCH = { id: 'watch123', instruction: 'Check the standard rose price at https://bloomfield-wholesale.example/prices', due: 1, recur: 'daily:07:00', deliver: 'changed' };

  it('the fire gets the person\'s words and the last record', async () => {
    const last: JobLastRun = { at: NOV6 - 86_400_000, summary: 's', value: '$1.10 per stem' };
    const { seen } = await fire({ ...WATCH, request: 'my words', lastRun: last }, { summary: 'ok', outcome: 'no-change', watchValue: '$1.10 per stem' });
    expect(seen[0].jobRequest).toBe('my words');
    expect(seen[0].jobLastRun).toEqual(last);
  });

  it('a new value is news with both values, even when the run called it "no change" — and it becomes an observation', async () => {
    process.env.TZ = 'America/New_York';
    const last: JobLastRun = { at: NOV6 - 86_400_000, summary: 's', value: '$1.10 per stem', valueAt: NOV6 - 86_400_000, history: [{ at: NOV6 - 4 * 86_400_000, value: '$1.10 per stem' }], obs: 'obs-1' };
    const { fired, saved, supersedes } = await fire({ ...WATCH, lastRun: last }, { summary: 'Standard roses are $1.45 per stem.', outcome: 'no-change', watchValue: '$1.45 per stem' });
    expect(fired).toHaveLength(1);
    expect(fired[0].outcome).toBe('changed');
    expect(fired[0].summary).toContain('(Changed since Thu 5 Nov 2026 at 7:00 AM: it was $1.10 per stem; it is now $1.45 per stem.)');
    expect(saved[0].value).toBe('$1.45 per stem');
    expect(saved[0].history!.map((h) => h.value)).toEqual(['$1.10 per stem', '$1.45 per stem']);
    expect(supersedes[0]).toMatch(/^obs-1:.*found: \$1\.45 per stem\. Before that, on Thu 5 Nov 2026 at 7:00 AM, it was \$1\.10 per stem\./);
    expect(saved[0].obs).toBe('obs-2');
  });

  it('the same value under "tell me only on change" stays quiet, whatever the run called it', async () => {
    const last: JobLastRun = { at: NOV6 - 86_400_000, summary: 's', value: '$1.10 per stem' };
    const { fired, saved, writes } = await fire({ ...WATCH, lastRun: last }, { summary: 'Price checked: still $1.10.', outcome: 'changed', watchValue: '$1.10 per stem.' });
    expect(fired).toHaveLength(0);
    expect(saved[0].history).toBeUndefined(); // no change, nothing added
    expect(writes).toHaveLength(0);
  });

  it('the first reading starts the history and writes the first observation', async () => {
    const { saved, writes } = await fire(WATCH, { summary: 'Standard roses: $1.10 per stem.', outcome: 'changed', watchValue: '$1.10 per stem' });
    expect(saved[0].history!.map((h) => h.value)).toEqual(['$1.10 per stem']);
    expect(writes[0]).toMatch(/found: \$1\.10 per stem\./);
    expect(saved[0].obs).toBe('obs-new');
  });

  it('a run that could not read the source keeps the last good record', async () => {
    const last: JobLastRun = { at: NOV6 - 86_400_000, summary: 's', value: '$1.10 per stem' };
    const { saved, fired } = await fire({ ...WATCH, lastRun: last }, { summary: "I couldn't open the page.", outcome: 'could-not' });
    expect(saved).toHaveLength(0);
    expect(fired).toHaveLength(1); // a failure is still delivered
  });
});

describe('a run reports its reading only when it read something', () => {
  const run = async (opts: Record<string, unknown>, actions: Record<string, unknown>[]) => {
    const { runAgent } = await import('../src/agent.js');
    const dir = mkdtempSync(join(tmpdir(), 'mwa-bl44r-'));
    let i = 0;
    const brain = { id: 's', model: 's', price: [0, 0] as [number, number], chat: async (input: any) => {
      if (!String(input.system ?? '').includes('TRUST BOUNDARY')) return { text: '{}', usage: { input: 1, output: 1 } };
      return { text: JSON.stringify(actions[Math.min(i++, actions.length - 1)]), usage: { input: 1, output: 1 } };
    } };
    const tools = { defs: () => [{ name: 'web__open_page', description: 'open', parameters: { type: 'object', properties: {} } }], has: (n: string) => n === 'web__open_page', call: async () => 'Standard roses: $1.45 per stem' };
    const prev = process.env.MWA_FAST_CHAT; process.env.MWA_FAST_CHAT = '0';
    try {
      return await runAgent({ instruction: 'Check the rose price', dir, memory: { enabled: false, async recall() { return []; }, async listPolicies() { return []; }, setSessionId() { /* */ }, async addScheduledTask() { return null; }, async logAction() { return null; } } as any, brain, worker: brain, interactive: false, plan: false, tools: tools as any, budget: { maxSteps: 5, maxWallMs: 20_000 }, ...opts } as any);
    } finally {
      if (prev === undefined) delete process.env.MWA_FAST_CHAT; else process.env.MWA_FAST_CHAT = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const DONE = { action: 'done', summary: 'Roses are $1.45 per stem.', outcome: 'changed', value: '$1.45 per stem' };

  it('a job that opened the page reports what it read', async () => {
    const r = await run({ jobId: 'watch123', dueNow: true }, [{ action: 'web__open_page' }, DONE]);
    expect(r.watchValue).toBe('$1.45 per stem');
  }, 30_000);

  it('a value from a run that read nothing is not taken', async () => {
    const r = await run({ jobId: 'watch123', dueNow: true }, [DONE]);
    expect(r.watchValue).toBeUndefined();
  }, 30_000);

  it('only a job\'s fire reports a reading', async () => {
    const r = await run({}, [{ action: 'web__open_page' }, DONE]);
    expect(r.watchValue).toBeUndefined();
  }, 30_000);
});
