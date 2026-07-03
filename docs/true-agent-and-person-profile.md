# MWA as a true autonomous agent — and the Person-Profile gap

**Status:** design (2026-07-01). Grounds MWA against three agent frameworks and specifies the one
missing dimension: **per-person Profile** ("handle a conversation with a specific person differently,
because different people have different needs" — Robert).

---

## 1. The frozen-model position (which learning layers MWA uses)

Across the four canonical *learning layers*, MWA deliberately operates on layers 2–4 and **never
touches layer 1**. This is the cost thesis, not an omission: frontier-like behavior from a frozen,
cheap model (`azure:gpt-5-4-mini`) by learning in the harness + memory, not the weights.

| Layer | Mechanism | MWA |
|---|---|---|
| 1. Model (fine-tune / RLHF / DPO / pre-train) | change the weights | **Intentionally NOT used.** Model stays frozen; learning lives above it. |
| 2. Harness & Skill (SkillOpt, tool expansion, prompt-gating) | change the software around the model | **Yes** — `saveSkill`/`listSkills` self-improving procedures (`src/awm.ts`); MCP self-install/tool expansion (`src/tools/`); domain-pack progressive disclosure (P1.3) + tier router (`src/model-router.ts`) + `classifyContinuity` (`src/serve.ts`) as prompt-gating/routing. |
| 3. Context & Memory (decision traces, RAG, dynamic few-shot) | change what's in the prompt | **Yes** — AWM. Action-log + provenance = context→action→outcome traces; recall = RAG; auto-prime = dynamic few-shot. |
| 4. Self-learning loop (Critic, self-reflection) | close the loop on outcomes | **Yes** — substance/validation gate + verify-before-done = Critic; Reflexion friction memory = self-reflection; `feedback()` = Hebbian learn. |

**Takeaway:** MWA is already a *learning agent* (the top of the reflex→model→goal→utility→learning
ladder) on the layers it targets. Nothing here needs a rebuild.

## 2. Profile · Memory · Planning · Action — where MWA stands

| Component | Framework definition | MWA today | Status |
|---|---|---|---|
| **Profile** | the agent's identity / persona / social context; enables personalized interaction | `Profile(self)` = the AGENT.md **domain pack** (P1.3). **No `Profile(interlocutor)`** — no notion of *who it's talking to*. | ⚠️ **half** |
| **Memory** | store/retrieve past interactions; read/write/reflect | AWM: recall, write, supersede, consolidate, friction, skills, provenance, soft namespaces (F5). | ✅ strong |
| **Planning** | strategize; predefined or feedback-adaptive | plan-and-execute + iterative reflect; ReAct Think-Act-Observe. | ✅ |
| **Action** | execute via tools; adapt internal state on results | tool registry + MCP; approval gate (`requireApproval()`); validation gate. | ✅ |

**The gap is `Profile(interlocutor)`** — and it is exactly the personalization the learning-layer
table also lacks: layers 2–4 currently learn into **one global agent identity**, not per-person.

## 3. The Person-Profile layer (the design)

Not a new store and not a new component bolted on — a **personalization axis** that scopes the
existing layer-2/3/4 loops by *who is being talked to*. Rides entirely on primitives MWA already has
(AWM entity tags + `person=` namespace, policies, auto-prime, auto-learn, provenance).

### 3.1 Identity resolution (who am I talking to)
Each turn resolves a stable `personId` from the channel:
- Telegram → chat id (already allowlisted per user)
- Email → sender address
- Web serve → the session's stated/known name, else `unknown` (shared profile)

Deterministic, cheap, connector-supplied. Falls back to a shared `unknown` profile — never blocks.

### 3.2 Per-person scope (layer 3)
Person-scoped memories are tagged `person=<id>` and recalled with AWM's entity-bridge boost + a
`person=` namespace, so recall pulls **that person's** preferences, style, and past threads —
**isolated from other people by default** (the privacy boundary). *Task* knowledge stays shared;
only the *profile + interaction history* is person-scoped.

### 3.3 Prime the profile (layer 2)
Before the model turn, inject a compact **"who I'm talking to"** block into the system prompt:
communication style, expertise level, recurring needs, standing do's/don'ts for *this* person. The
agent then adapts **tone / depth / format** — not facts, not safety.

### 3.4 Learn & update the profile (layer 4)
After the turn, a focused learn call updates the person model (they preferred bullets; non-technical;
cares about entries), **supersede-on-change** so it stays current. This is the Critic scoped per
person: what does *this* person count as a good outcome.

### 3.5 Invariants (non-negotiable)
- **Adaptation is style/verbosity/format only** — never facts, never the approval/validation/safety gates. Those are identical for everyone.
- **Profiles are private per person** by default (one person's model never bleeds into another's).
- **Data residency respected** — person profiles inherit the deployment's store (e.g. USEA PII stays in USEA's tenant).
- **Fail open to the shared profile** — unknown identity degrades to generic behavior, never an error.

## 4. Build slices

