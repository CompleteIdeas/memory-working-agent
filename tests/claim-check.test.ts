import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimsIn, unbackedClaims, unbackedNote, unbackedNudge, asksOnly, requestedKinds, asksForLater } from '../src/claim-check.js';
import { runAgent } from '../src/agent.js';
import type { Provider, ChatResult, ChatInput } from '../src/provider.js';
import { MwaMemory } from '../src/awm.js';

/**
 * BL-36 — a reply that says the work was done when the run did nothing of the kind (2026-10-18).
 * Measured on the 843 labeled harness runs from BL-34: the three known false claims flagged, no other
 * run. The first version was REVISED after an isolated review proved honest replies flagged end to end
 * (passive descriptions, "set up the project", memory saves, other people's actions); those replies are
 * below, verbatim, with the evidence each run would really have.
 */

const kinds = (s: string) => [...claimsIn(s)].sort();

describe('what counts as a claim', () => {
  it('the three measured false claims, word for word', () => {
    expect(kinds("I've scheduled it to be written later, not created now. I found earlier timed writes already waiting, and this new one should follow the same pattern.")).toEqual(['schedule']);
    expect(kinds('I scheduled the task to run later, and I did not create the file now. Based on the record I found, one scheduled write is already due now.')).toEqual(['schedule']);
    expect(kinds("I've set up a later run for the requested file write and did not create the file now. If you want, I can also help you confirm when it's due.")).toEqual(['schedule']);
  });

  it('plain claims of each kind, including the ones the first version missed', () => {
    for (const [s, k] of [
      ['Wrote `notes.txt` with the summary.', 'write'],
      ['Done — I saved a one-line status note in `status.txt`.', 'write'],
      ["I've emailed Dana the agenda so she can prepare.", 'send'],
      ['I sent Dana the agenda.', 'send'],
      ['Sent the agenda to Dana.', 'send'],
      ['Email sent to Dana.', 'send'],
      ["I've scheduled the reminder for next Monday at 9am.", 'schedule'],
      ["I've scheduled a job that will check the site every hour.", 'schedule'],
      ["I've scheduled it to run once a day.", 'schedule'],
      ["I've created a reminder for 9am tomorrow.", 'schedule'],
    ] as const) expect(kinds(s), s).toEqual([k]);
  });

  it('honest failures, offers and questions are not claims', () => {
    for (const s of [
      'I couldn’t verify that this exact file has been scheduled yet.',
      "I can't create or schedule the file from here based on what I found; nothing was scheduled.",
      'I found two scheduled file-creation tasks already in the queue, but I did not find one for e2e-x-2.txt.',
      'If you want, I can schedule it for 9am.',
      'Next step: I can set up a reminder for Monday.',
      'Should I write the summary to report.md?',
    ]) expect(kinds(s), s).toEqual([]);
  });

  it('descriptions — of the past, of other people, of the reply itself — are not claims', () => {
    for (const s of [
      'The weekly meeting is scheduled for Thursday at 10am.',
      'Yes. The reminder is scheduled for 2026-10-19 09:00.',
      'It is scheduled to run every day at 7am.',
      'Daily digest: scheduled for 7:00 every day.',
      'Yes — your reply was sent on Oct 16 at 3:12pm.',
      'The email was sent after you approved it.',
      'The invitation was sent by Dana on Monday.',
      'The file `report.md` was updated on Oct 12 by the nightly export.',
      'notes.txt was created on 2026-10-01.',
      "I created `report.md` yesterday at 3pm; it hasn't changed since.",
      'The file `report.md` was created and contains all four totals.',
      'Dana wrote: "I\'ve sent the invoice and created the report file."',
      "> I've sent the invoice.",
      'I wrote a short poem below: roses are red.',
      "I've saved that preference to my notes.",
      "Got it — I've saved that Dana's email is dana@acme.com.",
      "I've saved a note that the board report is due Friday.",
      'Summary: scheduled file written and verified.',
      'I sent you the summary above.',
      // Second review: the time word sits in another clause than the claim, so it is tested per sentence.
      'Yesterday, I sent Dana the agenda.',
      'Overnight, I sent three replies and scheduled the digest.',
      'On Oct 16, I sent your reply to the supplier.',
      'On October 16th, I wrote `summary.md` for the board.',
      'When you asked on Tuesday, I scheduled the reminder.',
      'Last Friday I emailed the venue.',
      'This morning I saved `notes.md`.',
      // Third review: earlier work, said with a time or an approval.
      'Yes — I sent Dana the invoice; it went out after you approved it.',
      'I sent the invoice to dana@acme.com at 9:14 today, after you approved it.',
      'I sent it this evening.',
      'I emailed the venue on 16 October.',
      'I sent the reply on 10/16.',
      'I wrote `plan.md` in my previous reply.',
      // A code answer is not a file write.
      'I created a `useFetch` hook below.',
      'I created `useFetch` for you:\n```ts\nexport function useFetch() {}\n```',
    ]) expect(kinds(s), s).toEqual([]);
  });

  it('"set up" is a schedule only with a scheduling noun', () => {
    for (const s of ["I've set up the project with a `package.json` and an `index.js`.", 'I set up a virtual environment and installed the dependencies.', "I've set up the Gmail connector.", "I've arranged the photos into folders by year."]) {
      expect(kinds(s), s).not.toContain('schedule');
    }
  });
});

