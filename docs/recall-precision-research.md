# Deep dive: AWM recall-precision at scale (the 2-hop / buried-fact gap)

**Problem (measured):** at scale, the directly-relevant memory gets buried under keyword-similar
but tangential memories. Seen in the gauntlet (`sparse-cue`: "codename for my main project" →
the agent answers the project *name* "Atlas", not its codename "Magpie") and on the **live large
AWM** (a 2-hop query whose answer was written minutes earlier returned old tangential memories
in the top-5, not the answer). It is **not a reasoning gap** — the model chains 2- and 3-hop
perfectly (3/3) when the facts are in context (`scripts/_twohop-lever.ts`). It is **candidate
recall**: the right memory never enters the pool the reranker sees.

## Core principle

> **Rerank — and AWM's graph-scoring — cannot rescue a memory that never enters the candidate pool.**

AWM's recall is a funnel: BM25 + vector → candidate pool → rerank → top-K. AWM's differentiator
(the associative/Hebbian graph) runs in *scoring*, **downstream of the cut**. So a 2-hop attribute
fact that's semantically related but not lexically matching the cue is dropped *before* the
cognitive machinery can act on it.

## Root cause in `activation.ts` (four mechanical cliffs)

1. **Fixed candidate-K** — `VECTOR_TOP_K = max(50, limit×5)`; doesn't grow with store size, so at
   thousands of memories the relevant one must out-cosine ~50 competitors.
2. **Hard cosine floor (0.40 targeted)** that *breaks* the scan — a related-but-not-close
   attribute fact below 0.40 is dropped entirely.
3. **BM25 is keyword-dominated** — the entity-*name* fact and topic-overlapping session summaries
   win; the attribute fact (different words) loses.
4. **The graph is used in scoring, not candidate selection** — AWM's moat sits below the choke point.

## What the field does (2025)

Every current approach to *buried-doc / multi-hop* retrieval converges on **graph-expansion +
entity-centric candidate retrieval**:
- QCG-RAG — multi-hop neighbor propagation (arXiv 2509.21237)
- LinearRAG — entity-centric Tri-Graph, multi-hop bridging, linear cost
- FG-RAG — context-aware entity expansion
- HG-RAG / HopRAG — hierarchical multi-hop expansion to maximize recall
Classic complements: HyDE / multi-query (pull more candidates), RRF fusion, MMR (diversify),
dynamic K. **AWM already has the graph these papers build from scratch** — it just isn't wired
into candidate selection.

## Ranked fixes for AWM (my analysis + literature + coworker, converged)

| Rank | Fix | Leverage | Risk | Failure mode |
|---|---|---|---|---|
| **1** | **Graph-expanded candidate retrieval** — traverse Hebbian edges from top BM25/vector seeds, pull 1-hop neighbors INTO the pool before rerank | **High** (directly injects the 2-hop fact, uses existing infra) | **Low** (additive; rerank still filters) | weak/absent edges for never-co-recalled facts → no expansion |
| 2 | Entity-aware fetch — extract query entities, fetch their linked facts directly | High | Low-med | entity-extraction errors; alias collisions ("Atlas" overloaded) |
| 3 | Dynamic candidate-K (log/sqrt scale with store) | Moderate | Moderate | cost creep; still blocked by the floor |
| 4 | RRF fusion (de-dominate BM25) | Modest | Low | doesn't fix "not in pool" |
| 5 | HyDE / query expansion at scale | Moderate | Med | hallucinated expansions shift intent; over-expansion hurts precision |
| 6 | Lower/remove the 0.40 floor | High (raw recall) | **Med-High** | recall explosion → reranker spikes; noise crowds out good candidates |
| 7 | Multi-hop query decomposition | High | **High** | planning errors cascade; latency/orchestration |

**Lead recommendation: (1) graph-expanded candidate retrieval**, paired with (2) entity-aware
fetch. Soften the floor (6) **only after** 1-hop expansion as a safety net — never alone (recall
explosion). This turns AWM's graph from a scoring nicety into a *recall* mechanism at the exact
choke point — the thing GraphRAG/LinearRAG reinvent, but AWM already has the substrate.

