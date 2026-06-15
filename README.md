# MWA — Memory Working Agent

A lightweight, turnkey **autonomous coding orchestrator** that runs a *cheap* model
on the [AWM](https://www.npmjs.com/package/agent-working-memory) decision substrate.
The cheap model **conducts** — it recalls prior decisions, dispatches coding subtasks
to a worker, reads files for ground truth, supersedes facts that go stale, and drives
the task to done **without a human** — while AWM keeps it on-goal and lets it get
smarter with reuse.

> Thesis: capability for *orchestration* lives in the **substrate**, not the model
> weights. A cheap conductor + memory can match a frontier model on cost — and at
> scale, memory does something no context window can.

---

## Two results

### 1. Orchestration — cheap conductor matches frontier (A/B/C benchmark)

3 objective tasks × 2 runs, fixed graders, real models:

| arm | model | AWM | pass | total cost | avg dispatches |
|---|---|---|---|---|---|
| **A** | gpt-5-4-mini | on | **6/6** | $0.019 | 1 |
| **B** | gpt-5-4-mini | off | **6/6** | $0.013 | 1 |
| **C** | Claude Sonnet | off | 4/6 | $0.069 | 1 |

- **Cheap matches (here, beats) frontier at ~3.5× lower cost** — both gpt-5-4-mini arms hit 100%; Sonnet's 2 misses were both the hard no-`.reverse()` constraint on the palindrome task (a strong-prior trap; small N=2, not a claim that cheap is generally better).
- **The orchestration win is modest on easy tasks** — the hybrid loop one-shots each task (1 dispatch) with or without memory, so AWM's per-task overhead is tiny but so is its savings. That's the honest V1→V2 lesson: AWM's *decisive* value isn't here — it's at scale (Result 2).

### 2. Memory at scale — what a context window structurally can't do

The orchestration win is modest on easy tasks (recall overhead vs savings). The
*decisive* win is at scale, and it's the reason AWM exists: **past ~500K tokens you
can no longer keep a large project's context alive by carrying it.** Measured on a
real large software project:

| to answer one question, carry… | tokens | AWM scoped recall |
|---|---|---|
| the whole system (code + docs) | **~29,000,000** — fits in no window, any tier | **~630, flat** |
| a real notes/transcript repo | ~2,000,000 | ~630, flat |
| the accumulated memory (~20K memories) | ~1,300,000 | ~630, flat |

Empirically, on real questions, scoped recall used **~5× fewer tokens** than opening
the single best-matching doc, **switched between projects with 0% cross-project bleed**,
stayed **correct after code changed** (via `supersede`, which a notes file can't),
and **compressed structured results another ~48%** (TOON). Full methodology, honest
caveats, and the where-it-doesn't-win scorecard: **[results/RESULTS-V2.md](results/RESULTS-V2.md)**.

---

## Why AWM — and why not the usual alternatives

Most "memory for AI" is a vector database with a retrieval wrapper. [AWM](vendor/agent-working-memory)
is a *cognitive substrate*: it decides what's worth keeping, strengthens what gets
used, forgets noise, and **knows when a fact has changed**. That difference is what
lets a cheap conductor hold up over a long, messy, real project instead of drowning
in its own history.

### The alternatives, honestly

| Approach | What breaks as the project grows |
|---|---|
| **Stuff the context window** | Hard wall. Past the window you summarize — and summarizing silently drops the one fact you needed next. 29M tokens fits in no tier, any model. |
| **Notes file** (`CLAUDE.md`, markdown) | The *whole* file rides in every prompt, and it goes stale **silently** — nothing tells you a line is now wrong. One file = no project isolation. |
| **Plain RAG / vector DB** | Returns top-k chunks with no salience, decay, or correction — so it surfaces the **old** value next to the new one, and noise grows with the corpus. |
| **Rolling summary** | Lossy by construction; overwrites the specifics you'll want verbatim later (a column name, a working query, a prior correction). |
| **Flat fact store** (Mem0-style) | Better — but no consolidation, no Hebbian reinforcement, no staleness signal. Facts pile up flat and you pay for the dead weight on every query. |
| **AWM** | Scoped recall stays ~630 tokens **flat** as the store grows; `supersede` retires stale facts so recall stops returning them; salience-gating makes the ~90% never-recalled memories cost ≈0; agent/workspace scoping gives 0% cross-project bleed. |

### The real wins (measured, not asserted)

- **Flat cost at scale.** ~630 tokens to answer a question whether the store holds 600 memories or 20,000 — ~2,000× less than carrying the store, ~5× less than opening the single best-matching doc file. (`src/repo-qa.ts`)
- **Stays correct when reality changes.** A fact changes between visits → `supersede` → recall returns the new value, not the old. A notes file or plain vector store can't signal this. (`src/staleness.ts`)
- **No cross-project bleed.** Interleave several projects in one store → 0% wrong-project recall, via agent/workspace scoping. (`src/contextswitch.ts`)
- **Capability moves into the substrate.** On a real domain workload, gpt-5.4-mini primed by AWM scored **14/15 vs a frontier model's 7/15 at ~1/40th the cost** — the hard-won knowledge lived in memory, not the model's weights. ([AWM-Native Harness pattern](vendor/agent-working-memory/docs/patterns/awm-native-harness.md))

### What's actually under the hood (specs)

Grounded in cognitive science — ACT-R activation decay, Hebbian learning,
complementary learning systems, synaptic homeostasis + tagging — not ad-hoc heuristics:

- **Recall pipeline:** BM25 + dense embeddings (`bge-small-en-v1.5`, 384-d) + a cross-encoder reranker (`ms-marco-MiniLM-L-6-v2`), with query expansion (`flan-t5-small`), prefix-tag / entity-bridge boosts, and optional confidence-based abstention. ~300 ms typical, all in-process.
- **Write pipeline:** novelty + salience gating (low-value writes stage or drop), **reinforce-on-duplicate** (restating a fact with new detail merges + re-embeds rather than discarding), **supersede-on-correction**, and a `canonical` class with a salience floor for source-of-truth facts. <10 ms per write.
- **Engines:** Activation (recall), Connection (Hebbian graph), Consolidation ("sleep" — cluster, strengthen, bridge, decay), Retraction (forget). Consolidation is what makes recall *mature* over time instead of just accumulating.
- **Content fade:** un-recalled memories degrade their body but keep their cue pathways (concept + tags + embedding), so old memories stay findable while recall keeps the hot ones full-fidelity. Write-and-forget is safe.
- **Backends:** SQLite (embedded, multi-process-safe WAL — the default) or PGlite (embedded Postgres + pgvector).
- **Output compression:** TOON encodes structured tool results ~50–65% smaller, losslessly (every encode is verified `encode→decode→deep-equal`).
- **Embedded, no server:** MWA links AWM **in-process** — `EngramStore` + engines + `performWrite` directly — so there's no daemon and no network hop. AWM is vendored as a git submodule at `vendor/agent-working-memory`, so a bug fix or feature found while building the agent flows straight back upstream.

Full methodology + the honest where-it-doesn't-win scorecard: **[results/RESULTS-V2.md](results/RESULTS-V2.md)**; AWM internals: its own **[README](vendor/agent-working-memory/README.md)**.

---

## Install (Docker) — one container, onboards itself

The container is the whole app: open it in a browser, get **guided setup** on first run,
then just chat. Everything persistent (secrets `.env`, AWM memory, workspace, model
cache) lives on the `/data` volume — on your disk. Your provider key is entered in the
setup screen and only ever goes to the AI provider you chose.

Pull the published image (no local build needed):

```bash
docker run -d -p 127.0.0.1:7788:7788 -v mwa-data:/data --name mwa \
  ghcr.io/completeideas/mwa:latest
# open http://localhost:7788 → pick a model → chat. (Build locally instead with
# `docker build -t mwa .` if you've cloned the repo with --recurse-submodules.)
```

Or use Compose (`cp .env.example .env`, then `docker compose up -d`).

**Running it on a network / NAS?** Set an access password and lock it down:

```bash
docker run -d -p 7788:7788 -v mwa-data:/data --name mwa \
  -e MWA_ACCESS_PASSWORD='a-strong-password' \
  ghcr.io/completeideas/mwa:latest
```

`MWA_ACCESS_PASSWORD` puts the whole UI + API behind a login (empty = no gate, the
localhost default). For an always-on box (so scheduled tasks fire) — including a
**Synology NAS** — see **[docs/deploy-nas.md](docs/deploy-nas.md)** (Container Manager,
Tailscale-only access, volume mapping, RAM notes).

## Quickstart (local, turnkey)

Prereqs: Node 22+ (and a C toolchain for `better-sqlite3`). Either run the wizard
(`npm run wizard` → http://localhost:7788) or put API keys in `.env` directly
(see [Config](#config)).

```bash
git clone --recurse-submodules https://github.com/CompleteIdeas/memory-working-agent.git
cd memory-working-agent
npm install       # links the vendored AWM submodule + web app as npm workspaces
npm run build     # builds AWM (submodule) + MWA + the web app (→ dist-ui)
npm run serve     # → opens http://localhost:7788 — guided setup, then just chat with it
```

`mwa serve` (also the default, `mwa` with no args) is the one command for humans: it
opens a local web app in your browser — connect a model, then talk to your assistant and
**watch it remember, look things up, and do the work** (the live "activity spine"). Keys
stay on your machine. For developers there's also `mwa run "<instruction>"` (headless),
`mwa watch` (a drop-folder), `mwa connect telegram`, and `npm run bench` (the A/B/C
benchmark UI).

**Connecting email** (Gmail or Outlook) uses a guided **bring-your-own** sign-in — you
make a free Google/Microsoft app once and the token stays on your machine; there's **no
managed broker** (no per-user cost, no third-party token custody). See
**[docs/connect-email.md](docs/connect-email.md)** for the steps and the plan to make it
near-turnkey via a homegrown `mwa connect` helper.

> Already cloned without submodules? Run `git submodule update --init` then
> `npm install && npm run build`. AWM lives at `vendor/agent-working-memory` and is
> built from source, so MWA always runs the exact AWM it vendors — fix it there and
> the change flows upstream.

`npm run setup` (published as the `mwa` bin) is turnkey and non-interactive — it reads
your `.env`, checks the AWM substrate, and writes `mwa.config.json` (model tiers,
enabled tools, escalation). Re-run it any time; edit the file to change tooling.

### Tools

The brain calls **native function-calling tools**. Beyond the orchestration tools
(`dispatch`/`recall`/`read`/`supersede`/`done`), MWA has a pluggable **tool registry**
(`src/tools/`): each tool is a `ToolDef` + handler, enabled by name in `mwa.config.json`.

Built-ins: `run_command` (sandbox shell), `read_file`, `list_files`, `http_request`.

**MCP bridge (live).** Point `tools.mcpServers` at any MCP server and its tools register
into the same registry — namespaced `<server>__<tool>`, no code:

```jsonc
// mwa.config.json
"tools": {
  "builtins": ["run_command", "read_file", "list_files"],
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] }
  }
}
```

So MWA drives the whole MCP ecosystem (filesystem, github, postgres — even AWM itself)
on the cheap-conductor + memory substrate. The brain sees built-in and MCP tools as one
unified tool list. (Uses `@modelcontextprotocol/sdk`; servers that fail to connect are
logged and skipped, never aborting a run.)

### Run it live

Give the agent a free-form instruction and a working directory — it works toward it
over many steps on the AWM substrate, then stops on done / stuck / budget:

```bash
mwa run "add a /health route to server.js and verify it returns 200" --dir .
# dev: npm run agent -- "…instruction…" --dir . --max-steps 40 --max-min 10
```

It recalls prior context, acts via tools (`dispatch` codegen / `run_command` / `read` /
`recall` / `supersede` / any MCP tool), verifies its work, and self-determines done — no
fixed grader. Long runs stay **flat in tokens**: only recent steps sit in the prompt, older
context returns via recall, and it **sleeps (consolidates)** on phase boundaries. The cheap
brain conducts; the worker escalates cheap→strong only when it stalls. Memory persists across
runs (`--db`, default `./data/agent.db`) — so it gets sharper the more you use it.

### Talk to it from your phone (chat connector)

A connector bridges a messaging channel to the agent (message in → run → reply out):

```bash
# get a bot token from @BotFather, then:
TELEGRAM_BOT_TOKEN=… TELEGRAM_ALLOWED_CHATS=<your chat id> mwa connect telegram
```

Text the bot an instruction; it runs the agent and replies with the result + output
files. **Security:** the agent can run commands, so only chat ids in
`TELEGRAM_ALLOWED_CHATS` are served — message the bot once to learn your id, then add
it. Email (Gmail) and WhatsApp (Twilio) follow the same connector pattern.

### Mailbox (file I/O)

`mwa watch` polls `<workspace>/inbox/` for instruction files, works each in
`outputs/<id>/`, and writes a report to `outbox/<id>.md`. Drop a `.md`/`.txt` in,
get results + generated files out — no server.

V2 evidence experiments (deterministic where possible):

```bash
npx tsx src/retention.ts      # decision survives N distractors at flat token cost
npx tsx src/repo-qa.ts        # scan → wipe → return: recall vs notes-file vs long-context
npx tsx src/staleness.ts      # code changes between visits: supersede stays correct
npx tsx src/contextswitch.ts  # interleaved projects: 0% cross-project bleed at scale
npx tsx src/headtohead.ts     # AWM recall vs grep+read a real docs repo (needs a work snapshot)
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

The brain runs a **hybrid memory↔grep loop** (the discipline validated in V2),
not pure recall. Each turn it calls one **native function-calling tool** (the proven
USEA design — the API returns validated tool calls, not hand-parsed JSON):

- `recall` — scoped, full-content recall of prior decisions/learnings (first, and
  re-queried mid-task framed to the current sub-problem).
- `read` — read a sandbox file for ground truth when memory is silent or to verify.
- `dispatch` — hand a concrete coding step to the worker; result + decision written to AWM.
- `supersede` — replace a recalled fact the moment a result proves it wrong (stay fresh).
- `done` — only after a dispatch produced passing tests *this run* (guarded against
  a recalled "success" tricking it into skipping the work).

Components:

- **brain** (`src/brain.ts`) — the loop above; native tools via `src/provider.ts` (Azure gpt-5-4-mini on `chat/completions`, Anthropic via SDK), text-JSON fallback for non-tool models.
- **router** (`src/model-router.ts`) — `classifyIntent` picks the starting tier; consecutive worker failures escalate cheap→strong, AWM shared across the switch.
- **worker** (`src/worker.ts`) — codegen+exec into a sandbox, runs the fixed test, reports pass/fail. The grader is protected from overwrite.
- **AWM** (`src/awm.ts`) — in-process substrate: `MwaMemory` (recall + write + supersede + feedback) for arm A; `NullMemory` for AWM-off arms. Same loop, memory swaps.
- **tasks** (`src/tasks.ts`) — objective, ungameable; each ships a fixed test, plus a hard constraint checked against the produced code.
- **benchmark** (`src/benchmark.ts`) — arms A/B/C × tasks × N → `results/`.

## Layout

```
src/
  cli.ts                                               # `mwa` entry: run · watch · connect · wizard · setup
  brain.ts  agent.ts                                   # hybrid loops: bench conductor + live agent
  provider.ts  model-router.ts  env.ts  util.ts        # native tool-calling providers + cheap→strong router
  awm.ts                                               # in-process AWM substrate (recall/write/supersede/schedule)
  tools/ (registry · builtins · build · mcp)           # pluggable tool registry + MCP client bridge
  connectors/ (telegram · google)                      # chat + Gmail/Calendar (read + draft, never send)
  mailbox.ts  scheduler.ts  wizard.ts  config.ts       # file I/O · scheduled tasks · onboarding · config
  worker.ts  tasks.ts  benchmark.ts  server.ts         # worker + A/B/C bench + live UI
  retention.ts staleness.ts repo-qa.ts contextswitch.ts headtohead.ts  # V2 evidence experiments
vendor/agent-working-memory/                           # AWM — git submodule, built from source
mcp-servers/search.mjs                                 # bundled keyless web-search MCP server
results/RESULTS-V2.md                                  # the honest V2 writeup
Dockerfile  docker-entrypoint.sh  README.md
```

## Status

**0.1.0** (Apache-2.0). Core loop + A/B/C benchmark + Docker + UI verified; the brain
embodies the USEA-tuned hybrid loop (recall-first, grep-on-miss, supersede-on-divergence).
Shipping in this release: the live agent (`mwa run`), mailbox (`mwa watch`), Telegram +
Gmail/Calendar connectors (read + draft only), a scheduler on AWM's task ledger, an MCP
tool bridge, and AWM vendored as a built-from-source submodule. V2 measured where AWM
decisively wins — long-horizon retention, context switching, staleness, and scale —
with the honest scorecard in [results/RESULTS-V2.md](results/RESULTS-V2.md).
