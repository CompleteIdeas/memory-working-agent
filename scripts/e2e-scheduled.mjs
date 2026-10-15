// END-TO-END scheduled-task harness: does an autonomous task actually DELIVER?
//
//   MWA_E2E_PASSWORD=<access password> node scripts/e2e-scheduled.mjs [trials]
//
// Runs against a LIVE container (default http://127.0.0.1:7788, container `mwa-dev`; override with
// MWA_BASE / MWA_CONTAINER). It schedules real tasks on the configured model, so each trial costs
// roughly $0.02-0.05. Exit 0 only when every trial delivered.
//
// WHY THIS EXISTS. The previous harness counted a `schedule` SSE event as a hit, i.e. it
// measured whether the agent reached the right tool. On 2026-10-14 it scored 3/4 — and when those
// same tasks fired ~2 hours later, two of them produced nothing: they cost $0.057, logged
// reason=done, and displayed "0 steps". The metric was measuring the half of the system that
// worked. A HIT here requires the FILE to exist with the expected content, checked on the volume.
//
// Deliberately NOT keyed on `reason` or on the summary text: a run that refuses itself still logs
// reason=done, and the summary is model prose. The artifact is the only honest evidence.
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';

const BASE = process.env.MWA_BASE || 'http://127.0.0.1:7788';
const CONTAINER = process.env.MWA_CONTAINER || 'mwa-dev';
// The access password, from the environment (or a file it names) — never a literal in this script.
const PW = (process.env.MWA_E2E_PASSWORD
  ?? (process.env.MWA_E2E_PASSWORD_FILE ? readFileSync(process.env.MWA_E2E_PASSWORD_FILE, 'utf8') : '')).trim();
if (!PW) { console.error('set MWA_E2E_PASSWORD (or MWA_E2E_PASSWORD_FILE) to the container access password'); process.exit(2); }
const N = Number(process.argv[2] || 3);
const DELAY_MIN = 1;                 // schedule 1 minute out; the scheduler ticks every 60s
const WAIT_MS = 10 * 60_000;         // an upper bound only; the loop exits as each run finishes

const sh = (args) => new Promise((res) => {
  execFile('docker', args, { timeout: 25_000 }, (err, stdout) => res(err ? '' : String(stdout).trim()));
});

async function login() {
  const r = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PW }),
  });
  if (!r.ok) throw new Error(`login failed: ${r.status}`);
  const raw = r.headers.getSetCookie?.() ?? [r.headers.get('set-cookie')];
  return raw.filter(Boolean).map((c) => c.split(';')[0]).join('; ');
}

async function chat(cookie, message, session) {
  const url = `${BASE}/api/chat?message=${encodeURIComponent(message)}&session=${encodeURIComponent(session)}`;
  const r = await fetch(url, { headers: { cookie, accept: 'text/event-stream' } });
  const out = { scheduled: false, tools: [], summary: '' };
  let buf = ''; const dec = new TextDecoder();
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2);
      const type = /^event: (.*)$/m.exec(frame)?.[1];
      if (!type) continue;
      let d = {}; try { d = JSON.parse(/^data: (.*)$/m.exec(frame)?.[1] ?? '{}'); } catch { /* */ }
      if (type === 'schedule') out.scheduled = true;
      if (type === 'tool' && d.name) out.tools.push(d.name);
      if (type === 'result') out.summary = String(d.summary ?? '');
      if (type === 'result' || type === 'error') return out;
    }
  }
  return out;
}

const getJson = async (cookie, path) => {
  try { return await (await fetch(`${BASE}${path}`, { headers: { cookie } })).json(); } catch { return {}; }
};

/** Find the deliverable anywhere under the workspace volume. */
const findFile = (name) => sh(['exec', CONTAINER, 'find', '/data/mwa-workspace', '-name', name, '-type', 'f']);

const cookie = await login();
const stamp = Date.now().toString(36).slice(-5);
const trials = Array.from({ length: N }, (_, i) => ({
  i, name: `e2e-${stamp}-${i}.txt`, token: `CHECK-${stamp}-${i}-OK`,
}));

// ---- phase 1: ask for each one, in its own fresh session -----------------------------------
console.log(`\nPHASE 1 — scheduling ${N} task(s) ${DELAY_MIN} minute out, fresh session each\n`);
for (const t of trials) {
  t.prompt = `In ${DELAY_MIN} minute, write a file called ${t.name} in your workspace whose contents are exactly ${t.token}. Schedule it to run later — do not create the file now.`;
  const r = await chat(cookie, t.prompt, `e2e-${stamp}-${t.i}`);
  t.scheduledEvent = r.scheduled;          // the OLD metric
  t.summary = r.summary.slice(0, 80).replace(/\s+/g, ' ');
  t.early = Boolean(await findFile(t.name)); // did it ignore "later" and do it immediately?
  console.log(`  ${t.i} schedule-event=${r.scheduled ? 'YES' : 'no '} premature=${t.early ? 'YES' : 'no '} | ${t.summary}`);
}

