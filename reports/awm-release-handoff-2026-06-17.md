# AWM release handoff — 2026-06-17 (overnight work, staged for your go)

Everything below is **done and validated locally**. Nothing was pushed or published.
The release is staged at AWM commit **`fe52a5f`**, now present in **both** the **driver repo
`C:/Users/robert/Personal-Projects/AgentWorkingMemory`** (the one releases are bumped + published FROM —
reconciled this session from a drifted 0.8.6 up to origin 0.8.8 + the recall change; `npm install` +
build clean) **and** the MWA vendored submodule (same SHA). The driver repo is 1 commit ahead of
`origin/master` (= the recall commit), nothing pushed. Safety on the driver: tag
`backup/pre-reconcile-2026-06-17` + `stash@{0}` preserve its prior state.

## TL;DR — the win, validated

**Widen the rerank pool + scope abstention to the returned top-K.** A pipeline-attribution
tracer (built this session) found the dominant recall loss was the *composite score gatekeeping
the reranker*: ~50% of answerable LoCoMo queries had gold that cleared the candidate floor but was
squeezed out of the rerank pool before the +3.29-lift reranker saw it. Fix = composite becomes a
cheap wide pre-filter; reranker discriminates on a wider pool; abstention judges the top-K so
precision decouples from pool width.

**Official LoCoMo: 22.7% → 25.7%** (multi-hop 13.4→17.3, single-hop 18.6→23.5, open-domain
11.8→15.1, temporal 9.7→10.0) **AND adversarial precision 73.4→74.9** — strictly better on every
axis. Recall latency 35→77ms (sub-100ms, env-tunable). **Zero regression** across the standard
suite (eval 4-suite identical, 569/569 unit, edge 32/34 ≥ old 31/34, workday 81.8% = old config).
MWA gauntlet (k=5): no gross regression (64% both; `abstain` task 80→100, corroborating precision).

This is the **first thing to move LoCoMo all session** — R1/R2/query-bridge/auto-tagger/embedder
swaps all left it flat. It also recovers most of the way to the historical 0.5.4 peak (28.2%);
the last ~2.5pp is a separate pre-existing cross-version regression (not chased — SIM_FLOOR was
ruled out).

## What changed (in `fe52a5f`)

Defaults (all env-revertible):
- `topN` breadth 3×→8×limit (`AWM_TOPN_MULT`)
- rerank pool `max(limit*2,15)`→`max(limit*4,40)` (`AWM_RERANK_POOL`)
- abstention gate judges post-rerank **top-5** (`AWM_ABSTAIN_GATE_K=5`; `0`=legacy whole-pool)
- `SIM_FLOOR` now env-tunable (`AWM_SIM_FLOOR_TARGETED/EXPLORATORY`) — defaults unchanged (0.50/0.35)

Opt-in, default-off (validated separately, NOT in the default path):
- `AWM_QUERY_BRIDGE` — query-named-entity boost; attribution 36%→92% on a controlled eval, small
  adversarial cost. **Decision needed:** ship as opt-in (current) or evaluate for default.
- `AWM_AUTOTAG` — wires the dormant `extractMetaTags`; neutral on recall.
- `AWM_BROAD_EDGES` — entity-co-occurrence edges.
- `AWM_SPREAD`/`AWM_SPREAD_INJECT` — **parked** (regressed recall by displacing gold; kept for research).

Tooling + docs: `tests/locomo-eval/trace.ts` (LoCoMo attribution tracer), `--no-expansion` eval
flag, `docs/reference.md` recall-tuning section, CHANGELOG (staged "Unreleased", candidate 0.9.0),
`docs/using-awm-at-scale.md`. MWA-side tracers: `scripts/trace-query.ts`, `trace-eval.ts`,
`attribution-eval.ts`, `crosslingual-eval.ts`.

## Morning GO — exact steps (each is the held, outward-facing part)

   **All steps below run FROM the driver repo `C:/Users/robert/Personal-Projects/AgentWorkingMemory`.**
1. **Review** `git -C C:/Users/robert/Personal-Projects/AgentWorkingMemory show fe52a5f` (the diff) + the CHANGELOG entry.
2. **Decide version** — recommend **0.9.0** (new recall-quality default + new tuning knobs,
   backward-compatible). Bump `package.json`, rename CHANGELOG "Unreleased" → "0.9.0 (2026-06-17)".
3. **Decide query-bridge** — **RESOLVED overnight: keep OPT-IN (default-off).** A/B on the new
   default (pool40+gateK5) with `AWM_QUERY_BRIDGE=1`: overall recall 25.7→25.9 (+0.2 only; +1.5
   open-domain/temporal) but adversarial 74.9→**72.8** (below the 73.4 baseline — gate-K does *not*
   fully offset its cost). Not worth default-on; stays a documented opt-in for attribution-heavy
   workloads (its validated 36→92% attribution win). No action needed unless you disagree.
4. **Push** (gh auth → CompleteIdeas), from the driver repo: `git -C C:/Users/robert/Personal-Projects/AgentWorkingMemory push origin master` (then drop the `backup/pre-reconcile-2026-06-17` tag + `stash@{0}` once you've confirmed nothing was lost).
5. **Publish** (per CLAUDE.md mechanics): NODE_OPTIONS ipv4first + the granular npm token; `npm publish`.
6. **Propagate**: bump MWA's submodule pointer to the pushed commit; update AgentSynapse's AWM dep.

## Open / deferred (not blocking the release)

- **Cross-version recall regression (28.2%→22.7% pre-this-change):** real, equal-precision, cause
  NOT yet found (SIM_FLOOR ruled out). Worth a future archaeology pass with the tracer.
- **Token-efficiency regression (pre-this-change):** `test:tokens` savings +56% (v0.8.5) → **−8%**
  on current 0.8.8 — confirmed on BOTH old and new config (so NOT the pool/gate-K change). A core
  value-prop regression. **Reinforce-merge RULED OUT overnight** — `AWM_REINFORCE_MERGE_CONTENT=0`
  still gives −7.9% savings, so the 0.8.5 content-merge is not the cause (don't re-test it). Cause
  remains open; same drift era as the LoCoMo regression — needs a fresh archaeology pass (vector
  refactor? test-corpus/baseline shift? methodology?). (Resolved side-note: the merge *does* explain
  the new-config token-test recall dip 97.5→87.5 — merge-off restores 97.5; savings unaffected.)
- **Temporal category** (LoCoMo ~10%): deep vocab-mismatch on time expressions — a genuine future
  feature (temporal-aware retrieval), not a masked regression.
- **Multilingual**: multilingual-e5 aligns cross-lingual (cos 0.84) but the English-tuned pipeline
  (floors/scoring/reranker) crushes it — a scoped project (embedder + floor retune + multilingual
  reranker), not a swap. Cross-lingual eval harness is built (`scripts/crosslingual-eval.ts`).
- **AgentSynapse update** — gated on the publish (or a local link).
- **Deeper doc edits** — README "Retrieval" row + `cognitive-model.md` funnel rewrite (lower priority).

## Verdict

AWM recall change: **PASS** (validated offline + regression + end-to-end no-regression). Staged,
committed locally, awaiting your go for the irreversible push + publish.
