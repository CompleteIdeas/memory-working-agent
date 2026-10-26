# Production review — what we tried on mwa-production, and what it needs (2026-10-27)

Read-only review of https://mwa-production.up.railway.app (v0.9.0 at the time of reading; the runs below happened
on 0.7.x–0.8.1) through its API: 9 conversations, 25 turns, 55 runs, 7 result notices, 25 logged actions, 3
approval cards, 0 scheduled jobs, 1 goal, 27 derived skills, 23 lessons, 0 standing preferences. Spend over the
period: $11.01 across the 55 runs. Gmail is connected (app password); Telegram, Outlook and a calendar are not; the
access preset is *assistant* with no granted folders; the model is gpt-6.1-sol through OpenRouter.

## What was tried, and how it went

| When | Ask | Outcome | Cost |
|---|---|---|---|
| Oct 20 | Connect Telegram | The setup card was shown; never completed. | $0.03 |
| Oct 22–23 | Research AI news and write a newsletter draft (chat, then "Work on it", then "try this again") | A draft exists with five takeaways, but only one or two developments in the week were verified. Nine of the twelve runs ended `budget` or `stuck`: planned sub-steps capped at 24 steps, a resume chain that posted "stuck" results after the first result stood, repeated web fetches that returned the same truncated opening. The goal is still `in_progress` and "stuck" with no job. | $3.1 |
| Oct 25 | "Learn everything you can about the rules of eventing" from an uploaded PDF, then "what are the rules around moving up a level", "you might have to read some of those pages visually" | Never answered. `read_document` returned excerpts without the qualification tables; the run asked to run `pdftotext` (an approval card, then "pdftotext isn't installed"); a fallback script had no PDF tools; 13 tool refusals across the session (shell commands held in the assistant preset); two budget cut-offs ($0.81 and $0.33) and a resume that "cannot see the verification notes". | $3.2 |
| Oct 25 | "Read thru my email and give me a triage of any important items" | A useful partial triage (phone-service interruption, a Google security alert, school dates), then budget at 19 steps "after reading several long messages"; the resume could not recover the findings because none were saved to a file and ended `stuck`. A follow-up on the school newsletters worked well. | $1.1 |
| Oct 25 | Add family dates and the book fair to the calendar | `.ics` files were made for import, because "Google Calendar requires sign-in"; a validation script needed an approval card. | $0.4 |

Run outcomes: 22 done/changed, 6 done/blocked (an approval card waiting), 7 budget/could-not, 4 stuck/could-not, 4
done/could-not, 3 budget with no outcome. Fifteen refusals in all, thirteen of them in the eventing session.

What 0.9.0 already changes for these: a resume that finds the earlier work finishes quietly instead of "stuck" (3d);
a plan's later steps get the files earlier steps found (3c); one-time codes are hidden from the model (4c — the
Google alert's verification code was in the triage); a tab or file the browser gets is handled (4d/4e); a job's
steps show in the Work view (5e). None of them give the eventing session its answer, or the triage its coverage.

## The gaps, by weight

1. **Reading a PDF.** The whole eventing session failed on this. `read_document` gives excerpts (a size cap) and no
   page images; the model's only way to "read it visually" was a shell command, which the assistant preset holds
   for approval, and the Railway image has no `pdftotext` anyway. Needed: in-process PDF text by page range (no
   shell, no poppler), the tables kept, and **page images for `browser_look`-style reading** of the pages the text
   cannot carry — the person literally said "you might have to read some of those pages visually".
2. **Reading on.** Three lessons say the same thing: repeated reads of a document or a page "returned the same
   truncated opening". `read_document`, `fetch` and `read_file` need an `offset` / "read on from here" the model
   is told about, and the cap message should say how to continue.
3. **Findings that survive a cut-off.** The email triage and the newsletter both lost work at a budget boundary
   because the findings lived only in the run's context. A run on a long task should write its findings to a
   file as it goes (`notes.md` in its folder) so a resume, a plan step or the person can pick them up; the resume
   framing should ask for that file first.
4. **The budget on a long chat task.** 40 steps / 10 minutes / 24-step plan steps ended seven runs. "Learn
   everything you can about…", "read thru my email and triage" and "research … and write" are background work;
   the offer fired for the newsletter but not for the eventing or the triage asks. Widen `offersBackground` to
   "learn everything / go through / review all / triage my inbox", so these run with a job's budget and a record.
5. **A calendar it can write to.** Twice the answer was an `.ics` file to import by hand. A Google Calendar (and
   Outlook) connector with OAuth, or at least a documented path, so "add this to the calendar" adds it.
6. **Email triage as a skill, not an improvisation.** Gmail works; the model improvised a triage and ran out of
   room after reading long messages. A built-in routine: list by sender and subject, rank, read the top N by
   budget, save findings as it goes, report by urgency; a daily job the person can schedule from Settings.
7. **Research quality.** One or two verified developments a week is thin. The trusted-sources checklist exists
   (memory 2026-10-23); the search tool should run several dated queries and dedupe; the browser (now with find,
   back and tabs) should open the story, not the listing, per the guide.
8. **Derived skills pile up.** 27 skills and 23 lessons from nine conversations, with near-duplicates ("verify
   eventing move-up rules" three times, "triage important email" twice). Dedupe by name similarity at write time
   and show them in Memory with a Forget.
9. **A stuck goal with no job.** The newsletter goal is `in_progress`, record "Stuck", no job, since Oct 23. The
   Work view should say so and offer Continue or Close; a goal untouched for a week should be flagged in the
   welcome.
10. **Telegram never finished.** The setup card is correct; nothing followed. Not a code gap.

## Skills and tools to add (in order)

- **`read_document` v2**: PDF and DOCX text by page range in process (`pages: "3-5"`, `offset`), tables kept,
  and `document_look(page)` giving the model the page as an image (same path as `browser_look`). The uploads
  folder is the input. Removes every shell command from the eventing session.
- **"Read on" for every reader**: `offset`/`next` on `read_document`, `fetch`, `read_file`, with the cap message
  naming the next call.
- **Findings file on long tasks**: the run writes `notes.md` as it goes when a task is research, triage or
  learning; resumes and plan steps read it first.
- **Background offer for learning and triage asks**; the job budget (60 steps / 20 min) for them.
- **Calendar connector** (Google first, Outlook after), with the `.ics` fallback kept.
- **Inbox triage routine** (built-in skill + a Settings toggle for a daily job).
- **Search: several dated queries, deduped**, and the trusted-sources checklist applied.
- **Skill dedupe at write time**, and Memory shows derived skills with Forget.
- **Stale goal handling** in Work and the welcome.
