# MWA configuration reference

Every runtime knob MWA reads from the environment, grouped by concern. Set them in the process
environment, or in the `.env` file on the data volume (`MWA_ENV_PATH`, default `<data>/.env`).
⚠ marks flags with security consequences. Defaults are what you get if the var is unset.

> AWM (the memory substrate) has its own large set of `AWM_*` tuning knobs — leave them at defaults
> unless diagnosing a recall regression. See `vendor/agent-working-memory/docs/` and the "Diagnostics /
> escape hatches" section of the AWM guidance. Only the `AWM_*` vars an MWA operator normally touches
> (backend selection) are listed here.

## Core / serve
| Var | Default | Purpose |
|---|---|---|
| `MWA_DATA_DIR` | `./data` | Where every runtime file goes: the store (`agent.db`, `approvals.db`), `runs.jsonl`, `tokens.jsonl`, `conversations.jsonl`, `notifications.jsonl`, receipts, `mwa.log`, `installs.jsonl`, `vault.json`, transcripts and browser profiles. `mwa serve --data <dir>` sets it. Each file's own var below still wins when set. Before 2026-10-24 every default was relative to the current directory, so a server started from the repo wrote into the repo's `data/` (usability review F16). |
| `MWA_ROOT` / `MWA_HOME` | unset | A home folder: the data folder is then `<home>/data` (`MWA_DATA_DIR` wins). `.env` and `mwa.config.json` are configuration, not data, and keep `MWA_ENV_PATH` / `MWA_CONFIG_PATH`. |
| `MWA_WORKSPACE` | `./mwa-workspace` | Working-files root (per-run output folders, mailbox). |
| `MWA_DB` | `<data>/agent.db` | SQLite memory DB path (ignored when a non-SQLite backend is selected). |
| `MWA_ENV_PATH` | `<data>/.env` | Where secrets are read/written. |
| `MWA_CONFIG_PATH` | `<data>/mwa.config.json` | Model/tools/access config file. |
| `MWA_SERVE_HOST` | `127.0.0.1` | Bind address. ⚠ Setting `0.0.0.0` exposes the server on the network — **only with `MWA_ACCESS_PASSWORD` set** (or behind Tailscale). |
| `MWA_SERVE_PORT` | `7788` (honors `$PORT`) | HTTP/SSE port. Railway/PaaS: honors `$PORT`. |
| `MWA_NO_OPEN` | unset | Set to skip auto-opening the browser on `serve`. |

## Security & access ⚠

