# Ready to merge: `build-loop`, third stack (2026-10-15)

The build loop stopped at its cap of five unmerged items. Nothing here has been merged, published or
deployed.

## The decision

Merge `build-loop` into `master` (`9a539d5`). It is a **fast-forward**: no merge commit, no
conflicts. The AWM submodule pin is unchanged at `8070751` (AWM 0.13.6).

## What is in it

| Commit | What it does |
|---|---|
| `d590275` | Records the second merge in the queue. |
| `8d3b54b` | **BL-08.** A job's change detector starts as a dry run. Only a person arms it, with an approval card bound to its record. |
| `d510618` | **BL-13.** Delivery receipts per channel. `schedule_list` shows each job's last result and flags jobs that reach no one. |
| `dda2fdf` | The cost cap raised to $20 (your call). |
| `cabbb49` | **BL-16a/b.** Third-party MCP text is labeled. MWA's own refusals count. The approval-gate outcome. |
| `74c244f` `1964712` `399d834` | **BL-09 (revise).** The no-compaction instrument and a first, inconclusive run, written up honestly. Also a fix: runs without memory aren't offered memory tools. |
| `89f461b` | **BL-10.** Run transcripts. A scheduled job cut off by a crash or redeploy is resumed. |

Every item passed the loop's gates:

- typecheck;
- the full suite in a clean checkout at the pinned AWM;
- `npm audit` (the same 8 known, unreachable advisories);
- an isolated review attacking the diff until nothing was left;
- a Docker image built from that clean checkout, with both end-to-end harnesses and a live proof.

On BL-10's image: injection 0/8, scheduled delivery 6/6, suite **554/554**.

## What a person will notice

- **"What's scheduled?"** now shows each job's last result: sent, held, shown in the app, or not
  sent and why. It also flags a job whose results haven't reached anyone three times in a row.
- **A detector (`check`) skips nothing until you approve it**, after it has proved itself against
  the runs. Older detectors keep working.
- **A crash or redeploy no longer loses a scheduled job.** It resumes, at once after a clean stop or
  within about four minutes after a crash. A chat that was cut off says so, and isn't re-run.
- **`/data/transcripts`** is new. It holds step names, plain paths and outcomes, plus the request
  text. Finished transcripts are deleted after 7 days.
- **A failed Telegram send is retried** instead of silently lost.

## Waiting on you

1. **Rotate the npm token** (the one pasted earlier is still live), then publish **0.6.0** from
   `master` and redeploy. The changelog's "Unreleased" section covers this stack, for the release
   after.
2. **BL-09's re-run** needs about $5–8; the loop has spent about $15.86 of $20. Raise the cap if you
   want it measured properly.
3. In the decision doc: deploy **nano** (yes/no), and **BL-14 option B or C**.
4. **BL-14b** (a live self-build) needs you present to tap the approvals.
5. Cheaper models: none reachable today works (the decision log has the detail). A nano deployment
   or an OpenRouter/Gemini key would make one testable.

## Queued next (after a merge)

- BL-11 (a one-file AWM interface)
- BL-12 (a promote button for proposed routines)
- BL-16c (DNS-rebinding pinning)
- BL-19 (the `schedule_list` dead end, about 1 in 4 scheduling chats)
- BL-20 (Ollama silently truncates MWA's prompts)
- the BL-09 re-run
