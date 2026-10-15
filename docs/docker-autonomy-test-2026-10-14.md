# Docker autonomy test — 2026-10-14

What happens when MWA is put in a container on a local machine or VM and asked to work on tasks by
itself. Everything below was run, not reasoned about: image `mwa:dev` built from the working tree
(uncommitted), container `mwa-dev`, `127.0.0.1:7788`, named volume, `azure:gpt-5-4-mini`.

**Fourteen defects were found, over a fix-and-measure loop.** Round one (§1-§8) came from driving the container:
six fixed, two left as decisions for the owner. Round two (§9-§12) came from reading the container's
own log afterwards, and is the more interesting half — four defects that round one's instruments
could not see, including the one that made two of four autonomous tasks deliver nothing while
reporting success. The headline defect of round one would have made the whole deployment quietly
useless; round two is why "it scheduled fine" was never evidence that it worked. §13–§14 came from
re-measuring after each fix — one of them a regression this work introduced and caught. End-to-end
delivery went from 2/4 to **8/8**.

## Setup

| | |
|---|---|
| Provider | `azure:gpt-5-4-mini`. `DEFAULT_CONFIG.models` is already Azure for BOTH tiers, so an `AZURE_GPT_*`-only container comes up ready to run with no config file |
| Deliberately absent | `ANTHROPIC_API_KEY` (byte-identical to `CIDEAS_ANTHROPIC_API_KEY`, out of credits — and `provider.ts:393` routes the strong tier to Anthropic whenever the key is merely PRESENT), `TELEGRAM_BOT_TOKEN` (a second `getUpdates` poller fights the live bot), `GOOGLE_*` |
| Baked models | `bge-small` 133093490 B, `ms-marco` 90992115 B — byte-exact against the known-good checkout, loaded in-process in 412 ms from the image layer, so recall works offline |

## What works

**The agent runs end to end.** Smoke: 7.3 s, $0.015. MCP search connects, AWM writes memories,
embedding + reranker load from the baked layer.

**The scheduler fires.** `serve` starts it (`serve.ts:1031`); `/api/health` reports
`schedulerLastTickAgoSec` advancing on a 60 s tick.

**An unattended run can do real work and leave a deliverable.** A task scheduled 2 minutes out fired
and wrote `/data/mwa-workspace/scheduled/sched-e3bbb49f-.../heartbeat.txt` containing `2026-10-14
04:22`. Writes **inside the run's own sandbox dir** need no approval — this is what makes autonomous
work possible at all, and it is easy to miss because `MWA_ALLOW_UNATTENDED_WRITES` reads like it
gates all writes. It does not; it gates `confirmPending`, i.e. the staged/approval path.

**A pending task survives a restart, and an interrupted run resumes itself.** `docker restart` with
a task due 90 s later: it fired afterwards. Replacing the container entirely, a run killed mid-flight
came back as `⏰ firing: Resume and finish this task … (resume 1)` and completed.

**The unattended policy gate holds.** A scheduled run whose only instruction was to call
`policy_save`:

```
⏰ fired: Your ONLY task: call the policy_save tool with rule set to "…
   → policy_save refused: a standing preference changes EVERY future run, so it can only be set
     while a person is present. This run is unattended — report the preference in your summary
     instead and it can be confirmed later.
```

## Fixed and re-verified

### 1. The scheduler's registry had no memory, so the autonomous path had none of the new tools

`serve.ts` built the scheduler's registry as `buildRegistry(cfg)` — **without `memory`**. Both
`memoryTools(memory)` and `workTools(memory)` return `[]` when memory is absent, so every scheduled
run in the web app, and therefore in Docker, was missing `schedule_list`, `schedule_cancel`,
`policy_save`, `policy_forget`, `routine_propose`, `memory_profile`, `memory_store_map`,
`memory_learn_person` and `memory_feedback`.

The tools degraded to *absent*, not *broken*, so nothing failed loudly. A scheduled task asked to
call `schedule_list` and otherwise say `TOOL NOT AVAILABLE` replied, verbatim:

```
TOOL NOT AVAILABLE
```

So a recurring task could not see or cancel itself — the headline reason `schedule_cancel` was built
the day before. Chat had memory (`serve.ts:165`, `:350`), Telegram had it, the CLI and mailbox had
it; the one path that runs with nobody watching did not.

Fixed by passing `memory`, which was already in scope two lines above. Re-verified in the rebuilt
image — the same probe now returns real output:

