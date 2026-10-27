# MWA v2 web app (W1: shell, client, store, fixture mode · W2: Today and the Calendar · W3: Important and the mail reader)

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
  store/today.ts      W2: the Today composite (cached, refetched on the stream's notice, focus and online; seen after 2 s;
                      check-in and wrap through the outbox), freshness and trust helpers
  store/calendar-ops.ts  W2: optimistic Confirm / Remove, double-booking words, honest states, New event, the .ics file
  store/today-react.ts   W2: useToday, useDraftActions, useCalendarAccounts, useSpeech
  store/important.ts  W3: the Important list's pure parts (pending taps applied, groups, skipped line, Not important choices)
  shell/              the app frame (header + pill, Ask bar, tabs, sheets) and the W1 screen frames; v2.css
  screens/today/      W2: Today — check-in, wrap, Needs you, Next up, Done for you, Worth a look, the desktop's three columns
  screens/calendar/   W2: the Calendar — day strip and week, the double-booking, drafts, New event, the event sheet
  screens/important/  W3: "Worth a look" — rows, the item sheet, Not important, Show them, Your rules, Ask about this
  screens/mail/       W3: the reader (sanitised text, reply-to warning, Draft a reply) and All email
  dev/fixture-data.ts the approved prototype's example day (Monday, November 9, 2026, 9:10 AM)
  dev/fixtures.ts     FixtureServer: /api/v1 answered from that day (shapes checked against the spec)
  dev/fixtures-important.ts  W3: its Important list, skipped mail, rules, reader extras and about-asks
  dev/fixtures-today.ts  W2: /today, the calendar's accounts and refresh, new drafts; Today's scenarios
  dev/fixture-clock.ts   W2: each scenario's frozen time of day
  dev/vite-plugin.ts  the same server as Vite dev/preview middleware
```

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
messages are waiting to be sorted", "Older mail … wasn't sorted yet"). Every scenario's Important list has the
prototype's items plus a phishing message and an unverified urgent one, and a rule made last week. W2's Today
scenarios: `N05` (7:30 AM, the morning check-in), `midday` (12:30 PM), `N09` (6:30 PM, the evening wrap), `partial`
(Google synced, Outlook never has), `not-connected` (no calendar), `reconnect` (Google needs signing in again). The
clock is frozen at the prototype's Monday — 9:10 AM, or the scenario's time in-browser (with the middleware, pass
`&now=2026-11-09T07:30:00` to match a reset scenario; `&now=<ISO>` always overrides it), a dashed **simulated** tag shows in the header, and `&theme=dark|light`
forces a theme. Writes it acts on: job stop / continue / open, calendar draft confirm / remove, project messages
(a simulated answer follows on the stream).

## Tests

- `npx vitest run tests/web-v2-client.test.ts tests/web-v2-store.test.ts tests/web-v2-fixtures.test.ts tests/web-v2-items.test.ts tests/web-v2-w3-fixtures.test.ts`
- `npm run build:ui && node scripts/v2-web-smoke.mjs --axe <path to axe.min.js> [--out <dir>]` — Playwright (the
  repo's playwright-core) against `vite preview` in fixture mode at 390×844 and 1440×900: pill and working sheet,
  tabs, Ask, IndexedDB, the offline outbox, the 426 path, axe and horizontal overflow; screenshots in `--out`.
- `npx vitest run tests/web-v2-today.test.ts tests/web-v2-calendar.test.ts tests/web-v2-w2-fixtures.test.ts` (W2)
- `node scripts/v2-w2-smoke.mjs --axe <axe.min.js> [--out <dir>]` — W2: Today (N01, the N05 check-in, the N09 wrap,
  the desktop's three columns), the Calendar (the double-booking, a draft's origin and Confirm, New event, the week,
  the .ics link), the partial and not-connected notes, the check-in done offline through the middleware, dark.
- `node scripts/v2-w3-smoke.mjs --axe <axe.min.js> [--out <dir>]` — the same for W3: the groups, phishing and
  unverified items, Handled by swipe with Undo, the item sheet, Not important (and the server's 400), Show them, Ask
  about this answered in place, the reader (Draft a reply, the reply-to warning), Your rules, offline, `sorting`.

## Not yet (later slices)

Reconnecting and connecting a calendar from v2 (W5: Today and the Calendar point to Settings and say so), Ask about an
event or a Done line answered in place (W4's AskAbout; they open the Ask sheet with a chip meanwhile), rules in Settings (W5; "Your rules" opens
from the bottom of Important until then), the month's spending limit (the API has no spending summary yet: the sheet shows what the jobs cost),
voice (P4: the mic opens the Ask sheet), files in Ask and Ask v1 (A6/W4: Ask posts to the project's thread), sign-in
and pairing screens (W5: a 401 shows "Sign in to continue"), the service worker's offline shell for v2 (P1/P2).
