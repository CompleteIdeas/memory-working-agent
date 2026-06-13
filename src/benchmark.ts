/**
 * A/B/C benchmark — the proof. Same brain loop + same fixed tasks; only the
 * model + memory swap per arm:
 *   A_cheap+AWM : gpt-5-4-mini + MwaMemory (shared db across runs → accumulation)
 *   B_cheap     : gpt-5-4-mini + NullMemory (no substrate)
 *   C_high      : Sonnet      + NullMemory (frontier ceiling)
 *
 * Records success (test pass AND constraint held), dispatches, tokens, cost,
 * recalledCount per (arm,task,run); writes results/{bench.jsonl,summary.json}
 * and prints a table. Arm A shares one AWM db so a task's run-2 recalls run-1
 * (smarter-over-time). Run: `npm run bench` (env: BENCH_TASKS, BENCH_RUNS, BENCH_ARMS).
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getProvider, type ProviderRole } from './provider.js';
import { MwaMemory, NullMemory, type Memory } from './awm.js';
import { TASKS } from './tasks.js';
import { runBrain } from './brain.js';

interface ArmDef {
  name: string;
  brainRole: ProviderRole;
  useAwm: boolean;
}
const ARMS: ArmDef[] = [
  { name: 'A_cheap+AWM', brainRole: 'brain', useAwm: true },
  { name: 'B_cheap', brainRole: 'brain', useAwm: false },
  { name: 'C_high', brainRole: 'high', useAwm: false },
];

interface Row {
  arm: string;
  task: string;
  run: number;
  success: boolean;
  constraintOk: boolean;
  pass: boolean; // success && constraintOk
  dispatches: number;
  steps: number;
  brainTok: number;
  workerTok: number;
  cost: number;
  recalled: number;
}

export interface ArmSummary {
  arm: string;
  runs: number;
  passRate: number;
  avgDispatches: number;
  avgCost: number;
  totalCost: number;
  avgRecalled: number;
  run1AvgDispatches: number | null;
  run2AvgDispatches: number | null;
}

export async function runBenchmark(opts: {
  taskIds?: string[];
  runs?: number;
  arms?: string[];
  outDir?: string;
} = {}): Promise<{ rows: Row[]; summary: ArmSummary[] }> {
  const runs = opts.runs ?? 2;
  const tasks = TASKS.filter((t) => !opts.taskIds || opts.taskIds.includes(t.id));
  const arms = ARMS.filter((a) => !opts.arms || opts.arms.includes(a.name));
  const outDir = opts.outDir ?? './results';
  mkdirSync(outDir, { recursive: true });
  const rows: Row[] = [];

  for (const arm of arms) {
    const provider = getProvider(arm.brainRole);
    let mem: Memory;
    if (arm.useAwm) {
      const db = `./data/bench-${arm.name}.db`;
      rmSync(db, { force: true });
      rmSync(`${db}-wal`, { force: true });
      rmSync(`${db}-shm`, { force: true });
      mem = new MwaMemory(`bench-${arm.name}`, db);
    } else {
      mem = new NullMemory();
    }
    for (const task of tasks) {
      for (let r = 1; r <= runs; r++) {
        const dir = `./sandbox/bench/${arm.name}/${task.id}/run${r}`;
        rmSync(dir, { recursive: true, force: true });
        task.setup(dir);
        const res = await runBrain({
          goal: { id: task.id, goal: task.goal, testCmd: task.testCmd, constraint: task.constraint },
          memory: mem,
          brain: provider,
          worker: provider,
          sandboxDir: dir,
          maxSteps: 6,
        });
        const extra = task.gradeExtra ? task.gradeExtra(dir) : { ok: true, note: '' };
        const row: Row = {
          arm: arm.name,
          task: task.id,
          run: r,
          success: res.success,
          constraintOk: extra.ok,
          pass: res.success && extra.ok,
          dispatches: res.dispatches,
          steps: res.steps,
          brainTok: res.usage.brainIn + res.usage.brainOut,
          workerTok: res.usage.workerIn + res.usage.workerOut,
          cost: res.costUsd,
          recalled: res.recalledCount,
        };
        rows.push(row);
        console.error(
          `[bench] ${arm.name} ${task.id} run${r}: pass=${row.pass} (test=${res.success} constraint=${extra.ok}) disp=${res.dispatches} recalled=${res.recalledCount} $${res.costUsd}`,
        );
      }
    }
    mem.close();
  }

  writeFileSync(`${outDir}/bench.jsonl`, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const summary = summarize(rows, arms.map((a) => a.name), runs);
  writeFileSync(`${outDir}/summary.json`, JSON.stringify({ at: new Date().toISOString(), runs, summary, rows }, null, 2));
  printTable(summary);
  return { rows, summary };
}

function avg(ns: number[]): number {
  return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : 0;
}

function summarize(rows: Row[], armNames: string[], runs: number): ArmSummary[] {
  return armNames.map((arm) => {
    const ar = rows.filter((r) => r.arm === arm);
    const r1 = ar.filter((r) => r.run === 1);
    const r2 = ar.filter((r) => r.run === 2);
    return {
      arm,
      runs: ar.length,
      passRate: ar.length ? ar.filter((r) => r.pass).length / ar.length : 0,
      avgDispatches: Number(avg(ar.map((r) => r.dispatches)).toFixed(2)),
      avgCost: Number(avg(ar.map((r) => r.cost)).toFixed(5)),
      totalCost: Number(ar.reduce((a, r) => a + r.cost, 0).toFixed(5)),
      avgRecalled: Number(avg(ar.map((r) => r.recalled)).toFixed(2)),
      run1AvgDispatches: r1.length ? Number(avg(r1.map((r) => r.dispatches)).toFixed(2)) : null,
      run2AvgDispatches: runs >= 2 && r2.length ? Number(avg(r2.map((r) => r.dispatches)).toFixed(2)) : null,
    };
  });
}

function printTable(summary: ArmSummary[]): void {
  console.log('\n=== MWA A/B/C BENCHMARK ===');
  console.log(
    ['arm'.padEnd(14), 'pass%'.padStart(6), 'avgDisp'.padStart(8), 'avgCost$'.padStart(9), 'totCost$'.padStart(9), 'avgRecall'.padStart(10), 'disp r1→r2'.padStart(12)].join(''),
  );
  for (const s of summary) {
    const acc = s.run1AvgDispatches !== null && s.run2AvgDispatches !== null ? `${s.run1AvgDispatches}→${s.run2AvgDispatches}` : '-';
    console.log(
      [
        s.arm.padEnd(14),
        (s.passRate * 100).toFixed(0).padStart(6),
        String(s.avgDispatches).padStart(8),
        String(s.avgCost).padStart(9),
        String(s.totalCost).padStart(9),
        String(s.avgRecalled).padStart(10),
        acc.padStart(12),
      ].join(''),
    );
  }
  console.log('');
}

// run as main
const _entry = process.argv[1] ?? '';
void fileURLToPath;
if (_entry.endsWith('benchmark.ts') || _entry.endsWith('benchmark.js')) {
  const taskIds = process.env.BENCH_TASKS ? process.env.BENCH_TASKS.split(',') : undefined;
  const runs = process.env.BENCH_RUNS ? Number(process.env.BENCH_RUNS) : 2;
  const arms = process.env.BENCH_ARMS ? process.env.BENCH_ARMS.split(',') : undefined;
  runBenchmark({ taskIds, runs, arms }).catch((e) => {
    console.error('benchmark failed:', e);
    process.exit(1);
  });
}