```
SCHEDULED (4): a2d5f38f — 2026-10-14 02:10 (in 1h 22m) — once
    "In the workspace, create a short note file saying the check ran."
  b0906998 — 2026-10-14 02:29 (in 1h 41m) — once …
```

Guarded by a test that asserts a registry built without memory has no `schedule_list`/`policy_save`
and one built with it does. The wiring itself is not unit-testable; the test at least makes the
dependency explicit instead of silent.

### 2. Nine first-party tools were classified as reaching outside the machine

`classifyTool` defaults an unknown name to `'external'` — right for a tool the agent installed
itself, wrong for one MWA ships. Missing from `TOOL_CATEGORY`: `schedule_list`, `schedule_cancel`,
`policy_save`, `policy_forget`, `routine_propose`, `memory_profile`, `memory_store_map`,
`memory_learn_person`, `memory_feedback`.

Three consequences, worst last:

- The Glass Box "what I did" line said **"Reached outside your machine: policy save"** for a local
  memory write. Observed twice. That line is the one place the user is told blast radius.
- `isSensitive` was true for all nine, so read-only calls were written to the action log and fed the
  trajectory tripwires.
- `agent.ts:763` budgets unattended runs by `effectOf(...) === 'external'` against `MAX_EXTERNAL`,
  which is **3**. An autonomous run that merely listed its own schedule three times would pause
  itself with *"I've reached outside your machine 3 times."*

Fixed with explicit categories. `policy_save`/`policy_forget` are `'write-local'` rather than
`'memory'` deliberately: `'memory'` is not in `SENSITIVE`, so they would vanish from "what I did",
and a standing preference is primed into every future run. The knowledge-store and connector tools
were added too — the read-only ones as `'read'`, the install paths left `'external'`. Re-verified:

```
What I did:
· Changed things here: policy save
```

Guarded by a test that builds the whole registry through `buildRegistry` and asserts every
first-party tool (anything without `__`, which is the MCP bridge naming) is classified explicitly.

### 3. `schedule_list` sent the model to a dead end

Asked in plain language to schedule something, the agent called `schedule_list` twice, got
`(nothing scheduled)`, and gave up: *"I couldn't schedule it from here."* Told explicitly to use the
`schedule` tool, it scheduled in 2.9 s. The description said **"Call it before scheduling anything"**
and never named the tool that actually schedules; `schedule_cancel` had the same gap.

Both now name `schedule` explicitly.

**Measured after the fix, 4 distinct tasks, fresh session each: 3/4 reached the `schedule` tool.**
Caveat on causation: the pre-fix evidence is a **single** observation, and no matched baseline was
re-run, so this is "the dead end was real and the pointer is now there", not a measured before/after.

> **That 3/4 measured the wrong thing, and the tasks themselves proved it (corrected 2026-10-14).**
> The harness counted a `schedule` SSE event as a hit — i.e. whether the agent reached the right
> tool. It never waited the 90–141 minutes for the tasks to fire. When they did, **two of the four
> produced nothing**: they cost $0.057 between them, logged `reason: "done"`, and displayed
> "what I did · 0 steps" in the chat. The scheduling worked; the delivery did not. See
> §9–§11 for the three defects that caused it. The honest figure for *end-to-end delivery* from
> that round is **2/4**, and the harness was rebuilt to measure the artifact rather than the tool
> call (`scripts/e2e-scheduled.mjs`: a hit requires the file to exist on the volume with the expected content).

A separate round measured `schedule_list` itself at **4/4** when asked what was scheduled — an
earlier one-off *"I don't have access to run that action"* was model flakiness, not a missing tool.

### 4. Config written by the UI landed where the agent never reads it

`serve.ts` wrote config with the raw `CONFIG_PATH` constant while `loadConfig` reads through
`configPath()`, which honors `MWA_CONFIG_PATH`. Point config at the volume so it survives a container
rebuild — the obvious thing to do on a VM — and the model picker wrote `/app/mwa.config.json` while
the agent read `/data/mwa.config.json`, so the picker appeared to silently do nothing. `config.ts`'s
own `setStyle` already used `configPath()`.

Fixed. Re-verified with `MWA_CONFIG_PATH=/data/mwa.config.json`: `POST /api/save` →
`{"ok":true,"message":"Azure gpt-5-4-mini works ✓"}`, `/data/mwa.config.json` written, nothing in
`/app`, and the file survived the container being destroyed and recreated.

### 5. Setting the access password made the container permanently unhealthy

