/* Stress / longevity dogfood: long iterate-until-green loop, dead-end (anti-thrash),
 * multi-turn clarify→build chain, wide research matrix, error→recover. Watches that the
 * loop stays BOUNDED (no thrash to budget) and COMPLETES. */
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { CONFIG_PATH, loadConfig } from '../src/config.js';
import { getProvider } from '../src/provider.js';
import { RoutedProvider } from '../src/model-router.js';
import { MwaMemory } from '../src/awm.js';
import { buildRegistry } from '../src/tools/build.js';
import { runAgent } from '../src/agent.js';
import { setAccess, type AccessPreset } from '../src/tools/access.js';
import { loadEnv } from '../src/env.js';

const ROOT = resolve('./data/_stress'); const DB = resolve('./data/_stress.db');
const backup = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, 'utf8') : null;

(async () => {
  loadEnv();
  try { rmSync(DB, { force: true }); rmSync(DB + '-wal', { force: true }); rmSync(DB + '-shm', { force: true }); rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
  const memory = new MwaMemory('mwa-stress', DB);
  const brain = new RoutedProvider(getProvider('brain'), getProvider('high'));
  const worker = new RoutedProvider(getProvider('brain'), getProvider('high'));

  async function turn(id: string, dir: string, hist: any[], preset: AccessPreset, interactive: boolean, msg: string, maxSteps: number) {
    setAccess(preset, []);
    const cfg = loadConfig();
    const ctx = hist.slice(-3).map((h, i) => `(${i + 1}) ${h.instruction} -> ${h.summary}`).join('\n');
    const instr = ctx ? `Recent conversation so far:\n${ctx}\n\nNew request: ${msg}` : msg;
    const evts: string[] = [];
    const { registry, close } = await buildRegistry(cfg);
    const r = await runAgent({ instruction: instr, dir, memory, brain, worker, tools: registry, workspace: cfg.awm.workspace, session: id, interactive, budget: { maxSteps, maxWallMs: 9 * 60_000, consolidateEvery: 10 }, onEvent: (t) => { if (['ask', 'dispatch', 'escalate'].includes(t)) evts.push(t); } }).catch((e) => ({ summary: 'ERR ' + (e as Error).message, reason: 'error', steps: 0, toolCalls: 0, dispatches: 0, costUsd: 0 } as any));
    await close(); hist.push({ instruction: msg, summary: r.summary ?? '' });
    return { r, evts, maxSteps, files: (() => { try { return readdirSync(dir); } catch { return []; } })() };
  }
  const dir = (id: string) => { const d = join(ROOT, id); mkdirSync(d, { recursive: true }); return d; };
  const read = (d: string, f: string) => { try { return readFileSync(join(d, f), 'utf8'); } catch { return ''; } };
  const show = (n: string, pass: boolean, t: any, extra = '') => {
    const hitBudget = t.r.steps >= t.maxSteps || t.r.reason === 'budget';
    console.log(`\n[${pass ? 'PASS' : 'FAIL'}] ${n} — reason=${t.r.reason} steps=${t.r.steps}/${t.maxSteps}${hitBudget ? ' ⚠HIT-BUDGET' : ''} disp=${t.r.dispatches} esc=${t.evts.filter((e: string) => e === 'escalate').length} $${t.r.costUsd.toFixed(4)} ${extra}`);
    console.log('   files:[' + t.files.join(', ') + '] ' + (t.r.summary ?? '').replace(/\s+/g, ' ').slice(0, 180));
  };

  // S1 — iterate-until-green build/test/fix loop (long)
  const d1 = dir('s1'); const s1 = await turn('s1', d1, [], 'developer', true, 'Create calc.js exporting add, sub, mul, div (div must handle divide-by-zero sensibly). Write test.js with assert cases for all four including divide-by-zero. Run the tests; if any fail, fix calc.js and re-run until ALL pass. Report the final test results.', 28);
  show('S1 build→test→fix until green', s1.files.includes('calc.js') && s1.files.includes('test.js') && /(all .*pass|passed|✓|4\/4|tests pass)/i.test(s1.r.summary), s1, `divzero=${/zero|Infinity|throw|finite/i.test(read(d1, 'calc.js'))}`);

  // S2 — dead-end: nonexistent email → must stop gracefully (no thrash, no fabrication)
  const s2 = await turn('s2', dir('s2'), [], 'assistant', true, "Find the email from 'Zxqwerty Q. Nonexistentpersonne' about the 2019 quarterly llama budget and summarize what it says.", 14);
  show('S2 dead-end anti-thrash', /(no|could ?n.?t|did ?n.?t|not) (find|locate|see|any|such|matching)|no (email|message)|nothing/i.test(s2.r.summary) && s2.r.steps < s2.maxSteps && !/Subject:/i.test(s2.r.summary), s2, `bounded=${s2.r.steps < s2.maxSteps}`);

  // S3 — multi-turn clarify → build chain
  const d3 = dir('s3'); const h3: any[] = [];
  const s3a = await turn('s3', d3, h3, 'developer', true, 'Make me a landing page.', 12);
  const s3b = await turn('s3', d3, h3, 'developer', true, "It's for a yoga studio called Calm Co — use teal colors and include a class schedule section. Build index.html.", 18);
  { const html = read(d3, 'index.html'); show('S3 clarify→build chain', s3a.evts.includes('ask') && !!html && /calm co/i.test(html) && /teal|#0|#1|#2/i.test(html) && /schedule/i.test(html), s3b, `t1asked=${s3a.evts.includes('ask')} hasPage=${!!html}`); }

  // S4 — wide research matrix (breadth + synthesis stress)
  const d4 = dir('s4'); const s4 = await turn('s4', d4, [], 'assistant', true, 'Compare four note-taking apps — Obsidian, Notion, Apple Notes, and Roam — across price, offline support, linking, and platforms. Write matrix.md with a markdown table (one row per app) and a one-paragraph recommendation for a privacy-focused user. Include a source link or two.', 28);
  { const md = read(d4, 'matrix.md'); show('S4 wide 4x4 matrix', !!md && /obsidian/i.test(md) && /notion/i.test(md) && /apple notes/i.test(md) && /roam/i.test(md) && /recommend/i.test(md) && /http/i.test(md), s4, `md=${md.length}b`); }

  // S5 — error → recover
  const d5 = dir('s5'); const s5 = await turn('s5', d5, [], 'developer', true, 'Run "node missing-script-xyz.js". If it fails (it will — the file does not exist), instead create hello.js that prints "recovered", run it, and report what happened.', 14);
  show('S5 error→recover', s5.files.includes('hello.js') && /recovered/i.test(s5.r.summary), s5);

  memory.close();
})().finally(() => { if (backup !== null) writeFileSync(CONFIG_PATH, backup); console.log('\n(restored mwa.config.json)'); });
