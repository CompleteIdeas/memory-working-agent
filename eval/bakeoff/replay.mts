// Model bake-off, judgement tasks: questions from the BL-53 assessment, each on a copy of the assessed cell's store
// rolled back to the moment it was asked, with the conversation it carried rebuilt from that cell's transcript and
// delivered job results, and tools answering what the eval world held then. Runs INSIDE an MWA image (its own code
// at /app/src). The model is whatever MWA_MODEL names. One JSON line per trial on stdout.
//   node --import tsx /b/replay.mts <scenario> <trials>     (stores in /stores, assessed cells in /r)
import { readFileSync, mkdtempSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runAgent } from '/app/src/agent.ts';
import { MwaMemory } from '/app/src/awm.ts';
import { getProvider } from '/app/src/provider.ts';
import { RoutedProvider } from '/app/src/model-router.ts';
import { markMcpReadOnly } from '/app/src/tools/governance.ts';

type Tools = Record<string, (a: Record<string, unknown>) => string>;
interface Scenario { store: string; cell: string; at: string; msg?: string; job?: RegExp; tools: Tools }

const DANA = 'From: Dana Whitcomb <dana@ledgerline.example>\nSubject: Q3 receipts\n\nHi Maya, could you send me your Q3 receipts (July to September) by Friday Nov 13? I need them to finish your quarterly filing. A shared folder or photos are both fine.\n\nDana\nLedgerline Accounting';
const MOVE = "From: Bright Smile Dental <frontdesk@brightsmile.example>\nSubject: Max's appointment has moved\n\nHi Sam, Dr. Patel is out on Wednesday, so we have moved Max's cleaning from Wednesday November 11 at 3:30 PM to Thursday November 12 at 4:00 PM. Reply if that doesn't work.";
const MOVE_ROW = "id s04 | Tue 2026-11-03 11:00 | From: Bright Smile Dental <frontdesk@brightsmile.example> | Subject: Max's appointment has moved";
const aboutDentist = (a: Record<string, unknown>) => /dent|max|bright|smile|appoint|clean/i.test(String(a.query ?? ''));

const S: Record<string, Scenario> = {
  // Sam's morning plan firing on Tue Nov 10: the calendar still shows Wednesday 3:30; the move (Nov 3) comes back only
  // to a search for it, and is in memory as a change an earlier run learned (BL-56).
  plan: {
    store: 'sam-plan-bl56.db', cell: 'sam-mwa', at: '2026-11-10T12:00:00Z', job: /morning plan/i,
    tools: {
      calendar__list_events: () => "e3 | Wed 2026-11-11 15:30–16:15 | Max - dentist cleaning\ne4 | Thu 2026-11-12 08:30–14:30 | Lily - zoo field trip\ne5 | Fri 2026-11-13 10:15–12:40 | Fly to Denver (AA 482)\ne6 | Sat 2026-11-14 19:00–21:30 | Jess's birthday dinner - Gracie's",
      gmail__search_email: (a) => aboutDentist(a) ? MOVE_ROW : [
        'id s05 | Wed 2026-11-04 09:00 | From: Ocean State Power <billing@oceanstatepower.example> | Subject: Autopay failed',
        'id s07 | Thu 2026-11-05 19:00 | From: FitLife Gym <members@fitlife.example> | Subject: Your membership renews soon',
        'id s09 | Mon 2026-11-09 12:00 | From: Brookside Elementary <office@brookside.example> | Subject: Picture day Thursday'].join('\n'),
      gmail__read_email: (a) => String(a.id) === 's04' ? MOVE
        : String(a.id) === 's05' ? 'We could not process your automatic payment of $142.37: the card on file has expired. Please pay by November 9 to avoid a $15 late fee.'
        : String(a.id) === 's07' ? 'Your annual FitLife membership renews automatically on November 14, 2026 at $480 (last year $420).'
        : 'Reminder: school picture day is Thursday November 12 (the same day as the Grade 4 trip). Students should wear their uniform.',
    },
  },
  // Asked Thu Nov 12 at 12:00: the flight watch read 8:40 on Nov 10; the calendar still says 10:15.
  flight: {
    store: 'sam-flight-new.db', cell: 'sam-mwa', at: '2026-11-12T17:00:00Z', msg: 'what time does my flight leave tomorrow?',
    tools: {
      calendar__list_events: () => 'e5 | Fri 2026-11-13 10:15–12:40 | Fly to Denver (Atlantic Air AA 482)',
      gmail__search_email: () => 'No messages found.',
      gmail__read_email: () => 'No message with that id.',
      web__open_page: () => 'Atlantic Air flight 482 | PVD to DEN | Friday Nov 13, 2026 Status: SCHEDULE CHANGE Departs: 8:40 AM | Arrives: 11:05 AM (local) Gate: TBD',
    },
  },
  // Asked Wed Nov 11 at 7:30: the calendar shows today 3:30; the dentist's email moved it to Thursday 4:00.
  dentist: {
    store: 'sam-dentist-new.db', cell: 'sam-mwa', at: '2026-11-11T12:30:00Z', msg: 'When’s Max’s dentist appointment again?',
    tools: {
      calendar__list_events: () => 'e3 | Wed 2026-11-11 15:30–16:15 | Max - dentist cleaning @ Bright Smile Dental',
      gmail__search_email: (a) => aboutDentist(a) ? MOVE_ROW : 'No messages found.',
      gmail__read_email: () => MOVE,
    },
  },
  // Asked Fri Nov 13: the accountant's email already gives the date. One draft at most, to her real address.
  dana: {
    store: 'maya-dana.db', cell: 'maya-mwa', at: '2026-11-13T16:00:00Z', msg: 'Can you ask my accountant when they need the Q3 receipts by?',
    tools: {
      gmail__search_email: () => 'id m07 | Tue 2026-11-03 09:12 | From: Dana Whitcomb <dana@ledgerline.example> | Subject: Q3 receipts',
      gmail__read_email: () => DANA,
      gmail__draft_email: (a) => `Draft saved in Drafts (id d${Math.random().toString(36).slice(2, 8)}) to ${a.to}. It has NOT been sent.`,
      calendar__list_events: () => 'No events.',
    },
  },
};