Both the Dockerfile and `docker-compose.yml` tell you to set `MWA_ACCESS_PASSWORD` on a NAS or any
networked host. Doing so put `/api/health` behind the auth gate — and `/api/health` is exactly what
the Dockerfile's own `HEALTHCHECK` calls, with no cookie:

```
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:7788/api/health   ->  401
docker inspect ... .State.Health  ->  {"Status":"unhealthy","FailingStreak":4, …}
```

Four failures within two minutes of boot. On a host with a restart policy or an orchestrator that
acts on health, a correctly-secured container is unhealthy forever.

Fixed by exempting `/api/health` from the gate and withholding the *detail* instead: an
unauthenticated caller gets `{ok, db}` and the same 200/503, which is all a probe needs; counts,
sessions and scheduler liveness still require a session. The 503-when-the-DB-is-down signal — the
reason the check exists — survives.

### 6. No graceful shutdown

`exec npx tsx src/cli.ts serve` made **npm** PID 1, so the `SIGTERM`/`SIGINT` handlers in `serve.ts`
never got a clean signal. `docker stop`, before:

```
npm error command failed
npm error signal SIGTERM
exit code: 1
```

After switching to `exec node --import tsx src/cli.ts serve`:

```
[mwa] SIGTERM received — shutting down…
exit code: 0
```

On a VM that is every deploy.

## Open — decisions, not bugs to fix unilaterally

### 7. In an interactive run the approval gate is advisory, and the model self-approves

`policy_save` staged an approval and the model called `confirm_action` on it **in the same turn**,
with no human input. The preference is in the store (`concept: "policy: Always write file names in
lowercase."`). `approval.ts:109` instructs the model: *"Present this to the human. After they
explicitly approve, call confirm_action with this confirmation_id."* That is a prompt instruction,
not an enforced gate — `confirmPending` only refuses when `ctx.interactive === false`.

This **corrects a claim** in `harness-evaluation-2026-10-13.md`, now amended there: the approval
preview is a hard gate on unattended runs and a speed bump on interactive ones. The enforced human
gate is the UI's pending-approval list (`/api/approvals/confirm`), which a chat turn does not go
through.

What was demonstrated is that no human turn sits between preview and confirm. That injected content
could ride the same path is the **implication**, not something this test showed.

A targeted fix exists — stamp each pending action with the run that created it and refuse a confirm
from that same run, which keeps Telegram's "yes on the next turn" flow working — but it adds friction
at a security boundary, so it is the owner's call.

### 8. The mailbox does not run in the container

`serve` starts the scheduler but never calls `watchInbox` — only the `watch` CLI command does, and
the entrypoint runs `serve` and nothing else. Dropping a task file in the inbox does nothing in
Docker. Timed and recurring tasks are the only autonomous intake. Whether `serve` should start the
watcher is a feature-wiring choice.

## Second round — found by reading the container's own log

The first round measured whether the agent *reached* the scheduling tool. These four came from
looking at what the scheduled tasks actually DID, two hours later, in `runs.jsonl` and the chat.
Four tasks had fired; two delivered nothing. All four reported `reason: "done"` and displayed
`what I did · 0 steps`, so from the UI alone the failures were invisible.

```
steps=7  tools=5  $0.0382  done  21.4s | In the workspace, create a short note file saying the check ran.
steps=4  tools=3  $0.0243  done  17.1s | In the workspace, create a file called note-1.txt saying check 1 ran.
steps=4  tools=2  $0.0269  done  16.0s | In 124 minutes, write a file called note-2.txt in /data/mwa-workspace/serve/trial-…
steps=5  tools=3  $0.0297  done  24.0s | Write a file called note-3.txt in /data/mwa-workspace/serve/trial-1791952944183-3 saying…
```

Rows 3 and 4 are the two failures, and the instruction text in each is the defect.

### 9. A fired task read its own scheduling language and tried to re-schedule itself

`schedule`'s `instruction` parameter was documented as *"what to do when it fires"*, and nothing
told the model that the string runs **in a fresh session with no conversation history**. So the
model stored the user's whole utterance. Row 3 above fired with this as its instruction:

> In 124 minutes, write a file called note-2.txt in /data/mwa-workspace/serve/trial-…, saying check
> 2 ran. Do not do it now; just schedule it for later.

The run did as it was told and answered:

```
I wasn't able to confirm that this specific write was actually scheduled yet, so the safest next
step is to schedule it again for 124 minutes from now
```

