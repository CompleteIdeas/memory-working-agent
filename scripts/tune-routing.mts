// A5: measure and tune the routing weights and thresholds on tests/fixtures/routing-40.json with the real embedding
// model (bge-small-en-v1.5, the one AWM loads for recall). No model calls; no network once the model is cached.
// Run: npx tsx scripts/tune-routing.mts
import { readFileSync } from 'node:fs';
import { resetAppDb } from '../src/v2/db.js';
import { createProject, insertTurn, scoreProjects, decide, ROUTING, type ProjectScore } from '../src/v2/projects.js';

process.env.VITEST = '1'; // app.db in memory
resetAppDb(':memory:');
const fx = JSON.parse(readFileSync(new URL('../tests/fixtures/routing-40.json', import.meta.url), 'utf8'));
const ids = new Map<string, string>();
let ts = 1_000;
for (const p of fx.projects) {
  const row = createProject({ name: p.name });
  ids.set(p.key, row.id);
  for (const m of p.thread) insertTurn({ projectId: row.id, ts: ts++, kind: 'chat', message: m, reply: 'ok' });
}
const cases = [...fx.messages.map((m: any) => ({ text: m.text, want: ids.get(m.project)! })), ...fx.unsure.map((t: string) => ({ text: t, want: 'general' }))];
const scored: { text: string; want: string; s: ProjectScore[] }[] = [];
for (const c of cases) scored.push({ ...c, s: (await scoreProjects(c.text))! });

const rescore = (s: ProjectScore[], w: typeof ROUTING) => s.map((x) => ({ ...x, score: (x.byThread == null ? x.byName : w.NAME_WEIGHT * x.byName + (1 - w.NAME_WEIGHT) * x.byThread) + w.LEX_WEIGHT * x.lex }))
  .sort((a, b) => b.score - a.score);
const results: { w: typeof ROUTING; ok: number; vague: number }[] = [];
for (const NAME_WEIGHT of [0.2, 0.35]) for (const LEX_WEIGHT of [0, 0.02, 0.04, 0.06]) for (const SUGGEST of [0.45, 0.5, 0.55]) for (const MARGIN of [0, 0.01, 0.02, 0.03, 0.04]) {
  const w = { ...ROUTING, NAME_WEIGHT, LEX_WEIGHT, SUGGEST, MARGIN };
  let ok = 0, vague = 0;
  for (const c of scored) {
    const got = decide(rescore(c.s, w), undefined, w).projectId;
    if (c.want === 'general') { if (got === 'general') vague++; } else if (got === c.want) ok++;
  }
  results.push({ w, ok, vague });
}
results.sort((a, b) => b.ok + 2 * b.vague - (a.ok + 2 * a.vague));
for (const r of results.slice(0, 15)) console.log(`name ${r.w.NAME_WEIGHT} lex ${r.w.LEX_WEIGHT} suggest ${r.w.SUGGEST} margin ${r.w.MARGIN}: ${r.ok}/40 right, ${r.vague}/${fx.unsure.length} vague kept in General`);
const cur = results.find((r) => r.w.NAME_WEIGHT === ROUTING.NAME_WEIGHT && r.w.LEX_WEIGHT === ROUTING.LEX_WEIGHT && r.w.SUGGEST === ROUTING.SUGGEST && r.w.MARGIN === ROUTING.MARGIN);
console.log(`\ncurrent ROUTING: ${cur ? `${cur.ok}/40 right, ${cur.vague}/${fx.unsure.length} vague kept in General` : 'not on the grid'}`);
for (const c of scored) {
  const got = decide(c.s, undefined).projectId;
  if (got !== c.want) console.log(`  miss: "${c.text}" → ${got} (want ${c.want}); top ${c.s.slice(0, 2).map((x) => `${x.project.name} ${x.score} lex ${x.lex.toFixed(2)}`).join(' | ')}`);
}
process.exit(0);
