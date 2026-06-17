# AWM whole-pipeline improvement register

A "turn over every rock" audit: the full AWM pipeline mapped against current ACT-R / memory /
retrieval research (2023–2026). Three independent investigations (pipeline map, ACT-R advances,
entity-centric retrieval) **converged** on the same conclusion — captured here as a prioritized,
testable register. Preserves AWM's unique features (shared substrate, precision-first, abstention,
the ACT-R core); most items *deepen* those rather than replace them.

## What AWM already does well (do NOT rebuild)

The map confirms AWM is already sophisticated — far past "BM25 + vector + rerank":
- **ACT-R base-level decay** (`B = ln(n+1) − d·ln(age/(n+1))`, d adaptive 0.3–0.6), confidence- &
  replay-modulated. Matches the community reference; `d=0.5` is still the standard. **No change needed.**
- **Hebbian edges** with log-space strengthening + power-law (DASH) decay + a **validation gate**
  (Kairos-style: edges held pending feedback). Sophisticated. Keep.
- **Multi-graph walk** already exists (Phase 4–5): 4 edge types (semantic/temporal/causal/entity),
  beam search, depth-2, causal-boost, capped at +0.25.
- **Entity-bridge boost** (Phase 3.7), **Rocchio PRF** (Phase 3.5), **coref expansion** (Phase −1),
  **multi-channel OOD abstention** (Phase 8), **confidence** computation (Phase 9), consolidation
  (clustering + synthesis + fade + forget + homeostasis). This is the precision-first moat. Keep.

## The convergent finding (all three investigations)

> **The lever is candidate GENERATION, not scoring/rerank.** Broaden what enters the pool, gate
> precision, and let the existing cross-encoder rerank make the final cut — *never widen the final
> cut itself.* AWM's rich scoring/graph-walk operates on the candidate pool; if the bridging fact
> isn't in the pool (and at scale it often isn't — and the edge to reach it often doesn't exist),
> none of the downstream machinery can help.

And the single highest-leverage upgrade, named by both research legs independently:
**bounded iterative spreading activation** (the principled, multi-hop, precision-preserving version
of the one-hop fetch we hand-rolled), which AWM is *almost* set up for already.

## Prioritized register (each → rigorous test before ship)

### #R1 — Broaden edge FORMATION (precondition; unblocks everything)
**Finding:** `connections.ts` forms `connection` edges only via a top-5 semantic `activate` at write
(threshold **0.7**). So entity-sharing facts below 0.7 cosine **don't link** — exactly why test 0
found no edge between "main project = Atlas" and "Atlas's codename = Magpie". The graph walk + any
spreading activation are starved of the edges they need.
**Change:** also form edges on **entity co-occurrence** (shared proper-noun/tag) and **temporal/session
adjacency** (co-written / same `sid=`), at lower weight — not just high-cosine. Research backing:
predictive associative memory (PAM, arXiv 2602.11322) — temporal co-occurrence edges enable the
associative leaps cosine misses.
**Cost:** low–med (edge-discovery rule in connections/consolidation). **Leverage:** high — feeds R2/R3.
**Risk:** edge bloat (mitigate: cap per node — already `MAX_EDGES_PER_ENGRAM=20`; low initial weight; decay prunes).

### #R2 — Bounded iterative spreading activation (PPR / SYNAPSE-style) — HIGHEST accuracy lever
**Finding:** AWM's graph walk is fixed-depth-2 beam. The 2025 SOTA (SYNAPSE, arXiv 2601.02744) runs
**bounded iterative** activation (T=3) with the **ACT-R fan-effect normalizer** + **lateral
inhibition** (top-M competition) — which is what makes multi-hop *raise* precision instead of
flooding. Equivalent to **Personalized PageRank** (≡ Successor Representation, arXiv 2512.24722),
computable as power iteration `O(k·m)`, fully local, no LLM. SYNAPSE: **40.5 F1 on LoCoMo (vs Zep
39.7), multi-hop 35.7 vs 27.0, adversarial 96.6**, ~+15–40ms.
**Change:** replace/augment the depth-2 beam with iterative PPR-style spread over the (now richer, R1)
graph: `u(t+1)=(1−δ)a + Σ S·w_ji·a_j/fan(j)`, lateral inhibition, `max(own, propagated)` not sum,
node-budget + edge-type filter for bounded cost. Candidates the spread reaches **enter the pool**
(recall-only) → rerank finalizes.
**Cost:** medium. **Leverage:** highest (multi-hop + precision together). **This is the principled,
in-AWM version of the harness bridge** — and it benefits every consumer, not just MWA.
**Risk:** the precision/cost knobs need calibration → the LoCoMo + 4-suite + gauntlet gate.

### #R3 — Entity inverted index + alias table (near-free breadth for entity search)
**Finding (the "broader entity search" question):** add an `entity → memories` inverted index +
`entity → entity` alias table *over* the existing store (no graph DB). Dependency-parse (spaCy SVO)
extraction hits ~94% of LLM-graph quality at ~1000× speed; fuse with vector via RRF. Collapses
surface forms ("Atlas" / "the Atlas project" / "my main project") to one entity.
**Change:** lightweight entity index maintained at write/consolidation; query-side entity extraction
drives a precise entity-scoped candidate fetch (confidence-gated to avoid wrong-entity routing).
**Cost:** low. **Leverage:** med-high for entity/attribute queries. **Risk:** entity-extraction errors,
alias over-merge (gate + keep recall-only).