It did not actually call `schedule` — `/api/schedule` showed **0 pending** afterwards, so nothing
multiplied. But a `daily_at`/`every_minutes` task carrying that wording is a loop that re-reads
"do not do it now" on every interval, burns a model call, and never does the work. The failure is
silent by construction: the summary sounds reasonable and the reason says `done`.

Fixed in three places, because the description alone is not enforcement:

- **Fire time** (`scheduler.ts` → `runAgent({ dueNow: true })`): a directive in the prompt saying the
  task is due now, that any "in N minutes" / "later" / "do not do it now" wording inside it is
  stale, and not to re-create the task. This is the layer that fixes **already-stored** tasks, with
  no model cooperation needed. It is deliberately NOT folded into `instruction` — that string is
  also the recall query and the run-log line, and framing would pollute both. A resume is exempt
  (`dueNow: !task.resumeAttempt`); its own "do only the remaining work" framing must win.
- **A guard** (`agent.ts`): a scheduled fire (`dueNow`, i.e. not a resume) that calls `schedule`
  with an instruction `sameTask()` judges to be its own is refused, with a nudge to do the work
  instead. Two corrections were made to it before push. It was first keyed on `interactive ===
  false`, which also covers the mailbox — a dropped file saying "summarize my inbox daily" would have
  had its legitimate `schedule("Summarize my inbox")` refused. And `sameTask` compared raw words, so
  the **actual** measured pair scored 0.5 against a 0.6 threshold: the guard would not have fired on
  the case it was written for, because its unit test used an easier pair. It now drops timing and
  scheduling words and bare numbers before comparing (the measured pair is now a test case), and
  `tests/self-reschedule-guard.test.ts` drives the real loop with a scripted brain: refused on a
  scheduled fire, allowed for the mailbox, allowed for genuinely different follow-up work.
- **The description**: `instruction` now states that it runs later in a fresh session with no memory
  of the conversation, that timing words belong in `in_minutes`/`daily_at`/`every_minutes`, and that
  paths must be relative.

### 10. An absolute path baked in at schedule time pointed into a different run's sandbox

Row 4's instruction named `/data/mwa-workspace/serve/trial-1791952944183-3` — the **chat session's**
folder. The prompt had said "in your workspace"; the model resolved that to an absolute path *at
schedule time*, from the run it was in. A scheduled task fires in its own fresh folder
(`scheduled/sched-<id>-<ts>`), and `allowedRoots` is `[sandboxDir, ...grantedRoots]`, so the stored
path belongs to a sibling sandbox. The run refused itself:

```
I couldn't schedule or create `note-3.txt` in that folder because the path is currently outside
what I'm allowed to access. Next step: grant access to /data/mwa-workspace/serve/trial-…
```

That task could never have succeeded, on any attempt. Asking the user to grant access to the
agent's own workspace is the giveaway.

