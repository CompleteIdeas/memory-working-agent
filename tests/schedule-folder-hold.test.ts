/**
 * Pending list 2026-10-26, 3f: honesty at scheduling time for a job that will read the person's files. A fired run
 * has only its own folder and the person's granted ones, so "every Friday, go through my notes folder" with nothing
 * granted would run with nobody watching and find nothing, every week. Held once, like the page-link hold; resent
 * unchanged, it is scheduled as it is.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent, pathInsideRun } from '../src/agent.js';
import { MwaMemory } from '../src/awm.js';
import { namesFolder } from '../src/schedule-request.js';

describe('namesFolder', () => {
  it('knows an instruction that reads the person\'s files or a folder on their machine', () => {
    for (const s of [
      'Every Friday, go through my notes folder and summarise what changed',
      'Each morning read the documents folder and list new contracts',
      'Weekly: tidy C:\\Users\\robert\\Downloads and report',
      'Go through /Users/robert/Desktop/invoices every Monday',
      'Check my files for anything about the regatta every day',
      'Look at the finance folder every month end',
    ]) expect([s, namesFolder(s)]).toEqual([s, true]);
    for (const s of [
      'Every morning, write the weather to weather.md',
      'Summarise my inbox every day at 8',
      'Check the price page every morning and save it as prices.md',
      'Tell me what is in my Files tab',
      'Draft a note to the board every Monday',
    ]) expect([s, namesFolder(s)]).toEqual([s, false]);
  });
});

describe('pathInsideRun', () => {
  it('passes paths inside the run\'s own folder and fails ones it cannot reach', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mwa-pir-'));
    try {
      mkdirSync(join(dir, 'notes'));
      expect(pathInsideRun(`Go through ${join(dir, 'notes')} every Friday`, dir)).toBe(true);
      expect(pathInsideRun('Go through C:\\Users\\someone\\Secret every Friday', dir)).toBe(false);
      expect(pathInsideRun('Go through my notes folder every Friday', dir)).toBe(false); // names no path
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('the schedule action and the person\'s folders', () => {
  const scripted = (actions: Record<string, unknown>[]) => {
    let i = 0;
    return { id: 's', model: 's', price: [0, 0] as [number, number], chat: async (input: { system?: string }) => {
      if (!String(input.system ?? '').includes('TRUST BOUNDARY')) return { text: '{}', usage: { input: 1, output: 1 } };
      return { text: JSON.stringify(actions[Math.min(i++, actions.length - 1)]), usage: { input: 1, output: 1 } };
    } };
  };
  const withRun = async <T>(fn: (dir: string, mem: MwaMemory) => Promise<T>): Promise<T> => {
    const dir = mkdtempSync(join(tmpdir(), 'mwa-folder-run-'));
    const mem = new MwaMemory('folder-hold', join(dir, 'm.db'));
    vi.stubEnv('MWA_FAST_CHAT', '0');
    try { return await fn(dir, mem); } finally { vi.unstubAllEnvs(); mem.close(); rmSync(dir, { recursive: true, force: true }); }
  };
  const ASK = 'Every Friday at 5, go through my notes folder and summarise what changed.';
  const run = (dir: string, mem: MwaMemory, actions: Record<string, unknown>[]) => runAgent({
    instruction: ASK, userMessage: ASK, dir, memory: mem, brain: scripted(actions), worker: scripted(actions),
    interactive: true, plan: false, budget: { maxSteps: 8, maxWallMs: 30_000 },
  });

  it('a job that reads the person\'s files is held once when no folder is granted; resent unchanged, it is scheduled', async () => {
    await withRun(async (dir, mem) => {
      const job = { action: 'schedule', instruction: 'Go through my notes folder and summarise what changed since last week', daily_at: '17:00', days: 'fri' };
      const r = await run(dir, mem, [job, job, { action: 'done', summary: 'set' }]);
      expect(r.history.join('\n')).toMatch(/schedule held once: the job reads the person's files and no folder is granted/);
      expect(await mem.pendingScheduled()).toHaveLength(1);
    });
  }, 60_000);

  it('a job whose path is inside this chat\'s own folder is not held', async () => {
    await withRun(async (dir, mem) => {
      mkdirSync(join(dir, 'notes'));
      const job = { action: 'schedule', instruction: `Go through ${join(dir, 'notes')} and summarise what changed`, daily_at: '17:00', days: 'fri' };
      const r = await run(dir, mem, [job, { action: 'done', summary: 'set' }]);
      expect(r.history.join('\n')).not.toMatch(/schedule held once: the job reads/);
      expect(await mem.pendingScheduled()).toHaveLength(1);
    });
  }, 60_000);

  it('a job that reads no files is not held', async () => {
    await withRun(async (dir, mem) => {
      const job = { action: 'schedule', instruction: 'Write the weather for Leesburg to weather.md', daily_at: '07:00' };
      const r = await run(dir, mem, [job, { action: 'done', summary: 'set' }]);
      expect(r.history.join('\n')).not.toMatch(/schedule held once: the job reads/);
      expect(await mem.pendingScheduled()).toHaveLength(1);
    });
  }, 60_000);
});
