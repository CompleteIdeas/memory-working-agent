# Backend slice for the usability redesign (scoped 2026-10-24)

The usability review of 2026-10-24 walked nine of MWA's use cases on a local instance (GPT-6 Luna,
branch bl72-approvals) and scored the web app 30 of 100. Its prototype, a Tasks model where one task
record drives the chat, a Tasks rail, a task panel and a return digest, scored 71 of 100 with a
scripted agent. Every gain in that prototype rests on a backend behaviour MWA does not have yet. This
document scopes those behaviours. The interface work (decisions D1 to D6 in the review) is a separate
slice that follows it.

Each item names the finding it answers, what the code does today (verified in this worktree, with the
review's own run log and server), the change, how it is tested, and a size: S is a short slice (one
session), M a full one.

## Order

| # | Item | Findings | Size | Depends on |
|---|---|---|---|---|
| B1 | Granted folders reach the run | F07 | S | – |
| B3 | One job per request | F04 (four reminders) | S | – |
| B5 | A goal closes with its job | F05 | S | – |
| B9 | Runtime data under one folder | F16 | S | – |
| B2 | Schedule API, pause and undo; a chat cancel that works | F04 | M | – |
| B4 | One card per proposal, truthful outcomes, gated writes | F02, F03, F01 (scope) | M | – |
| B6 | Stop for a chat run; real stage events | F06 | M | run registry |
| B7 | A running turn survives a reload | F09 | M | run registry (B6) |
| B8 | A message sent during a run reaches the run | F08 | M | run registry (B6) |

B1, B3, B5 and B9 are independent and small: do them first, in one or two sessions. B2 and B4 are the
two the person feels most. B6, B7 and B8 share one new piece, a registry of live runs per session
(run id, abort handle, event buffer), so they go together, B6 first.

Acceptance for the slice as a whole: replay the review's baseline scripts for U01, U02, U03, U04, U05,
U06 and U08 against a local server (the review's Playwright harness and evidence logs are under the
session scratchpad, `mwa-usability/`), and each of the failed outcomes passes: files found in the
granted folder, a cancel that cancels, one card per proposal with a visible expiry, Work saying done
when the job is done, a reload that keeps the running answer.

**Result (2026-10-24, evening).** All nine items built; the suite is green (112 files, 1212 tests) and
an end-to-end smoke through the API against a local server with GPT-6 Luna passed 21 of 21 checks at
$0.03 of model spend: the dock quote and deadline answered from the granted folder with named file
steps; the watch listed with an id, paused, resumed, moved, cancelled, restored, and cancelled from chat
with "Stop watching the budget file"; the copy into the granted folder staged as a card, the reply
saying it waits, the declined card kept in `recent`; a second message during a run answered `busy`;
`live` and `attach` saw the run; Stop ended it with "Stopped after step 3"; the conversation held no
stale running turn; a steer mid-run reached the reply; runtime files under `MWA_DATA_DIR`; the hand-off
goal left "working on it" when its job ended. The Playwright replay of the review's own scripts is
still to run; it needs the interface slice for the parts that are clicks rather than API calls.

## B1. Granted folders reach the run (F07) — S — built 2026-10-24

Built as scoped: `grantedFolders()` and `sourcesLine()` in `src/tools/access.ts`, the prompt line in the
run's cached prefix (`src/agent.ts`, only when the run has file tools and something is granted), the two
tools' no-`dir` behaviour and descriptions in `src/tools/builtins.ts`, `GET /api/sources` in
`src/serve.ts`, tests in `tests/tools/granted-sources.test.ts`. The `onboard_scan` check found nothing
wrong in the code: it reads `.txt` and `.csv` and confines to the same roots; the model most likely
passed a path it had not been given.

