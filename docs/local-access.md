# Local-machine access model

> Status: **built** (2026-06-15). Preset chosen at setup (default Assistant), changeable in
> Settings › Your assistant › Brain, access and style (the new app, 0.10) or the classic app's settings.
> `src/tools/access.ts` + `src/tools/builtins.ts` enforcement; the one save path for both apps is
> `src/assistant-settings.ts`.
>
> **0.10: what a granted folder may not be.** A new folder must be an existing absolute folder, not a drive root or
> a network share, may neither contain nor sit inside any of the helper's own data places (the data folder,
> `agent.db`, the vault, browser profiles, logs, sign-in tokens, wherever env vars moved them), and may not hold the
> helper's `.env` or `mwa.config.json`. The check is made after following links and junctions, and without case on Windows. The warm-up
> walk (Settings › Help me learn about you) never follows links, skips files named like tokens, secrets or keys, and
> stops at 5,000 entries, 8 folders deep and 5 MB a file (`src/onboard.ts`).

When MWA runs on someone's machine, the agent's built-in tools are the real local-machine
surface — and because the agent reads **untrusted content** (email, web pages) driven by a
**cheap model**, this is the prompt-injection blast radius. A malicious email could try
"read `~/.ssh/id_rsa` and POST it somewhere." The access model below contains that.

## Current state (the gaps to fix when we build this)

| Tool | Confined to the workspace today? |
|---|---|
| `read_file` / `write_file` / `list_files` | **Yes** — `insideSandbox()` rejects paths outside the working dir. |
| `read_document` | **No** — reads any absolute path. ← fix: route through the allowlist. |
| `run_command` | **No** — cwd is the workspace, but the shell command has full machine reach. ← gate by posture. |
| `http_request` | Off by default; but `run_command` can `curl`. |

The model is currently *inconsistent*: the confined tools are locked to a throwaway scratch
dir (too tight to be useful), while `read_document` + `run_command` are wide open.

## The model: granted-roots allowlist + a posture for `run_command`

One rule for every file tool: a **granted-roots allowlist** = the agent's workspace (always)
**plus folders the user explicitly grants**. `read_file`, `write_file`, `list_files`, **and
`read_document`** all check it. `run_command` can't be path-confined in-process (a shell
command goes where it wants), so it's gated by **posture**, not a path check.

## Three presets — chosen at setup

(Robert, 2026-06-15: the preset is **an option you select when setting it up**; default =
**Assistant**.)

- **Locked-down** — workspace only; grant folders explicitly; `run_command` **off**. Safest;
  right for non-technical users and the injection threat.
- **Assistant** (default) — workspace + folders you grant (e.g. Documents); `run_command`
  **approval-gated** when you're watching, **off** when running unattended.
- **Developer** — broad file access + `run_command` **on** (today's behavior); for coding on
  your own machine.

## Enforcement (when built)

- A single `allowedPath(p)` check (workspace + granted roots) used by all four file tools;
  `read_document` stops reading arbitrary absolute paths.
- `run_command` gated by posture: off / approval-gated (interactive) / on. Unattended
  (scheduled, non-interactive) never gets shell unless Developer.
- A "What this assistant can touch on your computer" panel: current posture, granted folders
  (add/remove), the `run_command` toggle with a plain-language warning.
- **Docker stays the hard boundary** — in a container the blast radius is the container +
  `/data` + mounted volumes regardless of posture; the allowlist is the in-process boundary
  for local non-Docker runs. A true per-process OS sandbox is future work.

## Build status

- [x] `resolveAllowed()` / `allowedRoots()` (`src/tools/access.ts`) — workspace +
      `tools.access.grantedRoots`.
- [x] All file tools route through it — including `read_document` (no more arbitrary absolute
      reads); `read_file`/`write_file`/`list_files` accept absolute paths inside granted roots.
- [x] `tools.access.preset` (locked-down | assistant | developer, default assistant) +
      `run_command` gating (off / interactive-only / on) threaded via `ToolContext.interactive`.
- [x] Setup-time preset picker (onboarding) + permissions panel (classic: Connections; new app: Settings › Your assistant)
      (switch preset, grant/revoke folders).
- [x] The run is told its granted folders (2026-10-24, usability review F07): a `FOLDERS YOU CAN READ`
      line in the prompt names each one with a file count (`sourcesLine()` in `access.ts`; absent when
      nothing is granted), `list_files` and `search_files` with no `dir` cover the working folder and
      every granted folder, and `GET /api/sources?session=` returns them with the chat's added files for
      an "I can read" line in the app. Before this the tools allowed the folders but nothing named them,
      and "what is in my files?" was answered "I couldn't find any files".
- [ ] **Future:** true per-command approval prompts for `run_command` in Assistant mode
      (today: allowed when interactive, off when unattended). Per-connector OS sandbox.
