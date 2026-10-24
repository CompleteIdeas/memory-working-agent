/**
 * Schedule controls (usability review 2026-10-24, F04). The schedule list had no ids and no controls, a five-minute
 * watch ran until the server was stopped, and three cancel requests in chat ended "I can't cancel them from here" —
 * the model listed the schedule three times and never called schedule_cancel. Now: the store pauses, resumes and
 * un-cancels a job; the scheduler skips a paused one; the app's list carries ids and state; the controls act through
 * the same tools the model uses, for the person asking; and a stop request that ends with nothing stopped is sent
 * back once with the ids.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MwaMemory } from '../src/awm.js';
import { tickScheduler } from '../src/scheduler.js';
import { scheduleRows, scheduleControl } from '../src/schedule-api.js';
import { runAgent } from '../src/agent.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { workTools } from '../src/tools/work.js';
import { asksToStopJob } from '../src/schedule-request.js';

const withStore = async <T>(fn: (mem: MwaMemory, dir: string) => Promise<T>): Promise<T> => {
  const dir = mkdtempSync(join(tmpdir(), 'mwa-sched-ctl-'));
  const mem = new MwaMemory('ctl', join(dir, 'm.db'));
  try { return await fn(mem, dir); } finally { mem.close(); rmSync(dir, { recursive: true, force: true }); }
};
const HOUR = 3_600_000;

describe('the store: pause, resume, undo a cancel', () => {
  it('pauses and resumes a job, and resume sets the next natural slot', async () => {
    await withStore(async (mem) => {
      const now = Date.now();
      const id = (await mem.addScheduledTask('Check the budget file', now - 60_000, { recur: 'every:5', person: 'p1' }))!;
      await mem.pauseScheduled(id);
      expect((await mem.pendingScheduled()).find((t) => t.id === id)?.paused).toBe(true);
      expect((await mem.getScheduled(id))?.paused).toBe(true);
      await mem.resumeScheduled(id, now);
      const t = (await mem.pendingScheduled()).find((x) => x.id === id)!;
      expect(t.paused).toBeUndefined();
      expect(t.due).toBe(now + 5 * 60_000);
      const daily = (await mem.addScheduledTask('Morning brief', now, { recur: 'daily:08:00', person: 'p1' }))!;
      await mem.pauseScheduled(daily); await mem.resumeScheduled(daily, now);
      expect((await mem.getScheduled(daily))!.due).toBeGreaterThan(now);
    });
  });
  it('a cancel can be undone within ten minutes, not after, and the job comes back as it was', async () => {
    await withStore(async (mem) => {
      const now = Date.now();
      const id = (await mem.addScheduledTask('Call Harbour Works', now + HOUR, { person: 'p1' }))!;
      await mem.cancelScheduled(id, now);
      expect(await mem.pendingScheduled()).toHaveLength(0);
      expect((await mem.getScheduled(id))?.status).toBe('canceled');
      expect(await mem.uncancelScheduled(id, undefined, now + 11 * 60_000)).toBe(false);
      expect(await mem.uncancelScheduled(id, undefined, now + 60_000)).toBe(true);
      const back = (await mem.pendingScheduled()).find((t) => t.id === id)!;
      expect(back.due).toBe(now + HOUR);
      expect((await mem.getScheduled(id))?.canceledAt).toBeUndefined();
    });
  });
});

describe('the scheduler skips a paused job', () => {
  it('does not run it and does not move its clock', async () => {
    const outRoot = mkdtempSync(join(tmpdir(), 'mwa-paused-'));
    const ran: unknown[] = []; const moved: unknown[] = [];
    try {
      await tickScheduler({
        memory: { async pendingScheduled() { return [{ id: 'job00001', instruction: 'Check the budget file', due: 1, recur: 'every:5', paused: true }]; },
          async completeScheduled() { /* */ }, async rescheduleTask(...a: unknown[]) { moved.push(a); }, async setScheduledSignature() { /* */ } } as never,
        brain: {} as never, worker: {} as never, outRoot, now: () => 10_000, checksAllowed: false, watchGate: null,
        onFire: async () => { /* */ }, runAgent: (async (o: unknown) => { ran.push(o); return { summary: 'ok', reason: 'done' }; }) as never,
      });
    } finally { try { rmSync(outRoot, { recursive: true, force: true }); } catch { /* */ } }
    expect(ran).toHaveLength(0);
    expect(moved).toHaveLength(0);
  });
});

