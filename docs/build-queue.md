# MWA build queue

The durable state of the MWA build loop. **This file is the source of truth**; the AWM resume
pointer (topic `mwa-build-loop`) only says where to start. If they disagree, this file wins.

Branch: `build-loop`, stacked on `docker-autonomy-2026-10-14`. One commit per item. Pushed, never
merged or published by the loop.

## Rules

**Authority.**

- The loop decides forks inside the plan itself, through the Decision Process with an
  `/ask-coworker` challenge. That covers calls 3, 4 and 5 of the 2026-10-14 decision review.
- Robert's answers override the coworker. Each tick re-reads the decision review doc for changes;
  if Robert answered a call differently, the affected item is re-opened.
- **Never done by the loop:**
  - merging to master, publishing to npm, redeploying any hosted instance (call 1 — public and
    hard to reverse);
  - turning on Developer mode anywhere;
  - publishing artifacts or docs (they land in the wrong account).

**Gates — every item.**

- `tsc --noEmit` for the server and for `web/`.
- `npx vitest run --exclude 'vendor/**'`, all green.
- `npm audit --omit=dev`: no new high or critical.
- The full suite again in a clean worktree at the **pinned** AWM submodule. The working tree runs a
  newer local AWM, so only the clean run proves the committed tree.
- Audit: one fresh-context reviewer per item covers all six `/full-audit` domains (JS, CSS, HTML,
  security, code quality, UI), given only the requirement and the diff. The full six-way audit runs
  at every cluster boundary (after BL-04, BL-08, BL-12).
  *Decision, recorded so it is not mistaken for a skipped gate: six parallel auditors on every
  small item costs more than it finds; one isolated reviewer per item plus a full sweep per cluster
  keeps the gate.*
- Items touching the agent loop, tools, scheduler or prompt also get: an image rebuild and
  `scripts/e2e-scheduled.mjs` (6 trials) — a hit means the file exists with the right content.
  Baseline to hold: **8/8 and 6/6 delivered** (2026-10-14).

**Delivery convergence.** At most **5 unmerged items** on the branch. At the cap, the next tick
writes a ready-to-merge summary for Robert and stops building.

**Cost cap.** **$10** of model spend (Azure e2e runs + coworker calls) for the loop, tracked
below. Stop and report at the cap.

**Stop when:** an item BLOCKs with nothing else ready; the stack cap or the cost cap is reached;
two consecutive items REVISE; or Robert says stop.

**Hygiene.**

- Stage explicit paths per item — never `git add -A` (the directory holds `data/`,
  `mwa-workspace/` and scratch files).
- Nothing from `../_reference/` enters the repo; describe work in our own words.
- Never touch `vendor/agent-working-memory` from the loop.

## Tick protocol

1. Recall the AWM resume pointer, then read this file.
2. Read the decision review doc's changes since the last bookmark. Apply any answer from Robert.
3. If an item is `in progress`, resume it. Otherwise take the first `ready` item.
4. Deliver it through `/first-class-delivery`: ground → orient → build → verify → challenge →
   close.
5. Update this file: status, commit, gate evidence and date. Commit it with the item.
6. Push the branch. Supersede the AWM resume pointer, and check the write came back active.
7. Report in chat in the short PASS / REVISE / BLOCK form.

## Queue

**Next up:** BL-02 (job contract + run outcome; also replace the coding-era `done` description the general agent inherits). Then BL-03, BL-15.

Status: `ready` · `in progress` · `blocked` · `done` · `revise`.
"Waits on" names an item or a person.

