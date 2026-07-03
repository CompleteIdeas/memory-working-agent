# Changelog

## 0.5.0 (2026-07-02) — per-person Profile, step-up verification, scheduler cost-gate, review hardening

First public 0.5.0 (npm was at 0.3.3). Version pin corrected to `agent-working-memory@^0.10.0` (was
`^0.9.1`, which excluded the vendored 0.10.0). See `docs/gap-analysis-2026-07.md` for the full audit +
fix ledger and `docs/configuration.md` for the complete env-var reference.

- **Per-person Profile (S1–S6)** — the agent adapts to *who it's talking to* and learns about them:
  person-scoped memory with hard cross-person isolation (`person=<id>`), a "who I'm talking to"
  primer injected each turn (tone/depth/elicitation only — never facts or safety gates), a learn
  trigger + self-recompressing **dossier** (a materialized view over the notes), a canonical intake
  schema (name/contact/role/style), and identity-mismatch detection. Off-switches
  `MWA_PERSON_PROFILE=0` / `MWA_PERSON_LEARN=0`. See `docs/true-agent-and-person-profile.md`.
- **Step-up verification (S6 v2)** — when an identity is in doubt, a sensitive/irreversible action is
  **mechanically blocked** at the approval gate until a second factor is verified out-of-band through
  a validated connection (Telegram). The gate travels with the pending action (enforced on both the
  chat tool and the UI confirm path); the validated connection is never revealed to a suspected
  impersonator; suspicion is **sticky** across turns so a split-claim can't bypass it.
- **Scheduler change-detection gate** — a recurring task can carry a cheap `check` command; an
  unchanged signature skips the (expensive) model fire entirely (idle polls ≈ free). Executes only
  when the access preset allows unattended commands.
- **Security hardening (from the audit + code review):** CSRF `sameOriginOk` extended to `/api/chat`,
  `/api/ingest`, `/api/approvals/*`, `/api/questions`, `/api/stepup/*`, `/api/open`; auto-learn +
  `remember` no longer promote **untrusted**-derived facts to canonical (F2 boundary); scheduled runs
  pass `interactive:false` (restores the unattended-write refusal); `activeRuns` cap reserved before
  any `await` (concurrency race). CI now runs the security/person/scheduler proof suite.

### Also in 0.5.0 — pluggable database backend (SQLite · PGlite · Postgres) + Tailscale + CSRF (2026-06-30)

The store is now backend-agnostic, so MWA runs on an embedded file (local/simple) or a real
Postgres server (cloud / multi-instance / always-on) without code changes. Sub-1.0 on purpose
(the backend-choice installer + AWM parity work come next). Not yet published.

- **Backend-agnostic memory** — `MwaMemory` opens its store lazily via the configured backend
  (`AWM_STORE_BACKEND` = `sqlite` [default] · `pglite` · `postgres`); every store-touching method
  is async. `await`-over-a-sync-SQLite-result is a no-op, so the SQLite default is 100%
  backward-compatible (full suite green). Bundles AWM's new `postgres` adapter (pg + pgvector) —
  the store of choice for Azure / Railway / any multi-replica deploy (avoids SQLite-on-network-FS
  locking; multi-connection safe). Verified end-to-end against `pgvector/pgvector:pg16`.
- **Tailscale in setup** — onboarding/Connections accepts a Tailscale **auth key** (`tskey-auth-…`);
  `docker-entrypoint.sh` brings up userspace networking at boot so a cloud deploy is reachable at
  its tailnet name with **no public port** (`MWA_ACCESS_PASSWORD` as a second factor). Works on
  Railway + Azure Container Apps.
- **CSRF hardening (security)** — `/api/save` and `/api/connections` now require a same-origin
  request (they write secrets: API keys, the Tailscale key, bot tokens). A malicious page can no
  longer swap your model API key or join your instance to an attacker's tailnet. `upsertEnv` also
  strips CR/LF from values (no `.env` line injection). Same-origin SPA + Tauri + CLI are unaffected.
- **Portable memory** — bundles AWM's backend-agnostic `awm import`/`export`, so you can move your
  memory between an embedded file and a Postgres server (embeddings included — no re-embed).

## 0.4.0 (2026-06-29) — the memory substrate: provenance, trust, transparency, governance, honesty, namespaces, routines

A ground-up redesign that turns AWM from storage the agent *recalls from* into the substrate it
*thinks with*. Every memory + action now carries **provenance** (where it came from), a **trust
tier** (stamped out-of-band so content can't elevate itself), a **topic namespace**, and an
**action record** — and six capabilities sit on that spine. See
[docs/the-memory-substrate.md](docs/the-memory-substrate.md) for the why.

- **Spine — provenance + trust + namespace + action log on every engram.** `MwaMemory.write()`
  stamps `src=`/`trust=` from a typed provenance (`user|inferred|ingested|tool`) and **strips** any
  caller/model-supplied `trust=`/`src=`/`ns=`/`origin=` so untrusted content can't self-elevate;
  `trustOf()` fails closed to `untrusted`. New `logAction()` / `forget()`.
- **F1 · Glass Box.** `/api/memories` carries provenance/trust per fact; new `/api/actions`,
  `/api/memory/export` (Markdown), `/api/memory/forget`, `/api/memory/correct`. The Memory view shows
  provenance/trust badges + correct / forget / export. `correctFact()` is deterministic and rolls
  back on failure (no data loss).
- **F2 · Provenance-weighted trust + injection safety.** Untrusted recalled facts are flagged
  `⚠UNTRUSTED` and walled off as data-never-instructions; a `TRUST BOUNDARY` rule forbids acting on
  them; email-mined facts and untrusted-read-derived `remember` writes inherit untrusted lineage.
  **CSRF** protection + forged-id rejection on the state-changing memory endpoints.
- **F3 · Governance (Explain · Approve · Undo).** Plain-language "what I did" report at run end;
  semantic action classification; a trajectory **tripwire that hard-halts unattended runs** before
  they exceed an outward-action limit.
- **F4 · Honest agent.** Answers are calibrated from the trust tier (sure / likely / unsure) and
  hedge + offer to verify on weak or untrusted grounding instead of asserting it as fact; proven
  recency guard.
- **F5 · Soft namespaces.** Topic-scoped recall with a no-bleed guarantee + a global carve-out for
  policies/skills; instance `setNamespace()`. Live chat scoping is opt-in (`MWA_TOPIC_NAMESPACE=1`).
- **F6 · Earned determinism.** Repeated successful approaches can be saved as versioned,
  injection-scanned, propose-not-commit routines. Auto-proposal is opt-in (`MWA_AUTO_ROUTINES=1`).
- **Clean upgrade path.** `scripts/retrofit-memory.ts` idempotently backfills provenance/trust onto
  memories written before the spine (evidence-based: email-mined stays untrusted, your policies →
  trusted, the rest → the agent's medium-trust knowledge) — an existing install upgrades with **zero
  knowledge loss**.
- 47 new tests; `npm run eval:design` end-to-end conformance check; the memory gauntlet confirms
  recall quality is unregressed by the redesign.

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
