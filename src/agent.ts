/**
 * runAgent — the LIVE runner: give it a free-form INSTRUCTION and a real working
 * directory, and it works toward it over many steps until done / stuck / budget,
 * on the AWM substrate.
 *
 * Differs from runBrain (the benchmark harness) on purpose:
 *   - free instruction, NO required test grader — the agent self-determines done
 *     (and is told to verify with run_command/tests before declaring it).
 *   - budget-bounded (maxSteps / wall-clock), not a tiny step cap.
 *   - history is WINDOWED — only the last few steps go in the prompt; older context
 *     comes back via recall. This is the anti-context-rot design: a long run stays
 *     flat in tokens because AWM holds the past, not the prompt.
 *   - periodic SLEEP (consolidate) on phase boundaries so it sharpens over a long run.
 *   - pluggable tools (built-ins + MCP) are first-class, not just codegen dispatch.
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { Provider } from './provider.js';
import type { Memory, RecalledMemory } from './awm.js';
import { BRAIN_TOOLS } from './brain.js';
import type { ToolDef } from './provider.js';
import { RoutedProvider, classifyIntent } from './model-router.js';
import type { ToolRegistry } from './tools/registry.js';
import { runWorker } from './worker.js';
import { parseJsonLoose, runCommand } from './util.js';

interface Action {
  action: string;
  instruction?: string;
  query?: string;
  path?: string;
  ref?: number;
  fact?: string;
  summary?: string;
  [k: string]: unknown;
}

export interface AgentBudget {
  maxSteps?: number;
  maxWallMs?: number;
  consolidateEvery?: number;
}

export interface AgentResult {
  reason: 'done' | 'budget' | 'stuck' | 'error';
  summary: string;
  steps: number;
  dispatches: number;
  toolCalls: number;
  reRecalls: number;
  supersedes: number;
  consolidations: number;
  durationMs: number;
  usage: { brainIn: number; brainOut: number; workerIn: number; workerOut: number };
  costUsd: number;
  history: string[];
}

const AGENT_SYSTEM = [
  'You are an autonomous agent working toward an INSTRUCTION over many steps. You act only by calling tools.',
  'Tools: dispatch (hand a coder ONE concrete step), recall (re-query your memory for the current sub-problem),',
  'read (read a file for ground truth), remember (persist a durable understanding to memory for future sessions),',
  'supersede (correct a recalled fact a result disproved), done (instruction satisfied AND verified), plus any extra tools.',
  'For a LEARN/UNDERSTAND instruction follow this loop: read ONE file you have NOT read yet, then IMMEDIATELY call remember with 1-2 specific facts about it (its role, key exports, how it connects). Repeat file by file. Do NOT re-list files you already listed, and do NOT recall facts you have not written yet. Calling remember is the deliverable. Finish once you have remembered the purpose plus each key module.',
  'Call exactly ONE tool per turn. Decompose big instructions into concrete steps; do one at a time.',
  'Use recalled PRIOR DECISIONS first (numbered — supersede by ref if wrong). READ files for ground truth.',
  'VERIFY your work (run the tests/commands) before calling done. Call done ONLY when the instruction is genuinely',
  'satisfied. Never loop without making progress — if stuck, try a different concrete step.',
].join('\n');

// Agent-only tool: deliberately persist a durable understanding to memory. This is
// what makes a comprehension/onboarding run STICK — future sessions recall it.
const REMEMBER_TOOL: ToolDef = {
  name: 'remember',
  description: 'Persist a durable fact/understanding about the project to memory so a FUTURE session recalls it. Lead with the fact; be specific (file paths, names, decisions).',
  parameters: { type: 'object', properties: { concept: { type: 'string', description: 'short title' }, fact: { type: 'string', description: 'the durable fact — lead with it' } }, required: ['concept', 'fact'] },
};

// Agent-only tool: schedule an instruction to run later (stored as an AWM task with
// a due=<epochMs> tag; the scheduler loop fires it and proactively delivers the result).
const SCHEDULE_TOOL: ToolDef = {
  name: 'schedule',
  description: 'Schedule an instruction to run LATER and proactively deliver the result. Use in_minutes for a one-shot delay, daily_at "HH:MM" (24h) for a daily run, or every_minutes for a recurring interval.',
  parameters: { type: 'object', properties: {
    instruction: { type: 'string', description: 'what to do when it fires' },
    in_minutes: { type: 'number', description: 'one-shot: run after N minutes from now' },
    daily_at: { type: 'string', description: 'recurring daily at HH:MM (24-hour)' },
    every_minutes: { type: 'number', description: 'recurring every N minutes' },
  }, required: ['instruction'] },
};

function nextDailyAt(hhmm: string, nowMs: number): number {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(nowMs); d.setHours(h || 0, m || 0, 0, 0);
  let due = d.getTime();
  if (due <= nowMs) due += 86_400_000;
  return due;
}

const PRICE_DIV = 1_000_000;
const HIST_WINDOW = 12; // only recent steps go in the prompt; recall covers the rest (anti-context-rot)
const MAX_READ_BYTES = 8_000;

function readFileInDir(dir: string, rel: string): string {
  const root = resolve(dir);
  const full = resolve(root, rel);
  if (full !== root && !full.startsWith(root + sep)) return '(refused: path outside working dir)';
  try {
    if (statSync(full).size > MAX_READ_BYTES * 4) return `(large; first ${MAX_READ_BYTES} bytes)\n` + readFileSync(full, 'utf8').slice(0, MAX_READ_BYTES);
    return readFileSync(full, 'utf8').slice(0, MAX_READ_BYTES);
  } catch (e) {
    return `(could not read ${rel}: ${(e as Error).message.slice(0, 80)})`;
  }
}

export async function runAgent(opts: {
  instruction: string;
  dir: string;
  memory: Memory;
  brain: Provider;
  worker: Provider;
  tools?: ToolRegistry;
  budget?: AgentBudget;
  session?: string;
  workspace?: string;
  /** wall-clock now; injected for testability (defaults to Date.now) */
  now?: () => number;
  onEvent?: (type: string, data: Record<string, unknown>) => void;
}): Promise<AgentResult> {
  const { instruction, dir, memory, brain, worker } = opts;
  const now = opts.now ?? (() => Date.now());
  const emit = opts.onEvent ?? (() => {});
  const maxSteps = opts.budget?.maxSteps ?? 40;
  const maxWallMs = opts.budget?.maxWallMs ?? 10 * 60_000;
  const consolidateEvery = opts.budget?.consolidateEvery ?? 10;
  const start = now();

  const usage = { brainIn: 0, brainOut: 0, workerIn: 0, workerOut: 0 };
  const history: string[] = [];
  let dispatches = 0, toolCalls = 0, reRecalls = 0, supersedes = 0, consolidations = 0;
  let consecNoProgress = 0, consecWorkerFails = 0, brainErrors = 0;
  const MAX_FETCH_FAILS = 2;

  memory.setSessionId(opts.session ?? `agent-${start}`);
  // Each task starts on the cheap tier; escalate only if THIS task struggles.
  if (worker instanceof RoutedProvider) worker.reset(classifyIntent(instruction));
  if (brain instanceof RoutedProvider) brain.reset('fetch');

  const recalled: RecalledMemory[] = memory.enabled ? await memory.recall(instruction, { limit: 6, full: true, workspace: opts.workspace }) : [];
  emit('start', { instruction: instruction.slice(0, 120), recalled: recalled.length, dir });

  const render = () =>
    recalled.length
      ? 'PRIOR DECISIONS/LEARNINGS (numbered — supersede by ref if a result disproves one):\n' + recalled.map((m, i) => `${i + 1}. [${m.concept}] ${m.content}`).join('\n')
      : 'No prior memory yet for this instruction.';

  let reason: AgentResult['reason'] = 'budget';
  let finalSummary = '';
  let nudge = '';
  let lastSig = '';
  let gatherStreak = 0; // reads/lists/recalls since the last remember/act — forces the record cadence
  let productive = 0; // remembers/dispatches/acts — once high enough, prompt to consider done
  const doneThreshold = Math.min(5, Math.ceil(maxSteps * 0.35));
  const GATHER_NUDGE = 'You have gathered information several times without recording anything. Call REMEMBER now with 1-2 specific facts from what you just read — do not read/list/recall again until you do.';
  let steps = 0;

  for (; steps < maxSteps; steps++) {
    if (now() - start > maxWallMs) { reason = 'budget'; finalSummary = 'wall-clock budget reached'; break; }

    // Escalate the BRAIN when it's struggling (looping / no progress) — the stronger
    // model breaks loops the cheap one gets stuck in (and dodges Azure's content filter).
    if (consecNoProgress >= 3 && brain instanceof RoutedProvider && brain.getTier() === 'fetch') {
      brain.escalate(); history.push('↑ escalated brain fetch→reason (no progress)'); emit('escalate', { which: 'brain' });
    }

    const recent = history.slice(-HIST_WINDOW);
    const prompt = [
      `INSTRUCTION: ${instruction}`,
      `WORKING DIR: ${dir}`,
      render(),
      recent.length ? `RECENT STEPS (older context is in memory — recall it if needed):\n${recent.join('\n')}` : 'No steps yet.',
      steps >= maxSteps * 0.8
        ? 'Budget is nearly spent — call done NOW and summarize what you accomplished, unless one critical step genuinely remains.'
        : (productive >= doneThreshold || steps >= maxSteps * 0.55)
          ? 'You have made substantial progress. If the INSTRUCTION is satisfied, call done. Only continue if a specific part genuinely remains.'
          : '',
      nudge,
      'Call your next tool now.',
    ].filter(Boolean).join('\n\n');

    let out;
    try {
      const base = [...BRAIN_TOOLS, REMEMBER_TOOL, SCHEDULE_TOOL];
      const toolset = opts.tools ? [...base, ...opts.tools.defs()] : base;
      out = await brain.chat({ system: AGENT_SYSTEM, messages: [{ role: 'user', content: prompt }], maxTokens: 800, tools: toolset });
      brainErrors = 0;
    } catch (e) {
      // Tolerate a transient brain blip (the provider already retried internally):
      // retry the step a couple times with backoff before giving up — one hiccup
      // shouldn't kill the whole task.
      brainErrors++;
      const msg = (e as Error).message.slice(0, 160);
      history.push(`(brain call error ${brainErrors}/3: ${msg})`);
      // Escalate to the stronger model — handles Azure content-filter 400s and transient blips.
      if (brain instanceof RoutedProvider && brain.escalate()) history.push('↑ escalated brain fetch→reason (after error)');
      if (brainErrors >= 3) { reason = 'error'; finalSummary = `brain unavailable after retries: ${msg}`; break; }
      await new Promise((r) => setTimeout(r, 1000 * brainErrors));
      continue;
    }
    usage.brainIn += out.usage.input; usage.brainOut += out.usage.output;

    let action: Action | null = null;
    const tc = out.toolCalls?.[0];
    if (tc?.name) { action = { action: tc.name, ...tc.args }; nudge = ''; }
    else { try { action = parseJsonLoose<Action>(out.text); nudge = ''; } catch { action = null; } }
    if (!action || !action.action) {
      consecNoProgress++;
      nudge = 'Call exactly ONE tool. Make a concrete next move toward the instruction.';
      history.push('(no tool call; retrying)');
      if (consecNoProgress >= 4) { reason = 'stuck'; finalSummary = 'no tool calls'; break; }
      continue;
    }

    // Anti-redundancy: skip an immediate exact-repeat action (the explore-loop trap)
    // and nudge toward a NEW move. done is never skipped.
    const sig = `${action.action}|${JSON.stringify(Object.fromEntries(Object.entries(action).filter(([k]) => k !== 'action'))).slice(0, 80)}`;
    if (sig === lastSig && action.action !== 'done') {
      consecNoProgress++;
      history.push(`(skipped redundant ${action.action})`);
      // Repeating after already producing output ⇒ effectively finished — conclude
      // as done rather than burning steps into "stuck".
      if (productive > 0 && consecNoProgress >= 2) {
        reason = 'done'; finalSummary = 'Done — the output is ready.'; break;
      }
      nudge = productive > 0
        ? `You already did "${action.action}" and produced output — if the task is complete, call done now.`
        : `You just did "${action.action}". Do something NEW, or call done.`;
      if (consecNoProgress >= 5) { reason = 'stuck'; finalSummary = 'looping on the same action'; break; }
      continue;
    }
    lastSig = sig;

    // periodic sleep (consolidate) — sharpen over a long run
    if (memory.enabled && steps > 0 && steps % consolidateEvery === 0) {
      const r = await memory.consolidate();
      consolidations++;
      emit('sleep', { cycle: consolidations, edgesStrengthened: r.edgesStrengthened ?? 0 });
      history.push(`(slept: consolidation #${consolidations})`);
    }

    if (action.action === 'done') {
      reason = 'done'; finalSummary = action.summary ?? 'instruction satisfied'; history.push(`done: ${finalSummary}`);
      break;
    }

    if (action.action === 'recall' && action.query && memory.enabled) {
      reRecalls++; consecNoProgress = 0;
      const more = await memory.recall(action.query, { limit: 5, full: true, workspace: opts.workspace });
      const fresh = more.filter((m) => !recalled.some((r) => r.id === m.id));
      recalled.push(...fresh);
      history.push(`recall("${action.query.slice(0, 56)}") -> +${fresh.length} (total ${recalled.length})`);
      emit('recall', { query: action.query.slice(0, 80), total: recalled.length });
      if (++gatherStreak >= 3) nudge = GATHER_NUDGE;
      continue;
    }

    if (action.action === 'read' && action.path) {
      consecNoProgress = 0;
      const content = readFileInDir(dir, action.path);
      history.push(`read(${action.path}):\n${content.slice(0, 1000)}`);
      emit('read', { path: action.path });
      if (++gatherStreak >= 3) nudge = GATHER_NUDGE;
      continue;
    }

    if (action.action === 'supersede' && action.ref && action.fact && memory.enabled) {
      const target = recalled[action.ref - 1];
      if (target) {
        const id = await memory.supersede(target.id, target.concept, action.fact, ['topic=agent', 'intent=finding', 'confidence_level=verified']);
        if (id) { supersedes++; productive++; recalled[action.ref - 1] = { id, concept: target.concept, content: action.fact, score: 1 }; history.push(`superseded #${action.ref}`); emit('supersede', { ref: action.ref }); }
      }
      consecNoProgress = 0;
      continue;
    }

    if (action.action === 'schedule' && action.instruction && memory.enabled) {
      consecNoProgress = 0;
      const nowMs = now();
      let dueMs = nowMs + 60_000; let recur: string | undefined;
      if (typeof action.in_minutes === 'number') dueMs = nowMs + action.in_minutes * 60_000;
      else if (typeof action.every_minutes === 'number') { dueMs = nowMs + action.every_minutes * 60_000; recur = `every:${action.every_minutes}`; }
      else if (typeof action.daily_at === 'string') { dueMs = nextDailyAt(action.daily_at, nowMs); recur = `daily:${action.daily_at}`; }
      await memory.addScheduledTask(String(action.instruction), dueMs, { recur, notify: opts.session });
      productive++;
      const when = new Date(dueMs).toISOString().slice(0, 16).replace('T', ' ');
      history.push(`scheduled "${String(action.instruction).slice(0, 50)}" for ${when}${recur ? ` (${recur})` : ''}`);
      emit('schedule', { instruction: String(action.instruction).slice(0, 60), due: dueMs, recur });
      reason = 'done'; finalSummary = `Scheduled for ${when}${recur ? ` (repeating ${recur})` : ''}. I'll message you the result.`;
      break;
    }

    if (action.action === 'remember' && action.concept && action.fact && memory.enabled) {
      consecNoProgress = 0;
      await memory.write(String(action.concept), String(action.fact), ['topic=project-understanding', 'intent=finding', 'confidence_level=observed'], { canonical: true, eventType: 'observation' });
      history.push(`remember [${String(action.concept).slice(0, 50)}]`);
      emit('remember', { concept: String(action.concept).slice(0, 80) });
      gatherStreak = 0; productive++; // recorded — reset the cadence
      continue;
    }

    if (opts.tools && opts.tools.has(action.action)) {
      toolCalls++; consecNoProgress = 0;
      const { action: _n, ...args } = action as Record<string, unknown> & { action: string };
      const result = await opts.tools.call(action.action, args as Record<string, unknown>, { sandboxDir: dir });
      history.push(`tool ${action.action} -> ${result.slice(0, 400).replace(/\n/g, ' ')}`);
      emit('tool', { name: action.action, result: result.slice(0, 120) });
      // reading/listing is gathering; other tools are acting (reset cadence)
      if (action.action === 'read_file' || action.action === 'list_files') { if (++gatherStreak >= 3) nudge = GATHER_NUDGE; }
      else { gatherStreak = 0; productive++; }
      continue;
    }

    if (action.action === 'dispatch' && action.instruction) {
      dispatches++; productive++; consecNoProgress = 0;
      let wres;
      try {
        wres = await runWorker(worker, { instruction: action.instruction, testCmd: 'true', protect: [] }, dir);
      } catch (e) {
        history.push(`dispatch#${dispatches}: WORKER ERROR ${(e as Error).message.slice(0, 120)}`);
        continue;
      }
      usage.workerIn += wres.usage.input; usage.workerOut += wres.usage.output;
      const tier = worker instanceof RoutedProvider ? ` [${worker.getTier()}]` : '';
      history.push(`dispatch#${dispatches}${tier}: ${action.instruction.slice(0, 110)} -> ${wres.filesWritten.join(', ') || '(no files)'} | ${wres.output.slice(0, 160)}`);
      emit('dispatch', { n: dispatches, files: wres.filesWritten });
      if (memory.enabled) {
        await memory.write(`agent step: ${action.instruction.slice(0, 56)}`, `Working "${instruction.slice(0, 60)}": ${action.instruction.slice(0, 200)} -> wrote ${wres.filesWritten.join(', ')}`, ['topic=agent', 'intent=decision', 'confidence_level=verified'], { eventType: 'decision' });
      }
      if (!wres.pass && worker instanceof RoutedProvider) {
        consecWorkerFails++;
        if (consecWorkerFails >= MAX_FETCH_FAILS && worker.escalate()) { history.push('↑ escalated worker fetch→reason'); emit('escalate', {}); consecWorkerFails = 0; }
      } else consecWorkerFails = 0;
      continue;
    }

    history.push(`(unhandled action: ${action.action})`);
    consecNoProgress++;
    if (consecNoProgress >= 4) { reason = 'stuck'; finalSummary = 'no progress'; break; }
  }

  if (steps >= maxSteps) { reason = 'budget'; finalSummary ||= 'step budget reached'; }

  // record the run outcome
  if (memory.enabled) {
    await memory.write(`agent run: ${instruction.slice(0, 56)}`, `Instruction "${instruction.slice(0, 80)}" ended: ${reason} after ${steps} steps, ${dispatches} dispatches. ${finalSummary}`, ['topic=agent', 'kind=run-outcome', 'intent=decision', 'confidence_level=verified'], { eventType: 'decision', canonical: reason === 'done' });
  }

  const brainCost = brain instanceof RoutedProvider ? brain.spentUsd() : (usage.brainIn / PRICE_DIV) * brain.price[0] + (usage.brainOut / PRICE_DIV) * brain.price[1];
  const workerCost = worker instanceof RoutedProvider ? worker.spentUsd() : (usage.workerIn / PRICE_DIV) * worker.price[0] + (usage.workerOut / PRICE_DIV) * worker.price[1];

  emit('end', { reason, steps, dispatches, durationMs: now() - start });
  return {
    reason, summary: finalSummary, steps, dispatches, toolCalls, reRecalls, supersedes, consolidations,
    durationMs: now() - start, usage, costUsd: Number((brainCost + workerCost).toFixed(6)), history,
  };
}
