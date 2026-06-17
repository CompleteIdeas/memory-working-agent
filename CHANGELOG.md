# Changelog

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
