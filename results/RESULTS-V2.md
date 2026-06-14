# MWA V2 — Results: where AWM decisively wins (and where it doesn't)

> 2026-06-13. Honest consolidation of the V2 experiments. Every number here came
> from a real run on this machine; the caveats are stated, not buried.

## Why this exists (the real motivation)

> *"This is why I built AWM — when we got to 500K tokens it was infeasible to
> maintain a large repo on development."* — Robert

Past roughly half a million tokens, keeping a large repo's context alive during
development breaks down. You cannot carry the whole repo + notes + history in a
window, and compaction/summarization silently drops the fact you needed next.
AWM was built to keep the *relevant slice* in scope at flat cost, no matter how
big the project gets. **V2 set out to measure that wall — and did.**

### The one number that says it all

To put the **whole EquiHub system** into a single query you would need:

| component | files | tokens |
|---|---|---|
| EquiHub code repo | 5,289 | ~27,208,000 |
| equihub-docs (notes + transcripts) | 383 | ~2,053,000 |
| **whole system, one query** | | **~29,260,000 tokens** |

That is **~146× past a 200K context window and ~29× past a 1M window** — there is
no model tier that holds it. An AWM scoped recall answers from **~630 tokens**, i.e.
**~46,000× smaller per query**. At this scale retrieval is not an optimization; it
is the only door. *(The 27M code figure includes `.json`/`.sql`/generated text a
dev wouldn't always load — but even the docs alone, 2.05M tokens, are 10× past a
200K window. The exact multiple doesn't matter; "it does not fit, at any tier" does.)*

## The thesis, corrected

V1 proved the AWM accumulation *mechanism* but chased the wrong headline: a
per-task *cost* win on small coding tasks. V2 triangulated why that never lands:

- A **capable** worker rediscovers small-task knowledge as cheaply as recalling it.
- A **cheap** worker is too unreliable to even establish the knowledge.
- On small corpora, a notes file is cheap enough to carry whole *and* complete.

So AWM's value is **not "cheaper per task."** It is **"the only thing that fits,
stays correct, and stays flat as the corpus grows past the point where
carry-everything becomes infeasible."** That is a narrower, more honest, and far
more durable claim — and it's exactly the 500K wall above.

## The four experiments

### 1. Retention (`src/retention.ts`) — does a turn-1 decision survive to turn N?
3 conventions set up front, D distractors, then a graded generation.

| arm | D=10 | D=50 | D=200 | tokens carried |
|---|---|---|---|---|
| **A_awm** | 3/3 | 3/3 | 3/3 | **flat 161** |
| B_nomem | 1/3 | 0/3 | 0/3 | 79 |
| D_longctx | 3/3 | 3/3 | 3/3 | 540 → 2020 → **7570** |

**Read:** vs no-memory, AWM is *categorical* (honors decisions vs loses them). vs
long-context, *equal accuracy at flat token cost* while long-context grows linearly.
**Caveat:** at ≤200 short distractors long-context still scores 3/3 — this depth
doesn't trigger "lost in the middle." The A-vs-D win here is cost, not accuracy.

### 2. Return-visit repo QA (`src/repo-qa.ts`) — real local repos, scan → wipe → return
Extract facts once (shared), then answer on return visits. Miss → fall back to a
full repo scan (a notes/recall miss is "slow that way too").

| repo | arm | accuracy | tok/visit | cum@10 visits |
|---|---|---|---|---|
| mwa | **A_awm** | 7/8 | **~14K** | **~150K** |
| mwa | MD_file | 8/8 | ~26K | ~269K |
| mwa | LongCtx | 8/8 | 49K | 491K |
| awm | **A_awm** | 4/6 | **~1.3K** | **~19K** |
| awm | LongCtx | 6/6 | 30K | 304K |

**Read:** the cost win is real and compounds — AWM overtakes long-context after
~1 visit. **Caveat (honest ceiling):** accuracy is capped by the *extraction*
step, not recall — when a fresh extraction misses a fact, both AWM *and* the
notes file miss it (LongCtx, holding raw files, doesn't). The hybrid grep-on-miss
recovers it, but only fires when the model *admits* the miss. Tuning that
matters: full-content recall (not truncated summaries) + storage that leads with
the fact + identifiers in tags (the USEA `AGENT.md` discipline).

### 3. Staleness / supersede (`src/staleness.ts`) — code changes between visits
VERSION 0.8.6→0.9.0, MAX_RETRIES 6→8.

| strategy | correct | tokens |
|---|---|---|
| MD_file (stale notes) | 1/3 | 75 |
| A_awm (no supersede) | 1/3 | ~80 |
| **A_awm + SUPERSEDE** | **3/3** | **37** |
| LongCtx (re-read all) | 3/3 | 96 |

**Read:** only AWM+supersede is *both* correct and cheapest — it re-reads the one
changed file, supersedes the two facts, and recall stops returning the old value.
**Honest catch:** AWM isn't auto-fresh — without supersede it's as stale as the
notes file. The structural difference: a notes file/repo has *no mechanism* to
know it went stale (full re-scan to find out); AWM *has* supersede — you must use it.

### 4. Scale — the live store (the capstone, real data)
Read-only stats on the running AWM DB (`AgentSynapse/packages/awm/memory.db`).

| corpus | size | carry-everything | scoped recall (top-10) | ratio |
|---|---|---|---|---|
| `work` agent (EquiHub) | 20,704 memories | **~1,300,859 tok** | **~630 tok, flat** | **~2,065×** |
| `equihub-docs` notes repo | 348 `.md` + 35 `.txt` | **~2,052,405 tok** | ~630 tok, flat | **~3,250×** |
| `personal` agent | 1,679 memories | ~244,841 tok | ~1,460 tok | ~168× |

**Read:** at real scale, carry-everything (~1.3–2M tokens) **does not fit in any
context window.** So the choice isn't "recall is cheaper" — it's "scoped recall
is the only thing that fits." A notes/long-context approach is forced to truncate
→ silently drops facts → wrong answers. Supporting facts: **93%** of `work`
memories are never recalled (dead weight a file pays for every turn, ≈0 in recall);
**40 superseded + 7 retracted** = staleness handled in real use; the `.txt`
transcripts (~18K tok each) are the worst case for files (unstructured, grep-weak,
uncarryable) and the best case for AWM (distill decisions into atomic engrams).

## Extensions (empirical)

### 5. AWM recall vs grep+read the real notes repo (`src/headtohead.ts`)
Same 6 EquiHub questions through (a) scoped recall on the live `work` store snapshot
vs (b) keyword-rank + open the single best `equihub-docs` file.

| question | AWM recall (tok) | grep+open best doc (tok) | advantage |
|---|---|---|---|
| POC qualification rules | 1,995 | 7,004 | 3.5× |
| fee services alignment | 2,151 | 9,617 | 4.5× |
| AEC qualification engine | 1,660 | 2,043 | 1.2× |
| post-show reconciliation | 1,267 | 2,719 | 2.1× |
| membership constraints | 1,689 | 19,630 | 11.6× |
| horse registration / USEF | 1,754 | 16,140 | 9.2× |
| **total** | **10,516** | **57,153** | **5.4×** |

**Read:** on *real* questions against the *real* docs, recall returns an on-target
atomic fact per question; the docs hold the answer too but buried in 16–20K-token
build files. **5.4× is a floor** — grep opens the single best file; a real agent
opens 2–3 and still misses cross-file facts. Honest cost: ~3.2s recall latency each.

### 6. TOON compression on structured output (`compress_output` / `retrieve_original`)
Recall and tool results that are *structured* (query rows, catalogs, schema lists)
compress further with TOON — schema-aware tabular encoding, self-verified lossless.
A 24-row fee-catalog result: **48% smaller**, round-trip verified via `retrieve_original`.

**Read:** the savings *compound* — scoped recall already shrinks the corpus to a slice;
TOON then roughly halves any *structured* slice before it enters context, with a `ref`
to fetch the verbatim original on demand. (Prose doesn't compress; TOON is for uniform
arrays/rows — exactly the big query results you'd otherwise paste in whole.)

### 7. Context switching (`src/contextswitch.ts`)
The crux of switching: the *same* question shape asked about *different* projects must
return *different, project-correct* answers. 4 projects share the same 5 attributes
(database, cache, language, auth, deploy) with distinct values; queries are interleaved
to force a switch every turn; a distractor sweep floods the store with unrelated projects.

| distractors in store | top-1 correct | cross-project bleed | recall tok | carry-all tok |
|---|---|---|---|---|
| 0 (20 facts) | **20/20** | **0** | 59 | 227 |
| 200 | **20/20** | **0** | 58 | 2,617 |
| 800 | **20/20** | **0** | 58 | 9,952 |

**Read:** 100% correct project, **zero bleed, invariant to store size** — under maximal
interference (every project shares attribute names) recall still isolates the queried
project's slice. Recall stays flat (~58 tok) while a notes file's carry-all grows linearly.
(A first real-store run against the live 20K-memory multi-project `work` agent was
abandoned as a *clear* benchmark — most EquiHub memories are tagged by sub-topic, not the
literal project word, so tag-based ground truth was too noisy to score cleanly. The
controlled version above is the clean signal.)

## The honest scorecard

**AWM decisively wins when:**
- The corpus is large (past the ~500K wall) — carry-everything stops fitting.
- Decisions/constraints must persist across context wipes and long horizons.
- Facts change over time and must be kept correct (supersede).
- Knowledge lives in unstructured transcripts/history.

**AWM does *not* win when:**
- Tasks are small and one-shot — write/recall overhead exceeds the savings (V1).
- A capable model can rediscover the needed fact in-session as cheaply as recall.
- The corpus is small enough to carry whole (a notes file is then cheap *and* complete).

**Real costs to AWM, not hidden:**
- Recall latency (~3.2s avg on the live store) — the price of ~2,000× fewer tokens.
- Accuracy is capped by extraction quality; tight recall can silently miss.
- Freshness requires the supersede discipline; it isn't automatic.

**What files/long-context genuinely win on:** human-readable, auditable,
version-controlled, zero retrieval latency, no extraction step.

## What MWA's agent should therefore be

Not pure-recall. The USEA-tuned loop: **recall first (scoped, full content),
grep/read for ground truth on a miss or to verify, and supersede the moment
reality differs.** Memory and grep balanced — recall for continuity and scale,
files for current ground truth.
