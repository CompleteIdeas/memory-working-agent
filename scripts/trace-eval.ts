/**
 * Pipeline-attribution analysis — run a labeled test set through the tracer, capture a
 * STRUCTURED per-stage record for every query, then do statistics on WHERE the pipeline
 * wins or loses. This is the "contrast imaging across many tests" instrument: instead of
 * hand-tracing one query, it quantifies the funnel over a whole set.
 *
 * For each (query → gold answer) it records, per stage:
 *   - gold's vector cosine + whether it cleared the candidate FLOOR
 *   - whether the KEYWORD (BM25) channel found it
 *   - gold's rank PRE-rerank (scoring) and POST-rerank (final); whether AWM abstained
 *   - LOST-AT attribution: the first stage at which the gold answer dropped out
 *
 * Then it aggregates: success@1/@5, abstention rate, mean rerank rank-lift, and a
 * histogram of WHERE losses happen (floor / pool / scoring / rerank / abstain). Flip a
 * flag (e.g. AWM_QUERY_BRIDGE=1) and re-run to see the attribution shift — A/B on the
 * mechanism, not just the score.
 *
 * Usage:   tsx scripts/trace-eval.ts            (baseline)
 *          AWM_QUERY_BRIDGE=1 tsx scripts/trace-eval.ts
 * Scale path: swap SEED/CASES for a labeled benchmark (e.g. LoCoMo query→evidence) to do
 * real pipeline-attribution analysis on a standard dataset.
 */
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { MwaMemory } from '../src/awm.js';
import { embed } from 'agent-working-memory/dist/core/embeddings.js';

const DB = resolve('./data/_traceeval.db');
for (const e of ['', '-wal', '-shm']) { try { rmSync(DB + e); } catch { /* */ } }
const FLOOR = 0.40;

// Corpus: concept → fact (speaker as tag where relevant).
const SEED: Array<{ c: string; t: string; tags?: string[] }> = [
  { c: 'atlas deadline', t: 'The Atlas project deadline is August 15.' },
  { c: 'atlas owner', t: 'Marcus Lee leads the Atlas project.' },
  { c: 'atlas codename', t: "Atlas's codename is Magpie." },
  { c: 'budget', t: 'The marketing budget this quarter is forty thousand dollars.' },
  { c: 'office', t: 'The new office is in downtown Portland.' },
  { c: 'standup', t: 'The weekly standup is every Wednesday morning.' },
  { c: 'launch', t: 'The product launches on the first Monday of March.' },
  { c: 'servers', t: 'Production servers run in the Frankfurt data center.' },
  { c: 'caroline trip', t: 'I think the trip should be relaxed with downtime.', tags: ['caroline'] },
  { c: 'dave trip', t: 'I think the trip should be packed with activities.', tags: ['dave'] },
];

// Labeled probes: query → the concept that is the correct answer. Mix of exact, paraphrase,
// cross-lingual, and attribution to exercise different parts of the funnel.
const CASES: Array<{ q: string; gold: string; kind: string }> = [
  { q: 'When is Atlas due?', gold: 'atlas deadline', kind: 'paraphrase' },
  { q: 'Who runs the Atlas project?', gold: 'atlas owner', kind: 'exact' },
  { q: "What is Atlas's codename?", gold: 'atlas codename', kind: 'exact' },
  { q: 'How much is the marketing budget?', gold: 'budget', kind: 'paraphrase' },
  { q: 'Where is the new office located?', gold: 'office', kind: 'exact' },
  { q: 'What day is the weekly standup?', gold: 'standup', kind: 'exact' },
  { q: 'When does the product go live?', gold: 'launch', kind: 'paraphrase' },
  { q: 'Which data center hosts production?', gold: 'servers', kind: 'paraphrase' },
  { q: 'What does Caroline think about the trip?', gold: 'caroline trip', kind: 'attribution' },
  { q: 'What does Dave think about the trip?', gold: 'dave trip', kind: 'attribution' },
  { q: '¿Cuándo vence el proyecto Atlas?', gold: 'atlas deadline', kind: 'crosslingual' },
  { q: '¿Cuál es el presupuesto de marketing?', gold: 'budget', kind: 'crosslingual' },
];

type Rec = { kind: string; cos: number; aboveFloor: boolean; inBM25: boolean; preRank: number; postRank: number; abstained: boolean; lostAt: string };

