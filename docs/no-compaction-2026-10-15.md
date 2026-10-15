# The no-compaction bet, measured (BL-09, 2026-10-15)

MWA keeps only the last 12 history lines in each prompt and never summarizes the rest. The bet (H-1 in
`docs/harness-evaluation-2026-10-13.md`) is that **memory recall stands in for compaction**. This is
the first measurement of it.

**Short answer:** memory kept the agent finishing the job, and finishing it correctly. At a 12-line
window, every run with memory wrote a correct summary (3/3). Every run without memory failed (0/3).
But memory did not replace the lost *working progress*. In two of three runs at window 12, the agent
lost track of where it was. It re-read the brief 9–10 times and took 85–107 steps where the full
window took 18–27. That cost about three times as much. The constraint survived; the agent's sense of
where it was in the work did not.

## The instrument

`scripts/measure-no-compaction.mts`. A workspace holds `brief.txt` and 10 one-line item files. The
brief contains two rules among six other details:

- the summary's first line must be the code word **KESTREL-7**;
- the summary must never name the client, Acme Corp. Some item files mention the client, as bait.

The instruction is to read the brief, read each item and append its number to a tally, then write
`summary.txt` following the brief. The rules arrive in a *tool result* at the first step, because
the instruction itself is always in the prompt. By the time the summary is written, the first read
of the brief is 20+ history lines back.

Each trial gets a fresh memory store and the same tools a real chat gets, in the Assistant preset.
The planner is off and the budget is 120 steps. The model is gpt-5.4-mini on Azure.

**Attribution is read from the prompt, not guessed.** At the step that writes `summary.txt`, the exact
prompt is captured, and the instrument records where the code word sits:

- `window`: the first read of the brief is still in the window;
- `reread`: the agent read the brief again;
- `memory`: the code word reached the prompt only through memory (a recall result or priming);
- `absent`: it wasn't in the prompt at all.

`KESTREL-7` can't be guessed, so output containing it with no source in the prompt would reveal a
broken instrument. That never happened.

## Results (3 trials per arm)

| Arm | Summary written | Rules kept (of written) | Steps | Brief reads | Code word came from | Cost |
|---|---|---|---|---|---|---|
| window 60, memory (control: nothing dropped) | 2/3 | 2/2 | 18, 24, 27 | 1, 1, 2 | window, window, (reread, no summary) | $0.56 |
| window 12, memory | **3/3** | **3/3** | **107, 85**, 27 | **10, 9**, 2 | **memory**, reread, reread | $1.78 |
| window 12, no memory | **0/3** | — | **120, 120**, 17 | 10, 9, 2 | (never wrote it) | $1.61 |

Two runs stopped at the 120-step budget, both in the no-memory arm. One run in each of the control and
no-memory arms ended `done` without writing the summary. That is model variance at this size, and it
is reported rather than hidden.

## What it shows

1. **Memory made the difference between finishing and not.** At the same 12-line window, all three
   runs with memory completed correctly. Without memory, two ran out of steps and one quit early.
2. **The rules themselves were never lost when a summary was written.** Every summary kept both
   rules. In one run the code word reached the prompt *only* through memory, the bet working exactly
   as designed. In the others the agent re-read the brief, which is recovery through the
   environment, not memory.
3. **The real cost of the small window is lost progress, not lost rules.** In two of three window-12
   runs, the agent re-read the brief 9–10 times and needed 85–107 steps against 18–27 for the
   control: about four times the steps and three times the cost. The history line that said "item 6
   done" had slid out of the window, and nothing put it back.
4. **Neither "bigger window" nor "compaction" is the obvious answer.** The full window was cheapest
   here because the task is short. The evaluation's warning still stands: compaction would destroy
   what memory does well.
   - What's missing is a small, always-present record of **working state**: which steps are done and
     what's next.
   - The paper's *Anchored Incremental Summary* is that idea, scoped to progress rather than to the
     whole history.
   - Queued as **BL-21**.

## Limits

- **Three trials per arm.** The direction is clear (0/3 against 3/3; ~100 steps against ~25), but
  this is not a rate to quote to a decimal place.
- **One task shape**, a list worked through in order. A task without an obvious progress counter
  might lose less.
- **One model** (gpt-5.4-mini). A stronger model may track progress better without help.
- The control arm's prompt grows to ~60 lines. That's cheap here because tool results are tiny. It
  would not be cheap with real documents, which is why a bigger window is not the fix.

## Reproduce

```
MWA_ENV_FILE=<file with AZURE_GPT_*> MWA_HIST_WINDOW=12 npx tsx scripts/measure-no-compaction.mts --memory on  --trials 3
MWA_ENV_FILE=<file with AZURE_GPT_*> MWA_HIST_WINDOW=60 npx tsx scripts/measure-no-compaction.mts --memory on  --trials 3
MWA_ENV_FILE=<file with AZURE_GPT_*> MWA_HIST_WINDOW=12 npx tsx scripts/measure-no-compaction.mts --memory off --trials 3
```

Each prints one JSON line per trial; this run's nine are in `docs/no-compaction-2026-10-15.jsonl`. It cost about $5.55, including three calibration runs.
