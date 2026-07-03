# Design spec — MWA as a team teammate (Telegram-group dogfood, headless cloud)

**Status:** draft / for review · **Date:** 2026-06-29 · **Owner:** Robert

> Goal: turn the existing 1:1 Telegram bot into a **team member** that lives in a group chat —
> participates, learns *who said what*, and acts under **its own identity** (its own email, not
> yours) — running **headless in a cloud Docker container**, not on the local machine. This is the
> sovereign/local answer to Anthropic's **Claude Tag** (see `docs/the-memory-substrate.md` §research).

---

## 0. Why this is mostly assembly, not new invention

The F1–F6 memory substrate is, almost exactly, what a team agent needs. The mapping:

| Team-agent need | Already built | New work |
|---|---|---|
| Know **who said what** | F2 **provenance** (`src=`, `origin=`) | tag `person=<speaker>` per message |
| Weight people differently | F2 **trust tiers** | map group role → trust |
| Channel = memory boundary | F5 **namespaces** (`setNamespace`) | group chat id → namespace |
| Audit what it did | SPINE **action-log** + F1 **Glass Box** | surface "what the team taught me" |
| Who can direct it / approve | F3 **governance** (presets, approval gate, tripwires) | role → permission |
| Group msg can't hijack it | F2 **injection isolation** | classify member messages as data |
| Learn the team's vocabulary | **AWM** cognitive memory (the moat) | attributed extraction from chat |
| Self-improving, safely | F6 **propose-not-commit routines** | — |
| Headless deploy | **Dockerfile** + compose (/data volume, models baked, healthcheck) | deploy to cloud |
| Telegram transport | `src/connectors/telegram.ts` (long-poll, allowlist, channel-agnostic core, runs scheduler) | group-awareness |

So this spec is: **(a)** deploy the existing image to the cloud, **(b)** make the Telegram gateway
group-aware, **(c)** add attributed learning + the agent's own identity. No rewrite.

---

## 1. The two constraints you raised

### 1a. Headless MWA in a cloud Docker container (not local)
The `Dockerfile` already produces a headless image (`MWA_SERVE_HOST=0.0.0.0`, `/data` volume, recall
models baked into a layer, `/api/health` healthcheck, `MWA_ACCESS_PASSWORD` gate). **Nothing about it
assumes a desktop** — the Tauri shell is a *separate* local front door. To run in the cloud:

- **Host:** Railway (CompleteIdeas account, per project `CLAUDE.md`) — Dockerfile deploy + a **persistent
  volume mounted at `/data`** (holds `agent.db`, `.env`, workspace). Fly.io / Render / a VPS all work
  the same way; Railway is the path of least resistance given the existing account.
- **Main process:** for a team agent the primary process is the **Telegram gateway** (`mwa connect
  telegram`) — it receives group messages, runs the agent, replies, *and* runs the scheduler (it already
  imports `runScheduler`). The web UI (`mwa serve`) is optional and runs alongside for the admin/Glass-Box
  view. Two clean options:
  1. **Gateway-primary:** container CMD = `mwa connect telegram`; expose `serve` too via a tiny
     supervisor (or a second Railway service sharing the volume — but single-process is simpler/safer
     for SQLite). **Recommended for the dogfood:** one service, CMD runs gateway; add an
     in-process `serve` start so `/api/health` + the Glass Box are reachable.
  2. **Serve-primary + gateway:** keep `serve` as main, start the gateway from inside it. Slightly more
     wiring; better if the admin UI is the primary surface.