**Today (before this change).** The file tools already allow the granted roots: `allowedRoots()` in `src/tools/access.ts`
adds every `tools.access.grantedRoots` entry in the assistant and developer presets, and resolving
the review's granted folder and a file in it through `resolveAllowed()` with the review's own
`mwa.config.json` returns both (checked 2026-10-24). The model never looked there. Nothing it is given
names the folder: the instruction note built in `serve.ts` (`filesNote`, around line 460) describes the
chat's own folder and the Files tab; `list_files` says "List files in your working folder" and lists
only it when `dir` is omitted; `search_files` defaults to the working folder too. In the review's run
the model called `run_command` (staged), `list_files` with no dir and `onboard_scan`, and answered
"I couldn't find any files". Given the full path it ran nine steps and still reported "no readable
files".

**Change.**
- A sources line in the run's instruction note, for chats and for scheduled fires: "You can read
  these folders of the person's: <root> (n files)…" with the roots' absolute paths, and the chat's
  added files as now. Built in one helper (`sourcesNote(ctx)`) used by `serve.ts` and `scheduler.ts`.
- `list_files` with no `dir` lists the working folder and then each granted root, grouped under a
  heading with its path; `search_files` with no `dir` searches all of them. Both keep their caps
  (200 entries, 60 hits). Their descriptions say "your working folder and the person's granted
  folders".
- `GET /api/sources`: the granted roots (path, file count, readable or not) and this chat's added
  files, for the interface's "I can read" line and for Settings.
- Why `onboard_scan` found nothing in the granted folder is checked while here (it confines to
  `resolveAllowed`, which passes; the scan may skip by extension).

**Tests.** A unit test with a temporary granted root: `list_files` and `search_files` with no dir
reach a file in it; the sources note names the root; a serve test that `/api/sources` returns it.
Replay U01 from the review: the answer names the $4,200 quote and 1 November from the granted
files without an upload.

## B3. One job per request (F04, the four reminders) — S — built 2026-10-24

Built in the `schedule` action (`src/agent.ts`): a twin (the same words at the same time, a one-off within
15 minutes or the same repeat) is refused whether it was created earlier in this run or already waits in the
store, with its id and time in the nudge; the same words at another time are held once with a pointer to
`schedule_update`, and added when resent unchanged. Gates `twin-job` and `near-job`. Tests in
`tests/twin-jobs.test.ts`.

**Today (before this change).** "Remind me tomorrow at 9am to call Harbour Works" made four reminders (8:59, 9:00, 9:10,
9:10). The run log shows five `schedule` actions in one run with the `am-pm` and `missing-output`
gates firing: each re-ask after a gate produced another job. The `schedule` action in `src/agent.ts`
(from line 1680) checks fan-out budgets, the reminder kind and web links, but never whether a pending
job of this person already has this instruction.

**Change.** Before `addScheduledTask`, look for a pending job of the same person whose normalised
instruction matches (case and whitespace folded, same `kind`) and whose time matches (same `recur`,
or a one-off due within 15 minutes of this one). If found, return it as "already scheduled" with its
id, create nothing, and say so in history. The same check covers jobs created earlier in this run.
A near match (same instruction, different time) is reported to the model as "a job with these words
exists at <time>; call schedule_update to move it, or schedule again with `distinct: true`".

**Tests.** Two `schedule` actions with the same text in one run make one job; a second run asking
for the same reminder gets "already scheduled"; a different time is flagged, not blocked. Replay U03's
first message: one reminder.

## B5. A goal closes with its job (F05) — S — built 2026-10-24

Built in `src/scheduler.ts` after a fire: a one-off job of a goal that ended `done` with outcome changed,
complete or no-change marks the goal done; could-not, blocked or a run that did not reach done marks it
blocked, with the reason in the scheduler log. Left alone when another job of the goal waits (a watch
keeps its goal open, since a done goal stops its jobs), when a resume was queued, when the job repeats, or
when the model already set the status. Tests in `tests/goal-closes.test.ts`. The welcome digest and Work
tab need no change: they already read the status.

