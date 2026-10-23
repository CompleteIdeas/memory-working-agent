# Merge summary, 2026-10-22: MWA you can come back to, and fewer "yes" taps

Branch `bl72-approvals` (on top of `8bd3c57`, which is `master` and what Railway runs). 15 commits. Nothing is merged or deployed. Full suite: 1099/1099.

## What changes for Robert

**Coming back**
- **Conversations stay.** Every chat turn and every background result is kept on the server.
  - Reloading the page, a deploy or another device reopens the conversation.
  - A list lets you reopen any earlier one; "+ new" starts a fresh one.
  - A gap alone no longer silently starts a new topic.
- **Sign-ins survive deploys.** A deploy used to sign you out. Changing the password still signs everyone out.
- **Welcome back.** After more than two hours away, the chat opens with what moved: goals, results, questions, approvals waiting.

**Work that keeps going**
- **"Want me to work on this and get back to you?"** A request that researches and writes something up gets the offer. "Work on it" runs it in the background in the same conversation's folder, and the result comes back there. "Do it now" keeps it in the chat.
- **Work tab.** Shows every goal and where it stands (files, next step, what it waits on). It has Continue, Open its conversation, Mark done and Pause.
- **"What were you working on?"** works. Each goal keeps a "where we are" record that recall finds. MWA can open files from any of your earlier chats.
- **Thinking time.** Built, but **off** until you pick how often. Between conversations MWA proposes one next step or question per open goal. It only proposes and never acts.

**Fewer approvals**
- **More commands run without asking.** Read-only commands like `date -u` and `sed -n '55,260p' notes.md` now run directly. The `sed` read was the approval that expired and left your newsletter report blocked.
- **Clef reviewer** (your choice). Shadow mode is on whenever `MWA_CLEF_TOKEN`/`MWA_CLEF_ACCOUNT` are set. It reviews every approval and logs what it would have done next to what you did, and changes nothing.
  - `MWA_AUTO_APPROVE=on` lets it run what it passes. That mode has been through two rounds of review.
  - **Recommendation: leave it off until a week of shadow data agrees with you** (`scripts/approval-shadow-report.mjs`).
- **Files area** (BL-70, from earlier today).

## Evidence
- **Calibration:** `docs/approval-calibration-2026-10-22.md`. Clef at 0.7 had 0 unsafe of 41 at 0.32 s. Jev Router sends each call to a different model.
- **End to end in Docker** with gpt-6.1-sol on US hosts:
  1. The newsletter-style request got the offer.
  2. The background job wrote `mwa-brief.md` and its record in about 3½ minutes.
  3. The result appeared in the conversation.
  4. A brand-new conversation asked "what were you working on? pull up the brief" and quoted its first bullet.
  The second round (restart, follow-up, thinking pass) is in the session report.
- **Isolated reviews** (fresh context, adversarial): 71c and the shell list, 2 rounds; 71a/b/d, 1 round; BL-72 live, 2 rounds; 71e, 1 round. Every high and medium finding is fixed, and each attack is a test.

## Deploying it
1. Merge `bl72-approvals` (fast-forward), push, `railway up --service mwa --ci`.
2. Add Railway variables `MWA_CLEF_TOKEN` and `MWA_CLEF_ACCOUNT` to start shadow mode. The Cloudflare token expires 2026-10-30.
3. Leave `MWA_AUTO_APPROVE` and `MWA_THINK` unset until you decide.

## Decisions for Robert
1. Merge and deploy?
2. Thinking time: how often, and the daily cap. The suggestion is every 4 h and $1 a day.
3. When to turn on automatic approvals: after a week of shadow data.
4. Telegram and the web app still have separate memories. Joining them is the next piece of "one MWA everywhere".
