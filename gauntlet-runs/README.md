# Retained gauntlet runs

Evidence lives here, **not** in `results/`.

`src/gauntlet/run.ts` calls `rmSync(root, {recursive:true, force:true})` on
`results/gauntlet` at startup. Anything stored there — including a committed
`scorecard.json` — is deleted by the next run. That is how the k=10 baseline arm was
lost mid-comparison, and how a committed scorecard came back as a `D` in `git status`.

This directory is a sibling the harness never touches.

| file | what it is |
|---|---|
| `scorecard-awm-k3-2026-08-25.json` | k=3, `awm` arm. 24/30 memory probes (80.0%). |
| `scorecard-awm-k10-rerank2+window+tags-2026-08-27T16-46-08-334.json` | k=10 treatment arm, **complete** (10/10 reps). 81/100 memory probes (81.0%), per-rep 9/9/8/7/6/7/9/10/10/8, $4.97. Pairs with the baseline above: **+7.0pp, Fisher p=0.31**. |
| `checkpoint-awm-k10-rerank2+window+tags.json` | superseded partial (3 of 10 reps) from the run that was cut short. Kept as the record that per-rep checkpointing works. |
| `scorecard-awm-k10-defaults-2026-08-27T14-03-10-999.json` | k=10 baseline, **complete** (10/10 reps, `partial: false`). 74/100 memory probes (74.0%), per-rep 6/8/8/8/8/4/9/7/8/8, $4.69. Supersedes the transcript-sourced 7-rep note, which said 74.3% — close, but not an artifact. |

**All 10 probes flip between identical runs** at k=10 — the 7-rep sample suggested 6 of 10,
which understated it. Even `distractor-codename` and `policy-signoff` land 9/10. That is the
ceiling on what any gauntlet delta can currently resolve.

`*.json` here is gitignored by default — these are run artifacts. Commit one deliberately
when it backs a documented claim, as the three above do.

Filenames encode arms, k, and the AWM recall configuration, so two runs can always be
compared and never silently mixed.
