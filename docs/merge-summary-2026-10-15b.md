# Ready to merge: `build-loop`, second stack (2026-10-15)

The build loop stopped again at its cap of five unmerged items. This page is everything needed to
decide whether to merge, and what to do after. Nothing here has been merged, published or deployed.

## The decision

Merge `build-loop` into `master`. It is a **fast-forward**: `master` (`b030c9f`, the first merge) is
an ancestor, so no merge commit and no conflicts. Up to BL-07 it carries 8 commits, 35 files,
+2,848 / −210 lines, plus the commit that adds this page and the changelog.

The AWM submodule pin is **unchanged** at `8070751` (AWM 0.13.6) on both branches. (Separately, the
working copy of `vendor/agent-working-memory` in the main checkout is at AWM 0.17.0, not the pin.
The loop didn't touch it, and every gate ran in a clean checkout at the pin.)

## What is in it

| Commit | What it does |
|---|---|
| `55718cd` | Records the first merge in the queue and resets the stack. |
| `6ac2090` | **Release prep:** version 0.6.0 and its changelog. |
| `4d2fb25` | Your answers from the decision review: release, test model, Gallop cancelled, the order. Harnesses now run once per item. |
| `52b07ec` | **BL-05.** Goals own their jobs, and a structural budget stops jobs multiplying. |
| `390fe9a` | **BL-18.** One approval store for the web app and Telegram, kept across restarts. |
| `37e9ce9` | **BL-14a.** MWA can work on its own repo: unattended runs stage commands, a person approves them, writes into `.git` and its tricks are refused. |
| `ed27bd6` | **BL-06.** `serve` watches the inbox, so dropping a file works in Docker too. |
| `d1e34d6` | **BL-07.** Quiet hours hold Telegram pushes overnight. Jobs still run on time. |

Every item passed the same gates: typecheck, the full suite in a clean checkout at the pinned AWM,
`npm audit`, an isolated reviewer attacking the diff until nothing was left, then a Docker image
built from that clean checkout with both end-to-end harnesses and a live proof of the item. On the
final image: injection 0/8, scheduled delivery 6/6, suite **495/495**.

## What a person will notice

- **Pending approvals survive a restart**, and an action approved in the web app that Telegram staged
  runs in the Telegram process. The result comes back to that chat.
- **Drop a file into `/data/mwa-workspace/inbox`** and the container works it. Anything already
  sitting there is worked on the first boot after this upgrade, so check that folder before
  deploying. `MWA_INBOX=0` turns the watcher off.
- **Scheduled runs ask before running commands** that aren't simple reads, at most three per run.
  An approved command can run for up to 15 minutes. Approving a check run on MWA's own repo runs that
  code as you, and the card says so.
- **Goals:** "my goal is …" in a chat creates one, and jobs serving it are tied to it. Follow-up jobs
  can't fan out past the budget, and the person is told once when one is refused.
- **Quiet hours** only matter where the Telegram connector runs (not in the Docker image on its own).
  Telegram messages wait until morning, with one message per job.

## After merging

1. **Rotate the npm token first.** The one pasted into chat earlier is still live.
2. Publish **0.6.0** (`package.json` and `CHANGELOG.md` are ready; the changelog now covers BL-05,
   BL-18, BL-14a, BL-06 and BL-07).
3. Redeploy the Railway dogfood.

## Still waiting on you (in the decision review doc)

- **Cheaper test model:** deploy gpt-5.4-nano on the Azure resource (yes/no). Only gpt-5.4-mini is
  deployed now; nano would run the non-blocking smoke tests, and mini stays the gate.
- **Cost cap:** raise it to $15 (yes/no). The loop has spent **≤ ~$8.00 of $10.00**.
- **BL-14 B or C:** how check runs could go unattended, either a sandboxed runner or a Developer-mode
  VM. Until then, every check run needs your tap.
- **BL-14b:** a live self-build needs you present to tap the approvals. The loop skips it until then.

After a merge, the loop continues with BL-08, BL-13, BL-16, then BL-09 to BL-12.

## Known residuals (not new)

`npm audit --omit=dev` shows the same 8 advisories as after BL-15: 0 critical, 2 high, 6 moderate.
The highs are `sharp` under AWM's `@huggingface/transformers`. MWA and AWM use transformers only for
text, so no image reaches sharp, and the fix is AWM's transformers 4.x upgrade (an AWM task). The
moderates include `sprintf-js` under `mammoth → argparse`, which is mammoth's command-line
dependency, and MWA calls only its library.
