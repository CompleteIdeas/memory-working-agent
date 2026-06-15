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
import { readFileSync, statSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, sep, dirname, join } from 'node:path';
import type { Provider } from './provider.js';
import type { Memory, RecalledMemory } from './awm.js';
import { BRAIN_TOOLS } from './brain.js';
import type { ToolDef } from './provider.js';
import { RoutedProvider, classifyIntent, startTier } from './model-router.js';
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
  'If the request is genuinely AMBIGUOUS or needs information only the user has (which item, a date, a preference, the scope), call ask_user ONCE with a specific question BEFORE guessing. If you can proceed reasonably, do the work instead of asking. Do not ask more than necessary.',
  'For a CODING / programming task: write files with write_file, run and test them with run_command (node, python, npm, build, etc.), or dispatch a concrete coding step to the coder. ALWAYS run it and check the actual output before calling done — never claim code works without running it.',
  'To read a document or PDF (a file path or a URL), use read_document — it extracts the real text. HONESTY: never claim you read a file/PDF, state a document\'s contents, or claim a capability unless you actually used the tool this turn. Do not invent file contents.',
  'When asked to ANALYZE, infer, or give your assessment (e.g. people\'s roles, what something means), DO the reasoned analysis from the evidence you have and clearly mark what is inferred vs explicitly stated. Do not refuse or punt if you have relevant material to reason from — honesty means labeling inferences, not withholding them.',
  'ACTIONS REQUIRE THE TOOL: to draft an email you MUST call draft_email (it creates a real Gmail DRAFT in the connected account; it never sends). To schedule, call schedule. NEVER say you drafted, sent, scheduled, or saved something unless that tool call returned success THIS turn — writing the email text in your reply is NOT drafting it. If you are missing the recipient or details, get them from the thread (read_email) or ask_user first, then call draft_email.',
  'The PRIOR KNOWLEDGE block is auto-recalled from YOUR memory each turn — read it FIRST and USE it. If it already answers part of the request, do NOT search or look it up again; only act on what is genuinely missing. Supersede a numbered item by ref if a result disproves it.',
  'COMPLETE EVERY PART: if the instruction asks for more than one thing (e.g. create TWO files, list AND enable a connector, find X AND draft Y), actually DO each one with its tool before calling done. Do not stop after the first part, and never call done while describing a remaining action as "the next step" — take that step.',
  'BE CONCISE: when you call done, lead with the answer and keep the summary tight — no preamble, no restating the question, no filler. A few sentences or a short list, not an essay. Do your reasoning in your head, not on the page.',
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