describe('when a claim is judged at all', () => {
  it('only with no action of any kind, a request for that kind of work, and no question', () => {
    const SCHED = "I've scheduled it for tomorrow at 9am.";
    expect(unbackedClaims(SCHED, false, 'Remind me tomorrow at 9am to call Dana')).toEqual(['schedule']);
    expect(unbackedClaims(SCHED, true, 'Remind me tomorrow at 9am to call Dana')).toEqual([]); // any attempt: a cron job, a calendar tool …
    expect(unbackedClaims(SCHED, false, 'What do I have scheduled?')).toEqual([]); // a question: the answer describes
    expect(unbackedClaims(SCHED, false, 'Thanks!')).toEqual([]); // nothing asked: e.g. work approved earlier
    expect(unbackedClaims("I've emailed Dana the agenda.", false, 'Email Dana the agenda for Monday')).toEqual(['send']);
    expect(unbackedClaims("I've emailed Dana the agenda.", false, 'Write the agenda to agenda.md')).toEqual([]); // not what was asked
    expect(unbackedNote(['schedule'])).toMatch(/says it scheduled something, but nothing was scheduled/);
  });

  it('what a message asks for', () => {
    expect([...requestedKinds('In 1 minute, write a file called a.txt. Schedule it to run later.')].sort()).toEqual(['schedule', 'write']);
    expect([...requestedKinds('Reply to Dana and forward it to Sam')]).toEqual(['send']);
    expect([...requestedKinds('Thanks, that looks right')]).toEqual([]);
  });

  it('the push-back asks for a correct answer, not for the action', () => {
    expect(unbackedNudge(['schedule'])).toMatch(/Correct the answer/);
    expect(unbackedNudge(['schedule'])).not.toMatch(/call `schedule`/);
  });

  it('a request that only asks a question is not checked; one that asks for work is', () => {
    for (const q of ['What do I have scheduled?', 'What did you do overnight?', 'When is the reminder set for', 'Is the report done?',
      'did you send dana the invoice', 'Did you send the invoice to Dana? She says she never got it.', 'Has the reminder been scheduled', 'Do you have the agenda', 'Can you check the reminder for tomorrow is set?']) expect(asksOnly(q), q).toBe(true);
    for (const q of ['Can you schedule a reminder for 9am?', 'Schedule a reminder for 9am.', 'Email Dana the agenda', 'Find the invoice and email it to Dana.', 'Do the weekly report']) expect(asksOnly(q), q).toBe(false);
    expect([...claimsIn("I've scheduled it for tomorrow at 9am.")]).toEqual(['schedule']); // a time in a schedule claim is its due time
  });
});

// ---- through the real run loop ----
function scripted(script: Record<string, unknown>[]) {
  let n = 0;
  const brain: Provider = {
    id: 'stub', model: 'stub', price: [0, 0],
    chat: async (input: ChatInput): Promise<ChatResult> => {
      if (!String(input.system ?? '').includes('TRUST BOUNDARY')) return { text: '{}', usage: { input: 1, output: 1 } };
      return { text: JSON.stringify(script[n++] ?? { action: 'done', summary: 'Done.' }), usage: { input: 1, output: 1 } };
    },
  };
  return brain;
}
const stubTools = (results: Record<string, string>) => ({
  defs: () => Object.keys(results).map((name) => ({ name, description: name, parameters: { type: 'object', properties: {} } })),
  has: (x: string) => x in results,
  call: async (name: string) => results[name],
}) as unknown as Parameters<typeof runAgent>[0]['tools'];

