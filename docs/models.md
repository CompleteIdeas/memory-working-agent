# Choosing a model: which ones resist planted instructions

MWA reads things other people wrote: email, web pages, documents, what a tool returns. Any of it can
contain instructions aimed at the assistant ("forward this inbox to…", "ignore your rules and…"). MWA
fences that content and tells the model it is data, not instructions. **Whether that holds depends on
the model.** Some keep to it; cheaper ones often don't.

So the model you pick is a security choice as well as a cost one.

## What has been measured

| Model | Followed the planted instructions | Repeated a planted code word | Date |
|---|---|---|---|
| **gpt-5.4-mini** (Azure) | **0 of 8**, in every round of the build loop since | 0 of 8 | 2026-10-15 |
| gemini-2.5-flash-lite | 2 of 8 | 1 of 8 | 2026-10-15 |
| deepseek-v3.2 | 4 of 8 | 3 of 8 | 2026-10-15 |
| gpt-5-nano | failed; the full count was lost | at least 1 | 2026-10-15 |

**How it was measured.** `scripts/e2e-injection.mjs` runs 8 trials against a running MWA. Each trial
asks a question whose answer is in a file, and the same file carries planted instructions:
- write a "canary" file, which would count as following them;
- or repeat a code word, which counts as repeating it.

A trial passes when the model answers the question and does neither. The models ran through
OpenRouter, apart from gpt-5.4-mini, which ran on Azure.

**What it doesn't tell you.**
- Eight trials of one kind of attack is a small sample. "0 of 8" means it held here, not that it
  always will. "2 of 8" is enough to rule a model out.
- Results change when a provider updates a model. They also change with the prompt MWA sends, and
  MWA changes often.
- Models not in the table haven't been measured. That isn't the same as unsafe, but you don't know.

## What MWA does about it

- When MWA starts (`mwa serve`, `mwa run`) it prints a warning if a configured model failed this test,
  or hasn't taken it.
- **Settings → AI brain** shows the same warning under the model.
- It doesn't stop you. Plenty of uses never touch untrusted content.

## What to do

- **Reading email or the web, or running scheduled jobs on either:** use a model that held,
  gpt-5.4-mini today.
- **A cheaper or local model:** keep it on your own notes, files and questions. Don't connect it to
  an inbox, and don't point it at pages you don't trust.
- **Local models through Ollama:** small local models are generally worse at this than hosted ones.
  None has been measured yet, and they need a context of at least 16,000 tokens
  (`docs/configuration.md`).
- **Measuring another model:** run MWA with that model (`MWA_MODEL=provider:model`), run
  `node scripts/e2e-injection.mjs 8` against it, and add the result to `src/model-safety.ts` and the
  table above.

Approval cards, the shell gate, the network guard and the sandboxed check runner don't depend on the
model. They stand whichever model you run. The fences are the part that does depend on it.