const DESC: Record<string, string> = {
  gmail__search_email: 'Search the mailbox. Returns id | date | from | subject lines.', gmail__read_email: 'Read one email by id.',
  gmail__draft_email: 'Create a draft email in the Drafts folder. It is NOT sent.', calendar__list_events: 'List calendar events.',
  web__open_page: 'Open a web page by URL and return its text.',
};
const PARAMS: Record<string, Record<string, unknown>> = {
  gmail__draft_email: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } },
  gmail__search_email: { query: { type: 'string' } }, gmail__read_email: { id: { type: 'string' } }, web__open_page: { url: { type: 'string' } },
};

const [name, trialsArg] = process.argv.slice(2);
const sc = S[name];
if (!sc) { console.error(`unknown scenario ${name}`); process.exit(2); }
const atMs = Date.parse(sc.at);
const cellDir = join('/r', sc.cell);

// The conversation as serve carried it: chat turns and delivered job results, the last 30 before the question.
const lines = (f: string) => existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const items: { t: number; instruction: string; summary: string }[] = [];
const tr = lines(join(cellDir, 'transcript.jsonl'));
for (let i = 0; i < tr.length; i++) if (tr[i].who === 'person' && tr[i + 1]?.who === 'assistant' && tr[i].vt < atMs - 60_000) items.push({ t: tr[i].vt, instruction: tr[i].text, summary: tr[i + 1].text });
for (const n of lines(join(cellDir, 'notifications.jsonl'))) if (n.ts < atMs - 60_000) items.push({ t: n.ts, instruction: `(scheduled result: ${String(n.instruction).slice(0, 120)})`, summary: String(n.summary).slice(0, 1500) });
items.sort((a, b) => a.t - b.t);
const carried = `Recent conversation so far:\n${items.slice(-30).map((h, i) => `(${i + 1}) ${h.instruction} → ${h.summary}`).join('\n')}`;

// As the eval world's servers declare them: mail and calendar reads are read-only; open_page and drafts are not.
for (const n of ['gmail__search_email', 'gmail__read_email', 'calendar__list_events']) markMcpReadOnly(n);

for (let k = 0; k < Number(trialsArg ?? 3); k++) {
  const dir = mkdtempSync(join(tmpdir(), 'bo-'));
  copyFileSync(join('/stores', sc.store), join(dir, 'agent.db'));
  const mem = new MwaMemory('mwa-serve', join(dir, 'agent.db'));
  mem.setSessionId('chat');
  // The job record keeps only its latest reading (the run's end state); put back what it held at the question.
  if (name === 'flight') for (const t of await mem.pendingScheduled()) if (/Atlantic Air/.test(t.instruction)) {
    const at = Date.parse('2026-11-10T23:00:00Z');
    await mem.setJobLastRun(t.id, { ...(t.lastRun ?? { summary: '' }), at, value: 'SCHEDULE CHANGE; departs 8:40 AM; arrives 11:05 AM local; gate TBD', valueAt: at } as never);
  }
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const names = Object.keys(sc.tools);
  const tools = {
    defs: () => names.map((n) => ({ name: n, description: DESC[n] ?? n, parameters: { type: 'object', properties: PARAMS[n] ?? {} } })),
    has: (x: string) => names.includes(x),
    call: async (n: string, args: Record<string, unknown>) => { calls.push({ name: n, args }); return sc.tools[n](args); },
  };
  let run: Record<string, unknown> = { instruction: sc.msg, userMessage: sc.msg, carried, startTainted: true, session: 'chat', interactive: true };
  if (sc.job) {
    const job = (await mem.pendingScheduled()).find((t) => sc.job!.test(t.instruction))!;
    // As the scheduler starts a recurring fire, minus the last-run record, which holds the run's end state.
    run = { instruction: job.instruction, session: job.notify, personId: job.person, plan: false, interactive: false, dueNow: true, startTainted: job.tainted === true,
      jobId: job.id, jobUntil: job.until, jobLimits: job.limits, jobDeliver: job.deliver, jobSettingsTainted: job.tainted === true, jobLineage: job.id, jobTask: job.task, jobRecur: job.recur, jobRequest: job.request };
  }
  const brain = new RoutedProvider(getProvider('brain'), getProvider('high'));
  const t0 = Date.now();
  let out: Record<string, unknown>;
  try {
    const r = await runAgent({ ...run, dir, memory: mem, brain, worker: brain, tools: tools as never, now: () => atMs, budget: { maxSteps: sc.job ? 16 : 14, maxWallMs: 600_000 } } as never);
    out = { summary: r.summary, reason: r.reason, outcome: r.outcome, steps: r.steps, costUsd: r.costUsd };
  } catch (e) { out = { error: (e as Error).message.slice(0, 300) }; }
  console.log(JSON.stringify({ scenario: name, trial: k + 1, model: process.env.MWA_MODEL, ms: Date.now() - t0, calls, ...out }));
  mem.close();
}
process.exit(0);
