# MWA building itself, with a person at the gates

MWA can work on its own repository as a scheduled job. It reads the build queue, drafts the next
change in a folder of its own, then asks you to approve running the checks. A later run of the job
reads what the checks printed and fixes what failed. Committing is a separate approval. MWA never
merges, publishes or deploys.

This is the human-in-the-loop version (BL-14a). It covers the typecheck and the test suite. The
Docker image and the end-to-end harnesses stay with whoever runs the build loop.

## The one thing to understand

**Approving a check run executes the code MWA wrote, as you.** Tests run the code. That run has your
files and your network. MWA's API keys and tokens are stripped from its environment, but it can still
read any file you can, including the `.env` in your main checkout that holds them. Until it runs, nothing MWA writes executes. Once you approve, your review of the change
is the only safeguard. So before you tap Approve on a check run, look at the change: open the folder
and run `git diff`. The approval card says this too.

If you want checks to run without that review, that's a different setup; see the options at the
end.

## What MWA can and can't do on its own

- **It works in Assistant mode, never Developer mode.** In Assistant mode a job nobody watches runs
  no commands at all. It can only ask: every command it wants becomes an approval card, at most 3
  per run, valid for a day. Developer mode has no boundary: its shell can reach MWA's own approvals
  endpoint and approve itself.
- **It writes only in the folders you grant,** checked against their real location on disk, so a link
  can't lead the write elsewhere.
- **It never writes where git or your editor runs code:** `.git`, `.husky`, `.githooks` or `.vscode`
  (a task there can run when you open the folder). Spellings that reach them
  sideways are refused too: Windows short names like `GIT~1`, file streams (`name:stream`), and
  names ending in a dot or space. A hook written there would run on your next `git` command,
  including one you type yourself.
- **Each card shows the exact command,** with a warning first when it reaches the network or this
  machine.
- **The job can't multiply.** BL-05's limits apply: at most 2 follow-up jobs per job, 2 levels deep.
  It can't create or change goals on its own.
- **It sees results as outside content.** What a check printed comes back fenced, and it taints the
  run, because it can echo whatever the code printed.

## Setup

1. Make a worktree for MWA on its own branch, outside your main checkout, and make it buildable:

   ```sh
   git worktree add ../mwa-selfbuild -b selfbuild/next build-loop
   cd ../mwa-selfbuild
   git submodule update --init vendor/agent-working-memory
   npm install
   npm run build:awm
   ```

2. In the app, open **connect**. Under "what it can touch on this computer", choose **Assistant**,
   then add the worktree folder under **Granted folders**.
3. Make sure you'll see the approval cards: the web app, or Telegram with your chat in
   `TELEGRAM_ALLOWED_CHATS`.
4. In a chat, ask MWA to schedule the job, giving the worktree's full path. For example:

   > Every 30 minutes, work on MWA in `<worktree path>`. First check approval_results: if the last
   > checks you asked me to approve failed, fix what failed. Otherwise read `docs/build-queue.md` in
   > that folder, take the first `ready` item, and draft the change there. When it's ready, ask me to
   > approve running `cd <worktree path> && npm run typecheck && npm test`. When the checks pass, ask
   > me to approve committing the files you changed, by name, to the current branch.

   Give it a contract: `until` "the item is marked done in the queue", and `limits` "never merge,
   publish or deploy; only touch files in that folder".

Commands run in the job's own working folder unless they `cd` first, so keep the `cd` in each
command. An approved run may take up to 15 minutes (`MWA_APPROVED_COMMAND_TIMEOUT_MS`), and it runs
in the background without stalling the app.

## What you'll see

- A card: "Run this command in …: cd <worktree> && npm run typecheck && npm test", followed by the
  warning that approving runs the code in that folder.
- After you approve: the result in the chat. A failing run is recorded as failed, with the end of
  its output, where the test summary is. The job's next run reads it with `approval_results`.
- When the checks pass: a card to commit named files, which you approve or decline.

## Running the checks without a person: your call

| Option | What it is | What can go wrong |
|---|---|---|
| **A. You approve each check run (built)** | This page. | Approving without reading the change: the code runs as you. |
| **B. A sandboxed check runner (built, BL-14c)** | The checks run in a throwaway container with no network, on a copy of the folder, started by a runner you start, with one fixed request: "run the checks on worktree 1". See below. | If MWA itself gets the Docker socket, it effectively has the host. The runner never accepts a command line, mounts or environment, and MWA never gets the socket. |
| **C. Developer mode on a VM of its own** | The VM is the boundary. It holds only the repo, a model key and a deploy key limited to a fork. | Everything on that VM is the model's. Boundaries rot when "one more secret" gets added. |

B is the only option where model-written code runs without a person and without your power. A
second model also recommended starting with A, and moving to B, never with the Docker socket in
MWA's hands, once A has shown the job is worth it.

## Option B: the sandboxed check runner

Start the runner yourself, on the machine with Docker. Name the worktrees MWA may have checked, and a
**trusted** checkout the sandbox image is built from:

```sh
mwa check-runner --allow ../mwa-selfbuild --from .
```

