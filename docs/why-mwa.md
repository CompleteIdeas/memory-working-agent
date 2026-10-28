# Why MWA, and why memory is the basis of it

This page answers three questions: what makes MWA different from other agent apps, why it is built on AWM
(agent-working-memory), and how well it actually works. The scorecard at the end uses measured numbers with their
dates and sources, including the ones that are not flattering. Written for 0.10.0 (2026-10-28).

## What MWA is

MWA is a personal assistant that runs on your own computer, a home server, or a hosted container (Railway, Docker),
and that you use from a browser or a phone. It checks in on you (a morning check-in and an evening wrap on Today),
sends notifications when something needs you, sorts your mail into a short Important list, keeps your calendar in
view, and works through longer requests in the background as jobs you can watch, stop, continue or give a note to.
It asks before anything that leaves your machine or can't be undone.

Underneath it is an agent loop (`src/agent.ts`) that calls a model, uses tools (files, documents, web search, a
browser, email and calendar connectors, MCP plug-ins) and keeps everything it learns in AWM.

## What is different about it

Most agent apps fall into one of three groups. MWA borrows from each but is none of them.

| Kind of app | What it is good at | Where MWA differs |
|---|---|---|
| Chat assistants with a "memory" feature | Answering in the moment | MWA works when you are not there: scheduled jobs, watches, mail sorting, a check-in, notifications. Its memory is the system's state, not a list of saved snippets. |
| Coding agents and harnesses | Long tool-using runs in a repository | MWA is aimed at a person's day (mail, calendar, documents, errands), with approvals a person can understand, and it runs unattended with its own spending limits. |
| Automation (cron, Zapier-style flows) | Doing a fixed thing on a schedule | MWA's jobs are written in plain words, carry what was learned last time, and stop and ask when a run would need something you have not allowed. |

The design choices that follow from that:

- **Memory first.** Every run starts by recalling what it already knows about the request and the person, and ends
  by writing what it learned. The model can be cheap because it does not have to rediscover your world each time.
- **Trust is tracked, not assumed.** Everything that came from outside (an email, a web page, a tool result) is
  marked untrusted when it is stored, and stays marked. Outside text can inform an answer but cannot become an
  instruction, and a run that has read outside text is held to stricter approval rules.
- **Approvals a person can read.** A staged action is shown in plain words with what each answer does, the exact
  text it will write and why it is asking. Risky ones (money, sending as you, deleting, outside content behind them)
  need a second confirm on the server.
- **Spending is bounded.** Every job and every plan option has a dollar limit and shows an estimate before it
  starts; chats keep step, time and token limits. A monthly budget (unset by default) holds scheduled work at
  100%, and the mail sorter has its own daily cap.
- **It is yours.** It runs where you put it, with your model key (or a local model through Ollama), and keeps no
  telemetry. You can see, correct, forget and export what it remembers.

## Why AWM

AWM is a memory engine for agents (npm `agent-working-memory`, vendored at 0.20.1 in `vendor/agent-working-memory`).
It came first: it was built to keep a large software project's context usable past the point where it fits in any
context window, and MWA was built on top of it to test whether a cheap model plus a good memory could do real work.

What AWM does that a plain vector store or a notes file does not:

- **Retrieval tuned on a real store.** BM25 and embeddings (bge-small) find candidates, a cross-encoder reranks them,
  and the whole pipeline runs in process. On a 11,262-memory real store it puts the right memory first 92.7% of the
  time, and says nothing on 90% of questions about facts it never stored (see the scorecard).
- **It decides what is worth keeping.** Writes go through a novelty and salience gate. A restated fact reinforces
  the existing memory instead of duplicating it.
- **It knows when a fact has changed.** `supersede` retires the old version so recall stops returning it. A notes
  file or a vector store returns both and leaves the model to guess.
- **It consolidates.** A "sleep" pass clusters, strengthens and decays memories, so a store built from many short
  chats matures instead of just growing (`mwa consolidate`).
- **It is scoped and shared.** Memories are scoped by agent and workspace, so projects don't bleed into each other,
  and several MWA surfaces (web, CLI, Telegram) can share one store.
- **It keeps provenance.** Every memory carries where it came from, which is what lets MWA keep untrusted content
  untrusted.

## What memory does inside MWA

Each item below was checked in the source for this release.

