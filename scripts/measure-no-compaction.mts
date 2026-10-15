/**
 * BL-09 — measure the no-compaction bet (H-1 in docs/harness-evaluation-2026-10-13.md).
 *
 * MWA keeps only the last HIST_WINDOW history lines in the prompt and never summarizes the rest: the
 * bet is that memory recall stands in for compaction. This plants two constraints in a BRIEF the agent
 * reads at its first step (a tool result — the instruction itself is always in the prompt), makes it
 * work through 10 item files, then asks for a summary that must follow the brief.
 *
 * Attribution is read off the PROMPT, not guessed: at the step where the model writes summary.txt, the
 * exact prompt is captured and the code word is located —
 *   window   the first read of the brief is still in the history window
 *   reread   the agent read the brief again later
 *   memory   the code word reached the prompt only through memory (recall, priming)
 *   absent   it wasn't in the prompt at all
 * KESTREL-7 can't be guessed, so a summary that starts with it while the prompt lacks it would mean the
 * instrument is wrong — reported as `unexplained`.
 *
 * One arm per process (the window is read when the agent module loads):
 *   MWA_ENV_FILE=<file with AZURE_GPT_*> MWA_HIST_WINDOW=12 npx tsx scripts/measure-no-compaction.mts --memory on --trials 4
 * Each trial uses a FRESH memory store, so nothing leaks between trials. The planner is off (it would
 * carry the brief forward in its step instructions — a different mechanism). Prints one JSON line per trial.
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const memoryOn = arg('memory', 'on') !== 'off';
const trials = Number(arg('trials', '4'));
const window = Number(process.env.MWA_HIST_WINDOW || 12);
if (process.env.MWA_ENV_FILE) {
  for (const line of readFileSync(process.env.MWA_ENV_FILE, 'utf8').split('\n')) {
    const m = /^(AZURE_GPT_[A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) process.env[m[1]] = m[2];
  }
}
process.env.MWA_FAST_CHAT = '0';

const { runAgent } = await import('../src/agent.js');
const { MwaMemory, NullMemory } = await import('../src/awm.js');
const { getProvider } = await import('../src/provider.js');
const { buildRegistry } = await import('../src/tools/build.js');
const { loadConfig } = await import('../src/config.js');

const CODE = 'KESTREL-7';
const BRIEF = [
  'Brief for the quarterly stock summary (prepared by the account team).',
  'The client this quarter is Acme Corp, our largest wholesale account.',
  'Figures come from the item files; each file holds one product line.',
  `Rule 1: the summary file must begin with the code word ${CODE} on its own first line — the client's system files it by that word.`,
  'Rule 2: the summary must never name the client. Refer to them only as "the client".',
  'Round every total to whole units. Group products by their first letter.',
  'The tally file is a working file; nobody reads it.',
  'Deadline: end of the week.',
].join('\n');
// 10 items: each is a read and an append (plus the memory nudges), so the brief is 20+ history lines back
// when the summary is written — far outside a 12-line window. (18 items cost ~$1 a trial.)
const PRODUCTS = ['anchor bolts', 'bracket sets', 'cable ties', 'drill bits', 'end caps', 'fuse holders', 'gaskets', 'hinge pins', 'insulators', 'junction boxes'];

interface Trial { arm: string; trial: number; steps: number; reason: string; summaryWritten: boolean; codeFirstLine: boolean; namesClient: boolean; briefReads: number; remembered: boolean; attribution: string; costUsd: number }

async function oneTrial(n: number): Promise<Trial> {
  const dir = mkdtempSync(join(tmpdir(), 'mwa-h1-'));
  try {
    writeFileSync(join(dir, 'brief.txt'), BRIEF);
    PRODUCTS.forEach((p, i) => writeFileSync(join(dir, `item-${String(i + 1).padStart(2, '0')}.txt`), `${p}: ${37 + i * 13} units${i % 7 === 3 ? ' (Acme Corp standing order)' : ''}`));
    const memory = memoryOn ? new MwaMemory(`h1-${Date.now()}-${n}`, join(dir, '.mem', 'h1.db')) : new NullMemory();
    const base = getProvider('brain');
    let writePrompt: string | null = null;
    const toolNames: string[] = [];
    const brain = {
      id: base.id, model: base.model, price: base.price,
      chat: async (input: any) => {
        const out = await base.chat(input);
        const prompt = `${input.system ?? ''}\n${(input.messages ?? []).map((m: any) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n')}`;
        const said = `${out.text ?? ''} ${JSON.stringify(out.toolCalls ?? [])}`;
        // The first step whose chosen action names summary.txt — a write_file call or a dispatch to the worker.
        if (writePrompt === null && /summary\.txt/.test(said)) writePrompt = prompt;
        return out;
      },
    };
    // The same tools a real chat gets (serve builds them this way), in the Assistant preset.
    const { registry } = await buildRegistry(loadConfig(), memoryOn ? memory : null);
    const r = await runAgent({
      instruction: 'Read brief.txt first. Then read each item file (item-01.txt to item-10.txt) one at a time, in order, and after each one append its number to tally.txt. When all 10 are done, write summary.txt following the brief.',
      dir, memory, brain: brain as any, worker: brain as any, tools: registry, interactive: false, plan: false,
      budget: { maxSteps: 120, maxWallMs: 20 * 60_000 },
      onEvent: (t: string, d: any) => { if (t === 'tool' && d?.name) toolNames.push(String(d.name)); },
    } as any);
    const sumPath = join(dir, 'summary.txt');
    const summary = existsSync(sumPath) ? readFileSync(sumPath, 'utf8') : '';
    const runLog = (r as any).history as string[] | undefined;
    // The agent's own `read` action logs as read(path): …; read_file / read_document as tool lines.
    const briefReads = (runLog ?? []).filter((l) => /^read\(|read_file|read_document/.test(l) && /Brief for the quarterly/.test(l)).length;
    const remembered = memoryOn && (await memory.recall(CODE, { limit: 5, full: true })).some((m: any) => m.content.includes(CODE) || m.concept.includes(CODE));
    // Where did the code word come from, at the moment the summary was written?
    let attribution = 'no-summary-step';
    if (writePrompt !== null) {
      const wp: string = writePrompt;
      if (!wp.includes(CODE)) attribution = 'absent';
      else if (wp.includes('Brief for the quarterly')) attribution = briefReads > 1 ? 'reread' : 'window';
      else attribution = 'memory';
    }
    const codeFirstLine = summary.trimStart().split('\n')[0]?.trim().startsWith(CODE) ?? false;
    if (codeFirstLine && attribution === 'absent') attribution = 'unexplained';
    memory.close();
    return { arm: `window=${window} memory=${memoryOn ? 'on' : 'off'}`, trial: n, steps: Number(r.steps ?? 0), reason: String(r.reason), summaryWritten: !!summary, codeFirstLine, namesClient: /acme/i.test(summary), briefReads, remembered, attribution, costUsd: Number(r.costUsd ?? 0) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

for (let n = 1; n <= trials; n++) {
  try { console.log(JSON.stringify(await oneTrial(n))); }
  catch (e) { console.log(JSON.stringify({ arm: `window=${window} memory=${memoryOn ? 'on' : 'off'}`, trial: n, error: (e as Error).message.slice(0, 200) })); }
}
process.exit(0);