`--from` must be a checkout MWA doesn't edit, such as your main one. The image's dependencies,
toolchain and AWM come from there, so MWA can't change them. The first start builds the image, which
takes a few minutes. It is rebuilt only when the lockfile or the AWM pin changes. The runner prints a
URL and a token, and the token is new each time it starts. Give both to MWA:

```sh
MWA_CHECK_RUNNER_URL=http://127.0.0.1:7797
MWA_CHECK_RUNNER_TOKEN=<the token it printed>
```

If MWA runs in Docker, start the runner with `--listen 0.0.0.0:7797` and use
`http://host.docker.internal:7797`. The runner warns you, because then anything that can reach that
port and has the token can ask for a check run.

MWA then has a `run_checks` tool, and the job's instruction changes from "ask me to approve running
the checks" to "run the checks with run_checks". Committing still needs your approval.

**What a check run can and can't do.**

- **Fixed commands.** It runs `tsc --noEmit` and `vitest run`, never `npm run`. MWA writes the
  worktree's `package.json`, so its scripts are MWA's to choose.
- **The toolchain is yours.** The compiler, the test runner and every dependency come from the image
  built from `--from`. A `node_modules` in the worktree is never staged.
- **Your files stay out.** It sees a copy of the worktree's files: the tracked ones and new ones that
  git doesn't ignore, never a `.env` or a `node_modules`. A symbolic link, a hard link, a folder that
  links somewhere else, an oversized file or too many files stop the run. The AWM submodule comes from
  the image. Listing the files can't make git run a program from the worktree's settings.
- **The container is locked down.**
  - It has no network, a read-only system, and a size-capped scratch area.
  - It runs as an unprivileged user with no capabilities.
  - Memory, CPU, processes and open files are limited, and it is killed after 15 minutes.
- **One run at a time.** The copy is deleted afterwards. MWA starts a run, then reads its result. It
  waits up to five minutes (`MWA_CHECK_RUNNER_WAIT_MS`). A longer run keeps going, and MWA reads its
  result later by the run's id.
- **What it printed comes back to MWA as outside content.** It is fenced and taints the run, which
  stops that run from saving lessons as trusted or scheduling follow-ups. A check run isn't counted as
  a change on your machine, because nothing on it changes.

**What a passing check does and doesn't tell you.** The sandbox protects your machine. It doesn't make
the result trustworthy: MWA can also edit the tests, `tsconfig.json` and the vitest config, so a change
that weakens them can pass. That is why committing still needs your approval. Look at the diff, not
just the green result.

The tests still run code MWA wrote. That is what a check is, and why it happens in the sandbox rather
than as you.

## A second opinion on the commit card (optional)

A passing check doesn't mean a good change: MWA can also edit the tests. To help with that review,
a decision model can read each change MWA asks to commit and answer two questions at the top of the
card: "does it contain dangerous code?" and "does it weaken the checks?". It also says when the change
reaches outside the repository (network, secrets, other files), as information. Turn it on in `.env`:

```sh
MWA_SECOND_OPINION=cloudflare:clef-flash     # or cloudflare:clef, slower and larger
CLOUDFLARE_ACCOUNT_ID=<your account id>
CLOUDFLARE_API_TOKEN=<a token with Workers AI permission>
```

What to know:

- **It sends the change to Cloudflare.** Env files (`.env`, `.env.local`, …) are never sent. Values
  that look like secrets (private keys, common API-key and token formats, passwords in URLs, values
  assigned to names like `SECRET` or `TOKEN`) are blanked first. That is pattern matching, so it
  will miss some: keep secrets out of the repository anyway.
- **It's advisory.** It approves and blocks nothing, and it can be wrong, including when the code it
  reads tries to talk it out of a flag. A card with no flags still says to read the change, and every
  probability is shown.
- **It reads everything the commit could take.** That is what is staged, plus the working-tree files
  the command can take: all tracked files for `-a`, `add -u` or `add -A`, and the files matching the
  paths a `git add` or `git commit` names. Git itself matches those paths, so globs, folders, case and
  `-f` work as they do for `git add`. It may read more than the commit takes, never less. A plain
  `git commit` reads only what is staged. Line-ending differences alone don't count as changes.
- **It only speaks to a plain add-and-commit:** `[cd <folder> &&] [git add … &&] git commit -m …`,
  with the common options spelled out in full. For anything else, such as other commands in the chain,
  `git -C`, aliases like `git ci`, `merge`, a variable, a pipe, `apply --cached`, an abbreviated option,
  or a repository mid-merge, the card says "Second opinion: not given" and why, and is exactly as it
  would be without the feature. It never guesses at what an unusual command commits.
- **It says when coverage is partial:** binary, linked or large files it didn't read, env files it
  held back, submodules, `--amend`, commit hooks, `-c` overrides, a command that runs other steps
  first or builds part of itself, and a change cut at 40,000 characters.
- **The card is bound to the change.** A fingerprint of the raw content of everything that was or
  could be committed is kept with the card, including files it didn't read. If anything there changes
  before you approve, approving commits nothing, and the run is told to ask again.
- **It only reads a repository whose top folder the run may use.** A granted subfolder of a bigger
  repository isn't read.
- **Measured** on 15 hand-written changes: with both questions, 8 of 8 bad changes flagged and 0 of 7
  clean ones (`docs/clef-eval-2026-10-16.md`). Each card costs a fraction of a cent.
