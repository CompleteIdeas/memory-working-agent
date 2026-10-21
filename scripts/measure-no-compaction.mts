/**
 * BL-09 — measure the no-compaction bet (H-1 in docs/harness-evaluation-2026-10-13.md).
 *
 * MWA keeps only the last HIST_WINDOW history lines in the prompt and never summarizes the rest: the
 * bet is that memory recall stands in for compaction. This plants two constraints in a BRIEF the agent
 * reads at its first step (a tool result — the instruction itself is always in the prompt), makes it
 * work through 10 item files, then asks for a summary that must follow the brief.
 *
 * Attribution is read off the PROMPT of the step that actually WRITES summary.txt — a main-loop call
 * (its system prompt carries the trust boundary) whose chosen action is write_file to summary.txt, or a
 * dispatch naming it. The prompt is split at its RECENT STEPS header:
 *   window     the brief's text is in RECENT STEPS and it was read once before this step
 *   reread     the brief's text is in RECENT STEPS and it was read more than once before this step
 *   own-notes  the code word is in RECENT STEPS only through lines the agent wrote (remember, recall,
 *              dispatch, a command) — not the brief itself
 *   memory     the code word is ONLY above RECENT STEPS: primed or recalled knowledge
 *   absent     it isn't in the prompt at all
 * KESTREL-7 can't be guessed: a summary starting with it while the prompt lacks it is `unexplained`.
 *
 * The run follows production's shape: the brain is a RoutedProvider, as in serve (here both tiers are
 * the same gpt-5.4-mini deployment, so escalation changes nothing); tools come from buildRegistry, with
 * an explicit config in a temp file (Azure model, Assistant preset, no MCP servers) so the dev box's own
 * settings don't leak in. `briefReadsBefore` counts reads the model CHOSE, including any the agent then
 * skipped as repeats. Each trial gets a fresh memory store. With
 * --memory off the agent gets NullMemory, and since BL-09's review it is offered no memory tools at all.
 * The planner is off (it would carry the brief in its step instructions — a different mechanism).
 *
 * One arm per process (the window is read when the agent module loads; MWA_HIST_WINDOW must be in the
 * process environment — a .env file is loaded too late):
 *   MWA_ENV_FILE=<file with AZURE_GPT_*> MWA_HIST_WINDOW=12 npx tsx scripts/measure-no-compaction.mts --memory on --trials 3 [--steps 160]
 * Run it from a clean checkout at the pinned AWM. Prints one JSON line per trial.
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const memoryOn = arg('memory', 'on') !== 'off';
const trials = Number(arg('trials', '3'));
const maxSteps = Number(arg('steps', '160'));
if (process.env.MWA_ENV_FILE) {
  for (const line of readFileSync(process.env.MWA_ENV_FILE, 'utf8').split('\n')) {
    const m = /^(AZURE_GPT_[A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) process.env[m[1]] = m[2];
  }
}
process.env.MWA_FAST_CHAT = '0';
// An explicit config: the dev box's mwa.config.json (bare model names, five MCP servers) must not leak in.
const cfgDir = mkdtempSync(join(tmpdir(), 'mwa-h1-cfg-'));
process.env.MWA_CONFIG_PATH = join(cfgDir, 'mwa.config.json');
// `tools` merges shallowly over the defaults, so mcpServers must be emptied explicitly (BL-09 review).
writeFileSync(process.env.MWA_CONFIG_PATH, JSON.stringify({ models: { fetch: 'azure:gpt-5-4-mini', reason: 'azure:gpt-5-4-mini' }, tools: { access: { preset: 'assistant' }, mcpServers: {} } }));

process.env.MWA_COMPACTION = 'off'; // this measures the window itself; the agent compacts by default since BL-32
const { runAgent, HIST_WINDOW } = await import('../src/agent.js');
const { MwaMemory, NullMemory } = await import('../src/awm.js');
const { getProvider } = await import('../src/provider.js');
const { RoutedProvider } = await import('../src/model-router.js');
const { buildRegistry } = await import('../src/tools/build.js');
const { loadConfig } = await import('../src/config.js');
const { parseJsonLoose } = await import('../src/util.js');
let awmVersion = '?';
try { awmVersion = JSON.parse(readFileSync(new URL('../vendor/agent-working-memory/package.json', import.meta.url), 'utf8')).version; } catch { /* */ }

const CODE = 'KESTREL-7';
const HEADER = 'Brief for the quarterly';
const BRIEF = [
  `${HEADER} stock summary (prepared by the account team).`,
  'The client this quarter is Acme Corp, our largest wholesale account.',
  'Figures come from the item files; each file holds one product line.',
  `Rule 1: the summary file must begin with the code word ${CODE} on its own first line — the client's system files it by that word.`,
  'Rule 2: the summary must never name the client. Refer to them only as "the client".',
  'Round every total to whole units. Group products by their first letter.',
  'The tally file is a working file; nobody reads it.',
  'Deadline: end of the week.',
].join('\n');
// 10 items: each is a read and an append, so the brief is 20+ history lines back when the summary is written.
const PRODUCTS = ['anchor bolts', 'bracket sets', 'cable ties', 'drill bits', 'end caps', 'fuse holders', 'gaskets', 'hinge pins', 'insulators', 'junction boxes'];

