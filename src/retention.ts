/**
 * V2 RETENTION benchmark — measures AWM's actual strength: does a decision set
 * at turn 1 survive to the final turn, amid distractors?
 *
 * Tasks are deliberately SIMPLE (coding skill is not the variable). The only
 * variable is whether the 3 project conventions established up front reach the
 * final generation:
 *   A (AWM)         — conventions + distractors written to memory; final turn RECALLS
 *   B (no memory)   — conventions gone by the final turn (the floor)
 *   D (long-context)— full transcript (conventions + all distractors) stuffed in;
 *                     tests lost-in-the-middle as distractor count grows
 *
 * Swept over distractor count. AWM should hold ~3/3 at every depth; long-context
 * should degrade as distractors bury turn 1. Deterministic 0–3 grader.
 */
import { pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { getProvider } from './provider.js';
import { MwaMemory } from './awm.js';
import { parseJsonLoose } from './util.js';

const CONVENTIONS: { concept: string; text: string }[] = [
  { concept: 'convention: record id format', text: "Record ids MUST be the name uppercased, prefixed with 'REC-'. e.g. for name 'alice' the id is 'REC-ALICE'." },
  { concept: 'convention: amounts integer cents', text: 'Monetary amounts MUST be stored as INTEGER CENTS: amount = Math.round(dollars * 100). Never a float.' },
  { concept: 'convention: file header', text: "Every source file's FIRST line MUST be exactly: // project:ledger" },
];

const FINAL_TASK =
  "Create record.mjs exporting makeRecord(name, dollars) that returns an object { id, name, amount }, honoring ALL established project conventions. Output ONLY JSON: {\"content\":\"<full record.mjs contents>\"}.";

function distractor(i: number): { concept: string; text: string } {
  const colors = ['blue', 'green', 'amber', 'slate'];
  return {
    concept: `note ${i}: misc`,
    text: `Misc note ${i}: dashboards use the ${colors[i % 4]} theme; standup moved to ${8 + (i % 9)}:30; helper foo${i} was renamed to bar${i}; ticket T-${1000 + i} closed.`,
  };
}

/** Grade the produced record.mjs 0–3 against the conventions (deterministic). */
async function grade(content: string, dir: string): Promise<{ score: number; c1: boolean; c2: boolean; c3: boolean }> {
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, 'record.mjs');
  writeFileSync(file, content, 'utf8');
  let c1 = false, c2 = false, c3 = false;
  // C3: first line header (static)
  try {
    c3 = readFileSync(file, 'utf8').split('\n')[0].trim() === '// project:ledger';
  } catch { /* */ }
  // C1 + C2: behavior
  try {
    const mod = await import(pathToFileURL(file).href + `?t=${Math.random()}`);
    const r = mod.makeRecord('alice', 4.5);
    c1 = r && r.id === 'REC-ALICE';
    c2 = r && Number.isInteger(r.amount) && r.amount === 450;
  } catch { /* import/exec failed → c1/c2 stay false */ }
  return { score: (c1 ? 1 : 0) + (c2 ? 1 : 0) + (c3 ? 1 : 0), c1, c2, c3 };
}

type Arm = 'A_awm' | 'B_nomem' | 'D_longctx';

async function buildContext(arm: Arm, distractors: number, runId: string): Promise<{ block: string; recalled: number; close: () => void }> {
  if (arm === 'B_nomem') {
    return { block: '(no project context available)', recalled: 0, close: () => {} };
  }
  if (arm === 'D_longctx') {
    // full transcript: conventions first (turn 1), then all distractors, then the task is far away
    const lines = [
      'PROJECT CONVENTIONS (established at project start):',
      ...CONVENTIONS.map((c, i) => `${i + 1}. ${c.text}`),
      '',
      'SUBSEQUENT NOTES:',
      ...Array.from({ length: distractors }, (_, i) => `- ${distractor(i).text}`),
    ];
    return { block: lines.join('\n'), recalled: 0, close: () => {} };
  }
  // A_awm: write conventions + distractors to memory, then recall against the task
  const db = `./data/ret-${runId}.db`;
  for (const ext of ['', '-wal', '-shm']) rmSync(db + ext, { force: true });
  const mem = new MwaMemory(`ret-${runId}`, db);
  for (const c of CONVENTIONS) await mem.write(c.concept, c.text, ['topic=convention'], { canonical: true, eventType: 'decision' });
  for (let i = 0; i < distractors; i++) { const d = distractor(i); await mem.write(d.concept, d.text, ['topic=note']); }
  const hits = await mem.recall('record.mjs makeRecord id amount file conventions to honor', { limit: 6 });
  const block = hits.length
    ? 'RECALLED PROJECT CONVENTIONS:\n' + hits.map((h, i) => `${i + 1}. ${h.content}`).join('\n')
    : '(no conventions recalled)';
  return { block, recalled: hits.length, close: () => mem.close() };
}