## Prototype design (AWM-core — `activation.ts` candidate phase)

After the BM25 + vector candidate gather, before rerank:
1. Take the **top-N seeds** (e.g. N=10) by current candidate score.
2. For each seed, fetch up to **M Hebbian neighbors** (e.g. M=5) from the connection graph
   (edges already exist; `ConnectionEngine`).
3. Add neighbors to the candidate pool (dedupe), tagged as graph-expanded so they're recall-only
   (no extra score bonus — let rerank judge them).
4. Cap total pool growth (e.g. +50) to bound rerank cost.
5. Rerank the enlarged pool as usual.

Budget tunables (env): `AWM_GRAPHEXPAND_SEEDS`, `AWM_GRAPHEXPAND_NEIGHBORS`, `AWM_GRAPHEXPAND_CAP`;
off-switch `AWM_GRAPHEXPAND=0`.

## Validation (this is an AWM-CORE change → same release gate)

- **Targeted:** gauntlet `sparse-cue` + `multihop` recover (the buried attribute fact now enters
  the pool); the live 2-hop query surfaces its answer.
- **No regression:** the 4-suite eval + **LoCoMo** (adversarial precision) — the 0.7.16 gate.
- **Cost:** recall latency stays bounded (the +cap; rerank pool growth measured).
- Pre-register: graph expansion must not *lower* precision (the neighbors are recall-only; rerank
  must still be able to demote them).

## Why this is the right bet

It's the one fix where **AWM's existing differentiator is the solution** — not a bolt-on. The
2025 literature builds entity/graph expansion from scratch to solve exactly this; AWM has the
graph already and is currently leaving it on the table at the candidate stage. Low blast radius
(additive + capped + off-switch), and it targets the precise, measured failure.

---

# Implementation plan (structural)

## Exact injection point
`src/engine/activation.ts`, the `activate()` recall path:
- **Line ~320–329** assembles the candidate pool: `survivorIds = BM25 ∪ vector`, hydrated into
  `candidateMap` / `candidates = Array.from(candidateMap.values())`.
- **Line ~338+** scores every candidate; **~614–640** reranks the top pool.
- **Insert graph-expansion BETWEEN 329 and 338** — neighbors join the pool and flow through the
  *existing* scoring + rerank unchanged. Nothing downstream needs to know they came from the graph.

## The step (pseudocode)
```
// after candidates assembled, before scoring  (gated: process.env.AWM_GRAPHEXPAND !== '0')
const SEEDS     = +(process.env.AWM_GRAPHEXPAND_SEEDS     ?? 10);
const NEIGHBORS = +(process.env.AWM_GRAPHEXPAND_NEIGHBORS ?? 5);
const CAP       = +(process.env.AWM_GRAPHEXPAND_CAP       ?? 50);
const allowed   = new Set(agentIds);          // workspace/agent scoping

// 1. seeds = strongest current candidates (best of bm25Score / rawCosineSim)
const seeds = candidates
  .map(e => ({ e, s: Math.max(bm25ScoreMap.get(e.id) ?? 0, rawCosineSims.get(e.id) ?? 0) }))
  .sort((a,b) => b.s - a.s).slice(0, SEEDS);

let added = 0;
for (const { e } of seeds) {
  if (added >= CAP) break;
  const edges = this.store.getAssociationsFor(e.id)           // undirected
    .map(a => ({ id: a.from_engram_id === e.id ? a.to_engram_id : a.from_engram_id, w: a.weight }))
    .sort((a,b) => b.w - a.w).slice(0, NEIGHBORS);
  for (const { id } of edges) {
    if (candidateMap.has(id) || added >= CAP) continue;
    const n = this.store.getEngram(id);
    if (!n) continue;
    if (!allowed.has(n.agentId)) continue;                    // scope
    if (n.stage !== 'active' || n.retracted || n.supersededBy) continue;  // health
    if (query.memoryType && n.memoryType !== query.memoryType) continue;
    candidateMap.set(id, n); added++;
  }
}
candidates = Array.from(candidateMap.values());               // enlarged pool → scoring/rerank
```

