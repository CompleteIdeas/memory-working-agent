/**
 * BL-54 — what the BL-53 second pass found, each traced in the run logs and the store:
 * eight drafts to one person in one run, a draft to an address nothing had shown, a price watch scheduled with
 * no link, and memory that made two answers worse — run records and page snapshots outranking a job's reading,
 * and a morning plan re-learning a stale calendar entry every day.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { draftRefusal, draftKey, addressesIn, EMAIL_DRAFT_TOOL } from '../src/draft-guard.js';
import { subjectOf, latestReadings, namesWebPage, hasLink, atMostDaily, isWatch, asksChangesOnly } from '../src/schedule-request.js';

const stubTools = (names: string[], answer: (name: string, args: Record<string, unknown>) => string) => {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    tools: {
      defs: () => names.map((name) => ({ name, description: name, parameters: { type: 'object', properties: {} } })),
      has: (x: string) => names.includes(x),
      call: async (name: string, args: Record<string, unknown>) => { calls.push({ name, args }); return answer(name, args); },
    } as never,
  };
};

/** A brain whose main loop plays `actions` in order (then the last one again); every side call answers `side`. */
const scripted = (actions: Record<string, unknown>[], side: (system: string) => string = () => '{}') => {
  const systems: string[] = [];
  let i = 0;
  return {
    systems,
    brain: { id: 's', model: 's', price: [0, 0] as [number, number], chat: async (input: { system?: string }) => {
      const system = String(input.system ?? '');
      systems.push(system);
      if (!system.includes('TRUST BOUNDARY')) return { text: side(system), usage: { input: 1, output: 1 } };
      return { text: JSON.stringify(actions[Math.min(i++, actions.length - 1)]), usage: { input: 1, output: 1 } };
    } },
  };
};

const withRun = async <T>(fn: (dir: string, mem: import('../src/awm.js').MwaMemory) => Promise<T>): Promise<T> => {
  const { MwaMemory } = await import('../src/awm.js');
  const dir = mkdtempSync(join(tmpdir(), 'mwa-bl54-'));
  const mem = new MwaMemory('bl54', join(dir, 'm.db'));
  const prev = process.env.MWA_FAST_CHAT; process.env.MWA_FAST_CHAT = '0';
  try { return await fn(dir, mem); } finally {
    if (prev === undefined) delete process.env.MWA_FAST_CHAT; else process.env.MWA_FAST_CHAT = prev;
    mem.close(); rmSync(dir, { recursive: true, force: true });
  }
};

