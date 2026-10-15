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

Status: `ready` · `in progress` · `blocked` · `done` · `revise`.
"Waits on" names an item or a person.

| ID | Item | Why | Waits on | Status | Commit | Gates (date) |
|---|---|---|---|---|---|---|
| BL-01 | **Label tool output in the model's context** (H-3). Tool, web, inbox and file results enter history as plain text (`agent.ts`, `history.push(\`tool …`). Mark them as untrusted data with delimiters the content can't forge. | The live injection path: a chat reads an email whose text reads like the agent's own notes. | — | ready | | |
| BL-02 | **Job contract + run outcome.** `schedule` gains an owner, a completion condition (`until`), a notify policy (`always` / `changed` / `never`) and explicit limits. The model writes a standing procedure, not a restatement. Each run is recorded in AWM as an episodic memory with provenance, linked to its owner. A run also records an `outcome` (`changed` / `no-change` / `could-not` / `blocked`), kept separate from `reason`. | Fixes at the source what today's scheduled-task failures came from, and stops no-op runs logging `done`. Call 4 is settled here. | — | ready | | |
| BL-03 | **Approval the model can't give itself.** First a Telegram Approve/Cancel button handled by the connector, then remove human-required confirms from the model's tools. Keep a same-run check as a second guard. One item: removing the tool before the button exists would break Telegram approvals. | Measured 2026-10-14: the model staged a write and confirmed it itself in one turn. Call 3 is settled here. | — | ready | | |
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
| BL-14 | **MWA runs this loop on its own repo.** The self-referential milestone: MWA's scheduler drives a build item end to end through these gates. | The point of the loop. Unsafe before injection labeling, real approval and shell gating exist. | BL-01, BL-03, BL-04 | blocked | | |

**Waiting on Robert (not built by the loop):** call 1 — merge `docker-autonomy-2026-10-14`,
publish 0.6.0, redeploy the dogfood. Calls 6 and 7 stay "not now".

## Cost ledger

| Date | Item | What | Cost |
|---|---|---|---|
| | | | |

**Running total: $0.00 of $10.00.**

## Decision log

Decisions the loop made, each with its coworker challenge and what was taken or rejected.

| Date | Item | Decision | Coworker challenge |
|---|---|---|---|
| 2026-10-14 | — | Audit gate scaled: one isolated reviewer per item, full six-way audit per cluster | Not challenged; recorded above under Gates |
