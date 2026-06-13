/**
 * MWA brain — the autonomous orchestrator loop (JSON-action protocol).
 *
 * The brain does NOT write code. It conducts: recalls prior decisions from AWM,
 * dispatches coding subtasks to the worker, reads results, records decisions/
 * learnings back to AWM, and stops when the goal's tests pass. The cheap model
 * conducts; the worker codes. AWM keeps it on-goal across steps and across runs.
 *
 * The Memory is injected: MwaMemory (arm A, AWM on) or NullMemory (arm B/C, off).
 * Same loop for every benchmark arm — only the provider + memory swap.
 */
import type { Provider } from './provider.js';
import type { Memory } from './awm.js';
import { runWorker } from './worker.js';
import { parseJsonLoose, runCommand } from './util.js';

export interface BrainGoal {
  id: string;
  goal: string;
  testCmd: string;
  constraint?: string;
  /** fixed files the worker must not overwrite. undefined → worker default ['test.mjs']; [] → custom task with no fixed grader */
  protect?: string[];
}

export interface BrainResult {
  taskId: string;
  success: boolean;
  steps: number;
  dispatches: number;
  recalledCount: number;
  usage: { brainIn: number; brainOut: number; workerIn: number; workerOut: number };
  costUsd: number;
  history: string[];
}

interface Action {
  action: 'dispatch' | 'done';
  instruction?: string;
  summary?: string;
}

const SYSTEM = [
  'You are an autonomous coding ORCHESTRATOR. You do NOT write code yourself.',
  'You conduct a worker that writes code and runs tests. Each turn, output ONLY JSON (no prose, no fences):',
  '  {"action":"dispatch","instruction":"<precise, self-contained coding instruction for the worker>"}',
  '  {"action":"done","summary":"<one line>"}',
  'Rules: dispatch ONE concrete step at a time. Read the worker result; if tests FAILED, dispatch a fix that addresses the specific error. If tests PASSED and the goal is met, say done.',
  'Use the recalled prior decisions to avoid repeating past mistakes. Be terse and decisive.',
].join('\n');

const PRICE_DIV = 1_000_000;

export async function runBrain(opts: {
  goal: BrainGoal;
  memory: Memory;
  brain: Provider;
  worker: Provider;
  sandboxDir: string;
  maxSteps?: number;
  workspace?: string;
  onEvent?: (type: string, data: Record<string, unknown>) => void;
}): Promise<BrainResult> {
  const { goal, memory, brain, worker, sandboxDir } = opts;
  const maxSteps = opts.maxSteps ?? 6;
  const emit = opts.onEvent ?? (() => {});
  const usage = { brainIn: 0, brainOut: 0, workerIn: 0, workerOut: 0 };
  const history: string[] = [];
  let dispatches = 0;

  // Prime: recall prior decisions/learnings for this kind of goal.
  const recalled = memory.enabled ? await memory.recall(goal.goal, { limit: 5, workspace: opts.workspace }) : [];
  const recalledBlock = recalled.length
    ? 'PRIOR DECISIONS/LEARNINGS (from memory — use them):\n' +
      recalled.map((m, i) => `${i + 1}. [${m.concept}] ${m.content}`).join('\n')
    : 'No prior memory for this task.';
  emit('recall', { count: recalled.length, awm: memory.enabled });

  let parseFails = 0;
  let steps = 0;
  for (; steps < maxSteps; steps++) {
    const prompt = [
      `GOAL: ${goal.goal}`,
      goal.constraint ? `HARD CONSTRAINT (must hold in the final code): ${goal.constraint}` : '',
      recalledBlock,
      history.length ? `WORK SO FAR:\n${history.join('\n')}` : 'No work yet.',
      'Decide the next action as JSON now.',
    ]
      .filter(Boolean)
      .join('\n\n');

    const out = await brain.chat({ system: SYSTEM, messages: [{ role: 'user', content: prompt }], maxTokens: 700 });
    usage.brainIn += out.usage.input;
    usage.brainOut += out.usage.output;

    let action: Action;
    try {
      action = parseJsonLoose<Action>(out.text);
    } catch {
      parseFails++;
      history.push(`(brain emitted unparseable output; retrying)`);
      if (parseFails >= 2) break;
      continue;
    }

    if (action.action === 'done') {
      history.push(`done: ${action.summary ?? ''}`);
      break;
    }

    if (action.action === 'dispatch' && action.instruction) {
      dispatches++;
      const wres = await runWorker(worker, { instruction: action.instruction, testCmd: goal.testCmd, constraint: goal.constraint, protect: goal.protect }, sandboxDir);
      usage.workerIn += wres.usage.input;
      usage.workerOut += wres.usage.output;
      history.push(`dispatch#${dispatches}: ${action.instruction.slice(0, 140)} -> ${wres.pass ? 'PASS' : 'FAIL'} | ${wres.output.slice(0, 220)}`);
      emit('dispatch', { n: dispatches, instruction: action.instruction.slice(0, 160), pass: wres.pass });
      if (memory.enabled) {
        await memory.write(
          `approach: ${action.instruction.slice(0, 56)}`,
          `task ${goal.id}: ${wres.pass ? 'WORKED' : 'FAILED'} — ${wres.output.slice(0, 300)}`,
          ['topic=coding', `task=${goal.id}`],
          { eventType: wres.pass ? 'decision' : 'friction', surprise: wres.pass ? 0.3 : 0.6 },
        );
      }
      continue;
    }

    history.push('(invalid action shape)');
    parseFails++;
    if (parseFails >= 2) break;
  }

  // Objective final grade — independent of the brain's claim.
  const grade = runCommand(goal.testCmd, sandboxDir, 60_000);
  const success = grade.code === 0;

  const costUsd =
    (usage.brainIn / PRICE_DIV) * brain.price[0] +
    (usage.brainOut / PRICE_DIV) * brain.price[1] +
    (usage.workerIn / PRICE_DIV) * worker.price[0] +
    (usage.workerOut / PRICE_DIV) * worker.price[1];

  // Persist the outcome so future runs recall what worked (smarter over time).
  if (memory.enabled) {
    await memory.write(
      `outcome: ${goal.id}`,
      `Goal "${goal.goal.slice(0, 80)}" -> ${success ? 'SUCCESS' : 'FAIL'} in ${dispatches} dispatch(es).`,
      ['topic=coding', `task=${goal.id}`, 'kind=outcome'],
      { eventType: 'decision', canonical: success },
    );
  }

  emit('done', { success, dispatches, costUsd: Number(costUsd.toFixed(6)), recalled: recalled.length });

  return {
    taskId: goal.id,
    success,
    steps,
    dispatches,
    recalledCount: recalled.length,
    usage,
    costUsd: Number(costUsd.toFixed(6)),
    history,
  };
}
