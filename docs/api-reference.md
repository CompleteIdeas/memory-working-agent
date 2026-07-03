# MWA serve — HTTP API reference

`mwa serve` exposes a small JSON/SSE API on `MWA_SERVE_HOST` (default `127.0.0.1`)
port `7788`. When `MWA_ACCESS_PASSWORD` is set, mutating/most routes require a
session cookie obtained from `POST /api/login` (localhost with no password set =
open). All bodies are JSON unless noted.

## Chat

### `GET /api/chat?message=<text>&session=<id>` → SSE
Streams one agent run as Server-Sent Events. Events: `start`, `recall`, `read`,
`remember`, `tool`, `dispatch`, `sleep`, `escalate`, `verify`, `ask`, then a final
`result` (`{reason, summary, steps, dispatches, toolCalls, costUsd}`) or `error`
(`{message}`). `session` groups follow-ups (per-session working dir + brief history).
Concurrency is capped (`MWA_MAX_CONCURRENT`, default 4) — over the cap returns an
`error` event ("at capacity").

## Status & observability

| Route | Method | Returns |
|---|---|---|
| `/api/status` | GET | provider + connection configuration state |
| `/api/health` | GET | `{ok, uptimeSec, db, memoryCount, activeRuns, sessions, schedulerLastTickAgoSec}`; **503** if the DB is unreachable. Used by the Docker healthcheck. |
| `/api/logs?since=<ts>&level=<info\|warn\|error>` | GET | `{logs:[{ts,level,category,msg,data}]}` — recent structured logs, newest first |
| `/api/runs` | GET | recent run-log entries |
| `/api/notifications?since=<ts>` | GET | recent scheduler/agent notifications |
| `/api/suggestions` | GET | starter prompts for the empty state |
| `/api/questions` | GET/POST | open self-learning questions (GET) / answer one (POST) |

## Configuration & connections

| Route | Method | Body / effect |
|---|---|---|
| `/api/save` | POST | `{which: 'anthropic'\|'azure'\|'provider'\|'telegram'\|'google'\|'microsoft'\|'access', …}` — validates with a live test call, writes to `.env` / `mwa.config.json`. Returns `{ok, message}` (never echoes the key). |
| `/api/connections` | GET/POST | configured connectors/secrets state; enable/connect flows |
| `/api/login` | POST | `{password}` → sets the session cookie (only when `MWA_ACCESS_PASSWORD` is set) |

## Write approvals (two-step gate)

The UI half of the tool-approval gate (the agent uses `confirm_action` in chat;
a human can review here instead).

| Route | Method | Body / effect |
|---|---|---|
| `/api/approvals` | GET | `{pending:[{id,tool,summary,expiresInSec}]}` |
| `/api/approvals/confirm` | POST | `{id?}` — execute a pending action (omit id = the single most recent) |
| `/api/approvals/cancel` | POST | `{id}` — discard a pending action |

## Memory (Glass Box)

The transparency + control surface over what the agent knows and has done. Every fact carries
**provenance** and a **trust** tier (the spine — see
[the-memory-substrate.md](the-memory-substrate.md)).

| Route | Method | Body / returns |
|---|---|---|
| `/api/memories` | GET | `{memories:[{id, concept, content, trust, provenance, origin?}]}` — recent learned facts with provenance/trust, newest first |
| `/api/actions` | GET | `{actions:[{id, verb, summary, effect, tool?, undo?}]}` — the "what I did" side-effecting action log |
| `/api/memory/export` | GET | `text/markdown` attachment — everything MWA knows, portable + provenance-annotated |
| `/api/memory/forget` | POST | `{id}` — hard-delete one memory (privacy). **Same-origin only.** |
| `/api/memory/correct` | POST | `{id, concept, content}` — replace a fact with your authoritative text (becomes trusted); deterministic + rolls back on failure; rejects a non-existent id. **Same-origin only.** |

The state-changing routes (`forget` / `correct`) require a same-origin request (CSRF defense) and
mint nothing for a forged id.

## People & identity (per-person Profile, S1–S6)

The per-person layer (see [true-agent-and-person-profile.md](true-agent-and-person-profile.md)). A
person is resolved from the channel (Telegram chat id, email sender, or the web `?person=<name>` param);
profiles are hard-isolated per person.

| Route | Method | Body / returns |
|---|---|---|
| `/api/people` | GET | `{people:[{personId, notes, fields, missing, dossier}]}` — everyone the agent has a profile for, with intake-field coverage + current dossier. |
| `/api/stepup/issue` | POST | `{personId, purpose?}` → `{ok, challengeId}` or `{ok:false, reason:'no-factor'\|'delivery-failed'}`. Issues a step-up challenge and delivers a one-time code **out-of-band** to the person's validated connection (Telegram). **Same-origin only.** |
| `/api/stepup/verify` | POST | `{challengeId, code}` → `{ok, reason?}` — verify the code; single-use, 3-attempt cap, 5-min TTL. On success the person is step-up-satisfied (and un-suspected). **Same-origin only.** |

`GET /api/chat` also emits per-person SSE events: `person {id, notes}` (who + how much is known),
`identity {level:'mismatch'}` (a self-claim contradicts the record — **the stored name/reasons are NOT
sent to the client**), and `learned {about, count}` (durable facts captured this turn).

When identity is in doubt, a sensitive `confirm_action` is **mechanically blocked** at the approval
gate until a step-up is verified (`isStepUpSatisfied`); suspicion is sticky across turns.

## Ingest

| Route | Method | Body / returns |
|---|---|---|
| `/api/ingest?days=<n>` | GET → SSE | Scan the connected inbox and write durable memories from it. Side-effecting → **same-origin only.** |

## Relevant env vars

| Var | Default | Meaning |
|---|---|---|
| `MWA_SERVE_HOST` | `127.0.0.1` | bind host (`0.0.0.0` in Docker) |
| `MWA_TOPIC_NAMESPACE` | `0` | `1` = scope chat recall + fact-writes to the active topic (no cross-topic bleed); off by default to preserve cross-session continuity |
| `MWA_AUTO_ROUTINES` | `0` | `1` = after a complex successful run, propose a versioned, injection-scanned routine (propose-not-commit) |
| `MWA_ACCESS_PASSWORD` | — | when set, gates the UI/API behind a login cookie |
| `MWA_MAX_CONCURRENT` | `4` | max parallel agent runs |
| `MWA_MAX_TOKENS` | `400000` | per-run token cap (brain+worker) |
| `MWA_SESSION_TTL_MS` | `1800000` | idle session eviction (30 min) |
| `MWA_CONFIG_PATH` | `mwa.config.json` | config file location |
| `MWA_LOG` | `./data/mwa.log` | structured log file |
| `MWA_DB` / `MWA_ENV_PATH` / `MWA_WORKSPACE` | `./data/*` | DB / secrets / workspace paths |
