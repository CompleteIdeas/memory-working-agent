// Promise assessment simulator (docs/assessment-2026-10-19.md). One persona, one arm, simulated days
// on an accelerated clock:
//
//   node --import tsx eval/run-sim.mjs --world maya --arm mwa|mwa-nomem|cron --env <azure .env> [--until "2026-11-04 12:00"] [--port 7811] [--out results/assessment]
//
// Virtual time jumps from event to event — a person turn, the next due job, the nightly
// consolidation (arm A), the person's end-of-day rating — and waits for each job's fire to finish
// before moving on. Everything lands in <out>/<world>-<arm>/.
import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync, appendFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const { values: a } = parseArgs({ options: { world: { type: 'string' }, arm: { type: 'string' }, env: { type: 'string' }, until: { type: 'string' }, port: { type: 'string', default: '7811' }, out: { type: 'string', default: 'results/assessment' }, image: { type: 'string', default: 'mwa:dev' } } });
const here = dirname(fileURLToPath(import.meta.url));
if (!['maya', 'sam'].includes(a.world) || !['mwa', 'mwa-nomem', 'cron'].includes(a.arm) || !a.env) {
  console.error('usage: --world maya|sam --arm mwa|mwa-nomem|cron --env <file with AZURE_GPT_*>'); process.exit(2);
}
const worldFile = join(here, 'worlds', `${a.world}.json`);
const rawWorld = JSON.parse(readFileSync(worldFile, 'utf8'));
process.env.TZ = rawWorld.tz;
const outDir = resolve(a.out, `${a.world}-${a.arm}`);
if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
// This process keeps the same virtual clock as the container (the cron arm runs inside it).
process.env.MWA_EVAL_CLOCK_FILE = join(outDir, 'harness-clock.json');
writeFileSync(process.env.MWA_EVAL_CLOCK_FILE, JSON.stringify({ offsetMs: 0 }));
await import('./clock-shim.mjs');
const { realNow } = globalThis.__mwaEvalClock;
const { localMs, stamp } = await import('./world.mjs');
const persona = await import('./persona.mjs');
persona.setPersonaUsageLog(join(outDir, 'persona-usage.jsonl'));

const world = rawWorld;
const start = localMs(world.start), end = a.until ? localMs(a.until) : localMs(world.end);
const log = (file, obj) => appendFileSync(join(outDir, file), JSON.stringify(obj) + '\n');
const say = (m) => console.log(`[${stamp(Date.now())}] ${m}`);

let arm;
if (a.arm === 'cron') {
  process.env.MWA_ENV_PATH = resolve(a.env);
  const cfg = join(outDir, 'cron.config.json');
  writeFileSync(cfg, JSON.stringify({ models: { fetch: 'azure:gpt-5-4-mini', reason: 'azure:gpt-5-4-mini' } }));
  process.env.MWA_CONFIG_PATH = cfg;
  const { makeCronArm } = await import('./cron-arm.mjs');
  arm = await makeCronArm({ worldFile, logFile: join(outDir, 'world-log.jsonl'), runLog: join(outDir, 'runs.jsonl'), persona: world.persona, envFile: resolve(a.env) });
} else {
  const { makeMwaArm } = await import('./mwa-arm.mjs');
  arm = await makeMwaArm({ world, worldName: a.world, arm: a.arm, port: Number(a.port), envFile: resolve(a.env), evalDir: here, outDir, image: a.image });
}

async function setVirtual(ms) {
  const offset = ms - realNow();
  writeFileSync(process.env.MWA_EVAL_CLOCK_FILE, JSON.stringify({ offsetMs: Math.round(offset) }));
  if (arm.setClock) await arm.setClock(offset);
  await new Promise((r) => setTimeout(r, 300)); // past the shim's 200 ms cache
}

// The schedule of things the harness itself does.
const events = world.turns.map((t) => ({ at: localMs(t.at), kind: 'turn', turn: t }));
for (let d = new Date(start); d.getTime() <= end; d.setDate(d.getDate() + 1)) {
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (a.arm === 'mwa') events.push({ at: day.getTime() + 3 * 3_600_000, kind: 'consolidate' });
  events.push({ at: day.getTime() + 21 * 3_600_000 + 45 * 60_000, kind: 'rate', day: day.getTime() });
}
events.sort((x, y) => x.at - y.at);

const seen = []; // what the person has been told: {vt, when, text}
let deliveredCount = 0;
async function refreshSeen() {
  const ds = a.arm === 'cron' ? arm.deliveries() : await arm.deliveries();
  for (const d of ds.slice(deliveredCount)) seen.push({ vt: Number(d.ts), when: stamp(Number(d.ts)), text: String(d.summary ?? ''), source: 'job' });
  deliveredCount = ds.length;
}

