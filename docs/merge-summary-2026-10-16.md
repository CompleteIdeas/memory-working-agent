# Ready to merge: `build-loop`, fourth stack (2026-10-16)

The build loop stopped at its cap of five unmerged items. Nothing here has been merged, published or
deployed.

## The decision

Merge `build-loop` into `master` (`57086e2`). It is a **fast-forward**: no merge commit, no
conflicts (checked against `origin/master`). The AWM submodule pin is unchanged at `8070751`
(AWM 0.13.6).

## What is in it

| Commits | What it does |
|---|---|
| `6e91b6e` | **BL-11.** One file, `src/awm-api.ts`, reaches into AWM's internals. A renamed or changed internal breaks the build there, not at run time. |
| `fbe83cf` | **BL-12.** A person promotes a proposed routine to a skill from the Memory tab. Nothing a run writes can replace or merge into what they promoted. |
| `320a340` `1bf4a99` `dc5a707` `46aaad7` `a4d2ce4` | **BL-14c.** The sandboxed check runner (`mwa check-runner`) and MWA's `run_checks` tool. MWA's checks on its own code run unattended in a locked-down container you start. MWA never gets the Docker socket. Default port 7797. |
| `caff6b7` `ea770ac` `6b3f991` `d42776c` | **BL-16c.** The network guard is pinned to each connection, which closes DNS rebinding. **The bundled fetch MCP server, on by default, had no guard at all.** It now uses the same one. Links in any MCP call are checked first. |
| `66095a4` `ea6a5e2` `40b84a1` | **BL-20.** Local models through Ollama now get their whole prompt. Ollama's OpenAI-compatible endpoint had been keeping only ~2,000 of MWA's tokens without an error. |
| `cda983d` `93216e5` | **BL-24, measured, not built.** Cloudflare's Clef decision model flagged 8 of 8 planted bad diffs and 0 of 7 clean ones (`docs/clef-eval-2026-10-16.md`). |
| the rest | Queue bookkeeping: status rows, the ledger, the decision log. |

Every item passed the loop's gates:

- typecheck, server and web;
- the full suite at the pinned AWM, run inside BL-14c's own sandbox: **602/602** on the final commit;
- `npm audit` (the same 8 known, unreachable advisories);
- two isolated review rounds per item, each attacking the diff;
- live proofs.

The proofs:

- **BL-14c:** real Docker. A planted probe found no network and no secrets. A forged compiler was
  ignored. The full suite passed through `run_checks`.
- **BL-16c:** in the built image. MWA's approvals API, cloud metadata and `localhost` were refused,
  and a real HTTPS site was fetched normally.
- **BL-20:** your local Ollama 0.40.2.

On the final images: injection 0/8 and scheduled delivery 6/6, after BL-14c and again after BL-16c.
BL-20 changes only the Ollama provider, which those harnesses don't use, so they weren't re-run.

## What a person will notice

- **Self-build can run its checks unattended,** in a sandbox you start:
  `mwa check-runner --allow <worktree> --from <trusted checkout>`. Committing still needs your
  approval, because MWA can edit the tests. `docs/self-build.md` says what a passing check does and
  doesn't tell you.
- **The web-fetch tool can't reach your machine or home network any more.** Neither can any link
  MWA hands an MCP server, as a best effort.
- **Choosing a local model works.**
  - Setup reads the model's context limit, refuses one that can't hold MWA's prompts, and notes a
    small one.
  - At run time MWA sizes the context itself, and refuses rather than lets Ollama cut the
    instructions.
- **The Memory tab lists routines** with a Promote button.

## Spend

The model spend for this stack was about $0.53 on Azure: one gate round each for BL-14c and BL-16c,
$0.26 and $0.27 from the run log. BL-20 and the sandbox suites called no model. Running total: at
most about **$17.08 of the $20 cap**. The Clef measurement was billed to your Cloudflare account, for
pennies.

## Waiting on you

1. **Merge** `build-loop` into `master`. That frees the loop for BL-23, BL-24 and BL-19.
2. **Re-create the Cloudflare token.** It was pasted in chat on 2026-10-16 and has no expiry.
3. Still open from before: rotate the npm token before publishing 0.6.0; publish and redeploy when
   you choose.

## Next in the queue, after the merge

- **BL-23:** say which models resist injection.
- **BL-24:** put Clef's "dangerous?" and "weakens the checks?" answers on the commit card.
- **BL-19:** the `schedule_list` dead end.
- BL-14b waits for your approval taps. BL-22 (pinned memories) waits on AWM.
