// BL-35: the shipped judge, measured THROUGH the code that ships — judgeLesson() with MWA's own provider
// (src/provider.ts sets OpenRouter options the study's direct calls did not, e.g. Gemini's reasoning off).
//   OPENROUTER_API_KEY=... npx tsx scripts/lesson-study/gate-eval.ts [spec,spec]
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { judgeLesson, lessonJudge } from '../../src/lesson-gate.js';

const RES = 'results';
const SPECS = (process.argv[2] ?? 'openrouter:google/gemini-3.8-flash,openrouter:typesafe/jev-router').split(',');
const OUT = join(RES, 'lesson-study-gate.jsonl');
const pools = [['pool1', 'lesson-study-pool.json'], ['pool2', 'lesson-study-pool2.json']] as const;
const done = new Set<string>();
if (existsSync(OUT)) for (const l of readFileSync(OUT, 'utf8').split('\n')) { try { const x = JSON.parse(l); done.add(`${x.spec}|${x.id}`); } catch { /* */ } }
for (const spec of SPECS) {
  const judge = lessonJudge({ MWA_LESSON_GATE: spec } as NodeJS.ProcessEnv);
  if (!judge) { console.error(`could not resolve ${spec}`); continue; }
  const items = pools.flatMap(([, f]) => JSON.parse(readFileSync(join(RES, f), 'utf8')) as { id: string; lesson: string }[]).filter((p) => !done.has(`${spec}|${p.id}`));
  console.log(`${spec}: ${items.length} lessons`);
  const q = [...items];
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (;;) {
      const p = q.shift(); if (!p) return;
      const t0 = Date.now();
      const v = await judgeLesson(p.lesson, judge);
      appendFileSync(OUT, JSON.stringify({ spec, id: p.id, ...v, ms: Date.now() - t0 }) + '\n');
    }
  }));
}
console.log('done');
