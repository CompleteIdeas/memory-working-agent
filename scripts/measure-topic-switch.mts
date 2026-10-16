/**
 * BL-30 — measure "fresh context comes from AWM every time" (Robert, 2026-10-16): switching topics
 * inside ONE run, across context loss, and coming back.
 *
 * One continuous run works three client accounts in turn, then returns to the first after one of its
 * facts changed. Work arrives through a `next_message` tool, one message per call:
 *   1-3  a client brief (code word, contact, deadline, budget, and two rules for report lines), with
 *        the task: read that client's six item files and write <client>-report.txt;
 *   4    an update for the FIRST client (its deadline moved) and the task: write <client>-final.txt
 *        with the code word, the contact, the budget, the NEW deadline, and the item lines again.
 * The contact and budget appear only in that client's brief, three segments back.
 *
 *   --book closed  (primary) a message is given once; nothing on disk repeats it.
 *   --book open    each brief is also saved as <client>/brief.txt, and re-reads are counted.
 *
 * Arms (one per process; the window is read when the agent module loads, so MWA_HIST_WINDOW must be
 * in the process environment and must match the arm — the script refuses otherwise):
 *   w12-awm      window 12 + AWM — MWA today                         MWA_HIST_WINDOW=12
 *   w12-off      window 12, no memory — the control                   MWA_HIST_WINDOW=12
 *   openclaw     older steps folded into a model-written running summary plus a MEMORY.md of durable
 *                facts, both rewritten at each fold (OpenClaw's compaction and pre-compaction memory
 *                flush), shown every step; no AWM                       MWA_HIST_WINDOW=12
 *   compact-awm  the same running summary (no MEMORY.md) + AWM — Robert's Claude Code + AWM setup
 *                                                                      MWA_HIST_WINDOW=12
 *   w200-off     window 200, no memory: nothing is ever lost — the ceiling   MWA_HIST_WINDOW=200
 * Every arm gets the same instruction and the same tools apart from memory's own (a run without
 * memory is offered none, since BL-09). Folding is the agent's experiment-only `compaction` hook.
 *
 * PRIMARY SCORE (fixed before any run): the final report is fully right — the first line is the
 * client's code word; the contact, budget and NEW deadline all appear; neither the old deadline nor
 * any other client's code word, contact, budget or deadline appears.
 * Secondary: item-line errors across all four reports (the mid-run mistakes: wrong case, wrong tag,
 * wrong quantity, another client's tag = bleed), steps, cost (the agent's plus the summarizer's), and
 * where the final step's prompt carried the contact and budget from: recent | summary | memory | absent
 * (split at RECENT STEPS and at the compaction block, as BL-09 splits its prompt).
 * Client order is shuffled per trial (seeded); the run returns to whichever client came first.
 *
 *   MWA_ENV_FILE=<file with AZURE_GPT_*> MWA_HIST_WINDOW=12 npx tsx scripts/measure-topic-switch.mts --arm w12-awm --book closed --trials 2 [--seed 1] [--steps 140]
 * Run it from a clean checkout at the pinned AWM. Prints one JSON line per trial.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const ARMS = ['w12-awm', 'w12-off', 'openclaw', 'compact-awm', 'w200-off'] as const;
type Arm = typeof ARMS[number];
const arm = arg('arm', 'w12-awm') as Arm;
const book = arg('book', 'closed');
const trials = Number(arg('trials', '2'));
const seed0 = Number(arg('seed', '1'));
const maxSteps = Number(arg('steps', '140'));
if (!ARMS.includes(arm)) { console.error(`--arm must be one of ${ARMS.join(', ')}`); process.exit(2); }
if (book !== 'closed' && book !== 'open') { console.error('--book must be closed or open'); process.exit(2); }
const wantWindow = arm === 'w200-off' ? 200 : 12;
if (Number(process.env.MWA_HIST_WINDOW) !== wantWindow) { console.error(`arm ${arm} needs MWA_HIST_WINDOW=${wantWindow} in the process environment`); process.exit(2); }
const memoryOn = arm === 'w12-awm' || arm === 'compact-awm';
const compaction = arm === 'openclaw' || arm === 'compact-awm';

if (process.env.MWA_ENV_FILE) {
  for (const line of readFileSync(process.env.MWA_ENV_FILE, 'utf8').split('\n')) {
    const m = /^(AZURE_GPT_[A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) process.env[m[1]] = m[2];
  }
}
process.env.MWA_FAST_CHAT = '0';
// An explicit config, as BL-09: the dev box's own settings and MCP servers must not leak in.
const cfgDir = mkdtempSync(join(tmpdir(), 'mwa-bl30-cfg-'));
process.env.MWA_CONFIG_PATH = join(cfgDir, 'mwa.config.json');
writeFileSync(process.env.MWA_CONFIG_PATH, JSON.stringify({ models: { fetch: 'azure:gpt-5-4-mini', reason: 'azure:gpt-5-4-mini' }, tools: { access: { preset: 'assistant' }, mcpServers: {} } }));

const { runAgent, HIST_WINDOW } = await import('../src/agent.js');
const { MwaMemory, NullMemory } = await import('../src/awm.js');
const { getProvider } = await import('../src/provider.js');
const { RoutedProvider } = await import('../src/model-router.js');
const { buildRegistry } = await import('../src/tools/build.js');
const { loadConfig } = await import('../src/config.js');
const { parseJsonLoose } = await import('../src/util.js');
let awmVersion = '?';
try { awmVersion = JSON.parse(readFileSync(new URL('../vendor/agent-working-memory/package.json', import.meta.url), 'utf8')).version; } catch { /* */ }