1. **S1 — identity + person-scoped write/recall.** ✅ DONE — `resolvePersonId` + `person=`-tagged `rememberAboutPerson`/`recallPersonProfile` in `MwaMemory`, hard-isolated per person. `scripts/_person-scope.ts` 14/14.
2. **S2 — prime.** ✅ DONE — `buildPersonPrimer` → compact "who I'm talking to" block injected into every user-facing system prompt (`personContext` on `runAgent`), wired in `serve.ts` behind `MWA_PERSON_PROFILE`. `scripts/_person-prime.ts` 10/10.
3. **S3 — learn trigger + compressed dossier.** ✅ DONE — `src/person-learn.ts`: `learnAboutPerson` (focused extract → dedupe vs known → person-scoped write, wired in `serve.ts` after each turn behind `MWA_PERSON_LEARN`) + `compressPersonDossier` (a self-recompressing **materialized view** over the atomic notes — the reactive-derived-view idea borrowed from Convex; recompresses at `MWA_DOSSIER_CAP`, supersedes prior, becomes the primed body). `scripts/_person-learn.ts` 10/10.
4. **S4 — surface.** ⏭ REMAINING. Show/edit the dossier + intake status in the serve Memory view (Glass-Box transparency).
5. **S5 — intake schema (universal high-value fields).** ✅ DONE — `src/person-intake.ts`: `INTAKE_FIELDS` (name / contact / role / style), `intakeStatus`/`nextIntakeField`/`intakeHint`. Answers are `field=`-tagged notes (exact status, not keyword-guessed); the learn extractor tags them; a single gentle "only if it comes up naturally" hint joins the prime. `scripts/_person-intake-identity.ts`.
6. **S6 — identity confidence (anti-impersonation).** ✅ DONE — `src/person-identity.ts`: `assessIdentity` compares a message's self-claims (name/contact) against stored anchors → `ok`/`new-claim`/`mismatch`; on `mismatch` an `identityGuidance` block is prepended (unverified → no sensitive action, don't reveal stored details, confirm first) and **learning is suppressed** so a suspected impersonator can't rewrite the dossier. Deterministic core; a fuzzy behavioral-style model pass is the documented next step. `scripts/_person-intake-identity.ts` + the end-to-end `scripts/_person-sim.ts`.

**Hardening note (S6):** the redaction is now IMPLEMENTED — `composePersonContext` (person-turn.ts) returns the guard ONLY on a mismatch, never the dossier/PII.

**S6 v2 — step-up verification (2nd factor via a validated connection).** ✅ DONE. When identity is in doubt, a sensitive/irreversible action must be confirmed by a SECOND FACTOR **out-of-band** — never on the suspect channel alone. `person-identity.ts`: `hasVerifiedFactor` (is there a `field=verified-contact` — a channel the person proved they own?) + `stepUpGuidance` (on mismatch: if a validated connection exists → require out-of-band confirmation through it; else → block sensitive actions + offer to establish one). **Critically it never names the validated connection** (naming it would leak the real person's contact to a possible impersonator). `preparePersonTurn(…, {channelVerified})` records the current channel as a validated connection on authenticated channels; the **Telegram** connector passes `channelVerified: true` (its chatId is Telegram-authenticated). `scripts/_person-intake-identity.ts` (incl. the no-leak check). NEXT (integration, not built): actually SENDING the out-of-band challenge (code to the verified email/Telegram) + challenge-state — needs live connector send.

### Audit (2026-07-01, /full-audit — security + correctness subagents)
Fixed: **prompt-injection via person name** (`buildPersonPrimer` now strips CR/LF+control chars from the display name before the header line); **two unchecked `rememberAboutPerson` returns** in person-learn.ts (learn loop no longer marks a failed write as "seen"/learned; dossier compression reports `compressed:false` if the fresh write fails). No new deps → the 3 `npm audit` highs (nodemailer/imapflow/mailparser) are pre-existing email-connector-chain issues, unrelated.

**Accepted / known limitations (not code-fixed):**
- **`/api/people` PII** is behind the same global auth gate as every other `/api/` route — password-gated when `MWA_ACCESS_PASSWORD` is set (all deployed instances), open only on localhost single-user. Consistent with `/api/memories` etc.
- **personId collision on self-asserted web names** — `resolvePersonId({channel:'web', name})` trusts a client-supplied name, and normalization can collide (`"a b"` ≡ `"a_b"`). The web `person` param is *unauthenticated self-assertion* by nature; **authenticated channels (Telegram `chatId`) bind identity and don't collide**. Real identity binding for the web path needs the hosted-tier auth layer (M2). S6 is a heuristic backstop, not authentication.
- **`assessIdentity` subset-name match** returns `ok` when a claim is a subset of the stored name (`"Alice"` vs `"Alice Margaret Smith"`) — **by design**, so a person using their first name / a nickname isn't false-flagged; only a *contradicting* name/contact fires `mismatch`.

Each slice ships behind a flag, with a DI-spy test (same pattern as the scheduler change-gate) proving
the behavior with no model/network. `/full-audit` PASS gate before merge. Nothing published until go.

### Note — external building blocks evaluated
- **Convex** (2026-07-01, Robert asked): reactive hosted/self-hostable TS backend (reactive DB, real-time query subscriptions, scheduled/cron functions, file storage, pluggable auth, vector + full-text search, durable "Agent" workflows). **Not for the core** — adopting its DB would sever MWA's in-process AWM substrate (the moat), the same reason the Hermes path was rejected. **Candidate only for the deferred hosted multi-user tier (M2)** as the app-backend layer *around* AWM: its per-user auth context + reactive sync map well to multi-tenant person-profiles (S1/S6) and its reactive queries could replace the serve UI's hand-rolled SSE. Revisit if/when the hosted tier is built; not a fit for the local-first product.

## 5. Verification (the Mom-test-style bar)
Two people talk to the same MWA in one session. It answers the non-technical person in plain, short
language and the power user tersely-technical; each one's stated preference is remembered and applied
next time; neither sees the other's profile; the approval/validation gates fire identically for both.
