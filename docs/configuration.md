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
| `MWA_ROOT` / `MWA_HOME` | `~/.mwa` (app), cwd (dev) | Config home (`.env`, `agent.db`, workspace). |
| `MWA_WORKSPACE` | `./mwa-workspace` | Working-files root (per-run output folders, mailbox). |
| `MWA_DB` | `<data>/agent.db` | SQLite memory DB path (ignored when a non-SQLite backend is selected). |
| `MWA_ENV_PATH` | `<data>/.env` | Where secrets are read/written. |
| `MWA_CONFIG_PATH` | `<data>/mwa.config.json` | Model/tools/access config file. |
| `MWA_SERVE_HOST` | `127.0.0.1` | Bind address. ⚠ Setting `0.0.0.0` exposes the server on the network — **only with `MWA_ACCESS_PASSWORD` set** (or behind Tailscale). |
| `MWA_SERVE_PORT` | `7788` (honors `$PORT`) | HTTP/SSE port. Railway/PaaS: honors `$PORT`. |
| `MWA_NO_OPEN` | unset | Set to skip auto-opening the browser on `serve`. |

## Security & access ⚠
| Var | Default | Purpose |
|---|---|---|
| `MWA_ACCESS_PASSWORD` | unset (open) | ⚠ Shared password gate. When set, **every** `/api/` route requires login (constant-time check, 30-day HttpOnly cookie). **Set this for any networked/NAS/Tailscale/`0.0.0.0` deployment.** Unset = localhost-only, no auth (single-user default). |
| `MWA_ALLOW_UNATTENDED_WRITES` | unset (off) | ⚠ When `1`, a scheduled/unattended run may `confirm_action` a write with no human present. Leave OFF unless you intend autonomous writes. |
| `MWA_APPROVAL_TTL_MS` | `600000` (10 min) | How long a pending dry-run write stays confirmable before it expires. |

The write-approval gate (dry-run→confirm) and the S6 per-person **step-up** gate (a 2nd factor for a
flagged identity before a sensitive confirm) are always on; they are not env-toggled.

## Model
| Var | Default | Purpose |
|---|---|---|
| `MWA_MODEL` | from `mwa.config.json` | Override the conductor model (`<provider>:<model>`, e.g. `azure:gpt-5-4-mini`, `openrouter:…`, `ollama:llama3.1`). Models differ in how well they ignore instructions planted in email and web pages: see [models.md](models.md). |
| `MWA_MODEL_IMAGE` | from config | Override the image model. |
| `MWA_BACKGROUND_MODEL` | unset (`models.background`) | The model for work nobody waits on: scheduled jobs, "work on it" hand-offs and thinking time, at both tiers. Chats keep `MWA_MODEL`. E.g. `openrouter:openai/gpt-6-luna`: the same three research jobs cost $0.14 on it against $2.08–2.62 on `gpt-6.1-sol`. |
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
| `MWA_PLAN` | on | `off` disables plan-and-execute decomposition for complex tasks. |
| `MWA_TOPIC_BOUNDARY` | on | `0` disables auto topic-boundary detection (continue/fresh/ask). |
| `MWA_TOPIC_NAMESPACE` | off | `1` scopes memory per conversation segment (usually leave off — hurts cross-session continuity). |
| `MWA_FRESH_IDLE_MS` | `2700000` (45 min) | Idle gap that forces a "new topic". |
| `MWA_AUTO_ROUTINES` | (default) | Auto self-crystallizing routines (F6). |
| `MWA_ENTITY_BRIDGE` | (default) | Entity-bridge recall boost toggle. |
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
