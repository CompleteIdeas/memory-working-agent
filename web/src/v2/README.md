# MWA v2 web app (W1: shell, client, store, fixture mode · W2: Today and the Calendar · W3: Important and the mail reader · W4: Ask and Projects · P1/P2: install, offline, updates)

The v2 app is opt-in until W6: open the app with `?ui=v2` (remembered on the device; `?ui=v1` goes back), or use
Settings › "Use the current app". v1 is unchanged: v2 is a lazy chunk with its own stylesheet that v1 never loads.

```
web/src/v2/
  index.tsx           entry: client → store → shell; picks real or fixture wiring
  choose.ts           which UI to show (?ui=, ?fixtures=1, localStorage mwa-ui)
  api/types.gen.ts    generated from api/openapi.yaml (npm run api:types)
  api/client.ts       typed client: X-MWA-Client, Idempotency-Key per action, typed errors
  store/core.ts       the store: IndexedDB cache, /sync catch-up, the /stream EventSource, the outbox
  store/cache.ts      the cache interface and its stores; MemoryCache (tests, private windows)
  store/idb.ts        the IndexedDB cache (the `idb` package)
  store/status.ts     the pill, the working sheet's groups and the month line, from the server's job states
  store/react.tsx     hooks: useJobs, useStatusPill, useCalendar, useProjects, useThread, useMail, useItems, useMeta…
  store/today.ts      W2: the Today composite (cached, refetched on the stream's notice, focus and online; seen after 2 s
                      on a server Today for the person's day, with its `now`; check-in and wrap through the outbox with
                      the day they dismiss), freshness helpers; outside words come from the server as parts (never parsed)
  store/calendar-ops.ts  W2: optimistic Confirm / Remove, double-booking words, honest states, New event, the .ics file
  store/today-react.ts   W2: useToday, useDraftActions, useCalendarAccounts, useSpeech
  store/important.ts  W3: the Important list's pure parts (pending taps applied, groups, skipped line, Not important choices)
  shell/              the app frame (header + pill, Ask bar, tabs, sheets) and the W1 screen frames; v2.css
  screens/today/      W2: Today — check-in, wrap, Needs you, Next up, Done for you, Worth a look, the desktop's three columns
  screens/calendar/   W2: the Calendar — day strip and week, the double-booking, drafts, New event, the event sheet
  screens/important/  W3: "Worth a look" — rows, the item sheet, Not important, Show them, Your rules
  screens/mail/       W3: the reader (sanitised text, reply-to warning, Draft a reply) and All email
  screens/ask/        W4: the Ask sheet, what an ask became (answer followed live, plan card, job, offer),
                      "Ask about this" (AskAbout, the one used everywhere), the words (logic.ts), answers as text
                      (answerText.tsx) and adding files (upload.ts); ask.css
  screens/projects/   W4: the Projects tab — the list, a project's thread, its Work and Files; projects.css
  dev/fixture-data.ts the approved prototype's example day (Monday, November 9, 2026, 9:10 AM)
  dev/fixtures.ts     FixtureServer: /api/v1 answered from that day (shapes checked against the spec)
  dev/fixtures-important.ts  W3: its Important list, skipped mail, rules, reader extras and about-asks
  dev/fixtures-today.ts  W2: /today, the calendar's accounts and refresh, new drafts; Today's scenarios
  dev/fixture-clock.ts   W2: each scenario's frozen time of day
  dev/fixtures-w4.ts  W4: its projects, threads and Ask (plans, choices, runs with live progress, offers, moves)
  dev/vite-plugin.ts  the same server as Vite dev/preview middleware
```

## Ask and Projects (slice W4)