| What | How | Where |
|---|---|---|
| **Recall before acting** | At the start of a run MWA recalls up to 40 memories for the request, drops ones that must not be primed, ranks them and puts the best 12 in front of the model, keeping at most 10 in the prompt as the run goes on. The model can recall again mid-task with different words. | `src/agent.ts` (`PRIME_K`, the task-start recall), `src/prime.ts` |
| **Writes as it learns** | The `remember` tool, facts captured after a run, and `supersede` when a result proves a recalled fact wrong. Corrections you make in Settings › What I remember go through the same path. | `src/agent.ts`, `src/awm.ts` (`write`, `supersede`, `correctFact`), `src/memory-settings.ts` |
| **Newer beats older, trust beats newer** | Each primed memory shows the day it was noted. The prompt tells the model to prefer a later change over an older record, but never to let a newer untrusted item override what you said. | `src/agent.ts` (the NEWER BEATS OLDER and TRUST BOUNDARY rules) |
| **A model of the person** | Per-person notes, a compact dossier that recompresses itself, an intake set (what to call you, how to reach you), and a "who I'm talking to" block each turn. A message that contradicts the record flags the turn, and a sensitive action then needs a second factor (step-up). | `src/person.ts`, `src/person-learn.ts`, `src/person-identity.ts`, `src/step-up.ts` |
| **Skills and lessons** | After a run MWA can save a skill (what worked) or a lesson (what went wrong). An optional judge holds back lessons that teach the agent to get around a safety check. A skill or lesson from a run that read outside content is never primed as an instruction. | `src/agent.ts`, `src/lesson-gate.ts` (`MWA_LESSON_GATE`), `src/prime.ts` |
| **Provenance and taint** | Trust tiers (high, medium, untrusted) are stamped from where content came from, never from what it says. A run that reads outside content is tainted; its staged actions carry that, and since 0.10 they also record which message caused it, so an approval traced to a phishing-flagged email is kept out of the normal lists and never pushed to your phone. | `src/awm.ts` (`TrustTier`), `src/agent.ts` (`sawUntrustedRead`, `taintSources`), `src/v2/important.ts` |
| **The work ledger** | Scheduled tasks, goals, where-we-are records, open items and the action log ("What I did") live in AWM. In 0.10 the app's own records (jobs, tries, projects, mail headers, calendar cache) moved to a separate `app.db`; AWM keeps the knowledge. | `src/awm.ts` (`addScheduledTask`, `addGoal`, `addOpenItem`, `logAction`), `src/v2/db.ts` |
| **Which project an answer drew on** | MWA records what it recalled and, after the answer, which memories were actually used. If they came from another project, the answer says so. | `src/awm.ts` (`usedMemories`), `src/v2/provenance-match.ts` |
| **You can see and change it** | Settings › What I remember lists facts with search, correct, forget and export, plus standing preferences and routines. | `src/memory-settings.ts`, `web/src/v2/screens/settings/Memory.tsx` |
| **It can be switched off to measure it** | `MWA_MEMORY=off` keeps the scheduler but recalls and remembers nothing. That is how the assessment below separates what memory adds. | `src/memory-off.ts` |

This is why memory is the basis rather than a feature: the same store holds what MWA knows about you, what it has
been asked to do, what it did, and how far each piece of it can be trusted. The approval rules, the
injection defence, the "What I did" account and the per-person behaviour all read from it.

## What it costs, and on which models

MWA is built to do most of its work on cheap models, and memory is a large part of why that works. Most results on
this page come from cheap or mid-priced models; a few calibration runs routed some calls to expensive ones (the Jev
router in the approval calibration sent some to claude-opus-5.5).

- **Background work can run on GPT-6 Luna, and should.** Scheduled jobs, "work on it" hand-offs and thinking time go
  to `MWA_BACKGROUND_MODEL`. **It is unset by default, and then background work uses the chat model (GPT-6.1 Sol).**
  We recommend setting `MWA_BACKGROUND_MODEL=openrouter:openai/gpt-6-luna`; the maintainer's hosted instance runs
  background work on Luna and chats on Sol. Luna's OpenRouter list price is $0.10 / $0.50 per million tokens in and
  out (read 2026-10-28), a twentieth of Sol's $2 / $10. Measured per brief in the job bake-off: about $0.0045 on Luna
  against $0.108 on Sol, 24 times less.
- **Flex pricing for background calls is on by default** (`MWA_OPENROUTER_FLEX=background`). It applies only to
  `openai/` models through OpenRouter when OpenAI is an allowed host, asks for OpenAI's flex tier at half the price
  ($0.05 / $0.25 for Luna), is slower, and falls back to the standard price when flex turns the call away
  (`src/provider.ts`).