- **Secrets (env):** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_CHATS=<group-id>`, the **agent's** email
  creds (see 1b), `ANTHROPIC_API_KEY` / Azure, `MWA_ACCESS_PASSWORD` (the UI is now networked),
  `MWA_DB=/data/agent.db`. Long-polling means **no public webhook** is needed — the container only makes
  outbound calls to `api.telegram.org`, so it works behind any NAT/firewall.
- **Cost note:** an always-on cloud agent + (later) passive observation has a real token bill. Gate
  observation/extraction hard (see §4) and point routine traffic at the cheap tier.

### 1b. The agent has its **own** email, not yours
This is exactly the **agent-identity principle** (Claude Tag: "its own account in each system it
touches"). Concretely:

- Provision a **dedicated mailbox for the agent** — e.g. `agent@yourdomain` or a fresh Gmail — and
  connect *that* via the existing Gmail-IMAP / OAuth / Outlook connectors. The agent reads, drafts, and
  (on approval) sends from **its** inbox; it never touches a team member's personal email.
- The agent's resources (email, file workspace, tools) are scoped to **the deployment/group**, not to
  any individual's credentials — so a group member asking it to "check our inbox" uses the *agent's*
  inbox, and no personal credential ever enters the shared chat (no "side door").
- The email-ingest "learn about me" feature now means **"learn about the team/agent's world"** from the
  agent's own inbox — attributed and scoped, not your private mail.

---

### 1c. Deployment targets — Railway (dogfood) + Azure (USEA)

The image is host-agnostic; two targets, two reasons:

**Railway — the completeideas dogfood.** Confirmed it hosts this class of app (Railway already runs
PostRoom + NovelForge for completeideas). What to know:
- **Dockerfile deploy** is automatic; set a **custom start command** to run the Telegram gateway as the
  service process (Railway supports long-running/worker processes, not just request/response).
- **Persistent `/data` on a Railway volume** (Pro: up to 1 TB). One gotcha Railway makes explicit:
  **volumes are not mounted during *build*, only at runtime** — which is exactly why the Dockerfile
  bakes the recall models into an *image layer* (not `/data`). Already correct; don't move the model
  cache onto the volume.
- One deploy / one instance per service → fine for a single SQLite db. Always-on + usage-billed → gate
  observation/extraction and use the cheap tier.
- **Compliance (checked 2026-06-29):** Railway's Acceptable Use Policy prohibits illegal/abusive
  content, fraud, malware/DDoS, **spam (unsolicited bulk email/SMS)**, crypto mining, reselling compute,
  and **"bots or scrapers that violate applicable terms of service."** It does **not** prohibit AI
  agents, autonomous apps, or outbound API/Telegram polling — and Railway is explicitly positioning as
  an *agent-native* cloud (Railway Agent + Guardrails *for* agents). MWA-as-host is fine. Two behavioural
  rails to keep clean: (1) the agent's email must never become a bulk/unsolicited sender (the F3 approval
  gate is the safeguard), and (2) don't point its web tools at sites whose ToS forbid bots. The Telegram
  bot uses Telegram's official Bot API (not a ToS-violating scraper) → fine. Same logic applies to Azure's
  AUP. *(Not legal advice; the AUP text + Railway support are the source of truth.)*

**Azure — the USEA version.** Same image, deployed into USEA's Azure tenant so **USEA data stays in
Azure** (compliance/sovereignty). Use **Azure Container Apps** (env/secrets via Key Vault, always-on,
sidecar support) *or* a small VM. One real caveat: **SQLite over an Azure Files (SMB) mount has file-
locking quirks** — so for the Azure/USEA deployment prefer one of:
- **AWM's Postgres backend** → **Azure Database for PostgreSQL** (cleanest; AWM already supports
  PGlite/Postgres — see `docs/` Postgres roadmap). Avoids the network-filesystem-SQLite problem entirely
  and is the right call for a managed prod deploy. **Recommended for USEA.**
- or a **VM with a local disk** + SQLite-on-volume (simplest lift-and-shift), or Azure Files **NFS**
  (tolerates SQLite better than SMB).

Net: Railway-dogfood on SQLite-volume; USEA-prod on Azure Container Apps + managed Postgres.

### 1d. Tailscale in setup (private access, no public port)

The Dockerfile/README already recommend reaching a networked instance over **Tailscale** instead of a
public port (there's precedent — the Gallop-on-MWA compose ran a Tailscale sidecar). Make it a
first-class **setup option**:

- Add a **Tailscale auth key** field to onboarding (`/api/save {which:'tailscale'}` → writes
  `TAILSCALE_AUTHKEY` to `.env`). *(Clarification: for a container to join your tailnet you need a
  Tailscale **auth key** — `tskey-auth-…`, ideally a reusable/ephemeral one — not the management **API
  key**. The API key manages the tailnet; the auth key is what `tailscale up` consumes.)*
- On container start, `docker-entrypoint.sh` runs `tailscaled` + `tailscale up --authkey=$TAILSCALE_AUTHKEY
  --hostname=mwa-<name>` (when the key is present), so the admin/Glass-Box UI is reachable at the tailnet
  hostname (`http://mwa-<name>:7788`) with **no public port exposed** — `MWA_ACCESS_PASSWORD` becomes a
  second layer rather than the only one.