type Case = 'upper' | 'lower' | 'title';
interface Client { key: string; name: string; code: string; contact: string; deadline: string; budget: string; tag: string; case: Case; items: string[] }
export const CLIENTS: Client[] = [
  { key: 'apex', name: 'Apex', code: 'APX-31', contact: 'Dana Cole', deadline: 'March 3', budget: '$12,000', tag: '#north', case: 'upper', items: ['anchor bolts', 'bracket sets', 'cable ties', 'drill bits', 'end caps', 'fuse holders'] },
  { key: 'beacon', name: 'Beacon', code: 'BCN-58', contact: 'Owen Wells', deadline: 'May 9', budget: '$30,000', tag: '#east', case: 'lower', items: ['gaskets', 'hinge pins', 'insulators', 'junction boxes', 'key rings', 'lock nuts'] },
  { key: 'cedar', name: 'Cedar', code: 'CDR-74', contact: 'Lena Ford', deadline: 'June 21', budget: '$8,500', tag: '#west', case: 'title', items: ['mesh panels', 'nail plates', 'o rings', 'pipe clamps', 'quick links', 'rivet guns'] },
];
const NEW_DEADLINE = 'October 30';
const qty = (ci: number, i: number) => 17 + ci * 40 + i * 7;
const caseWord: Record<Case, string> = { upper: 'in CAPITAL LETTERS', lower: 'in lowercase', title: 'in Title Case (each word capitalized)' };
const applyCase = (s: string, c: Case) => c === 'upper' ? s.toUpperCase() : c === 'lower' ? s.toLowerCase() : s.replace(/\b\w/g, (m) => m.toUpperCase());

