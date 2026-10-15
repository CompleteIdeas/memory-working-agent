/**
 * Prototype proof — the scheduler's cheap change-detection GATE.
 *
 * A recurring scheduled task can carry a `check` command. Before each (expensive) agent fire the
 * scheduler runs that command; if its output SIGNATURE is unchanged since the last real fire, the
 * fire is skipped entirely — one tiny subprocess, ZERO model calls. This is what makes an idle
 * recurring poll ~free (a fresh runAgent per fire already keeps context small; the gate avoids even
 * paying for the fire when there's nothing new).
 *
 * We inject a SPY runAgent (SchedulerDeps.runAgent) so we can prove, deterministically and with no
 * model/network, exactly WHEN the agent runs vs skips — and that the check command + last signature
 * round-trip through real AWM storage.
 *
 *   npx tsx scripts/_scheduler-gate.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MwaMemory } from '../src/awm.js';
import { tickScheduler } from '../src/scheduler.js';

const dir = mkdtempSync(join(tmpdir(), 'mwa-gate-'));
const dbPath = join(dir, 'agent.db');
const outRoot = join(dir, 'out');

const checks: { name: string; pass: boolean; detail?: string }[] = [];
const ok = (n: string, p: boolean, d?: string) => checks.push({ name: n, pass: p, detail: d });

// The watched state is just an env var the test flips — the check command prints it, so its
// signature changes exactly when we change SIGVAL. (Stands in for "SELECT count(*) FROM inbox",
// "curl -s api/etag", a file mtime, etc.) Uses node -e so it's identical on Windows + POSIX.
const CHECK = 'node -e "process.stdout.write(process.env.SIGVAL||\'\')"';

async function main() {
  const mem = new MwaMemory('gate-test', dbPath);
  let clock = 1_000_000_000;
  const ran: string[] = [];      // instructions the (spy) agent actually executed
  const delivered: string[] = []; // tasks whose result was delivered via onFire

  // create a recurring poll WITH a change-gate, due now
  await mem.addScheduledTask('summarize new inbox items', clock, { recur: 'every:1', check: CHECK });

  // round-trip: the check command survives AWM storage (base64 tag) and reads back intact
  const [t0] = await mem.pendingScheduled();
  ok('check command round-trips through AWM storage', t0?.check === CHECK, t0?.check);

  const deps: any = {
    memory: mem, brain: {}, worker: {}, outRoot,
    checksAllowed: true, // opt in — the gate itself is proven separately; this test exercises the change-detection
    now: () => clock,
    runAgent: async (a: any) => { ran.push(a.instruction); return { summary: 'ok', reason: 'done', files: [] }; },
    onFire: async (task: any) => { delivered.push(task.instruction); },
    onLog: () => {},
  };

  const tick = async (sigval: string) => { process.env.SIGVAL = sigval; clock += 120_000; return tickScheduler(deps); };

  // Tick 1 — first-ever fire (no baseline yet) → RUNS, records baseline sig('A')
  await tick('A');
  ok('tick1 (first fire) runs the agent', ran.length === 1, `ran=${ran.length}`);

  // Tick 2 — SIGVAL unchanged → SKIP: no agent run, no delivery, just a cheap subprocess
  await tick('A');
  ok('tick2 (no change) SKIPS the agent — zero model calls', ran.length === 1, `ran=${ran.length}`);
  ok('tick2 delivers nothing on a skip', delivered.length === 1, `delivered=${delivered.length}`);

  // Tick 3 — SIGVAL changed → RUNS again, updates the baseline to sig('B')
  await tick('B');
  ok('tick3 (state changed) runs the agent again', ran.length === 2, `ran=${ran.length}`);

  // Tick 4 — unchanged again → SKIP
  await tick('B');
  ok('tick4 (no change) SKIPS again', ran.length === 2, `ran=${ran.length}`);

  // 4 ticks, only 2 real fires → half were free. The signature persisted across ticks in AWM.
  const [after] = await mem.pendingScheduled();
  ok('last signature persisted in AWM (sha1 hex)', !!after?.lastSig && /^[0-9a-f]{40}$/.test(after.lastSig), after?.lastSig);

  // Fail-open: a check that ERRORS must never silently drop work — it runs the agent anyway.
  await mem.addScheduledTask('failing-check task', clock, { recur: 'every:1', check: 'node -e "process.exit(3)"' });
  const before = ran.length;
  await tick('A'); // task1 unchanged (skips); the new failing-check task should fire despite the error
  ok('failed check fails OPEN (runs the agent, never silently skips)', ran.some((i) => i === 'failing-check task'), `ran=${ran.slice(before).join('|')}`);

  mem.close();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }

  const passed = checks.filter((c) => c.pass).length;
  console.log('\n=== scheduler change-detection gate ===');
  for (const c of checks) console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : `  → ${c.detail ?? ''}`}`);
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed !== checks.length) process.exit(1);
  console.log('PASS — idle (unchanged) recurring fires cost zero model calls; only real changes run the agent.');
}
main().catch((e) => { console.error('gate test failed:', e?.stack ?? e); try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } process.exit(1); });
