import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimsIn, unbackedClaims, unbackedNote, unbackedNudge, asksOnly, type ClaimKind } from '../src/claim-check.js';
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
const did = (...k: ClaimKind[]) => new Set<ClaimKind>(k);

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
      ["I've saved the following to `notes.md`: milk, eggs.", 'write'],
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
    ]) expect(kinds(s), s).toEqual([]);
  });

  it('"set up" is a schedule only with a scheduling noun', () => {
    for (const s of ["I've set up the project with a `package.json` and an `index.js`.", 'I set up a virtual environment and installed the dependencies.', "I've set up the Gmail connector.", "I've arranged the photos into folders by year."]) {
      expect(kinds(s), s).not.toContain('schedule');
    }
  });
});

describe('what backs a claim', () => {
  it('a schedule claim needs a schedule or an outside action; a send, an outside action; a write, any change', () => {
    expect(unbackedClaims("I've scheduled it for later.", did('write'))).toEqual(['schedule']);
    expect(unbackedClaims("I've scheduled it for later.", did('schedule'))).toEqual([]);
    expect(unbackedClaims("I've scheduled the meeting with Dana for Thursday at 10am.", did('send'))).toEqual([]); // a calendar tool
    expect(unbackedClaims("I've queued the newsletter to go out at 9am.", did('send'))).toEqual([]);
    expect(unbackedClaims("I've sent the message to the #ops channel.", did('send'))).toEqual([]);
    expect(unbackedClaims("I've set up the project with a `package.json` and an `index.js`.", did('write'))).toEqual([]);
    expect(unbackedClaims("I've emailed Dana the agenda.", did('write'))).toEqual(['send']); // a draft is a write
    expect(unbackedClaims('Nothing to do today.', did())).toEqual([]);
    expect(unbackedNote(['schedule'])).toMatch(/says it scheduled something, but nothing was scheduled/);
  });

  it('the push-back asks for a correct answer, not for the action', () => {
    expect(unbackedNudge(['schedule'])).toMatch(/Correct the answer/);
    expect(unbackedNudge(['schedule'])).not.toMatch(/call `schedule`/);
  });

  it('a request that only asks a question is not checked; one that asks for work is', () => {
    for (const q of ['What do I have scheduled?', 'What did you do overnight?', 'When is the reminder set for', 'Is the report done?']) expect(asksOnly(q), q).toBe(true);
    for (const q of ['Can you schedule a reminder for 9am?', 'Schedule a reminder for 9am.', 'Email Dana the agenda', 'Find the invoice and email it to Dana.']) expect(asksOnly(q), q).toBe(false);
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

async function run(instruction: string, script: Record<string, unknown>[], tools?: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'mwa-bl36-'));
  const mem = new MwaMemory('bl36', join(dir, 'm.db'));
  try {
    const brain = scripted(script);
    return await runAgent({ instruction, dir, memory: mem, brain, worker: brain, interactive: true, tools: tools ? stubTools(tools) : undefined, budget: { maxSteps: 5, maxWallMs: 20_000 } });
  } finally { mem.close(); rmSync(dir, { recursive: true, force: true }); }
}
const prev = process.env.MWA_FAST_CHAT;
beforeAll(() => { process.env.MWA_FAST_CHAT = '0'; });
afterAll(() => { if (prev === undefined) delete process.env.MWA_FAST_CHAT; else process.env.MWA_FAST_CHAT = prev; });

describe('a run whose reply claims work it never did (BL-36)', () => {
  // No file name in the request: a named output file trips the separate "missing output file" check.
  const REMIND = 'Schedule a reminder for tomorrow at 9am to call Dana about the venue.';
  const CLAIM = { action: 'done', summary: "I've scheduled it for tomorrow at 9am, as you asked.", outcome: 'changed' };

  it('the e2e-k5ncb-3 shape: listed the schedule, said it scheduled — pushed back once, then could-not and the person is told', async () => {
    const r = await run(REMIND, [{ action: 'schedule_list' }, CLAIM, CLAIM], { schedule_list: '(nothing scheduled)' });
    // The substance gate alone passed this (a tool was used); the kind check pushed back with the missing action.
    expect(r.history.join('\n')).toMatch(/substance gate: Your answer says you scheduled something in this run, but this run has not done that/);
    expect(r.outcome).toBe('could-not');
    expect(r.outcomeDeclared).toBeUndefined(); // overridden by evidence, so not the model's own word
    expect(r.summary).toMatch(/⚠ Not done: this reply says it scheduled something, but nothing was scheduled/);
  }, 30_000);

  it('pushed back, the model actually schedules: a normal run', async () => {
    const r = await run(REMIND, [{ action: 'schedule_list' }, CLAIM, { action: 'schedule', instruction: 'Remind me to call Dana about the venue', in_minutes: 60 }], { schedule_list: '(nothing scheduled)' });
    expect(r.summary).toMatch(/^Scheduled for/);
    expect(r.summary).not.toMatch(/Not done/);
    expect(r.outcome).not.toBe('could-not');
  }, 30_000);

  it('a real schedule is not flagged', async () => {
    const r = await run('In 1 minute, write a.txt with OK. Schedule it.', [{ action: 'schedule', instruction: 'Write a.txt with exactly OK', in_minutes: 1 }]);
    expect(r.summary).toMatch(/^Scheduled for/);
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
});
