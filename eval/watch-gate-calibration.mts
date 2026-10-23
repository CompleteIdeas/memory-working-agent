// BL-73: calibrate the watch gate (src/watch-gate.ts). Cases: every watch message the job bake-off delivered (its
// scenario says whether the person wanted it), plus written cases for watches the bake-off does not have (a price, a
// flight time, a package, a job posting). Each case is asked of Clef; prints the separation and the misses.
//   MWA_CLEF_TOKEN=… MWA_CLEF_ACCOUNT=… node --import tsx eval/watch-gate-calibration.mts [results/bakeoff-jobs/r1] [--runs 2]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { clefWatchGate, type WatchGateInput } from '../src/watch-gate.js';

const argv = process.argv.slice(2);
const runsAt = argv.indexOf('--runs');
const RUNS = runsAt >= 0 ? Number(argv[runsAt + 1]) : 2;
const dir = argv.find((a, i) => !a.startsWith('--') && i !== runsAt + 1);

const TREQ = 'Set a daily 9:00 AM check for Tessa Morrow’s status page: https://members.useventing.example/status/48213. Only notify me when her membership changes to Active. No updates otherwise.';
const TUNTIL = 'the status page shows Tessa Morrow’s membership is Active';
const RREQ = 'Set a daily 10:00 AM Eastern check on the Riverbend Fall HT results page: https://results.riverbendeventing.example/fall-ht-2026. Only alert me when results are marked final. No updates otherwise.';
const RUNTIL = 'the Riverbend results page marks the results final';
const PRICE = 'Check Petal Supply every morning and tell me if the price of red roses changes.';
const FLIGHT = 'Watch my flight UA 1423 on Nov 12 and tell me if the departure time changes.';
const PKG = 'Tell me when my Harbor Freight package is delivered.';
const JOB = 'Let me know if the Senior Data Analyst posting at Riverside Health closes.';
const TIX = 'Tell me when tickets for the Nov 20 Lumineers show go on sale.';
const RAIN = 'Tell me if Saturday’s forecast changes to rain.';

type Case = WatchGateInput & { same: boolean; id: string };
const W = (id: string, same: boolean, request: string, until: string | undefined, previous: string, reading: string | undefined, message: string): Case =>
  ({ id, same, request, ...(until ? { until } : {}), previous, ...(reading ? { reading } : {}), message });

const cases: Case[] = [
  W('t-same-wording', true, TREQ, TUNTIL, 'LAPSED (expired 2026-10-31)', 'LAPSED - expired Oct 31, 2026', 'Tessa Morrow’s status page still shows LAPSED (expired Oct 31). No change.'),
  W('t-pending', true, TREQ, TUNTIL, 'LAPSED (expired 2026-10-31)', 'LAPSED (expired 2026-10-31); renewal payment PENDING', 'Still not active: the page shows LAPSED with a renewal payment pending.'),
  W('t-active-again', true, TREQ, TUNTIL, 'ACTIVE (through 2027-11-30)', 'Status: ACTIVE through Nov 30, 2027', 'Tessa Morrow is Active through November 30, 2027.'),
  W('t-no-change', true, TREQ, TUNTIL, 'LAPSED (expired 2026-10-31)', undefined, 'No change.'),
  W('r-prov', true, RREQ, RUNTIL, 'PROVISIONAL', 'PROVISIONAL', 'Results are still provisional.'),
  W('r-final-again', true, RREQ, RUNTIL, 'FINAL (2026-11-06)', '**FINAL** (dated 2026-11-06)', 'Results remain marked FINAL as of Nov 6.'),
  W('r-corrected', true, RREQ, RUNTIL, 'PROVISIONAL', 'PROVISIONAL (scores corrected 2026-11-05)', 'The page still says PROVISIONAL; scores were corrected on November 5.'),
  W('p-same', true, PRICE, undefined, '$1.10 per stem', '$1.10/stem', 'Red roses are $1.10 per stem, same as before.'),
  W('p-nochange', true, PRICE, undefined, '$1.10 per stem', undefined, 'No change in the red rose price today.'),
  W('f-same', true, FLIGHT, undefined, 'Departs 8:40 AM', 'Departure 08:40', 'UA1423 still departs at 8:40 AM, on time.'),
  W('k-transit', true, PKG, 'the package is delivered', 'In transit - Memphis, TN', 'In transit (arrived at Louisville, KY facility)', 'Your package is still in transit; it reached the Louisville facility.'),
  W('j-open', true, JOB, 'the posting is closed', 'Open — accepting applications', 'Open', 'The posting is still open.'),
  W('x-notyet', true, TIX, 'tickets are on sale', 'Not on sale yet', 'Not on sale yet (presale for fan club Nov 1)', 'Tickets are not on sale yet; a fan-club presale opens Nov 1.'),
  W('t-active', false, TREQ, TUNTIL, 'LAPSED (expired 2026-10-31); renewal payment PENDING', 'ACTIVE (through 2027-11-30)', 'Tessa is now Active.'),
  W('r-final', false, RREQ, RUNTIL, 'PROVISIONAL (scores corrected 2026-11-05)', 'FINAL (2026-11-06)', 'Results are final.'),
  W('p-up', false, PRICE, undefined, '$1.10 per stem', '$1.45 per stem', 'Red roses went up to $1.45 per stem.'),
  W('p-down-small', false, PRICE, undefined, '$1.10 per stem', '$1.05 per stem', 'Red roses are $1.05 per stem today.'),
  W('f-delay', false, FLIGHT, undefined, 'Departs 8:40 AM', 'Departs 10:15 AM (delayed)', 'UA1423 now departs at 10:15 AM, delayed 95 minutes.'),
  W('f-small', false, FLIGHT, undefined, 'Departs 8:40 AM', 'Departs 8:55 AM', 'UA1423 departs at 8:55 AM.'),
  W('k-delivered', false, PKG, 'the package is delivered', 'In transit - Louisville, KY', 'Delivered Nov 4, 2:13 PM, front porch', 'Your package was delivered at 2:13 PM.'),
  W('j-closed', false, JOB, 'the posting is closed', 'Open', 'Closed', 'The Senior Data Analyst posting has closed.'),
  W('x-onsale', false, TIX, 'tickets are on sale', 'Not on sale yet', 'On sale now — $45', 'Tickets are on sale now, $45.'),
  W('w-rain', false, RAIN, undefined, 'Saturday: sunny, high 64', 'Saturday: 80% chance of rain', 'Saturday’s forecast now calls for rain.'),
];

