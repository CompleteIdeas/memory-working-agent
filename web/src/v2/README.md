# MWA v2 web app (slice W1: shell, client, store, fixture mode)

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
  shell/              the app frame (header + pill, Ask bar, tabs, sheets) and the W1 screen frames; v2.css
  dev/fixture-data.ts the approved prototype's example day (Monday, November 9, 2026, 9:10 AM)
  dev/fixtures.ts     FixtureServer: /api/v1 answered from that day (shapes checked against the spec)
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
the eight server states), `old-client` (the server wants a newer app: 426). The clock is frozen at the prototype's
Monday 9:10 AM (`&now=<ISO>` overrides it), a dashed **simulated** tag shows in the header, and `&theme=dark|light`
forces a theme. Writes it acts on: job stop / continue / open, calendar draft confirm / remove, project messages
(a simulated answer follows on the stream).

## Tests

- `npx vitest run tests/web-v2-client.test.ts tests/web-v2-store.test.ts tests/web-v2-fixtures.test.ts`
- `npm run build:ui && node scripts/v2-web-smoke.mjs --axe <path to axe.min.js> [--out <dir>]` — Playwright (the
  repo's playwright-core) against `vite preview` in fixture mode at 390×844 and 1440×900: pill and working sheet,
  tabs, Ask, IndexedDB, the offline outbox, the 426 path, axe and horizontal overflow; screenshots in `--out`.

## Not yet (later slices)

The Important list (`useItems` answers `supported: false` until A9 adds `/items` and the `items` feature), Today's
composite (A10), the month's spending limit (the API has no spending summary yet: the sheet shows what the jobs cost),
voice (P4: the mic opens the Ask sheet), files in Ask and Ask v1 (A6/W4: Ask posts to the project's thread), sign-in
and pairing screens (W5: a 401 shows "Sign in to continue"), the service worker's offline shell for v2 (P1/P2).
