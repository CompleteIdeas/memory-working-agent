# AWM + MWA Deep-Dive Gap Analysis (2026-07-02)

Method: five parallel review agents read the real code across AWM (cognitive core, storage/ops) and
MWA (agent runtime, safety/surfaces, coverage/seam). Findings below are deduplicated and tagged
**CONFIRMED** (verified against the code in this pass) or **PLAUSIBLE** (agent-reported, credible,
not yet independently verified). Nothing was changed — this is analysis only.

> Caveat on the AWM cognitive-core section: one agent flagged several recall features as "default-OFF."
> Some of those flags were shipped-on in later releases (query-bridge, rerank-pool widening). Those
> specific claims are marked **VERIFY-CONFIG** and must be checked against the shipped defaults before
> being treated as real.

---

## TIER 1 — Quick, high-value, mostly this session's code (fix first)

1. **Auto-learn trust-laundering** — CONFIRMED — `src/agent.ts:880`. The harness-owned auto-learn writes "facts about the user's world" as `canonical` with **no `provenance`** → defaults to `inferred`/medium trust, even when the run read untrusted inbox/web content (`sawUntrustedRead`). The model-elective `remember` handler *does* taint (agent.ts:708) — auto-learn is the leak. This is the exact F2 prompt-injection-persistence vector. **Fix:** pass `provenance: sawUntrustedRead ? 'ingested' : 'inferred'` (one arg); also skip the learn suite when `reason==='paused'`.
2. **CSRF gaps on the HTTP surface** — CONFIRMED — `src/serve.ts`. `/api/chat` (947, the agent-exec SSE) and `/api/approvals/confirm` (620), plus `/api/approvals/cancel`, `/api/questions`, `/api/stepup/*`, `/api/open` do **not** call `sameOriginOk` (which 538/549/724/827 do). A page the user visits can drive the agent / confirm writes on the no-password localhost default. **Fix:** add `sameOriginOk` to these; for `/api/chat` require `Sec-Fetch-Site: same-origin` (GET/EventSource). Add a **Host allowlist** to defeat DNS-rebinding (which otherwise bypasses all same-origin checks).
3. **Confirm path defeats the step-up + approval gate** — CONFIRMED — `src/serve.ts:620`. `confirmPending(..., {sandboxDir: resolve('.'), interactive:true})` omits `personId`/`identityInDoubt`, so the S6 step-up gate is a **no-op via the UI**; and `sandboxDir` is the server CWD, not the session workspace the preview was generated in. **Fix:** thread `personId`/`identityInDoubt` and the correct session sandbox into the UI confirm path.
4. **Scheduler `check` runs raw `exec`, unattended, ungated** — CONFIRMED (by construction) — `src/scheduler.ts`. The change-gate's `check` is model/injection-controlled, base64-stored, then shell-executed on every tick — **bypassing the `run_command` access preset** and running with no human present. **Fix:** route `check` through the preset-gated `runCommand` + injection-scan it before persisting, or restrict to a non-shell allowlist.
5. **AWM↔MWA version pin is broken** — CONFIRMED — `package.json:67` `^0.9.1` vs vendored `0.10.0` (submodule pinned to untagged `v0.9.0-1-gec660a7`). `^0.9.1` excludes 0.10.0 → `npm i memory-working-agent` from the registry can't resolve the deep imports MWA uses. **Fix:** correct the pin, tag the submodule commit, reconcile `docs/deployment.md`.
6. **Test the security-critical surfaces + run the proof scripts in CI** — CONFIRMED — `serve.ts` (auth gate + every endpoint), the person-model (incl. the `person=` privacy isolation invariant), `step-up.ts`, and `runPlanned` have **no vitest**; the 40+ `scripts/_*.ts` proofs run **nowhere automatically** (CI runs only `npm test`). **Fix:** promote the highest-value proofs (person isolation, step-up, io-roundtrip, postgres) into `tests/` and add a serve auth/endpoint test.

## TIER 2 — Structural correctness (AWM storage + write pipeline)

