# Ready to merge: `build-loop` (2026-10-15)

The build loop stopped at its cap of five unmerged items. This page is everything needed to decide
whether to merge, and what to do after. Nothing here has been merged, published or deployed.

## The decision

Merge `build-loop` into `master`. It is a **fast-forward**: `master` (335b7d4) is an ancestor, so
no merge commit and no conflicts. It carries 8 commits, 66 files, +7,086 / −331 lines.

The AWM submodule pin is **unchanged** at `8070751` (AWM 0.13.6) on both branches.

After merging, Call 1 of the 2026-10-14 decision review still applies: publish **0.6.0** to npm
(`package.json` still says 0.5.0, and `CHANGELOG.md` has an "Unreleased" section to turn into
0.6.0), then redeploy the Railway dogfood, whose health check was returning 401.

## What is in it

| Commit | What it does |
|---|---|
| `1162465` | Runs autonomously in Docker: scheduled tasks deliver end to end (the 2026-10-14 branch). |
| `8972109` | Tracks the CI proof scripts, so a fresh clone passes. |
| `3078b30` | Adds `docs/build-queue.md`, the loop's durable state. |
| `794e0ff` | **BL-01.** Tool, web, inbox and file output is fenced in the model's context with a per-run code that content can't forge. |
| `59f7962` | **BL-17.** Taint follows text that came from outside into everything that lasts: memories, skills, lessons, scheduled tasks and chat history. |
| `34ad4b6` | **BL-02.** Each scheduled job has a contract (`until`, `limits`, `deliver`), and each run records an outcome: changed, no-change, could-not, blocked or complete. |
| `56f9768` | **BL-03 + BL-04.** Only a person can approve: there's an approvals panel in the web app and an Approve button in Telegram. In Assistant mode, shell commands that aren't read-only need approval, and the fetch tools can't reach this machine. |
| `140b0f7` | **BL-15.** Dependency advisories went from 29 (2 critical, 16 high) to 8 (0 critical, 2 high). |

## What a person will notice

- **An approvals panel** appears above the chat input whenever something waits for you. Telegram
  sends an Approve / Cancel card. The agent can no longer approve anything itself.
- **Assistant mode asks before running commands** that aren't simple reads: `ls`, `cat`, `grep`,
  `find`, `head`, `tail` and `wc` still run at once. Installs, builds, git, scripts and network
  tools now show up as cards. The settings page describes this.
- **Developer mode is unchanged and is labeled as no security boundary.** The agent has your shell
  there, so it can approve its own actions. Choose it only on a sandboxed machine.
- **Standing preferences need a click.** "From now on, always …" becomes a card to approve, not a
  silent save. A pasted email can no longer give the agent a permanent rule.
- **Scheduled jobs can finish and can be quiet.** A job can say when it is done for good, and it
  stops only after two checks in a row agree. A monitor can be set to tell you only when something
  changed. Failures, completions and anything waiting for your approval always reach you.
- **Chat cards for scheduled runs** say what happened: "nothing new", "couldn't finish", "needs
  you", "looks finished — confirming", "finished, job stopped".

## How it was verified

Every item went through the same gates: both typechecks, the full suite on a clean checkout at the
pinned AWM, `npm audit`, an isolated reviewer who attacked the diff, and for loop or scheduler
changes a rebuilt Docker image with both end-to-end harnesses.

- **Suite:** 392 / 392 at the pinned AWM.
- **Prompt injection** (`scripts/e2e-injection.mjs`): 4 of 9 runs followed planted instructions
  before BL-01. Every round since has scored 0, the last 0 / 8 on the final image.
- **Scheduled delivery** (`scripts/e2e-scheduled.mjs`, a hit means the right file exists): 6 / 6
  on the final image. One earlier round scored 5 / 6: the model listed schedules and stopped
  without scheduling, and no approval was involved.
- **The self-approval attack:** an agent asked to `curl` the approvals endpoint with a real id
  staged the command for approval, and the target stayed pending. The same attack runs as a test
  against a real local server.
- **Reviews** found and fixed, among others: a monitor's one completion message being silenced,
  a job refused on every run going quiet, a pasted rule saved as yours, and the shell route to
  self-approval (critical, proven twice by the reviewer).

**One correction about the evidence.** The Docker images for BL-01 to BL-03 were built from a
checkout whose `vendor/` held a newer, uncommitted AWM, not the pin. Their harness results describe
that AWM. The final image was built from a clean checkout at the pin, and it re-ran both harnesses
on the whole branch with the results above. The gates now require building from the pin.

## Known and not fixed

These are queued in `docs/build-queue.md`:

- **BL-18:** pending approvals live in memory, per process, so serve and the Telegram connector
  don't share them, and a restart drops what was waiting. Also: Telegram checks the chat, not the
  user, in a group chat; and `cancel_action` / `list_pending` aren't scoped to a session.
- **BL-16:** lower-risk unfenced paths, DNS rebinding against the fetch guard, and two minor
  outcome-label gaps.
- **AWM task:** `@huggingface/transformers` 4.x would clear the last two high advisories
  (`sharp`). AWM loads `sharp` but never sends it an image.
- AWM's own suite has a timing failure that predates this work (`migrate-smoke`, 5.1 s against a
  5 s limit).

## After merging

1. `npm version minor` (→ 0.6.0) and turn the CHANGELOG "Unreleased" section into 0.6.0.
2. Publish, then redeploy the Railway dogfood and check `/api/health`.
3. Tell the loop it may continue: next are BL-05 (goals own their work; a budget for scheduled-task
   fan-out) and BL-18.

Model spend for the loop so far is at most about $6.15 of its $10 cap.
