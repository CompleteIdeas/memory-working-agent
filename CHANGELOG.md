# Changelog

## 0.3.3 (2026-06-18) — onboarding + UX: model picker, first-run setup, walkthrough, faster chat

- **Dynamic model selection.** `listModels(provider)` + `GET`/`POST /api/models` list a
  provider's available models (OpenAI-compatible `/models`, Anthropic `/v1/models`,
  OpenRouter's public catalog). Onboarding's model field is now a type-ahead dropdown.
- **First-run model setup.** `POST /api/setup/warm` downloads the local recall models so the
  first chat doesn't hang; the onboarding "Start" step waits with a "Preparing your memory…" note.
- **Feature walkthrough.** A capabilities tour during onboarding with on/off toggles for the
  bundled connectors (reuses the existing enable/disable).
- **Telegram connect.** The Connections page now has a real Telegram set-up control (bot-token
  entry + live validation), not just a status label.
- **Faster conversational replies.** A fast path answers greetings / "what can you do?" in one
  cheap call, skipping memory recall, the entity bridge, and tools (`MWA_FAST_CHAT=0` to disable).

## 0.3.2 (2026-06-18) — domain pack reaches the whole agent (full topics + the planner)

Fixes so the domain pack actually drives behavior end-to-end (found while standing up a
support agent that kept ignoring its own documented DB tool):

- **Domain context no longer truncated.** `buildDomainContext` capped the *combined*
  AGENT.md + topics at 6000 chars, so a large AGENT.md ate the whole budget and **every
  topic file was silently dropped**. Now AGENT.md is always included in full (≤40k) and
  topics get their own budget (16k total, ≤8k/topic) — `topics/*.md` knowledge loads.
- **Topic selection no longer biased toward big files.** Relevance now weights filename
  and headings above body mentions (plus singular/plural matching, top-5), so a small
  focused topic (e.g. `dba-member-queries.md`) beats a giant catch-all.
- **The planner now sees the domain pack.** Plan-and-execute built its planning prompt
  *without* the domain pack, so it decomposed data tasks into generic steps like "inspect
  the workspace for the data source" instead of using the documented domain tool. The
  planner now gets the same domain context as the direct loop and is told to USE documented
  tools/methods, not hunt for them.
- Requires `agent-working-memory ^0.9.1` (fixes `import` of exports containing associations).
- Internal: groundwork for agent-contributed knowledge-store entries (experimental, unwired).

## 0.3.1 (2026-06-17) — domain-pack hook for serve

- `mwa serve` now honors `MWA_DOMAIN_PACK` — passes it as `domainPackDir` to `runAgent`,
  so a domain agent (e.g. a support agent) can load its `AGENT.md` + `topics/*.md`
  progressive-disclosure pack via env without code. Additive; no behavior change when unset.

## 0.3.0 (2026-06-17) — production-readiness hardening + modular tooling

Makes MWA a solid, embeddable agent platform. No breaking API changes.

### Safety & security
- `http_request` hard timeout (`MWA_HTTP_TIMEOUT_MS`, default 15s).
- Process-level `unhandledRejection` (log, keep serving) + `uncaughtException`
  (log + exit for supervised restart).
- Bundled MCP servers resolve correctly under global / `npx` install (no longer
  CWD-relative).
- Two-step write-approval gate (`requireApproval` + `confirm_action` /
  `cancel_action`): irreversible/custom tools preview, then run only after explicit
  approval (chat **or** the `/api/approvals` UI). Unattended runs refuse to confirm
  writes unless `MWA_ALLOW_UNATTENDED_WRITES=1`.
- Substance gate before `done` — rejects fabricated actions and punts.

### Modular, hot-swappable tooling
- `list_active_tools`, `uninstall_connector`, `remove_mcp_server`, and
  approval-gated `add_mcp_server` — add/remove tools & MCP servers from chat;
  curated connectors auto-install, arbitrary ones require approval.
- `MWA_CONFIG_PATH` override (deploy flexibility + testability).
- Progressive-disclosure domain packs (`runAgent({ domainPackDir })`).

### Resource limits & lifecycle
- Per-run token cap (`budget.maxTokens`, serve default `MWA_MAX_TOKENS=400k`).
- Concurrency cap (`MWA_MAX_CONCURRENT=4`) + session TTL/LRU eviction.
- Graceful SIGTERM/SIGINT shutdown (drain in-flight, 10s backstop).
- Scheduler exponential backoff (60s→…→30m) on repeated failure.

### Observability
- `GET /api/health` (503 if DB unreachable; uptime, memory count, active runs,
  sessions, scheduler heartbeat) — the Docker healthcheck now uses it.
- Structured JSON logger → `data/mwa.log`; `GET /api/logs?since=&level=`.
- Config validation on load with clear warnings; loud warning on malformed config.

### Tooling & docs
- CI: `.github/workflows/check.yml` (build + typecheck + test on every push/PR).
- Critical-path tests: model-router, access-control path guard, agent done-path,
  approval gate, substance gate, domain pack, scheduler backoff, config validator,
  logger, tool management.
- `docs/api-reference.md`, `docs/embedding-mwa.md`, README ops/security section.

## 0.2.0 (2026-06-17) — first npm release

MWA on the AWM 0.9 substrate: `mwa serve` chat UI + activity spine, multi-provider
router (Anthropic/Azure/OpenAI-compat/Ollama), scheduler + mailbox, connectors
(Gmail/Outlook/Telegram), curated connector self-install, PWA, Docker/Synology.
