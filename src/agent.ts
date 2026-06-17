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
import { RoutedProvider, classifyIntent, startTier, isComplexTask } from './model-router.js';
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
  'If a STANDING PREFERENCES block is present, those are the user\'s persistent rules — honor every one of them in how you work and what you produce (tone, format, length, and especially approval rules like "never send without review"). They override your defaults.',
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
  /** 1-based resume count when this run is the scheduler RESUMING an earlier unfinished run.
   *  0/undefined = a fresh run. Caps auto-resume so a stuck task can't re-queue forever. */
  resumeAttempt?: number;
  /** plan-and-execute: undefined = auto (plan iff isComplexTask), true = force planned,
   *  false = force the direct loop. Set false on sub-task runs to prevent re-planning. */
  plan?: boolean;
  /** true when this run is one isolated sub-task spawned by the planner — suppresses
   *  re-planning and self-scheduled resumes (the planner owns retries). */
  subRun?: boolean;
  /** cap on primed memories kept in the prompt (default 10, the anti-context-rot discipline).
   *  Raised only by the gauntlet's long-context baseline arm to let it dump the full store. */
  primeCap?: number;
  /** wall-clock now; injected for testability (defaults to Date.now) */
  now?: () => number;
  onEvent?: (type: string, data: Record<string, unknown>) => void;
}): Promise<AgentResult> {
  const { instruction, dir, memory, brain, worker } = opts;
  const now = opts.now ?? (() => Date.now());
  const emit = opts.onEvent ?? (() => {});

  // PLAN-AND-EXECUTE — for a genuinely complex task, decompose it and run each sub-task in
  // its OWN isolated sub-run (the proven loop, unchanged) that shares only AWM memory, not a
  // monolithic context. This is the principled fix for long-horizon blow-ups + entangled
  // context; it never touches the direct loop's dynamics (simple tasks skip it entirely, and
  // a step is "done" only when its real sub-run returns — so planning can't be mistaken for
  // progress, the failure mode of the earlier naive self-checklist). MWA_PLAN=off disables it.
  if (!opts.subRun && memory.enabled && process.env.MWA_PLAN !== 'off' && (opts.plan ?? isComplexTask(instruction))) {
    return runPlanned(opts);
  }

  const maxSteps = opts.budget?.maxSteps ?? 40;
  const maxWallMs = opts.budget?.maxWallMs ?? 10 * 60_000;
  const consolidateEvery = opts.budget?.consolidateEvery ?? 10;
  const start = now();

  const usage = { brainIn: 0, brainOut: 0, workerIn: 0, workerOut: 0 };
  const history: string[] = [];
  let dispatches = 0, toolCalls = 0, reRecalls = 0, supersedes = 0, consolidations = 0;
  let learnedFacts = 0, skillsDerived = 0, openQuestions = 0, frictionsLearned = 0, policiesLearned = 0; // for the run log + self-learning loop
  let consecNoProgress = 0, consecWorkerFails = 0, brainErrors = 0, incompleteRejections = 0;
  let verifyRejections = 0, verified = false; // verify-before-done: one numeric re-check, no spinning
  const MAX_FETCH_FAILS = 2;

  memory.setSessionId(opts.session ?? `agent-${start}`);
  // Cheap-first for ordinary work; complex/long tasks start the conductor on the strong
  // tier (the cheap tier under-delivers / quits early on long-horizon work), and the
  // worker follows its own intent classification. Escalation below still earns upgrades.
  if (worker instanceof RoutedProvider) worker.reset(classifyIntent(instruction));
  const brainStart = startTier(instruction);
  if (brain instanceof RoutedProvider) brain.reset(brainStart);

  const PRIME_K = opts.primeCap ?? 10; // cap on primed memories kept in the prompt (anti-context-rot)
  const recalled: RecalledMemory[] = memory.enabled ? await memory.recall(instruction, { limit: 8, full: true, workspace: opts.workspace }) : [];
  // STANDING PREFERENCES — user policies that must apply to EVERY task (e.g. "never send
  // without my review", "keep summaries to 5 bullets"). Unlike PRIOR KNOWLEDGE, these are
  // NOT relevance-pruned: they're always injected so recency/topic can't erase a standing rule.
  const policies: string[] = memory.enabled ? memory.listPolicies().slice(0, 12) : [];
  emit('start', { instruction: instruction.slice(0, 120), recalled: recalled.length, dir });

  // Auto-PRIME: pull memory relevant to a context into the prompt set, keeping only the
  // top-K by relevance. Called at start (above) and silently re-run as the task evolves,
  // so the model leans on what it already knows instead of re-deriving / re-searching.
  // Background re-prime uses RERANK-ONLY (drop query expansion). Measured: ~2.1x faster
  // (69ms→32ms) because expansion's real cost is inflating the rerank candidate pool, not the
  // flan-t5 call. rerank-only scores are SCALE-COMPATIBLE with full (verified: identical top-1
  // 4/4, ~0.61 vs 0.61) — so merging into the shared recalled[] (sorted+capped) does NOT
  // displace the full task-start results (the bug that killed the earlier no-rerank fast-prime).
  // Expansion's recall boost is kept where it matters: task-start prime + the explicit recall tool.
  async function prime(ctx: string): Promise<number> {
    if (!memory.enabled) return 0;
    const more = await memory.recall(ctx, { limit: 6, full: true, rerank: true, expand: false, workspace: opts.workspace });
    const fresh = more.filter((m) => !recalled.some((r) => r.id === m.id));
    if (fresh.length) {
      recalled.push(...fresh);
      recalled.sort((a, b) => b.score - a.score);
      if (recalled.length > PRIME_K) recalled.length = PRIME_K;
    }
    return fresh.length;
  }

  // MULTI-HOP BRIDGE — AWM nails SINGLE-hop recall but a 2-hop query ("codename for my main
  // project") surfaces the bridging ENTITY ("Atlas"), not the asked attribute ("Magpie"), and the
  // attribute fact ranks too low to make the pool against the vocab-mismatched query. Fix in the
  // HARNESS (not AWM — keeps it fast/precise): take the salient proper-noun entities from the top
  // recalled items that AREN'T already in the instruction, and issue a follow-up SINGLE-hop recall
  // on each (AWM recalls "Atlas codename = Magpie" precisely for "Atlas"), merging into the primed
  // set. The model then chains the hops (verified: reliable when both hops are in context).
  // Off-switch MWA_ENTITY_BRIDGE=0. Cheap: ≤3 rerank-only recalls.
  async function bridgeEntities(): Promise<void> {
    if (!memory.enabled || process.env.MWA_ENTITY_BRIDGE === '0' || recalled.length === 0) return;
    const STOP = new Set(['the', 'a', 'an', 'my', 'our', 'your', 'their', 'this', 'that', 'what', 'when', 'where', 'who', 'why', 'how', 'is', 'are', 'was', 'were', 'project', 'account', 'team', 'main', 'internal', 'codename', 'name', 'regards']);
    const instrLc = instruction.toLowerCase();
    const bridged = new Set<string>(); // entities already followed (dedupe across rounds)
    // Up to 2 rounds so 3-hop chains resolve (round 1: scheduler→Sarah; round 2: Sarah→Cygnus→…).
    for (let round = 0; round < 2; round++) {
      const fresh: string[] = [];
      for (const r of recalled.slice(0, 6)) {
        for (const m of `${r.concept} ${r.content}`.matchAll(/\b[A-Z][A-Za-z]{2,}\b/g)) {
          const w = m[0]; const lw = w.toLowerCase();
          if (!STOP.has(lw) && !instrLc.includes(lw) && !bridged.has(lw)) { bridged.add(lw); fresh.push(w); }
        }
      }
      if (fresh.length === 0) break;
      let added = 0;
      for (const ent of fresh.slice(0, 4)) added += await prime(ent);
      if (added === 0) break;
    }
  }
  await bridgeEntities();

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
    const ext = '(?:md|json|jsonl|csv|html?|txt|js|mjs|cjs|ts|tsx|py|css|ya?ml|xml|svg)';
    const fileRe = new RegExp(`\\b([\\w][\\w.-]*\\.${ext})\\b`, 'gi');
    const produce = /(write|writes|writing|creat|sav|produce|generat|output|build|make|findings to|results? to|report to|put (it|them|that) (in|into|to))/i;
    const out = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = fileRe.exec(instruction))) {
      const f = m[1];
      if (f.includes('*')) continue; // skip globs (e.g. sales-*.csv — those are inputs)
      if (produce.test(instruction.slice(Math.max(0, m.index - 60), m.index))) out.add(f); // a produce verb just before it
    }
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
      policies.length ? `STANDING PREFERENCES (the user's standing rules — always honor these; they override defaults):\n${policies.map((p) => `• ${p}`).join('\n')}` : '',
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
      // VERIFY-BEFORE-DONE — for tasks with COMPUTED/NUMERIC results (where pass^k variance
      // bites: arithmetic slips, invented numbers, RAG totals), do ONE cheap self-check before
      // accepting done — re-read the deliverable it wrote (or the work trail) and confirm the
      // answer's numbers are actually supported. Capped at a single re-check (no spinning) and
      // it only rejects on a CONCRETE discrepancy (defaults to passing) so a shaky verifier
      // can't send a correct answer into needless rework. Self-verification stabilizes outputs.
      const hasNumber = /\d/.test(summ);
      const computeTask = /\b(calculat|comput|how many|how much|count|total|sum|subtotal|average|mean|median|percent|%|tally|add up|eval|evaluat|metric|score|tax|invoice|price|cost|budget|figure|amount|\$|€|£)\b/i.test(`${instruction} ${summ}`);
      if (!verified && hasNumber && computeTask && verifyRejections < 1 && now() - start < maxWallMs * 0.85) {
        let evidence = '';
        for (const f of expectedOutputs.filter((x) => { try { return existsSync(join(dir, x)); } catch { return false; } }).slice(0, 2)) {
          try { evidence += `\n--- ${f} ---\n${readFileSync(join(dir, f), 'utf8').slice(0, 4000)}`; } catch { /* */ }
        }
        if (!evidence) evidence = history.slice(-20).join('\n').slice(0, 4000);
        try {
          const v = await brain.chat({
            system: 'You are double-checking an answer before it is sent. Compare the NUMERIC claims in the ANSWER against the EVIDENCE (a file the agent produced, or what it found/computed). Recompute where you can. Output ONLY JSON. If every number is supported by the evidence, output {"ok":true}. If a specific number is wrong, unsupported, or contradicts the evidence, output {"ok":false,"fix":"name the wrong number and what it should be, or what to re-check"}. Be strict, but only flag a CONCRETE error — if you cannot point to a specific wrong number, output {"ok":true}.',
            messages: [{ role: 'user', content: `ANSWER:\n${summ}\n\nEVIDENCE:${evidence}` }],
            maxTokens: 300,
          });
          usage.brainIn += v.usage.input; usage.brainOut += v.usage.output;
          const verdict = parseJsonLoose<{ ok?: boolean; fix?: string }>(v.text);
          if (verdict && verdict.ok === false && verdict.fix && String(verdict.fix).trim().length > 6) {
            verifyRejections++;
            consecNoProgress = 0; // it's correcting, not stalling
            nudge = `Before finishing, a check of the numbers found a problem: ${String(verdict.fix).slice(0, 220)}. Re-check that against the actual data/file, fix it, then call done.`;
            history.push(`(verify-before-done flagged a numeric issue: ${String(verdict.fix).slice(0, 90)})`);
            emit('verify', { ok: false });
            continue;
          }
          verified = true;
          emit('verify', { ok: true });
        } catch { /* verification is best-effort — never block a done on it */ }
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

  // SUPERSEDE-AS-TRANSITION — when this run learned that a PRIOR fact's VALUE changed, record the
  // update as a transition-with-reason ("X moved from <old> to <new> because <why>") written with
  // the prior's SAME concept + eventType=surprise → AWM's R3 supersede fires. PROVEN (at scale):
  // the current value ranks #1, while the prior value AND the why ride inside the same memory, so
  // "what was it before / why did it change" stay answerable from one record — without polluting
  // recall with a stale standalone (it fades below). Supersede is decision-HISTORY, not deletion.
  // Run-end, harness-owned; a misdetection just writes a verbose fact (low blast radius).
  let transitionsRecorded = 0;
  if (memory.enabled && !askedUser && recalled.length > 0 && (toolCalls > 0 || modelAnswered)) {
    try {
      const priors = recalled.slice(0, 8).map((m, i) => `${i + 1}. [${m.concept}] ${m.content}`).join('\n');
      const tr = await brain.chat({
        system: 'Find any PREVIOUSLY KNOWN fact whose VALUE CHANGED this session (a new date, status, owner, decision, or amount — not a brand-new unrelated fact, not a restatement). For each, write ONE sentence stating the change AS A TRANSITION WITH REASON: "<subject> changed from <old value> to <new value> because <reason>" (omit "because ..." only if no reason is evident). Output ONLY JSON {"transitions":[{"ref":N,"statement":"..."}]} where ref is the number of the now-outdated prior fact above. Output {"transitions":[]} if nothing changed.',
        messages: [{ role: 'user', content: `PREVIOUSLY KNOWN FACTS:\n${priors}\n\nWHAT HAPPENED THIS SESSION:\n${history.slice(-24).join('\n')}\n\nANSWER GIVEN:\n${finalSummary}` }],
        maxTokens: 400,
      });
      usage.brainIn += tr.usage.input; usage.brainOut += tr.usage.output;
      for (const t of parseJsonLoose<{ transitions?: { ref?: number; statement?: string }[] }>(tr.text)?.transitions ?? []) {
        const prior = recalled[Number(t?.ref) - 1];
        if (!prior || !t?.statement || String(t.statement).trim().length < 12) continue;
        // SAME concept as the prior + eventType=surprise → R3 supersede with the transition text.
        const id = await memory.write(prior.concept, String(t.statement), ['topic=world', 'intent=decision', 'confidence_level=verified'], { canonical: true, eventType: 'surprise' });
        if (id) { supersedes++; transitionsRecorded++; emit('remember', { concept: `updated: ${prior.concept}`.slice(0, 80) }); history.push(`recorded a change ("${String(t.statement).slice(0, 56)}")`); }
      }
    } catch { /* best-effort */ }
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

  // REFLEXION (learn-from-failure) — when a run ended badly (gave up / hit budget / stuck /
  // error, or the trail shows refusals/errors/"couldn't"), make ONE focused call to write a
  // short verbal lesson ("X failed because Y; next time Z") as a friction memory. Auto-prime
  // recalls it before similar future tasks, so the agent stops repeating the same dead end.
  // The failure counterpart of the skill derivation above — harness-owned, run-end only, so it
  // never changes the live loop's dynamics (the lesson from the plan-and-execute regression).
  const failedRun = reason === 'stuck' || reason === 'error' || reason === 'budget'
    || /refused|could ?n.?t|couldn|unable|\bfail|\berror\b|not found|no files|gave up/i.test(history.slice(-20).join('\n'));
  if (memory.enabled && toolCalls > 0 && !askedUser && failedRun) {
    try {
      const refl = await brain.chat({
        system: 'A task did NOT go cleanly. In ONE or TWO sentences, write a reusable lesson for a FUTURE similar attempt: what went wrong, the likely cause, and what to do differently next time. Be concrete and general enough to transfer (name the kind of task/tool, not one-off specifics). Output ONLY JSON {"topic":"2-5 word kind of task this applies to","lesson":"X failed because Y; next time Z"}. If there is no transferable lesson (a clean run, or a failure outside our control with no better next step), output exactly {}.',
        messages: [{ role: 'user', content: `REQUEST: ${instruction}\n\nWHAT HAPPENED (most recent last):\n${history.slice(-24).join('\n')}\n\nOUTCOME: ${reason} — ${finalSummary}` }],
        maxTokens: 220,
      });
      usage.brainIn += refl.usage.input; usage.brainOut += refl.usage.output;
      const r = parseJsonLoose<{ topic?: string; lesson?: string }>(refl.text);
      if (r?.topic && r?.lesson && String(r.lesson).trim().length > 12) {
        const fid = await memory.saveFriction(String(r.topic), String(r.lesson));
        if (fid) { frictionsLearned++; emit('remember', { concept: `lesson: ${String(r.topic)}`.slice(0, 80) }); history.push(`recorded a lesson ("${String(r.topic).slice(0, 40)}")`); }
      }
    } catch { /* best-effort */ }
  }

  // PERSISTENT POLICY/PREFERENCE capture — when the user states a STANDING rule (not a one-off
  // task detail), persist it as a policy memory so it's always-primed on EVERY future task
  // (fidelity + user-in-the-loop: a rule like "never send without my review" must outlive the
  // turn it was said in). Regex pre-gate keeps normal tasks free of the extra call; the focused
  // call then decides if anything is truly STANDING. Harness-owned, run-end — no loop change.
  const directiveLike = /\b(always|never|from now on|going forward|in future|each time|every time|whenever|by default|make sure (to|you)|be sure to|remember to|please (always|never)|don'?t ever|prefer|i (like|want|need) (you|it|them) to|keep (it|them|the|your|things|responses|summaries|replies)|sign off|cc |bcc |my (name|signature)|tone|do not send|don'?t send|without (my|me) (review|approval|ok|sign))\b/i;
  if (memory.enabled && opts.interactive && !askedUser && directiveLike.test(instruction)) {
    try {
      const pol = await brain.chat({
        system: 'Decide if the user stated any STANDING preference or rule meant to apply to FUTURE tasks too — not a detail of just this one task. Examples that ARE standing: "always CC my assistant", "never send email without my review", "keep summaries to 5 bullets", "sign off as Rob", a tone/format rule. NOT standing: one-off task parameters ("email Sarah about Tuesday"), facts, or anything specific to only this request. Output ONLY JSON {"policies":["imperative standing rule", ...]} with 0 to 3 items; output {"policies":[]} if none. Write each rule as a short imperative the agent can follow ("Never send an email without showing me a draft first").',
        messages: [{ role: 'user', content: `USER REQUEST: ${instruction}` }],
        maxTokens: 250,
      });
      usage.brainIn += pol.usage.input; usage.brainOut += pol.usage.output;
      const known = new Set(policies.map((p) => p.toLowerCase().trim()));
      for (const rule of (parseJsonLoose<{ policies?: string[] }>(pol.text)?.policies ?? []).slice(0, 3)) {
        const r = typeof rule === 'string' ? rule.trim() : '';
        if (r.length < 8 || known.has(r.toLowerCase())) continue;
        const id = await memory.savePolicy(r);
        if (id) { policiesLearned++; known.add(r.toLowerCase()); emit('remember', { concept: `preference: ${r}`.slice(0, 80) }); history.push(`saved a standing preference ("${r.slice(0, 50)}")`); }
      }
    } catch { /* best-effort */ }
  }

  // record the run outcome
  if (memory.enabled) {
    await memory.write(`agent run: ${instruction.slice(0, 56)}`, `Instruction "${instruction.slice(0, 80)}" ended: ${reason} after ${steps} steps, ${dispatches} dispatches. ${finalSummary}`, ['topic=agent', 'kind=run-outcome', 'intent=decision', 'confidence_level=verified'], { eventType: 'decision', canonical: reason === 'done' });
  }

  // SCHEDULER-DRIVEN RESUME — a long task that ran out of budget (or got stuck) AFTER doing
  // real work isn't a dead end: queue a RESUME the scheduler drives to completion in a fresh,
  // small context (reusing this run's folder + files; prior progress comes back via recall).
  // One brittle over-budget run becomes a tracked, resumable sequence. Capped so a genuinely
  // stuck task can't re-queue forever. Run-end only — no change to the live loop's dynamics.
  const MAX_RESUMES = 2;
  const RESUME_DELAY_MS = 60_000; // next scheduler tick
  const attempt = opts.resumeAttempt ?? 0;
  if (memory.enabled && !opts.subRun && !askedUser && (reason === 'budget' || reason === 'stuck') && (toolCalls > 0 || dispatches > 0) && attempt < MAX_RESUMES) {
    const cont = `Resume and finish this task — an earlier attempt ran out of time before completing it (resume ${attempt + 1} of ${MAX_RESUMES}). FIRST recall what you already did and check the files already in the working folder; then do ONLY the remaining work and finish. Do not start over.\n\nTHE TASK: ${instruction}`;
    const dueMs = now() + RESUME_DELAY_MS;
    const id = await memory.addScheduledTask(cont, dueMs, { notify: opts.session, dir, resumeAttempt: attempt + 1 });
    if (id) {
      history.push(`(unfinished — queued a resume for ~1 min from now, attempt ${attempt + 1}/${MAX_RESUMES})`);
      emit('schedule', { instruction: `resume: ${instruction.slice(0, 50)}`, due: dueMs, resume: attempt + 1 });
    }
  }

  const brainCost = brain instanceof RoutedProvider ? brain.spentUsd() : (usage.brainIn / PRICE_DIV) * brain.price[0] + (usage.brainOut / PRICE_DIV) * brain.price[1];
  const workerCost = worker instanceof RoutedProvider ? worker.spentUsd() : (usage.workerIn / PRICE_DIV) * worker.price[0] + (usage.workerOut / PRICE_DIV) * worker.price[1];

  appendRunLog({
    ts: start, session: opts.session ?? '', instruction: instruction.slice(0, 160), reason,
    steps, dispatches, toolCalls, reRecalls, supersedes, consolidations,
    learned: learnedFacts, skills: skillsDerived, questions: openQuestions, frictions: frictionsLearned, policies: policiesLearned, transitions: transitionsRecorded,
    durationMs: now() - start, costUsd: Number((brainCost + workerCost).toFixed(4)), summary: finalSummary.slice(0, 200),
  });
  emit('end', { reason, steps, dispatches, durationMs: now() - start });
  return {
    reason, summary: finalSummary, steps, dispatches, toolCalls, reRecalls, supersedes, consolidations,
    durationMs: now() - start, usage, costUsd: Number((brainCost + workerCost).toFixed(6)), history,
  };
}

/**
 * Plan-and-Execute orchestrator (Plan-and-Act / Task-Decoupled Planning). A PLANNER (strong
 * tier) decomposes a complex task into 2–6 concrete sub-tasks; each runs as an ISOLATED
 * sub-run of runAgent (subRun: true → no re-planning, no self-scheduled resume) so a long
 * task never accumulates one monolithic context — the steps share state only through AWM
 * recall (each step writes its result; later steps recall it). A failed step retries once in
 * isolation (the Reflexion friction it wrote auto-primes the retry). A SYNTHESIS pass turns
 * the step results into one plain answer. Distinct from the reverted naive self-checklist:
 * there the model "planned" inside the live loop and treated planning as progress; here a step
 * is done ONLY when its real sub-run returns, and planning/execution are separate calls.
 */
async function runPlanned(opts: Parameters<typeof runAgent>[0]): Promise<AgentResult> {
  const { instruction, dir, memory, brain } = opts;
  const now = opts.now ?? (() => Date.now());
  const emit = opts.onEvent ?? (() => {});
  const start = now();
  const maxWallMs = opts.budget?.maxWallMs ?? 10 * 60_000;
  const totalSteps = opts.budget?.maxSteps ?? 40;
  const usage = { brainIn: 0, brainOut: 0, workerIn: 0, workerOut: 0 };
  let costUsd = 0;
  const history: string[] = [];
  memory.setSessionId(opts.session ?? `plan-${start}`);
  emit('start', { instruction: instruction.slice(0, 120), recalled: 0, dir, planned: true });

  // 1) PLAN (strong tier) — decompose into the fewest concrete, independently-doable steps.
  if (brain instanceof RoutedProvider) brain.reset('reason');
  let steps: { task: string; done_when?: string }[] = [];
  try {
    const known = await memory.recall(instruction, { limit: 6, full: true, workspace: opts.workspace });
    const p = await brain.chat({
      system: 'You are the PLANNER. Break the user\'s task into the SMALLEST ordered set of concrete sub-tasks (2 to 6) that together fully complete it. Each sub-task must be self-contained — something one agent can do alone in a fresh context (it can read files, search the web, write files, draft email). Prefer FEWER steps; do not pad. Output ONLY JSON {"steps":[{"task":"imperative sub-task","done_when":"one observable success condition"}, ...]}. If the task is actually simple enough to do in one go, output {"steps":[]}.',
      messages: [{ role: 'user', content: `TASK: ${instruction}\nWORKING DIR: ${dir}${known.length ? `\n\nWHAT YOU ALREADY KNOW (from memory):\n${known.map((k) => `- ${k.concept}: ${k.content}`).join('\n')}` : ''}` }],
      maxTokens: 700,
    });
    usage.brainIn += p.usage.input; usage.brainOut += p.usage.output;
    steps = (parseJsonLoose<{ steps?: { task?: string; done_when?: string }[] }>(p.text)?.steps ?? [])
      .filter((s) => s && typeof s.task === 'string' && s.task.trim().length > 4)
      .map((s) => ({ task: String(s.task).trim(), done_when: s.done_when ? String(s.done_when).trim() : undefined }));
  } catch { /* fall through to direct run */ }
  if (brain instanceof RoutedProvider) costUsd += brain.spentUsd();

  // Not worth decomposing (planner returned 0–1 step) → just run the proven loop directly.
  if (steps.length < 2) return runAgent({ ...opts, subRun: true, plan: false });
  steps = steps.slice(0, 6);
  emit('plan', { steps: steps.map((s) => s.task.slice(0, 90)) });
  history.push(`planned ${steps.length} steps: ${steps.map((s) => s.task.slice(0, 40)).join(' | ')}`);

  // 2) EXECUTE — each step in its own isolated sub-run; results bridge via AWM, not context.
  const stepResults: string[] = [];
  let aggSteps = 0, aggDispatches = 0, aggToolCalls = 0;
  let allDone = true;
  const perStepBudget = Math.max(6, Math.ceil(totalSteps / steps.length) + 4);
  for (let i = 0; i < steps.length; i++) {
    if (now() - start > maxWallMs) { allDone = false; history.push(`(out of time before step ${i + 1})`); break; }
    const s = steps[i];
    emit('plan_step', { n: i + 1, total: steps.length, task: s.task.slice(0, 90) });
    const ctx = `${s.task}${s.done_when ? `\n\nDone when: ${s.done_when}` : ''}\n\n(This is step ${i + 1} of ${steps.length} of a larger task: "${instruction.slice(0, 140)}". Earlier steps' results are in your memory — recall them first. Do ONLY this step, then call done.)`;
    const remainWall = Math.max(60_000, maxWallMs - (now() - start));
    const subBudget = { maxSteps: perStepBudget, maxWallMs: remainWall, consolidateEvery: 50 };
    let sub = await runAgent({ ...opts, instruction: ctx, subRun: true, plan: false, budget: subBudget, now: opts.now, onEvent: emit });
    if (sub.reason !== 'done' && now() - start < maxWallMs) {
      // localized replanning: retry THIS step once (its friction memory auto-primes the retry).
      const retryCtx = `${ctx}\n\nA previous attempt did not finish this step — recall what went wrong and take a DIFFERENT concrete approach this time.`;
      // The first attempt failed, so the retry (done, or at worst equivalent) replaces it.
      sub = await runAgent({ ...opts, instruction: retryCtx, subRun: true, plan: false, budget: subBudget, now: opts.now, onEvent: emit });
    }
    usage.brainIn += sub.usage.brainIn; usage.brainOut += sub.usage.brainOut;
    usage.workerIn += sub.usage.workerIn; usage.workerOut += sub.usage.workerOut;
    costUsd += sub.costUsd; aggSteps += sub.steps; aggDispatches += sub.dispatches; aggToolCalls += sub.toolCalls;
    if (sub.reason !== 'done') allDone = false;
    stepResults.push(`Step ${i + 1} — ${s.task.slice(0, 70)} [${sub.reason}]: ${sub.summary.slice(0, 320)}`);
    history.push(`step ${i + 1}/${steps.length} [${sub.reason}]: ${s.task.slice(0, 50)}`);
    // Persist the step result so later steps recall it (the cross-step bridge is memory).
    await memory.write(`plan step ${i + 1}: ${s.task.slice(0, 50)}`, `For task "${instruction.slice(0, 70)}", step ${i + 1} ("${s.task.slice(0, 90)}") → ${sub.summary.slice(0, 260)}`, ['topic=plan-step', 'intent=decision', 'confidence_level=verified'], { eventType: 'decision' });
  }

  // 3) SYNTHESIZE — one plain answer from the step results (strong tier, isolated cost).
  let finalSummary = '';
  if (brain instanceof RoutedProvider) brain.reset('reason');
  try {
    const syn = await brain.chat({
      system: 'Combine the sub-task results into ONE clear, direct answer to the user\'s ORIGINAL request, in plain language for a non-technical person. Lead with the answer; be concise — no preamble, no step-by-step narration. If a part could not be completed, say so honestly in one line and suggest a sensible next step. No tool names or jargon.',
      messages: [{ role: 'user', content: `ORIGINAL REQUEST: ${instruction}\n\nSUB-TASK RESULTS (in order):\n${stepResults.join('\n')}` }],
      maxTokens: 600,
    });
    usage.brainIn += syn.usage.input; usage.brainOut += syn.usage.output;
    finalSummary = syn.text?.trim() || stepResults.join('\n');
  } catch { finalSummary = stepResults.join('\n'); }
  if (brain instanceof RoutedProvider) costUsd += brain.spentUsd();

  const reason: AgentResult['reason'] = allDone ? 'done' : 'budget';
  appendRunLog({
    ts: start, session: opts.session ?? '', instruction: instruction.slice(0, 160), reason,
    steps: aggSteps, dispatches: aggDispatches, toolCalls: aggToolCalls, reRecalls: 0, supersedes: 0, consolidations: 0,
    planned: steps.length, durationMs: now() - start, costUsd: Number(costUsd.toFixed(4)), summary: finalSummary.slice(0, 200),
  });
  emit('end', { reason, steps: aggSteps, dispatches: aggDispatches, durationMs: now() - start, planned: steps.length });
  return {
    reason, summary: finalSummary, steps: aggSteps, dispatches: aggDispatches, toolCalls: aggToolCalls,
    reRecalls: 0, supersedes: 0, consolidations: 0, durationMs: now() - start, usage, costUsd: Number(costUsd.toFixed(6)), history,
  };
}