7. **`awm merge` silently destroys data** — ✅ FIXED (2026-07-02) — merge now initializes the target via `EngramStore` (authoritative schema + FTS triggers) and routes every source engram through `createEngram` (+ stage/retracted restore + supersession pass), so embeddings, `memory_class`, task/supersession fields, and BM25 all survive. Proof `scripts/_merge-fidelity.ts` (5/5), CI-run.
8. **`awm import` resurrects retracted memories + flattens stages** — ✅ FIXED (2026-07-02) — import restores `stage` (`updateStage`) + `retracted` (`retractEngram`) after create. Proof `scripts/_import-stage-retract.ts` (4/4), CI-run.
9. **`withTransaction` has no isolation on SQLite + PGlite** — CONFIRMED, NOT FIXED (subsystem work) — `sqlite.ts:1630`, `pglite.ts:229`. Raw `BEGIN…await…COMMIT` on the shared connection captures unrelated concurrent writes. In MWA's in-process single-connection usage this is largely latent; fixing it properly (dedicated-client / write-serialization) is a storage-layer change deserving its own task, not a drive-by. Verified on Postgres (already correct via AsyncLocalStorage).
10. **Hive/workspace recall silently single-agent on PG/PGlite** — CONFIRMED; silent-degradation MITIGATED (2026-07-02); full support = subsystem port. The whole coordination layer is SQLite-coupled (`initCoordinationTables(db: better-sqlite3)`, SQLite DDL, registration via the raw handle), so Postgres/PGlite can't register OR read hive members — creating `coord_agents` alone wouldn't help. **Done:** `getWorkspaceAgentIds` on Postgres+PGlite now emits a ONE-TIME warning and returns self-only (verified live) so it degrades VISIBLY, not silently. **Remaining (own task):** port the coordination subsystem to be backend-agnostic.
11. **Backend behavioral divergence** — CONFIRMED, NOT FIXED (parity/tuning task) — `timeWarp` (relative+assocs on SQLite vs absolute-collapse, no-assocs on PG/PGlite; mostly test-infra), vector search (exact vs approximate ivfflat → fewer/different results — an index-strategy tuning exercise), dim-mismatch (silent on SQLite, hard-abort mid-import on PG). Real divergences, but each is parity/tuning work rather than a contained bug; scope as a backend-parity hardening task before Postgres is trusted for prod recall.
12. **Write-pipeline correctness holes** — H1 ✅ FIXED (2026-07-02): `computeNoveltyWithMatch` now prefers an exact same-concept recent match as `matchedEngramId`, so a channel disagreement (cosine top ≠ the concept-duplicate) reinforces the existing engram instead of creating a duplicate. Proof `scripts/_novelty-exact-concept.ts` (3/3), CI-run; AWM's own suite 568/569 (no hot-path regression). — H2 (same-concept *contradicting* write merges instead of supersedes) is a **DESIGN LIMITATION, not fixed**: the substrate has no semantic-contradiction detection; corrections must be tagged `surprise`/`friction` to supersede. Adding auto-contradiction-detection is a feature, out of scope for a bug fix.

## TIER 3 — Scaling, memory-quality, and hardening

