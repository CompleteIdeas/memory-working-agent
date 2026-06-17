# The Memory Gauntlet — a controlled benchmark for MWA / AWM

A scientific, single-factor benchmark that asks one question: **what does AWM's cognitive layer
add over plain retrieval — and where doesn't it?** It is deliberately honest: it reports where
AWM ties a well-built baseline, not just where it wins.

## Design (one independent variable)

The **only** thing that changes between arms is the memory substrate dropped into a
byte-identical agent harness. Everything else is held constant: model, decoding, harness code,
task sequence, seed data, budgets, tools.

| Arm | What it is |
|---|---|
| `awm` | the cognitive substrate — semantic recall + cross-encoder rerank + query expansion + salience + supersede + cross-agent workspace |
| `rag` | **strong baseline** — AWM's *own* embeddings + plain cosine top-k, none of the cognitive layer (isolates exactly what that layer adds) |
| `notes` | naive DIY — a flat notes file, lexical substring match only |
| `longctx` | "stuff it all in context" — return the whole store (byte-capped); a different *mechanism*, not a clean control |
| `off` | `NullMemory` — no memory (the ablation control) |

Controls that make it trustworthy:
- **Per-task filesystem wipe** + a separate persistent memory store → the *only* cross-task
  carryover is the memory substrate.
- **Deterministic scoring** (file-exists / exact-match / regex) — no LLM judge in the headline.
- **pass^k with bootstrap CIs** — reasoning models are nondeterministic; single runs are noise.
- Three metric axes, because accuracy alone hides AWM's profile: **pass-rate**, **tokens**,
  **recall latency**.

Run: `npm run gauntlet -- --suite <memory|contextswitch> --arms awm,rag,notes,longctx,off --k 3 [--pad N]`
and `npm run gauntlet:crossagent`.

## Results

### 1. Plain single-fact recall — AWM ≈ RAG (honest parity)

Hardened memory suite (dense confusable world, multi-supersession, multi-hop, sparse cue,
cross-session composite), k=3, memory-dependent pass-rate:

| arm | pass-rate (95% CI) |
|---|---|
| rag | **78%** [78–78] |
| awm | 70% [67–78] |
| notes | 59% [56–67] |
| off | 0% |

AWM's CI **overlaps** RAG's — on plain retrieval there is **no significant advantage**, exactly
as expected: AWM *uses* the same retrieval, so on single-fact lookup it should match RAG. The
no-memory ablation (+70pts over `off`) only proves "memory helps," **not** "AWM beats a
well-designed system." That distinction is the whole point of including the `rag` arm.

A sharper sub-finding: **named-entity probes are RAG-trivial at any scale.** Padding the store
with 1000s of *similar* records didn't separate the arms, because a probe that names the entity
("Cedar's deadline") carries a near-unique key. AWM only separates where the query lacks a unique
key — supersede, sparse/indirect cues, conflict — which loops back to the cognitive layer.

### 2. Long-context is strictly dominated

`longctx`: **17k input tokens/task AND 0%** memory-dependent accuracy. It pays the most tokens
*and* scores worst, because a byte-budgeted full dump **evicts** the older facts by probe time.
"Just stuff it in context" is the worst of both worlds at scale.

### 3. Efficiency + speed (the axes pass-rate hides)

| arm | in-tok/task | recall latency |
|---|---|---|
| awm | ~9–11k | ~150–200 ms (in-process embed + rerank + expansion) |
| rag | ~9–10k | ~7–10 ms |
| longctx | ~17k | — |

Two honest corrections this benchmark forced:
- **AWM is *slower* than local RAG** (~150ms vs ~10ms) — the rerank + query-expansion cost.
  Measured: rerank+expansion is **~84% of recall latency** (68ms full vs 11ms fast). AWM's speed
  pitch only holds vs *network-backed* memory (e.g. a hosted service at 100s of ms), not vs a
  local vector index.
- The **token win is retrieval-vs-long-context**, not AWM-vs-RAG (those are comparable).

### 4. Cross-agent shared recall — AWM wins by construction

Agent A records decisions; a *different* agent B (fresh identity) is probed on facts only
obtainable from A's memory:

| arm | B recalls A's decisions |
|---|---|
| **awm** | **100%** (3/3) |
| rag | 0% |
| notes | 0% |
| off | 0% |

A categorical gap, not a noisy margin. A memory *library/file is per-process* and structurally
cannot share across agents; AWM's shared substrate (one store + workspace, distinct agent ids)
lets B recall what A wrote. **This is the result that isn't a tie** — and it's the capability
RAG-as-a-library cannot do at all.

## The narrative the data supports

**AWM = RAG + a cognitive layer + a shared real-time substrate.** On plain retrieval it *ties*
a well-built vector RAG (expected, fair). Its defensible edges are the things retrieval-alone
lacks: **cross-agent / cross-CLI shared recall (proven: 100% vs 0%)**, supersede/recency, and
association — plus it never blows up tokens the way long-context does. Where it currently *loses*
is latency vs a local index (the rerank tax) — a known, re-scoped improvement.

## Methodology lessons (for anyone extending this)

- **Probes must require a value only obtainable from memory** — never a plausible default. A
  no-memory model guessing "review before sending" produced a false 33% until the probe was
  tightened to an unguessable specific.
- **Off-topic padding creates no interference** — the haystack must be *near-duplicates* of the
  needle to stress retrieval precision.
- **Single runs are noise** — arms swing 10–20pts at k=1; use k≥3 + CIs before any ranking claim.
- **Don't ship a memory optimization on a latency number alone** — verify it doesn't change
  *what* is recalled. (Two prototyped fixes were reverted here after deeper checks: a fast
  background-prime that mixed incompatible score scales, and a supersede pass whose effect was
  masked by the model's own supersede.)
