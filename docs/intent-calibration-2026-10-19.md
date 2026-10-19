# Reading what a message asks for: patterns vs models (BL-52, 2026-10-19)

## Why

MWA's scheduling checks need to know what the person's message asks for:
- whether it sets up later work;
- how many jobs;
- which jobs are reminders;
- whether it corrects a job that already exists.

Until now, regular expressions answered these questions:
- `asksForLater` in `src/claim-check.ts`;
- `expectedJobCount` and `asksToChangeJob` in `src/schedule-request.ts`.

BL-40 showed the patterns missing real requests. "Set two reminders for me: …" matched nothing, so the push to schedule never fired. The patterns written for BL-43 then read 16 ordinary messages as requests, including "tell me when you are done" and "create a summary of the 9:30 notes". Tightening them brought back misses. Robert asked whether a model could answer these questions instead.

## Method

`scripts/intent-calibration/` holds three scripts:
- `extract.mjs` collects the messages;
- `label.mjs` labels them;
- `run.mts` asks each candidate and scores it. Results go to `results/intent-cal-*.json`, which is git-ignored.

The 129 messages come from four sources:
- **BL-40 (69).** Every distinct message the simulated people sent in the assessment, written by the Codex persona.
- **BL-19 tests (27).** The positive and negative test phrases.
- **BL-43 review (16).** The reviewer's misfire list.
- **Written for this (17).** Job corrections and mixed or multi-job requests.

Each message has one of four labels:
- `later`: set up something for later or repeating (43 messages);
- `change_job`: change or stop an existing job (12);
- `setting`: a general setting such as quiet hours (8);
- `now`: anything else (66).

Every model got the same definitions. For a provider that was `INTENT_SYSTEM` in `src/request-intent.ts`. For Clef it was the same text, phrased as questions:
- a choice for the category;
- a yes-probability for "later";
- choices for the two counts.

**Labeller caveat.** One person labelled the set, and the same person wrote the patterns. A few messages are genuinely ambiguous: "Summarize this later if you can" and "always warn me before anything auto-renews". Read the numbers as a direction, and check disagreements by hand.

## Results

| Candidate | Later requests caught | False triggers | Job corrections | Job counts* | Median time |
|---|---|---|---|---|---|
| Patterns (after the BL-43 review) | 34/43 (79%) | 0/86 | 8/12 (5 false) | 32/34 | 0 |
| gpt-5.4-mini, MWA's own model (minimal reasoning) | 41/43 (95%) | 3/86 (3.5%) | 11/12 (1 false) | 41/41 | 1.0 s |
| Jev Router (OpenRouter) | 43/43 | 5/86 (5.8%) | 12/12 (1 false) | 43/43 | 1.7 s |
| Clef-flash (Cloudflare, 9B), by category | 43/43 | 14/86 (16%) | 11/12 | 43/43 | 0.7 s |
| Clef (Cloudflare, 27B), by category | 43/43 | 7/86 (8.1%) | 12/12 (0 false) | 43/43 | 0.27 s |
| **Clef, yes-probability ≥ 0.65** | **42/43 (98%)** | **0/86** | 12/12 (0 false) | 43/43 | **0.27 s** |
| **Gemini 3.8 Flash (OpenRouter)** | **43/43** | **1/86 (1.2%)** | 12/12 (0 false) | 43/43, reminders 43/43 | 4.3 s |

\* Counted only on messages that both the label and the candidate call `later`.

The pass bar, set before the runs, was at least 95% of requests caught and at most 2% false triggers.
- **Pass:** Clef with a threshold, and Gemini 3.8 Flash.
- **Fail:** the patterns (too many misses), and gpt-5.4-mini and Jev Router (too many false triggers).

Clef's threshold sweep on the "later" yes-probability:

| Threshold | Caught | False |
|---|---|---|
| 0.5 | 43/43 | 2/86 |
| 0.6 | 42/43 | 1/86 |
| 0.7 | 42/43 | 0/86 |
| 0.8 | 41/43 | 0/86 |

The one message it misses at 0.6–0.7 is "Tell me the moment the package shows delivered" (0.52). Above 0.8 it starts to miss "always warn me before anything auto-renews" (0.90). MWA uses 0.65.

## What MWA does with it

`src/request-intent.ts` is opt-in, because it sends the person's message to another service:
- `MWA_INTENT=clef` uses Cloudflare Workers AI. It needs `MWA_CLEF_TOKEN` (or `CLOUDFLARE_API_TOKEN`) and `MWA_CLEF_ACCOUNT` (or `CLOUDFLARE_ACCOUNT_ID`). It needs the Workers Paid plan: the free daily allowance ran out during this calibration.
- `MWA_INTENT=<provider spec>` uses any model MWA resolves, for example `openrouter:google/gemini-3.8-flash`.

How it runs:
- The call starts when a chat run starts, and the result is awaited only where a check needs it, so its latency mostly hides behind the first model step.
- It never throws.
- A timeout (8 s), an error, or an answer it cannot read means no answer, and the patterns decide as before.

What the reading changes:
- **The push to schedule a request that was only listed.** The classifier now decides whether a message is a request for later work.
- **Planning.** A request for later work is not planned.
- **Ending after `schedule`.** The run ends as soon as the number of jobs asked for are set.
- **The count push.** It uses the classifier's job count.
- **The job-correction push.** It uses the classifier's `change_job` category.
- **Reminder or task.** This is settled without asking the model when the reading is clear-cut, meaning every job asked for is a reminder or none is. It is still asked when the message mixes the two. A reminder is still set only by the person in a clean conversation.

What stays deterministic, because it is a fact in the run's own record:
- whether the run called `schedule`;
- whether the stored hour matches the AM/PM the person wrote;
- whether a fired job read its sources;
- what was cancelled.

## Cost

- **Clef:** about 300 input tokens per message on Workers Paid.
- **Gemini 3.8 Flash:** about 600 input tokens, roughly $0.0005 a message.

Both are small next to a chat run, which in BL-40 averaged $0.19 per person-day.