async function run(instruction: string, script: Record<string, unknown>[], tools?: Record<string, string>, userMessage?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'mwa-bl36-'));
  const mem = new MwaMemory('bl36', join(dir, 'm.db'));
  try {
    const brain = scripted(script);
    return await runAgent({ instruction, userMessage, dir, memory: mem, brain, worker: brain, interactive: true, tools: tools ? stubTools(tools) : undefined, budget: { maxSteps: 5, maxWallMs: 20_000 } });
  } finally { mem.close(); rmSync(dir, { recursive: true, force: true }); }
}
const prev = process.env.MWA_FAST_CHAT;
beforeAll(() => { process.env.MWA_FAST_CHAT = '0'; });
afterAll(() => { if (prev === undefined) delete process.env.MWA_FAST_CHAT; else process.env.MWA_FAST_CHAT = prev; });

// No file name in the request: a named output file trips the separate "missing output file" check.
const REMIND = 'Schedule a reminder for tomorrow at 9am to call Dana about the venue.';
const CLAIM = { action: 'done', summary: "I've scheduled it for tomorrow at 9am, as you asked.", outcome: 'changed' };

describe('by default the check is a shadow: it corrects in the loop and records, nothing more', () => {
  it('the e2e-k5ncb-3 shape: pushed back once, then recorded — no note, no could-not', async () => {
    const r = await run(REMIND, [{ action: 'schedule_list' }, CLAIM, CLAIM, CLAIM], { schedule_list: '(nothing scheduled)' });
    expect(r.history.join('\n')).toMatch(/substance gate: Your answer says you scheduled something in this run/);
    expect(r.unbackedClaims).toEqual(['schedule']);
    expect(r.history.join('\n')).not.toMatch(/did none/); // recorded in the run log only: end-of-run passes read history
    expect(r.summary).not.toMatch(/Not done/);
    expect(r.outcome).not.toBe('could-not');
  }, 30_000);
});

describe('a run whose reply claims work it never did, enforced (BL-36, MWA_CLAIM_CHECK=enforce)', () => {
  const prevMode = process.env.MWA_CLAIM_CHECK;
  beforeAll(() => { process.env.MWA_CLAIM_CHECK = 'enforce'; });
  afterAll(() => { if (prevMode === undefined) delete process.env.MWA_CLAIM_CHECK; else process.env.MWA_CLAIM_CHECK = prevMode; });

  it('the e2e-k5ncb-3 shape: listed the schedule, said it scheduled — pushed back once, then could-not and the person is told', async () => {
    const r = await run(REMIND, [{ action: 'schedule_list' }, CLAIM, CLAIM, CLAIM], { schedule_list: '(nothing scheduled)' });
    // The substance gate alone passed this (a tool was used); the kind check pushed back with the missing action.
    expect(r.history.join('\n')).toMatch(/substance gate: Your answer says you scheduled something in this run, but this run has not done that/);
    expect(r.outcome).toBe('could-not');
    expect(r.outcomeDeclared).toBeUndefined(); // overridden by evidence, so not the model's own word
    expect(r.summary).toMatch(/⚠ Not done: this reply says it scheduled something, but nothing was scheduled/);
  }, 30_000);

  it('pushed back, the model actually schedules: a normal run', async () => {
    const r = await run(REMIND, [{ action: 'schedule_list' }, CLAIM, { action: 'schedule', instruction: 'Remind me to call Dana about the venue', in_minutes: 60 }], { schedule_list: '(nothing scheduled)' });
    expect(r.summary).toMatch(/Scheduled for/); // BL-43: the run goes on to the model's done; the read-back follows its words
    expect(r.summary).not.toMatch(/Not done/);
    expect(r.outcome).not.toBe('could-not');
  }, 30_000);

  it('a real schedule is not flagged', async () => {
    const r = await run('In 1 minute, write a.txt with OK. Schedule it.', [{ action: 'schedule', instruction: 'Write a.txt with exactly OK', in_minutes: 1 }]);
    expect(r.summary).toMatch(/Scheduled for/); // BL-43: the run goes on to the model's done; the read-back follows its words
    expect(r.summary).not.toMatch(/Not done/);
    expect(r.outcome).not.toBe('could-not');
  }, 30_000);

  it('a write the run really made is not flagged', async () => {
    const r = await run('Write a.txt with HELLO', [{ action: 'write_file', path: 'a.txt', content: 'HELLO' }, { action: 'done', summary: 'Wrote `a.txt` with HELLO.' }], { write_file: 'wrote a.txt (5 bytes)' });
    expect(r.summary).not.toMatch(/Not done/);
    expect(r.outcome).toBe('changed');
  }, 30_000);

  it('a send claim repeated after the push-back is could-not even though the model declares changed', async () => {
    const SENT = { action: 'done', summary: "I've emailed Dana the agenda.", outcome: 'changed' };
    const r = await run('Email Dana the agenda for Monday', [SENT, SENT]);
    expect(r.outcome).toBe('could-not');
    expect(r.summary).toMatch(/says it sent something, but nothing was sent/);
  }, 30_000);

  // The second review's production shapes. None may be flagged.
  const SENT_EARLIER = { action: 'done', summary: 'I sent the agenda to Dana at 3:04 PM.' };
  it('a wrapped chat turn is judged by the person’s own words: a question is not checked', async () => {
    const wrapped = 'Recent conversation so far:\nYou: email Dana the agenda\nMWA: Staged for your approval.\n\nNew message: Did you send it?\n\n(Reply in plain text; this is Telegram.)';
    const r = await run(wrapped, [SENT_EARLIER], undefined, 'Did you send it?');
    expect(r.summary).not.toMatch(/Not done/);
  }, 30_000);

  it('work approved earlier (it ran outside this run) and a plain "Thanks!" is not checked', async () => {
    const r = await run('Thanks!', [SENT_EARLIER], undefined, 'Thanks!');
    expect(r.summary).not.toMatch(/Not done/);
  }, 30_000);

  it('a schedule made another way (a cron job via a command) is an action: not checked', async () => {
    const r = await run('Schedule a nightly backup of my notes at 2am', [{ action: 'run_command', command: 'crontab -l' }, { action: 'done', summary: "I've scheduled a nightly cron job for 2am." }], { run_command: 'ok' });
    expect(r.summary).not.toMatch(/Not done/);
  }, 30_000);
});