**Today (before this change).** "Work on it" creates a goal and sets it `in_progress` (`src/handoff.ts`, `startBackgroundWork`).
Nothing sets it `done`: the fired job's result is written as a notification and a turn in
`serve.ts` (`onFire`, around line 1487), and the status changes only if the model calls `goal_update`.
The Work tab renders `in_progress` as "working on it" (`web/src/components/Work.tsx`), so the review
saw it 17 minutes after the result. The welcome card said a watch that "couldn't finish" was "done".

**Change.** In `scheduler.ts`, after a run for a one-shot job that belongs to a goal: when the run
ended `done` with outcome `changed` or `complete`, no resume was queued, and no other pending job
belongs to that goal, set the goal `done` and write its record from the run's summary and files when
the model left none. When the run ended `could-not` or `blocked`, set the goal `blocked` with the
reason in its record, so Work says "paused" with a reason and Continue works. The welcome digest
derives each result's state from `outcome`, not from the job having fired.

**Tests.** Scheduler unit tests for the three endings; `/api/work` shows `done` after a hand-off
completes; replay U02: Work and the chat agree after the result.

## B9. Runtime data under one folder (F16) — S — built 2026-10-24

Built as `src/paths.ts` (`dataDir`, `dbFile`, `runLogPath`, `notifyPath`, `mwaLogPath`, `installLogPath`,
`vaultPath`, `browserDir`): `MWA_DATA_DIR`, else `<MWA_ROOT|MWA_HOME>/data`, else `./data`; the per-file
vars still win. Every `./data/…` literal in `src/` now goes through it (21 files), `mwa serve --data <dir>`
sets it, and `docs/configuration.md` describes it. Tests in `tests/paths.test.ts`.

**Today (before this change).** Every default path is relative to the current directory: `./data/runs.jsonl`
(`agent.ts`), `./data/mwa.log` (`logger.ts`), `./data/agent.db` and `./data/notifications.jsonl`
(`serve.ts`, `cli.ts`), with a separate env var for each. `docs/configuration.md` describes
`MWA_ROOT`/`MWA_HOME`, but no code reads them except `repo-qa.ts`. The review's first server, started
from the repo folder, wrote into the repo's `data/`.

**Change.** One `src/paths.ts` that resolves a data directory once (`MWA_DATA_DIR`, else `MWA_ROOT`
or `MWA_HOME` per the docs, else `./data`) and exports every runtime path from it; the per-file env
vars keep working as overrides. `mwa serve --data <dir>` sets it. The docs row becomes true.

**Tests.** With `MWA_DATA_DIR` set and no per-file vars, a serve run writes the run log, token log,
notifications and conversations under it and nothing under the cwd.

## B2. Schedule API, pause and undo; a chat cancel that works (F04) — M — built 2026-10-24

