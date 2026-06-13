# MWA v1 — Build PROGRESS (loop source of truth)

> Overnight autonomous build (Robert asleep, full autonomy, ~10-min self-loop).
> Each loop iteration: read this file → do the NEXT ACTION → verify → update this
> file + AWM → reschedule. Stop when all core items PASS in Docker + polished, or
> if genuinely blocked (then report).

## North star
A cheap-model (gpt-5-4-mini) **autonomous orchestrator brain** that, grounded in
**AWM** (recall + task ledger + cognitive scoring + learning write-back), plans a
coding goal, **dispatches codegen to a worker**, verifies via tests, and drives to
done **without a human** — proven by an **A/B/C benchmark run in Docker** showing
cheap+AWM ≈ frontier at a fraction of cost, and cheap+AWM ≫ cheap-baseline.

## Decisions (locked, see AWM)
- Standalone repo (this dir), deps on `agent-working-memory` npm. Not in AWH (Codex-active).
- Worker v1 = programmatic codegen+exec (model → write files → run tests), headless/Dockerable.
- Models: brain=Azure gpt-5-4-mini (fallback Haiku), high=Sonnet, baseline=brain w/ AWM off.
- Smarter-over-time = AWM memory_task ledger + cognitive scoring + recall + write-back.

## Component checklist
- [x] **C0 Foundation** — package.json, tsconfig, .gitignore ✓; deps installed ✓; .env keys (Anthropic + Azure gpt-5-4-mini) ✓
- [x] **C1 Providers** — `src/provider.ts`: `getProvider('brain'=azure gpt-5-4-mini Responses API | 'high'=Sonnet)`, `chat({system,messages})→{text,usage}`. Verified real calls + tsc. JSON-action protocol (no native tools). Haiku fallback if Azure key absent.
- [x] **C2 AWM substrate** — `src/awm.ts`: `MwaMemory(agentId,dbPath)` recall/write/feedback in-process + `NullMemory` (AWM-off arm). write→recall→feedback verified (score 0.64) + tsc. Formal task-ledger (getNextTask + cognitive scoring) = fast-follow; v1 uses decision-memories.
- [x] **C3 Worker** — `src/worker.ts` + `src/util.ts` (parseJsonLoose, runCommand). Codegen+exec verified (built add.mjs+test, exit 0). Provider-parameterized, headless, path-traversal guarded.
- [x] **C4 Brain loop** — `src/brain.ts`. END-TO-END verified: gpt-5-4-mini autonomously orchestrated worker over 3 dispatches → fizzbuzz+test, success, $0.0044, AWM decisions written. Memory swap (MwaMemory|NullMemory) = A/B arms; objective final grade via re-run of testCmd. JSON-action protocol robust (parse-fail retry).
- [x] **C5 Task domain** — `src/tasks.ts`: T1 stack, T2 calc, T3 palindrome+constraint(no .reverse()). FIXED test written by setup() (worker can't game it); gradeExtra greps for constraint. T3 verified end-to-end (success+constraintOk).
- [x] **C6 Benchmark** — `src/benchmark.ts`: arms A(cheap+AWM,shared db)/B(cheap)/C(Sonnet) × tasks × N runs → results/{bench.jsonl,summary.json} + table. SMOKE (stack,N=1): all 3 arms 100% pass, grader INTACT. Fixed 2 bugs: parseJsonLoose now direct-parse-first (Sonnet embeds ```fences``` in dispatch JSON → was corrupting); worker now PROTECTS test.mjs from overwrite (objectivity). Early signal: C_high $0.0101 vs A $0.0015 (~6.7×).
- [x] **C7 Dockerize** — Dockerfile (node:22-slim + build-essential/python3 for better-sqlite3; npm ci; HF_HOME=/data/hf volume; keys via --env-file) + .dockerignore. IN FLIGHT: image build (docker-build.log) + full LOCAL benchmark run (results-full.log) both launched in background this iteration.
- [x] **C8 RUN A/B/C** — LOCAL full N=2 (18 runs, all pass) + **DOCKER confirmed** (in-container N=1, 9 runs all pass, turnkey reproducible: Sonnet $0.0238 > A cheap+AWM $0.0134 > B cheap $0.0057, arm A recalled prior decisions). Same pattern as local. REAL NUMBERS + honest read below.

## RESULTS (C8) — local N=2, 18 runs, all 100% pass
| arm | pass% | avgDisp | avgCost | TOTAL cost | avgRecall | disp r1→r2 |
|---|---|---|---|---|---|---|
| A cheap+AWM (gpt-5-4-mini) | 100 | 2.33 | $0.0045 | **$0.0272** | 3.33 | **3→1.67** |
| B cheap (gpt-5-4-mini, no AWM) | 100 | 1.83 | $0.0029 | **$0.0171** | 0 | 1.33→2.33 |
| C high (Sonnet, no AWM) | 100 | 1.0 | $0.0078 | **$0.0466** | 0 | 1→1 |

HONEST interpretation (no spin):
1. **Cheap beats frontier on cost at equal success:** both cheap arms 100% pass like Sonnet; A is 1.7× cheaper than Sonnet, B is 2.7× cheaper. → for tasks of this difficulty you do NOT need the frontier model.
2. **AWM accumulation is real & measured (the mechanism works):** arm A's dispatches fell run1→run2 (3→1.67; palindrome 5→2, cost $0.0117→$0.0035 = 3.3× cheaper on the repeat) as recall grew 0→5. B (no memory) did NOT improve (1.33→2.33). → "smarter over time" demonstrated.
3. **HONEST GAP:** on these EASY one-shot tasks, AWM's write/recall overhead makes A ($0.0272) MORE expensive than bare-cheap B ($0.0171). AWM does not pay for itself on trivial single-shot tasks; its win (avoided re-derivation/flailing, continuity) needs HARDER / LONGER / MULTI-SESSION tasks — the run2 drop shows the payoff starting on the 2nd encounter. → v2: add hard/long-horizon tasks where flailing is expensive.

Net: cost-vs-frontier win clear; AWM-accumulation mechanism proven; decisive AWM cost-win NOT yet shown (tasks too easy) — a credible, honest v1 result.
- [x] **C9 Setup UI** — `src/server.ts`: zero-dep node:http server + single-file UI + live SSE (start/recall/dispatch/done/result), wired to runBrain (onEvent added to brain.ts). `npm run ui` → :7878. Verified end-to-end (config detects providers; stack/arm-B run streamed + passed $0.0017). Lightweight per turnkey constraint; full /front-end-designer polish = awake follow-up.
- [~] **C10 Polish** — README done (turnkey quickstart + honest A/B/C table + Docker + config + layout). npm scripts: ui/bench/typecheck/build/test. Threaded `protect` so custom UI tasks work. REMAINING: /full-audit (or targeted lint/security self-review unattended) → fix real findings, then FINAL AM REPORT memory.

## Current state (updated each loop)
- C0–C6 DONE + verified (tsc clean + real runs). Full pipeline works: autonomous brain→worker→AWM loop + 3 objective tasks + A/B/C benchmark harness. Smoke (stack,N=1): all 3 arms 100% pass, grader protected. Fixed 2 bugs (parseJsonLoose direct-parse-first for Sonnet's embedded fences; worker protects test.mjs).
- Files: src/{env,provider,awm,worker,util,brain,tasks,benchmark}.ts + src/types/awm-shims.d.ts. Env BENCH_TASKS/BENCH_RUNS/BENCH_ARMS; outputs → results/.
- Early cost signal (N=1 stack): C_high(Sonnet) $0.0101 vs A(gpt-5-4-mini+AWM) $0.0015 (~6.7×), all pass. Full N=2×3 tasks gives the real table.

## NEXT ACTION (loop picks up here)
1. **C7 Dockerfile** (repo root): FROM node:22-slim; apt-get build-essential python3 (better-sqlite3 native build); COPY package*.json → npm ci; COPY src tsconfig; ENV HF_HOME=/data/hf + TRANSFORMERS_CACHE so embed/rerank models persist on a mounted volume; entry = run benchmark. Add .dockerignore (node_modules, sandbox, data, results, *.log, .git).
2. **C8 RUN full benchmark in container**: docker build -t mwa-bench .; docker run --rm --env-file .env -v "$PWD/results:/app/results" -v mwa-hf:/data/hf -e BENCH_RUNS=2 mwa-bench. 3 tasks × 3 arms × 2 = 18 runBrain. Capture results/summary.json + table → write the REAL A/B/C numbers into PROGRESS + AM-report memory. Budget: Sonnet = 6 runs (~$0.06-0.12). If native better-sqlite3 build is slow/fails in-container, FALL BACK to a local full run for the numbers and note Docker status (don't stall).
3. Then **C9 setup UI** (/front-end-designer) + **C10 polish + /full-audit**.
Verify before declaring PASS.

## Open risks / notes
- Azure key retrieval may be flaky unattended → fallback Haiku, note in results.
- agent-working-memory pulls native better-sqlite3 + transformers; first run downloads embed model (cache in volume for Docker).
- Keep it LIGHTWEIGHT + TURNKEY: one command to run; no hardcoded paths.