13. **Consolidation is O(N²) memory/CPU with no cap** — PLAUSIBLE — `consolidation.ts:790`. Full n×n cosine matrix over all active engrams (~1 GB at 11K); likely OOM at scale, and a crash stops edge discovery too. **Fix:** cap cluster input / block-wise / ANN clustering.
14. **Default multi-hop recall is inert** — PLAUSIBLE + **VERIFY-CONFIG** — `activation.ts:1116` graph walk only re-weights in-pool candidates; bridged facts the lexical/vector channels missed never enter. Whether this is truly default depends on which of `AWM_SPREAD/AWM_ENTITY_FETCH/AWM_QUERY_BRIDGE` ship on. **Verify against shipped defaults first.**
15. **Confidence inflation on every recall** — PLAUSIBLE — `sqlite.ts:663` `touchEngram` bumps confidence+accessCount on each returned result, ungated by usefulness → distractors entrench (slower decay, stronger forgetting-protection). Contradicts the "validation-gated Hebbian" design. **Fix:** gate the bump on feedback, not mere retrieval.
16. **Content fade is irreversible + desyncs embedding** — PLAUSIBLE — `consolidation.ts:538` overwrites content with a stub but never re-embeds, so vector search still matches the old text and returns a stub; fires after one access + 45d idle. **Fix:** archive (recoverable) instead of destructive fade, or re-embed the stub.
17. **Superseded engrams stay active in the pool** — PLAUSIBLE — `sqlite.ts:996` sets links but not `stage`; a stale fact can still surface when its successor isn't co-retrieved. **Fix:** move superseded engrams out of the active recall set.
18. **Cost cap not enforced in wrap-up or `runPlanned`** — PLAUSIBLE — `agent.ts`: `maxTokens` is checked only at the direct-loop top; the ~7 wrap-up calls and the entire planned path (which doesn't pass `maxTokens` to sub-runs) ignore it; mailbox/cli set no cap at all. **Fix:** thread + check the token budget through wrap-up and planned sub-runs.
19. **Multi-provider tool-call drift** — PLAUSIBLE — only the first tool call is used (2..N silently dropped); malformed args → `{}` → a garbled `done` from a local model ends the task with an empty completion. **Fix:** handle multiple tool_use blocks; reject arg-less `done` from non-native parses.
20. **Substance gate fails open on multi-tool runs** — PLAUSIBLE — `substance.ts:42`: any incidental `read`/`web_search` counts as "acting," so the fabrication check only fires on zero-tool runs. **Fix:** distinguish read-only tools from state-changing ones in the gate.
21. **SSRF + auth hardening** — PLAUSIBLE — `http_request`/`read_document` have no loopback/link-local/metadata/RFC1918 block or redirect cap; `/api/login` has no brute-force throttle and tokens never prune. **Fix:** egress allowlist + redirect cap; login rate-limit + token TTL.
22. **The approval gate covers almost nothing** — PLAUSIBLE — `requireApproval` wraps only 2 tools (knowledge write, add_mcp_server); `run_command`/`write_file`/`http_request`/`draft_email`/MCP tools are unwrapped. The "hard gate" (and the step-up inside it) doesn't cover the tools that actually mutate/reach out. **Fix:** wrap the state-changing/external tools, especially any prod-DB tool before the USEA cutover.

## Silent-failure + operability notes
- **Total memory failure looks healthy** — every AWM op catches→`null`/`[]`/`console.error`; persistent write failure degrades the whole value prop to nothing while every surface reports success. Add a health signal.
- **Env-var sprawl** — ~45 `MWA_*` flags, ~2 documented in `.env.example` (incl. undocumented `MWA_ALLOW_UNATTENDED_WRITES`, approval TTLs). Document the security-relevant ones.
- **Seam fragility** — MWA imports AWM's private `dist/**` internals (no stability contract) + reaches a raw better-sqlite3 handle; an AWM dist refactor breaks MWA at runtime with no compile signal.
- **`pg` global type-parser mutation** (`postgres.ts:49`) contaminates any other `pg` user in-process.
- **Docker runs `tsx src/` while the bin/desktop run `node dist/`** — two code paths; a tsc-only breakage can pass one and fail the other.

## What's solid (don't re-litigate)
Auth gate (when enabled) covers all `/api/`; constant-time password/token compare; MCP children get a minimal env (no keychain); email is draft-only; file tools are path-confined; approval + step-up codes are single-use/TTL/attempt-capped; scheduler reschedules-before-run and fails-open by design.

## Recommended order
Tier 1 (1–6) first — small, high-leverage, and several are this session's own code. Then Tier 2 (AWM
data-movement + backend parity) before Postgres/merge/import are trusted in production. Tier 3 as
hardening + scaling ahead of any public/multi-user launch. Verify #14 config before acting on it.
