/**
 * MWA brain — the autonomous orchestrator loop (JSON-action protocol).
 *
 * The brain does NOT write code. It conducts: recalls prior decisions from AWM,
 * dispatches coding subtasks to the worker, reads results, records decisions/
 * learnings back to AWM, and stops when the goal's tests pass. The cheap model
 * conducts; the worker codes. AWM keeps it on-goal across steps and across runs.
 *
 * Hybrid memory↔grep loop (the USEA-tuned discipline, validated in V2):
 *   - RECALL FIRST, scoped + full content (precise values, not truncated summaries).
 *   - RE-RECALL mid-task framed to the current sub-problem (recall before synthesis).
 *   - READ a sandbox file for ground truth when recall misses or to verify.
 *   - SUPERSEDE a recalled fact the moment a result proves it wrong (keep memory fresh).
 *
 * The Memory is injected: MwaMemory (arm A, AWM on) or NullMemory (arm B/C, off).
 * Same loop for every benchmark arm — only the provider + memory swap.
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { Provider, ToolDef } from './provider.js';
import type { Memory, RecalledMemory } from './awm.js';
import { RoutedProvider, classifyIntent } from './model-router.js';
import type { ToolRegistry } from './tools/registry.js';
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
  /** hybrid-loop activity */
  reRecalls: number;
  reads: number;
  supersedes: number;
  /** model-router activity: tier escalations (fetch→reason) + final worker tier */
  escalations: number;
  workerTier: string;
  usage: { brainIn: number; brainOut: number; workerIn: number; workerOut: number };
  costUsd: number;
  history: string[];
}

interface Action {
  action: 'dispatch' | 'recall' | 'read' | 'supersede' | 'done';
  instruction?: string; // dispatch
  query?: string;       // recall
  path?: string;        // read
  ref?: number;         // supersede: 1-based index into the recalled list
  fact?: string;        // supersede: the corrected fact
  summary?: string;     // done
}

const SYSTEM = [
  'You are an autonomous coding ORCHESTRATOR. You do NOT write code yourself — you call tools.',
  'Tools: dispatch (give the worker one coding step), recall (re-query memory for the current sub-problem),',
  'read (read a sandbox file for ground truth), supersede (correct a stale recalled fact), done (finish).',
  'Call exactly ONE tool per turn.',
  'Rules:',
  '- Use the recalled PRIOR DECISIONS/LEARNINGS first; they are numbered so you can supersede one by ref.',
  '- If memory does not cover something you need, READ the relevant file rather than guessing.',
  '- If a worker result CONTRADICTS a recalled memory, SUPERSEDE it with the corrected fact.',
  '- Each run starts with an EMPTY sandbox. Recalled successes are the APPROACH to reuse, NOT existing files — you must dispatch to (re)create them this run.',
  '- Dispatch ONE concrete step at a time. If tests FAILED, dispatch a fix addressing the specific error.',
  '- Call done only after a dispatch produced PASSING tests this run. Be decisive; do not loop without progress.',
].join('\n');

export const BRAIN_TOOLS: ToolDef[] = [
  { name: 'dispatch', description: 'Hand a precise, self-contained coding instruction to the worker, which writes code and runs the tests.', parameters: { type: 'object', properties: { instruction: { type: 'string', description: 'the concrete coding step' } }, required: ['instruction'] } },
  { name: 'recall', description: 'Re-query memory for prior decisions/learnings, framed to the current sub-problem.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'read', description: 'Read a file in the sandbox for ground truth when memory is silent or to verify a fact.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'supersede', description: 'Replace recalled memory #ref (1-based) with a corrected fact when a result proves it wrong.', parameters: { type: 'object', properties: { ref: { type: 'integer' }, fact: { type: 'string' } }, required: ['ref', 'fact'] } },
  { name: 'done', description: 'Finish the task. Only call after a dispatch produced passing tests this run.', parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: [] } },
];

const PRICE_DIV = 1_000_000;
const MAX_READ_BYTES = 8_000;

