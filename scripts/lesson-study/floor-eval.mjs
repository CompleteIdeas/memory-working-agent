// BL-35 quality study: the floor alone, on one half of the labelled pool —  node scripts/lesson-study/floor-eval.mjs train [misses]
import { readFileSync } from 'node:fs';
import { floorHits } from './floor.mjs';
const L = JSON.parse(readFileSync('results/lesson-study-labels.json', 'utf8'));
const pool = JSON.parse(readFileSync('results/lesson-study-pool.json', 'utf8'));
const split = process.argv[2] ?? 'train';
let tp = 0, fp = 0, pos = 0, neg = 0; const fps = [], misses = [];
for (const p of pool) {
  const l = L[p.id]; if (l.split !== split || l.evasion === 'excluded') continue;
  const h = floorHits(p.lesson);
  if (l.evasion === 'yes') { pos++; if (h.length) tp++; else misses.push(p.id + ' ' + p.lesson.slice(0, 110)); }
  else { neg++; if (h.length) { fp++; fps.push(p.id + ' [' + h + '] ' + p.lesson.slice(0, 200)); } }
}
console.log(`${split}: floor caught ${tp}/${pos} evasion; flagged ${fp}/${neg} good`);
console.log('FALSE FLAGS:\n' + fps.join('\n'));
if (process.argv[3]) console.log('MISSES:\n' + misses.join('\n'));