async function main() {
  const arm = [process.env.AWM_QUERY_BRIDGE === '1' ? 'query-bridge' : '', process.env.AWM_AUTOTAG === '1' ? 'autotag' : ''].filter(Boolean).join('+') || 'baseline';
  const m = new MwaMemory('traceeval', DB);
  const idOf: Record<string, string> = {};
  for (const s of SEED) idOf[s.c] = (await m.write(s.c, s.t, [...(s.tags ?? []), 'topic=demo'])) ?? '';
  await m.consolidate();
  const store = (m as unknown as { store: any }).store;
  const activation = (m as unknown as { activation: any }).activation;
  const aid = (m as unknown as { agentId: string }).agentId;

  const recs: Rec[] = [];
  for (const c of CASES) {
    const gid = idOf[c.gold];
    const qvec = await embed(c.q);
    const vh = store.searchByVector(aid, qvec, 30) as Array<{ engram: any; distance: number }>;
    const hit = vh.find(h => h.engram.id === gid);
    const cos = hit ? 1 - hit.distance : 0;
    const aboveFloor = cos >= FLOOR;
    const bm = store.searchBM25WithRank(aid, c.q, 30) as Array<{ engram: any; bm25Score: number }>;
    const inBM25 = bm.some(h => h.engram.id === gid);
    const pre = await activation.activate({ agentId: aid, context: c.q, limit: 8, useReranker: false, internal: true });
    const post = await activation.activate({ agentId: aid, context: c.q, limit: 8, internal: true });
    const preRank = pre.findIndex((r: any) => r.engram.id === gid) + 1;   // 0 = absent
    const postRank = post.findIndex((r: any) => r.engram.id === gid) + 1;
    const abstained = post.length === 0;

    // Attribute the first stage at which the gold answer was lost.
    let lostAt = 'success@1';
    if (postRank === 1) lostAt = 'success@1';
    else if (postRank >= 2 && postRank <= 5) lostAt = 'found@2-5';
    else if (abstained) lostAt = (aboveFloor || inBM25) ? 'abstain(had-signal)' : 'abstain(no-signal)';
    else if (!aboveFloor && !inBM25) lostAt = 'lost@candidate-floor';
    else if (preRank === 0) lostAt = 'lost@pool/scoring';
    else if (preRank > 0 && postRank === 0) lostAt = 'lost@rerank';
    else lostAt = 'lost@final-cut';
    recs.push({ kind: c.kind, cos, aboveFloor, inBM25, preRank, postRank, abstained, lostAt });
  }
  m.close();
  for (const e of ['', '-wal', '-shm']) { try { rmSync(DB + e); } catch { /* */ } }

  const n = recs.length;
  const pct = (k: number) => `${(100 * k / n).toFixed(0)}%`;
  const succ1 = recs.filter(r => r.postRank === 1).length;
  const succ5 = recs.filter(r => r.postRank >= 1 && r.postRank <= 5).length;
  const abst = recs.filter(r => r.abstained).length;
  const aboveFloor = recs.filter(r => r.aboveFloor).length;
  // rerank lift = (preRank - postRank) for cases present in both (positive = rerank promoted gold)
  const lifts = recs.filter(r => r.preRank > 0 && r.postRank > 0).map(r => r.preRank - r.postRank);
  const meanLift = lifts.length ? (lifts.reduce((a, b) => a + b, 0) / lifts.length) : 0;

  console.log(`\n${'═'.repeat(72)}\n PIPELINE-ATTRIBUTION ANALYSIS  ·  arm=${arm}  ·  ${n} labeled probes\n${'═'.repeat(72)}`);
  console.log(` success@1 ${pct(succ1)} (${succ1}/${n})   success@5 ${pct(succ5)}   abstained ${pct(abst)}`);
  console.log(` gold cleared candidate floor: ${pct(aboveFloor)} (${aboveFloor}/${n})   mean rerank rank-lift: +${meanLift.toFixed(1)}`);

  console.log(`\n WHERE THE PIPELINE LANDS (stage attribution):`);
  const buckets = new Map<string, number>();
  for (const r of recs) buckets.set(r.lostAt, (buckets.get(r.lostAt) ?? 0) + 1);
  for (const [k, v] of [...buckets.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`   ${'█'.repeat(v).padEnd(n)} ${pct(v).padStart(4)}  ${k}`);

  console.log(`\n BY QUERY KIND (success@1):`);
  for (const kind of [...new Set(CASES.map(c => c.kind))]) {
    const rk = recs.filter(r => r.kind === kind);
    const s = rk.filter(r => r.postRank === 1).length;
    console.log(`   ${kind.padEnd(12)} ${(100 * s / rk.length).toFixed(0).padStart(3)}%  (${s}/${rk.length})`);
  }

  console.log(`\n PER-PROBE DETAIL:`);
  console.log(`   kind         cos   floor bm25  pre→post  outcome`);
  recs.forEach((r, i) => {
    console.log(`   ${r.kind.padEnd(12)} ${r.cos.toFixed(3)}  ${r.aboveFloor ? ' ✓ ' : ' ✗ '}  ${r.inBM25 ? '✓' : '·'}    ${String(r.preRank || '-').padStart(2)}→${String(r.postRank || '-').padStart(2)}    ${r.lostAt}`);
  });
  console.log(`${'═'.repeat(72)}\n`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
