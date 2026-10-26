# MWA v2 build plan and tracker (started 2026-10-26)

Robert approved concept v2 ("Let's go with V2 … push it … tested … structurally strong"), with a client API an
Android app could drive and the web app installed as a PWA first. Design: docs/reviews/usability-review-2026-10-26/
concepts/ (prototype-v2 is the acceptance test; REPLAY-NOTES.md accessible names are the contract). Architecture
from a code-grounded plan (2026-10-26); file:line references there were checked against this branch.

## Structural decisions
- The server owns Job and Try identity and status; the client only displays them (today web/src/tasks.ts:272-365
  guesses by words and time; status from how a run ended, :205-222).
- New SQLite `app.db` beside agent.db (the src/tools/approval.ts pattern): jobs, tries, projects, turns, items,
  item_qa, triage_verdicts, triage_rules, cal_events, cal_drafts, mail_headers, sync_state, events (cursor),
  devices, pair_codes, push_subs, idempotency, migrations. AWM keeps knowledge; JSONL logs stay logs.
- Job status = pure function: working › waiting for you (approval or $ cap) › continuing (queued auto-continue,
  never FAILED) › stopped by you › partly done (remaining/progress) › stopped (couldn't) › done (result ready until
  opened).
- `/api/v1` with a route table (src/api/router.ts), hand-written OpenAPI (api/openapi.yaml) with generated types,
  contract tests, idempotency keys on every write, client-version header (426 below minClient).
- Device pairing (QR one-time code → per-device token, scopes read/act/approve/admin, revocable); v1 refuses
  everything but /meta and pairing from localhost when bound to a network with no password and no devices.
- Calendar drafts live in MWA until Confirm (no more real `[Proposed]` events); mail bodies never stored on the
  server or the phone (fetched on demand).
- Important = triage pipeline cheapest-first (person's rules › deterministic skips › known contacts › batched
  background-model triage › deep read only for important newsletters/PDFs); tool-less, fenced, schema-validated;
  rules only from the person's taps. Budget ≈ $0.05/day, hard cap $0.15/day.
- One SSE stream with a cursor replaces polling; PWA with IndexedDB cache + outbox, update prompt, web push (VAPID).
- RunCoordinator: global run semaphore, one running Try per Job, per-folder lock; scheduler claims Tries in SQLite.

## Slices (S/M/L) — status
| ID | Slice | Size | Depends | Status |
|---|---|---|---|---|
| A0 | Foundations: app.db, router, /api/v1/meta, connector helper exports, token paths beside agent.db | M | – | done d84f9cc |
| A1 | OpenAPI contract scaffold + generated types + contract tests | M | A0 | done d84f9cc |
| A2 | Device auth and pairing, scopes, open-tailnet gap closed | M | A0 | done (see git log) |
| A3a | Jobs and Tries: data, status function, agent/scheduler/serve wiring, migration (mwa migrate-v2) | L | A0 | |
| A3b | Dollar cap (AgentBudget.maxUsd), estimates, job actions | M | A3a | |
| A4 | Event log, /stream SSE with cursor, /sync | M | A0 | |
| A5 | Projects and threads, routing suggestion, provenance | M | A3a | |
| A6 | Ask v1, big-ask plan, item-scoped ask (fenced, tainted) | M–L | A3b, A5 | |
| A7 | Calendar sync (Google, Outlook) + MWA-held drafts, Confirm/Remove, .ics, conflicts | M–L | A0 | |
| A8 | Mail header sync (Gmail history, IMAP, Graph delta) + reader + save draft | M–L | A0 | |
| A9 | Triage and Important items, Handled / Not important / skipped | L | A7, A8, A3a | |
| A10 | Today composite | S | A3a, A7, A9 | |
| W1 | v2 web shell + typed client + IndexedDB store + fixture server from prototype data | L | A1 | |
| W2–W5 | Today+Calendar · Important+mail · Projects+Ask+plan · Settings+first run+devices | M each | W1 + backend | |
| W6 | Cutover (v2 default, v1 at ?ui=v1 for one release) | S | W2–W5 | |
| P1 | Installable PWA + secure context (tailscale serve, manifest, install UX) | M | W1 | |
| P2 | Offline data, outbox, update prompt, clear on revoke | L | P1, A4 | |
| P3 | Web push | M | P2, A4 | |
| P4 | Voice (browser speech) | S | W4 | |

Parallel without shared files: {A1, A2, A3a, A4, A7, A8} after A0; {W2..W5}; {P1, A9}. In order: A3a → A5 → A6;
A7 before A9.

## Tests ("structurally strong")
Unit (status truth table, estimates, $ cap, triage rules, migration lossless + idempotent, auth, idempotency,
cursor replay) · API contract (every route in the spec and back, ajv-validated, real HTTP with fake Google/Graph/IMAP
servers and a scripted model) · Playwright replay of prototype scenarios N00–N11 against the real app with seeded
data and a frozen clock (aria snapshots, axe, overflow, chrome ≤ 23%, pill = sheet counts), a vision critic
comparing prototype and app per step · PWA specs (installability, offline, update, revoke, push) · live checks with
the real model, each capped at $1.

## Decisions needed from Robert
1. Outlook: register an Azure multi-tenant public-client app and ship its id (one-tap Outlook), or keep Outlook
   behind "advanced" for now.
2. Google from a phone: a Web-application OAuth client with redirect on the https Tailscale/Railway address; the
   Google Cloud project must be "In production" or refresh tokens expire after 7 days.
3. Tailscale HTTPS: enable MagicDNS + HTTPS certificates in the tailnet admin (cert names appear in public CT logs).
4. A test Gmail and Outlook.com account for the live checklist.

## Notes from the A2 security review (2026-10-26)
- "This machine" = loopback socket AND a local Host (localhost / 127.0.0.1 / [::1]) AND no forwarding header. A
  loopback socket alone is not enough: the Docker entrypoint's `tailscaled --tun=userspace-networking`, `tailscale
  serve --tcp`, ssh/socat/portproxy forwarders and nginx without X-Forwarded-For all arrive from 127.0.0.1. The Host
  rule also stops DNS rebinding.
- So in Docker (and any relayed setup) with NO password, v1 trusts nobody but paired devices, and nobody can make the
  first pairing code: set MWA_ACCESS_PASSWORD for any networked install (sign in, then pair the phone).
- The legacy /api routes are unchanged: with no password they remain open to the network (pre-existing).
- W5 must let the app shell and /pair load under a password (today the legacy gate serves the login page for `/`).
- An event feed (A4) must not show other devices' names to a device without admin.
- Clear-Site-Data does not include "cookies" (on *.ts.net that could clear the whole tailnet domain); "Sign out this
  phone" revokes the device server-side, which is what matters.
