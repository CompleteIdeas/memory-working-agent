// BL-35 quality study: the yes/no judge models on OpenRouter, scored like analyze.mjs (gate = floor OR
// the model says "evasion: yes"), against the same blind labels and the same pass bar.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { floorHits } from './floor.mjs';

const RES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'results');
const L = JSON.parse(readFileSync(join(RES, 'lesson-study-labels.json'), 'utf8'));
const pool = JSON.parse(readFileSync(join(RES, 'lesson-study-pool.json'), 'utf8'));
const rows = readFileSync(join(RES, 'lesson-study-openrouter.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const pct = (a, b) => (b ? `${a}/${b} (${Math.round((100 * a) / b)}%)` : '—');
const yes = (v) => /^y/i.test(String(v ?? ''));

for (const model of [...new Set(rows.map((r) => r.model))]) {
  const R = new Map(rows.filter((r) => r.model === model && !r.error).map((r) => [r.id, r]));
  const errors = rows.filter((r) => r.model === model && r.error).length;
  const unparsed = [...R.values()].filter((r) => !r.answers).length;
  const cost = [...R.values()].reduce((s, r) => s + (r.cost ?? 0), 0);
  const ms = [...R.values()].map((r) => r.ms).sort((a, b) => a - b);
  console.log(`\n=========== ${model} — ${R.size} answered, ${errors} errors, ${unparsed} unparsed; cost $${cost.toFixed(4)} ($${(cost / Math.max(R.size, 1)).toFixed(6)}/lesson); latency median ${ms[Math.floor(ms.length / 2)]} ms, p95 ${ms[Math.floor(ms.length * 0.95)]} ms ===========`);
  const routed = {}; for (const r of R.values()) routed[r.routed] = (routed[r.routed] ?? 0) + 1;
  if (Object.keys(routed).length > 1) console.log('routed to:', JSON.stringify(routed));
  const model_ = (id) => yes(R.get(id)?.answers?.evasion);
  for (const split of ['train', 'test', 'all']) {
    const s = pool.filter((p) => (split === 'all' || L[p.id].split === split) && L[p.id].evasion !== 'excluded' && R.has(p.id));
    const pos = s.filter((p) => L[p.id].evasion === 'yes'), neg = s.filter((p) => L[p.id].evasion === 'no');
    const gate = (p) => floorHits(p.lesson).length > 0 || model_(p.id);
    console.log(`${split.padEnd(5)} model alone: caught ${pct(pos.filter((p) => model_(p.id)).length, pos.length)}, good rejected ${pct(neg.filter((p) => model_(p.id)).length, neg.length)}  |  floor+model: caught ${pct(pos.filter(gate).length, pos.length)}, good rejected ${pct(neg.filter(gate).length, neg.length)}`);
    if (split === 'test') {
      for (const p of pos.filter((q) => !gate(q))) console.log(`   MISSED ${p.id} | ${p.lesson.slice(0, 140)}`);
      for (const p of neg.filter(gate)) console.log(`   REJECTED-GOOD ${p.id} floor=${floorHits(p.lesson)} model=${model_(p.id)} | ${p.lesson.slice(0, 140)}`);
    }
  }
  const all = pool.filter((p) => R.get(p.id)?.answers);
  console.log(`category within the labellers' answers: ${pct(all.filter((p) => L[p.id].cats.includes(String(R.get(p.id).answers.category).toLowerCase())).length, all.length)}`);
  const o = all.filter((p) => L[p.id].outside !== 'excluded');
  console.log(`outside-control: flagged ${pct(o.filter((p) => L[p.id].outside === 'yes' && yes(R.get(p.id).answers.outside)).length, o.filter((p) => L[p.id].outside === 'yes').length)}; wrongly ${pct(o.filter((p) => L[p.id].outside === 'no' && yes(R.get(p.id).answers.outside)).length, o.filter((p) => L[p.id].outside === 'no').length)}`);
  const t = all.filter((p) => L[p.id].transferable !== 'excluded');
  console.log(`junk: dropped ${pct(t.filter((p) => L[p.id].transferable === 'no' && !yes(R.get(p.id).answers.transferable)).length, t.filter((p) => L[p.id].transferable === 'no').length)}; good dropped ${pct(t.filter((p) => L[p.id].transferable === 'yes' && !yes(R.get(p.id).answers.transferable)).length, t.filter((p) => L[p.id].transferable === 'yes').length)}`);
}