// Agent tool: ask the USER a clarifying question when the request is ambiguous or needs
// info only they have. The turn ends and waits for their reply (the chat is multi-turn).
const ASK_USER_TOOL: ToolDef = {
  name: 'ask_user',
  description: 'Ask the USER ONE specific clarifying question when the request is ambiguous or needs information only they have (which item they mean, a date, a preference, scope). Use SPARINGLY — only when you genuinely cannot proceed well without it; otherwise make a reasonable assumption and do the work. The turn ends and waits for their answer.',
  parameters: { type: 'object', properties: { question: { type: 'string', description: 'one specific question for the user' } }, required: ['question'] },
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

/** Append one line to the run log (JSONL) — the record reviewed to iterate on quality. */
function appendRunLog(entry: Record<string, unknown>): void {
  try {
    const p = process.env.MWA_RUNLOG ?? resolve('./data/runs.jsonl');
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(entry) + '\n');
  } catch { /* logging is best-effort */ }
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
  /** is a human watching who can answer a clarifying question? web/telegram = true;
   *  mailbox/scheduled/ingest = false (then ask_user → note it + assume + proceed). */
  interactive?: boolean;
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
  let learnedFacts = 0, skillsDerived = 0, openQuestions = 0; // for the run log + self-learning loop
  let consecNoProgress = 0, consecWorkerFails = 0, brainErrors = 0, incompleteRejections = 0;
  const MAX_FETCH_FAILS = 2;

  memory.setSessionId(opts.session ?? `agent-${start}`);
  // Cheap-first for ordinary work; complex/long tasks start the conductor on the strong
  // tier (the cheap tier under-delivers / quits early on long-horizon work), and the
  // worker follows its own intent classification. Escalation below still earns upgrades.
  if (worker instanceof RoutedProvider) worker.reset(classifyIntent(instruction));
  const brainStart = startTier(instruction);
  if (brain instanceof RoutedProvider) brain.reset(brainStart);

  const PRIME_K = 10; // cap on primed memories kept in the prompt (anti-context-rot)
  const recalled: RecalledMemory[] = memory.enabled ? await memory.recall(instruction, { limit: 8, full: true, workspace: opts.workspace }) : [];
  emit('start', { instruction: instruction.slice(0, 120), recalled: recalled.length, dir });

  // Auto-PRIME: pull memory relevant to a context into the prompt set, keeping only the
  // top-K by relevance. Called at start (above) and silently re-run as the task evolves,
  // so the model leans on what it already knows instead of re-deriving / re-searching.
  async function prime(ctx: string): Promise<number> {
    if (!memory.enabled) return 0;
    const more = await memory.recall(ctx, { limit: 6, full: true, workspace: opts.workspace });
    const fresh = more.filter((m) => !recalled.some((r) => r.id === m.id));
    if (fresh.length) {
      recalled.push(...fresh);
      recalled.sort((a, b) => b.score - a.score);
      if (recalled.length > PRIME_K) recalled.length = PRIME_K;
    }
    return fresh.length;
  }

  const render = () =>
    recalled.length
      ? 'PRIOR KNOWLEDGE (recalled from your memory — use it; supersede by ref if a result disproves one):\n' + recalled.map((m, i) => `${i + 1}. [${m.concept}] ${m.content}`).join('\n')
      : 'No prior memory yet for this request.';

  let reason: AgentResult['reason'] = 'budget';
  let finalSummary = '';
  let modelAnswered = false; // true only when the model gave a real answer (done w/ summary, or schedule)
  let askedUser = false; // the turn ended by asking the user a clarifying question
  let nudge = '';
  let lastSig = '';
  const toolUses = new Map<string, number>(); // tool name -> times called this run
  const lastToolResult = new Map<string, string>(); // tool name -> its previous result (detect no-new-info loops)
  const recalledQueries = new Set<string>(); // normalized recall queries this run — kills the re-ask-memory loop
  const rememberedConcepts = new Set<string>(); // normalized remember concepts this run — kills duplicate writes
  const toolSigs = new Set<string>(); // exact (tool+args) calls already made — kills identical retries
  const normSig = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  let gatherStreak = 0; // reads/lists/recalls since the last remember/act — forces the record cadence
  let productive = 0; // remembers/dispatches/acts — once high enough, prompt to consider done
  const doneThreshold = Math.min(5, Math.ceil(maxSteps * 0.35));
  const LONG_TASK_STEPS = 8; // a run this many conductor-steps deep = long-horizon → escalate
  const GATHER_NUDGE = 'You have gathered information several times without recording anything. Call REMEMBER now with 1-2 specific facts from what you just read — do not read/list/recall again until you do.';
  // Named output files the instruction asked the agent to PRODUCE (write/create/save … X.ext,
  // or "to X.ext") — verified to actually exist before we accept `done`, catching "it's ready"
  // claims with no file. Conservative: only filenames in a produce-context.
  const expectedOutputs = (() => {
    const out = new Set<string>();
    const ext = '(?:md|json|jsonl|csv|html?|txt|js|mjs|cjs|ts|tsx|py|css|ya?ml|xml|svg)';
    const re1 = new RegExp(`\\b(?:write|writes|writing|create|creates|creating|save|saved|saving|produce|generate|generates|output|outputs|build|builds|make|makes)\\b[\\s\\S]{0,40}?\\b([\\w][\\w./-]*\\.${ext})\\b`, 'gi');
    const re2 = new RegExp(`\\bto\\s+([\\w][\\w./-]*\\.${ext})\\b`, 'gi');
    for (const re of [re1, re2]) { let m: RegExpExecArray | null; while ((m = re.exec(instruction))) out.add(m[1]); }
    return [...out];
  })();
  let steps = 0;

  for (; steps < maxSteps; steps++) {
    if (now() - start > maxWallMs) { reason = 'budget'; finalSummary = 'wall-clock budget reached'; break; }

    // Escalate the BRAIN when it's struggling (looping / no progress) — the stronger
    // model breaks loops the cheap one gets stuck in (and dodges Azure's content filter).
    if (consecNoProgress >= 3 && brain instanceof RoutedProvider && brain.getTier() === 'fetch') {
      brain.escalate(); history.push('↑ escalated brain fetch→reason (no progress)'); emit('escalate', { which: 'brain', reason: 'no-progress' });
    }
    // Long-running task → upgrade even when it ISN'T stuck: a run this many conductor-steps
    // deep is long-horizon work, where the cheap tier under-delivers; give it the strong
    // model to finish coherently (it inherits all the AWM context, so the switch is cheap).
    else if (steps >= LONG_TASK_STEPS && brain instanceof RoutedProvider && brain.getTier() === 'fetch') {
      brain.escalate(); history.push('↑ escalated brain fetch→reason (long task)'); emit('escalate', { which: 'brain', reason: 'long-task' });
    }
    // Hard stop on a no-progress spiral (e.g. recall↔search over and over with no new
    // info). The escalated model gets a few tries first; then we stop and answer below.
    if (consecNoProgress >= 6) { reason = 'stuck'; finalSummary = 'I kept looking but stopped making progress.'; break; }

    // Auto-PRIME: right after the agent gathered new external info (a tool/read/dispatch
    // result), silently pull in memory relevant to it — so the next move leans on what we
    // already know rather than re-searching. Cheap (local recall, no model call).
    if (memory.enabled && steps > 0) {
      const last = history[history.length - 1] ?? '';
      if (/^(tool |read\(|dispatch#)/.test(last)) {
        const added = await prime(`${instruction}\n${last}`.slice(0, 400));
        if (added) history.push(`(auto-primed +${added})`); // silent — background priming shouldn't clutter the feed
      }
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
      const base = [...BRAIN_TOOLS, REMEMBER_TOOL, SCHEDULE_TOOL, ASK_USER_TOOL];
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
      const summ = action.summary ? String(action.summary) : '';
      // Reject a "done" whose OWN summary admits unfinished work ("I didn't finish X",
      // "the next step is to add Y") — the model stopping short of a requested deliverable.
      // Normalize markdown first (summaries use **bold**). Cap rejections to avoid spinning.
      const norm = summ.replace(/[*_`#>]/g, '');
      const admitsUnfinished = /\b(did\s?n.?t (finish|complete|create|add|write|build|get to)|have\s?n.?t (finish|complet|add|creat)|still (need|have) to (finish|create|add|write|build|do)|next step is to (add|create|write|finish|build|make)|not yet (finish|complet|creat|don)|remaining (file|step|task|item)|i.?ll (add|create|finish|build) (it|that|the))\b/i.test(norm);
      // Requested output files that don't actually exist → the agent claimed completion
      // ("the output is ready") without producing the file. Make it really write them.
      const missingOutputs = expectedOutputs.filter((f) => { try { return !existsSync(join(dir, f)); } catch { return false; } });
      if ((admitsUnfinished || missingOutputs.length) && incompleteRejections < 2 && now() - start < maxWallMs * 0.8) {
        incompleteRejections++;
        consecNoProgress = 0; // it IS progressing, just stopping short — don't trip the stuck guard
        nudge = missingOutputs.length
          ? `You called done but did NOT create the file(s) asked for: ${missingOutputs.join(', ')}. STOP gathering — call write_file RIGHT NOW to write ${missingOutputs.length > 1 ? 'them' : 'it'} with what you already have (it's fine if not perfect), THEN done. A summary is not the deliverable.`
          : `Your summary admits work is still unfinished ("${norm.slice(0, 80)}…"). Do NOT call done while a requested part remains — take that next step now and actually produce it. Only call done once everything the instruction asked for truly exists.`;
        history.push(`(rejected premature done — ${missingOutputs.length ? 'missing output file(s): ' + missingOutputs.join(',') : 'admitted unfinished work'})`);
        continue;
      }
      reason = 'done';
      finalSummary = summ || 'instruction satisfied';
      modelAnswered = Boolean(summ.trim());
      history.push(`done: ${finalSummary}`);
      break;
    }

    if (action.action === 'ask_user' && action.question) {
      const question = String(action.question);
      if (opts.interactive) {
        // A human is watching — ask them and wait for their reply (the chat is multi-turn).
        reason = 'done'; finalSummary = question; modelAnswered = true; askedUser = true;
        history.push(`asked user: ${question.slice(0, 80)}`);
        emit('ask', { question: question.slice(0, 120) });
        break;
      }
      // No one to ask (mailbox/scheduled/ingest) — note the question for later, make a
      // reasonable assumption, and keep going. Feeds the self-learning resolve queue.
      if (memory.enabled) { await memory.saveQuestion(question); openQuestions++; emit('question', { question: question.slice(0, 100) }); }
      history.push(`(no user to ask; noted "${question.slice(0, 60)}" — proceeding on a best assumption)`);
      nudge = `No one is available to answer "${question}". State your best reasonable assumption in one line and CONTINUE the task — do not ask again; it's noted for later.`;
      consecNoProgress++; // guard against repeated asking
      continue;
    }

    if (action.action === 'recall' && action.query && memory.enabled) {
      // Re-asking memory the same thing is the #1 thrash pattern — and recall looks
      // "fresh" because the agent's OWN mid-run writes become recallable. Block repeats
      // and push toward a real action. (Auto-prime already keeps memory in the prompt.)
      const qsig = normSig(String(action.query));
      if (recalledQueries.has(qsig)) {
        consecNoProgress++;
        nudge = 'You already recalled that. Stop re-asking your memory — take a concrete action (web_search, read, draft) or call done with what you have.';
        history.push(`(skipped repeat recall "${String(action.query).slice(0, 40)}")`);
        continue;
      }
      recalledQueries.add(qsig);
      reRecalls++;
      const more = await memory.recall(action.query, { limit: 5, full: true, workspace: opts.workspace });
      const fresh = more.filter((m) => !recalled.some((r) => r.id === m.id));
      recalled.push(...fresh);
      if (recalled.length > PRIME_K) { recalled.sort((a, b) => b.score - a.score); recalled.length = PRIME_K; }
      history.push(`recall("${action.query.slice(0, 56)}") -> +${fresh.length} (total ${recalled.length})`);
      emit('recall', { query: action.query.slice(0, 80), total: recalled.length });
      // Recall is gathering, NOT task progress — don't reset the no-progress counter, and
      // don't push the "call remember" nudge (that caused re-remembering the same fact).
      if (fresh.length === 0) {
        consecNoProgress++;
        nudge = 'That recall turned up nothing new. Take a concrete action (web_search, read, draft), or call done with what you have.';
      }
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
      modelAnswered = true;
      break;
    }

    if (action.action === 'remember' && action.concept && action.fact && memory.enabled) {
      // Block re-saving the same fact (the agent re-remembers "X" over and over) — that's
      // not progress and floods the activity feed.
      const csig = normSig(String(action.concept));
      if (rememberedConcepts.has(csig)) {
        consecNoProgress++;
        nudge = 'You already saved that. Move on — take the next concrete action or call done.';
        history.push(`(skipped dup remember "${String(action.concept).slice(0, 40)}")`);
        continue;
      }
      rememberedConcepts.add(csig);
      consecNoProgress = 0;
      await memory.write(String(action.concept), String(action.fact), ['topic=project-understanding', 'intent=finding', 'confidence_level=observed'], { canonical: true, eventType: 'observation' });
      history.push(`remember [${String(action.concept).slice(0, 50)}]`);
      emit('remember', { concept: String(action.concept).slice(0, 80) });
      gatherStreak = 0; productive++; // recorded — reset the cadence
      continue;
    }

    if (opts.tools && opts.tools.has(action.action)) {
      toolCalls++;
      const { action: _n, ...args } = action as Record<string, unknown> & { action: string };
      const result = await opts.tools.call(action.action, args as Record<string, unknown>, { sandboxDir: dir, interactive: opts.interactive });
      // Keep enough of the result for the model to actually USE it — read_email/read_document
      // return long documents (a full email thread, a PDF); 400 chars hid the answer.
      history.push(`tool ${action.action} -> ${result.slice(0, 6000).replace(/\n/g, ' ')}`);
      emit('tool', { name: action.action, result: result.slice(0, 120) });
      const uses = (toolUses.get(action.action) ?? 0) + 1; toolUses.set(action.action, uses);
      const repeatedResult = lastToolResult.get(action.action) === result; lastToolResult.set(action.action, result);
      const refused = /^\((refused|could not read|could not write|unknown tool|tool .+ failed)/i.test(result.trimStart());
      const sig = `${action.action}:${JSON.stringify(args)}`.slice(0, 200);
      const dupCall = toolSigs.has(sig); toolSigs.add(sig);
      const refusedAgain = refused && dupCall; // a deterministic "no" we already hit — retrying is pointless
      // A refused/failed call, an EXACT-duplicate call, a same-as-last result, or a tool
      // hammered many times is not progress — steer to a different approach or to conclude
      // rather than retrying the same thing (e.g. re-running a refused command).
      if (refused || dupCall || repeatedResult || uses >= 5) {
        consecNoProgress++;
        nudge = refused
          ? `"${action.action}" was REFUSED — you did NOT get any result (${result.slice(0, 90).replace(/\n/g, ' ')}). Do NOT invent, guess, or state what the output "would be". Either do something genuinely different, or call done and tell the user plainly that you couldn't do it (and why).`
          : dupCall
          ? `You already made that exact "${action.action}" call with the same arguments — no new information. Do something different, or call done.`
          : repeatedResult
          ? `"${action.action}" returned the same result again — that's not new information. Answer with what you have, or call done (it's fine to say you couldn't find it). Do NOT repeat the same search.`
          : `You've used "${action.action}" ${uses} times. Stop and give your answer with what you found so far, or call done — including "I couldn't find it" if that's the truth.`;
        // A refusal is permanent — retrying the same refused call won't change it. Stop after
        // the second identical refusal and let the finalizer give an honest "I couldn't" answer.
        if (refusedAgain) { reason = 'done'; history.push('(refused twice on the same call — concluding honestly)'); break; }
      } else {
        consecNoProgress = 0;
        if (action.action === 'read_file' || action.action === 'list_files') { if (++gatherStreak >= 3) nudge = GATHER_NUDGE; }
        else { gatherStreak = 0; productive++; }
      }
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

  // If the model didn't give a real answer (budget/stuck, or a generic redundancy-break
  // "done"), make ONE final call to turn what we found into a plain, direct reply — or an
  // honest "couldn't find it + next step". The difference between a dead end and help.
  if (!modelAnswered) {
    try {
      const fin = await brain.chat({
        system: 'You are wrapping up a task for a non-technical person. Using ONLY what was found below, give a brief, direct answer to their request in plain language. If something could not be found or finished, say so honestly in one line and suggest a sensible next step. No jargon, no tool names.',
        messages: [{ role: 'user', content: `THEIR REQUEST: ${instruction}\n\nWHAT I DID / FOUND (most recent last):\n${history.slice(-24).join('\n')}\n\nWrite the answer now.` }],
        maxTokens: 400,
      });
      usage.brainIn += fin.usage.input; usage.brainOut += fin.usage.output;
      if (fin.text?.trim()) finalSummary = fin.text.trim();
    } catch { /* keep the terse summary */ }
  }

  // Auto-LEARN — the harness OWNS persistence. The model rarely calls `remember` on its
  // own (it just answers), so after any run that actually gathered something, extract the
  // durable facts and write them. This is what makes knowledge COMPOUND: people, topics,
  // commitments learned today are recalled instantly tomorrow. Emits `remember` events so
  // the user watches it learn (and the memory meter climbs). Best-effort; never fails a run.
  if (memory.enabled && toolCalls > 0 && !askedUser) {
    try {
      const learn = await brain.chat({
        system: 'Extract ONLY durable facts about the USER\'S WORLD that will help answer FUTURE requests: people and their role/relationship, organizations or groups, recurring topics/projects, commitments, dates/deadlines, stated preferences and decisions. STRICT EXCLUSIONS — never store: anything about your own tools, workspace, files, or search process; transient status ("couldn\'t find X", "workspace empty", "snippet cut off"); or one-off trivia. If a fact would not matter next week, skip it. Output ONLY JSON: {"facts":[{"concept":"short title (3-8 words)","content":"the fact, lead with it; include names/dates/specifics"}]}. Return 0 to 6 facts — fewer is better; return [] if nothing meets the bar.',
        messages: [{ role: 'user', content: `REQUEST: ${instruction}\n\nWHAT HAPPENED:\n${history.slice(-30).join('\n')}\n\nANSWER GIVEN:\n${finalSummary}` }],
        maxTokens: 700,
      });
      usage.brainIn += learn.usage.input; usage.brainOut += learn.usage.output;
      const parsed = parseJsonLoose<{ facts?: { concept?: string; content?: string }[] }>(learn.text);
      let learned = 0;
      for (const f of parsed?.facts ?? []) {
        if (!f?.concept || !f?.content) continue;
        const id = await memory.write(String(f.concept).slice(0, 80), String(f.content), ['topic=world', 'intent=finding', 'confidence_level=observed'], { canonical: true, eventType: 'observation' });
        if (id) { learned++; emit('remember', { concept: String(f.concept).slice(0, 80) }); }
        if (learned >= 6) break;
      }
      learnedFacts = learned;
      if (learned) history.push(`auto-learned ${learned} durable fact(s)`);
    } catch { /* learning is best-effort */ }
  }

  // Auto-derive a SKILL (procedural memory) from procedural runs — a SEPARATE focused call
  // (the cheap model reliably omits a "skill" field when also asked for facts). Harness-owned;
  // recalled by auto-prime on similar future tasks so the agent reuses HOW it solved it.
  if (memory.enabled && (dispatches > 0 || toolCalls >= 3) && !askedUser) {
    try {
      const sk = await brain.chat({
        system: 'A task was just completed using tools. If it followed a REPEATABLE procedure that would help on similar future requests, output ONLY JSON {"name":"short skill name (e.g. \'triage scouting inbox\')","steps":"numbered how-to a future run can follow"}. If it was a trivial one-off, output exactly {}.',
        messages: [{ role: 'user', content: `REQUEST: ${instruction}\n\nSTEPS TAKEN:\n${history.slice(-24).join('\n')}` }],
        maxTokens: 400,
      });
      usage.brainIn += sk.usage.input; usage.brainOut += sk.usage.output;
      const s = parseJsonLoose<{ name?: string; steps?: string }>(sk.text);
      if (s?.name && s?.steps) {
        const sid = await memory.saveSkill(String(s.name), String(s.steps));
        if (sid) { skillsDerived++; emit('remember', { concept: `skill: ${String(s.name)}`.slice(0, 80) }); history.push(`learned skill "${String(s.name).slice(0, 40)}"`); }
      }
    } catch { /* best-effort */ }
  }

  // SELF-LEARNING LOOP — note UNKNOWNS this run surfaced (missing info, things it couldn't
  // find) as open questions to resolve LATER (USEA pattern). Harness-derived (separate
  // focused call) → intent=question/status=open memories the user (or a resolve pass) acts on.
  if (memory.enabled && toolCalls > 0 && !askedUser) {
    try {
      const q = await brain.chat({
        system: 'Based on the work below, list UNKNOWNS this task surfaced that are worth answering LATER — missing info, things you could not find, useful follow-ups. Output ONLY JSON {"questions":["short specific question", ...]} with 0 to 3 items. Output {"questions":[]} if nothing is open.',
        messages: [{ role: 'user', content: `REQUEST: ${instruction}\n\nWHAT HAPPENED:\n${history.slice(-24).join('\n')}\n\nANSWER:\n${finalSummary}` }],
        maxTokens: 300,
      });
      usage.brainIn += q.usage.input; usage.brainOut += q.usage.output;
      const qs = parseJsonLoose<{ questions?: string[] }>(q.text)?.questions ?? [];
      for (const question of qs.slice(0, 3)) {
        if (typeof question === 'string' && question.trim().length > 8) {
          const id = await memory.saveQuestion(question.trim());
          if (id) { openQuestions++; emit('question', { question: question.trim().slice(0, 100) }); }
        }
      }
      if (openQuestions) history.push(`noted ${openQuestions} open question(s)`);
    } catch { /* best-effort */ }
  }

  // record the run outcome
  if (memory.enabled) {
    await memory.write(`agent run: ${instruction.slice(0, 56)}`, `Instruction "${instruction.slice(0, 80)}" ended: ${reason} after ${steps} steps, ${dispatches} dispatches. ${finalSummary}`, ['topic=agent', 'kind=run-outcome', 'intent=decision', 'confidence_level=verified'], { eventType: 'decision', canonical: reason === 'done' });
  }

  const brainCost = brain instanceof RoutedProvider ? brain.spentUsd() : (usage.brainIn / PRICE_DIV) * brain.price[0] + (usage.brainOut / PRICE_DIV) * brain.price[1];
  const workerCost = worker instanceof RoutedProvider ? worker.spentUsd() : (usage.workerIn / PRICE_DIV) * worker.price[0] + (usage.workerOut / PRICE_DIV) * worker.price[1];

  appendRunLog({
    ts: start, session: opts.session ?? '', instruction: instruction.slice(0, 160), reason,
    steps, dispatches, toolCalls, reRecalls, supersedes, consolidations,
    learned: learnedFacts, skills: skillsDerived, questions: openQuestions,
    durationMs: now() - start, costUsd: Number((brainCost + workerCost).toFixed(4)), summary: finalSummary.slice(0, 200),
  });
  emit('end', { reason, steps, dispatches, durationMs: now() - start });
  return {
    reason, summary: finalSummary, steps, dispatches, toolCalls, reRecalls, supersedes, consolidations,
    durationMs: now() - start, usage, costUsd: Number((brainCost + workerCost).toFixed(6)), history,
  };
}
