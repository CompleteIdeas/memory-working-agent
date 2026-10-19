/**
 * BL-39 — the agent is told the person's local date and time (NOW), can schedule a one-shot at a local
 * date and time (`at`), and confirms in local time. Found grounding the promise assessment: no prompt
 * carried a date, so "Thursday at 3pm" could only be guessed, and confirmations were UTC.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nowLine, parseLocalAt, localStamp } from '../src/agent.js';

const prevTz = process.env.TZ;
afterEach(() => { if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz; });

describe('the clock the agent sees', () => {
  it('NOW names the weekday, the local date and time, and the zone', () => {
    process.env.TZ = 'America/New_York';
    const ms = Date.UTC(2026, 9, 22, 19, 5); // 15:05 in New York (EDT)
    expect(nowLine(ms)).toBe('NOW: Thursday, October 22, 2026 (2026-10-22), 15:05, time zone America/New_York.');
    expect(localStamp(ms)).toBe('2026-10-22 15:05');
  });

  it('reads "YYYY-MM-DD HH:MM" as local time and refuses what is not a real date and time', () => {
    process.env.TZ = 'America/New_York';
    expect(parseLocalAt('2026-10-22 15:00')).toBe(Date.UTC(2026, 9, 22, 19, 0));
    expect(parseLocalAt('2026-10-22T09:30')).toBe(Date.UTC(2026, 9, 22, 13, 30));
    for (const bad of ['2026-02-30 10:00', '2026-10-22 25:00', 'Thursday 3pm', '2026-10-22', '']) expect(parseLocalAt(bad), bad).toBeNull();
  });
});

describe('scheduling at a date and time in a run', () => {
  const run = async (actions: Record<string, unknown>[]) => {
    const { runAgent } = await import('../src/agent.js');
    const { MwaMemory } = await import('../src/awm.js');
    const dir = mkdtempSync(join(tmpdir(), 'mwa-bl39-'));
    const mem = new MwaMemory('bl39', join(dir, 'm.db'));
    const systems: string[] = []; const prompts: string[] = [];
    let i = 0;
    const brain = { id: 's', model: 's', price: [0, 0] as [number, number], chat: async (input: any) => {
      if (!String(input.system ?? '').includes('TRUST BOUNDARY')) return { text: '{}', usage: { input: 1, output: 1 } };
      systems.push(String(input.system)); prompts.push(String(input.messages?.[0]?.content ?? ''));
      return { text: JSON.stringify(actions[Math.min(i++, actions.length - 1)]), usage: { input: 1, output: 1 } };
    } };
    const nowMs = Date.UTC(2026, 9, 19, 13, 0); // Monday 09:00 in New York
    const prev = process.env.MWA_FAST_CHAT; process.env.MWA_FAST_CHAT = '0';
    try {
      const r = await runAgent({ instruction: 'remind me Thursday at 3pm to call the plumber', userMessage: 'remind me Thursday at 3pm to call the plumber', dir, memory: mem as any, brain, worker: brain, interactive: true, plan: false, now: () => nowMs, budget: { maxSteps: 6, maxWallMs: 20_000 } } as any);
      const jobs = await mem.pendingScheduled();
      return { r, jobs, systems, prompts };
    } finally {
      if (prev === undefined) delete process.env.MWA_FAST_CHAT; else process.env.MWA_FAST_CHAT = prev;
      mem.close(); rmSync(dir, { recursive: true, force: true });
    }
  };

  it('the run is told NOW; `at` schedules exactly then and confirms in local time', async () => {
    process.env.TZ = 'America/New_York';
    const { r, jobs, systems } = await run([{ action: 'schedule', instruction: 'Remind the person to call the plumber.', at: '2026-10-22 15:00' }]);
    expect(systems[0]).toContain('NOW: Monday, October 19, 2026 (2026-10-19), 09:00, time zone America/New_York.');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].due).toBe(Date.UTC(2026, 9, 22, 19, 0));
    expect(r.summary).toContain('Scheduled for 2026-10-22 15:00');
  }, 60_000);

  it('a past or malformed `at` goes back to the model with NOW instead of running in a minute', async () => {
    process.env.TZ = 'America/New_York';
    const { jobs, prompts } = await run([
      { action: 'schedule', instruction: 'Remind the person to call the plumber.', at: '2026-10-15 15:00' },
      { action: 'schedule', instruction: 'Remind the person to call the plumber.', at: 'Thursday 3pm' },
      { action: 'schedule', instruction: 'Remind the person to call the plumber.', at: '2026-10-22 15:00' },
    ]);
    expect(prompts[1]).toMatch(/That time is already past\. NOW: Monday, October 19, 2026/);
    expect(prompts[2]).toMatch(/is not a date and time in the form YYYY-MM-DD HH:MM/);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].due).toBe(Date.UTC(2026, 9, 22, 19, 0));
  }, 60_000);
});