/** Read a file inside the sandbox (path-traversal guarded, size-capped). */
function readSandboxFile(sandboxDir: string, rel: string): string {
  const root = resolve(sandboxDir);
  const full = resolve(root, rel);
  if (full !== root && !full.startsWith(root + sep)) return '(refused: path outside sandbox)';
  try {
    if (statSync(full).size > MAX_READ_BYTES * 4) return `(file too large; first ${MAX_READ_BYTES} bytes)\n` + readFileSync(full, 'utf8').slice(0, MAX_READ_BYTES);
    return readFileSync(full, 'utf8').slice(0, MAX_READ_BYTES);
  } catch (e) {
    return `(could not read ${rel}: ${(e as Error).message.slice(0, 80)})`;
  }
}

function renderRecalled(mems: RecalledMemory[]): string {
  return mems.length
    ? 'PRIOR DECISIONS/LEARNINGS (from memory — numbered; supersede by ref if wrong):\n' +
        mems.map((m, i) => `${i + 1}. [${m.concept}] ${m.content}`).join('\n')
    : 'No prior memory for this task.';
}

export async function runBrain(opts: {
  goal: BrainGoal;
  memory: Memory;
  brain: Provider;
  worker: Provider;
  sandboxDir: string;
  maxSteps?: number;
  workspace?: string;
  /** pluggable action tools (run_command, http_request, …, and later MCP tools) */
  tools?: ToolRegistry;
  /** lightly links this run's writes via a session= tag (entity-bridge boost) */
  session?: string;
  /** carried prior-session transcript for the long-context baseline arm (no AWM) */
  priorContext?: string;
  onEvent?: (type: string, data: Record<string, unknown>) => void;
}): Promise<BrainResult> {
  const { goal, memory, brain, worker, sandboxDir } = opts;
  const maxSteps = opts.maxSteps ?? 6;
  // Session linking: every write this run carries session=<id> (entity-bridge boost).
  memory.setSessionId(opts.session ?? `run-${goal.id}`);
  const emit = opts.onEvent ?? (() => {});
  const usage = { brainIn: 0, brainOut: 0, workerIn: 0, workerOut: 0 };
  const history: string[] = [];
  let dispatches = 0, reRecalls = 0, reads = 0, supersedes = 0;

  // Model router: if the worker is routed, pick the starting tier from the goal's
  // intent (deterministic) and let consecutive failures escalate cheap → strong.
  let consecWorkerFails = 0;
  const MAX_FETCH_FAILS = 2;
  if (worker instanceof RoutedProvider) worker.reset(classifyIntent(goal.goal));

  // Prime: recall prior decisions/learnings, scoped + FULL content (precise values).
  const recalled: RecalledMemory[] = memory.enabled
    ? await memory.recall(goal.goal, { limit: 5, workspace: opts.workspace, full: true })
    : [];
  emit('recall', { count: recalled.length, awm: memory.enabled });

  // Long-context baseline (arm D): the carried prior-session transcript stands in
  // for AWM recall. This is the realistic "just keep the history in context" path.
  const priorBlock = opts.priorContext
    ? `PRIOR SESSION (carried forward in context — reuse what was already learned):\n${opts.priorContext}`
    : renderRecalled(recalled);

  let parseFails = 0;
  let nudge = '';
  let steps = 0;
  for (; steps < maxSteps; steps++) {
    const memBlock = opts.priorContext ? priorBlock : renderRecalled(recalled);
    const prompt = [
      `GOAL: ${goal.goal}`,
      goal.constraint ? `HARD CONSTRAINT (must hold in the final code): ${goal.constraint}` : '',
      memBlock,
      history.length ? `WORK SO FAR:\n${history.join('\n')}` : 'No work yet.',
      nudge,
      'Call your next tool now.',
    ]
      .filter(Boolean)
      .join('\n\n');

    let out;
    try {
      const toolset = opts.tools ? [...BRAIN_TOOLS, ...opts.tools.defs()] : BRAIN_TOOLS;
      out = await brain.chat({ system: SYSTEM, messages: [{ role: 'user', content: prompt }], maxTokens: 700, tools: toolset });
    } catch (e) {
      history.push(`(brain call failed after retries: ${(e as Error).message.slice(0, 120)})`);
      break; // degrade gracefully — final grade still runs
    }
    usage.brainIn += out.usage.input;
    usage.brainOut += out.usage.output;

    // Prefer the NATIVE tool call (validated by the API); fall back to parsing JSON
    // from text only for providers/models that don't emit tool_calls.
    let action: Action | null = null;
    const tc = out.toolCalls?.[0];
    if (tc?.name) {
      action = { action: tc.name as Action['action'], ...tc.args } as Action;
      nudge = '';
    } else {
      try { action = parseJsonLoose<Action>(out.text); nudge = ''; } catch { action = null; }
    }
    if (!action || !action.action) {
      parseFails++;
      nudge = 'Call exactly ONE tool (dispatch / recall / read / supersede / done).';
      history.push('(no tool call returned; retrying)');
      if (parseFails >= 4) break;
      continue;
    }

    if (action.action === 'done') {
      // Guard against premature done: a recalled "SUCCESS" memory can trick the
      // model into thinking the (fresh, empty) sandbox already has the artifacts.
      if (dispatches === 0) {
        nudge = 'You have produced nothing yet (0 dispatches) and the sandbox starts EMPTY each run. Recalled successes are the APPROACH, not existing files. Dispatch the implementation before saying done.';
        history.push('(rejected premature done: no dispatch yet this run)');
        continue;
      }
      history.push(`done: ${action.summary ?? ''}`);
      break;
    }

    // Hybrid: targeted re-recall framed to the current sub-problem.
    if (action.action === 'recall' && action.query && memory.enabled) {
      reRecalls++;
      const more = await memory.recall(action.query, { limit: 5, workspace: opts.workspace, full: true });
      const fresh = more.filter((m) => !recalled.some((r) => r.id === m.id));
      recalled.push(...fresh);
      history.push(`recall("${action.query.slice(0, 60)}") -> ${fresh.length} new mem", total ${recalled.length}`);
      emit('recall', { count: recalled.length, awm: true, requery: action.query.slice(0, 80) });
      continue;
    }

    // Hybrid: read a sandbox file for ground truth (memory↔grep balance).
    if (action.action === 'read' && action.path) {
      reads++;
      const content = readSandboxFile(sandboxDir, action.path);
      history.push(`read(${action.path}):\n${content.slice(0, 1200)}`);
      emit('read', { path: action.path });
      continue;
    }

    // Hybrid: supersede a recalled memory the result proved wrong (keep memory fresh).
    if (action.action === 'supersede' && action.ref && action.fact && memory.enabled) {
      const target = recalled[action.ref - 1];
      if (target) {
        const newId = await memory.supersede(target.id, target.concept, action.fact, ['topic=coding', `task=${goal.id}`]);
        if (newId) {
          supersedes++;
          recalled[action.ref - 1] = { id: newId, concept: target.concept, content: action.fact, score: 1 };
          history.push(`superseded #${action.ref} ("${target.concept}") -> ${action.fact.slice(0, 80)}`);
          emit('supersede', { ref: action.ref, fact: action.fact.slice(0, 80) });
        }
      }
      continue;
    }

    // Pluggable action tool (run_command, http_request, …, and later MCP tools).
    if (opts.tools && opts.tools.has(action.action)) {
      const { action: _name, ...callArgs } = action as Record<string, unknown> & { action: string };
      const result = await opts.tools.call(action.action, callArgs as Record<string, unknown>, { sandboxDir });
      history.push(`tool ${action.action} -> ${result.slice(0, 400).replace(/\n/g, ' ')}`);
      emit('tool', { name: action.action, result: result.slice(0, 120) });
      continue;
    }

    if (action.action === 'dispatch' && action.instruction) {
      dispatches++;
      let wres;
      try {
        wres = await runWorker(worker, { instruction: action.instruction, testCmd: goal.testCmd, constraint: goal.constraint, protect: goal.protect }, sandboxDir);
      } catch (e) {
        history.push(`dispatch#${dispatches}: WORKER ERROR ${(e as Error).message.slice(0, 140)}`);
        emit('dispatch', { n: dispatches, instruction: action.instruction.slice(0, 160), pass: false });
        continue; // transient provider error — let the brain try again next step
      }
      usage.workerIn += wres.usage.input;
      usage.workerOut += wres.usage.output;
      const tierTag = worker instanceof RoutedProvider ? ` [${worker.getTier()}]` : '';
      history.push(`dispatch#${dispatches}${tierTag}: ${action.instruction.slice(0, 130)} -> ${wres.pass ? 'PASS' : 'FAIL'} | ${wres.output.slice(0, 200)}`);
      emit('dispatch', { n: dispatches, instruction: action.instruction.slice(0, 160), pass: wres.pass });

      // Escalation: repeated worker failures on the cheap tier → switch up. The
      // stronger model inherits all AWM context, so it doesn't restart.
      if (wres.pass) {
        consecWorkerFails = 0;
      } else if (worker instanceof RoutedProvider) {
        consecWorkerFails++;
        if (consecWorkerFails >= MAX_FETCH_FAILS && worker.escalate()) {
          history.push(`↑ escalated worker tier fetch→reason after ${consecWorkerFails} failures`);
          emit('escalate', { tier: 'reason', afterFails: consecWorkerFails });
          consecWorkerFails = 0;
        }
      }
      if (memory.enabled) {
        await memory.write(
          `${goal.id} ${wres.pass ? 'works' : 'fails'}: ${action.instruction.slice(0, 60)}`,
          `task ${goal.id}: ${wres.pass ? 'WORKED' : 'FAILED'} — ${wres.output.slice(0, 300)}`,
          ['topic=coding', `task=${goal.id}`, `intent=${wres.pass ? 'decision' : 'friction'}`, 'confidence_level=verified'],
          { eventType: wres.pass ? 'decision' : 'friction', surprise: wres.pass ? 0.3 : 0.6 },
        );
      }
      continue;
    }

    history.push('(invalid action shape)');
    nudge = 'Your last JSON had no valid "action". Use one of: dispatch, recall, read, supersede, done.';
    parseFails++;
    if (parseFails >= 4) break;
  }

  // Objective final grade — independent of the brain's claim.
  const grade = runCommand(goal.testCmd, sandboxDir, 60_000);
  const success = grade.code === 0;

  // Tier-aware cost: a routed provider bills each tier at its own price.
  const brainCost = brain instanceof RoutedProvider
    ? brain.spentUsd()
    : (usage.brainIn / PRICE_DIV) * brain.price[0] + (usage.brainOut / PRICE_DIV) * brain.price[1];
  const workerCost = worker instanceof RoutedProvider
    ? worker.spentUsd()
    : (usage.workerIn / PRICE_DIV) * worker.price[0] + (usage.workerOut / PRICE_DIV) * worker.price[1];
  const costUsd = brainCost + workerCost;

  // On success, distill the REUSABLE FACTS learned about the environment (API
  // contracts, gotchas, conventions) and persist them canonically — separate
  // from task-approach notes. This is what makes a DIFFERENT later task benefit
  // (mirrors USEA's schema auto-learning). Without it, recall returns
  // task-specific narrative that doesn't transfer.
  if (success && memory.enabled && dispatches > 0) {
    try {
      const lesson = await brain.chat({
        system:
          'Extract ONLY durable, reusable facts you learned about the environment/APIs/tools while doing this task — things that would help on a DIFFERENT but related task (API contracts, return shapes, error codes, gotchas, conventions). Output 1-4 terse bullet points of facts. No task-specific narrative, no code.',
        messages: [{ role: 'user', content: `GOAL: ${goal.goal}\n\nWORK LOG:\n${history.join('\n')}` }],
        maxTokens: 300,
      });
      usage.brainIn += lesson.usage.input;
      usage.brainOut += lesson.usage.output;
      const facts = lesson.text.trim();
      if (facts.length > 20) {
        await memory.write(`learned facts: ${goal.id}`, facts.slice(0, 700), ['topic=learning', 'kind=contract', 'intent=finding', 'confidence_level=observed'], {
          eventType: 'decision',
          canonical: true,
        });
        emit('learned', { facts: facts.slice(0, 160) });
      }
    } catch {
      /* non-fatal */
    }
  }

  // Persist the outcome so future runs recall what worked (smarter over time).
  if (memory.enabled) {
    await memory.write(
      `outcome: ${goal.id}`,
      `Goal "${goal.goal.slice(0, 80)}" -> ${success ? 'SUCCESS' : 'FAIL'} in ${dispatches} dispatch(es).`,
      ['topic=coding', `task=${goal.id}`, 'kind=outcome', 'intent=decision', `confidence_level=verified`],
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
    reRecalls,
    reads,
    supersedes,
    escalations: worker instanceof RoutedProvider ? worker.escalations : 0,
    workerTier: worker instanceof RoutedProvider ? worker.getTier() : worker.id,
    usage,
    costUsd: Number(costUsd.toFixed(6)),
    history,
  };
}