describe('the app\'s schedule view and controls', () => {
  it('lists this person\'s jobs with ids, kind and state; cancels with an undo; pauses and resumes; moves a time', async () => {
    await withStore(async (mem) => {
      const now = Date.now();
      const remind = (await mem.addScheduledTask('Call Harbour Works about the dock quote', now + HOUR, { person: 'web-robert', kind: 'reminder', request: 'Remind me to call Harbour Works' }))!;
      const watch = (await mem.addScheduledTask('Check budget-2026.csv and report changes', now + 5 * 60_000, { person: 'web-robert', recur: 'every:5', deliver: 'changed' }))!;
      await mem.addScheduledTask('Somebody else\'s brief', now + HOUR, { person: 'tg-1000000001', recur: 'daily:08:00' });
      const rows = await scheduleRows(mem, 'web-robert');
      expect(rows.map((r) => [r.id, r.kind, r.paused])).toEqual([[watch, 'watch', false], [remind, 'reminder', false]]);
      expect(rows[1].request).toBe('Remind me to call Harbour Works');
      // another person's job: not listed, not controllable
      expect(rows.some((r) => r.instruction.startsWith('Somebody'))).toBe(false);
      const other = (await mem.pendingScheduled()).find((t) => t.person === 'tg-1000000001')!;
      expect((await scheduleControl(mem, 'web-robert', 'cancel', { id: other.id })).ok).toBe(false);
      // cancel, then undo
      const c = await scheduleControl(mem, 'web-robert', 'cancel', { id: remind.slice(0, 8) }, now);
      expect(c.ok).toBe(true); expect(c.message).toMatch(/Undo within ten minutes/);
      expect((await scheduleRows(mem, 'web-robert')).map((r) => r.id)).toEqual([watch]);
      expect((await scheduleControl(mem, 'web-robert', 'uncancel', { id: remind }, now + 60_000)).ok).toBe(true);
      expect((await scheduleRows(mem, 'web-robert')).map((r) => r.id)).toEqual([watch, remind]);
      // pause and resume the watch
      expect((await scheduleControl(mem, 'web-robert', 'pause', { id: watch })).ok).toBe(true);
      expect((await scheduleRows(mem, 'web-robert')).find((r) => r.id === watch)?.paused).toBe(true);
      const r = await scheduleControl(mem, 'web-robert', 'resume', { id: watch }, now);
      expect(r.ok).toBe(true); expect(r.message).toMatch(/^Resumed\. Next run/);
      // move the reminder
      const u = await scheduleControl(mem, 'web-robert', 'update', { id: remind, at: '2031-03-04 09:30' });
      expect(u.ok).toBe(true); expect(u.message).toMatch(/^updated/);
      expect((await mem.getScheduled(remind))!.due).toBe(new Date(2031, 2, 4, 9, 30).getTime());
      expect((await scheduleControl(mem, 'web-robert', 'update', { id: remind })).ok).toBe(false);
    });
  });
});

describe('a stop request that ends with nothing stopped', () => {
  it('asksToStopJob reads the person\'s stop words', () => {
    expect(asksToStopJob('Cancel the Harbour Works reminder, I already called them.')).toBe(true);
    expect(asksToStopJob('Stop watching the budget file.')).toBe(true);
    expect(asksToStopJob('What is on my schedule?')).toBe(false);
  });
  it('is sent back once with the ids, and the model then cancels', async () => {
    await withStore(async (mem, dir) => {
      const now = Date.now();
      const id = (await mem.addScheduledTask('Check budget-2026.csv and report changes', now + 5 * 60_000, { recur: 'every:5' }))!;
      const reg = new ToolRegistry(); reg.registerAll(workTools(mem));
      const script: Record<string, unknown>[] = [
        { action: 'schedule_list' },
        { action: 'done', summary: 'I found the recurring check, but I haven\'t stopped it. I can\'t cancel it from here.' },
        { action: 'schedule_cancel', id: id.slice(0, 8) },
        { action: 'done', summary: 'Stopped the budget check.' },
      ];
      let i = 0; const prompts: string[] = [];
      const brain = { id: 's', model: 's', price: [0, 0] as [number, number], chat: async (input: { system?: string; messages?: { content: string }[] }) => {
        if (!String(input.system ?? '').includes('TRUST BOUNDARY')) return { text: '{}', usage: { input: 1, output: 1 } };
        prompts.push(String(input.messages?.[0]?.content ?? ''));
        return { text: JSON.stringify(script[Math.min(i++, script.length - 1)]), usage: { input: 1, output: 1 } };
      } };
      const prev = process.env.MWA_FAST_CHAT; process.env.MWA_FAST_CHAT = '0';
      try {
        const r = await runAgent({ instruction: 'Stop watching the budget file.', userMessage: 'Stop watching the budget file.', dir, memory: mem, brain, worker: brain, tools: reg, interactive: true, budget: { maxSteps: 8, maxWallMs: 30_000 } });
        expect(r.history.join('\n')).toMatch(/a stop request ended with nothing stopped — asked for the cancel/);
        expect(prompts.some((p) => p.includes('You CAN cancel') && p.includes(id.slice(0, 8)))).toBe(true);
        expect(r.summary).toMatch(/^Stopped the budget check\.\n\nStopped: "Check budget-2026\.csv/); // BL-47 names the job stopped
        expect(await mem.pendingScheduled()).toHaveLength(0);
      } finally { if (prev === undefined) delete process.env.MWA_FAST_CHAT; else process.env.MWA_FAST_CHAT = prev; }
    });
  }, 60_000);
});
