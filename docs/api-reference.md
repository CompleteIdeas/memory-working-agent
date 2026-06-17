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

## Relevant env vars

| Var | Default | Meaning |
|---|---|---|
| `MWA_SERVE_HOST` | `127.0.0.1` | bind host (`0.0.0.0` in Docker) |
| `MWA_ACCESS_PASSWORD` | — | when set, gates the UI/API behind a login cookie |
| `MWA_MAX_CONCURRENT` | `4` | max parallel agent runs |
| `MWA_MAX_TOKENS` | `400000` | per-run token cap (brain+worker) |
| `MWA_SESSION_TTL_MS` | `1800000` | idle session eviction (30 min) |
| `MWA_CONFIG_PATH` | `mwa.config.json` | config file location |
| `MWA_LOG` | `./data/mwa.log` | structured log file |
| `MWA_DB` / `MWA_ENV_PATH` / `MWA_WORKSPACE` | `./data/*` | DB / secrets / workspace paths |
