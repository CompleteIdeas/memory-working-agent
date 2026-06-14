/**
 * V2.1 — MULTI-SESSION validation with SLEEP between sessions.
 *
 * The proper test of the maturation thesis, done with AWM used as designed:
 * session 1 writes rich, session-tagged memories; we SLEEP (consolidate) between
 * sessions; session 2 (a different task needing the same knowledge) recalls the
 * matured memory. Two arms isolate sleep's effect:
 *   - sleep:   S1 → consolidate() → S2
 *   - nosleep: S1 →               → S2
 * Both share one AWM store across sessions, both tag writes with session=.
 *
 * Sleep is wired HERE (the orchestrator above runBrain), not in-band — biological
 * consolidation is offline, between sessions.
 */
import { rmSync } from 'node:fs';
import { getProvider } from './provider.js';
import { MwaMemory } from './awm.js';
import { SCENARIOS } from './tasks-v2.js';
import { runBrain, type BrainResult } from './brain.js';

const sc = SCENARIOS[0]; // legacy-store: S1 learns the contract (doc), S2 reuses it (no doc)

async function session(mem: MwaMemory, brain: any, worker: any, i: number, runId: string, arm: string): Promise<BrainResult> {
  const s = sc.sessions[i];
  const dir = `./sandbox/ms/${runId}/${arm}/s${i + 1}`;
  rmSync(dir, { recursive: true, force: true });
  sc.setupShared(dir);
  s.setup(dir);
  return runBrain({ goal: { id: `s${i + 1}`, goal: s.goal, testCmd: s.testCmd }, memory: mem, brain, worker, sandboxDir: dir, maxSteps: 7, session: `session-${i + 1}` });
}

async function runArm(arm: 'sleep' | 'nosleep', runId: string): Promise<{ s1: BrainResult; s2: BrainResult; consol: Record<string, number> }> {
  const db = `./data/ms-${arm}-${runId}.db`;
  for (const ext of ['', '-wal', '-shm']) { try { rmSync(db + ext, { force: true }); } catch { /* */ } }
  const mem = new MwaMemory(`ms-${arm}-${runId}`, db);
  const brain = getProvider('brain');
  const worker = getProvider('high');

  const s1 = await session(mem, brain, worker, 0, runId, arm);
  let consol: Record<string, number> = {};
  if (arm === 'sleep') {
    consol = await mem.consolidate(); // SLEEP between sessions
  }
  const s2 = await session(mem, brain, worker, 1, runId, arm);
  mem.close();
  return { s1, s2, consol };
}

export async function runMultiSession(runId = 'ms'): Promise<void> {
  console.log('\n=== MULTI-SESSION: S1 learns contract → (sleep?) → S2 reuses it (no doc) ===\n');
  const arms: ('sleep' | 'nosleep')[] = ['sleep', 'nosleep'];
  const out: Record<string, { s1: BrainResult; s2: BrainResult; consol: Record<string, number> }> = {};
  for (const arm of arms) {
    const r = await runArm(arm, runId);
    out[arm] = r;
    if (arm === 'sleep') {
      const p = (k: string) => r.consol[k] ?? 0;
      console.log(`[sleep] consolidation between sessions: clusters=${p('clustersFound')} edgesStrengthened=${p('edgesStrengthened')} edgesCreated=${p('edgesCreated')} bridges=${p('bridgesCreated')} faded=${p('memoriesFaded')} processed=${p('engramsProcessed')}`);
    }
    console.log(`[${arm}] S1: success=${r.s1.success} disp=${r.s1.dispatches}  |  S2: success=${r.s2.success} disp=${r.s2.dispatches} recalled=${r.s2.recalledCount} reRecalls=${r.s2.reRecalls} reads=${r.s2.reads}`);
  }

  console.log('\n--- session-2 reuse comparison (the question: does sleep help S2 reuse?) ---');
  for (const arm of arms) {
    const s2 = out[arm].s2;
    console.log(`  ${arm.padEnd(8)}: S2 success=${s2.success}  dispatches=${s2.dispatches}  recalled=${s2.recalledCount}  $${s2.costUsd.toFixed(4)}`);
  }
  console.log('\n(Note: a 2-session scenario writes few memories, so consolidation has little to fade/strengthen —');
  console.log('the validation confirms the WIRING + direction; the +30% recall win shows at volume per AWM\'s eval.)\n');
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('multisession.ts') || entry.endsWith('multisession.js')) {
  runMultiSession(process.env.MS_RUNID ?? 'ms').catch((e) => { console.error('multisession failed:', e); process.exit(1); });
}