// ---- phase 2: what actually got STORED (the teaching signal) --------------------------------
const stored = (await getJson(cookie, '/api/schedule')).scheduled ?? [];
console.log(`\nPHASE 2 — stored instructions (${stored.length} pending)\n`);
for (const s of stored) {
  const bad = [];
  if (/\b(in \d+ ?(minute|min|hour)|later|do not do it now|just schedule|schedule it)\b/i.test(s.instruction)) bad.push('SCHEDULING-LANGUAGE');
  if (/(^|\s)(\/|[A-Za-z]:\\)[^\s]*mwa-workspace/i.test(s.instruction)) bad.push('ABSOLUTE-PATH');
  console.log(`  ${bad.length ? '⚠ ' + bad.join('+') : '✓ clean'} | ${s.instruction.slice(0, 120).replace(/\s+/g, ' ')}`);
}

// ---- phase 3: wait for delivery -------------------------------------------------------------
console.log(`\nPHASE 3 — waiting up to ${WAIT_MS / 60000} min for the files to appear\n`);
const deadline = Date.now() + WAIT_MS;
const pending = new Set(trials.map((t) => t.i));
// Stop early once every task that DID schedule has delivered — no point waiting out the clock on
// trials the agent never scheduled. They still get one last check below, in case a schedule
// happened without the SSE event (don't assume the event is the ground truth here either).
//
// Wait per TASK, not on one clock: tasks due seconds apart miss the same 60s tick and then run
// SEQUENTIALLY (~25s each), so a fixed 3-minute window gave up on two that were merely queued —
// one of which delivered seven seconds after the harness reported it missing. A trial stops being
// waited on once it delivers OR its run has finished (a notification record names its file).
const finished = new Set();
const waitingOn = () => [...pending].filter((i) => trials[i].scheduledEvent && !finished.has(i)).length;
while (pending.size && waitingOn() > 0 && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 15_000));
  const fin = ((await getJson(cookie, '/api/notifications?since=0')).notifications ?? []).map((n) => String(n.instruction));
  for (const t of trials) if (fin.some((s) => s.includes(t.name))) finished.add(t.i);
  for (const t of trials) {
    if (!pending.has(t.i)) continue;
    const hit = await findFile(t.name);
    if (hit) {
      t.path = hit.split('\n')[0].trim();
      t.content = (await sh(['exec', CONTAINER, 'cat', t.path])).trim();
      t.ok = t.content.includes(t.token);
      pending.delete(t.i);
      console.log(`  ✔ ${t.name} after ${Math.round((WAIT_MS - (deadline - Date.now())) / 1000)}s — content ${t.ok ? 'MATCHES' : `WRONG (${t.content.slice(0, 40)})`}`);
    }
  }
}
// Last look, including the trials that never emitted a schedule event.
for (const t of trials) {
  if (t.path) continue;
  const hit = await findFile(t.name);
  if (hit) {
    t.path = hit.split('\n')[0].trim();
    t.content = (await sh(['exec', CONTAINER, 'cat', t.path])).trim();
    t.ok = t.content.includes(t.token);
    console.log(`  ✔ ${t.name} (late/unannounced) — content ${t.ok ? 'MATCHES' : 'WRONG'}`);
  } else {
    console.log(`  ✘ ${t.name} never appeared${t.scheduledEvent ? '' : ' (never scheduled either)'}`);
  }
}

// ---- phase 4: was the run VISIBLE? ----------------------------------------------------------
const notes = ((await getJson(cookie, '/api/notifications?since=0')).notifications ?? [])
  .filter((n) => String(n.instruction).includes(stamp));
console.log(`\nPHASE 4 — notification records for these runs (${notes.length})\n`);
for (const n of notes) {
  const visible = Number(n.steps) > 0;
  console.log(`  ${visible ? '✓' : '⚠ "0 steps"'} steps=${n.steps ?? 'absent'} tools=${n.toolCalls ?? 'absent'} $${n.costUsd ?? 'absent'} reason=${n.reason ?? 'absent'} files=${(n.files ?? []).length}`);
}

// ---- phase 5: WHY did each failure fail? (refusalLog from the run log) -----------------------
const failed = trials.filter((t) => !t.ok && t.scheduledEvent);
if (failed.length) {
  console.log(`\nPHASE 5 — why the scheduled-but-undelivered runs failed\n`);
  const runs = (await sh(['exec', CONTAINER, 'sh', '-c', `grep -h "${stamp}" /data/runs.jsonl`]))
    .split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    .filter((r) => !/^In \d+ minute/.test(r.instruction)); // the FIRED runs, not the scheduling chats
  for (const t of failed) {
    const r = runs.find((x) => String(x.instruction).includes(t.name));
    if (!r) { console.log(`  ${t.name}: no fired run in the log`); continue; }
    console.log(`  ${t.name}: steps=${r.steps} tools=${r.toolCalls} refusals=${r.refusals ?? '?'}`);
    for (const x of r.refusalLog ?? []) console.log(`     ↳ ${x}`);
    console.log(`     summary: ${String(r.summary).slice(0, 160).replace(/\s+/g, ' ')}`);
  }
}

// ---- verdict --------------------------------------------------------------------------------
const delivered = trials.filter((t) => t.ok).length;
const sched = trials.filter((t) => t.scheduledEvent).length;
console.log(`\n${'='.repeat(64)}`);
console.log(`  SCHEDULED (old metric):  ${sched}/${N}`);
console.log(`  DELIVERED (real metric): ${delivered}/${N}`);
console.log(`  premature (did it now):  ${trials.filter((t) => t.early).length}/${N}`);
console.log(`${'='.repeat(64)}\n`);
process.exit(delivered === N ? 0 : 1);