type Action = { name: string; args: Record<string, unknown> };
/** The action a main-loop call chose: a native tool call, or the JSON the model wrote. */
function chosen(out: { text?: string; toolCalls?: Action[] }): Action | null {
  if (out.toolCalls?.length) return out.toolCalls[0];
  try { const j: any = parseJsonLoose(String(out.text ?? '')); if (j && typeof j.action === 'string') return { name: j.action, args: j }; } catch { /* */ } // as the agent parses it
  return null;
}
const touchesBrief = (a: Action) => /brief\.txt/i.test(JSON.stringify(a.args)) && /^(read|read_file|read_document|run_command)$/.test(a.name);
const writesSummary = (a: Action) =>
  (a.name === 'write_file' && /summary\.txt$/i.test(String(a.args.path ?? ''))) || (a.name === 'dispatch' && /summary\.txt/i.test(String(a.args.instruction ?? '')));

async function oneTrial(n: number) {
  const dir = mkdtempSync(join(tmpdir(), 'mwa-h1-'));
  try {
    writeFileSync(join(dir, 'brief.txt'), BRIEF);
    PRODUCTS.forEach((p, i) => writeFileSync(join(dir, `item-${String(i + 1).padStart(2, '0')}.txt`), `${p}: ${37 + i * 13} units${i % 7 === 3 ? ' (Acme Corp standing order)' : ''}`));
    const memory: any = memoryOn ? new MwaMemory(`h1-${Date.now()}-${n}`, join(dir, '.mem', 'h1.db')) : new NullMemory();
    let writePrompt: string | null = null;
    let briefReadsBefore = 0;
    const actions: Record<string, number> = {};
    // Capture on the providers UNDER the router, so the agent still sees a real RoutedProvider.
    const capture = (base: any) => ({
      id: base.id, model: base.model, price: base.price,
      chat: async (input: any) => {
        const out = await base.chat(input);
        if (!String(input.system ?? '').includes('TRUST BOUNDARY')) return out; // worker, verifier, chat helpers
        const a = chosen(out);
        if (!a) return out;
        actions[a.name] = (actions[a.name] ?? 0) + 1;
        if (writePrompt === null && writesSummary(a)) {
          writePrompt = `${input.system ?? ''}\n${(input.messages ?? []).map((m: any) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n')}`;
        } else if (writePrompt === null && touchesBrief(a)) briefReadsBefore++;
        return out;
      },
    });
    const brain = new RoutedProvider(capture(getProvider('brain')) as any, capture(getProvider('high')) as any);
    const worker = new RoutedProvider(capture(getProvider('brain')) as any, capture(getProvider('high')) as any);
    const { registry } = await buildRegistry(loadConfig(), memoryOn ? memory : null);
    const r = await runAgent({
      instruction: 'Read brief.txt first. Then read each item file (item-01.txt to item-10.txt) one at a time, in order, and after each one append its number to tally.txt. When all 10 are done, write summary.txt following the brief.',
      dir, memory, brain, worker, tools: registry, interactive: false, plan: false,
      budget: { maxSteps, maxWallMs: 30 * 60_000 },
    } as any);
    const sumPath = join(dir, 'summary.txt');
    const summary = existsSync(sumPath) ? readFileSync(sumPath, 'utf8') : '';
    const remembered = memoryOn && (await memory.recall(CODE, { internal: true, limit: 5, full: true })).some((m: any) => `${m.concept} ${m.content}`.includes(CODE));
    let attribution = summary ? 'no-write-step-seen' : 'no-summary';
    if (writePrompt !== null) {
      const wp: string = writePrompt;
      const at = wp.lastIndexOf('RECENT STEPS');
      const above = at >= 0 ? wp.slice(0, at) : wp, recent = at >= 0 ? wp.slice(at) : '';
      if (recent.includes(HEADER)) attribution = briefReadsBefore > 1 ? 'reread' : 'window';
      else if (recent.includes(CODE)) attribution = 'own-notes';
      else if (above.includes(CODE)) attribution = 'memory';
      else attribution = 'absent';
    }
    const codeFirstLine = summary.trimStart().split('\n')[0]?.trim().startsWith(CODE) ?? false;
    if (codeFirstLine && attribution === 'absent') attribution = 'unexplained';
    memory.close();
    return { arm: `window=${HIST_WINDOW} memory=${memoryOn ? 'on' : 'off'}`, awm: awmVersion, trial: n, steps: Number(r.steps ?? 0), maxSteps, reason: String(r.reason), summaryWritten: !!summary, codeFirstLine, namesClient: /acme/i.test(summary), briefReadsBefore, remembered, attribution, actions, costUsd: Number(r.costUsd ?? 0) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

for (let n = 1; n <= trials; n++) {
  try { console.log(JSON.stringify(await oneTrial(n))); }
  catch (e) { console.log(JSON.stringify({ arm: `window=${HIST_WINDOW} memory=${memoryOn ? 'on' : 'off'}`, trial: n, error: (e as Error).message.slice(0, 200) })); }
}
rmSync(cfgDir, { recursive: true, force: true });
process.exit(0);