function brief(c: Client): string {
  return [
    `Message from the account desk — client ${c.name}.`,
    `Client code word: ${c.code}. Main contact: ${c.contact}. Deadline: ${c.deadline}. Budget: ${c.budget}.`,
    `Rules for every ${c.name} item line: write the item name ${caseWord[c.case]}, then a colon, a space, the quantity as a number, a space, and the tag ${c.tag}.`,
    `Task now: read ${c.key}/item-1.txt to ${c.key}/item-6.txt one at a time, then write ${c.key}-report.txt — its first line is the client code word, then one item line per item, in order.`,
    'Keep these details: this client may come up again later.',
  ].join('\n');
}
function update(c: Client): string {
  return [
    `Message from the account desk — client ${c.name} again.`,
    `Update: ${c.name}'s deadline has moved to ${NEW_DEADLINE}.`,
    `Task now: write ${c.key}-final.txt. First line: the ${c.name} code word. Then three lines: "Contact: <main contact>", "Budget: <budget>", "Deadline: <deadline>". Then the ${c.name} item lines again, in order, following ${c.name}'s rules.`,
  ].join('\n');
}

/** A seeded permutation of the three clients (mulberry32). */
function order(seed: number): Client[] {
  let a = seed >>> 0;
  const rnd = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const xs = [...CLIENTS];
  for (let i = xs.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [xs[i], xs[j]] = [xs[j], xs[i]]; }
  return xs;
}

/** Score one report's item lines against a client's rules. */
export function scoreLines(text: string, c: Client): { right: number; wrong: number; bleed: number } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let right = 0, wrong = 0, bleed = 0;
  const ci = CLIENTS.indexOf(c);
  c.items.forEach((item, i) => {
    const want = `${applyCase(item, c.case)}: ${qty(ci, i)} ${c.tag}`;
    const line = lines.find((l) => l.toLowerCase().startsWith(item.toLowerCase()));
    if (line === want) right++;
    else {
      wrong++;
      if (line && CLIENTS.some((o) => o !== c && line.includes(o.tag))) bleed++;
    }
  });
  return { right, wrong, bleed };
}

/** The primary score, on the final report. */
export function scoreFinal(text: string, c: Client): { pass: boolean; checks: Record<string, boolean> } {
  const t = text.replace(/\r/g, '');
  const others = CLIENTS.filter((o) => o !== c);
  const has = (s: string) => t.toLowerCase().includes(s.toLowerCase());
  const amount = (s: string) => t.replace(/[$,]/g, '').includes(s.replace(/[$,]/g, ''));
  const checks = {
    codeFirst: (t.trimStart().split('\n')[0] ?? '').trim().startsWith(c.code),
    contact: has(c.contact),
    budget: amount(c.budget),
    newDeadline: has(NEW_DEADLINE),
    noOldDeadline: !has(c.deadline),
    noBleed: !others.some((o) => has(o.code) || has(o.contact) || amount(o.budget) || has(o.deadline)),
  };
  return { pass: Object.values(checks).every(Boolean), checks };
}

type Action = { name: string; args: Record<string, unknown> };
function chosen(out: { text?: string; toolCalls?: Action[] }): Action | null {
  if (out.toolCalls?.length) return out.toolCalls[0];
  try { const j: any = parseJsonLoose(String(out.text ?? '')); if (j && typeof j.action === 'string') return { name: j.action, args: j }; } catch { /* */ }
  return null;
}
const SUMMARY_HEAD = 'CONVERSATION SUMMARY (older steps, compacted):';
const MEMORY_HEAD = 'MEMORY.md (your durable notes):';