// The bake-off's delivered watch messages, minus the notes the scheduler adds after the run.
const PREV: Record<string, string> = { JW1: 'LAPSED (expired 2026-10-31)', JW2: 'LAPSED (expired 2026-10-31); renewal payment PENDING', JW3: 'ACTIVE (through 2027-11-30)',
  CW1: 'PROVISIONAL', CW2: 'PROVISIONAL', CW3: 'PROVISIONAL (scores corrected 2026-11-05)', CW4: 'FINAL (2026-11-06)' };
if (dir && existsSync(dir)) {
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl') && !/\.(runs|tokens)\.jsonl$/.test(x))) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean)) {
      const r = JSON.parse(line);
      if (r.kind !== 'watch' || !r.delivered || !r.summary) continue;
      const tessa = r.scenario.startsWith('J');
      const message = String(r.summary).replace(/\n\n\((Changed since|This looks finished|Confirmed finished)[\s\S]*$/, '').trim();
      cases.push(W(`${f.replace('.jsonl', '')}:${r.scenario}#${r.trial}`, r.expect === 'quiet', tessa ? TREQ : RREQ, tessa ? TUNTIL : RUNTIL, PREV[r.scenario], undefined, message));
    }
  }
}

const gate = clefWatchGate({ token: process.env.MWA_CLEF_TOKEN!, account: process.env.MWA_CLEF_ACCOUNT!, timeoutMs: 15_000 });
const rows: { c: Case; ps: number[]; ms: number[] }[] = [];
let next = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (next < cases.length) {
    const c = cases[next++]; const ps: number[] = []; const ms: number[] = [];
    for (let k = 0; k < RUNS; k++) { const t0 = Date.now(); const p = await gate(c); ms.push(Date.now() - t0); if (p !== null) ps.push(p); }
    rows.push({ c, ps, ms });
  }
}));
rows.sort((a, b) => Number(a.c.same) - Number(b.c.same) || a.c.id.localeCompare(b.c.id));
for (const r of rows) console.log(`${r.c.same ? 'SAME' : 'DIFF'} ${r.c.id.padEnd(22)} ${r.ps.map((p) => p.toFixed(2)).join(' ').padEnd(12)} ${r.ps.length < RUNS ? `(${RUNS - r.ps.length} no answer)` : ''}`);
const sameMin = Math.min(...rows.filter((r) => r.c.same).flatMap((r) => r.ps));
const diffMax = Math.max(...rows.filter((r) => !r.c.same).flatMap((r) => r.ps));
const all = rows.flatMap((r) => r.ms).sort((a, b) => a - b);
console.log(`\ncases ${rows.length} (same ${rows.filter((r) => r.c.same).length}, different ${rows.filter((r) => !r.c.same).length}), ${RUNS} runs each`);
console.log(`lowest "same" ${sameMin.toFixed(3)}, highest "different" ${diffMax.toFixed(3)}; median ${all[Math.floor(all.length / 2)]} ms, p90 ${all[Math.floor(all.length * 0.9)]} ms`);
for (const t of [0.5, 0.6, 0.7, 0.8, 0.9]) {
  const quietWrong = rows.filter((r) => !r.c.same).flatMap((r) => r.ps).filter((p) => p >= t).length;
  const sentWrong = rows.filter((r) => r.c.same).flatMap((r) => r.ps).filter((p) => p < t).length;
  console.log(`threshold ${t}: wanted messages silenced ${quietWrong}, unwanted still sent ${sentWrong}`);
}
