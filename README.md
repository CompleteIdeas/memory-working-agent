# MWA — Memory Working Agent

A lightweight, turnkey **autonomous coding orchestrator** that runs a *cheap* model
on the [AWM](https://www.npmjs.com/package/agent-working-memory) decision substrate.
The cheap model **conducts** — it plans, dispatches coding subtasks to a worker,
reads results, records decisions to AWM, and drives the task to done **without a
human** — while AWM keeps it on-goal and lets it get smarter with reuse.

> Thesis: capability for *orchestration* lives in the **substrate**, not the
> model weights. A cheap conductor + memory can match a frontier model on cost.

## Result (real A/B/C benchmark, 3 tasks × 2 runs, all 100% pass)

| arm | model | AWM | total cost | avg dispatches | run1→run2 dispatches |
|---|---|---|---|---|---|
| **A** | gpt-5-4-mini | on | $0.0272 | 2.33 | **3 → 1.67** |
| **B** | gpt-5-4-mini | off | $0.0171 | 1.83 | 1.33 → 2.33 |
| **C** | Claude Sonnet | off | $0.0466 | 1.0 | 1 → 1 |

Honest read:
- **Cheap matches frontier at lower cost** — both gpt-5-4-mini arms hit 100% like Sonnet, at **1.7–2.7× lower cost**.
- **AWM "smarter over time" is real** — arm A's dispatches *drop* on the second encounter (memory recalled prior decisions); the no-memory arm doesn't improve.
- **Honest gap** — on these *easy one-shot* tasks AWM's overhead makes A cost a bit more than bare-cheap B. AWM's decisive win needs **harder / longer / repeated** tasks where re-derivation is expensive (the run-2 drop shows where it starts). That's the v2 direction.

(Reproduced turnkey in Docker — see below.)

## Quickstart (turnkey)

Prereqs: Node 22+. Put API keys in `.env` (see [Config](#config)).

```bash
npm install
npm run ui        # → http://localhost:7878  (pick a task + arm, hit Run, watch live)
npm run bench     # → runs the full A/B/C benchmark → results/summary.json + table
```

One command in Docker (reproducible, no local toolchain):

```bash
docker build -t mwa-bench .
docker run --rm --env-file .env -v mwa-hf:/data/hf -e BENCH_RUNS=2 mwa-bench
```

## Config

`.env` (gitignored; never baked into the image — passed at runtime):

```
ANTHROPIC_API_KEY=...                 # high-model arm (Claude Sonnet)
AZURE_GPT_BASE_URL=https://<res>.api.cognitive.microsoft.com/openai/v1
AZURE_GPT_API_KEY=...                 # brain (gpt-5-4-mini, Azure Responses API)
AZURE_GPT_DEPLOYMENT=gpt-5-4-mini
```

If `AZURE_GPT_*` is absent, the brain falls back to Claude Haiku automatically.

## How it works

- **brain** (`src/brain.ts`) — JSON-action loop: `recall(goal)` → decide `dispatch`/`done` → run worker → write decision/learning to AWM → repeat until tests pass. Model-agnostic via `src/provider.ts`.
- **worker** (`src/worker.ts`) — codegen+exec: writes files into a sandbox, runs the task's test command, reports pass/fail. The fixed grader is protected from overwrite.
- **AWM** (`src/awm.ts`) — in-process substrate: `MwaMemory` (recall + decision write + feedback) for arm A; `NullMemory` for the AWM-off arms. Same loop, memory swaps.
- **tasks** (`src/tasks.ts`) — objective, ungameable: each ships a fixed test; T3 adds a hard constraint checked against the produced code.
- **benchmark** (`src/benchmark.ts`) — runs arms A/B/C × tasks × N, writes `results/`.

## Layout

```
src/{env,provider,awm,worker,util,brain,tasks,benchmark,server}.ts
Dockerfile  .dockerignore  README.md  PROGRESS.md
```

## Status

v1 pilot. Core loop + benchmark + Docker + UI all working and verified. Built as
a standalone proof; the natural next home is as an adapter/worker inside the
AgentWorkingHive (AWH) orchestration runtime. v2: harder/long-horizon tasks (to
show AWM's decisive cost win), formal AWM task-ledger with cognitive scoring,
multi-agent shared-workspace runs.
