// Background-job bake-off (Robert, 2026-10-23: "a little mini bake-off on the areas where we're struggling on the
// bottom tier models"). Chats stay on GPT-6.1 Sol in production; only work nobody waits on goes to the cheap model.
// So each scenario fires ONE scheduled job through MWA's own scheduler (tickScheduler: the run, then the delivery
// rules) at the moment a USEA staff world checked it in the BL-68 runs, with the job as Sol set it up there, its last
// run as Sol left it, and the world's mail, calendar and pages answering as they stood at that moment.
//   MWA_EVAL_CLOCK_FILE=<file> MWA_MODEL=<worker> \
//   node --import ./eval/clock-shim.mjs --import tsx eval/bakeoff/jobs.mts <out.jsonl> [--trials 2] [--only JB2,CW3]
// One JSON line per fire: delivered or quiet, the message, outcome, steps, the tools it called. Judged by jobs-score.mjs.
import { readFileSync, writeFileSync, appendFileSync, mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { tickScheduler } from '../../src/scheduler.js';
import { MwaMemory, type JobLastRun } from '../../src/awm.js';
import { getProvider } from '../../src/provider.js';
import { RoutedProvider } from '../../src/model-router.js';
import { markMcpReadOnly } from '../../src/tools/governance.js';
import { openItemTools } from '../../src/tools/open-items.js';
import { makeWorld, localMs, stamp } from '../world.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const opt = (k: string, d?: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const OUT = resolve(argv[0]);
const TRIALS = Number(opt('trials', '2'));
const ONLY = opt('only')?.split(',');
const clock = (globalThis as { __mwaEvalClock?: { realNow: () => number } }).__mwaEvalClock;
if (!clock || !process.env.MWA_EVAL_CLOCK_FILE) { console.error('load ./eval/clock-shim.mjs with MWA_EVAL_CLOCK_FILE set'); process.exit(2); }
process.env.TZ = 'America/New_York'; // both worlds' time zone (Git Bash drops TZ on its way to node)

// The jobs as Sol wrote them in the BL-68 runs (results/usea/<world>-mwa/notifications.jsonl), keyed by how they begin.
const lines = (f: string) => existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const solJobs = (world: string) => lines(join(ROOT, 'results', 'usea', `${world}-mwa`, 'notifications.jsonl')) as { ts: number; instruction: string; summary: string }[];
const jobText = (world: string, start: string, contains?: string) => {
  const j = solJobs(world).find((n) => n.instruction.startsWith(start) && (!contains || n.instruction.includes(contains)));
  if (!j) throw new Error(`no ${world} job starting "${start}"`);
  return j.instruction;
};
// A brief's last run: Sol's delivered message from the same job before this fire.
const lastBrief = (world: string, instruction: string, beforeMs: number): JobLastRun | undefined => {
  const prev = solJobs(world).filter((n) => n.instruction === instruction && n.ts < beforeMs - 60_000).pop();
  return prev ? { at: prev.ts, summary: prev.summary.slice(0, 600) } : undefined;
};

interface Scenario {
  id: string; world: 'jordan' | 'casey'; at: string; kind: 'brief' | 'watch';
  start: string; contains?: string; recur: string; notify: string; request: string;
  deliver?: 'always' | 'changed'; until?: string;
  prev?: { at: string; value: string }; pendingComplete?: boolean;
  expect: 'deliver' | 'quiet';
}

const JB = 'Prepare a concise morning brief for the user';
const CB = 'Prepare and send me a short weekday morning brief';
const CD = 'Send me a short weekly summary of deadlines';
const JREQ = 'Set a weekday 8:30 AM brief for me: what came in that needs me + today’s calendar, ranked most important first. Always put any rider eligibility issue that could block someone from competing at an upcoming event at the very top.';
const CREQ = 'Set this up: every weekday at 8:00 AM send me a short brief of new email items that need me, highest priority first. If there’s anything about an official not legally able to serve at an upcoming event, that always goes first.';
const DREQ = 'Also set a weekly check: every Monday at 9:00 AM Eastern, send me the deadlines due that week from my email and calendar.';
const TREQ = 'Set a daily 9:00 AM check for Tessa Morrow’s status page: https://members.useventing.example/status/48213. Only notify me when her membership changes to Active. No updates otherwise.';
const RREQ = 'Set a daily 10:00 AM Eastern check on the Riverbend Fall HT results page: https://results.riverbendeventing.example/fall-ht-2026. Only alert me when results are marked final. No updates otherwise.';
const TESSA = { start: 'Check Tessa Morrow', recur: 'daily:09:00', notify: 'setup-watch', request: TREQ, deliver: 'changed' as const, until: 'the status page shows Tessa Morrow’s membership is Active' };
const RIVER = { start: 'Check the Riverbend Fall HT results page', recur: 'daily:10:00', notify: 'setup-watch', request: RREQ, deliver: 'changed' as const, until: 'the Riverbend results page marks the results final' };
// What a delivered fire must say, per scenario (the BL-68 world probes, worded for substance); jobs-score.mjs reads it too.
const RUBRICS = JSON.parse(readFileSync(join(HERE, 'rubrics.json'), 'utf8')) as Record<string, string[]>;

const SCENARIOS: Scenario[] = [
  // Morning briefs and the weekly digest: each must be a real brief with the item the world planted for that day.
  { id: 'JB1', world: 'jordan', at: '2026-11-02 08:30', kind: 'brief', start: JB, recur: 'daily:08:30@12345', notify: 'setup-brief', request: JREQ, expect: 'deliver' },
  { id: 'JB2', world: 'jordan', at: '2026-11-04 08:30', kind: 'brief', start: JB, recur: 'daily:08:30@12345', notify: 'setup-brief', request: JREQ, expect: 'deliver' },
  { id: 'JB3', world: 'jordan', at: '2026-11-05 08:30', kind: 'brief', start: JB, recur: 'daily:08:30@12345', notify: 'setup-brief', request: JREQ, expect: 'deliver' },
  { id: 'JB4', world: 'jordan', at: '2026-11-10 08:30', kind: 'brief', start: JB, contains: 'Board and committee', recur: 'daily:08:30@12345', notify: 'setup-brief', request: JREQ, expect: 'deliver' },
  { id: 'CB1', world: 'casey', at: '2026-11-02 08:00', kind: 'brief', start: CB, recur: 'daily:08:00@12345', notify: 'setup-brief', request: CREQ, expect: 'deliver' },
  { id: 'CD1', world: 'casey', at: '2026-11-02 09:00', kind: 'brief', start: CD, recur: 'daily:09:00@1', notify: 'setup-digest', request: DREQ, expect: 'deliver' },
  { id: 'CD2', world: 'casey', at: '2026-11-09 09:00', kind: 'brief', start: CD, recur: 'daily:09:00@1', notify: 'setup-digest', request: DREQ, expect: 'deliver' },
  // Change-only watches: a message only on the change the person asked about, then a quiet stop.
  { id: 'JW1', world: 'jordan', at: '2026-11-04 09:00', kind: 'watch', ...TESSA, prev: { at: '2026-11-03 09:00', value: 'LAPSED (expired 2026-10-31)' }, expect: 'quiet' },
  { id: 'JW2', world: 'jordan', at: '2026-11-05 09:00', kind: 'watch', ...TESSA, prev: { at: '2026-11-04 09:00', value: 'LAPSED (expired 2026-10-31); renewal payment PENDING' }, expect: 'deliver' },
  { id: 'JW3', world: 'jordan', at: '2026-11-06 09:00', kind: 'watch', ...TESSA, prev: { at: '2026-11-05 09:00', value: 'ACTIVE (through 2027-11-30)' }, pendingComplete: true, expect: 'quiet' },
  { id: 'CW1', world: 'casey', at: '2026-11-03 10:00', kind: 'watch', ...RIVER, prev: { at: '2026-11-02 10:00', value: 'PROVISIONAL' }, expect: 'quiet' },
  { id: 'CW2', world: 'casey', at: '2026-11-06 10:00', kind: 'watch', ...RIVER, prev: { at: '2026-11-05 10:00', value: 'PROVISIONAL' }, expect: 'quiet' },
  { id: 'CW3', world: 'casey', at: '2026-11-07 10:00', kind: 'watch', ...RIVER, prev: { at: '2026-11-06 10:00', value: 'PROVISIONAL (scores corrected 2026-11-05)' }, expect: 'deliver' },
  { id: 'CW4', world: 'casey', at: '2026-11-08 10:00', kind: 'watch', ...RIVER, prev: { at: '2026-11-07 10:00', value: 'FINAL (2026-11-06)' }, pendingComplete: true, expect: 'quiet' },
];

const TOOLS: Record<string, string> = { gmail__search_email: 'search_email', gmail__read_email: 'read_email', gmail__draft_email: 'draft_email', calendar__list_events: 'list_events', calendar__propose_event: 'propose_event', web__open_page: 'open_page' };
for (const n of ['gmail__search_email', 'gmail__read_email', 'calendar__list_events']) markMcpReadOnly(n);
const setClock = async (ms: number) => {
  writeFileSync(process.env.MWA_EVAL_CLOCK_FILE!, JSON.stringify({ offsetMs: ms - clock.realNow() }));
  await new Promise((s) => setTimeout(s, 300)); // the shim rereads the file at most every 200 ms
};

mkdirSync(dirname(OUT), { recursive: true });
const brain = new RoutedProvider(getProvider('brain'), getProvider('high'));
for (const sc of SCENARIOS.filter((s) => !ONLY || ONLY.includes(s.id))) {
  const atMs = localMs(sc.at);
  const instruction = jobText(sc.world, sc.start, sc.contains);
  for (let k = 0; k < TRIALS; k++) {
    const dir = mkdtempSync(join(tmpdir(), 'bojob-'));
    const worldLog = join(dir, 'world-log.jsonl');
    const { tools: wt } = makeWorld(join(ROOT, 'eval', 'worlds', `${sc.world}.json`), worldLog);
    const calls: { name: string; args: unknown }[] = [];
    await setClock(atMs - 5 * 60_000);
    const mem = new MwaMemory('mwa-serve', join(dir, 'agent.db'));
    // The open-items list production gives every run (src/tools/build.ts), empty here: round 1 left it out, and the
    // jobs Sol wrote start "check open_items" — briefs said "I couldn't open your tracker" and ended could-not.
    const own = openItemTools(mem);
    const tools = {
      defs: () => [...Object.entries(TOOLS).map(([n, t]) => ({ name: n, description: wt[t].description, parameters: wt[t].parameters })), ...own.map((t) => t.def)],
      has: (x: string) => x in TOOLS || own.some((t) => t.def.name === x),
      call: async (n: string, args: Record<string, unknown>, ctx?: Record<string, unknown>) => {
        calls.push({ name: n, args });
        const o = own.find((t) => t.def.name === n);
        return o ? o.handler(args ?? {}, { sandboxDir: dir, personId: 'web', ...(ctx ?? {}) } as never) : String(wt[TOOLS[n]].run(args ?? {}));
      },
    };
    const id = await mem.addScheduledTask(instruction, atMs, { recur: sc.recur, notify: sc.notify, person: 'web', task: instruction, request: sc.request,
      ...(sc.deliver ? { deliver: sc.deliver } : {}), ...(sc.until ? { until: sc.until } : {}) });
    if (!id) throw new Error('job not stored');
    const last = sc.kind === 'brief' ? lastBrief(sc.world, instruction, atMs)
      : sc.prev ? { at: localMs(sc.prev.at), summary: '', value: sc.prev.value, valueAt: localMs(sc.prev.at), history: [{ at: localMs(sc.prev.at), value: sc.prev.value }] } : undefined;
    if (last) await mem.setJobLastRun(id, last);
    if (sc.pendingComplete) await mem.setPendingComplete(id, true);
    await setClock(atMs);
    let fired: { outcome?: string; summary?: string; steps?: number; costUsd?: number; reason?: string; completion?: string } | null = null;
    const log: string[] = [];
    const t0 = clock.realNow();
    let error: string | undefined;
    try {
      await tickScheduler({ memory: mem, brain, worker: brain, tools: tools as never, outRoot: join(dir, 'out'), checksAllowed: false,
        onFire: async (_t, r) => { fired = r as never; }, onLog: (m) => log.push(m) });
    } catch (e) { error = (e as Error).message.slice(0, 300); }
    const f = fired as typeof fired & object | null;
    const quiet = log.find((l) => l.includes('quiet (') || l.includes('stopped quietly'));
    const ran = log.find((l) => l.startsWith('✔ ran'));
    const gateLine = log.find((l) => l.includes('watch gate:'));
    const rec = { scenario: sc.id, world: sc.world, kind: sc.kind, at: sc.at, trial: k + 1, model: process.env.MWA_MODEL, worker: process.env.MWA_BACKGROUND_MODEL || undefined, jobId: id.slice(0, 8),
      expect: sc.expect, rubrics: RUBRICS[sc.id] ?? [], delivered: !!f, outcome: f?.outcome ?? /\((\w+)\/([\w-]+)\)/.exec(ran ?? '')?.[2], completion: f?.completion,
      summary: f?.summary ?? null, quiet: quiet ?? null, watchGate: gateLine ?? null, ran: ran ?? null, steps: f?.steps, reportedCost: f?.costUsd, ms: clock.realNow() - t0, error,
      calls: calls.map((c) => ({ name: c.name, args: JSON.stringify(c.args).slice(0, 160) })), stamp: stamp(atMs) };
    appendFileSync(OUT, JSON.stringify(rec) + '\n');
    console.log(`${sc.id} #${k + 1}: ${rec.delivered ? 'DELIVERED' : 'quiet'} (${rec.outcome ?? '?'}) expect ${sc.expect}, ${rec.steps ?? '?'} steps, ${(rec.ms / 1000).toFixed(0)} s${error ? ` ERROR ${error}` : ''}`);
    mem.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* a locked db file on Windows */ }
  }
}
process.exit(0);
