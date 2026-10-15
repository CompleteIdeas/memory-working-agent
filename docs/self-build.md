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
| **B. A sandboxed check runner** | The checks run in a throwaway container with no network, on a copy of the folder, started by a small runner service with one fixed request: "run the checks on folder X". | If MWA itself gets the Docker socket, it effectively has the host. The runner must never accept a command line, mounts or environment. |
| **C. Developer mode on a VM of its own** | The VM is the boundary. It holds only the repo, a model key and a deploy key limited to a fork. | Everything on that VM is the model's. Boundaries rot when "one more secret" gets added. |

B is the only option where model-written code runs without a person and without your power. A
second model also recommended starting with A, and moving to B, never with the Docker socket in
MWA's hands, once A has shown the job is worth it.
