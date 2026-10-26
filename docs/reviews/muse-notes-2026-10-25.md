# Meta Muse — what it does, as publicly described (gathered 2026-10-25)

Sources: Meta's announcement (about.fb.com/news/2026/09/introducing-muse, 2026-09-08), KDnuggets explainer,
Upstox / VKTR / eesel / Relevant Audience coverage via search. Not independently tested; reliability claims are Meta's.

## The shape
- A personal agent you give a GOAL, not a prompt. Its model (Muse Spark 1.3) plans, uses tools, acts, monitors
  progress, and comes back when it needs input. Complex jobs spawn subagents that work in parallel.
- Each user gets an isolated Linux VM ("Muse Secure VM") holding workspace, files, browser, tools, running tasks and
  state between sessions. Inside it Muse can browse, work with files, run code and command-line tools, schedule
  recurring jobs, and write small programs to reach services that expose an API or CLI.
- Surfaces: iOS, Android, muse.ai, WhatsApp; AI glasses "coming soon". US only. Free for most use, paid tiers above.

## Browser capabilities
- Its own browser inside the VM, for sites with no connector: open sites, fill forms, negotiate on the user's behalf,
  book travel, make reservations, shop.
- Credentials: stored secrets usable by Muse without Muse seeing them; cannot see passwords typed into the browser;
  1Password and Shop Pay "coming soon".
- Checkout through Stripe's Link with a one-time-use card so the real card stays hidden; Link purchase protections.
- Websites can block agents (Amazon has blocked Muse).

## Control model (the part MWA should compare itself to)
- Sentinel: a separate system-level agent on the same VM, isolated from Muse, that is the permission authority.
  Every proposed action is allowed, blocked, or sent to the user for approval; ALL outbound network traffic passes
  through it.
- Split permissions per connector: read email without being allowed to send it. Access can be changed or revoked
  at any time.
- Asks before sensitive actions: sending an email, making a purchase.
- Prompt-injection defences: untrusted-content labels, detection classifiers, browser restrictions, system
  isolation, human approval gates. Meta says it "can and will still make mistakes".
- A complete audit trail of what it has done and plans to do.

## Background work and memory
- Keeps working after the app is closed; returns when something changes or an approval is needed.
- A Goals system tracks long-term objectives (monitor flight prices, find a cheaper phone plan, organise a move)
  and makes unprompted suggestions.
- Memory across conversations, inspectable and editable; "forget" on request; acts on details mentioned once.

## Example tasks Meta gives
- Trip: find flights and hotels within a budget that fit the calendar, bring choices back for approval.
- Shopping: research products by size, price and reviews; buy with the one-time card after approval.
- Email: summarise threads, find information, draft, send with permission.
- Dinner: check availability, find a reservation, ask preference, book, add to calendar.
- Research: gather from several sources, reconcile conflicts, produce a deliverable.
- Recipe reel → grocery list; remember friends' dietary restrictions before sending invites.

## Where MWA already stands (for the comparison)
- Has: own Chromium browser per person (signed-in profile), numbered controls, vault secrets used without being
  seen and only on their own site, consequential-click hold with a go-ahead, approval cards a person taps, split
  permissions by preset and by connector (email drafts only, never sends), audit trail (run log, action log, Glass
  Box), goals and scheduled jobs, background work that returns, memory with provenance and trust, injection fencing
  and taint lineage, a network guard on every browser request.
- Lacks or partial (to confirm in the review): a separate approver process (MWA's gate is in-process), scrolling /
  tabs / back / find-on-page / downloads in the browser, payments and one-time cards, unattended sign-in (vault refs
  are refused once a run has read outside content, and every page read is outside content), subagents in parallel,
  code execution inside an isolated VM (MWA has a sandboxed check runner and a shell gate instead), WhatsApp.
