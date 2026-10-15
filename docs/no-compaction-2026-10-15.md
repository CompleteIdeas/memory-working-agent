# The no-compaction bet: a first run, and why it doesn't settle it (BL-09, 2026-10-15)

MWA keeps only the last 12 history lines in each prompt and never summarizes the rest. The bet (H-1 in
`docs/harness-evaluation-2026-10-13.md`) is that **memory recall stands in for compaction**.

**Status: inconclusive. A corrected re-run is queued.** A first run of nine trials was made. An
isolated review then showed the instrument couldn't support the conclusions first drawn from it. Those
conclusions are withdrawn here, together with what the data does and does not show. The instrument is
fixed, and one validation trial ran on the fixed version.

## What was measured

`scripts/measure-no-compaction.mts`. A brief, read as a tool result at the first step, holds two rules:

- the summary must begin with the code word `KESTREL-7`;
- the summary must never name the client.

The agent then works through 10 item files, appending to a tally, and finally writes `summary.txt`.
Three arms ran, three trials each, on gpt-5.4-mini:

- window 12 with memory;
- window 60 with memory (nothing drops out);
- window 12 without memory.

Raw rows: `docs/no-compaction-2026-10-15.jsonl`.

| Arm | Summary written | Both rules kept (of written) | Steps | Cost |
|---|---|---|---|---|
| window 60, memory | 2/3 | 2/2 | 18, 24, 27 | $0.56 |
| window 12, memory | 3/3 | 3/3 | 107, 85, 27 | $1.78 |
| window 12, no memory | 0/3 | — | 120, 120 (budget), 17 | $1.61 |

## What the data does NOT show (withdrawn)

- **"Memory made the difference between finishing and not."** The no-memory arm wasn't "no memory".
  It still offered the `remember` and `recall` tools, and they only failed as unhandled steps. The
  prompt still said "older context is in memory — recall it if needed", and the nudge to remember
  could fire in both arms (no history was saved to show whether it did). Both window-12 arms show the
  same pattern: 85–120 steps in two of three trials. The memory runs that went long ended at 107 and
  85 steps; the no-memory ones hit the 120-step budget. With 3 trials per arm, 3/3 against 0/3 is about p≈0.1, and the control arm itself failed
  one in three.
- **"Memory carried the rule in one run."** The instrument labeled the source by what was *absent*
  from the prompt. The code word could also have arrived through lines the agent wrote itself: a
  `remember` or `recall` line, a dispatch, a command. The label is unverified.
- **"The window lost the agent's progress; the 'item 6 done' line slid out."** No history was saved,
  so this was assumed. The window-60 rows read the brief 1, 1 and 2 times, but a later validation
  trial at window 60, on the fixed instrument, read it four times before writing. Re-reading can
  happen even when nothing has dropped out of the window, so on its own it isn't evidence of lost
  progress.
- The step and cost ratios were computed on mixed bases. Per arm: 73 against 23 steps and $1.78
  against $0.56, both about 3.2×.

## What it does show

- **At window 12, four of six trials ran 85–120 steps; no window-60 trial ran over 27.** That is
  suggestive, not established (about p≈0.12). Whether long runs at window 12 come from memory failing
  to stand in is exactly what the corrected run has to separate.
- **When a summary was written, both rules were always kept** (5 of 5).
- `KESTREL-7` never appeared in a summary without a source in the prompt, so `unexplained` never
  fired. The attribution logic was flawed, but nothing points to the model guessing.

## What the review found, and what changed

1. **Attribution fired on any mention of `summary.txt`,** including in calls that weren't the write.
   Runs that never wrote a summary were labeled. *Fixed:* the capture is now the main-loop call whose
   chosen action is `write_file` to `summary.txt`, or a dispatch naming it.
2. **The "memory" label was attribution by absence.** *Fixed:* the prompt is split at its RECENT
   STEPS header.
   - `memory` now means the code word appears only above that header (primed or recalled knowledge).
   - `own-notes` covers the agent's own lines in the window.
   - `window` and `reread` count brief reads made *before* the write step only.
3. **The no-memory arm had dead memory tools.** *Fixed in MWA itself:*
   - A run without memory is no longer offered `remember`, `recall` or `supersede`.
   - It isn't told to recall older context, and doesn't get the nudge to remember.
   - Its system prompt now says plainly that memory is off. The shared text still describes those
     tools for runs that have them. That was a real product bug: a memory-less setup wasted steps on tools
   that couldn't work. It is tested in `tests/hist-window.test.ts`.
4. **The run didn't match production.** *Fixed:*
   - The brain is now a `RoutedProvider`, as in serve. Both tiers are the same gpt-5.4-mini
     deployment here, so escalation changes nothing.
   - The config is explicit (Azure model, Assistant preset, MCP servers emptied) instead of the dev
     box's own. The validation trial below still had the default search server registered; that was
     fixed afterwards.
   - Each trial reports its action counts and the AWM version.
   - The first run used the main checkout, where AWM is 0.17.0 rather than the pinned 0.13.6. That
     run didn't record its version, so 0.17.0 is inferred from the checkout. The validation trial
     recorded it. The re-run must use a clean checkout at the pin.
5. `MWA_HIST_WINDOW` must be set in the process environment. A `.env` file is loaded after the agent
   module reads it. This is documented in the script.

One validation trial on the fixed instrument (window 60) wrote a correct summary in 23 steps for
$0.19. Attribution was `reread` (four brief reads before the write), with actions `read` 14,
`remember` 4, `read_file` 3, `write_file` 2, `done` 1.

## The re-run (queued)

Same three arms, from a clean checkout at the pinned AWM, with the fixed instrument and a 160-step
budget. Ideally there would be 5 or more trials per arm, so the "long run" rate at window 12 can be
compared between memory and no memory at a size that means something. Estimated cost is $5–8 at
3–5 trials. That only fits within the loop's cap if the cap allows it.

Until then, H-1's recommendation stands unchanged: **do not add compaction before this is measured.**

## Reproduce

```
MWA_ENV_FILE=<file with AZURE_GPT_*> MWA_HIST_WINDOW=12 npx tsx scripts/measure-no-compaction.mts --memory on  --trials 5
MWA_ENV_FILE=<file with AZURE_GPT_*> MWA_HIST_WINDOW=60 npx tsx scripts/measure-no-compaction.mts --memory on  --trials 5
MWA_ENV_FILE=<file with AZURE_GPT_*> MWA_HIST_WINDOW=12 npx tsx scripts/measure-no-compaction.mts --memory off --trials 5
```

The first run, three calibration trials and the validation trial cost about $5.74 in all. The first
run's arms alone were $3.95, from the rows above.