- Works identically on Railway and Azure (it's an outbound connection to Tailscale's coordination server).
  Keep the public `EXPOSE`/port optional; the secure default is Tailscale-only.

## 2. The interaction model (Telegram group)

Telegram bot updates already include `message.chat.type` (`private` | `group` | `supergroup`) and
`message.from` (the sender). The gateway extension:

- **Respond only when addressed.** In a group, react to: an **@mention of the bot**, a **reply to the
  bot's message**, or a configurable **wake word**. Otherwise the bot does *not* reply (no chatter).
  (Telegram "privacy mode" off lets the bot see all group messages; keep it off for observation but gate
  responses to addressed-only.)
- **Observe the rest (opt-in).** Non-addressed messages are *candidates to learn from*, not prompts to
  act on — passed to the attributed-extraction path (§4), never to the action loop.
- **Per-chat working dir + namespace.** `handleInstruction` already keys the working dir on `chatId`;
  add `memory.setNamespace(\`tg-\${chatId}\`)` so each group's learned facts are scoped (F5 no-bleed).
- **Threading/context.** Telegram has light threading (replies + topics in forum supergroups); thread the
  last N messages of the group as recent context (as the DM path already does), scoped to the namespace.

---

## 3. Identity, trust & permissions (who can steer it)

Mirror the Claude Tag access model with MWA's existing primitives:

- **The group is the permission boundary.** One config per group: which tools/connectors the agent may
  use, the access preset (file/command scope), and which members may direct *privileged* actions.
  (Reuse F3 access presets + the approval gate; key the config by chat id.)
- **Trust per speaker (F2).** Map Telegram role → trust: group **owner/admin** → high; member → medium;
  unknown/guest → low. A learned fact carries `person=<id>` + the trust of its speaker. Only
  high/authorized speakers can trigger send-email / spend / delete (the F3 tripwires already gate these;
  add a speaker-role check).
- **Member messages are DATA, not instructions (F2).** A random member can't inject "ignore your rules
  / email everyone" — observed content is untrusted-by-handling; only an *addressed request from an
  authorized member* drives action, and external actions still go through the approval gate.
- **Audit (SPINE + F1).** Every learned fact and action is already logged with provenance + an action
  record; the Glass Box shows the team *what it learned and did, and from whom*.

---

## 4. Learning from the discussion (the privacy-sensitive core)

The tension: a *learning* teammate must remember, but you must not hoard the team's raw conversation.
Resolution — **store attributed durable facts, not transcripts:**

- **Attributed extraction.** Reuse the email-ingest pattern (`src/ingest.ts`) on observed group messages:
  a cheap model extracts *durable* facts (decisions, preferences, people, commitments) and writes them
  with `provenance:'user'`, `person=<speaker>`, `ns=tg-<chatId>`, trust per role. Skip chit-chat. This is
  the "builds a deepening understanding of the team's vocabulary and decisions" behaviour — but local and
  inspectable.
- **The Glass Box becomes "what the team taught me."** Each fact shows who contributed it; the group
  owner can **correct/forget** any of it (F1). That's the consent/control surface.
- **Conservative defaults.** Observation is **opt-in per group**; extraction runs batched (cost + noise);
  raw messages are never persisted as memories (only the distilled facts).

