# Experience pilot: does studied memory make a cheap model answer like a team member?

Dates: 2026-10-23 (round 1), 2026-10-24 (round 2). Judge: Gemini 3.8 Flash through OpenRouter, rubric per
question, three repeats per question, 18 questions, 54 answers per arm. Corpus: 82 MWA documents (design docs,
decision log, test reports) copied out of this repository. Runner, questions, stores and answers live in the
session scratchpad (`exptest/`), not in the repo.

## The question

MWA is meant to be used over months. We wanted to know whether a cheap model (GPT-6 Luna, about a cent an
answer) that has *studied* a project once and carries the result in AWM memory can answer questions about that
project the way an experienced team member would, against the same model reading the files on demand, and
against an expensive model (GPT-6.1 Sol) reading the files.

Six question types, three questions each:

| Type | Asks for | Example |
|---|---|---|
| lookup | a stated number or name | the BL-05 follow-up limits |
| synthesis | several facts joined | the detector readiness record |
| current | the value *now*, after changes | the thinking cadence today |
| rationale | why a decision was made | why the judge is one fixed model |
| apply | what MWA does in a situation | a vendor email asks for a BCC |
| lens | accept / modify / reject a proposal, citing the record | drop the deterministic floor |

## Round 1 (2026-10-23)

| Arm | Model | Knows the project through | Score /54 | Consistent | $/answer |
|---|---|---|---|---|---|
| A | Luna | nothing | 3 | 100% | 0.011 |
| B | Luna | the files | 4 | 83% | 0.007 |
| C | Luna | studied memory | 29 | 83% | 0.014 |
| D | Luna | memory + files | 26 | 56% | 0.020 |
| E | Sol | the files | 25 | 67% | 0.386 |
| F | Luna | studied, then reconsolidated memory | **33** | 78% | 0.014 |