// Approval cards (MWA arms): the person looks at the panel after talking to it and after its jobs
// run, and decides in character, approving only what they asked for (pilot: a quiet-hours rule was
// staged for approval and sat there).
const askedSoFar = [];
async function handleApprovals() {
  if (!arm.approvals) return;
  for (const card of await arm.approvals()) {
    const ok = await persona.personApproval(world, stamp(Date.now()), card, askedSoFar);
    const res = await arm.decide(card.id, ok);
    say(`approval ${ok ? 'APPROVED' : 'DECLINED'}: ${card.tool} — ${String(card.summary).slice(0, 100)} → ${res.slice(0, 60)}`);
    log('transcript.jsonl', { vt: Date.now(), who: 'person', approval: ok, tool: card.tool, summary: card.summary, tainted: card.tainted === true, result: res.slice(0, 200) });
  }
}

if (arm.start) await arm.start(start - realNow());
await setVirtual(start);
say(`start ${world.persona.name} / ${a.arm}`);
const t0 = performance.now();

while (true) {
  const jobs = a.arm === 'cron' ? arm.dueJobs() : await arm.dueJobs();
  const nextJob = jobs.length ? Math.min(...jobs.map((j) => j.due)) : Infinity;
  const nextEv = events.length ? events[0].at : Infinity;
  const t = Math.min(nextJob, nextEv);
  if (!Number.isFinite(t) || t > end) break;
  if (t > Date.now()) await setVirtual(t + 1000);

  if (nextJob <= nextEv) {
    const due = jobs.filter((j) => j.due <= Date.now());
    say(`jobs due: ${due.map((j) => j.instruction.slice(0, 50)).join(' | ')}`);
    if (a.arm === 'cron') await arm.fireDue();
    else {
      const n = await arm.waitFires(due.length, nextJob);
      if (n < 0) { say('  ! fires did not finish in 10 min'); log('harness.jsonl', { vt: Date.now(), issue: 'fire-timeout', due }); }
    }
    await refreshSeen();
    await handleApprovals();
    continue;
  }

  const ev = events.shift();
  if (ev.kind === 'turn') {
    await refreshSeen();
    const recent = seen.slice(-6);
    const msg = await persona.personMessage(world, ev.turn, stamp(Date.now()), recent);
    say(`${ev.turn.id} person: ${msg}`);
    const exchange = [{ who: 'You', text: msg }];
    let r = await arm.chat(ev.turn.session, msg);
    say(`${ev.turn.id} assistant: ${r.reply.replace(/\s+/g, ' ').slice(0, 160)}`);
    log('transcript.jsonl', { vt: Date.now(), turn: ev.turn.id, session: ev.turn.session, who: 'person', text: msg });
    log('transcript.jsonl', { vt: Date.now(), turn: ev.turn.id, session: ev.turn.session, who: 'assistant', text: r.reply, tools: r.tools, asked: r.asked, costUsd: r.costUsd });
    exchange.push({ who: 'Assistant', text: r.reply });
    seen.push({ vt: Date.now(), when: stamp(Date.now()), text: r.reply, source: 'chat' });
    for (let k = 0; k < 2 && r.asked; k++) {
      const ans = await persona.personAnswer(world, ev.turn, stamp(Date.now()), exchange);
      if (!ans) break;
      say(`${ev.turn.id} person: ${ans}`);
      r = await arm.chat(ev.turn.session, ans);
      say(`${ev.turn.id} assistant: ${r.reply.replace(/\s+/g, ' ').slice(0, 160)}`);
      log('transcript.jsonl', { vt: Date.now(), turn: ev.turn.id, session: ev.turn.session, who: 'person', text: ans, followUp: k + 1 });
      log('transcript.jsonl', { vt: Date.now(), turn: ev.turn.id, session: ev.turn.session, who: 'assistant', text: r.reply, tools: r.tools, asked: r.asked, costUsd: r.costUsd, followUp: k + 1 });
      exchange.push({ who: 'You', text: ans }, { who: 'Assistant', text: r.reply });
      seen.push({ vt: Date.now(), when: stamp(Date.now()), text: r.reply, source: 'chat' });
    }
    askedSoFar.push(ev.turn.intent);
    await handleApprovals();
  } else if (ev.kind === 'consolidate') {
    const r = await arm.consolidate();
    log('harness.jsonl', { vt: Date.now(), consolidate: r });
  } else if (ev.kind === 'rate') {
    await refreshSeen();
    const items = seen.filter((s) => s.vt >= ev.day && s.vt < ev.day + 86_400_000);
    const r = await persona.personRating(world, new Date(ev.day).toDateString(), items);
    say(`rating ${new Date(ev.day).toDateString()}: ${r.rating} — ${r.why}`);
    log('ratings.jsonl', { day: stamp(ev.day).slice(4, 14), ...r, messages: items.length });
  }
}

await refreshSeen();
if (a.arm === 'cron') writeFileSync(join(outDir, 'notifications.jsonl'), arm.deliveries().map((d) => JSON.stringify(d)).join('\n') + '\n');
else { await arm.collect(); await arm.stop(); }
writeFileSync(join(outDir, 'summary.json'), JSON.stringify({ world: a.world, arm: a.arm, start: world.start, end: stamp(end), realMinutes: Math.round((performance.now() - t0) / 60_000), messagesSeen: seen.length }, null, 2));
say(`done in ${Math.round((performance.now() - t0) / 60_000)} real minutes`);
process.exit(0);
