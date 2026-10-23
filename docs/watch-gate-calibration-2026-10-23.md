# Watch gate calibration, 2026-10-23 (BL-73)

Before a watch that reports only changes sends a message, Clef is asked whether the message reports the same situation as the last one (`src/watch-gate.ts`). A yes keeps the watch quiet.

## Why it is needed

The scheduler decides "changed" by comparing the watch's reading as text. Sol words a reading the same way each day, but the cheaper models in the job bake-off did not, and each rewording reached the person as news:

- **Reworded reading on the confirming check.** MiniMax M3.1 Flash and Haiku 5.5 sent "FINAL (2026-11-06)" and then "RESULTS: FINAL (dated 2026-11-06)". The person got "Confirmed finished" and the whole message again.
- **A change the person did not ask about.** Haiku sent "PROVISIONAL", then "PROVISIONAL (scores corrected Nov 5)". The person had asked only to hear when the results were final.
- **No reading at all.** Luna sent "No change." with no reading and no declared outcome, twice.

## Cases

The calibration set has 54 cases:

- **From the bake-off.** All 32 watch messages that round 1 delivered. Each scenario says whether the person wanted the message: 24 were wanted and 8 were not.
- **Written for other kinds of watch.** 22 cases covering a price, a flight time, a package, a job posting, ticket sales, a forecast, and the two bake-off watches in other words. 12 should stay quiet and 10 should be sent.

The script is `eval/watch-gate-calibration.mts`. Each case was asked twice.

## Result

| | Clef's "same" score |
|---|---|
| Should stay quiet (20 cases) | 0.78 to 0.99 |
| Should be sent (34 cases) | 0.01 to 0.06 |

Clef gave the same answer on both runs of every case. Median time was 0.7 s and p90 1.8 s, with six calls in flight at once.

| Threshold | Wanted messages silenced | Unwanted messages still sent |
|---|---|---|
| 0.5 | 0 | 0 |
| 0.6 | 0 | 0 |
| 0.7 | 0 | 0 |
| 0.8 | 0 | 2 |
| 0.9 | 0 | 4 |

The threshold is **0.6**. Silencing real news is the worse mistake, so the threshold sits further from the "should be sent" scores (a gap of 0.54) than from the lowest "should stay quiet" score (a gap of 0.18).

## Limits

- **The gate only silences.** It never turns silence into a message. It is not asked about a failure, a run that staged an action, a job set to report every time, or a watch's first reading.
- **Gaps fail open.** When Clef does not answer within 4 s, or is not configured, the message goes out as before.
- **Small sample.** The set has 54 cases, two of them real watches; the other kinds of watch are hand-written. Every message the gate keeps quiet is logged as "watch gate: the same situation as last time (Clef 0.nn)", so real watches can be checked against it.