| ID | Item | Why | Waits on | Status | Commit | Gates (date) |
|---|---|---|---|---|---|---|
| BL-01 | **Label tool output in the model's context** (H-3). Tool, web, inbox and file results enter history as plain text (`agent.ts`, `history.push(\`tool …`). Mark them as untrusted data with delimiters the content can't forge. | The live injection path: a chat reads an email whose text reads like the agent's own notes. | — | **done** | (this commit) | 2026-10-14: suite 253/253, clean worktree 253/253 at pinned AWM, injection 4/9 → 0/9, 0/12, 0/8, 0/8 (incl. lookalike brackets 0/6), delivery 8/8 and 6/6, two isolated reviews, every finding fixed or moved to BL-16/BL-17 |
| BL-02 | **Job contract + run outcome.** `schedule` gains an owner, a completion condition (`until`), a notify policy (`always` / `changed` / `never`) and explicit limits. The model writes a standing procedure, not a restatement. Each run is recorded in AWM as an episodic memory with provenance, linked to its owner. A run also records an `outcome` (`changed` / `no-change` / `could-not` / `blocked`), kept separate from `reason`. | Fixes at the source what today's scheduled-task failures came from, and stops no-op runs logging `done`. Call 4 is settled here. | — | ready | | |
| BL-03 | **Approval the model can't give itself.** First a Telegram Approve/Cancel button handled by the connector, then remove human-required confirms from the model's tools. Keep a same-run check as a second guard. One item: removing the tool before the button exists would break Telegram approvals. **Also:** a standing preference captured automatically at run end is saved silently today. If the person pastes third-party text ("from now on, always BCC …") into their own message, it is captured as theirs; make captured policies a confirmable pending item, not a silent save (from the BL-17 coworker challenge). | Measured 2026-10-14: the model staged a write and confirmed it itself in one turn. Call 3 is settled here. | — | ready | | |
| BL-04 | **Gate shell commands** (H-4). A parsed allowlist of read-only commands runs directly; anything else is staged for approval. Developer mode unchanged. | In the default mode a chat can run any shell command unconfirmed. | BL-03 | blocked | | |
| BL-05 | **Goals own work; fan-out budget** (H-8). A goal is an AWM task (status, priority, `blocked_by`) that owns its scheduled tasks. Caps on tasks per run and per goal. | A scheduled run can create unbounded scheduled tasks. | BL-02 | blocked | | |
| BL-06 | **Inbox watcher in `serve`** (call 5). Start the file-drop watcher in the container. | The only autonomous intake in Docker today is a timed task. | — | ready | | |
| BL-07 | **Quiet hours and notify-on-change.** A delivery window; recurring tasks default to notifying only when something changed. | An always-on agent would message at any hour, every interval. | BL-02 | blocked | | |
| BL-08 | **Detector dry run.** The `check` command gets a dry run and starts disabled. | It can't be tested before it is armed. | — | ready | | |
| BL-09 | **Measure the no-compaction bet** (H-1). Plant a constraint at step 1, require it at step 25+, vary the window. | MWA's most distinctive claim is unmeasured. | — | ready | | |
| BL-10 | **Replayable run transcript** (H-5). Log every action and result so a crashed run can resume. | A crashed long run is unrecoverable. | — | ready | | |
| BL-11 | **One-file AWM interface** (H-7). A façade over the 11 deep imports. | The next AWM upgrade lands as a build break. | — | ready | | |
| BL-12 | **Promote button for proposed routines** (H-9). A human control in the Memory tab. | Saved routines are inert by construction. | — | ready | | |
| BL-13 | **Delivery receipts.** Record per channel whether a result reached the person. | A finished run is not a delivered result. | BL-02 | blocked | | |
| BL-15 | **Dependency advisories.** Production deps carry 2 critical (`proxy-addr`, `tar`) and 16 high advisories, all with fixes available — including `mailparser` / `linkify-it` / `html-to-text` denial-of-service on attacker-written text (MWA reads email) and an MCP SDK OAuth credential issue. Upgrade, re-run every gate. | Found by BL-01's audit gate; pre-existing, not caused by it. | — | ready | | |
| BL-17 | **Taint lineage, end to end.** BL-01 fences what the model *sees*; this makes "this run read outside content" follow the text into everything that *lasts*. Each path below was found by BL-01's second isolated review:<br>(1) **policy capture** lifts "always cc …" out of tainted text into a standing preference applied to every future run — no taint or sub-run guard (`agent.ts` ~1127–1160); HIGH, pre-existing;<br>(2) **fact transitions** write canonical with provenance from the prior fact only (~1003); HIGH;<br>(3) **chat turns**: earlier replies go unfenced into the next turn's instruction and `tainted` is never stored (`serve.ts` ~358, `telegram.ts` ~70);<br>(4) **`schedule` from a tainted run** creates an unattended task that starts clean;<br>(5) **person notes** learn from tainted replies (`serve.ts` ~390, `telegram.ts` ~88);<br>(6) **plan-step and run-outcome writes** and the synthesis prompt carry tainted text at inferred trust (~1178, ~1350, ~1356);<br>(7) **local reads** stop only `remember` being canonical — auto-learn, taught facts, skills and lessons ignore it;<br>(8) **the learning regression BL-01 accepted**: runs that touch the web, MCP or the shell no longer save skills or lessons. Write them as untrusted (`ingested`, not canonical) instead of dropping them; keep dropping open questions, which become unattended instructions. | These turn a one-turn injection into a lasting one. | — | **done** | (this commit) | 2026-10-15: suite 280/280 and clean worktree 280/280 at pinned AWM; injection 0/8 and delivery 6/6 every round; six isolated-review rounds with probes (p1–p11), every finding fixed or deferred. Residual: denial of trust (a planted near-twin can get a trusted fact flagged) — degradation, logged, not laundering; proper fix is the AWM task "reinforce/supersede ignore trust". |
| BL-16 | **Fence the remaining low-risk paths.** MCP tool descriptions (up to 400 characters, written by the server) reach every prompt unfenced; `confirm_action` is classed as MWA's own output but returns the wrapped tool's raw result, which would wrongly trust a future gated tool that returns third-party text. Also: first-party refusals inside external-classed tools (`http_request`, `read_document`) now count as actions, not refusals, because only the registry's failure flag counts for external tools — fail-safe, but the Glass Box over-reports; have handlers set the flag themselves. From BL-17's review: `runBrain` (`src/brain.ts`, used by `src/server.ts`) recalls with no `primeable` filter, and the gauntlet arms' memory wrappers (`src/gauntlet/arms.ts`) drop `LearnOpts`, `tainted`, `person` and `origin`. | Low findings from BL-01's isolated review, deferred to keep BL-01 scoped. | — | ready | | |
| BL-14 | **MWA runs this loop on its own repo.** The self-referential milestone: MWA's scheduler drives a build item end to end through these gates. | The point of the loop. Unsafe before injection labeling, real approval and shell gating exist. | BL-01, BL-03, BL-04 | blocked | | |

