# Reliability methods — leaning on AWM memory + task management

The dogfood + the agent-reliability literature converge on the same failure modes. The
good news: the two things MWA already has — **AWM (the cognitive substrate)** and a
**task ledger + scheduler** — are precisely the levers the research recommends. This maps
each weakness → the best-known method → how MWA leans on what it already has.

## The weaknesses (measured + literature)

| Weakness | Seen in dogfood | Literature |
|---|---|---|
| Long-horizon tasks quit early / don't finish | C7 site build, S4 matrix | "inappropriate decomposition → asymptotic error accumulation" |
| Error cascade — one bad tool call → retry loops, contradictions | refused-`whoami` 6× retry; module-style flail | Reflexion; "Where LLM Agents Fail" (2509.25370) |
| Entangled context — monolithic history, local errors propagate | long runs degrade | Task-Decoupled Planning (2601.07577) |
| Long-context degradation (arithmetic, fidelity) | — (untested >100k) | "severe degradation already at 100K tokens" |
| Instruction fidelity over follow-ups (recency drift) | S3 turn-2 stale state | competing directives → forgets initial intent |
| pass^k variance — unreliable across repeated runs | RAG eval 1–2/3, multifile | "15–25 pts below pass^1" (2602.16666) |
| User-in-the-loop / policy adherence | (not yet tested) | τ²-bench: ~20% drop guiding a user |

## Method → MWA lean

### 1. Plan-and-Execute via the AWM task ledger  ← the biggest lean
**Status: BUILT (correct version).** `runPlanned` in `src/agent.ts`: a PLANNER (strong tier)
decomposes a complex task into 2–6 concrete sub-tasks; each runs as its OWN isolated sub-run of
`runAgent` (`subRun: true`) that shares state only through AWM recall, then a SYNTHESIS pass
produces the answer. A failed step retries once in isolation (its Reflexion friction auto-primes
the retry). Gated on `isComplexTask` (simple tasks use the proven direct loop); `MWA_PLAN=off`
disables. Verified on the multi-file website build that the **naive self-checklist version
regressed** (3 files → 0): the dispatch version produces all 3. The earlier naive attempt —
a checklist inside the live loop — was reverted because the model treated *planning* as progress
and rushed to done; here a step is done only when its real sub-run returns.

**Method:** separate a Planner (high-level plan) from an Executor (stepwise, with localized
replanning). Decompose long tasks into sub-tasks so each executes in **isolated context** —
this is what stops cascading errors and "entangled context," and it's the principled fix for
long-horizon blow-ups (Plan-and-Act; Task-Decoupled Planning).

**MWA lean:** AWM already has a **task ledger** (`memory_task_add / _next / _update / _list`).
Turn the free-running loop into a **plan-tracked** one: for a complex task (the `isComplexTask`
gate we already compute), the conductor first writes a checklist of sub-tasks to the ledger,
then works them one at a time, marking each done. Benefits, all from existing primitives:
- each sub-task runs with a **small, focused context** (mitigates long-context degradation);
- the checklist is the **durable goal** — re-grounded every step, so recency can't erase intent
  (instruction fidelity);
- "did I finish?" becomes a **ledger check**, not a vibe — reinforces the done-guard;
- a failed sub-task is **retried in isolation**, not the whole task (error containment).

### 2. Reflexion (learn-from-failure) via AWM episodic memory
**Method:** an Evaluator detects failure → a Self-Reflection step writes *verbal* feedback
("X failed because Y; next time try Z") into episodic memory → future attempts recall it.
Lightweight, no fine-tuning, interpretable (Reflexion 2303.11366).

**MWA lean:** AWM already has **episodic memory with `event_type: 'friction'`**. On a failed
tool/sub-task, write a one-line reflection as a friction memory; recall friction memories for
the current sub-problem *before* retrying and at the start of similar future tasks. We already
have the negative half (refused/dup hard-stops); this adds the **learning** half. Mirror of the
existing `saveSkill` (which captures *successful* procedures) — add the failure counterpart.

### 3. Self-verification / checkpoints for pass^k variance
**Method:** verify your own output at step boundaries; for critical results re-derive or vote
(self-consistency / CISC confidence-weighted). Verification "stabilizes outputs and reduces
random variance" (2505.09031).

**MWA lean:** we already verify two things — **run tests for code**, and **output files exist**
(the done-guard). Extend to a cheap **verify step** before done on eval/compute tasks (re-check
the numbers / re-read the file it wrote). Lean on memory: **canonical verified results are
recalled instead of re-derived** — the measured ~3× reuse win *is* variance reduction (a recalled
fact has zero sampling variance). Reserve full self-consistency (run-twice-and-compare) for
high-stakes, gated by the same complexity/escalation signal so cost stays bounded.

### 4. External-memory offload for long-context degradation
**Method:** don't carry the whole history in context; offload to retrieval; keep per-step
context small.

**MWA lean:** this is literally AWM's job — **recall the relevant slice per step** (auto-PRIME,
top-K=10) + **consolidation** (compress) instead of a growing transcript. Combined with #1
(per-sub-task context), the working window stays small even on long tasks. Mostly already built;
the win is using #1 so a long task never accumulates one monolithic context.

### 5. Re-grounding on the goal/policy (fidelity + user-in-the-loop)
**Method:** persist the original goal + any user policies; re-inject each turn; ask when
ambiguous; confirm before irreversible actions (τ²-bench's bottleneck).

**MWA lean:** store the **original instruction + user preferences/policies as canonical
memories** and re-prime them each step (the task-ledger top item = current sub-goal). We already
have `ask_user` (clarify) and policy-by-construction (draft-not-send, access presets); making
preferences **persistent canonical memories** carries policy across sessions — e.g. "never send
without review," "summaries should be ≤5 bullets," recalled before acting.

### 6. The scheduler as a reliability tool (not just cron)
**MWA lean:** the **scheduler** can do more than timed tasks — it can **re-run a verification**
later, **retry** a sub-task that failed transiently, or **resume** a long job in a fresh small
context. Combined with the ledger, an unfinished long task becomes a set of queued sub-tasks the
scheduler can drive to completion across ticks rather than one over-budget run.

## Priority (impact × leans-on-what-we-have)

1. **Plan-and-Execute via the task ledger** (#1) — biggest reliability gain; directly leans on
   the existing AWM task tools; fixes long-horizon + entanglement + fidelity at once.
2. **Reflexion friction memory** (#2) — cheap; one write + one recall; cuts repeat-error loops
   and improves across runs (the reuse story, applied to failures).
3. **Verify-before-done step** (#3) — small extension of the done-guard; trims pass^k variance.
4. Persistent **policy/preference memories** (#5) and **scheduler-driven retry/resume** (#6) —
   follow-ons.

The thesis it reinforces: **AWM isn't just recall — it's the reliability layer.** Memory carries
the plan (fidelity), the failures (Reflexion), the verified results (variance), and the policies
(user-in-the-loop); the task ledger + scheduler turn one brittle long run into a tracked,
resumable, self-correcting sequence.

Sources: Reflexion (arxiv 2303.11366), Plan-and-Act (OpenReview ybA4EcMmUZ), Task-Decoupled
Planning (2601.07577), Towards a Science of AI Agent Reliability (2602.16666), Where LLM Agents
Fail (2509.25370), Reliability via CoT+RAG+self-consistency+self-verification (2505.09031),
τ²-bench (2506.07982).