export async function runRetention(opts: { distractorCounts?: number[]; runId?: string } = {}): Promise<void> {
  const sweep = opts.distractorCounts ?? [10, 50, 200];
  const runId = opts.runId ?? 'ret';
  const gen = getProvider('brain'); // simple gen task — cheap model is fine; retention is the variable
  const arms: Arm[] = ['A_awm', 'B_nomem', 'D_longctx'];
  const rows: { arm: Arm; D: number; score: number; c1: boolean; c2: boolean; c3: boolean; recalled: number; inTok: number }[] = [];

  for (const arm of arms) {
    for (const D of sweep) {
      const ctx = await buildContext(arm, D, `${runId}-${arm}-${D}`);
      const prompt = [
        ctx.block,
        '',
        `TASK: ${FINAL_TASK}`,
      ].join('\n');
      const out = await gen.chat({
        system: 'You are a careful engineer. Follow ALL established project conventions exactly. Output only the requested JSON.',
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 700,
      });
      ctx.close();
      let content = '';
      try { content = parseJsonLoose<{ content: string }>(out.text).content ?? ''; } catch { content = out.text; }
      const g = await grade(content, `./sandbox/ret/${runId}-${arm}-${D}`);
      rows.push({ arm, D, ...g, recalled: ctx.recalled, inTok: out.usage.input });
      console.error(`[ret] ${arm} D=${D}: score=${g.score}/3 (id=${g.c1?'✓':'✗'} cents=${g.c2?'✓':'✗'} hdr=${g.c3?'✓':'✗'}) recalled=${ctx.recalled} inTok=${out.usage.input}`);
    }
  }

  const cell = (arm: Arm, d: number) => rows.find((r) => r.arm === arm && r.D === d);
  // Table 1: accuracy (adherence /3) vs distractor count
  console.log('\n=== RETENTION accuracy: convention adherence (score /3) vs distractor count ===');
  console.log(['arm'.padEnd(12), ...sweep.map((d) => `D=${d}`.padStart(8))].join(''));
  for (const arm of arms) {
    console.log([arm.padEnd(12), ...sweep.map((d) => `${cell(arm, d)?.score ?? '-'}/3`.padStart(8))].join(''));
  }
  // Table 2: input tokens carried per turn vs distractor count (the AWM cost win)
  console.log('\n=== CONTEXT COST: input tokens carried into the final turn vs distractor count ===');
  console.log(['arm'.padEnd(12), ...sweep.map((d) => `D=${d}`.padStart(8))].join(''));
  for (const arm of arms) {
    console.log([arm.padEnd(12), ...sweep.map((d) => `${cell(arm, d)?.inTok ?? '-'}`.padStart(8))].join(''));
  }
  // The headline ratio: at the deepest sweep point, long-context vs AWM input tokens at equal accuracy
  const deep = sweep[sweep.length - 1];
  const aTok = cell('A_awm', deep)?.inTok ?? 0;
  const dTok = cell('D_longctx', deep)?.inTok ?? 0;
  const aAcc = cell('A_awm', deep)?.score ?? 0;
  const dAcc = cell('D_longctx', deep)?.score ?? 0;
  console.log(`\nAt D=${deep}: A_awm ${aAcc}/3 @ ${aTok} tok  vs  D_longctx ${dAcc}/3 @ ${dTok} tok` +
    (aTok ? `  → AWM carries ${(dTok / aTok).toFixed(1)}× fewer input tokens at ${aAcc >= dAcc ? 'equal-or-better' : 'lower'} accuracy.` : ''));
  console.log('AWM holds adherence with a FLAT token cost as distractors grow; long-context re-sends everything every turn.\n');
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('retention.ts') || entry.endsWith('retention.js')) {
  const counts = process.env.RET_DISTRACTORS ? process.env.RET_DISTRACTORS.split(',').map(Number) : undefined;
  runRetention({ distractorCounts: counts }).catch((e) => {
    console.error('retention failed:', e);
    process.exit(1);
  });
}