Built: `src/schedule-api.ts` (`scheduleRows`, `scheduleControl`) behind `GET /api/schedule?person=` (id,
kind reminder/watch/task, the person's words, next run, repeat, paused, last run, goal) and
`POST /api/schedule/{cancel|uncancel|pause|resume|update}` with `{ id, … }`, same-origin, scoped to the
person; the controls act through the model's own `schedule_cancel` and `schedule_update` tools, so the
ownership and timing rules live once. The store gained `getScheduled`, `pauseScheduled`,
`resumeScheduled` (next natural slot) and `uncancelScheduled` (ten minutes, from the `canceledat` tag a
cancel now writes); the scheduler skips a paused job; `schedule_list` says PAUSED. In chat, a stop
request (the BL-52 classifier's `change_job`, or the person's own stop words, now shared as
`asksToStopJob`) that ends after `schedule_list` with nothing cancelled or changed is sent back once with
the person's job ids (gate `cancel-asked`), and the cancel tool's guard accepts the person's stop words
even when the classifier read the message otherwise. Tests in `tests/schedule-controls.test.ts`.
Not built: the reply suffix pointing at the app's controls, which waits for the interface slice.

**Today (before this change).** `GET /api/schedule` (`serve.ts` line 777) returns instruction, due and recur with no id,
so the interface cannot act on a job. There is no write endpoint. The store has `cancelScheduled`
(status tag `canceled`) and `updateScheduledJob` (instruction, recur, due) in `src/awm.ts`; there is
no paused state for a job, only for a goal (`blocked`, which the scheduler honours at line 218). In
chat, three cancel requests failed, and the run logs show why: the model called `schedule_list` three
times each and never `schedule_cancel`, with no refusal recorded, then wrote "I can't cancel them from
here". The BL-47 guard was not the cause; it never ran.

**Change.**
- `GET /api/schedule` returns, per job of this person: id, kind (reminder, task, watch), the
  person's words (`request`), instruction, next run, recur, paused, last run summary and time, goal,
  tainted, and whether it is a resume (never shown as cancellable).
- `POST /api/schedule/cancel`, `/pause`, `/resume`, `/update` (time, days, interval, instruction),
  `/uncancel`, all same-origin and by id. Pause is a `paused=1` tag: the scheduler skips a paused job
  and advances its clock as it does a blocked goal's. Uncancel restores a job cancelled in the last ten
  minutes (the Undo in the prototype). Every call appends an audit line to the run log.
- Chat cancel. When the person's message asks to stop a job (the BL-52 classifier says `change_job`,
  or the BL-47 stop words match) and the run ends having called only `schedule_list`, the harness
  nudges once with the listed ids: "The person asked to stop a job. Call schedule_cancel with one of
  these ids, or say which one you cannot tell apart." If the run still ends without a cancel, the
  reply is appended with "You can stop it from the Tasks list" and the job ids are returned in the
  result event so the interface can offer the control inline.
- A watch (`every:` job with `deliver: changed`) is a job here like any other; "Stop watching" is a
  cancel.