async function oneTrial(n: number) {
  const seed = seed0 * 1000 + n;
  const clients = order(seed);
  const first = clients[0];
  const dir = mkdtempSync(join(tmpdir(), 'mwa-bl30-'));
  let summarizerCost = 0;
  try {
    for (const c of CLIENTS) {
      mkdirSync(join(dir, c.key));
      const ci = CLIENTS.indexOf(c);
      c.items.forEach((item, i) => writeFileSync(join(dir, c.key, `item-${i + 1}.txt`), `${item}: ${qty(ci, i)} units`));
      if (book === 'open') writeFileSync(join(dir, c.key, 'brief.txt'), brief(c));
    }
    const queue = [...clients.map(brief), update(first)];
    let delivered = 0;
    const memory: any = memoryOn ? new MwaMemory(`bl30-${Date.now()}-${n}`, join(dir, '.mem', 'bl30.db')) : new NullMemory();
    const { registry } = await buildRegistry(loadConfig(), memoryOn ? memory : null);
    registry.register({
      def: { name: 'next_message', description: 'Get your next work message. Each message is given once.', parameters: { type: 'object', properties: {} } } as any,
      handler: async () => (delivered < queue.length ? queue[delivered++] : '(no more messages — all work is assigned. When it is done, call done.)'),
    });

    // The compaction arms: a model-written running summary, plus MEMORY.md for the OpenClaw arm.
    const summarizer = getProvider('brain');
    let summary = '', memoryMd = '';
    const fold = async (lines: string[]) => {
      const ask = [
        'You are compacting an AI agent\'s working history so it can continue its work without the older steps.',
        'Rewrite the running summary to merge the older steps below into it. Keep everything needed to continue correctly: the tasks and their status, every fact given (names, dates, amounts, code words), every rule, files written, and changes to earlier facts. Be concise but do not drop specifics.',
        arm === 'openclaw' ? 'Also rewrite MEMORY.md: the durable facts worth keeping long-term, one per line, updating any fact that changed. Reply as JSON: {"summary": "...", "memory": "..."}' : 'Reply with the summary text only.',
        `\nCURRENT SUMMARY:\n${summary || '(none yet)'}`,
        arm === 'openclaw' ? `\nCURRENT MEMORY.md:\n${memoryMd || '(empty)'}` : '',
        `\nOLDER STEPS TO MERGE:\n${lines.join('\n')}`,
      ].filter(Boolean).join('\n');
      const out = await summarizer.chat({ system: 'You write faithful, specific summaries.', messages: [{ role: 'user', content: ask }], maxTokens: 1500 } as any);
      summarizerCost += (out.usage.input * summarizer.price[0] + out.usage.output * summarizer.price[1]) / 1_000_000;
      if (arm === 'openclaw') {
        try { const j: any = parseJsonLoose(String(out.text ?? '')); summary = String(j.summary ?? summary); memoryMd = String(j.memory ?? memoryMd); }
        catch { summary = String(out.text ?? summary); }
      } else summary = String(out.text ?? summary);
    };
    const block = () => [memoryMd ? `${MEMORY_HEAD}\n${memoryMd}` : '', summary ? `${SUMMARY_HEAD}\n${summary}` : ''].filter(Boolean).join('\n\n');

    let finalPrompt: string | null = null;
    let briefReads = 0;
    const actions: Record<string, number> = {};
    const finalName = `${first.key}-final.txt`;
    const capture = (base: any) => ({
      id: base.id, model: base.model, price: base.price,
      chat: async (input: any) => {
        const out = await base.chat(input);
        if (!String(input.system ?? '').includes('TRUST BOUNDARY')) return out;
        const a = chosen(out);
        if (!a) return out;
        actions[a.name] = (actions[a.name] ?? 0) + 1;
        if (/brief\.txt/i.test(JSON.stringify(a.args))) briefReads++;
        const writesFinal = (a.name === 'write_file' && String(a.args.path ?? '').endsWith(finalName)) || (a.name === 'dispatch' && String(a.args.instruction ?? '').includes(finalName));
        if (finalPrompt === null && writesFinal) finalPrompt = (input.messages ?? []).map((m: any) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
        return out;
      },
    });
    const brain = new RoutedProvider(capture(getProvider('brain')) as any, capture(getProvider('high')) as any);
    const worker = new RoutedProvider(capture(getProvider('brain')) as any, capture(getProvider('high')) as any);
    const r = await runAgent({
      instruction: 'Work through your messages from the account desk. Call next_message, do exactly what that message asks, and only then call next_message again. When it says there are no more messages and the work is done, call done.',
      dir, memory, brain, worker, tools: registry, interactive: false, plan: false,
      budget: { maxSteps, maxWallMs: 40 * 60_000 },
      ...(compaction ? { compaction: { fold, block } } : {}),
    } as any);

    const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '');
    const reports = clients.map((c) => ({ c, text: read(`${c.key}-report.txt`) }));
    const finalText = read(finalName);
    const lineScores = [...reports.map(({ c, text }) => scoreLines(text, c)), scoreLines(finalText, first)];
    const final = scoreFinal(finalText, first);
    let source: Record<string, string> = { contact: 'no-final-step', budget: 'no-final-step' };
    if (finalPrompt !== null) {
      const p: string = finalPrompt;
      const rAt = p.lastIndexOf('RECENT STEPS');
      const cAt = Math.min(...[p.indexOf(MEMORY_HEAD), p.indexOf(SUMMARY_HEAD)].filter((i) => i >= 0), rAt >= 0 ? rAt : p.length);
      const recent = rAt >= 0 ? p.slice(rAt) : '', compacted = p.slice(cAt, rAt >= 0 ? rAt : p.length), primed = p.slice(0, cAt);
      const where = (s: string) => recent.includes(s) ? 'recent' : compacted.includes(s) ? 'summary' : primed.includes(s) ? 'memory' : 'absent';
      source = { contact: where(first.contact), budget: where(first.budget) };
    }
    memory.close();
    return {
      arm, book, window: HIST_WINDOW, awm: awmVersion, trial: n, seed, order: clients.map((c) => c.key).join('>'),
      steps: Number(r.steps ?? 0), maxSteps, reason: String(r.reason), messagesTaken: delivered,
      primary: final.pass, checks: final.checks,
      itemLines: { right: lineScores.reduce((s, x) => s + x.right, 0), wrong: lineScores.reduce((s, x) => s + x.wrong, 0), bleed: lineScores.reduce((s, x) => s + x.bleed, 0), of: lineScores.length * 6 },
      reportsWritten: reports.filter((x) => x.text).length + (finalText ? 1 : 0),
      source, briefReads, actions,
      costUsd: Number(r.costUsd ?? 0) + summarizerCost, summarizerCostUsd: summarizerCost,
    };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

if (process.argv.includes('--selftest')) {
  // The scorers on hand-made reports (no model calls): right, a wrong case, a bleed, a stale deadline.
  const a = CLIENTS[0], b = CLIENTS[1];
  const good = [a.code, ...a.items.map((it, i) => `${applyCase(it, a.case)}: ${qty(0, i)} ${a.tag}`)].join('\n');
  console.log(JSON.stringify({
    goodLines: scoreLines(good, a),
    lowerCaseLines: scoreLines(good.toLowerCase(), a),
    bleedLines: scoreLines(good.replace(/#north/g, '#east'), a),
    finalGood: scoreFinal(`${a.code}\nContact: ${a.contact}\nBudget: ${a.budget}\nDeadline: ${NEW_DEADLINE}`, a).pass,
    finalStale: scoreFinal(`${a.code}\nContact: ${a.contact}\nBudget: ${a.budget}\nDeadline: ${a.deadline}`, a).pass,
    finalBleed: scoreFinal(`${a.code}\nContact: ${b.contact}\nBudget: ${a.budget}\nDeadline: ${NEW_DEADLINE}`, a).pass,
    orders: [1001, 1002, 1003, 1004].map((s) => order(s).map((c) => c.key).join('>')),
  }));
  rmSync(cfgDir, { recursive: true, force: true });
  process.exit(0);
}

for (let n = 1; n <= trials; n++) {
  try { console.log(JSON.stringify(await oneTrial(n))); }
  catch (e) { console.log(JSON.stringify({ arm, book, trial: n, error: (e as Error).message.slice(0, 200) })); }
}
rmSync(cfgDir, { recursive: true, force: true });
process.exit(0);