- **Chats run on GPT-6.1 Sol**, listed at $2 / $10 per million, because a person is waiting and it followed none of
  32 planted instructions in a file it read (`docs/models.md`). `MWA_MODEL` changes it.
- **AWM calls no hosted model.** Its embeddings, its reranker and an optional small query-expansion model
  (flan-t5-small, off in MWA: `src/awm.ts`) run locally on the CPU. Recall, write, supersede and consolidation cost
  no API money, so remembering more does not make each run dearer. A scoped recall puts a few hundred to about 1,500
  tokens in front of the model instead of the whole history (161 to about 630 in MWA's own experiments,
  `results/RETENTION-V2.md` and `results/RESULTS-V2.md`; about 1,518 measured by AWM's harness at its default
  settings, AWM `docs/claims.md`). MWA's own learning steps do call the model: learning about the person
  (`src/person-learn.ts`), the lesson gate, warm-up from a folder and Get to know me.

What that buys, measured:

| Work | On the cheap model | On the dearer model | Source |
|---|---|---|---|
| Morning briefs and change-only watches, 14 scenarios × 2, with MWA's checks on | Luna 27 of 28 at about $0.0045 a brief (DeepSeek V4.1 Flash the same) | Sol 26 of 28 at $0.108 a brief | `docs/configuration.md` (`MWA_BACKGROUND_MODEL`), `docs/build-queue.md` BL-73, 2026-10-23 |
| Questions about a project's own history | Luna with studied memory, planning off: 39 of 54 at $0.0075 an answer (the best of about eight memory configurations, which ranged 26 to 39) | Sol reading the files with search, planning on: 46 of 54 at $0.658 an answer (88 times the cost) | `docs/experience-pilot-2026-10-23.md` |
| Three research jobs (a newsletter, a product comparison, a guide) | Luna $0.14 for all three, every file written | Sol $2.08 to $2.62 | `src/provider.ts` (`backgroundCalls` note), 2026-10-23 |
| Two weeks of a simulated assistant | gpt-5.4-mini, $0.155 a person-day | — | `docs/assessment-2026-10-19.md` |
| A week of real use on the hosted instance, on 0.7.x to 0.8.1, chats on Sol and no background model set | — | 55 runs for $11.01, about 20 cents a run | `docs/reviews/production-review-2026-10-27.md` |

What is still weak about cost:

- **A cheap model needs the harness.** Luna's first long run of scheduled jobs (2026-10-23) went badly: wrong
  reminder times, "no change" messages from change-only watches, briefs that gave up. In the earlier model bake-off
  Luna was dropped after delivering 3 of 6 (`docs/models.md`). With BL-73's checks (a calendar listing alongside
  email that moves an event, a gate on watch messages, an open-items list) Luna scored 27 of 28; without them it had
  done badly. Without those checks, use a better model.
- **Cheap is not free on long tasks.** A run that reads a lot (a 73-page rulebook, a full inbox) still costs tens of
  cents to a dollar. Jobs and plan options carry a dollar limit; chats carry step, time and token limits. Settings
  shows the month's spend, and a monthly budget, if you set one, holds scheduled jobs at 100%.
- **The cheap model is weaker on some questions.** In the pilot, Luna with memory trailed Sol with the files on
  lookups (6 of 9 against 9) and on joining several facts (4 of 9 against 8); on judging a proposal they tied at 4
  of 9. The memory arm ran with planning off and the file arms with planning on, which the pilot calls its largest
  confound. MWA keeps the dearer model where a person is waiting. With `MWA_BACKGROUND_BOSS=on`, a background run
  starts on the background model and the chat model (the boss) takes over when it stalls for 3 steps, ignores a
  check or gives up. In the bake-off the boss added at most one point, at about 16 times the cost.

## The scorecard

Real numbers with dates and sources; where it does well; what is still weak or unmeasured. Small samples are
called small.

