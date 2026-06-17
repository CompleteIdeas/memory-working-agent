/**
 * Memory gauntlet runner — a scientific single-factor ablation.
 *
 *   Independent variable : the memory substrate (4 arms: awm / off / notes / longctx).
 *   Held CONSTANT        : model, decoding, harness code, task sequence, seed data, budgets,
 *                          tools. The working dir is WIPED between every task; the memory store
 *                          is the ONLY thing that persists across a run's sessions.
 *   Measured             : per-task pass-rate over k repetitions (pass^k), steps, cost.
 *   Headline contrast    : awm vs off (one bit flipped). notes/longctx are baselines, NOT a
 *                          clean control — longctx is a different mechanism (full-dump context,
 *                          byte-capped). Reported separately.
 *
 * Usage:  tsx src/gauntlet/run.ts [--arms awm,off,notes,longctx] [--k 1] [--bytes 6000]
 */
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getProvider } from '../provider.js';
import { RoutedProvider } from '../model-router.js';
import { buildRegistry } from '../tools/build.js';
import { loadConfig } from '../config.js';
import { runAgent } from '../agent.js';
import { makeArm, type ArmName } from './arms.js';
import { SUITES, padNote, type GauntletTask } from './tasks.js';

const ALL_ARMS: ArmName[] = ['awm', 'rag', 'notes', 'longctx', 'off'];

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

interface Cell { pass: boolean; steps: number; cost: number; inTok: number; outTok: number; reason: string; note: string }
interface Meter { recallCalls: number; recallMs: number; recallResults: number; writeCalls: number; writeMs: number }