**Tests.** Serve tests for each endpoint and for scope (another person's job is "no such job");
scheduler test that a paused job does not fire and resumes on its next slot; an agent test that a
list-only cancel run gets the nudge and then cancels. Replay U03 and U04: cancel confirmed in chat;
the five-minute watch stops.

## B4. One card per proposal, truthful outcomes, gated writes (F02, F03) — M — built 2026-10-24

Built: `stageAction` returns the waiting card when the same tool with the same arguments is staged again
by the same conversation or run (`src/tools/approval.ts`); the run-end capture compares rules by their
words across both kinds and cancels the model's shorter card for the same rule in favour of the person's
wording (`src/agent.ts`); `GET /api/approvals` `recent` now carries done, declined (`cancelled`) and
expired cards with their words and session for a day, and `pending` cards carry `expiresAt`, `runId`
and `readLocal` (so the card can say "read your own files" rather than "outside content"); `write_file`
into a folder outside the run's own (a granted folder) stages a card naming the path and whether it
overwrites, run on approval by the `write_file_granted` executor under the access policy of that moment
(`src/tools/builtins.ts`); and a reply that does not say an action is waiting, while one this run staged
is, opens with what waits (gate `claimed-staged`). Tests in `tests/approval-cards.test.ts`. The card
wording itself ("outside content" vs "your own files") is the interface's to change with `readLocal`.

**Today (before this change).**
- Duplicates. One preference produced one `captured-policy` card and three `policy_save` cards. The
  capture in `agent.ts` (line 2413) skips only when a pending summary contains the rule text; the
  model's own `policy_save` cards have a different summary, and the tool does not look for the captured
  card. Approving the first saved the model's shorter wording, which dropped "British spelling".
- Silent expiry. `GET /api/approvals` returns pending cards plus `approved` and `failed` outcomes
  (`recentApprovalOutcomes`, `approval.ts` line 359). Expired and declined cards simply vanish.
- A chat that says done while a card waits. `write_file` is not wrapped in `requireApproval`; it writes
  anywhere in the allowed roots at once, granted folders included. In U05 the model wrote the copy with
  `write_file`, also staged a shell copy, and the reply said "Copied" while the card waited; Decline
  then changed nothing. The BL-36 claim check (`claimedUnbacked`, line 2155) runs only when nothing is
  staged, so it cannot catch a reply that claims a staged action's effect.
- Every card says "Proposed by a run that read outside content": the capture passes `tainted:
  sawUntrustedRead`, and a chat that has read any local file or carried a fenced turn is marked.
- Scope. Cards carry `session` already (`PendingView.session`); the interface shows all of them.

**Change.**
- One card per rule: dedupe by normalised rule text across both kinds; `policy_save` for a rule with a
  captured card pending returns "already proposed, card <id>"; where both exist the captured card
  (the person's words) wins and the model's is cancelled. Cards get `taskId` (the run's root run id)
  and keep `session`, so the interface can place each inside its task.
- Outcomes: `/api/approvals` returns the last day's `expired`, `cancelled` (declined) and `done`
  cards with summary, time and result, and a `pending` card's `expiresAt` as a clock time. The
  expiring sweep in `prune()` writes a notification for the session ("expired at 3:41 PM, nothing was
  changed") so the chat can say so.
- Gated writes outside the run's own folder: `write_file`, and any copy or move the shell would do,
  whose target is in a granted root (not the run's sandbox) goes through `requireApproval` with a
  preview naming the path and whether it overwrites, unless the BL-72 reviewer passes it. Writes in
  the run's own folder stay immediate.
- Truthful replies: when the run ends with staged actions pending, the summary is checked for a claim
  of the staged effect (the staged tool's verb and object, as the BL-36 check does for unbacked work);
  a match is rewritten to "<effect> is waiting for your approval". The outcome is already `blocked`
  in that case (line 2555); the words follow it.
- The taint label on a card distinguishes "read outside content" (web, email, another chat's files)
  from "read your own files" and says neither for a clean turn.

**Tests.** Agent tests for the dedupe (one rule, one card; the captured card wins), the claim rewrite,
and a `write_file` into a granted root staging a card while a write into the sandbox does not; serve
test that an expired card appears in `recent` with its time. Replay U05: one card per request, Decline
leaves the file untouched, expiry visible; U07: one Remember card.

## B6. Stop for a chat run; real stage events (F06) — M — built 2026-10-24

Built with B7 and B8 on one piece, `src/live-runs.ts`: one live run per conversation with an id, an
abort handle, a ring of its last 300 events, an inbox and attached readers. `runAgent` takes `signal`
(checked at the top of every step: reason `stopped`, summary "Stopped after step k. Kept: … / n actions
still wait for your approval") and emits a `step` event per tool call with the tool, the thing it touches
(path, folder, query, address, id) and the time so far. `POST /api/chat/stop { session }` aborts; the
stream says `stopping` at once and `result` when the step finishes. The `result` event now carries
`runId`, `turnId`, `elapsedMs` and the staged ids. `GET /api/chat/live?session=` says whether a run is
going, with its last stage. Tests in `tests/live-runs.test.ts`.

**Today (before this change).** `runAgent` has no stop input: it ends on `done`, the step budget or the wall clock (`agent.ts`
line 1206). `serve.ts` `chat()` holds no handle to the run; closing the browser tab does not stop it
(the request's `close` only clears the heartbeat). Events carry a kind (`tool`, `read`, `dispatch`) and
sometimes a name or path; the interface renders "Using a tool…" with no elapsed time.

**Change.**
- A run registry in `serve.ts`: session → { runId, controller: AbortController, startedAt, events: ring
  buffer (last 200), turn }. `runAgent` takes `opts.signal`; it is checked at the top of each step and
  before each tool call. A stop ends the run with reason `stopped`, summary "Stopped after step k. Kept:
  <files written>. Nothing was sent or changed outside this folder." (staged cards are left pending
  and named), and the turn is appended like any other.
- `POST /api/chat/stop { session }` sets `stopping` (sent as an event at once) and aborts; the result
  event follows when the step finishes.
- Stage events: a `step` event per tool call with `{ n, label, detail, elapsedMs }`, where the label is
  the tool's verb and the detail its file, folder, query or job ("Reading budget-2026.csv", "Searching
  Board papers for 'dock'"), and `plan_step` already gives `n of N` for planned runs. The `result`
  event carries `runId`, `turnId`, `steps`, `elapsedMs`.

**Tests.** An agent test that an aborted signal ends the run at the next step with reason `stopped`
and the kept files listed; a serve test for `/api/chat/stop`; an event test that a `read_file` step's
label names the file.

## B7. A running turn survives a reload (F09) — M — built 2026-10-24

Built: the chat writes a `running` turn (with the run id) when the run starts, and the finished turn
carries the same id, which retires it in `readConversation`; `GET /api/chat/attach?session=` replays the
live run's events and follows it to its `result` (or says `gone`). The page's part, calling attach when
its conversation's last turn is `running`, belongs to the interface slice. Closing the page detaches its
reader and does not stop the run.

**Today (before this change).** `/api/chat` streams for the life of one request; `appendTurn` writes the conversation only
when the run ends (`serve.ts` line 487). A reload drops the stream; the run keeps going on the server,
and the answer appears only after a second refresh, because `sessionFor` rebuilds history from the
conversation file.

**Change.** On start, append a `running` turn with the run id; `GET /api/chat/attach?session=` replays
the registry's event buffer and then streams live until the result, which replaces the running turn
with the finished one. The interface calls attach on load when the conversation's last turn is
`running`. Cross-origin rules as for `/api/chat`.

**Tests.** Serve test: start a run, open attach mid-run, receive the buffered events and the result;
the conversation file holds one finished turn, not a running one.

## B8. A message sent during a run reaches the run (F08) — M — built 2026-10-24 (steer and busy)

Built: `/api/chat` answers `busy` (run id, started, elapsed, last stage) instead of starting a second
run in the same conversation; `POST /api/chat/steer { session, message }` queues the message, and the
agent drains the inbox at the top of its next step as "THE PERSON ADDS: …", the person's own words.
Not built: the `revise: <turnId>` targeting for a later "make it shorter" — the `turnId` is on every
result now, and the framing belongs with the interface's Revise box.

**Today (before this change).** A second `/api/chat` for the same session starts a second concurrent run (the cap is four
per server); the first never sees it, and both append to the same history, so "make it shorter"
revised whichever turn finished last. The correction in U06 was lost.

**Change.** If the session has a live run, `/api/chat` answers with a `busy` event `{ runId, startedAt,
stage }` instead of starting another, and the interface offers: add to the running task, send
separately, stop and do this instead. `POST /api/chat/steer { session, message }` queues the message
into the run (`opts.inbox`); the agent reads the queue before each step and gives it to the model as
the person's own words ("The person adds: …", unfenced; the person is the user). "Send separately"
runs it in a new conversation. The `result` event's `turnId` lets a revision name its target: a message
with `revise: <turnId>` carries that turn's reply as the thing to change, whatever came after it.

**Tests.** Agent test: a queued message changes the next step's prompt and the final reply; serve test
for `busy` and `steer`; a revision with `revise` targets the named turn. Replay U06: the correction
applies and "make it shorter" shortens the right reply.

## Not in this slice

- The Tasks interface itself (D1 Tasks model, D2 cards inside tasks, D5 Settings, D6 colours): a
  separate slice once B2, B4 and B6 expose what it needs. D3 (approval for writes into granted
  folders) is B4; D4 (schedule controls) is B2 plus interface.
- Connectors (U10) and the warm-start wizard (U11): not reviewed.
- Push notification outside the app: Telegram remains the channel for that.