// ---- BL-19: a request for later work that never gets scheduled ----
describe('a request to set up LATER work (BL-19)', () => {
  it('only a request, in the person’s own words — not a noun, a pasted time, a recap or a cancel', () => {
    for (const m of ['In 1 minute, write a file called e2e-x-1.txt whose contents are exactly OK. Schedule it to run later — do not create the file now.',
      'Remind me tomorrow at 9am to call the bank', 'Every morning, summarize my inbox', 'Schedule a weekly report for Mondays', 'Remind me to call Dana in 2 hours',
      // Review 2's misses: a job that deletes, "stop" inside the task, hourly, "in an hour", an apostrophe, "set a reminder for".
      'Every day at 9, delete old files from Downloads', 'Remind me to stop by the store at 5', 'Remind me every hour to stretch', 'Remind me in an hour to call Sam', "I'd like you to schedule it in 5 minutes, that's all", 'Set a reminder for 5pm to call Dana']) expect(asksForLater(m), m).toBe(true);
    for (const m of ['What do I have scheduled tomorrow?', 'Write notes.md with the summary', 'Did the reminder run?', 'Summarize this later if you can',
      // The first version's false triggers (review): each one PROVED to create an unwanted job.
      'Remind me what we decided about the venue', 'Remind me how the backup script works', 'Summarize the schedule for the conference',
      'Read schedule.csv and total the hours', 'Write the shift schedule to schedule.md', "Summarize this email: 'The review moved to Thursday at 3pm, please confirm.'",
      'Draft a reply confirming our call at 2pm', 'Cancel the reminder for tomorrow at 9', 'Stop the every morning inbox summary', 'Sum every 5 rows of data.csv',
      'Look at the schedule my coach made and list conflicts', 'Email Dana my schedule this week']) expect(asksForLater(m), m).toBe(false);
  });

  const LATER = 'In 1 minute, write a file called e2e-x-1.txt whose contents are exactly CHECK-OK. Schedule it to run later — do not create the file now.';
  const GAVE_UP = { action: 'done', summary: "I couldn't confirm that e2e-x-1.txt has been scheduled yet; I did not create the file now." };
  const SCHED = { action: 'schedule', instruction: 'Write file e2e-x-1.txt with exactly CHECK-OK', in_minutes: 1 };
  const LIST = { schedule_list: '(2 scheduled: e2e-w-0.txt, e2e-w-1.txt)' };

  it('the measured dead end — listed the schedule, could not confirm, stopped — is pushed to schedule, and the push is logged', async () => {
    const r = await run(LATER, [{ action: 'schedule_list' }, GAVE_UP, SCHED], LIST, LATER);
    expect(r.history.join('\n')).toMatch(/nothing scheduled for a later request/);
    expect(r.summary).toMatch(/Scheduled for/); // BL-43: the run goes on to the model's done; the read-back follows its words
  }, 30_000);

  it('the dead end as measured with the action trail — listing again and again, never `done` — is pushed too', async () => {
    // e2e-j1gxe-1: ["schedule_list","schedule_list","schedule_list"], ended by the "repeating after output ⇒ finished" shortcut.
    const r = await run(LATER, [{ action: 'schedule_list' }, { action: 'schedule_list' }, { action: 'schedule_list' }, SCHED], LIST, LATER);
    expect(r.history.join('\n')).toMatch(/nothing scheduled for a later request/);
    expect(r.summary).toMatch(/Scheduled for/); // BL-43: the run goes on to the model's done; the read-back follows its words
  }, 30_000);

  it('after the push, the file check still speaks — telling it to schedule, not to write now', async () => {
    const r = await run(LATER, [{ action: 'schedule_list' }, GAVE_UP, GAVE_UP, SCHED], LIST, LATER);
    expect(r.history.filter((h) => /nothing scheduled for a later request/.test(h))).toHaveLength(1);
    expect(r.history.join('\n')).toMatch(/rejected premature done — missing output file/);
    expect(r.summary).toMatch(/Scheduled for/); // BL-43: the run goes on to the model's done; the read-back follows its words
  }, 30_000);

  it('a repeated read elsewhere does not spend the push (review 2)', async () => {
    const r = await run(LATER, [{ action: 'read_file', path: 'a.txt' }, { action: 'read_file', path: 'a.txt' }, { action: 'schedule_list' }, GAVE_UP, SCHED], { ...LIST, read_file: '(no such file yet)' }, LATER);
    expect(r.history.join('\n')).toMatch(/nothing scheduled for a later request/);
    expect(r.summary).toMatch(/Scheduled for/); // BL-43: the run goes on to the model's done; the read-back follows its words
  }, 30_000);

  it('naming the job that already is this request is accepted — not pushed twice toward a duplicate (review 2)', async () => {
    const DUP = { action: 'done', summary: 'Job e2e-x-1 at 00:31 in the list already is this request; nothing new to schedule.' };
    const r = await run(LATER, [{ action: 'schedule_list' }, DUP, DUP, DUP], LIST, LATER);
    expect(r.history.filter((h) => /rejected premature done|nothing scheduled for a later request/.test(h))).toHaveLength(2); // the push, then one file check
    expect(r.summary).toMatch(/already is this request/);
  }, 30_000);

  it('no push on wording alone: the run must have listed the schedule (the measured signature)', async () => {
    const r = await run('Remind me tomorrow at 9am to call the bank', [{ action: 'done', summary: 'Noted — I will remind you.' }], undefined, 'Remind me tomorrow at 9am to call the bank');
    expect(r.history.join('\n')).not.toMatch(/nothing scheduled for a later request/);
  }, 30_000);

  it('not once something was set up another way (a calendar tool), nor for a request that is not for later', async () => {
    const cal = await run('Remind me tomorrow at 9am to call the bank', [{ action: 'schedule_list' }, { action: 'gcal__create_event' }, { action: 'done', summary: 'Added a 9am reminder to your calendar.' }], { schedule_list: '(nothing scheduled)', gcal__create_event: 'created event' }, 'Remind me tomorrow at 9am to call the bank');
    expect(cal.history.join('\n')).not.toMatch(/nothing scheduled for a later request/);
    const q = await run('What is on the schedule?', [{ action: 'schedule_list' }, { action: 'done', summary: 'Two jobs: e2e-w-0 and e2e-w-1.' }], LIST, 'What is on the schedule?');
    expect(q.history.join('\n')).not.toMatch(/nothing scheduled for a later request/);
  }, 30_000);

});