## Design invariants (why it's low-risk)
- **Recall-only:** neighbors get **no score bonus**. They enter the pool and must *earn* their
  rank via the same scoring + cross-encoder rerank. Rerank can (and should) demote irrelevant
  neighbors → precision protected by construction.
- **Capped:** `CAP` bounds pool growth → bounded rerank cost / latency.
- **Scoped + healthy-only:** respects agent/workspace scoping; never surfaces
  superseded/retracted/non-active engrams.
- **Off-switch:** `AWM_GRAPHEXPAND=0` reverts to today's behavior with zero code change.

## Hard dependency to verify FIRST (the make-or-break precondition)
Graph-expansion only helps **if the edge exists** between the entity-name fact and the attribute
fact. `ConnectionEngine` forms edges on write/consolidation (co-occurrence/similarity/entity
overlap). **Precondition test:** write "main project = Atlas" + "Atlas codename = Magpie", then
`getAssociationsFor()` — is there an edge (immediately? after `consolidate()`)? If edges DON'T
form for entity-linked facts, graph-expansion is inert and the real fix shifts to **(b)
entity-aware fetch** (or strengthening edge formation). **Run this before building anything else.**

# Test plan (success criteria, in order)

| # | Test | Pass criteria | Tool |
|---|---|---|---|
| 0 | **Precondition** — edges form between entity-linked facts | `getAssociationsFor` returns the Atlas↔Magpie edge (immediately or post-consolidate) | new `scripts/_edge-formation.ts` |
| 1 | **Unit** — neighbor enters the pool | with expand ON, the Magpie engram is in `candidates` for "main project codename" (was absent) | unit probe on `activate()` |
| 2 | **Recall** — buried fact recovered | Magpie now in recall top-k for the sparse cue; live 2-hop query surfaces its answer | `_sparsecue-*` + live `memory_recall` |
| 3 | **Targeted gauntlet** — the measured failures lift | `sparse-cue` + `multihop` pass-rate UP vs baseline (awm), k≥3 | `npm run gauntlet` |
| 4 | **No regression (accuracy)** | other gauntlet probes flat; AWM 4-suite eval ≥ baseline; **LoCoMo adversarial precision not down** (the 0.7.16 gate) | `npm run eval` + `test:locomo` |
| 5 | **No regression (cost)** | mean recall-ms increase within budget (the CAP); pool-size delta logged | gauntlet metrics |
| 6 | **Precision guard** | graph-expanded neighbors do NOT crowd out / outrank true matches (rerank demotes them) — measured as no drop in precision@k | eval + gauntlet |

**Decision rule:** ship iff (2 ✓ AND 3 ↑ AND 4 no-regression AND 5 within-budget). If precondition
0 fails → pivot to entity-aware fetch instead.

# Rollback plan

- **Immediate (zero-deploy):** `AWM_GRAPHEXPAND=0` — env off-switch disables expansion in place.
- **Default posture:** ship **default-OFF** until tests 0–6 pass; flip default-ON only on green.
- **Code revert (AWM-core):** the change is a single contiguous block in `activation.ts`; revert =
  `git revert` that commit in the AWM submodule + bump MWA's submodule pointer back. No schema
  change, no migration, no data written → revert is clean and total.
- **Pre-registered failure triggers → roll back:** LoCoMo adversarial precision regresses, OR
  recall-ms exceeds budget, OR sparse-cue/multihop don't improve, OR precision@k drops on the
  4-suite eval.
- **Blast-radius note:** because neighbors are recall-only + capped + health/scope-filtered, the
  worst realistic failure is *latency creep* or *no effect* — not wrong answers. That's why
  default-OFF + the off-switch is sufficient containment.