- **The Ask sheet** (`screens/ask/AskSheet.tsx`, behind W1's Ask bar, Ask button and mic, same accessible names):
  "To: Family & school · suggested" while typing (GET /projects/suggest, debounced; **Change** picks a project and the
  person's choice wins, sent as `projectId`); Send is POST /ask through the outbox. What it became shows in place
  (`AskOutcome.tsx`): an answer followed live (the `running` turn, the stream's `live` steps, then the answer — a new
  turn with the same runId; GET /ask/{id} as well while it runs), the **plan card** (N04: the two choices in the
  server's words with the ready time in this device's time, "Or narrow it…" with the server's narrower asks, Details
  with "Stop if it costs more than $" from capDefault, at most $20; 410 "This plan is old — ask again", 409 files_gone
  and archived in plain words), a job ("I’ll let you know · ready around …", and the way to the working sheet), or the
  offer (Work on it in the background · Do it here now). An ask made offline waits in the outbox with its key; a plan
  that comes back from the outbox shows when Ask is opened next.
- **Files**: `upload.ts` posts to `POST /api/v1/files` (W5: act scope, Idempotency-Key) — from the computer or a
  paired phone; fixture mode never touches the network.
- **Voice** is P4: the mic opens the Ask sheet and says so.
- **"Ask about this"** — ONE component everywhere: `<AskAbout kind id label … />` (`screens/ask/AskAbout.tsx`), used
  by a project's Work tab (inline), an Important item's sheet and the mail reader (W3's copy is gone). Props:
  - `kind` item | mail | event | draft | job | conflict; `id` that thing's id; `label` the chip's words ("About: …")
    until the server names the thing — the server's label wins;
  - `item?` an Important item: its answers arrive on the item's own stream (`item.qa`), which reads the asks again;
  - `form?` `'inline'` (default) or `'sheet'` (questions in a sheet that closes once the helper is answering; the answer
    still shows in place), `sheetId?` that sheet's id; `open?` start open; `prefill?` open with this question in the box;
  - `noAsk?` no "Ask about this" (a phishing message) — earlier answers still show; `taintNote?` other words for the
    tainted label (the mail reader: "Based on what the email says — check before acting"); `onAsked?(askId)`.
  It shows the chip, the server's 2–3 questions (GET /ask/suggestions) and a box (a second tap while one is on its way
  does nothing), and under "You asked" every ask about the thing, one per ask id (GET /ask?about=), with its answer
  followed live (polling capped, only while visible), "using what I know from …" (earlier answers too) and the tainted
  label. Answers everywhere are plain text with links as hosts (`answerText.tsx`, on `store/text.ts`, the server's rule).
- **Projects** (`screens/projects/`): the list (icon, what it is doing or its last activity, Working / Waiting badges,
  New project, archived ones under "Archived · N" with Restore); a project (Project options: Rename, Archive — not
  General; "Ask about <name>"; tabs Conversation · Work · Files). The conversation pages back with "Earlier messages"
  (`before`), shows the running answer with Stop and "Add to it" (steer), "using what I know from …", the About chip
  on item-scoped questions, the offer, the divider before an imported conversation, and Move… on each message (with
  Undo); its composer asks in the project, so a big ask gets its plan card there.
- **Store** additions (`store/core.ts`, `store/react.tsx`): actions `ask`, `ask.choose`, `turn.move`,
  `project.create|update|stop|steer|offer` through the outbox (`act(…, {quiet})` leaves a refusal to the screen);
  `askOutcomes` (by outbox entry id), `askChoices`, `asks` (the stream's `ask` changes); `threadOlder`/`threadNext`
  and `loadEarlier`; `loadProjectWork`, `loadAsk`; hooks `useAsk`, `useLive`, `useProjectActions`, `useJobMap`,
  `useCalendarItem`, and `useThread(id).all / hasEarlier / loadEarlier`.

## Fixture mode

Build screens before the backend slices land. Two ways, same data:

1. **Vite middleware** (the real client, EventSource and IndexedDB against a fixture server):
   ```
   MWA_FIXTURES=1 npm run dev:ui                      # then http://localhost:5179/?ui=v2
   MWA_FIXTURES=1 MWA_FIXTURE_SCENARIO=N06 npm run dev:ui
   npm run build:ui && cd web && MWA_FIXTURES=1 npx vite preview   # the built UI: http://localhost:4173/?ui=v2
   ```
   (PowerShell: `$env:MWA_FIXTURES='1'; npm run dev:ui`.) Switch the world without a restart:
   `POST /__fixtures/reset?scenario=N06`. The legacy `/api/*` still proxies to `mwa serve` in dev.
2. **In the browser**, no server at all: `?fixtures=1` (and `&scenario=N06`), on any build, e.g.
   `http://localhost:7788/?fixtures=1`. A fresh world on every load; nothing is kept on the device.

Scenarios: `N00` (default: one job working), `N06` (+ a job waiting at its 15¢ limit), `states` (one job in each of
the eight server states), `old-client` (the server wants a newer app: 426), `sorting` (W3: sorting held back — "3
messages are waiting to be sorted", "Older mail … wasn't sorted yet"), `thread-long` (W4: Eventing has 80 older turns:
paging). Every scenario's Important list has the prototype's items plus a phishing message and an unverified urgent one,
and a rule made last week. Ask in fixture mode: two files or "learn everything / go through all / review all / triage /
read all" give a plan (the prototype's PDFs are 76 and 73 pages); "[old]" in the text makes a plan that is a day old
(410); a file whose name has "gone" in it is gone when chosen (409); "research …" gets the offer. W2's Today scenarios: `N05` (7:30 AM, the morning check-in), `midday` (12:30 PM), `N09`
(6:30 PM, the evening wrap), `partial` (Google synced, Outlook never has), `not-connected` (no calendar), `reconnect`
(Google needs signing in again). The clock is frozen at the prototype's Monday — 9:10 AM, or the scenario's time
in-browser (with the middleware, pass `&now=2026-11-09T07:30:00` to match a reset scenario; `&now=<ISO>` always
overrides it), a dashed **simulated** tag shows in the header, and `&theme=dark|light`
forces a theme. Writes it acts on: job stop / continue / open, calendar draft confirm / remove, project messages and
asks (a simulated answer follows on the stream, with its progress), plan choices, projects (create, rename, archive),
moving a turn, Stop, Steer and the offer.

## Install, offline and updates (slices P1/P2)

```
web/src/pwa/          (in the main bundle: both UIs share one worker)
  sw-logic.ts         the worker's decisions, pure: route a request, which caches to delete, is a fetched file usable
  sw.ts               the worker (bundled to dist-ui/sw.js by web/vite-pwa.ts with this build's file list)
  update.ts           "A new version is ready · Reload" as a state machine
  register.ts         registers the worker, feeds update.ts, keeps the install prompt, points v2 at its manifest
  install.ts          "Install on this phone" in plain words, per browser
  offline.ts          the offline banner's words
  react.ts            useUpdate, useInstallState
web/vite-pwa.ts       after the build: hashes every file, writes sw.js + pwa-build.json
web/public/manifest-v2.webmanifest, web/public/pwa/   the v2 manifest and icons (node web/scripts/gen-pwa-icons.mjs)
screens/settings/InstallCard.tsx                      Settings › This device › Install on this phone
src/pwa.ts            (server) cache headers; the worker, manifests and icons are public behind the password
scripts/tailscale-serve.mjs                           npm run tailscale:serve
```

- **One worker for v1 and v2.** They are one build (one index.html, v2 a lazy chunk) at the same origin and path, so two
  workers would fight over one scope. v1 keeps its own manifest; v2 swaps to `manifest-v2.webmanifest` (start_url
  `./?ui=v2&source=pwa`, shortcuts Ask · Today · Important) before the browser reads it.
- **Precache, all or nothing.** The worker caches every file of its build in `mwa-precache-<buildId>-<workerHash>`
  (the worker's own code is in the name, so a worker-only change never shares the active cache); index.html is fetched
  as `index.html?ui=v2` (W5's gate lets a v2 page in signed out) and must be the page that loads this build's entry
  script (a sign-in page is refused), or the install fails and the old worker stays. An install deletes only a cache it
  created. So a cached index.html never points at hashed files the cache lacks.
- **Pages: network first, however long it takes; the cached shell only when the device is offline, the request fails,
  or the proxy answers 5xx** (the computer asleep). Never after a timeout: the server's sign-in page must win, or v1's
  reload-on-401 loops (v1 also reloads on a 401 at most once per session, then shows a sign-in notice: web/src/locked.ts).
  `/api/*` is never touched: data lives in IndexedDB through the store. The cache before the current one is kept, so an
  old tab's lazy chunk still loads.
- **Updates.** A new build's worker installs and WAITS; the shell shows "A new version is ready · Reload". Reload waits
  up to 15 s for actions in flight, puts any still on their way in the outbox with their keys (never lost; the server
  answers a repeated key with its first answer), then the worker takes over (SKIP_WAITING) and the page reloads once.
  No new build within ~20 s: "Couldn’t get the update — try again". A page that already runs the new build lets the
  worker take over quietly. A 426 shows the same banner and looks for the new worker first.
- **Offline.** "Offline · showing what I had at 9:10 AM" and "2 things will be sent when you're back online" under the
  header; Stop, "Add to it" and a plan choice with a price are refused offline in plain words (a narrower ask, which has
  no price, still waits). A choice already in an outbox from an earlier build is still sent.
- **Signed out.** A 401 (a removed phone, a sign-out, an ended session) clears the device's copy — IndexedDB and the
  outbox — says "Signed out — this phone’s copy was cleared", and an offline start after it shows no cached data. The
  password sign-out also sends `Clear-Site-Data: "cache", "storage"`.
- **Tests:** `npx vitest run tests/pwa-sw.test.ts tests/pwa-client.test.ts tests/pwa-server.test.ts tests/pwa-review.test.ts tests/docker-entrypoint-tailscale.test.ts`, and
  `node scripts/v2-p1p2-smoke.mjs --data <empty folder> --axe <axe.min.js>` (a real `mwa serve` on 7899, builds A and B).

## Tests

- `npx vitest run tests/web-v2-client.test.ts tests/web-v2-store.test.ts tests/web-v2-fixtures.test.ts tests/web-v2-items.test.ts tests/web-v2-w3-fixtures.test.ts`
- W4: `npx vitest run tests/web-v2-w4-store.test.ts tests/web-v2-w4-ui.test.ts tests/web-v2-w4-fixtures.test.ts tests/web-v2-w4-review.test.ts`,
  and `node scripts/v2-w4-smoke.mjs --axe <axe.min.js> [--out <dir>]` (Ask, the plan card, Projects, at 390 and 1440)
- `npm run build:ui && node scripts/v2-web-smoke.mjs --axe <path to axe.min.js> [--out <dir>]` — Playwright (the
  repo's playwright-core) against `vite preview` in fixture mode at 390×844 and 1440×900: pill and working sheet,
  tabs, Ask, IndexedDB, the offline outbox, the 426 path, axe and horizontal overflow; screenshots in `--out`.
- `npx vitest run tests/web-v2-today.test.ts tests/web-v2-calendar.test.ts tests/web-v2-w2-fixtures.test.ts tests/web-v2-w2-review.test.tsx tests/web-v2-w2-zone.test.ts` (W2)
- `node scripts/v2-w2-smoke.mjs --axe <axe.min.js> [--out <dir>]` — W2: Today (N01, the N05 check-in, the N09 wrap,
  the desktop's three columns), the Calendar (the double-booking, a draft's origin and Confirm, New event, the week,
  the .ics link), the partial and not-connected notes, the check-in done offline through the middleware, dark.
- `node scripts/v2-w3-smoke.mjs --axe <axe.min.js> [--out <dir>]` — the same for W3: the groups, phishing and
  unverified items, Handled by swipe with Undo, the item sheet, Not important (and the server's 400), Show them, Ask
  about this answered in place, the reader (Draft a reply, the reply-to warning), Your rules, offline, `sorting`.

## Not yet (later slices)

Reconnecting and connecting a calendar from v2 (W5: Today and the Calendar point to Settings and say so), rules in Settings (W5; "Your rules" opens
from the bottom of Important until then), the month's spending limit (the API has no spending summary yet: the sheet shows what the jobs cost),
voice (P4: the mic opens the Ask sheet), an /api/v1 upload (W4 uses the legacy one until W5), the service worker's offline shell for v2 (P1/P2).

## W5: sign-in, pairing, first run, Settings

- `screens/start/Start.tsx`: `useStartGate()` (the shell asks it first) — **Sign in** after a 401 (`POST /api/v1/session`;
  with no password set, "Pair this device first"), **Pair this phone** (`/pair`, the QR's `/pair#c=CODE`, or "Type a
  code"; `POST /pair` sets the device cookie), and **first run** on the computer until `firstRunDone` (name the helper,
  connect Google / Outlook, turn on what's off, pair your phone with the code and QR). `/pair` always opens the v2 app.
- `screens/settings/`: Settings (Connected, This month, Devices, Your rules, Your helper, What I keep up to date, Saved
  logins, Notifications, Look, About), `useSettings.ts` (data and words), `PairNewDevice.tsx` and `qr.ts` (a small
  QR encoder, byte mode level M, checked against the `qrcode` package in tests/web-v2-qr.test.ts). Admin-only parts
  are read-only on a paired phone, with one line that says why. The Important list's "Your rules" sheet links here.
- Fixtures (`dev/fixtures-settings.ts`): scenarios `signed-out` (password "example"), `unpaired` (code K7PQ-M4XZ),
  `phone` (a paired phone, no admin) and `first-run`.
- `node scripts/v2-w5-smoke.mjs --axe <axe.min.js> [--out <dir>]`.