async function main() {
  const arms = arg('arms', ALL_ARMS.join(',')).split(',').map((s) => s.trim()).filter(Boolean) as ArmName[];
  const k = Number(arg('k', '1'));
  const bytes = Number(arg('bytes', '6000'));
  const suiteName = arg('suite', 'memory');
  const pad = Number(arg('pad', '0')); // simulate notes accumulated over a large corpus (scale test)
  const TASKS = SUITES[suiteName];
  if (!TASKS) { console.error(`unknown --suite "${suiteName}". options: ${Object.keys(SUITES).join(', ')}`); process.exit(1); }
  const root = resolve('./results/gauntlet');
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  const cfg = loadConfig();
  const { registry, close } = await buildRegistry(cfg);
  const brain = new RoutedProvider(getProvider('brain'), getProvider('high'));
  const worker = new RoutedProvider(getProvider('brain'), getProvider('high'));

  // results[arm][taskId] = Cell[]  (one per repetition)
  const results: Record<string, Record<string, Cell[]>> = {};
  const meters: Record<string, Meter> = {};
  for (const a of arms) { results[a] = {}; for (const t of TASKS) results[a][t.id] = []; meters[a] = { recallCalls: 0, recallMs: 0, recallResults: 0, writeCalls: 0, writeMs: 0 }; }

  console.log(`\nMEMORY GAUNTLET — suite=${suiteName}  arms=[${arms.join(', ')}]  k=${k}  tasks=${TASKS.length}  pad=${pad}  longctx-cap=${bytes}B\n`);

  for (let r = 0; r < k; r++) {
    for (const armName of arms) {
      const storeDir = resolve(root, armName, `r${r}`, 'store');
      rmSync(storeDir, { recursive: true, force: true });
      const arm = makeArm(armName, storeDir, bytes);
      // SCALE TEST — pad the store with `pad` accumulated "doc notes" so the real facts are
      // needles in a large haystack (the "what if I have 10,000 docs of notes" case). This is
      // where flat-file scan + vector-cosine cost grow O(n) and precision drops, long-context
      // fully evicts, and AWM's indexed activation should hold.
      if (pad > 0) {
        const t0 = Date.now();
        for (let i = 0; i < pad; i++) { const n = padNote(i); await arm.memory.write(n.concept, n.content, ['topic=docnote', 'confidence_level=observed']); }
        process.stdout.write(`(padded ${pad} in ${((Date.now() - t0) / 1000).toFixed(1)}s) `);
        // zero the meter so recall/write stats reflect the TASKS, not the one-time pad writes
        arm.memory.recallMs = 0; arm.memory.recallCalls = 0; arm.memory.recallResults = 0; arm.memory.writeMs = 0; arm.memory.writeCalls = 0;
      }
      const workDir = resolve(root, armName, `r${r}`, 'work');
      process.stdout.write(`  [${armName} r${r}] `);
      for (const task of TASKS) {
        // HARD reset: wipe the working dir before every task. Only `arm.memory` carries over.
        rmSync(workDir, { recursive: true, force: true });
        mkdirSync(workDir, { recursive: true });
        task.setup?.(workDir);
        let cell: Cell;
        try {
          const res = await runAgent({
            instruction: task.instruction, dir: workDir, memory: arm.memory, brain, worker, tools: registry,
            interactive: true, primeCap: arm.primeCap, session: `${armName}-r${r}-${task.id}`,
            budget: { maxSteps: 8, maxWallMs: 90_000, consolidateEvery: 50 },
          });
          const sc = task.score({ dir: workDir, result: res });
          cell = { pass: sc.pass, steps: res.steps, cost: res.costUsd, inTok: res.usage.brainIn + res.usage.workerIn, outTok: res.usage.brainOut + res.usage.workerOut, reason: res.reason, note: sc.note };
        } catch (e) {
          cell = { pass: false, steps: 0, cost: 0, inTok: 0, outTok: 0, reason: 'error', note: (e as Error).message.slice(0, 40) };
        }
        results[armName][task.id].push(cell);
        process.stdout.write(cell.pass ? (task.memoryDependent ? '✓' : '·') : '✗');
      }
      process.stdout.write('\n');
      const m = meters[armName]; const s = arm.memory;
      m.recallCalls += s.recallCalls; m.recallMs += s.recallMs; m.recallResults += s.recallResults;
      m.writeCalls += s.writeCalls; m.writeMs += s.writeMs;
      arm.memory.close();
    }
  }
  close();

  // ---- scorecard ----
  const mdTasks = TASKS.filter((t) => t.memoryDependent);
  const passRate = (arm: string, t: GauntletTask) => results[arm][t.id].filter((c) => c.pass).length / Math.max(1, k);
  const pct = (n: number) => `${Math.round(n * 100)}%`.padStart(4);

  console.log(`\n  per-task pass-rate (✓ = memory-dependent)\n`);
  const head = ['task'.padEnd(16), 'MD', ...arms.map((a) => a.padStart(8))].join('  ');
  console.log('  ' + head);
  for (const t of TASKS) {
    const row = [t.id.padEnd(16), t.memoryDependent ? '✓ ' : '  ', ...arms.map((a) => pct(passRate(a, t)).padStart(8))].join('  ');
    console.log('  ' + row);
  }

  console.log(`\n  HEADLINE — memory-dependent pass-rate (${mdTasks.length} tasks):`);
  for (const a of arms) {
    const mean = mdTasks.reduce((s, t) => s + passRate(a, t), 0) / mdTasks.length;
    const cost = Object.values(results[a]).flat().reduce((s, c) => s + c.cost, 0);
    const steps = Object.values(results[a]).flat().reduce((s, c) => s + c.steps, 0);
    console.log(`    ${a.padStart(8)}:  ${pct(mean)}   (total cost $${cost.toFixed(4)}, ${steps} steps)`);
  }

  // ACCURACY is one axis; AWM's value is accuracy AT LOW TOKEN COST and HIGH SPEED. A full
  // dump (longctx) buys accuracy with tokens; a network store buys it with latency. Show both.
  console.log(`\n  EFFICIENCY + SPEED (the axes pass-rate hides):\n`);
  const ehead = ['arm'.padStart(8), 'MD-acc', 'in-tok/task', 'out-tok/task', 'recall-calls', 'mean-recall-ms', 'mean-results'].join('  ');
  console.log('  ' + ehead);
  const nRuns = k; const nTasks = TASKS.length;
  for (const a of arms) {
    const cells = Object.values(results[a]).flat();
    const inTok = cells.reduce((s, c) => s + c.inTok, 0) / Math.max(1, nRuns * nTasks);
    const outTok = cells.reduce((s, c) => s + c.outTok, 0) / Math.max(1, nRuns * nTasks);
    const mdAcc = mdTasks.reduce((s, t) => s + passRate(a, t), 0) / mdTasks.length;
    const mt = meters[a];
    const recallMs = mt.recallCalls ? mt.recallMs / mt.recallCalls : 0;
    const meanRes = mt.recallCalls ? mt.recallResults / mt.recallCalls : 0;
    const row = [a.padStart(8), pct(mdAcc), Math.round(inTok).toString().padStart(11), Math.round(outTok).toString().padStart(12),
      mt.recallCalls.toString().padStart(12), recallMs.toFixed(0).padStart(14), meanRes.toFixed(1).padStart(12)].join('  ');
    console.log('  ' + row);
  }
  console.log('\n  (in-tok/task = prompt-token efficiency; long-context dumps the store → high in-tok.');
  console.log('   mean-recall-ms = retrieval speed; AWM does embed+rerank in-process, naive arms are ~0ms,');
  console.log('   the real speed contrast lands against a network-backed system like Mem0.)');
  // STABILITY — single runs are noise (arms swing 10-20pts). Report the per-repetition
  // memory-dependent accuracy as mean ± sd with a 95% bootstrap CI, so claims survive variance.
  if (k > 1) {
    console.log(`\n  STABILITY — memory-dependent accuracy over k=${k} reps (mean ± sd, 95% bootstrap CI):\n`);
    const perRepMd = (a: string): number[] => Array.from({ length: k }, (_, r) =>
      mdTasks.reduce((s, t) => s + (results[a][t.id][r]?.pass ? 1 : 0), 0) / mdTasks.length);
    for (const a of arms) {
      const xs = perRepMd(a);
      const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
      const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length);
      // bootstrap 95% CI over the k per-rep accuracies (wide at small k — honest)
      const B = 2000; const means: number[] = [];
      for (let b = 0; b < B; b++) { let acc = 0; for (let i = 0; i < k; i++) acc += xs[Math.floor(Math.random() * k)]; means.push(acc / k); }
      means.sort((x, y) => x - y);
      const lo = means[Math.floor(0.025 * B)]; const hi = means[Math.floor(0.975 * B)];
      console.log(`    ${a.padStart(8)}:  ${pct(mean)} ± ${Math.round(sd * 100)}pp   95% CI [${pct(lo)}, ${pct(hi)}]   reps: ${xs.map((x) => Math.round(x * 100)).join('/')}`);
    }
    console.log(`\n  (overlapping CIs ⇒ the difference is NOT yet significant at this k — increase k.)`);
  }

  const onOff = arms.includes('awm') && arms.includes('off');
  if (onOff) {
    const on = mdTasks.reduce((s, t) => s + passRate('awm', t), 0) / mdTasks.length;
    const off = mdTasks.reduce((s, t) => s + passRate('off', t), 0) / mdTasks.length;
    console.log(`\n  PRIMARY CONTRAST (awm − off): ${pct(on)} − ${pct(off)} = +${Math.round((on - off) * 100)} pts on memory-dependent tasks`);
    const band = on >= 0.3 && on <= 0.85;
    console.log(`  difficulty band: awm memory-ON at ${pct(on)} — ${band ? 'IN the 30–85% target' : 'OUT of band, retune task difficulty'}`);
  }

  writeFileSync(resolve(root, 'scorecard.json'), JSON.stringify({ arms, k, bytes, results }, null, 2));
  console.log(`\n  wrote ${resolve(root, 'scorecard.json')}\n`);
}
main().catch((e) => { console.error(e); process.exit(1); });