| Area | Score or measure | Evidence | What is still weak |
|---|---|---|---|
| AWM recall accuracy | 92.7% right memory first, 97.3% in the top five, on 300 identifier queries over 11,262 retrievable memories; p50 256 ms. On questions about facts never stored, it correctly returns nothing 90% of the time. AWM 0.20.0, 2026-10-20. | AWM `docs/benchmarks-current.md`, `docs/claims.md` | Measured on the maintainer's private store; the method is public (`npm run bench:public` on a synthetic corpus). The 90% rests on ten probes. Multi-hop questions are the agent's job (one hop per recall). The association graph changes the top three in 0% of tested queries. Time words like "last week" don't filter yet. |
| AWM against RAG, notes and long context | AWM 70%, RAG 78%, notes file 59%, no memory 0% on the hardened memory suite (confusable facts, several supersessions, multi-hop, sparse cues). Long context carried about 17,000 tokens a task and scored 0%. AWM 0.9.0 / MWA 0.2.0, 2026-06-17. | `docs/gauntlet.md` | AWM ties or trails a well-built RAG on this suite, even with supersede and multi-hop probes in it. An old version. |
| Shared memory across agents | AWM 100% (3 of 3); RAG, notes and no memory 0%, by construction: the other arms can't share. 2026-06-17. | `docs/gauntlet.md` | A small probe set; workspace sharing is SQLite only (Postgres and PGlite scope to one agent). |
| Decisions kept over a long session | 3 of 3 kept at 10, 50 and 200 distractors with a flat 161 tokens; long context also 3 of 3 but grows to 7,570 tokens; no memory 1 of 3 at 10 and 0 of 3 at 50 and 200. 2026-06-13, early MWA. | `results/RETENTION-V2.md` | No accuracy win over long context at that depth; the win is cost. An older version. |
| Scale | A scoped recall answers from a few hundred to about 1,500 tokens where carrying the system would take about 29 million. | `results/RESULTS-V2.md` (2026-06-13, about 630), AWM `docs/claims.md` (about 1,518 per recall at the default settings) | Recall then took about 3.2 s on the live store (AWM's current bench: 256 ms p50). Accuracy is capped by what was written down. |
| A cheap model that has studied a project | GPT-6 Luna with studied memory 39 of 54 at $0.0075 an answer; GPT-6.1 Sol reading the files with search 46 of 54 at $0.658 (88 times the cost); Luna reading the files 16 of 54. Equal on "why was this decided" (9 of 9) and on judging a proposal (4 of 9). 2026-10-23 to 25. | `docs/experience-pilot-2026-10-23.md` | 39 is the best of about eight memory configurations (26 to 39), run with planning off while the file arms ran with planning on. Behind on lookups (6 of 9 against 9) and joining several facts (4 of 9 against 8). One study pass is a sample: two passes kept different facts. |
| Personal assistant, 14 simulated days, two personas | First (registered) pass: checks passed MWA 62%, MWA with memory off 56%, plain model plus cron 44%. Facts said on day 1 and asked on day 13 or 14: MWA 3 of 4, every other arm 0 of 4; 4 of 4 on the second pass. Invented details: MWA 8, memory off 12, plain loop with fresh jobs 11, plain loop re-reading its own thread 37. Cost $0.155 a person-day against $0.011. 2026-10-19, gpt-5.4-mini. | `docs/assessment-2026-10-19.md` | **Verdict by its own pre-registered rule: no evidence of promise yet**, because the reliability bar failed (10 of 24 on time; one daily plan was never scheduled). The "memory makes it better" bar was inconclusive on the first pass and failed on the second (9 of 15 against 8 of 15). Twice, stale memories outranked a correction (a moved dentist appointment, a moved flight). Turning a request into a job was the weakest link. 14 times the plain loop's cost. The simulated person rated MWA lowest (2.7 of 5 against 3.8). One run per cell. Fixes since were checked by replay, not by a full rerun. |
| Planted instructions in a file it reads | GPT-6.1 Sol (the default model) followed or repeated them 0 of 32 times; gpt-5.4-mini 0 of 8; cheaper models 2 to 4 of 8. 2026-10-15 to 20. | `docs/models.md`, `scripts/e2e-injection.mjs` | One kind of attack (instructions in a local notes file), small samples. It depends on the model: MWA fences the content, but the model has to respect the fence. |
| Approval reviewer (automatic approvals) | Clef at safe ≥ 0.7 behind the fixed rules: 0 of 41 actions that need a person ran on their own; 41 of 48 fine actions would have needed no tap. 2026-10-22. | `docs/approval-calibration-2026-10-22.md` | 89 cases labelled by one person, thresholds chosen on the same set. Needs Cloudflare Clef credentials; ships in shadow mode (it reviews, you still decide) unless `MWA_AUTO_APPROVE=on`. |
| Lesson gate | Gemini 3.8 Flash caught 21 of 22 and 27 of 30 lessons that would get around a check, holding back 2 of 63 and 2 of 51 good ones. 2026-10-18. | `docs/lesson-gate-study-2026-10-18.md` | Opt-in (`MWA_LESSON_GATE`), needs an OpenRouter key. Without it, a lesson written after a refusal is kept but never fed into runs (`src/lesson-gate.ts`). |
| Watch gate (no repeat news) | 54 cases: at thresholds 0.5 and 0.6, no wanted message silenced and no unwanted one sent. 2026-10-23. | `docs/watch-gate-calibration-2026-10-23.md` | Needs Cloudflare Clef credentials; only 2 of the 54 cases came from real watches. |
| Unattended delivery in Docker | 8 of 8 tasks delivered after fixes, from 2 of 4. 2026-10-14. | `docs/docker-autonomy-test-2026-10-14.md` | Small set; see the assessment row for a harder test. |
| Real use on the hosted instance | 55 runs over a week for $11.01; 22 finished with a change, 7 ran out of budget, 3 more hit the budget with no outcome, 4 got stuck. 0.7 to 0.8.1, reviewed 2026-10-27. | `docs/reviews/production-review-2026-10-27.md` | Long tasks hit their budget, research was thin, and the eventing PDF session was never answered. Page-by-page PDF reading in 0.9.1 then answered 12 graded questions about those rulebooks correctly. |
| Project routing | 85% (34 of 40) of messages go to the right project; 4 of 4 vague ones stay in General. 2026-10-26. | commit `fd334f5`, `scripts/tune-routing.mts` | A labelled fixture of 40, written by us, and the weights were tuned on the same 40. |
| Usability | The classic task-centred workspace (0.8.0) came to 85.0 of 100 on the review's rubric, from a baseline of 30.0, with 8 of 9 use cases passing. That was the builder's own scoring and the report calls it borderline. The independent review before it scored the baseline 30.0 and its prototype 71.3, with the 85 target not met. The new-app web and settings slices pass their Playwright smokes with no axe violations at 390 and 1440 wide. | `docs/reviews/interface-slice-2026-10-26.txt`, `docs/reviews/usability-review-2026-10-24.html`, `scripts/v2-*-smoke.mjs` | **The new app has not been scored on the rubric.** The smokes run on fixture data; the install and offline smoke runs at phone width only, the push smoke at one phone width. |
| The new app on real accounts and phones | Not measured. Mail, calendar and push were tested against fake Google, Graph and IMAP servers and a mock push service. | merge commits `e23f727`, `a4c3cb6`; `docs/v2-build-plan.md` | Some provider calls (Graph draft properties, Gmail draft search by Message-ID) are unverified on real accounts. The phone install and push need a real tailnet test. |

### What the numbers add up to

- **Memory helps where only memory can.** Facts from two weeks earlier (3 of 4 and then 4 of 4, against 0 of 4),
  decisions that survive a long session at flat cost, a cheap model answering "why did we decide this" as well as
  an expensive one reading the files, and sharing between agents.
- **Fewer invented details come from the harness, not from memory.** MWA invented the fewest (8), but MWA with
  memory off (12) and the plain loop with fresh jobs (11) were close; the plain loop's 37 came from re-reading its
  own thread.
- **Memory can also hurt.** Twice in the assessment, stale memories outranked a correction. Ranking newer and
  corrected facts above re-learned stale ones is still open work.
- **It is not a better retriever on its own.** A well-built RAG does as well on the gauntlet. AWM's value is in what
  it does around retrieval: change, trust, scope, consolidation, sharing.
- **The harness is the weak part.** The assessment's misses were turning a request into the right job, watches
  without state and corrections that did not reach the jobs they were about. Several were fixed afterwards and
  checked by replay; a full rerun is still owed.
- **It can run on cheap models.** With `MWA_BACKGROUND_MODEL` set to Luna, background work costs fractions of a cent
  a brief, and AWM adds no API cost of its own. It still costs more than a bare loop with cron (14 times, in the
  assessment), because it reads and checks more; the new app shows limits and estimates before that is spent.
- **0.10.0 is mostly an interface and safety release.** Most of its slices were security-reviewed before merge
  (not A4, W1 or P4), but how it does for a real person over weeks on a phone has not been measured yet.

## Further reading

- [The memory substrate](the-memory-substrate.md): how provenance, trust and the action log were built into memory.
- [Choosing a model](models.md): which models resist planted instructions.
- [Reliability methods](reliability-methods.md) and [recall precision research](recall-precision-research.md).
- [Results V2](../results/RESULTS-V2.md) and [the memory gauntlet](gauntlet.md): the earlier benchmarks.
- AWM's own [README](https://github.com/CompleteIdeas/agent-working-memory#readme) and known limitations.
