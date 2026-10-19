/**
 * BL-43 — a request to set up later work becomes the right jobs. Measured in BL-40 (all four MWA runs):
 * "Set two reminders …" was never recognised as a request, so the run listed the schedule three times and
 * gave up; when a job was set, the run ended at the first one, so the second reminder was lost; "Thursday
 * at 7:00 PM" was stored as 07:00; and a reminder fired as a task ("I can't sign the slip").
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asksForLater } from '../src/claim-check.js';
import { expectedJobCount, whenMentions, ampmMismatch, friendlyWhen, friendlySchedule } from '../src/schedule-request.js';
import { tickScheduler } from '../src/scheduler.js';
import { workTools } from '../src/tools/work.js';

const prevTz = process.env.TZ;
afterEach(() => { if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz; });

// The person's messages from BL-40, verbatim.
const MAYA_TWO = 'Set two reminders for me: Thursday at 10:00 AM to call Harbor Hotel about the centerpieces, and Friday at 4:00 PM to order ribbon.';
const SAM_TWO = 'Set 2 reminders: Thursday at 7:00 PM to sign Lily’s permission slip, and Friday Nov 13 to pick up the cake for Jess’s birthday dinner.';

describe('recognising a request for later work', () => {
  it('the BL-40 requests that matched nothing now read as requests', () => {
    for (const m of [MAYA_TWO, SAM_TWO,
      'Set a daily 9:00 AM check on https://billing.okaforfloral.example/invoices. If any invoice is unpaid and 3+ days past due, draft a short polite payment reminder.',
      'Good morning. Set a weekday 8:00 AM brief for me: what came in that needs me, ranked most important first.',
      'Good morning—set me up with a short daily plan at 7:00 every morning: today’s appointments, bills due this week.',
      'Also, always warn me before anything auto-renews or is about to charge my card.',
      'Set a daily check at 6pm for this: https://atlanticair.example/status/482. Only message me if the time changes.',
      'Remind me Thursday at 10 to call the bank']) expect(asksForLater(m), m).toBe(true);
  });

  it('still not a noun, a question, a one-off piece of work or a cancel', () => {
    for (const m of ['Make a plan for the wedding', 'Tell me if this email is spam', 'Create a summary of this thread', 'Write a report on last month',
      'Remind me what we decided about the venue', 'What do I have scheduled tomorrow?', 'Cancel the reminder for tomorrow at 9', 'Set the table for 6']) expect(asksForLater(m), m).toBe(false);
  });
});

describe('reading the request', () => {
  it('counts the jobs named outright', () => {
    expect(expectedJobCount(MAYA_TWO)).toBe(2);
    expect(expectedJobCount(SAM_TWO)).toBe(2);
    expect(expectedJobCount('Set three daily checks')).toBe(3);
    expect(expectedJobCount('Remind me tomorrow at 9am to call the bank')).toBe(0);
  });

  it('counts days and times: one job is about two, two jobs about four', () => {
    expect(whenMentions('Remind me tomorrow at 9am to call the bank')).toBe(2);
    expect(whenMentions(MAYA_TWO)).toBe(4);
    expect(whenMentions('Remind me Thursday at 10 and Friday at 4')).toBeGreaterThanOrEqual(2);
  });

  it('a stored hour on the wrong side of noon is caught, a matching or unstated one is not', () => {
    expect(ampmMismatch(SAM_TWO, 7, 0)).toBe('7:00 PM');
    expect(ampmMismatch(SAM_TWO, 19, 0)).toBeNull();
    expect(ampmMismatch('Remind me at 7 to call', 7, 0)).toBeNull(); // no AM/PM said
    expect(ampmMismatch(MAYA_TWO, 16, 0)).toBeNull(); // 4:00 PM, right
    expect(ampmMismatch(MAYA_TWO, 4, 0)).toBe('4:00 PM');
    expect(ampmMismatch('call at 12pm', 12, 0)).toBeNull();
    expect(ampmMismatch('call at 12pm', 0, 0)).toBe('12pm');
  });

  it('reads a time back with its weekday', () => {
    process.env.TZ = 'America/New_York';
    expect(friendlyWhen(Date.UTC(2026, 10, 6, 0, 0))).toBe('Thu 5 Nov 2026 at 7:00 PM');
    expect(friendlySchedule(Date.UTC(2026, 10, 2, 13, 0), 'daily:08:00')).toBe('daily at 8:00 AM, first Mon 2 Nov 2026 at 8:00 AM');
  });
});

describe('a run that sets up jobs', () => {
  const run = async (message: string, actions: Record<string, unknown>[]) => {
    const { runAgent } = await import('../src/agent.js');
    const { MwaMemory } = await import('../src/awm.js');
    const dir = mkdtempSync(join(tmpdir(), 'mwa-bl43-'));
    const mem = new MwaMemory('bl43', join(dir, 'm.db'));
    const prompts: string[] = [];
    let i = 0;
    const brain = { id: 's', model: 's', price: [0, 0] as [number, number], chat: async (input: any) => {
      if (!String(input.system ?? '').includes('TRUST BOUNDARY')) return { text: '{}', usage: { input: 1, output: 1 } };
      prompts.push(String(input.messages?.[0]?.content ?? ''));
      return { text: JSON.stringify(actions[Math.min(i++, actions.length - 1)]), usage: { input: 1, output: 1 } };
    } };
    const nowMs = Date.UTC(2026, 10, 2, 14, 0); // Monday 2 Nov, 09:00 in New York
    const prev = process.env.MWA_FAST_CHAT; process.env.MWA_FAST_CHAT = '0';
    try {
      const r = await runAgent({ instruction: message, userMessage: message, dir, memory: mem as any, brain, worker: brain, interactive: true, plan: false, now: () => nowMs, budget: { maxSteps: 8, maxWallMs: 20_000 } } as any);
      const jobs = await mem.pendingScheduled();
      return { r, jobs, prompts };
    } finally {
      if (prev === undefined) delete process.env.MWA_FAST_CHAT; else process.env.MWA_FAST_CHAT = prev;
      mem.close(); rmSync(dir, { recursive: true, force: true });
    }
  };
  const HARBOR = { action: 'schedule', kind: 'reminder', instruction: 'Call Harbor Hotel about the centerpieces', at: '2026-11-05 10:00' };
  const RIBBON = { action: 'schedule', kind: 'reminder', instruction: 'Order ribbon', at: '2026-11-06 16:00' };
  const DONE = { action: 'done', summary: 'Both reminders are set.' };

  it('two reminders in one message are two jobs, both read back with their weekdays', async () => {
    process.env.TZ = 'America/New_York';
    const { r, jobs, prompts } = await run(MAYA_TWO, [HARBOR, RIBBON, DONE]);
    expect(jobs.map((j) => j.instruction).sort()).toEqual(['Call Harbor Hotel about the centerpieces', 'Order ribbon']);
    expect(jobs.every((j) => j.kind === 'reminder')).toBe(true);
    expect(prompts).toHaveLength(2); // both asked for are set: the run ends there, no extra call for `done`
    expect(r.summary).toMatch(/^Scheduled 2 \(America\/New_York\):/);
    expect(r.summary).toContain('• Thu 5 Nov 2026 at 10:00 AM — reminder "Call Harbor Hotel about the centerpieces"');
    expect(r.summary).toContain('• Fri 6 Nov 2026 at 4:00 PM — reminder "Order ribbon"');
    expect(r.outcome).toBe('changed');
  }, 60_000);

  it('stopping at one of two is pushed back once, with the one that is set named', async () => {
    process.env.TZ = 'America/New_York';
    const { r, jobs, prompts } = await run(MAYA_TWO, [HARBOR, DONE, RIBBON, DONE]);
    expect(jobs).toHaveLength(2);
    expect(r.history.join('\n')).toMatch(/1 of 2 jobs set — asked to set the rest/);
    expect(prompts.some((p) => /The person asked for 2; this run has set 1: "Call Harbor Hotel/.test(p))).toBe(true);
  }, 60_000);

  it('7 PM stored as 07:00 goes back once; the corrected time is kept', async () => {
    process.env.TZ = 'America/New_York';
    const { jobs, prompts } = await run(SAM_TWO, [
      { action: 'schedule', kind: 'reminder', instruction: 'Sign Lily’s permission slip.', at: '2026-11-05 07:00' },
      { action: 'schedule', kind: 'reminder', instruction: 'Sign Lily’s permission slip.', at: '2026-11-05 19:00' },
      { action: 'schedule', kind: 'reminder', instruction: 'Pick up the cake for Jess’s birthday dinner.', at: '2026-11-13 09:00' },
      DONE,
    ]);
    expect(prompts.some((p) => /The person said "7:00 PM", but that job is set for 7:00 AM/.test(p))).toBe(true);
    expect(jobs.map((j) => new Date(j.due).getHours()).sort((a, b) => a - b)).toEqual([9, 19]);
  }, 60_000);

  it('the same job twice in a run is set once', async () => {
    process.env.TZ = 'America/New_York';
    const { jobs } = await run(MAYA_TWO, [HARBOR, { ...HARBOR, instruction: 'Call the Harbor Hotel about centerpieces' }, RIBBON, DONE]);
    expect(jobs).toHaveLength(2);
  }, 60_000);

  it('one job asked for: the run ends at it, as before, and the reply reads it back', async () => {
    process.env.TZ = 'America/New_York';
    const { r, jobs, prompts } = await run('Remind me tomorrow at 9am to call the bank', [{ action: 'schedule', instruction: 'Call the bank', at: '2026-11-03 09:00' }, DONE]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].kind).toBe('reminder'); // worded as a reminder; the model did not say
    expect(prompts).toHaveLength(1);
    expect(r.summary).toBe('Scheduled for Tue 3 Nov 2026 at 9:00 AM (America/New_York): reminder "Call the bank". I\'ll send it to you then.');
  }, 60_000);

  it('a job whose instruction reads as work stays a task, even in a message that says "reminder"', async () => {
    process.env.TZ = 'America/New_York';
    const msg = 'Set a daily 9:00 AM check on https://billing.okaforfloral.example/invoices. If any invoice is unpaid and 3+ days past due, draft a short polite payment reminder.';
    const { jobs } = await run(msg, [{ action: 'schedule', instruction: 'Check https://billing.okaforfloral.example/invoices and draft a polite reminder for any invoice unpaid 3+ days past due.', daily_at: '09:00' }, DONE]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].kind).toBeUndefined();
    expect(jobs[0].recur).toBe('daily:09:00');
  }, 60_000);
});

describe('a reminder fires as a message', () => {
  it('is delivered word for word, with no run and no cost, and a one-off is finished', async () => {
    const outRoot = mkdtempSync(join(tmpdir(), 'mwa-rem-'));
    const fired: { summary: string; steps: number; costUsd: number; outcome?: string }[] = [];
    const ran: unknown[] = []; const done: string[] = [];
    try {
      await tickScheduler({
        memory: { async pendingScheduled() { return [{ id: 'rem12345', instruction: 'Sign Lily’s permission slip.', due: 1, kind: 'reminder' }]; }, async completeScheduled(id: string) { done.push(id); }, async rescheduleTask() { /* */ } } as never,
        brain: {} as never, worker: {} as never, outRoot, now: () => 10_000, checksAllowed: false,
        onFire: async (_t, r) => { fired.push(r); },
        runAgent: (async (o: unknown) => { ran.push(o); return { summary: 'ran', reason: 'done' }; }) as never,
      });
    } finally { rmSync(outRoot, { recursive: true, force: true }); }
    expect(ran).toHaveLength(0);
    expect(fired).toHaveLength(1);
    expect(fired[0].summary).toBe('Reminder: Sign Lily’s permission slip.');
    expect(fired[0].outcome).toBe('changed');
    expect(fired[0].costUsd).toBe(0);
    expect(done).toEqual(['rem12345']);
  });
});

describe('the schedule listing says it only lists', () => {
  it('empty or not, it points at `schedule` for a job that is not there', async () => {
    const tasks: Record<string, unknown>[] = [];
    const mem = { enabled: true, async pendingScheduled() { return tasks; } } as never;
    const list = workTools(mem).find((t) => t.def.name === 'schedule_list')!;
    expect(await list.handler({}, { personId: 'p1' } as never)).toMatch(/call `schedule` to create it — one call per job/);
    tasks.push({ id: 'abcd1234', instruction: 'Order ribbon', due: Date.now() + 3_600_000, person: 'p1', kind: 'reminder' });
    const out = String(await list.handler({}, { personId: 'p1' } as never));
    expect(out).toMatch(/— once — reminder/);
    expect(out).toMatch(/call `schedule` to create it/);
  });
});