describe('an email draft', () => {
  const seen = new Set(['dana@ledgerline.example', 'aisha.nguyen@mail.example']);
  it('goes to an address, not a name', () => {
    expect(draftRefusal({ to: 'Aisha Nguyen', body: 'x' }, seen, new Set())).toMatch(/needs the recipient's email ADDRESS, and "Aisha Nguyen" is not one/);
    expect(draftRefusal({ body: 'x' }, seen, new Set())).toMatch(/needs the recipient's email ADDRESS\./);
  });
  it('goes only to an address the run met — a guessed one is refused, in to or cc', () => {
    expect(draftRefusal({ to: 'aisha.nguyen@example.com', body: 'x' }, seen, new Set())).toMatch(/aisha\.nguyen@example\.com does not appear/);
    expect(draftRefusal({ to: 'Aisha <Aisha.Nguyen@mail.example>', body: 'x' }, seen, new Set())).toBeNull();
    expect(draftRefusal({ to: 'dana@ledgerline.example', cc: 'boss@ledgerline.example', body: 'x' }, seen, new Set())).toMatch(/boss@ledgerline\.example does not appear/);
    expect(draftRefusal({ to: 'dana@ledgerline.example', bcc: 'boss@ledgerline.example', body: 'x' }, seen, new Set())).toMatch(/boss@ledgerline\.example does not appear/);
  });
  it('reads recipients in any shape a model gives them', () => {
    expect(draftRefusal({ to: ['dana@ledgerline.example'] }, seen, new Set())).toBeNull();
    expect(draftRefusal({ to: [{ name: 'Dana', email: 'dana@ledgerline.example' }] }, seen, new Set())).toBeNull();
    expect(draftRefusal({ to: [{ email: 'x@guess.example' }] }, seen, new Set())).toMatch(/x@guess\.example does not appear/);
  });
  it('is made once per recipient per run, unless the person asks for versions', () => {
    const drafted = new Set([draftKey({ to: 'dana@ledgerline.example' })]);
    expect(draftRefusal({ to: 'Dana <dana@ledgerline.example>', subject: 'Re: Q3 receipts' }, seen, drafted)).toMatch(/already saved a draft to dana@ledgerline\.example/);
    expect(draftRefusal({ to: 'dana@ledgerline.example' }, seen, drafted, 'Draft two versions for Dana, one short and one formal')).toBeNull();
    expect(draftRefusal({ to: 'aisha.nguyen@mail.example' }, seen, drafted)).toBeNull();
    expect(draftRefusal({ to: 'dana@ledgerline.example' }, seen, drafted, 'Email Dana about the receipts, and send another one about the invoice')).toBeNull();
    // Sending is not drafting again; Outlook's draft tool is covered too.
    expect(draftRefusal({ to: 'dana@ledgerline.example' }, seen, drafted, undefined, 'gmail__send_email')).toBeNull();
    expect(EMAIL_DRAFT_TOOL.test('microsoft__draft_outlook')).toBe(true);
    // The words must be about the draft (review: these lifted the limit).
    for (const m of ['Add a second reminder to the list', 'Also, on a separate note, the invoice is late', 'Fix the second paragraph'])
      expect(draftRefusal({ to: 'dana@ledgerline.example' }, seen, drafted, m), m).toMatch(/already saved a draft/);
  });
  it('reads addresses from any text', () => {
    expect(addressesIn('From: Dana <Dana@Ledgerline.example>, cc ops@x.co.uk')).toEqual(['dana@ledgerline.example', 'ops@x.co.uk']);
  });

  it('in a run: eight tries become one draft, and a guessed address never reaches the mailbox', async () => {
    await withRun(async (dir, mem) => {
      const { runAgent } = await import('../src/agent.js');
      const { calls, tools } = stubTools(['gmail__search_email', 'gmail__draft_email'], (name) => name === 'gmail__search_email'
        ? 'From: Dana Whitcomb <dana@ledgerline.example> Subject: Q3 receipts — could you send them by Friday Nov 13?'
        : 'Draft saved in Drafts. It has NOT been sent.');
      const drafts = Array.from({ length: 8 }, (_, i) => ({ action: 'gmail__draft_email', to: 'dana@ledgerline.example', subject: `Q3 receipts ${i}`, body: 'When do you need them by?' }));
      const { brain } = scripted([{ action: 'gmail__search_email', query: 'accountant Q3' }, { action: 'gmail__draft_email', to: 'dana@ledgerlines.example', subject: 'Q3', body: 'x' }, ...drafts, { action: 'done', summary: 'It is in Drafts.' }]);
      const msg = 'Can you ask my accountant when they need the Q3 receipts by?';
      const r = await runAgent({ instruction: msg, userMessage: msg, dir, memory: mem, brain, worker: brain, tools, interactive: true, plan: false, budget: { maxSteps: 14, maxWallMs: 30_000 } } as never);
      const made = calls.filter((c) => c.name === 'gmail__draft_email');
      expect(made.map((c) => c.args.to)).toEqual(['dana@ledgerline.example']);
      // A run that made its draft is done, not stuck: the repeats end it (review: it had ended could-not).
      expect(r.reason).toBe('done');
      expect(r.outcome).not.toBe('could-not');
    });
  }, 60_000);

  const guess = async (actions: Record<string, unknown>[], answer: (name: string, args: Record<string, unknown>) => string) => withRun(async (dir, mem) => {
    const { runAgent } = await import('../src/agent.js');
    const { calls, tools } = stubTools(['gmail__search_email', 'gmail__draft_email', 'write_file', 'read_file'], answer);
    const { brain } = scripted([...actions, { action: 'done', summary: 'ok' }]);
    const msg = 'Draft the quote reply to Aisha';
    await runAgent({ instruction: msg, userMessage: msg, dir, memory: mem, brain, worker: brain, tools, interactive: true, plan: false, budget: { maxSteps: 8, maxWallMs: 30_000 } } as never);
    return calls.filter((c) => c.name === 'gmail__draft_email').length;
  });
  it('a guess does not become "seen" by searching for it, saving it, or a failed call', async () => {
    const DRAFT = { action: 'gmail__draft_email', to: 'aisha.nguyen@example.com', subject: 'Quote', body: 'x' };
    // A search that echoes its own query.
    expect(await guess([{ action: 'gmail__search_email', query: 'to:aisha.nguyen@example.com' }, DRAFT],
      (n, a) => n === 'gmail__search_email' ? `No messages matched "${a.query}".` : 'Draft saved.')).toBe(0);
    // Remembered, then recalled, in the same run.
    expect(await guess([{ action: 'remember', concept: 'Aisha email', fact: 'Aisha is aisha.nguyen@example.com' }, { action: 'recall', query: 'Aisha email address' }, DRAFT], () => 'Draft saved.')).toBe(0);
    // A file the run wrote, read back (review: write a guess, read it, "seen").
    expect(await guess([{ action: 'write_file', path: 'notes.txt', content: 'aisha.nguyen@example.com' }, { action: 'read_file', path: 'notes.txt' }, DRAFT],
      (n) => n === 'read_file' ? 'aisha.nguyen@example.com' : 'ok')).toBe(0);
    // A search for an address that comes back as a real sender counts (review: the echo rule refused it).
    expect(await guess([{ action: 'gmail__search_email', query: 'from:aisha.nguyen@mail.example' }, { ...DRAFT, to: 'aisha.nguyen@mail.example' }],
      (n) => n === 'gmail__search_email' ? 'id m3 | From: Aisha Nguyen <aisha.nguyen@mail.example> | Subject: Wedding flowers' : 'Draft saved.')).toBe(1);
    // The control: an address a search really returned.
    expect(await guess([{ action: 'gmail__search_email', query: 'Aisha wedding' }, { ...DRAFT, to: 'aisha.nguyen@mail.example' }],
      (n) => n === 'gmail__search_email' ? 'From: Aisha Nguyen <aisha.nguyen@mail.example> Subject: Wedding flowers' : 'Draft saved.')).toBe(1);
  }, 90_000);
  it('an address in a standing preference or the job\'s own request counts as seen', async () => {
    await withRun(async (dir, mem) => {
      const { runAgent } = await import('../src/agent.js');
      const { calls, tools } = stubTools(['gmail__draft_email'], () => 'Draft saved.');
      const { brain } = scripted([{ action: 'gmail__draft_email', to: 'client@acme.example', cc: 'amy@okafor.example', subject: 'Invoice', body: 'x' }, { action: 'done', summary: 'ok' }]);
      await runAgent({ instruction: 'Draft the overdue reminder', dir, memory: mem, brain, worker: brain, tools, interactive: false, plan: false, jobId: 'job12345', jobRecur: 'daily:09:00',
        jobRequest: 'Each morning draft a reminder to client@acme.example for any overdue invoice', budget: { maxSteps: 4, maxWallMs: 20_000 } } as never);
      expect(calls).toHaveLength(0); // amy@ is in nothing yet
      // Enough unrelated memories that recall would not bring the preference back by itself (review).
      for (let i = 0; i < 15; i++) await mem.write(`Overdue invoice note ${i}`, `Invoice #${1000 + i} overdue reminder drafted for client ${i}.`, ['topic=world'], { canonical: true });
      await mem.savePolicy('Always cc amy@okafor.example on client emails');
      const again = scripted([{ action: 'gmail__draft_email', to: 'client@acme.example', cc: 'amy@okafor.example', subject: 'Invoice', body: 'x' }, { action: 'done', summary: 'ok' }]);
      const policies = await mem.listPolicies();
      await runAgent({ instruction: 'Draft the overdue reminder', dir, memory: mem, brain: again.brain, worker: again.brain, tools, interactive: false, plan: false, jobId: 'job12345', jobRecur: 'daily:09:00',
        jobRequest: 'Each morning draft a reminder to client@acme.example for any overdue invoice', budget: { maxSteps: 4, maxWallMs: 20_000 } } as never);
      expect(policies.join(' ')).toMatch(/amy@okafor\.example/); // the preference is in place
      expect(calls).toHaveLength(1);
    });
  }, 60_000);
});

describe('a job that checks a web page', () => {
  it('is recognised by what it names', () => {
    expect(namesWebPage("Set a daily 7:00 AM check of Bloomfield Wholesale's price page")).toBe(true);
    expect(namesWebPage('Check the flight status page every evening')).toBe(true);
    expect(namesWebPage('Send me a 1-page summary of my inbox every morning')).toBe(false);
    expect(namesWebPage('Check my email every morning')).toBe(false);
  });
  it('has a link when it carries one, bare or not', () => {
    expect(hasLink('Check https://bloomfield-wholesale.example/prices')).toBe(true);
    expect(hasLink('Check bloomfield-wholesale.example/prices daily')).toBe(true);
    expect(hasLink("Check Bloomfield Wholesale's price page")).toBe(false);
    // A domain is not a link — nor an email address (review: "emails from dana@ledgerline.com" made a brief a watch).
    expect(hasLink('Every morning summarize new emails from dana@ledgerline.com')).toBe(false);
    expect(hasLink('Summarize my Outlook.com inbox')).toBe(false);
    expect(isWatch({ instruction: 'Every morning summarize new emails from dana@ledgerline.com' })).toBe(false);
  });

  const schedule = async (msg: string, instruction: string, extra: Record<string, unknown> = {}) => withRun(async (dir, mem) => {
    const { runAgent } = await import('../src/agent.js');
    const job = { action: 'schedule', kind: 'task', instruction, daily_at: '07:00', ...extra };
    const { brain } = scripted([job, job, { action: 'done', summary: 'Set.' }]);
    const r = await runAgent({ instruction: msg, userMessage: msg, dir, memory: mem, brain, worker: brain, interactive: true, plan: false, budget: { maxSteps: 6, maxWallMs: 20_000 } } as never);
    return { history: r.history.join('\n'), jobs: await mem.pendingScheduled() };
  });
  it('without a link is sent back once to get one, then set as asked', async () => {
    const msg = "Set a daily 7:00 AM check of Bloomfield Wholesale's price page. Only alert me if the standard roses price changes.";
    const { history, jobs } = await schedule(msg, "Check Bloomfield Wholesale's price page for the standard roses price");
    expect(history).toMatch(/schedule refused once: a web-page check with no link/);
    expect(jobs).toHaveLength(1);
  }, 60_000);
  it('with a link, or as a reminder, is set at once', async () => {
    const msg = 'Set a daily 7:00 AM check of https://bloomfield-wholesale.example/prices. Only alert me if the price changes.';
    const linked = await schedule(msg, 'Check https://bloomfield-wholesale.example/prices for the standard roses price');
    expect(linked.history).not.toMatch(/no link/);
    expect(linked.jobs).toHaveLength(1);
    // A reminder — even with the kind left for the harness to settle (review: it was sent back for a link).
    const r = 'Remind me every day at 9 AM to check the order status page';
    const reminded = await schedule(r, 'Check the order status page', { kind: undefined });
    expect(reminded.history).not.toMatch(/no link/);
    expect(reminded.jobs).toHaveLength(1);
  }, 60_000);
  it('is judged on the job\'s own instruction, not everything else in the message', async () => {
    const msg = 'Watch the price page at https://bloomfield-wholesale.example/prices, and every Monday at 7 summarize my inbox for me.';
    const inbox = await schedule(msg, 'Summarize my inbox', { daily_at: '07:00', days: 'mon' });
    expect(inbox.history).not.toMatch(/no link/);
    expect(inbox.jobs).toHaveLength(1);
  }, 60_000);
});

describe('what a check last read', () => {
  const FLIGHT = { instruction: 'Check the Atlantic Air flight 482 status page at https://atlanticair.example/status/482 and message me only if the status has changed.', recur: 'daily:18:00', deliver: 'changed', lastRun: { at: 3, value: 'SCHEDULE CHANGE; departs 8:40 AM', valueAt: 3 } };
  const ROSES = { instruction: 'Check https://bloomfield.example/prices for the standard roses price', recur: 'daily:07:00', deliver: 'changed', lastRun: { at: 5, value: '$1.45 per stem', valueAt: 5 } };
  it('leads with what is watched', () => {
    expect(subjectOf(FLIGHT.instruction)).toBe('the Atlantic Air flight 482 status page at https://atlanticair.example/status/482');
    expect(subjectOf("Check Bloomfield's price page every day at 7:00 AM. Alert me only if it changes.")).toBe("Bloomfield's price page");
    // An abbreviation is not the end of a sentence (review: "the U.S", "Dr").
    expect(subjectOf('Check the U.S. Embassy visa page at https://x.example/visa. Tell me if it changes.')).toBe('the U.S. Embassy visa page at https://x.example/visa');
    expect(subjectOf("Check Dr. Patel's booking page at https://x.example/patel")).toBe("Dr. Patel's booking page at https://x.example/patel");
  });
  it('a watch is set up as one: changes only, a finish condition, or a page by its link — not a brief', () => {
    expect(isWatch({ deliver: 'changed' })).toBe(true);
    expect(isWatch({ until: 'it shows Delivered' })).toBe(true);
    expect(isWatch({ instruction: 'Check the flight status at https://atlanticair.example/482 every evening and tell me' })).toBe(true);
    expect(isWatch({ instruction: 'Create a daily morning plan: appointments, bills, school' })).toBe(false);
    expect(isWatch({ instruction: 'Check new email and calendar items, then send me a brief' })).toBe(false);
  });
  it('"tell me if it changes" asks for changes only; "tell me when it\'s done" does not', () => {
    for (const m of ['Check the price daily and let me know if it changes.', 'Tell me if the standard rose price changes', 'Alert me when it drops below $1'])
      expect(asksChangesOnly(m), m).toBe(true);
    for (const m of ['Tell me when it\'s done', 'Let me know if you have questions', 'Send me the price every morning'])
      expect(asksChangesOnly(m), m).toBe(false);
  });
  it('is shown for a question about the same thing, and only then', () => {
    expect(latestReadings([FLIGHT, ROSES], 'what time does my flight leave tomorrow?')).toEqual([expect.stringMatching(/^the Atlantic Air flight 482 status page .*: SCHEDULE CHANGE; departs 8:40 AM \(read /)]);
    expect(latestReadings([FLIGHT, ROSES], 'What happened with the rose prices?')).toHaveLength(1);
    expect(latestReadings([FLIGHT, ROSES], 'Thanks! What should I keep an eye on this week?')).toEqual([]);
    expect(latestReadings([{ ...FLIGHT, lastRun: undefined }], 'my flight?')).toEqual([]); // no reading yet
    expect(latestReadings([{ ...FLIGHT, recur: undefined }], 'my flight?')).toEqual([]); // not a recurring check
  });
  it('matches what a check watches, not the rest of its instruction, its reading or a year', () => {
    const INVOICES = { instruction: 'Check https://billing.okaforfloral.example/invoices. If any invoice is 3 or more days past due and still unpaid, draft a short polite payment reminder to that client.', recur: 'daily:09:00', deliver: 'changed', lastRun: { at: 1, value: '#1042 Cedar & Vine unpaid, due 2026-11-05' } };
    expect(latestReadings([INVOICES], 'Draft a reply to Aisha with a payment reminder')).toEqual([]);
    expect(latestReadings([INVOICES], 'Has Cedar & Vine paid yet? Anything new in 2026?')).toEqual([]);
    expect(latestReadings([INVOICES], 'Any unpaid invoices?')).toHaveLength(1);
  });
  it('reaches its own person\'s chat about it, fenced and flagged, without tainting the run — and no one else\'s', async () => {
    await withRun(async (dir, mem) => {
      const { runAgent } = await import('../src/agent.js');
      await mem.addScheduledTask(FLIGHT.instruction, Date.now() + 3_600_000, { recur: FLIGHT.recur, deliver: 'changed', person: 'tg-2222' });
      const [job] = await mem.pendingScheduled();
      await mem.setJobLastRun(job.id, { at: Date.now() - 60_000, summary: 's', value: 'SCHEDULE CHANGE; departs 8:40 AM', valueAt: Date.now() - 60_000 });
      const ask = async (personId: string, msg: string) => {
        const s = scripted([{ action: 'done', summary: 'ok' }]);
        const r = await runAgent({ instruction: msg, userMessage: msg, dir, memory: mem, brain: s.brain, worker: s.brain, interactive: true, plan: false, personId, budget: { maxSteps: 4, maxWallMs: 20_000 } } as never);
        return { r, main: s.systems.find((x) => x.includes('TRUST BOUNDARY'))! };
      };
      const own = await ask('tg-2222', 'what time does my flight leave tomorrow?');
      expect(own.main).toMatch(/⚠UNTRUSTED — WHAT YOUR SCHEDULED CHECKS LAST READ[^]*⚠ EXTERNAL CONTENT from scheduled_checks[^]*departs 8:40 AM/);
      // Shown as recall shows the same observation: a chat that merely mentions the flight is not tainted
      // (review: "remind me…" became a task, quiet hours were refused).
      expect(own.r.tainted).toBe(false);
      // Another person's chat never sees it (review: a stranger's flight reading reached the wrong Telegram user).
      expect((await ask('tg-1111', 'what time does my flight leave tomorrow?')).main).not.toMatch(/SCHEDULED CHECKS LAST READ/);
      // Nor does a chat on another subject.
      expect((await ask('tg-2222', 'Hello there')).main).not.toMatch(/SCHEDULED CHECKS LAST READ/);
    });
  }, 60_000);
  it('a report job keeps no reading: its "value" is a digest, never an observation or a chat\'s reading', async () => {
    const { tickScheduler } = await import('../src/scheduler.js');
    const outRoot = mkdtempSync(join(tmpdir(), 'mwa-bl54r-'));
    const saved: Record<string, unknown>[] = []; const writes: string[] = [];
    const PLAN = { id: 'plan1234', instruction: 'Create a daily morning plan', due: 1, recur: 'daily:07:00', lastRun: { at: 1, summary: 's', value: 'old digest', valueAt: 1 } };
    try {
      await tickScheduler({
        memory: { enabled: true, async pendingScheduled() { return [PLAN]; }, async completeScheduled() { /* */ }, async rescheduleTask() { /* */ },
          async setJobLastRun(_id: string, rec: Record<string, unknown>) { saved.push(rec); }, async write(_c: string, content: string) { writes.push(content); return 'obs'; }, async supersede() { return 'obs'; } } as never,
        brain: {} as never, worker: {} as never, outRoot, now: () => 10_000, checksAllowed: false, onFire: async () => { /* */ },
        runAgent: (async () => ({ reason: 'done', outcome: 'changed', summary: 'Today: Max dentist Wed 3:30.', watchValue: 'Today: Max dentist Wed 3:30; FitLife renews Sat', steps: 2, toolCalls: 1, costUsd: 0, durationMs: 0 })) as never,
      });
    } finally { rmSync(outRoot, { recursive: true, force: true }); }
    expect(saved[0].value).toBeUndefined();
    expect(saved[0].history).toBeUndefined();
    expect(writes).toEqual([]);
    expect(latestReadings([{ ...PLAN, lastRun: { at: 1, value: 'Max dentist Wed 3:30' } }], "When's Max's dentist? What's in the morning plan?")).toEqual([]);
  });
  it('a daily spec is at most daily', () => {
    expect(atMostDaily('daily:08:00')).toBe(true);
    expect(atMostDaily('daily:08:00@12345')).toBe(true);
    expect(atMostDaily('every:1440')).toBe(true);
    expect(atMostDaily('every:60')).toBe(false);
    expect(atMostDaily(undefined)).toBe(false);
  });
});

describe('what memory keeps from a run', () => {
  it('recall never returns the action log', async () => {
    await withRun(async (_dir, mem) => {
      await mem.logAction({ verb: 'web open page', summary: 'Atlantic Air flight 482 Status: Scheduled Departs: 10:15 AM', effect: 'external', tool: 'web__open_page' });
      await mem.write('Flight to Denver', 'Atlantic Air flight 482 to Denver on Fri Nov 13.', ['topic=world'], { canonical: true });
      const hits = await mem.recall('Atlantic Air flight 482 departs', { limit: 5, full: true });
      expect(hits.some((h) => /^action:/.test(h.concept))).toBe(false);
      expect(hits.some((h) => h.concept === 'Flight to Denver')).toBe(true);
      expect((await mem.recentActions(5)).map((a) => a.verb)).toContain('web open page'); // still the "what I did" log
    });
  }, 60_000);

  const runs = async (opts: Record<string, unknown>, sideAnswer = '{}') => withRun(async (dir, mem) => {
    const { runAgent } = await import('../src/agent.js');
    const { tools } = stubTools(['calendar__list_events'], () => 'Max - dentist cleaning, Wed Nov 11 3:30 PM');
    const { brain, systems } = scripted([{ action: 'calendar__list_events' }, { action: 'done', summary: 'Max: dentist Wed 3:30.' }], () => sideAnswer);
    await runAgent({ dir, memory: mem, brain, worker: brain, tools, plan: false, budget: { maxSteps: 4, maxWallMs: 20_000 }, ...opts } as never);
    // Read from the store itself, not through recall (review: absence by recall proves less).
    const all: { concept: string }[] = await (mem as unknown as { store: { getEngramsByAgent(a: string): Promise<{ concept: string }[]> } }).store.getEngramsByAgent('bl54');
    return { systems, runRecords: all.filter((h) => /^agent run:/.test(String(h.concept))) };
  });
  it('a recurring fire writes no run record, and learns only announced changes', async () => {
    const { systems, runRecords } = await runs({ instruction: 'Create a daily morning plan', jobId: 'job12345', jobRecur: 'daily:07:00', interactive: false });
    expect(runRecords).toEqual([]);
    expect(systems.some((s) => /Extract ONLY CHANGES a source announced/.test(s))).toBe(true);
    expect(systems.some((s) => /Extract ONLY durable facts about the USER/.test(s))).toBe(false);
  }, 60_000);
  it('a chat keeps its run record, named by the person\'s words, not the carried conversation', async () => {
    const msg = 'When is the dentist?';
    const { systems, runRecords } = await runs({ instruction: `Recent conversation so far:\n(1) hi → hello\n\nNew request: ${msg}`, userMessage: msg, interactive: true });
    expect(runRecords.map((h) => h.concept)).toEqual([`agent run: ${msg}`]);
    expect(systems.some((s) => /Extract ONLY durable facts about the USER/.test(s))).toBe(true);
  }, 60_000);

  const changePass = async (concept: string, content: string) => withRun(async (dir, mem) => {
    const { runAgent } = await import('../src/agent.js');
    await mem.write(concept, content, ['topic=agent'], { canonical: true });
    const { tools } = stubTools(['web__open_page'], () => 'Flight 482 departs 8:40 AM');
    const { brain, systems } = scripted([{ action: 'web__open_page', url: 'https://atlanticair.example/482' }, { action: 'done', summary: 'It departs 8:40 AM.' }]);
    const msg = 'Check the flight: when does flight 482 depart?';
    await runAgent({ instruction: msg, userMessage: msg, dir, memory: mem, brain, worker: brain, tools, interactive: true, plan: false, budget: { maxSteps: 4, maxWallMs: 20_000 } } as never);
    return systems.some((s) => /Find any PREVIOUSLY KNOWN fact whose VALUE CHANGED/.test(s));
  });
  it('only a fact is marked as changed — never a run record', async () => {
    expect(await changePass('agent run: Check the flight 482', 'Instruction "Check the flight 482" ended: done. Flight 482 departs 10:15 AM.')).toBe(false);
    expect(await changePass('Flight 482', 'Flight 482 departs 10:15 AM.')).toBe(true); // the control: a fact is weighed
  }, 60_000);
});
