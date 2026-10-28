# MWA — Memory Working Agent

A personal assistant that remembers. MWA checks in on you each morning, sorts your mail into a short list of what
matters, keeps your calendar in view, sends a notification when something needs you, and works through longer
requests in the background while you get on with your day. It runs on your own computer, a home server or a hosted
container, and you use it from a browser or your phone.

It is built on [AWM (agent-working-memory)](https://github.com/CompleteIdeas/agent-working-memory): every run starts by
recalling what MWA already knows about the request and about you, and ends by writing down what it learned, with a
record of where each fact came from and how far to trust it. That is what lets a cheap model do useful work without
being told everything again, and what keeps instructions hidden in an email from turning into actions.

**New in 0.10.0: the new app.** Today, Calendar, Important and Projects on a phone or a desktop, installable, with
notifications, voice input, approvals you can read, and every setting in one place. See the
[tour of the new app](docs/new-app.md) and the [CHANGELOG](CHANGELOG.md).

<p>
<img src="https://raw.githubusercontent.com/CompleteIdeas/memory-working-agent/master/docs/images/desktop-today.png" alt="Today in the new app on a computer: things that need you, what was done for you, and your day" width="640">
<img src="https://raw.githubusercontent.com/CompleteIdeas/memory-working-agent/master/docs/images/phone-approvals.png" alt="An approval on a phone, in plain words" width="190">
</p>

*Screenshots use the app's built-in example data; every name and address in them is invented.*

## Contents

- [What it does](#what-it-does)
- [Why it is different, and why AWM](#why-it-is-different-and-why-awm)
- [Install and run](#install-and-run)
- [Use it from your phone](#use-it-from-your-phone)
- [A quick tour](#a-quick-tour)
- [Configuration](#configuration)
- [For developers](#for-developers)
- [Documentation](#documentation)
- [Status](#status)

## What it does

- **Checks in on you.** Today shows what needs you, what is next on your calendar, and what was done for you since
  you last looked, with a morning check-in and an evening wrap in your time zone.
- **Notifies you.** Installed on a phone, it sends a notification when an approval is waiting, a job needs you, a
  result is ready, or the morning check-in has something to say. Notifications carry no personal content, and quiet
  hours are respected.
- **Works in the background.** Hand over a job ("go through these two PDFs and tell me what changed") and it runs
  with a cost estimate and a dollar limit, shows how far it got, and can be stopped, continued or given a note.
  Repeating jobs and watches ("tell me if the price changes") run on a schedule.
- **Sorts your mail.** Gmail (signed in, or with an app password) and Outlook are sorted into Important ("Worth a look") cheapest
  first: your rules, then fixed rules, then one batched model call, for about $0.05 a day. Suspected phishing is
  flagged and can't be acted on. It drafts replies; it never sends mail.
- **Keeps your calendar.** Google and Outlook calendars sync every 30 minutes; double bookings are pointed out, and
  events the helper proposes stay drafts until you confirm them.
- **Asks before it acts.** Anything that writes outside its own folder, reaches the network, deletes, costs money or
  sends as you waits for your OK, in plain words, with a second confirm for risky ones.
- **Remembers, and lets you see what it remembers.** Settings › What I remember lists what it knows, where each fact
  came from, and lets you correct, forget or export it.
- **Extends with plug-ins.** MCP servers (web search, GitHub, Notion and others) can be turned on from Settings, or
  added from npm after a safety review.

## Why it is different, and why AWM

Most assistants answer when asked and forget between conversations; most automation does a fixed thing on a
schedule. MWA sits between the two: it acts on its own within limits you set, and carries what it learns from one
day to the next. Memory is the basis of the system, not a feature beside it. The same AWM store holds what MWA knows
about you, the jobs it has been asked to do, what it did, and how much each piece can be trusted. Approvals, the
injection defence, the "What I did" account and the way it adapts to each person all read from it.

What AWM brings that a vector database or a notes file does not: retrieval tuned on a real store, a gate on what is
worth keeping, `supersede` when a fact changes so the old value stops coming back, consolidation that matures the
store over time, scoping so projects don't bleed into each other, and provenance on every memory.

**The honest scorecard, in short** (full table with sources and limits in [docs/why-mwa.md](docs/why-mwa.md)):

| Area | Measured | Still weak |
|---|---|---|
| AWM recall | 92.7% right memory first on 300 queries over 11,262 real memories, p50 256 ms (AWM 0.20.0, 2026-10-20) | Multi-hop is the agent's job; time words don't filter yet |
| Memory over two weeks | Facts said on day 1, asked on day 13–14: MWA 3 of 4, without memory 0 of 4; invented details 8 against a plain loop's 37 (2026-10-19) | The same assessment's pre-registered verdict was "no evidence of promise yet": a missed schedule failed the reliability bar |
| Cheap model with studied memory | 39 of 54 at under a cent an answer, against 46 of 54 for an expensive model reading the files at 88 times the cost (2026-10-25) | Behind on joining several facts and judging proposals |
| Planted instructions | The default model (GPT-6.1 Sol) followed none in 32 trials (2026-10-20) | One kind of attack; depends on the model you pick |
| The new app | Every slice passes its Playwright and accessibility smoke at phone and desktop width | Not yet scored on the usability rubric or tried on real phones over weeks |

## Install and run

You need an API key for a model provider (OpenRouter, OpenAI, Anthropic, Azure OpenAI or Google Gemini), or a local
model through [Ollama](https://ollama.com) with no key. The default model is GPT-6.1 Sol through OpenRouter; see
[Choosing a model](docs/models.md) before picking a cheaper one.

### On your computer (npm)

Needs Node 22 or newer and a C toolchain for `better-sqlite3`.

```bash
git clone --recurse-submodules https://github.com/CompleteIdeas/memory-working-agent.git
cd memory-working-agent
npm install       # links the vendored AWM submodule and the web app as npm workspaces
npm run build     # builds AWM, MWA and the web app (dist-ui)
npm run serve     # opens http://localhost:7788
```

The first screen asks you to pick a brain (provider and key), how much it may touch on your computer, and your
name, then offers to connect calendar and email and pair your phone. On this computer with no password set, you are
the owner without signing in. `mwa serve --data <dir>` keeps all runtime files in one folder; `MWA_NO_OPEN=1` stops
it opening a browser.

Already cloned without submodules? Run `git submodule update --init`, then `npm install && npm run build`.

### Docker

```bash
docker run -d --name mwa -p 127.0.0.1:7788:7788 -v mwa-data:/data \
  -e MWA_ACCESS_PASSWORD='a-strong-password' \
  ghcr.io/completeideas/mwa:latest
# open http://localhost:7788, sign in with the password, then set it up in the browser
```

**Set `MWA_ACCESS_PASSWORD` in Docker.** Inside a container nobody counts as "this machine" (the request could have
been relayed), so without a password nobody can sign in or pair a phone. Everything that persists (the `.env` with
your keys, the memory store, `app.db`, the workspace) lives on the `/data` volume. Compose works too:
`cp .env.example .env`, set the password, `docker compose up -d`. For a Synology or other NAS see
[docs/deploy-nas.md](docs/deploy-nas.md).

### Hosted (Railway or another container host)

The same image runs on Railway, Azure Container Apps or Cloud Run. Attach a volume at `/data`, set
`MWA_ACCESS_PASSWORD`, and MWA honours the platform's `$PORT`. A hosted install refuses browser-based Google and
Microsoft sign-in (use a Gmail app password or Outlook's code sign-in instead). Steps and gotchas are in
[docs/deployment.md](docs/deployment.md).

## Use it from your phone

A phone needs an https address to install the app, keep it offline and receive notifications.

- **On a computer or NAS:** with [Tailscale](https://tailscale.com) installed and MagicDNS and HTTPS certificates
  switched on in your tailnet, run `npm run tailscale:serve`. It serves MWA privately on your tailnet (Funnel stays
  off) and prints the `.env` lines to add: `MWA_PUBLIC_URL`, `MWA_ALLOWED_HOSTS` and `MWA_ACCESS_PASSWORD`.
- **In Docker:** set `TAILSCALE_AUTHKEY` and the container joins your tailnet, serves https itself and sets
  `MWA_PUBLIC_URL` (`TAILSCALE_SERVE=0` turns that off).
- **Hosted:** use the https address the platform gives you.

Then on the computer open Settings › Devices › **Pair a new device**, scan the QR code with the phone, and install
it from Settings › This device. Each paired phone has its own token with read, act and approve rights (no admin), and
can be removed at any time. The [onboarding and pairing walkthrough](docs/onboarding-and-pairing.html) has the
details.

## A quick tour

<p>
<img src="https://raw.githubusercontent.com/CompleteIdeas/memory-working-agent/master/docs/images/phone-today.png" alt="Today on a phone" width="190">
<img src="https://raw.githubusercontent.com/CompleteIdeas/memory-working-agent/master/docs/images/phone-important.png" alt="Important on a phone, with a phishing warning" width="190">
<img src="https://raw.githubusercontent.com/CompleteIdeas/memory-working-agent/master/docs/images/phone-conversation.png" alt="A project conversation on a phone" width="190">
<img src="https://raw.githubusercontent.com/CompleteIdeas/memory-working-agent/master/docs/images/phone-memory.png" alt="What I remember on a phone" width="190">
</p>

- **Today**: needs you, next up, done for you, the check-in and the wrap.
- **Calendar**: your day and week, double bookings, drafts to confirm.
- **Important**: mail and items worth a look, with why, Mark handled, Not important and Ask about this.
- **Projects**: one running conversation per project, its jobs and files.
- **Ask** (on every screen, by typing or voice): small questions are answered at once; a big ask comes back as a plan
  with "now" or "in the background", each with an estimate and a limit.
- **Settings**: connections, your assistant (brain, access, folders, style), plug-ins, what I remember, activity and
  spending, devices, notifications, your rules, and About, where **Use the classic app** switches back to the
  previous interface for this release.

<img src="https://raw.githubusercontent.com/CompleteIdeas/memory-working-agent/master/docs/images/desktop-plugins.png" alt="The plug-ins page on a computer" width="640">

The full walk-through, with every screen at phone and desktop width, is [docs/new-app.md](docs/new-app.md).

## Configuration

Most settings are made in the app. Deployment settings are environment variables, read from the process
environment or the `.env` on the data volume; the full list is [docs/configuration.md](docs/configuration.md). The
ones you are most likely to need:

| Variable | What it does |
|---|---|
| `MWA_ACCESS_PASSWORD` | Puts the app and API behind a password. Required for Docker, hosted and any networked install. |
| `MWA_PUBLIC_URL` | The address phones use (pairing QR codes, the install card). |
| `MWA_ALLOWED_HOSTS` | Extra host names the server answers to; anything else gets 421. |
| `MWA_SERVE_HOST` / `MWA_SERVE_PORT` | Bind address (default `127.0.0.1`) and port (default 7788, or `$PORT`). |
| `MWA_DATA_DIR` | Where every runtime file goes (default `./data`). |
| `MWA_MODEL`, `MWA_BACKGROUND_MODEL` | The model for chats, and a cheaper one for background work. |
| `MWA_MONTHLY_BUDGET_USD` | Monthly spending budget; scheduled work waits at 100%. |
| `MWA_TZ` | Your time zone, for the check-in, quiet hours and the calendar. |
| `AWM_STORE_BACKEND` | Memory storage: `sqlite` (default), `pglite` or `postgres` (with `AWM_DATABASE_URL`). |
| `TAILSCALE_AUTHKEY` | Docker only: join your tailnet and serve https on it. |

The access level (locked-down, assistant, developer) and the folders MWA may read are set in Settings › Your
assistant; see [docs/local-access.md](docs/local-access.md).

## For developers

MWA is also a harness you can build on. The pieces it is made of are exported:

- **The agent loop** (`runAgent`), **the memory** (`MwaMemory`, in process, no daemon), **the model router**
  (`RoutedProvider`, cheap to strong on struggle) and **the tool registry** (`buildRegistry`: built-ins, MCP servers,
  your own tools). See [docs/embedding-mwa.md](docs/embedding-mwa.md).
- **The client API** at `/api/v1`: a hand-written OpenAPI contract (`api/openapi.yaml`), idempotency keys on every
  write, server-sent events with a resumable cursor, and `/sync` for offline catch-up. A second client, such as an
  Android app, can be built against it. Every route is in [docs/api-reference.md](docs/api-reference.md).
- **Command line:**

  ```text
  mwa serve [--port N] [--data DIR]        the web app (also: mwa with no arguments)
  mwa run "<instruction>" --dir .          one headless run (--max-steps, --max-min)
  mwa watch [--once]                       work instruction files dropped in <workspace>/inbox
  mwa connect <gmail|outlook|telegram>     connect from the terminal
  mwa consolidate                          run AWM's consolidation pass (safe any time; good as a cron)
  mwa migrate-v2 [--dry-run] [--force]     move goals and scheduled tasks into jobs (also runs at start)
  mwa setup                                write mwa.config.json from .env
  ```

- **Plug-ins by config.** MCP servers can also be listed in `mwa.config.json`; their tools register as
  `<server>__<tool>`:

  ```jsonc
  "tools": {
    "mcpServers": {
      "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] }
    }
  }
  ```

- **Shared memory across surfaces.** Set `awm.workspace` in `mwa.config.json` and the web app, the CLI and
  Telegram recall each other's decisions (SQLite backend).
- **Tests and checks:** `npm test` (vitest), `node node_modules/typescript/bin/tsc --noEmit`, `npm run test:perf`,
  the Playwright smokes in `scripts/v2-*-smoke.mjs`, and `node scripts/v2-screenshots.mjs` to regenerate the
  pictures in `docs/images/`.
- **Benchmarks:** `npm run gauntlet` (memory ablation: AWM against RAG, notes, long context and none),
  `npm run bench` (the original orchestration benchmark), and the evidence experiments in `src/retention.ts`,
  `src/repo-qa.ts`, `src/staleness.ts` and `src/contextswitch.ts`.

AWM is vendored as a git submodule at `vendor/agent-working-memory` and built from source, so MWA always runs the
exact AWM it pins (0.20.1).

## Documentation

| | |
|---|---|
| [docs/new-app.md](docs/new-app.md) | A tour of the new app, screen by screen |
| [docs/why-mwa.md](docs/why-mwa.md) | Why memory is the basis, and the full scorecard |
| [docs/configuration.md](docs/configuration.md) | Every environment variable |
| [docs/deployment.md](docs/deployment.md), [docs/deploy-nas.md](docs/deploy-nas.md) | Desktop, Docker, NAS, Railway, Azure |
| [docs/onboarding-and-pairing.html](docs/onboarding-and-pairing.html) | Tailscale, the https address and pairing a phone |
| [docs/connect-email.md](docs/connect-email.md) | Gmail and Outlook |
| [docs/local-access.md](docs/local-access.md) | What it can touch on your computer |
| [docs/models.md](docs/models.md) | Choosing a model, and which resist planted instructions |
| [docs/connector-security.md](docs/connector-security.md), [docs/browser.md](docs/browser.md) | Plug-in and browser safety |
| [docs/api-reference.md](docs/api-reference.md) | The HTTP API, classic and `/api/v1` |
| [docs/embedding-mwa.md](docs/embedding-mwa.md) | Using MWA as a library |
| [docs/the-memory-substrate.md](docs/the-memory-substrate.md) | How provenance and trust were built into memory |
| [docs/true-agent-and-person-profile.md](docs/true-agent-and-person-profile.md) | The per-person profile and step-up verification |

Dated assessments, pilots and reviews (for example [docs/assessment-2026-10-19.md](docs/assessment-2026-10-19.md)
and [docs/reviews/](docs/reviews/)) are kept as written at the time.

## Status

**0.10.0** (Apache-2.0; under 1.0 on purpose). Every release is in [CHANGELOG.md](CHANGELOG.md). 0.10.0 is
mostly an interface and safety release: the new app, the `/api/v1` client API, phone install, notifications and
voice, with each slice reviewed for security before it merged. What has not been measured yet: the new app on the
usability rubric, and weeks of real use on a phone. The classic app is still reachable from Settings › About for this
release and will be removed after it.