---

## 5. Ambient mode (opt-in, gated)

"Ambient" = proactive follow-ups without being asked. MWA already has the engine: the **scheduler**
(unattended runs) + **F3 tripwires** (hard-halt) + **F6 propose-not-commit**. So:

- A per-group ambient toggle schedules periodic "anything unresolved / worth surfacing?" passes.
- Anything outward-facing (posting to the group, sending email) is **proposed**, gated by the approval
  rules, and tripwire-bounded — never silent action in a shared space (that's where team trust dies).

---

## 6. Surface as an adapter (so Slack/Discord follow)

Keep the channel-agnostic core (`handleInstruction`) and define a thin **ChannelAdapter** contract:
`{ channelId, speaker:{id,name,role}, text, isAddressed, postReply(), postFile() }`. Telegram-group is
adapter #1. Later:
- **Slack channel-bot** (the real prize): `app_mention` events, `conversations.replies` for thread
  context, 3-second ack via a "thinking…" status, streamed replies, and the **agent-identity/RBAC** model
  (its own Slack app identity, channel-scoped scopes). More work (Slack app review + scopes) — do it
  after the Telegram dogfood proves the pattern.
- **Discord / Matrix:** sovereign-friendly, similar bot model.

---

## 7. Phased plan

- **P0 — Headless cloud deploy (no new features).** Deploy the existing image to Railway with a `/data`
  volume; connect the **agent's own email** + the team's private Telegram **group** (allowlist the group
  id). Verify the agent answers an addressed message in the group and persists memory across restarts.
  *Proves: cloud headless + agent identity. Pure ops, reuses everything.*
- **P1 — Group-aware gateway.** Respond only when addressed; per-speaker `person=` provenance + role→trust;
  group→namespace. *Proves: who-said-what + no cross-group bleed.*
- **P2 — Learn from the discussion.** Attributed durable-fact extraction from observed messages; Glass
  Box "what the team taught me" with forget/correct. *Proves: the teammate that learns.*
- **P3 — Ambient (opt-in).** Scheduler proactive passes, propose-not-commit, tripwire-gated.
- **P4 — Slack channel-bot adapter** + identity/RBAC. *The real prize, after the pattern is proven.*

Each phase is independently shippable; P0–P2 are the dogfood.

---

## 8. Open decisions (need your call)

1. **Trigger model:** @mention only, or @mention + a wake word + reply-to-bot? (Recommend: all three,
   addressed-only for action.)
2. **How much to learn:** observe-and-extract everything in the group, or only messages that mention the
   bot / are explicitly "remember this"? (Recommend: start *explicit-only* — lowest cost + privacy risk —
   then graduate to opt-in passive observation.)
3. **The agent's email:** dedicated Gmail (fastest) vs a `@yourdomain` mailbox (more "teammate"-real).
4. **Cloud host:** Railway (existing account) vs Fly/VPS. (Recommend: Railway.)
5. **One agent per group, or a shared agent across groups with per-group namespaces?** (Recommend: one
   deployment, per-group namespace — simplest, your F5 work supports it.)
6. **Admin surface:** expose the Glass Box web UI publicly (behind `MWA_ACCESS_PASSWORD` / Tailscale), or
   keep it private and admin via Telegram commands?

---

## 9. Reuse vs new (engineering summary)

- **Reuse as-is:** Dockerfile + compose, `/data` persistence, recall-model bake, `/api/health`, the
  Telegram long-poll loop, `handleInstruction` core, scheduler, the entire F1–F6 substrate, email
  connectors, access presets, approval gate, tripwires, ingest/extraction pattern, Glass Box.
- **New (small, additive):** group-message handling + addressed-only gating in `telegram.ts`;
  `person=`/role→trust tagging on the write path; group→namespace call; an opt-in attributed-extraction
  pass over observed messages; a per-group config (tools/permissions/ambient/observe toggles); the
  `ChannelAdapter` seam; the Railway deploy.