Memory won lookup, current, rationale and apply (C answered all nine rationale questions). Sol with files won
synthesis (8/9 against F's 3/9). Lens was near zero everywhere. "Consistent" is the share of questions where the
three repeats agreed.

Two things made round 1 unfair to the file arms, and they were traced before anything was changed:

- **The file tools.** B spent 369 calls on `list_files` and 14 on `read_file`; its `grep … | head` attempts were
  staged for approval (69 approval waits). The model could not search a folder of 82 files, so it listed and
  guessed. B and E gave up ("couldn't verify") on 15 and 12 answers.
- **The memory arms' misses were mostly priming, not storage.** For each missed question we checked: was the
  fact stored, was it in the twelve memories primed at task start, was it used? An offline replay of MWA's
  task-start recall (fresh copy of the store per configuration, because recall raises access counts) found:
  1. The runner's framing ("Answer this question about the MWA project, an AI assistant we are building")
     pulled generic project memories ahead of the specific one. The bare question put L1 from #21 to #1, R1 from
     #31 to #1.
  2. Five general `insight:` / `position:` memories were primed on 11 to 17 of the 18 questions, pushing the
     memory holding the asked-for numbers out of the twelve.
  3. AWM multiplies rank by the memory's confidence, and confidence at write time is bimodal by kind (decisions
     0.64, observations 0.44), so plain facts with numbers were under-primed. Reducing the gate was measured as a
     trade (some questions up, some down), not a gain, and was left alone.
  4. Reconsolidation lost material: 17 of 273 merge outputs were archived with no successor (AWM's redundancy
     pruning, cosine ≥ 0.75, a threshold calibrated for a different embedding model), merges were born at 0.44
     confidence, and standing positions were formed from 260-character digests, so they could not cite the
     numbers that decide (BL-30's 0/5 against 4/5).
  5. Study granularity: the L3 code word was never stored, and the `(from file.md)` pointer in each memory could
     not be followed because file reads were gated.
  6. Use: the L2 fact was primed at #1 ("four agreements, at least two each way") and Luna still paraphrased it to
     "both directions" five times out of six.
  7. Hedging: every arm, Sol included, answered "modify" on lens questions the record settles outright.

## What changed for round 2

In MWA (this commit):

- `search_files`: a built-in, read-class tool that searches a granted folder (case-insensitive text or regex,
  skips `node_modules`, dotfiles and binaries, 60 hits, 8 per file). `read_file` and `list_files` were the only
  file tools before.
- Task-start recall is run on the request itself when the prompt wraps it in a template with a labelled line
  (`Question:`, `Task:`, `Request:`, `Brief:`, `Prompt:`).
- At most `MWA_PRIME_ABSTRACT_CAP` (3) `insight:` / `position:` memories take primed slots; the rest move behind
  the specific facts.
- A primed insight brings up to three of the memories it rests on (its `causal` links), scored just under it
  (`MWA_PRIME_SOURCES`), so a conclusion arrives with its numbers.
- The knowledge block tells the model that a number, threshold, date or name is given exactly, not paraphrased,
  and the system prompt says to accept or reject outright when the record settles a proposal; "modify" needs a
  named change.

In the study and reconsolidation scripts (scratchpad, not shipped): positions formed from 700-character memories,
merges inherit the highest confidence of what they replace, insight-to-source links are written both ways, and
neither script calls `consolidate()` on a just-written store. The pruning itself is fixed in AWM's working tree
(threshold 0.90, grace-period age guard, canonical exempt), not yet in the build MWA pins.

Replay before the run (answer primed in the top twelve, 18 questions): reconsolidated store as shipped 7, with
query focusing 14, with the cap 14, with sources 15. The worst general attractor went from 17 of 18 questions to 6.

## Round 2 (2026-10-24)

| Arm | Model | Knows the project through | lookup | synth. | current | rationale | apply | lens | Score /54 | Consistent | $/answer |
|---|---|---|---|---|---|---|---|---|---|---|---|
| B2 | Luna | files + `search_files` | 5 | 5 | 6 | 0 | 0 | 0 | 16 | 89% | 0.010 |
| E2 | Sol | files + `search_files` | 9 | 8 | 9 | 9 | 7 | 4 | **46** | 83% | 0.658 |
| C2 | Luna | studied memory (rebuilt) | 6 | 2 | 9 | 8 | 6 | 1 | 32 | 83% | 0.013 |
| F2 | Luna | reconsolidated memory (rebuilt) | 6 | 4 | 9 | 9 | 6 | 1 | **35** | 78% | 0.015 |
| F3 | Luna | as F2, AWM confidence gate k=0.5 | 3 | 2 | 9 | 6 | 5 | 1 | 26 | 83% | 0.015 |

Round-1 arms for comparison: C 29 (3, 1, 8, 9, 8, 0), F 33 (4, 3, 8, 9, 6, 3), E 25 (4, 8, 6, 5, 2, 0).

### The file arms

With a search tool, the file arms are a different experiment:

| | B (Luna+files) | B2 | E (Sol+files) | E2 |
|---|---|---|---|---|
| Score /54 | 4 | **16** | 25 | **46** |
| `search_files` calls | — | 132 | — | 373 |
| `read_file` calls | 14 | 141 | 111 | 427 |
| `run_command` calls | 185 | 61 | 157 | 216 |
| Approval waits | 69 | 30 | 6 | 6 |
| Gave up ("couldn't verify") | 15 | 3 | 12 | 4 |
| $/answer | 0.007 | 0.010 | 0.386 | 0.658 |

Sol with the files and a search tool is now the strongest arm: every lookup, synthesis, current and rationale
question but one, seven of nine apply, and the first real lens passes (4 of 9). Its three remaining misses are
V2 (answers "modify" on a proposal BL-52 supports, all three times), A1 (hedges on whether a blocked run is
delivered) and V3 (does not find the shadow-promotion condition). It costs 66 times a Luna answer.

Luna with the files improved only on lookups. On every judgment question (rationale, apply, lens, and S2, C3) the
planner split the task into about ten sub-runs, each of which listed the folder again (50 to 80 `list_files`
calls per question, against 1 to 11 on the questions it passed) and then reported that it lacked the files. The
search tool fixed the lookups; the plan path is what loses the judgment questions for a small model, and it is
the next thing to look at (an open item below).

### The memory arms

The priming fixes did what the replay predicted and no more. Lookup went from 3 to 6 (C to C2) and 4 to 6 (F to
F2); current went to 9 of 9 in both; L2, the fact that was primed at #1 and paraphrased away in round 1, passed
all three repeats in both arms once the knowledge block said numbers are given exactly. Rationale and apply held
(8 to 9 and 6 of 9). The reconsolidated store stayed ahead of the plain studied store by three points, as in
round 1.

The confidence-gate arm (F3) lost nine points against F2 with the same store, mostly on lookup and rationale.
That matches the replay, where lowering the gate moved some questions up and others down: it is a trade, and AWM's
default stays.

Lens stayed at one of nine. The verdict rule changed the shape of the misses rather than the count: on V1 and V2
the memory arms now say reject or accept outright in several repeats (round 1 was "modify" twenty-seven times
out of twenty-seven), and F2 passed V1 once with the BL-30 figures; the remaining misses are a missing figure the
rubric requires (the pre-set ≥95% / ≤2% bar on V2, the BL-30 measurements on V1). V3 is the one real regression:
F passed it three times in round 1 by citing Clef's false-alarm rate (69 of 221 honest runs); neither rebuilt
store holds that figure. The second study pass over the same 82 documents did not record it, so the regression is
study-to-study variance, not the fixes.

Still failing in every memory arm: L3 (a code word inside one document; the study never stores it), S3 (the
BL-53 scores and which plan failed), and A1 (the arms say the run is blocked but not that the command is staged
as an approval card and the result delivered).

## What we take from it

- **Studied memory lets a cent-an-answer model answer like a team member on what the team *decided* and
  *why*.** F2 matched Sol-with-files on rationale (9/9), came within one on current (9 against 9) and apply (6
  against 7), at a 45th of the cost. That is the result the pilot was looking for, and it held across two rounds and
  two store builds.
- **It does not yet let it *judge* or *join*.** Synthesis (4 against 8) and lens (1 against 4) need the record
  in hand, and memory primes twelve items; the expensive model with a search tool reads until it has them. The
  verdict rule removes the hedging; the deciding numbers still have to arrive.
- **The round-1 file-arm numbers were a tooling artefact.** Give MWA a search tool and Sol answers 46 of 54.
  Luna with files remains weak (16) because of how the planner handles a judgment question over a folder, not
  because of the tool.
- **What was fixed in MWA earned its keep on exactly the questions the replay said it would** (lookup, current)
  and nowhere else. The remaining memory misses are study coverage (which facts a single cheap pass records) and
  priming reach on two questions, not ranking.
- **A single study pass is a sample.** Two passes over the same corpus by the same model disagreed on which
  facts to keep (Clef's 69/221 was in one and not the other). Study has to be deterministic about measured
  numbers, or run more than once, before memory can be trusted for lens questions.

## Open items

- Luna's plan-and-execute path on judgment questions over files: ten sub-runs that each re-list the folder.
  Either the planner should pass the files already found to the next step, or a question over a granted folder
  should not be decomposed at all.
- Study granularity and coverage: a code word or a single sentence inside a document is still not stored, and
  which measured numbers a pass records varies between passes (4 to 12 facts per document is a sample). A
  second, numbers-only pass per document, or a check that every number in a results table was stored, is the
  candidate fix. The `(from file.md)` pointer is only useful when files are also granted.
- S2 is out of reach by priming on every store configuration and needs the file; C2 (the current spend cap) ranks
  #38 to #40 in recall.
- AWM's redundancy-pruning fix, the confidence floor on supersede and the `embedding_model` stamp are in AWM's
  working tree and await a release MWA can pin.
- The lens questions need the rule *and* the record: with the record in hand (E2) the verdict rule produced the
  first passes; with memory the record still has to be primed.