**Waiting on Robert (not built by the loop):** call 1 — merge `docker-autonomy-2026-10-14`,
publish 0.6.0, redeploy the dogfood. Calls 6 and 7 stay "not now".

## Cost ledger

| Date | Item | What | Cost |
|---|---|---|---|
| 2026-10-14 | BL-01 | Injection baseline, 9 chat turns (Azure) | $0.12 |
| 2026-10-14 | BL-01 | Injection rounds 1–4 (37 more chats) | $0.48 |
| 2026-10-14 | BL-01 | Delivery rounds 1–4 (26 trials, chats + fired runs) | ~$0.81 |
| 2026-10-14 | BL-01 | Coworker challenges (2) | ~$0.04 |
| 2026-10-15 | BL-17 | Six gate rounds: injection 8 + delivery 6 each, plus coworker | ≤ ~$2.75 |

**Running total: ≤ ~$4.2 of $10.00.** An upper bound: `runs.jsonl` logs a planned chat's sub-runs as separate entries whose cost the parent entry already includes, so summing it double-counts. All-time raw sum $4.81, of which ~$0.6 predates the loop.

## Decision log

Decisions the loop made, each with its coworker challenge and what was taken or rejected.

| Date | Item | Decision | Coworker challenge |
|---|---|---|---|
| 2026-10-14 | — | Audit gate scaled: one isolated reviewer per item, full six-way audit per cluster | Not challenged; recorded above under Gates |
| 2026-10-14 | BL-01 | Fence every tool result; label by source in three fail-closed classes (own / local / external), warning only on the last two. | **Taken:** classify fail-closed instead of by naming convention; grade labels so a cheap model doesn't learn to ignore warnings. **Rejected, then reversed:** a per-run random token in the markers. I judged replacing the marker glyphs sufficient. The isolated review forged a close with lookalike brackets on the first try, so the token went in. Lesson: the instrument tested only the glyph I already replaced, so 0/9 proved nothing about lookalikes. |
| 2026-10-14 | BL-01 | A run that read external content saves no skill, lesson or open question. | From the isolated review, not the coworker. An open question becomes an unattended run's instruction, so learning from tainted runs is a path from a web page to an unattended run. Cost: fewer lessons from runs that read the inbox or web. |
| 2026-10-14 | BL-17 | Standing-preference capture reads only the person's own words (`userMessage`), never in plan sub-runs; no taint guard. | **Rejected** the coworker's taint guard (option C): pasted third-party text in the person's own message does not taint the run, so the guard would not stop that case and would only drop legitimate captures like "read my email, and from now on always cc my assistant". **Taken** as a threat: captured policies become confirmable — moved to BL-03. |
| 2026-10-14 | BL-17 | Skills and lessons from tainted runs are saved as untrusted (not canonical) and never auto-primed; open questions are not saved from runs that read external OR local content. | **Taken** the coworker's core point: untrusted procedures are evidence, not instructions — hence the auto-prime exclusion rather than plain untrusted storage. Reverses BL-01's drop, which had stopped most real runs from learning. |
