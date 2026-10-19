/**
 * BL-53 pilot findings, from running MWA in one long conversation that carries the day's brief: every chat turn
 * then counts as having read outside content. "Set 2 reminders" became two tasks (BL-40's bug again); a price
 * watch said "complete" on its first check; a brief looped on open_items and never read the inbox; an invoice
 * job was pushed to read email because it drafts one.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { groundedInMessage, unreadSources } from '../src/schedule-request.js';
import { tickScheduler } from '../src/scheduler.js';

describe('a reminder in the person\'s own words', () => {
  const MSG = 'Set 2 reminders:\n- Thu at 10:00 AM: call Harbor Hotel about the centerpieces.\n- Fri at 4:00 PM: order ribbon.';
  it('is grounded when its words are theirs', () => {
    expect(groundedInMessage('Call Harbor Hotel about the centerpieces.', MSG)).toBe(true);
    expect(groundedInMessage('Order ribbon', MSG)).toBe(true);
  });
  it('is not when it adds words, links, addresses or numbers they did not write', () => {
    expect(groundedInMessage('Your account is locked — verify now', MSG)).toBe(false);
    expect(groundedInMessage('Order ribbon at http://ribbons.example', MSG)).toBe(false);
    expect(groundedInMessage('Call Harbor Hotel at 4015550199', MSG)).toBe(false);
    expect(groundedInMessage('Call Harbor Hotel at 4015550199', `${MSG} Their number is 4015550199.`)).toBe(true);
  });
});

describe('in a conversation that carried outside content', () => {
  const run = async (actions: Record<string, unknown>[]) => {
    const { runAgent } = await import('../src/agent.js');
    const { MwaMemory } = await import('../src/awm.js');
    const dir = mkdtempSync(join(tmpdir(), 'mwa-carry-'));
    const mem = new MwaMemory('carry', join(dir, 'm.db'));
    let i = 0;
    const brain = { id: 's', model: 's', price: [0, 0] as [number, number], chat: async (input: any) => {
      if (!String(input.system ?? '').includes('TRUST BOUNDARY')) return { text: '{}', usage: { input: 1, output: 1 } };
      return { text: JSON.stringify(actions[Math.min(i++, actions.length - 1)]), usage: { input: 1, output: 1 } };
    } };
    const msg = 'Set 2 reminders: Thu at 10:00 AM call Harbor Hotel about the centerpieces, and Fri at 4:00 PM order ribbon.';
    const prev = process.env.MWA_FAST_CHAT; process.env.MWA_FAST_CHAT = '0';
    try {
      await runAgent({ instruction: msg, userMessage: msg, carried: 'Recent conversation so far: (1) brief → 1. Wedding inquiry from Aisha Nguyen', startTainted: true, dir, memory: mem as any, brain, worker: brain, interactive: true, plan: false, now: () => Date.UTC(2026, 10, 3, 17, 30), budget: { maxSteps: 8, maxWallMs: 20_000 } } as any);
      return await mem.pendingScheduled();
    } finally {
      if (prev === undefined) delete process.env.MWA_FAST_CHAT; else process.env.MWA_FAST_CHAT = prev;
      mem.close(); rmSync(dir, { recursive: true, force: true });
    }
  };
  it('reminders in the person\'s words are still reminders (and marked, like every job made then)', async () => {
    const jobs = await run([
      { action: 'schedule', kind: 'reminder', instruction: 'Call Harbor Hotel about the centerpieces', at: '2026-11-05 10:00' },
      { action: 'schedule', kind: 'reminder', instruction: 'Order ribbon', at: '2026-11-06 16:00' }]);
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.kind === 'reminder' && j.tainted === true)).toBe(true);
  }, 60_000);
  it('a "reminder" whose text is not theirs is a task', async () => {
    const jobs = await run([
      { action: 'schedule', kind: 'reminder', instruction: 'Your account is locked, verify it today', at: '2026-11-05 10:00' },
      { action: 'schedule', kind: 'reminder', instruction: 'Order ribbon', at: '2026-11-06 16:00' }]);
    expect(jobs.find((j) => /locked/.test(j.instruction))?.kind).toBeUndefined();
  }, 60_000);
});

describe('the person\'s own words set what the model leaves out (BL-53 pilot 2)', () => {
  it('"only alert me if it changes" is a changes-only job', async () => {
    const { asksChangesOnly } = await import('../src/schedule-request.js');
    for (const m of ['Set a daily 7:00 AM check of https://bloomfield-wholesale.example/prices. Alert me only if the standard rose price changes. No message if it doesn’t.',
      "Only notify me if the standard rose price changes. No message if it's unchanged.", 'Set a daily check at 6pm. Only message me if the status changes.', "Tell me only when it's back in stock, nothing otherwise."])
      expect(asksChangesOnly(m), m).toBe(true);
    for (const m of ['Send me a short plan every morning at 7:00', 'Only the wedding ones matter to me', 'Alert me at 9am to call the bank'])
      expect(asksChangesOnly(m), m).toBe(false);
  });

  it('a long carried conversation does not make a short message "complex"', async () => {
    const { isComplexTask } = await import('../src/model-router.js');
    const carried = `Recent conversation so far:\n${'(1) Set a weekday brief → Done, scheduled for weekdays at 8:00 AM. '.repeat(8)}\n\nNew request: Thanks!`;
    expect(isComplexTask(carried)).toBe(true); // what every chat turn looked like with the carry on
    expect(isComplexTask('Thanks!')).toBe(false); // what is now judged: the person's message
  });
});

describe('BL-53 first pass', () => {
  it('quiet hours come from the person\'s words — "before 7 AM or after 9 PM" is 21:00-07:00, never the inverse', async () => {
    const { quietFromWords } = await import('../src/schedule-request.js');
    expect(quietFromWords('Don’t message me before 7:00 AM or after 9:00 PM.')).toBe('21:00-07:00');
    expect(quietFromWords('Set quiet hours for me: no messages before 7:00 AM or after 9:00 PM.')).toBe('21:00-07:00');
    expect(quietFromWords('no messages after 9pm or before 7am')).toBe('21:00-07:00');
    expect(quietFromWords('Don’t message me between 10pm and 6am. I work some nights.')).toBe('22:00-06:00');
    expect(quietFromWords('Set a daily 9:00 AM check')).toBeNull();
  });

  it('the quiet_hours tool uses the person\'s window over a model\'s inverted one', async () => {
    const { workTools } = await import('../src/tools/work.js');
    const prev = process.env.MWA_QUIET_HOURS; delete process.env.MWA_QUIET_HOURS;
    const prevCfg = process.env.MWA_CONFIG_PATH;
    const dir = mkdtempSync(join(tmpdir(), 'mwa-quiet-'));
    process.env.MWA_CONFIG_PATH = join(dir, 'mwa.config.json');
    try {
      const tool = workTools({ enabled: true, pendingScheduled: async () => [] } as never).find((t) => t.def.name === 'quiet_hours')!;
      const out = await tool.handler({ set: '07:00-21:00' }, { sandboxDir: dir, interactive: true, personId: 'maya', personMessage: 'Don’t message me before 7:00 AM or after 9:00 PM.' } as never);
      expect(out).toMatch(/quiet hours set to 21:00.07:00/);
    } finally {
      if (prev === undefined) delete process.env.MWA_QUIET_HOURS; else process.env.MWA_QUIET_HOURS = prev;
      if (prevCfg === undefined) delete process.env.MWA_CONFIG_PATH; else process.env.MWA_CONFIG_PATH = prevCfg;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a request for later answered NOW, with no listing, is pushed to schedule', async () => {
    const { runAgent } = await import('../src/agent.js');
    const { MwaMemory } = await import('../src/awm.js');
    const dir = mkdtempSync(join(tmpdir(), 'mwa-pass1-'));
    const mem = new MwaMemory('pass1', join(dir, 'm.db'));
    const msg = 'Set me up with a daily 7:00 AM plan: today’s appointments, bills due this week, and anything for the kids’ school.';
    let i = 0; const actions = [{ action: 'done', summary: 'Today: no appointments; Ocean State Power $142.37 due Nov 9.' }, { action: 'schedule', kind: 'task', instruction: 'Send a 5-bullet plan', daily_at: '07:00' }, { action: 'done', summary: 'Set.' }];
    const brain = { id: 's', model: 's', price: [0, 0] as [number, number], chat: async (input: any) => {
      if (!String(input.system ?? '').includes('TRUST BOUNDARY')) return { text: '{}', usage: { input: 1, output: 1 } };
      return { text: JSON.stringify(actions[Math.min(i++, actions.length - 1)]), usage: { input: 1, output: 1 } };
    } };
    const prev = process.env.MWA_FAST_CHAT; process.env.MWA_FAST_CHAT = '0';
    try {
      const r = await runAgent({ instruction: msg, userMessage: msg, dir, memory: mem as any, brain, worker: brain, interactive: true, plan: false, budget: { maxSteps: 6, maxWallMs: 20_000 } } as any);
      expect(r.history.join('\n')).toMatch(/nothing scheduled for a later request/);
      expect((await mem.pendingScheduled())[0]?.recur).toBe('daily:07:00');
    } finally {
      if (prev === undefined) delete process.env.MWA_FAST_CHAT; else process.env.MWA_FAST_CHAT = prev;
      mem.close(); rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('a job\'s sources and outcomes', () => {
  const TOOLS = ['gmail__search_email', 'calendar__list_events', 'web__open_page'];
  it('drafting an email is not reading one', () => {
    expect(unreadSources('Open https://billing.example/invoices and, for any invoice 3+ days overdue, draft a polite payment reminder email to the client', TOOLS, new Set(['web__open_page']))).toEqual([]);
    expect(unreadSources('Check my inbox for new emails from clients', TOOLS, new Set())).toEqual(['email']);
  });

  const fire = async (task: Record<string, unknown>, run: Record<string, unknown>) => {
    const outRoot = mkdtempSync(join(tmpdir(), 'mwa-carryf-'));
    const fired: { outcome?: string }[] = [];
    try {
      await tickScheduler({
        memory: { async pendingScheduled() { return [task]; }, async completeScheduled() { /* */ }, async rescheduleTask() { /* */ }, async setJobLastRun() { /* */ }, async setPendingComplete() { /* */ } } as never,
        brain: {} as never, worker: {} as never, outRoot, now: () => 10_000, checksAllowed: false, onFire: async (_t, r) => { fired.push(r); },
        runAgent: (async () => ({ reason: 'done', steps: 2, toolCalls: 1, costUsd: 0, durationMs: 0, ...run })) as never,
      });
    } finally { rmSync(outRoot, { recursive: true, force: true }); }
    return fired;
  };
  const WATCH = { id: 'w1234567', instruction: 'Check the rose price', due: 1, recur: 'daily:07:00', deliver: 'changed' };
  it('a watch\'s first reading under "only tell me when it changes" is quiet, even called complete', async () => {
    expect(await fire(WATCH, { summary: 'Standard roses are $1.10 per stem.', outcome: 'complete', watchValue: '$1.10 per stem' })).toHaveLength(0);
    expect(await fire(WATCH, { summary: 'Standard roses are $1.10 per stem.', outcome: 'changed', watchValue: '$1.10 per stem' })).toHaveLength(0);
  });
  it('a job with a finished-when condition may still complete on its first look', async () => {
    const fired = await fire({ ...WATCH, until: 'the package shows Delivered', deliver: undefined }, { summary: 'Delivered.', outcome: 'complete', watchValue: 'Delivered' });
    expect(fired[0]?.outcome).toBe('complete');
  });
});