> **Exposing MWA through a forwarder? Set `MWA_RELAYED=1`.** With no password, a request that arrives from
> 127.0.0.1 with `Host: localhost` is trusted as "this machine". A hand-made forwarder — `socat`, `netsh interface
> portproxy`, `ssh -R`, an nginx `stream` block or `proxy_pass` without `X-Forwarded-For` — delivers every remote
> request exactly like that, and MWA cannot see it. Anyone who sets one up must set `MWA_RELAYED=1` and
> `MWA_ACCESS_PASSWORD`. (MWA does detect its own Docker image's Tailscale, a bind beyond 127.0.0.1, Railway and
> containers, and `tailscale serve` forwarding to its port — checked at start and every 5 minutes.) The server says
> this in its start-up log whenever it runs with no password on loopback.
| Var | Default | Purpose |
|---|---|---|
| `MWA_ACCESS_PASSWORD` | unset (open) | ⚠ Shared password gate. When set, **every** `/api/` route requires login (constant-time check, 30-day HttpOnly cookie with a server-side record: signing out ends it). **Set this for any networked/NAS/Tailscale/`0.0.0.0` deployment.** Unset = this computer only (single-user default); a paired phone still works. Wrong passwords slow their source down (¼ s doubling to 10 s); the right one is never refused. |
| `MWA_ALLOWED_HOSTS` | unset | Comma-separated host names the server answers to besides `localhost`, `127.0.0.1`, `[::1]`, IP addresses and this machine's name — e.g. `mwa.tail1a2b.ts.net`, or `*.tail1a2b.ts.net`. Any other `Host` gets 421 (DNS-rebinding defence). Railway's own domain and the Docker image's `<TAILSCALE_HOSTNAME>.<tailnet>.ts.net` are allowed automatically. `*` turns the check off. A non-local name here also means **relayed mode** (below). |
| `MWA_PUBLIC_URL` | unset | Where phones reach the helper, e.g. `https://mwa.tail1a2b.ts.net`. Pairing links (the QR) use it when Settings is opened at `localhost`; also settable in Settings › Your helper. Its host is allowed, and it means relayed mode. |
| `MWA_RELAYED` | auto | `1`: something can relay remote clients to this server from 127.0.0.1 (socat, ssh -R, netsh portproxy, nginx without X-Forwarded-For…), so nobody counts as "this machine" — sign in with the password or a paired device. Detected automatically when bound beyond 127.0.0.1 (`MWA_SERVE_HOST=0.0.0.0`, the Docker image), with the Docker image's Tailscale (`TAILSCALE_AUTHKEY`), on Railway/containers, when `tailscale serve` forwards to this port (checked at start), or with a non-local `MWA_ALLOWED_HOSTS` / `MWA_PUBLIC_URL`. `0` says it is not. |
| `MWA_TRUSTED_PROXY` | unset | Comma-separated IP addresses **or CIDR ranges** (`127.0.0.1`, `10.0.0.0/8`, `fd7a:115c:a1e0::/48`) of proxies whose `X-Forwarded-For` the throttles may believe (e.g. `127.0.0.1` behind `tailscale serve`, so each phone is its own source); the right-most address not in the list counts. Unset: the socket address counts, and the header is ignored. |
| `MWA_UPLOAD_QUOTA_MB` | `2048` | Total size of files added through uploads (every project's `uploads` folder). Past it, an upload gets 507. One file is at most `MWA_MAX_UPLOAD_MB` (25). |
| `MWA_ALLOW_UNATTENDED_WRITES` | unset (off) | ⚠ When `1`, a scheduled/unattended run may `confirm_action` a write with no human present. Leave OFF unless you intend autonomous writes. |
| `MWA_APPROVAL_TTL_MS` | `600000` (10 min) | How long a pending dry-run write stays confirmable before it expires. |

The write-approval gate (dry-run→confirm) and the S6 per-person **step-up** gate (a 2nd factor for a
flagged identity before a sensitive confirm) are always on; they are not env-toggled.

## Model
| Var | Default | Purpose |
|---|---|---|
| `MWA_MODEL` | from `mwa.config.json` | Override the conductor model (`<provider>:<model>`, e.g. `azure:gpt-5-4-mini`, `openrouter:…`, `ollama:llama3.1`). Models differ in how well they ignore instructions planted in email and web pages: see [models.md](models.md). |
| `MWA_MODEL_IMAGE` | from config | Override the image model. |
| `MWA_BACKGROUND_MODEL` | unset (`models.background`) | The model for work nobody waits on: scheduled jobs, "work on it" hand-offs and thinking time. Chats keep `MWA_MODEL`. In the job bake-off (2026-10-23), with MWA's checks on, `openrouter:openai/gpt-6-luna` and `openrouter:deepseek/deepseek-v4.1-flash-1017` each scored 27 of 28 at about $0.0045 a brief, against 26 of 28 at $0.108 on `gpt-6.1-sol`. |
| `MWA_BACKGROUND_BOSS` | off | `on`: a background run starts on `MWA_BACKGROUND_MODEL` and `MWA_MODEL` (the boss) takes over when it stalls for 3 steps, ignores a check or gives up (BL-73). In the bake-off it added at most one point for about 16 times the cost, so it is off unless asked for. |
| `MWA_BACKGROUND_EFFORT` | `high` | Reasoning effort for the background worker (`minimal`, `low`, `medium`, `high`, or `tier` for the tier's own). Only OpenAI models take an effort setting. |
| `MWA_WATCH_GATE` | on when Clef is set | Before a watch that reports only changes sends a message, Clef checks it against what the watch said last; the same situation in other words stays quiet (BL-73, [calibration](watch-gate-calibration-2026-10-23.md)). Needs `MWA_CLEF_TOKEN` and `MWA_CLEF_ACCOUNT`; `off` turns it off. |
| `MWA_OLLAMA_NUM_CTX` | sized per prompt | For `ollama:` models, a fixed context size in tokens. By default MWA sizes it from each prompt, in 8k steps from 16k. It keeps one size per model and only grows it while running, because Ollama reloads the model when the size changes. |
| `MWA_OLLAMA_MAX_NUM_CTX` | the model's own limit | The largest context MWA may ask Ollama for, so it fits your memory. A request that needs more is refused with both numbers, rather than Ollama silently dropping the start of the prompt. MWA asks Ollama not to truncate, so a prompt that doesn't fit is refused with its real size. |
| `MWA_OLLAMA_TIMEOUT_MS` | `600000` | How long to wait for a local model's answer, which can be slow on a CPU. |
| `MWA_SECOND_OPINION` | off | `cloudflare:clef-flash` or `cloudflare:clef`: a decision model reads each change MWA asks to commit and puts its answers on the approval card. Advisory only. Needs `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` (Workers AI permission). See [self-build.md](self-build.md#a-second-opinion-on-the-commit-card-optional). |
| `MWA_MAX_TOKENS` | `400000` | Hard per-run output-token ceiling (cost guard). |

Provider API keys live in `.env` (never committed): `ANTHROPIC_API_KEY`, `AZURE_GPT_*`, `OPENAI_API_KEY`,
`OPENROUTER_API_KEY`, `OLLAMA_*`, etc. — surfaced through the setup wizard, stored mode-0600.

## Memory backend
| Var | Default | Purpose |
|---|---|---|
| `AWM_STORE_BACKEND` | `sqlite` | `sqlite` (default, multi-process safe) · `pglite` (embedded Postgres, single-process) · `postgres` (server). |
| `AWM_DATABASE_URL` | — | Postgres connection string (required for `postgres`). |
| `AWM_DB_PATH` | `MWA_DB` | Path override (file for sqlite, directory for pglite). |
| `MWA_WORKSPACE_SHARE` / `AWM_WORKSPACE` | unset | Hive workspace name for cross-agent shared recall. **SQLite only today** — Postgres/PGlite warn once and scope recall to self. |

## Per-person Profile (S1–S6)
| Var | Default | Purpose |
|---|---|---|
| `MWA_PERSON_PROFILE` | on | Set `0` to disable per-person priming/identity/step-up entirely. |
| `MWA_PERSON_LEARN` | on | Set `0` to disable learning facts about people + dossier compression. |
| `MWA_DOSSIER_CAP` | `10` | Atomic-note count that triggers dossier re-compression (only fires when something new was learned). |

## Agent behavior
| Var | Default | Purpose |
|---|---|---|
| `MWA_MAX_CONCURRENT` | (small) | Max parallel agent runs the serve process will start (box protection). |
| `MWA_SESSION_TTL_MS` | (default) | Idle chat-session eviction window. |
| `MWA_FAST_CHAT` | on | `0` disables the one-call conversational fast path. |
| `MWA_PLAN` | on | `off` disables plan-and-execute decomposition. A request is planned when it names steps ("then", "after that", a numbered list) or, over 220 characters, asks for something to be produced and is not itself a question (`wantsPlan`). Until 2026-10-25 any message over 220 characters was planned: in the experience pilot that split every long question into steps and cost the memory arm 8 answers of 54 (31 planned, 39 direct, at half the cost). |
| `MWA_TOPIC_BOUNDARY` | on | `0` disables auto topic-boundary detection (continue/fresh/ask). |
| `MWA_TOPIC_NAMESPACE` | off | `1` scopes memory per conversation segment (usually leave off — hurts cross-session continuity). |
| `MWA_FRESH_IDLE_MS` | `2700000` (45 min) | Idle gap that forces a "new topic". |
| `MWA_AUTO_ROUTINES` | (default) | Auto self-crystallizing routines (F6). |
| `MWA_ENTITY_BRIDGE` | (default) | Entity-bridge recall boost toggle. |
| `MWA_PRIME_SOURCES` | on | A primed `insight:` or `position:` brings up to three of the memories it rests on (its `causal` links, written by reconsolidation), scored just under it, so the conclusion arrives with its numbers. On the pilot's replay (2026-10-24) it moved the memory that answers to #1 on three more questions. `0` turns it off. |
| `MWA_PRIME_ABSTRACT_CAP` | `3` | How many `insight:` / `position:` memories (patterns read across memories, standing views) may take primed slots at the start of a run; the rest move behind the specific facts. In the experience pilot (2026-10-23) five general memories were primed on 11–17 of 18 unrelated questions, pushing the memories holding the asked-for numbers out of the twelve primed. |
| `MWA_ANSWER_SAMPLES` | `1` (off) | Sampled answers. A question answered from what the run gathered, with nothing acted on, is drafted this many times (up to 5) from the same context and merged into one answer that keeps every figure any draft gave. When the drafts disagree on a figure or a verdict, or all hedge, a stronger tier takes the run over (the background boss, `MWA_BACKGROUND_BOSS`), or with none above, memory is recalled once more on the question's identifiers. In the experience pilot (2026-10-24) merging three drafts took the memory arm from 11.7 to 13 of 18 questions (the best pick of three being 14) and Sol with the files from 15.3 to 17; the merge cost a tenth of a cent, the drafts about one answer each. Run inside MWA with the drafts firing on 47 of 54 runs (arm F6P, 2026-10-25, planning off) it scored 38 against 39 without, with repeat-to-repeat consistency up from 72% to 83% and cost up by a third: drafts from one run share one recall, so the union adds little. Off by default for that reason; turn it on where a consistent answer matters more than a cent. |
| `MWA_BROWSER` | on | `0` turns the agent browser's tools off. `MWA_BROWSER_DIR` (default `<data>/browser`) holds the per-person Chromium profiles; `MWA_CHROMIUM_PATH` names a Chromium to use instead of Playwright's. |
| `MWA_BROWSER_MAX_CHARS` | `9000` | page text per snapshot; `MWA_BROWSER_TIMEOUT_MS` (`30000`) is the navigation timeout. |
| `MWA_DOCUMENT_LOOKS` | `6` | how many pages a run may look at as pictures (`document_look`: a PDF page or an image file, rendered in process — no shell, no poppler); only a model that takes images gets one. `read_document` reads a PDF by page (`pages`) and every reader (`read_document`, `read_file`, `http_request`) says how to read on (`offset`). |
| `MWA_BROWSER_LOOKS` | `3` | how many times a run may look at a picture of the page (`browser_look`); only a model that takes images gets one, and never while a password box on the page holds a value. See docs/browser.md. |
| `MWA_BROWSER_ALLOW` / `MWA_BROWSER_DENY` | unset | Comma lists of hosts, added to `tools.browser.allow` / `tools.browser.deny` in `mwa.config.json`. A denied host is never reached by any request; with a non-empty allow list only listed hosts can be opened, landed on or shown in a frame (a page's own fonts, scripts and images are not held to it; a frame from an unlisted site stays blank). A host covers itself and its subdomains; `*.example.com` only the subdomains; an entry written as an address is read as its host. `MWA_BROWSER_DOWNLOAD_MB` (`25`) caps a file the browser saves into `downloads/`. |
| `MWA_MONTHLY_BUDGET_USD` | unset | Fixes the monthly model-spend budget (else Settings › Billing sets `billing.monthlyUsd` in `mwa.config.json`). At 80% the app warns; at 100% scheduled jobs wait, an hour at a time, until the month turns or the budget is raised, and a chat's reply says so. The spend is the sum of `tokens.jsonl` (`MWA_TOKEN_LOG`) for the calendar month; `/api/billing` has the sums, `/api/billing.csv?days=` the calls. |
| `MWA_BRIDGE_SLOTS` | `2` | How many of the ten primed memories may be second hops the entity bridge found (memories recalled for a name in the question's own results, for "the codename of my main project" questions). They sit in the last slots, under the question's own results; `0` keeps the bridge out of the prime (`MWA_ENTITY_BRIDGE=0` turns it off altogether). |
| `MWA_PRIME_LOG` | unset | A file: every run appends one JSON line with the PRIOR KNOWLEDGE block it started with, for a pilot or a replay asking what the model actually saw. |
| `MWA_STRIP_CODES` | on | `0` stops hiding one-time codes and sign-in / reset links in what the agent reads from outside (pages, email, connectors). On, a code that words announce ("your verification code is …") and a link that signs in, resets or verifies with a token in it reach the model as `‹one-time code hidden›` / `‹one-time link hidden: host›`; the run's log notes the first time it hid something. Files the person has and the agent's own output are never touched (what a site downloaded is outside content and is). |
| `MWA_AGENT_ID` | `mwa-serve` | The AWM agent id the serve process recalls/writes under. |
| `MWA_DOMAIN_PACK` | unset | Path to a domain pack (`AGENT.md` + `topics/`) — plugs a domain agent onto MWA. |
| `MWA_HTTP_TIMEOUT_MS` | (default) | Timeout for the `http_request`/`read_document` tools. |

## Connectors
| Var | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather (`mwa connect telegram`). |
| `TELEGRAM_ALLOWED_CHATS` | Comma-separated allowlist of chat ids (all rejected until set). |
| `TAILSCALE_AUTHKEY` / `TAILSCALE_HOSTNAME` | Join a tailnet (userspace) for private access with no public port. |
| `MWA_GMAIL_USER` / `MWA_GMAIL_APP_PASSWORD` / `MWA_GMAIL_IMAP_HOST` / `MWA_GMAIL_IMAP_PORT` | Device-local Gmail (IMAP) connect. |
| `MWA_MS_TOKEN` / `MWA_MS_OAUTH_PORT` / `MWA_DEFAULT_MS_CLIENT_ID` | Device-local Outlook (Microsoft Graph) connect. |
| `MWA_GOOGLE_TOKEN` / `MWA_GOOGLE_OAUTH_PORT` | BYO Gmail/Calendar (loopback OAuth). |
