/**
 * Pipeline tracer — "contrast imaging" for an AWM recall.
 *
 * Inject one query and watch it flow through every stage, seeing exactly where each
 * candidate gains or loses signal — the thing you otherwise have to hand-trace:
 *
 *   STAGE 1  Candidate generation  — what the VECTOR channel found (with cosines) and
 *            what the candidate FLOOR excluded; what the KEYWORD (BM25) channel found.
 *            (This is where a cross-lingual or vocab-mismatched fact silently drops out.)
 *   STAGE 2  Scoring (pre-rerank)   — per-candidate signal breakdown: text / vector /
 *            ACT-R decay / hebbian / graph-boost → composite. See which signal carries it.
 *   STAGE 3  Rerank contrast        — run again with the reranker ON; show how the order
 *            CHANGES and each item's reranker score (the precision cut).
 *   STAGE 4  Final + abstention     — the returned few, or [] if AWM abstained.
 *
 * Zero changes to the engine: uses the store's vector/BM25 methods + the activation
 * engine's own per-result phaseScores, run twice (rerank off vs on) for the contrast.
 *
 * Usage:
 *   tsx scripts/trace-query.ts "When is Atlas due?"
 *   AWM_QUERY_BRIDGE=1 tsx scripts/trace-query.ts "What does Caroline think about the trip?"
 *   tsx scripts/trace-query.ts "¿Cuándo vence Atlas?"          # watch cross-lingual drop out
 */
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { MwaMemory } from '../src/awm.js';
import { embed } from 'agent-working-memory/dist/core/embeddings.js';

const DB = resolve('./data/_trace.db');
for (const e of ['', '-wal', '-shm']) { try { rmSync(DB + e); } catch { /* */ } }

const QUERY = process.argv.slice(2).join(' ') || 'When is Atlas due?';
const bar = (x: number, w = 14) => '█'.repeat(Math.max(0, Math.round((x || 0) * w))).padEnd(w, '·');
const f = (x: number | undefined) => (x ?? 0).toFixed(3);

// A small, illustrative corpus (speaker only as a tag; one superseded value; distractors).
const SEED: Array<{ c: string; t: string; tags?: string[] }> = [
  { c: 'atlas deadline', t: 'The Atlas project deadline is August 15.' },
  { c: 'atlas owner', t: 'Marcus Lee leads the Atlas project.' },
  { c: 'atlas codename', t: "Atlas's codename is Magpie." },
  { c: 'caroline trip view', t: 'I think the trip should be relaxed with downtime.', tags: ['caroline'] },
  { c: 'dave trip view', t: 'I think the trip should be packed with activities.', tags: ['dave'] },
  { c: 'budget', t: 'The marketing budget this quarter is forty thousand dollars.' },
  { c: 'office', t: 'The new office is in downtown Portland.' },
  { c: 'standup', t: 'The weekly standup is every Wednesday morning.' },
];

async function main() {
  const m = new MwaMemory('trace', DB);
  for (const s of SEED) await m.write(s.c, s.t, [...(s.tags ?? []), 'topic=demo']);
  await m.consolidate();
  const store = (m as unknown as { store: any }).store;
  const activation = (m as unknown as { activation: any }).activation;
  const aid = (m as unknown as { agentId: string }).agentId;

  const FLOOR = 0.40; // SIM_CANDIDATE_FLOOR_TARGETED (default)
  console.log(`\n${'═'.repeat(74)}\n CONTRAST TRACE  ·  query: "${QUERY}"\n${'═'.repeat(74)}`);

  // ── STAGE 1: candidate generation ────────────────────────────────────────
  const qvec = await embed(QUERY);
  const vh = (store.searchByVector(aid, qvec, 20) as Array<{ engram: any; distance: number }>)
    .map(h => ({ concept: h.engram.concept, cos: 1 - h.distance }));
  const bm = (store.searchBM25WithRank(aid, QUERY, 20) as Array<{ engram: any; bm25Score: number }>)
    .map(h => ({ concept: h.engram.concept, s: h.bm25Score }));

  console.log(`\n▼ STAGE 1 — CANDIDATE GENERATION  (the only step that decides what's eligible)`);
  console.log(`  VECTOR channel (meaning) — cosine vs query, floor=${FLOOR}:`);
  for (const h of vh.slice(0, 8))
    console.log(`     ${h.cos >= FLOOR ? '✓in ' : '✗OUT'}  ${bar(h.cos)} ${f(h.cos)}  ${h.concept}`);
  const dropped = vh.filter(h => h.cos < FLOOR);
  if (dropped.length) console.log(`     ↳ ${dropped.length} candidate(s) FELL BELOW THE FLOOR → invisible to the rest of the pipeline`);
  console.log(`  KEYWORD channel (BM25) — top matches:`);
  for (const h of bm.slice(0, 6)) console.log(`     ${bar(h.s)} ${f(h.s)}  ${h.concept}`);

  // ── STAGE 2: scoring, pre-rerank ─────────────────────────────────────────
  const pre = await activation.activate({ agentId: aid, context: QUERY, limit: 8, useReranker: false, internal: true });
  console.log(`\n▼ STAGE 2 — SCORING (pre-rerank)  ·  signal breakdown per candidate`);
  console.log(`     rank  composite  text   vector  decay  graph   concept`);
  pre.forEach((r: any, i: number) => {
    const p = r.phaseScores;
    console.log(`      ${i + 1}.   ${f(r.score)}    ${f(p.textMatch)}  ${f(p.vectorMatch)}  ${f(p.decayScore)}  ${f(p.graphBoost)}   ${r.engram.concept}`);
  });

  // ── STAGE 3: rerank contrast ─────────────────────────────────────────────
  const post = await activation.activate({ agentId: aid, context: QUERY, limit: 8, internal: true });
  const preOrder = pre.map((r: any) => r.engram.id);
  console.log(`\n▼ STAGE 3 — RERANK CONTRAST  ·  how the expert re-read changes the order`);
  console.log(`     final  Δrank  rerank  composite  concept`);
  post.forEach((r: any, i: number) => {
    const wasAt = preOrder.indexOf(r.engram.id);
    const delta = wasAt < 0 ? 'new' : (wasAt - i === 0 ? '—' : (wasAt - i > 0 ? `↑${wasAt - i}` : `↓${i - wasAt}`));
    console.log(`      ${i + 1}.    ${delta.padStart(4)}  ${f(r.phaseScores.rerankerScore)}   ${f(r.score)}    ${r.engram.concept}`);
  });

  // ── STAGE 4: final + abstention ──────────────────────────────────────────
  console.log(`\n▼ STAGE 4 — FINAL RESULT`);
  if (post.length === 0) {
    console.log(`     ⊘ ABSTAINED — the channels did not agree this query is in-domain. Returned nothing.`);
  } else {
    console.log(`     top answer: "${post[0].engram.concept}" — ${post[0].engram.content.slice(0, 60)}`);
    console.log(`     why: ${post[0].why}`);
  }
  console.log(`${'═'.repeat(74)}\n`);

  m.close();
  for (const e of ['', '-wal', '-shm']) { try { rmSync(DB + e); } catch { /* */ } }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