### #R4 — Sparse attribute-triple layer (optional, bigger) — precise "X's <attribute>"
**Finding:** a sparse `(entity, attribute, value, source)` layer alongside free-text resolves
"what is X's <attribute>" with zero context bloat (maps to Mem0g triplets + AWM's prefix-tags).
**Cost:** med-high (extraction + dual-store). **Leverage:** high for attribute lookups (the sparse-cue
class). **Defer** behind R1–R3 unless attribute queries dominate.

### Explicitly OUT (preserve the design)
- LLM-driven schema/reflection consolidation (A-MEM, Hindsight reflect) — LLM in the loop; if ever,
  an **offline batch job**, never the hot path.
- Neural complementary-learning-systems — maps weakly to a symbolic store; AWM's working→canonical
  tiering + fade already approximates two-speed CLS.
- Predictive async prefetch — payoff assumes 100–500ms latency to hide; AWM is already fast.

## Test plan (the rigorous process, per item)

Each candidate ships only if it passes ALL, default-off until green:
1. **Targeted:** the gauntlet `sparse-cue` + `multihop` improve (k≥3).
2. **No accuracy regression:** AWM 4-suite eval ≥ baseline; **LoCoMo adversarial precision not down**
   (the 0.7.16 gate); LoCoMo multi-hop/open-domain ideally *up*.
3. **Cost:** recall-ms within budget (the spread node-budget / index lookups bounded).
4. **Precision guard:** added candidates are recall-only; rerank must still demote them (precision@k flat).
5. Off-switch + clean revert (one contiguous block / env flag).

## Recommendation

Sequence: **R1 → R2** first (R1 unblocks R2; together they deliver true in-AWM multi-hop that's
precise and benefits all consumers — the principled successor to the MWA harness bridge), then **R3**
(near-free entity breadth). R4 only if attribute queries dominate. Each through the gate above.

This is the highest-fidelity path: it deepens AWM's *existing* ACT-R + graph + Hebbian design with
the 2025 SOTA (iterative spreading + fan-normalization + lateral inhibition) rather than bolting on
anything foreign — and every step is gated by the same LoCoMo + 4-suite + gauntlet rigor that got the
historical numbers.

---

## Results — 2026-06-16 validation pass (turn over every rock)

All changes are behind **default-OFF** env flags; the production path is unchanged. Validated through
LoCoMo (expansion-off, AWM 0.8.8) + a purpose-built attribution eval + (pending) gauntlet.

### R1 — broaden edge formation (`AWM_BROAD_EDGES`) — KEEP as enabler, default-off
Corrected the test-0 conclusion: entity-linked facts *did* already link via consolidation, but at
weight **0.09** (too weak for the graph walk). R1 raises entity-co-occurrence edges to **~0.52**
(verified). No standalone recall win; retained as the graph enabler for R2.

### R2 — bounded iterative spreading activation (`AWM_SPREAD`/`AWM_SPREAD_INJECT`) — **PARKED**
Built faithfully (T=3, fan-normalization, lateral inhibition, restart, node budget; boost folds into
`composite` to survive rerank; optional out-of-pool injection). **Result: REGRESSED LoCoMo** (overall
22.7→20.7, multi-hop 13.4→12.3, single-hop −5.1; adversarial held). Spreading/injection adds
graph-neighbor candidates that *displace genuine evidence turns*. This **disconfirms** the R2 thesis on
LoCoMo and **confirms** the prior doctrine: in-store ranking boosts fight the cross-encoder (AWM's final
cut by design); the **harness bridge** (re-query with the entity) remains the design-aligned multi-hop
fix. Kept as opt-in experimental, not shipped.

### Auto-tagger wiring (`AWM_AUTOTAG`) — latent-bug fix, SAFE, opt-in
`extractMetaTags` (emits `entity:<ProperNoun>` + `cat:<category>`) was **exported but never called** —
so the Phase 3.7 entity-bridge boost (which folds into `composite` and *survives* rerank — the genuinely
working multi-hop machinery) had no `entity:` tags to bridge on (inert on LoCoMo, underfed in real use).
Wired into `write-pipeline.ts` `createNewEngram` (additive, gated); `cat:` excluded from the bridge
(too broad — kept for BM25 recall only, `entity:` kept as bridges). **Neutral on LoCoMo recall, precision
held.** Complementary to query-bridge.

### #R-NEW — Query-conditioned entity bridge (`AWM_QUERY_BRIDGE`) — **VALIDATED WIN**
**The positive outcome of this pass.** The Phase 3.7 bridge was query-*blind*: it bridged from the top
text-match anchor's tags and a document-frequency filter *deleted* common tags (e.g. a speaker in >30%
of turns). That is backwards for attribution: if the query names "Caroline," her speaker tag is the
*most* valuable bridge regardless of frequency. New Phase 3.75 extracts proper-noun entities from the
**query**, and boosts in-pool candidates whose tags (speaker name / `entity:`) match — **relevance-
modulated** (`boost = matches·0.4·textMatch`, capped) so a broad speaker tag tips same-topic turns toward
the queried speaker without flooding off-topic chatter. Recall-only re-rank, no injection.
**Attribution-precision eval (`scripts/attribution-eval.ts`, 3 speakers × 12 topics, speaker only as a
tag so the reranker is blind):** attrib-win (right speaker outranks the others on-topic) **36%→92%**,
correct@1 16.7→27.8, MRR 0.37→0.59. **Flat on LoCoMo recall@k (22.7→22.7), adversarial held (73.1)** —
proving LoCoMo recall@k is *structurally blind* to attribution precision (it scores "gold turn in top-10,"
never "right speaker above wrong speaker"). This is why the right test had to be built.
**Recommendation: ship default-on** (narrow trigger, relevance-gated, recall-only, zero measured
downside); auto-tag stays opt-in pending a write-latency check; R1 default-off enabler; R2 parked.
