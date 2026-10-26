# MWA serve — HTTP API reference

`mwa serve` exposes a small JSON/SSE API on `MWA_SERVE_HOST` (default `127.0.0.1`)
port `7788`. When `MWA_ACCESS_PASSWORD` is set, mutating/most routes require a
session cookie obtained from `POST /api/login` (localhost with no password set =
open). All bodies are JSON unless noted.

## Chat

### `GET /api/chat?message=<text>&session=<id>` → SSE
Streams one agent run as Server-Sent Events. Events: `run` (`{runId, startedAt}`), `start`, `recall`, `read`,
`remember`, `tool`, `step` (`{n, of, tool, detail, elapsedMs}` — one per tool call, with the file, folder, query or
address it touches), `dispatch`, `sleep`, `escalate`, `verify`, `ask`, `steered`, `stopping`, `stopped`, then a final
`result` (`{reason, summary, steps, dispatches, toolCalls, costUsd, runId, turnId, elapsedMs, staged?}`) or `error`
(`{message}`). `session` groups follow-ups (per-session working dir + brief history).
Concurrency is capped (`MWA_MAX_CONCURRENT`, default 4) — over the cap returns an
`error` event ("at capacity"). One run per conversation: a message sent while one is going gets a `busy` event
(`{runId, message, startedAt, elapsedMs, stopping, stage?}`) and no second run.

### Live runs (usability review 2026-10-24)
| Route | Method | Body / effect |
|---|---|---|
| `/api/chat/live?session=` | GET | `{live: {runId, message, startedAt, elapsedMs, stopping, stage?} \| null, running}`. A fired job runs under the session `job_<id>` (its row in `/api/schedule` carries the same under `live`), so every route in this table reaches a background run too. |
| `/api/chat/attach?session=` | GET → SSE | replays the live run's events so far and follows it to `result`; `gone` when nothing is running (a reload re-attaches instead of losing the answer) |
| `/api/chat/stop` | POST | `{session}` — the run ends at its next step with reason `stopped` and a summary of what it kept |
| `/api/chat/steer` | POST | `{session, message}` — queued into the run; the model gets it at its next step as the person's own words |

### Sources
| Route | Method | Returns |
|---|---|---|
| `/api/sources?session=` | GET | `{preset, folders:[{path, files, capped, readable}], added:[…]}` — the granted folders the run can read and the files added to this chat |

### Schedule
| Route | Method | Body / effect |
|---|---|---|
| `/api/schedule?person=` | GET | `{scheduled:[{id, kind: reminder\|watch\|task, request, instruction, due, recur, when, paused, tainted, allow, goal?, session?, lastRun?, fails?}]}` — this person's jobs; `session` is the web conversation it reports to (absent for Telegram), so the app shows the job inside the task that set it up; `allow` is `{vault?: [names], click?: [{host, label}]}` or null: what the job may do unattended in the browser (docs/browser.md) |
| `/api/schedule/cancel` | POST | `{id}` — stops it; undo within ten minutes |
| `/api/schedule/uncancel` | POST | `{id}` — the undo |
| `/api/schedule/pause` · `/resume` | POST | `{id}` — a paused job keeps its settings and does not run; resume sets its next natural slot |
| `/api/schedule/update` | POST | `{id, instruction?, at?, daily_at?, days?, every_minutes?}` — the same fields as the model's `schedule_update` |

### Settings (interface slice 2026-10-25)
| Route | Method | Body / effect |
|---|---|---|
| `/api/vault` | GET | `{entries:[{name, site?, fields:[names], savedAt?}]}` — saved logins and keys, never a value |
| `/api/vault/forget` | POST | `{name}` — deletes one entry. **Same-origin only.** Saving stays in the vault card the agent opens (BL-63). |
| `/api/quiet` | GET | `{window: "HH:MM-HH:MM" \| null, timeZone, fixed, invalid}` — quiet hours (BL-07) |
| `/api/quiet` | POST | `{value: "HH:MM-HH:MM" \| "off"}` — sets or clears them in `mwa.config.json`; refused when `MWA_QUIET_HOURS` fixes the window. **Same-origin only.** |

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
| `/api/approvals` | GET | `{pending:[{id,tool,summary,expiresInSec,expiresAt,createdAt,tainted,readLocal,kind,session,runId?}], recent:[{id,tool,status,summary,kind,session?,result?,at,createdAt}], auto:[…]}` — `recent` keeps every ending (done, approved, failed, declined as `cancelled`, expired) for a day |
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
