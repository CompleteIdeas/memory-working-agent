# MWA V2 — Retention Benchmark (AWM's actual strength)

> Run 2026-06-13. `npx tsx src/retention.ts` (sweep `RET_DISTRACTORS=10,50,200`).
> Generator: Azure gpt-5-4-mini. Deterministic 0–3 grader (id format / integer-cents / file header).

## Why this benchmark (the V1→V2 pivot)

V1 proved the AWM *accumulation mechanism* but could NOT show a decisive cost-win:
its coding tasks were trivial one-shots where AWM's write/recall overhead exceeded
its savings. V2 first tried *harder coding tasks* and triangulated a negative result:
a **capable worker rediscovers task knowledge as cheaply as recalling it** (no memory
edge), while a **cheap worker is too unreliable to even establish the knowledge**
(chain breaks). Coding tasks are the wrong vehicle.

So V2 measures what AWM is *actually* for: **long-horizon retention** — does a decision
set at turn 1 survive to the final turn amid distractors? Tasks are deliberately simple
(coding skill is not the variable); the only variable is whether 3 conventions
established up front reach the final generation.

- **A_awm** — conventions + distractors written to AWM; final turn RECALLS.
- **B_nomem** — no memory; conventions gone by the final turn (the floor).
- **D_longctx** — full transcript (conventions + every distractor) stuffed into the
  final prompt; the realistic "just keep the history in context" baseline.

## Results

### Accuracy — convention adherence (/3) vs distractor count
| arm | D=10 | D=50 | D=200 |
|---|---|---|---|
| **A_awm** | 3/3 | 3/3 | 3/3 |
| B_nomem | 1/3 | 0/3 | 0/3 |
| D_longctx | 3/3 | 3/3 | 3/3 |

### Context cost — input tokens carried into the final turn
| arm | D=10 | D=50 | D=200 |
|---|---|---|---|
| **A_awm** | 161 | **161** | **161** |
| B_nomem | 79 | 79 | 79 |
| D_longctx | 540 | 2020 | **7570** |

**At D=200: A_awm 3/3 @ 161 tok vs D_longctx 3/3 @ 7570 tok → AWM carries 47× fewer
input tokens at equal accuracy.**

## Honest interpretation (no spin)

1. **vs no-memory — categorical win.** AWM is the difference between honoring turn-1
   decisions (3/3) and losing them (0/3). The memoryless agent doesn't know the
   conventions by the final turn, so it violates them. Recall stayed precise as the
   store filled with noise (pulled the right 3 conventions even among 200 distractors).
2. **vs long-context — flat cost at equal accuracy.** AWM's context cost is FLAT (161
   tokens at every depth); long-context grows linearly (540 → 2020 → 7570). The win is
   **cost/scalability**, and it widens with session length until long-context hits the
   window limit and truncates — at which point its accuracy collapses while AWM holds.
3. **Caveat, stated plainly.** At ≤200 short distractors the long-context baseline still
   scores 3/3 — that depth does not yet trigger "lost in the middle" for a capable model.
   An *accuracy* win over long-context would require genuine context-window pressure
   (thousands of items). We do NOT claim that here. The claim is: equal accuracy, flat-
   vs-linear token cost, and a categorical win over no-memory.

Net: V2 found the regime where AWM decisively helps — **long-horizon decision continuity**,
where precise recall delivers the same adherence as carrying the whole transcript at a
fraction of the per-turn token cost, and where no-memory simply fails.
