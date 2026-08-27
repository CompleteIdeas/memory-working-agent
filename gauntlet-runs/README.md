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
| `checkpoint-awm-k10-rerank2+window+tags.json` | k=10 treatment arm, 3 of 10 reps before a task timeout. 23/30 (76.7%). `partial: true`. |
| `baseline-k10-defaults-2026-08-26.md` | k=10 baseline, 7 of 10 reps, 52/70 (74.3%). **Transcript-sourced** — its JSON was destroyed by the next run's startup wipe before it could be copied out. Weaker evidence than the JSON beside it; re-run before quoting the delta. |

`*.json` here is gitignored by default — these are run artifacts. Commit one deliberately
when it backs a documented claim, as the three above do.

Filenames encode arms, k, and the AWM recall configuration, so two runs can always be
compared and never silently mixed.