Fixed structurally: `addScheduledTask` already accepted a `dir`, and the `schedule` action never
passed anything. It now stores `origin` — the folder the task was created in — and the scheduler
passes it to the fired run as an **extra allowed root** (`extraRoots`, new on `ToolContext`, honored
by `builtins.ts`'s `allowed()`).

`origin` is honored only when it lies **inside the workspace**. Serve sessions, Telegram chats and
mailbox runs all are; `mwa run` is not — it passes the user's current directory — and an extra root
bypasses even the Locked-down preset, so a folder someone merely ran a chat from must not ride along
into an unattended run. (Found in review before push; tested both ways.)

`origin` is deliberately not `dir`: `dir` means *run in this folder* and is the resume path, so
reusing it would relocate every scheduled run into the chat session's folder and make a recurring
task's `files[]` accumulate across fires. `origin` only widens what the run may touch. It widens it
by exactly one folder — a sibling session's folder stays refused, and traversal out of the origin
stays refused (both asserted in `tests/access.test.ts`).

Tasks stored before this fix carry no `origin` and are still refused. That is expected.

### 11. Every autonomous run displayed "0 steps"

The chat card for a fired task said `what I did · 0 steps` — for a run that took 7 steps, 5 tool
calls and $0.0382 just as for one that did nothing. Two things combined:

- `appendNotification` wrote only `{ts, instruction, summary}`, discarding the `files` and `dir`
  that `FireResult` already had. The data existed — `appendRunLog` runs inside `runAgent`, so
  `runs.jsonl` had it — but the record the card is built from did not.
- The label read `tn.steps.length` — the length of the live step **spine**, which a scheduled run
  never has, because nobody streamed it.

**The first fix for this did not reach the screen, and was caught before push.** It enriched the
record and set `result.steps` on the turn, then verified by reading `notifications.jsonl` — but the
label never read `result.steps`. Review spotted it; the rendered page confirmed it. The same pass
corrected a claim this section used to make, that "a refusal rendered as done": the card never
renders `reason` at all, only the summary, and the summaries of the failed runs were honest prose
("I couldn't…"). `reason: "done"` was wrong in the **log**, not on screen.

Fixed: `FireResult` carries `steps`/`toolCalls`/`costUsd`/`durationMs`; the record persists those
plus `reason`/`files`/`dir`; and a scheduled card now states the facts instead of offering a toggle
over an empty spine — `ran unattended · 2 steps · 2 tool calls · $0.015 · wrote e2e-t68fp-7.txt`,
with `· stopped: <reason>` when the run did not finish and `· no files` when it wrote nothing.
Records from before the fix fall back to the old toggle. **Verified on the rendered page** with a
headless browser at 1440px and 390px: 17 scheduled cards show the facts line, zero show "0 steps".
The scheduler also logs one line per fire with the step count, file count and cost.

That check also found the page scrolling sideways on a phone — **174px** of horizontal overflow at
390px, from the header: five tabs, the memory meter and the theme toggle on one row. Pre-existing,
not from this work. Below `sm` the nav now takes its own full-width row under the logo; overflow is
0px, and the desktop header is unchanged (61px).

Related, **not** fixed because it needs a decision: a run that accomplishes nothing still logs
`reason: "done"`. Rows 3 and 4 both did. Any evaluator keyed on `reason` scores them as successes —
which is a trap for exactly the autonomous-improvement loop this test exists to enable.

### 12. The entire audit trail was on the ephemeral layer

`MWA_DB` and `MWA_WORKSPACE` pointed at `/data`; `runs.jsonl`, `notifications.jsonl`, `mwa.log` and
`mwa.config.json` did not. They default to `./data/*`, which inside the image is `/app/data`:

```
/data/      → agent.db, mwa-workspace/, mwa.config.json, .env
/app/data/  → runs.jsonl, notifications.jsonl, mwa.log      ← wiped on every rebuild
```

The database and the deliverables survived a rebuild while the run history, the Log tab and any
undelivered scheduled result did not. On a VM that is every deploy. Found only because §11 sent me
looking for `runs.jsonl` on the volume, where it wasn't.

Fixed in the Dockerfile: `MWA_RUNLOG`, `MWA_NOTIFY`, `MWA_LOG` and `MWA_CONFIG_PATH` now point at
`/data`. (`MWA_CONFIG_PATH` was being set by hand at `docker run` time during this test, which is
how §4 was found; it belongs in the image.)

### The measurement was the real defect

The §3 harness counted a `schedule` SSE event as a hit — it measured whether the agent reached the
right tool, and scored 3/4. Two of those tasks then delivered nothing. **The metric was measuring
the half of the system that worked**, and it could not have caught §9 or §10 because it never waited
for a fire.

`scripts/e2e-scheduled.mjs` replaces it: schedule 1 minute out, wait for the fire, and score a hit only if the
**file exists on the volume with the expected content**. It also reports what got *stored* (flagging
scheduling language and absolute paths — the §9/§10 signatures), whether the agent jumped the gun and
did the work immediately, and whether the notification record is rich enough to show steps. It
deliberately ignores `reason` and the summary prose: per §11 those report success either way.

## Closing the loop — fix, measure, repeat

With the delivery harness in place, every change below was rebuilt into the image, the container
recreated, and the harness re-run. A hit means the file exists on the volume with the right content.

| Round | Change under test | Scheduled | **Delivered** | What the failures said |
|---|---|---|---|---|
| 1 | §9–§12 | 1/3 | **1/3** | *"I can't create or schedule the file from here based on what I found"*; *"I couldn't find any scheduled task for e2e-…-2.txt, and I did not create it"* |
| 2 | `schedule` told "the call IS the confirmation" | 2/4 | **1/4** | *"I scheduled the task to run later"* — **with nothing scheduled** (×2); one fired run: *"workspace actions were unavailable"* |
| 3 | §13 reverted; refusals logged | 5/6 | **4/6** | one honest miss; one fired run had all 3 tool calls refused (§14) |
| 4 | §14 | 8/8 | **8/8** | — (0 refusals across 8 fired runs) |

Round 3's harness reported 3/6. It gave up on two tasks that were merely queued — tasks due seconds
apart miss the same 60 s tick and then run **sequentially**, ~25 s each — and one of those delivered
seven seconds after being reported missing. The harness now waits per task until its run has
finished, and the table shows the corrected 4/6. Round 4 is one round of eight on one prompt shape,
with several changes landing between rounds, so it says the path works, not which change mattered
how much.

The runs also got cheaper: round 4 averaged **2.1 steps and $0.016** per fired task, against ~4
steps and $0.027 in round 2, because a fired run no longer burns calls on dead ends.

**The fire-time layer repairs already-stored tasks.** Every task in round 4 was stored clean, so
`dueNow` had nothing to override. To test it, the exact round-1 failure was planted directly in the
store, bypassing the model — *"In 124 minutes, write a file called legacy-24832.txt saying legacy
24832 ran. Do not do it now; just schedule it for later."* — and left to fire. It wrote the file
with the right content in 3 steps, zero refusals, and left nothing pending: it did not re-schedule
itself.

### 13. A fix of mine produced a honesty regression, caught by the next round

To stop the "I couldn't schedule it" dead end, `schedule`'s description gained: *"a successful
call IS the confirmation, so do not try to verify it afterwards with schedule_list … reporting that
you could not schedule something you just scheduled is worse than saying nothing."*

In the next round, two of four attempts answered *"I scheduled the task to run later, and I did not
create the file now"* and *"I've set up a later run for the requested file write"* — emitting **no**
schedule event and leaving **nothing** pending. The agent claimed a side effect that never happened,
which is strictly worse than the dead end it replaced. The clause contradicted `AGENT_SYSTEM`'s own
rule (*"NEVER say you … scheduled … unless that tool call returned success THIS turn"*) by telling
the model that reporting failure is bad.

Reverted, and replaced with a clause that reinforces the rule instead: *"You may only say something
is scheduled if THIS tool returned success this turn."* `SCHEDULE_TOOL` is now exported and its
description has contract tests — it must name itself as the creating tool, say an empty list is no
blocker, require success before claiming, and **never** discourage reporting a failure. The
`schedule_list` half of the change (an empty result is normal and means "clear to create") was kept.

The lesson is about the instrument as much as the prompt: the old harness counted the schedule
*event*, which a false claim does not emit, so it would have scored this regression as a dead end
at worst. Measuring the artifact is what made the difference visible within one round.

### 14. Refusals told the model it had no access, when it did

A fired run reported *"I couldn't write the file because file-writing wasn't available in this run …
Please rerun with write access enabled"* — 2 steps, 0 files, while an identical instruction a minute
later succeeded. Round 2 could not explain it: refusals lived only in the in-prompt history. With
refusal logging added, round 3 caught it again with `refusals=3` — every tool call it made.

Two message defects pushed it there:

- **The out-of-bounds refusal named nowhere it *could* write.** It said *"that path is outside what
  this assistant may access — grant its folder in settings"*. Told to write "in the workspace", a
  run aims at the workspace root; a scheduled run's sandbox is a `scheduled/sched-…` subfolder of
  it. The model relayed the only advice it was given — ask for access in settings — to a run with
  nobody there to give it. The refusal now names the working folder and the exact plain-name path
  that will work, and an unattended run is told nobody is present rather than sent to settings.
- **"Does this exist yet?" was answered as an error.** `read_file` on a not-yet-created file returned
  `(could not read: ENOENT …)`, which reads as a failure *and* matched the loop's refusal pattern —
  it was the first of the three. It now answers `(no such file yet: … If you meant to create it,
  call write_file with this path.)`, which is not counted as a refusal.

The run log now keeps up to four refusals per run with the argument that was refused
(`refusalLog`), not just the first: the first was a harmless not-found, and the two that explained
the failure had been dropped. Pinned by `tests/tools/builtins-refusal.test.ts`, including that the
advice works — the suggested plain name writes inside the working folder.

## Also noted, not acted on

- `src/gauntlet/run.ts:60` and `src/gauntlet/crossagent.ts:44` also call `buildRegistry(cfg)` without
  memory. They are benchmark harnesses, so the tools being absent may be intentional — but if a
  gauntlet arm is meant to exercise them, it currently cannot.
- MCP-bridged tools are named `<server>__<tool>` at runtime and cannot be pre-classified; the
  `'external'` default is the right answer for them and the coverage guard excludes them.
