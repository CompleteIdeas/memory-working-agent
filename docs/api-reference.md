# MWA serve — HTTP API reference

`mwa serve` listens on `MWA_SERVE_HOST` (default `127.0.0.1`) port `7788` and exposes two APIs:

- **`/api/v1`** (since 0.10.0): the versioned client API the new app and a paired phone use. A route table in
  `src/api/v1.ts` + `src/api/routes/*.ts`, described by the OpenAPI contract `api/openapi.yaml` (132 operations;
  `tests/api-contract.test.ts` holds code and contract together). Documented first, below.
- **`/api/*`** (the classic routes): what the classic app (`/?ui=v1`) and older scripts use. Documented after the v1
  section. They now take the same callers as v1 (see [Who may call](#who-may-call-both-apis)).

All bodies are JSON unless noted.

## Who may call (both APIs)

Verified in `src/api/auth.ts`, `src/api/trust.ts`, `src/api/sessions.ts`, `src/api/router.ts` and `src/serve.ts`.

**Host check first.** Every request except `GET /api/health` must carry a `Host` the server answers to, or it gets
**421** (DNS-rebinding defence). Allowed: `localhost`, `127.0.0.1`, `[::1]`, any IP literal, this machine's hostname
(and `<hostname>.local`), each name in `MWA_ALLOWED_HOSTS` (comma-separated; `*.example.ts.net` allows a suffix; `*`
turns the check off), the host of `MWA_PUBLIC_URL`, Railway's own domains, and `<TAILSCALE_HOSTNAME>.<tailnet>.ts.net`
when the Docker image joined a tailnet.

**Three kinds of caller** (`makeAuthenticate`, checked in this order):

| Caller | How it is recognised | Scopes |
|---|---|---|
| a bearer token | `Authorization: Bearer <token>` from a paired device (a phone app). If the header is present it must verify: a malformed or revoked token is 401, never a fall-through to a cookie | the device's (`read, act, approve` by default) |
| the password session | `mwa_session` cookie from `POST /api/v1/session` or `POST /api/login` (only when `MWA_ACCESS_PASSWORD` is set). 30 days, with a server-side record in `app.db`, so signing out ends it on the server | all: `read, act, approve, admin` |
| a paired device's cookie | `mwa_device` cookie (HttpOnly, SameSite=Strict) set by `POST /api/v1/pair` for the installed web app | the device's |
| this machine | only when **no** password is set, the socket is loopback, there are no forwarding headers (`X-Forwarded-*`, `Forwarded`, `X-Real-IP`, `Via`, `Tailscale-*`), the `Host` is local, **and** the server is not in relayed mode | all |

**Relayed mode** (`relayedMode` in `trust.ts`): nobody counts as "this machine" when the server could be reached
through something that makes a remote client look local. It is on when `MWA_RELAYED=1`, the bind host is not
loopback (Docker sets `MWA_SERVE_HOST=0.0.0.0`), `TAILSCALE_AUTHKEY` is set, `MWA_ALLOWED_HOSTS` or `MWA_PUBLIC_URL`
names a non-local host, the app runs hosted (Railway, a container), or `tailscale serve` forwards to this port
(detected at start). `MWA_RELAYED=0` forces it off. In relayed mode the owner signs in with the password or uses a
paired device.

**Scopes.** `read` (look), `act` (change things, start work), `approve` (decide approvals), `admin` (secrets,
settings, memory editing, pairing). A paired phone gets `read, act, approve`; a scope it lacks is **403 `forbidden`**.
The classic `/api/*` routes are mapped to the same scopes in `src/api/legacy.ts` (`legacyApiScope`): `/api/health`,
`/api/login` and `/api/share/*` are public; secrets, memory export/edit, logs, connections, models, setup, billing
settings, step-up, routines, the inbox scan and `/api/open` are `admin`; `/api/approvals/confirm|cancel` is
`approve`; other writes and `GET /api/chat` are `act`; other GETs are `read`.

**Same-origin (CSRF).** A write carried by a cookie or by "this machine" must be same-origin (`Sec-Fetch-Site` of
`same-origin`/`none`, or an `Origin` whose host equals `Host`; no `Origin` at all, as from curl, is allowed). Otherwise
**403 `cross_origin`**. A bearer-token call is exempt (another site's page cannot send one).

**Sign-in throttle.** Wrong passwords and wrong pairing codes from one source make that source wait longer (nothing
for the first 3, then 0.25 s doubling to 10 s; at most 30 s per attempt). A right password or code is never refused.
The source is the socket peer; `X-Forwarded-For` is believed only from a proxy listed in `MWA_TRUSTED_PROXY`.

## Client API v1 (`/api/v1`)

### Conventions (`src/api/router.ts`)

- **Errors** are always `{"error": {"code", "message"}}` with a plain-words `message`. Common codes on every route:
  `401 locked` (sign in), `403 forbidden` (scope), `403 cross_origin`, `404 not_found`, `405 method_not_allowed`
  (with `Allow`), `400 bad_json`, `400 bad_path` (an id that decodes to a slash, backslash or NUL), `413 too_large`
  (bodies over 1 MB, except uploads), `500 internal`.
- With nobody signed in, only a public route answers; every other path, existing or not, is **401** (no route map for
  strangers).
- **Idempotency.** Every signed-in write (any non-GET request to a non-public route; sign-in and pairing need none) must send `Idempotency-Key` (8–128 of `A-Za-z0-9._:-`), else
  `400 idempotency_key_required`. A retry with the same key and the same request gets the first answer back (header
  `idempotent-replay: true`) for 48 h; the same key on a different request is `409 idempotency_key_reused`; one still
  running is `409 in_progress`. Refusals marked transient (sign in again, busy, a failed live check) and 5xx release
  the key.
- **Client version.** `X-MWA-Client: web/<semver>`; older than `1.0.0` (`MIN_CLIENT`) gets `426 client_too_old`.
- Responses are `application/json` with `cache-control: no-store`, except the SSE streams and the downloads noted.
- Paths below are relative to `/api/v1`. **Scope** is the minimum scope; `public` needs no sign-in.

### Meta and sign-in

| Method | Path | Scope | Body / query | Returns, refusals |
|---|---|---|---|---|
| GET | `/meta` | public | — | `{api: "v1", server, minClient, secure, features[], importing}`. `features`: jobs, calendar, mail, projects, important, ask, today, settings, files, push, plugins, assistant, connections, approvals, memory, activity, setup. `secure` = HTTPS or localhost (install, offline and push need it). `importing` = `{done, total}` bytes while older conversations import, else null |
| GET | `/me` | public | — | `{signedIn, kind: session\|local\|device\|null, deviceId, deviceName, scopes[], passwordSet}` |
| POST | `/session` | public | `{password}` | sets `mwa_session`; `{signedIn, kind: "session", scopes}`. `409 no_password` (none set: pair instead), `400 bad_body`, `401 wrong_password` (throttled) |
| DELETE | `/session` | read | — | ends this password session on the server, clears the cookie, sends `Clear-Site-Data: "cache", "storage"`. `400 not_a_session` |
| POST | `/session/sign-out-everywhere` | admin | — | every password session ends (this one too) and their push subscriptions go; `{signedOut: n, message}`. Paired devices are removed one by one |

### Pairing and devices

| Method | Path | Scope | Body | Returns, refusals |
|---|---|---|---|---|
| POST | `/pair/codes` | admin | — | 201 `{code: "ABCD-EFGH", expiresAt, pairUrl, scopes, reachable}`. One-time, 10 minutes, only its hash is kept. `pairUrl` is `<base>/pair#c=CODE` (the fragment never reaches a server log); from a local page it uses the public address (`MWA_PUBLIC_URL`, Settings, or a tailnet name) and `reachable: false` when none is known |
| POST | `/pair` | public | `{code, name?, platform?, cookie?}` | 201 `{deviceId, scopes}` plus the `mwa_device` cookie (400 days); with `cookie: false` the token comes back in the body as `token` instead (a phone app). `400 pair_code_invalid` (wrong, used and expired are not told apart; throttled) |
| GET | `/devices` | admin | — | `{devices: [{id, name, platform, scopes, createdAt, lastSeen, revokedAt}]}` |
| PATCH | `/devices/{id}` | admin | `{name}` | `{device}`. `400 bad_name`, `404` |
| DELETE | `/devices/{id}` | admin | — | revokes at once (checked on every request) and removes its push subscriptions; `{revoked}`. `404` |
| POST | `/devices/me/sign-out` | read | — | a paired device revokes itself; clears its cookie and site data. `400 not_a_device` |

### Settings and spending

| Method | Path | Scope | Body / query | Returns, refusals |
|---|---|---|---|---|
| GET | `/settings` | read | — | the helper's name, the greeting name, time zone, first-run flag, feature switches, public URL |
| PATCH | `/settings` | admin | one or more of `helperName, ownerName, timeZone, firstRunDone, features, publicUrl` | the settings. `400 bad_body` (unknown field or none), `409 bad_config` |
| GET | `/spending` | read | — | `{month: {label, usd, calls}, limit: {usd, fixed, state, pct}, background: [{purpose, label, usd, calls}], defaults: {handoffMaxUsd: 5, continueMaxUsd: 20, perFireUsd, perFireFixed}}` |
| PATCH | `/spending` | admin | `{monthlyUsd?: number\|null, perFireUsd?: number\|null}` | the spending view. `400 bad_limit` (monthly at least $1), `400 bad_cap` (per-run $0.01–$20), `400 fixed` (set by `MWA_MONTHLY_BUDGET_USD` or at install), `409 bad_config`. Both are checked before either is saved |
| GET | `/spending/detail` | read | — | the last 30 days by day, top 8 models, the 5 costliest conversations/jobs by name (never by session id), this month's tokens, the provider balance (OpenRouter) or null |
| GET | `/spending/calls.csv?days=` | admin | `days` 1–366 (default 30) | `text/csv` download, one row per model call. `400 bad_days` |
| GET | `/vault` | admin | — | `{entries}`: saved logins and keys, names only, never a value |
| POST | `/vault/forget` | admin | `{name}` | `{forgot, message}`. `404` |

### Live updates and offline catch-up

| Method | Path | Scope | Query | Returns |
|---|---|---|---|---|
| GET | `/stream` | read | `cursor` (or `Last-Event-ID`) | **SSE.** `hello {cursor, head}`, then `change` events (`{seq, entity, id, op, data?}` with `id:` = the sequence) for jobs, tries, calendar, items, projects, turns, asks, approvals, devices (admin callers only) and a coarse `today` notice (at most every 5 s); bare notices `{seq, entity, id, op}` with no data for `mail`, `action`, `setup` and `inbox_scan`; when an approval changes, the job waiting on it is sent too; `live` events (a running try's progress, at most once a second per run); `reset` when the cursor is older than the 7 days kept. Keep-alive comment every 15 s. Another person's jobs are never sent. `400 bad_cursor` |
| GET | `/sync` | read | `since`, `collections` (comma list of `jobs, calendar, mail, projects, turns, important, today`; default `jobs`) | `{cursor, reset, more, upserts: {<collection>: [...]}, deletes: {<collection>: [ids]}}`. `since` absent, 0 or too old gives a full snapshot with `reset: true`. Pages of at most 500 events or about 5 MB: `more: true` means call again with the returned cursor. Mail is headers only. `400 unknown_collection\|bad_cursor` |

### Today

| Method | Path | Scope | Body | Returns, refusals |
|---|---|---|---|---|
| GET | `/today` | read | — | the Today screen in one read: `{date, weekday, greeting, part, checkin, wrap, needsYou, nextUp, agenda, doneForYou, doneSince, worthALook, weekLine, month, status, freshness}`. No model call |
| POST | `/today/seen` | act | `{seenAt?}` (ms) | `{seenAt}`: "I looked" for this caller (Done for you lists what came after). `400 bad_seen` |
| POST | `/today/checkin/done` | act | `{day?: "YYYY-MM-DD"}` | `{message, today}`; a mark for another day changes nothing (`ignored: true`). `400 bad_day` |
| POST | `/today/wrap/done` | act | `{day?}` | the evening wrap, same shape |

### Projects, threads and asking

A project has one thread; sending a message into a project starts the same chat run as the classic `/api/chat`, under
the session `p-<id>`. The answer arrives on `/stream` and in the thread.

| Method | Path | Scope | Body / query | Returns, refusals |
|---|---|---|---|---|
| GET | `/projects?archived=1` | read | — | `{projects, importing}` |
| POST | `/projects` | act | `{name, icon?}` | 201 `{project}` |
| GET | `/projects/suggest?text=&from=` | read | — | a routing suggestion for a message. `400 bad_text`, `404` (unknown `from`) |
| PATCH | `/projects/{id}` | act | any of `{name, icon, archived, sort}` | `{project}`. `400 bad_body` |
| GET | `/projects/{id}/thread?before=&limit=` | read | `limit` 1–200 (50) | `{project, turns, next}`. `400 bad_cursor`, `400 bad_limit` |
| POST | `/projects/{id}/messages` | act | `{text, stay?, person?}` (text up to 8000) | 202 `{session, state: started\|offer, runId?, turnId?, message?}`. `409 archived`, `409 busy` (one run per project), `400 bad_text`, `503 unavailable` |
| GET | `/projects/{id}/work` | read | — | `{jobs}` working for this project |
| GET | `/projects/{id}/files` | read | — | `{files, folder}` (the project's folder, at most 500, newest first) |
| POST | `/projects/{id}/stop` | act | `{runId?}` | `{stopped, message}`: the running step finishes, nothing new starts. `409 nothing_running`, `409 not_running` (that run already finished), `400 bad_run` (a `runId` that isn't a string) |
| POST | `/projects/{id}/steer` | act | `{text, runId?}` | `{added, message}`: taken into account at the next step. `409 nothing_running\|not_running`, `400 bad_run` |
| GET | `/projects/{id}/live` | read | — | **SSE**: the running answer's events (the classic chat's event names) until its final event; `gone` when nothing is running |
| POST | `/projects/{id}/offer/accept` | act | `{message?, person?}` | 202: "Work on it" for a waiting offer to work in the background. `409 no_offer` |
| POST | `/turns/{id}/move` | act | `{projectId}` | `{turn, from, message, undo: {projectId}}`: moves a message and its answer |
| POST | `/ask` | act | `{text, projectId?, about?: {kind, id}, files?: [paths], mode?: auto\|now\|background, capUsd?, source?: typed\|voice}` | 202 `{askId, projectId, route, kind: answer\|plan\|job, ...}`. `answer` runs now in the thread; `plan` is a big ask not yet started (cost/time per option and narrower asks); `job` was handed to the background with a spending limit. `about` (kind `item, mail, event, draft, job, conflict`) is answered in place, fenced, never a plan or a job, and takes no files. `files` = up to 10 paths as `POST /files` returns them. `capUsd` $0.01–$20. Errors: `400 bad_text\|bad_mode\|bad_source\|bad_about\|bad_files\|bad_file\|bad_cap`, `404` |
| POST | `/ask/{id}/choose` | act | `{mode: now\|background}` or `{narrowIndex}`, `capUsd?` | 202, a plan's choice, made once (the same choice again replays the first answer). `400 bad_choice` (neither or both of `mode` and `narrowIndex`, an unknown mode, or no narrower ask at that position), `400 bad_cap`, `404`, `409 not_a_plan\|already_chosen\|in_progress\|archived\|files_gone`, `410 expired` (a plan older than a day) |
| GET | `/ask/{id}` | read | — | `{ask, turn}` |
| GET | `/ask?about=kind:id` | read | — | `{about, asks}`: the questions asked about one thing, oldest first |
| GET | `/ask/suggestions?about=kind:id` | read | — | `{about, suggestions}`: 2–3 questions from templates, no model call |

There is no GET-with-the-message route in v1 (`/api/chat?message=` is not carried over), so what the person asks
never sits in a query string. Voice is turned into text by the browser; there is no server speech route.

### Files

| Method | Path | Scope | Body / query | Returns, refusals |
|---|---|---|---|---|
| POST | `/files?projectId=&name=` | act | the file as the raw body, or `multipart/form-data` with one file part | 201 `{id, path, name, size, projectId, pages}`; `path` goes into `/ask` `files`. Saved under the project's `uploads` folder (General when no project) with a cleaned name, never over another file. Limit `MWA_MAX_UPLOAD_MB` (25); all uploads share `MWA_UPLOAD_QUOTA_MB` (2048). A `.docx` is opened with a 20 MB inflation ceiling first. `413 too_large`, `507 storage_full`, `429 busy` (2 at a time per caller, 4 in all), `400 no_file\|no_name\|empty_file\|unsafe_document\|bad_name`, `409 archived`, `404` |
| GET | `/files?projectId=` | read | — | `{projectId, folder, files: [{id, path, name, size, mtime}]}` |

### Jobs (background work)

Status is computed on the server: `working, waiting, continuing, stopped_by_you, partly_done, stopped, scheduled,
done`. Every v1 caller acts for the owner; another person's job (a Telegram contact's) is "No such job".

| Method | Path | Scope | Body / query | Returns, refusals |
|---|---|---|---|---|
| GET | `/jobs?state=&limit=&before=&archived=1` | read | `limit` up to 200 (50) | `{jobs, next}`. `400 bad_state` |
| GET | `/jobs/{id}` | read | — | `{job, tries}` |
| GET | `/jobs/{id}/estimate` | read | — | `{continue?, startOver?, basis, samples}`. `409 not_estimable` (a repeating job) |
| POST | `/jobs/{id}/stop` | act | — | the job and a message. `409 nothing_running`, `409 running_elsewhere` (finishing in another MWA process) |
| POST | `/jobs/{id}/continue` | act | `{capUsd?}` | 202. Default limit: twice the estimate, or the estimate plus three of the job's largest steps and the wrap-up, whichever is more; at least $0.25 ($0.50 when the estimate is a first guess); at most $20; a run that reaches it waits for the person. `409 not_continuable\|nothing_left\|already_running\|refused`, `400 bad_cap` |
| POST | `/jobs/{id}/start-over` | act | `{capUsd?}` | 202, same rules |
| POST | `/jobs/{id}/open` | act | — | marks a result as seen |
| POST | `/jobs/{id}/pause` · `/resume` · `/cancel` | act | — | for a repeating job or a reminder, through the same schedule control as the model's tools. `409 not_recurring\|refused` |

### Calendar

| Method | Path | Scope | Body / query | Returns, refusals |
|---|---|---|---|---|
| GET | `/calendar?from=&to=` | read | dates or ISO times; at most 62 days | `{from, to, items, conflicts}`: cached events plus the drafts MWA holds. `400 bad_range` |
| GET | `/calendar/accounts` | read | — | `{accounts}` |
| POST | `/calendar/refresh` | act | — | `{accounts, results}` |
| POST | `/calendar/drafts` | act | `{title, start, end?, allDay?, location?, notes?, provider?, projectId?, tz?}` | 201 `{draft, message}` (200 when the same draft exists). Nothing is on a calendar until confirmed. `400 bad_draft` |
| POST | `/calendar/drafts/{id}/confirm` | act | `{provider?}` | `{draft, message, already}`: adds it, no invites. Confirm is never a model tool |
| POST | `/calendar/drafts/{id}/remove` | act | — | `{draft, message}` |
| GET | `/calendar/drafts/{id}.ics` | read | — | `text/calendar` download. `404` once removed |

### Mail (read and draft, never send)

There is no send route, and the providers have no send.

| Method | Path | Scope | Body / query | Returns, refusals |
|---|---|---|---|---|
| GET | `/mail?before=&limit=` | read | `limit` 1–200 (50) | `{mail: [headers], nextBefore, note, connected}`. `400 bad_limit\|bad_cursor` |
| GET | `/mail/accounts` | read | — | `{accounts, note}` |
| POST | `/mail/refresh` | act | — | 200 `{done: true, accounts, message}` or 202 when still checking after 20 s. `409 not_connected` |
| GET | `/mail/{id}` | read | — | the header plus `to, replyTo, replyGoesElsewhere, replyNote, bodyText` (sanitised plain text), `truncated, tooComplex, quotedLinesHidden, imagesHidden, trackersRemoved, trust: "untrusted", fetchedAt` |
| POST | `/mail/{id}/draft` | act | `{body}` | 201 `{saved: true, sent: false, account, draftId, alreadySaved, message: "Saved to your drafts. Nothing was sent.", to, replyNote}`. The draft id comes from the Idempotency-Key, so a retry finds the draft it made. `400 bad_body\|too_long` |

### Important ("Worth a look")

| Method | Path | Scope | Body / query | Returns, refusals |
|---|---|---|---|---|
| GET | `/items?state=open\|handled\|not-important&group=` | read | — | the list grouped Today / This week / Earlier, with what was skipped per group. `400 bad_state` |
| GET | `/items/skipped?group=` | read | — | `{group, count, skipped: [{mail, group, kind, reason, byYou}]}` (headers only) |
| POST | `/items/{id}/handled` | act | — | `{item, already, message}` |
| POST | `/items/{id}/unhandle` | act | — | the Undo. `409 not_handled` |
| POST | `/items/{id}/not-important` | act | `{scope: sender\|domain\|kind}` (sender) | `{item, rule, effect?, message}`: teaches the filter. A `kind` is learned only from how a message is sent (a list, a promotion, a receipt), never from its text: `400 kind_not_available`; a free-mail domain is refused: `400 freemail_domain`; `400 bad_scope` |
| POST | `/mail/{id}/important` | act | — | "This was important" on a skipped message: `{item, rule, message}` |
| GET | `/triage/rules` | read | — | `{rules: [{id, match, value, verdict, createdAt, effect}]}` |
| DELETE | `/triage/rules/{id}` | act | — | `{removed, message}` |
| POST | `/items/{id}/action` | act | — | the item's one action: `add-to-calendar` (an MWA-held draft, confirmed separately), `remind`, or a route to open (`review-reply`, `open-job`, `reconnect`, `review-approval`, `draft-note`). `409 not_open\|no_action`, `503 unavailable` |
| POST | `/important/refresh` | act | — | 200 `{done, sorting, message}`, or 202 while still sorting |

Rules are written only from the person's own taps. Nothing a message says reaches a write on its own.

### Approvals

The same decision code as the classic `/api/approvals/confirm` and `/cancel` (`src/approval-decisions.ts`).

| Method | Path | Scope | Body | Returns, refusals |
|---|---|---|---|---|
| GET | `/approvals` | read | — | `{pending, recent}` (pending oldest first; recent = decided in the last day). A caller without `approve` sees file text, the exact action and its output cut to 300 characters |
| GET | `/approvals/{id}` | read | — | `{approval}` in any state |
| POST | `/approvals/{id}/approve` | approve | `{confirmed?, note?}` | `{outcome: done\|failed\|approved\|not_done, message, approval}`. A high-risk one (`confirm` in its view: phishing-traced, outside content, money, sending, deleting, the network) needs `confirmed: true`, else `409 confirm_needed` naming the risks. `409 already_decided\|expired\|step_up_required\|refused\|not_here`, `404` |
| POST | `/approvals/{id}/deny` | approve | `{note?}` (up to 500 characters, passed to the helper) | `{outcome: declined, message, approval}`. The same refusals as approve except `confirm_needed`: `409 already_decided\|expired\|step_up_required\|refused\|not_here`, `400 bad_note`, `404` |

There is no "always allow this kind". A decision is final; one made on another device or in Telegram is 409 here.

### Plug-ins (MCP servers)

Every change takes effect on the next message. Key values go in, never out.

| Method | Path | Scope | Body | Returns, refusals |
|---|---|---|---|---|
| GET | `/plugins` | read | — | the library (on/off, what it can touch, key names and whether each is saved), the owner's own (command shown, env values and secret-looking arguments hidden; the command's arguments shown only to admin callers, `argsHidden: true` otherwise), and whether "add from npm" is available |
| POST | `/plugins/{id}/enable` | admin | — | `{plugin, message}`. `409 needs_keys\|not_enabled`, `404` |
| POST | `/plugins/{id}/disable` | admin | — | `{plugin, message}` |
| PUT | `/plugins/{id}/keys` | admin | `{keys: {NAME: value}}` | only names the plug-in declares. `400 unknown_key\|bad_value\|bad_body` |
| DELETE | `/plugins/{id}/keys/{name}` | admin | — | clears one key. `400 unknown_key` (a name the plug-in doesn't declare), `409 in_use` (on and required), `404 not_saved` |
| DELETE | `/plugins/{id}` | admin | — | removes one of the owner's own. `400 library_plugin` (turn it off instead), `404` |
| POST | `/plugins/review` | admin | `{package}` | `{review}`: the safety review of an npm package; nothing is installed. `400 bad_package`, `409 npm_unavailable` (needs a strong enough brain), `503 review_failed` |
| POST | `/plugins/approve` | admin | `{package, acceptRisk?}` | installs a package reviewed in the last 30 minutes at the version reviewed. `409 review_first\|not_installable\|unreviewed\|risky\|name_taken` (`unreviewed` and `risky` need `acceptRisk: true`; never overwrites an existing plug-in) |

### Your assistant

| Method | Path | Scope | Body | Returns, refusals |
|---|---|---|---|---|
| GET | `/assistant` | read | — | the brain, the image model, providers (whether a key is saved, never the key), access level and granted folders, style, whether "add from npm" is available |
| POST | `/assistant/models` | admin | `{provider, kind?: chat\|image, key?}` | `{provider, kind, models}`; a key typed here is used for this listing only |
| PUT | `/assistant/brain` | admin | `{provider, model, key?, baseUrl?}` | checks the model live with the key, then saves. `400 check_failed` (transient), `409 fixed` |
| PUT | `/assistant/image` | admin | `{provider, model, key?, baseUrl?}` | sets the image model. `400 bad_model` |
| DELETE | `/assistant/image` | admin | — | turns image generation off |
| PUT | `/assistant/access` | admin | `{preset: locked-down\|assistant\|developer}` | the access level. `400 bad_preset` |
| POST | `/assistant/folders` | admin | `{path}` | grants a folder. Refused outright (`folderProblem` in `src/assistant-settings.ts`): a relative path, a network share, a whole drive, a folder holding the helper's own keys and settings, and any folder inside or containing the helper's data (memory, sign-ins, saved logins), compared where the folder really is, so a link or junction does not get past it. `400 bad_folder\|not_found\|refused` |
| POST | `/assistant/folders/remove` | admin | `{path}` | `404 not_granted` |
| PUT | `/assistant/style` | admin | `{style: guided\|direct}` | `400 bad_style` |

Each answers `{assistant, message}`.

### Connections

| Method | Path | Scope | Body | Returns, refusals |
|---|---|---|---|---|
| GET | `/connections` | read | — | Google, Outlook, Telegram, Tailscale: connected, how, needs reconnecting, which sign-ins work here (`server` when hosted), returned as the view itself. Never a key, secret, password or token. The writes below answer `{connections, message}` |
| POST | `/connections/gmail/app-password` | admin | `{address, appPassword}` | checked over IMAP, then saved |
| PUT | `/connections/google/app` | admin | `{clientId, clientSecret}` | your own Google sign-in app |
| PUT | `/connections/outlook/app` | admin | `{clientId, tenant?}` | your own Microsoft app |
| PUT | `/connections/telegram` | admin | `{token}` | checked with Telegram, then saved |
| PUT | `/connections/tailscale` | admin | `{authKey, hostname?}` | used at the next restart |
| DELETE | `/connections/{service}` | admin | — | `google`, `outlook`, `telegram` or `tailscale` |
| GET | `/accounts` | read | — | `{accounts: [{provider, label, what, connected, needsReconnect, method, connect: browser\|code\|setup}]}` |
| POST | `/accounts/{provider}/connect` | admin | `{method?: browser\|code, readOnly?}` | `{kind: browser\|code\|setup, url, code?, expiresIn?, message}`. Outlook offers a device code or a browser sign-in; Google a browser sign-in or an app password. `400 browser_not_here` (a browser sign-in can't finish on a hosted server), `400 bad_method`, `503 provider_unavailable` |
| POST | `/accounts/{provider}/cancel` | admin | — | stops waiting for a sign-in that was started: `{cancelled, message}` |

Connections answers are `{connections, message}`; a failed live check is `400 check_failed` (transient).

### Memory and activity

| Method | Path | Scope | Body / query | Returns, refusals |
|---|---|---|---|---|
| GET | `/memory?q=&limit=` | read | `limit` 1–500 (40) | `{facts: [{id, name, text, truncated, full, about, source: you\|inferred\|outside, origin, trusted}], total, query, preferences, routines}` |
| POST | `/memory/{id}/correct` | admin | `{text, name?, confirmed?}` | replaces a fact with your words (trusted). A fact from outside needs `confirmed: true`: `409 confirm_needed` |
| POST | `/memory/{id}/forget` | admin | `{confirmed: true}` | forgets for good. `409 confirm_needed`, `404` |
| GET | `/memory/export` | admin | — | `text/markdown` download (`mwa-memory.md`) |
| POST | `/memory/preferences/remove` | admin | `{rule, confirmed: true}` | `{removed, preferences, message}` |
| POST | `/memory/routines/{id}/promote` | admin | `{confirmed: true, store?}` | its steps guide similar tasks from now on |
| POST | `/memory/routines/{id}/retire` | admin | `{store?}` | — |
| GET | `/activity?limit=` | read | 1–200 (60) | the recent runs in plain words: how each ended, tools by name, cost; pasted secrets masked |

### Setup (getting going)

| Method | Path | Scope | Body | Returns, refusals |
|---|---|---|---|---|
| GET | `/setup` | read | — | `{brain, storage, inbox, folderNote, cardsWaiting}` |
| POST | `/setup/warm` | admin | — | gets the local memory models ready (downloads them the first time). `503 unavailable` |
| POST | `/setup/folder/scan` | admin | `{path}` | `{scanId, folder, filesScanned, truncated, notes, message}`: reads one folder into notes to look over. The folder must pass the same rules as granted folders; nothing is saved or granted |
| POST | `/setup/folder/save` | admin | `{scanId, keep}` | `{saved, message}`; kept notes stay marked as from your files (untrusted). `409 scan_expired` |
| GET | `/setup/inbox` | read | — | "Get to know me": how the inbox scan is going and what it learned |
| POST | `/setup/inbox` | admin | `{days?: 1–730 (30), confirmed}` | 202 `{scan, message}`. It costs money: without `confirmed: true` the answer is `409 confirm_needed` with the estimate. `409 already_running\|no_email` |
| POST | `/setup/inbox/stop` | admin | — | stops between rounds; what it learned is kept |
| GET | `/setup/cards` | read | — | `{cards, canSubmit}`: a password or key the helper asked for mid-task (never a value) |
| POST | `/setup/cards/{id}/submit` | admin | `{values}` | checked, saved, never sent back. `400 bad_value` (no values), `409 not_waiting` |
| POST | `/setup/cards/{id}/cancel` | approve | — | closes it without filling it |
| PUT | `/setup/storage` | admin | `{kind: sqlite\|postgres, url? (postgres://…), bringMemory?, confirmed}` | where memory is kept, from the next restart; the address never comes back. `409 confirm_needed`, `409 fixed` (the server's `AWM_STORE_BACKEND`/`AWM_DATABASE_URL` decides), `400 bad_kind\|bad_url` |

### Push notifications

Payloads carry no personal content. Subscriptions belong to the device or session that made them; revoking the device
or signing the session out removes them.

| Method | Path | Scope | Body | Returns, refusals |
|---|---|---|---|---|
| GET | `/push/subscriptions` | read | — | `{vapidPublicKey, keysReset, subscriptions, settings: {kinds, morning, timeZone, quietHours}}`; the caller's own subscriptions (an admin sees all; the endpoint only to its own browser) |
| POST | `/push/subscriptions` | act | `{endpoint, keys: {p256dh, auth}, expirationTime?, platform?, replaces?}` | 201 `{subscription}`. Only https endpoints on the known push services. `400 bad_endpoint\|bad_keys`, `409` (another device's endpoint, or the cap) |
| DELETE | `/push/subscriptions/{id}` | act | — | the caller's own (an admin: any). `404` |
| PATCH | `/push/settings` | admin | any of `{kinds: {approval, waiting, result, morning: bool}, morning: "HH:MM" (05:00–11:30), quietHours: "HH:MM-HH:MM"\|null}` | the settings. `400 bad_kinds\|bad_time\|bad_quiet\|fixed` (`MWA_QUIET_HOURS` set) |
| POST | `/push/test` | act | — | sends a test to the caller's own subscriptions: `{accepted, gone, failed, results, message}`. `409 not_subscribed`, `429 too_many_tests` |

---

# Classic routes (`/api/*`)

The classic app (Settings › About › "Use the classic app", or `/?ui=v1`) and older integrations use these. Each needs
the scope listed under [Who may call](#who-may-call-both-apis); the "same-origin only" notes below still apply.

## Chat

### `GET /api/chat?message=<text>&session=<id>` → SSE
Streams one agent run as Server-Sent Events. Events: `run` (`{runId, startedAt}`), `start`, `recall`, `read`,
`remember`, `tool`, `step` (`{n, of, tool, detail, elapsedMs}` — one per tool call, with the file, folder, query or
address it touches), `dispatch`, `sleep`, `escalate`, `verify`, `ask`, `steered`, `stopping`, `stopped`, then a final
`result` (`{reason, summary, steps, dispatches, toolCalls, costUsd, runId, turnId, elapsedMs, staged?}`) or `error`
(`{message}`). `session` groups follow-ups (per-session working dir + brief history).
Concurrency is capped (`MWA_MAX_CONCURRENT`, default 4) — over the cap returns an
`error` event ("at capacity"). One run per conversation: a message sent while one is going gets a `busy` event
(`{runId, message, startedAt, elapsedMs, stopping, stage?}`) and no second run.
`stay=1` runs a request in the chat that would otherwise be offered to the background, and records "do it here" on
the waiting offer with those words. `resume=1`, or `resume=<ts of the stopped turn>` ("Continue from where it
stopped"), picks that stopped run (else the last one not yet continued) up from its own words, framed as a resume
in the same folder, never offered to the background and not put to the continuity classifier (the `topic` event
carries `resumed: true`); a stopped run that had read outside content resumes tainted, its last word fenced. With
nothing stopped, `message` runs as a plain message, still without the offer.

### Live runs (usability review 2026-10-24)
| Route | Method | Body / effect |
|---|---|---|
| `/api/chat/live?session=` | GET | `{live: {runId, message, startedAt, elapsedMs, stopping, stage?} \| null, running}`. A fired job runs under the session `job_<id>` (its row in `/api/schedule` carries the same under `live`), so every route in this table reaches a background run too. |
| `/api/chat/attach?session=` | GET → SSE | replays the live run's events so far and follows it to `result`; `gone` when nothing is running (a reload re-attaches instead of losing the answer) |
| `/api/chat/stop` | POST | `{session}` — the run ends at its next step with reason `stopped` and a summary of what it kept |
| `/api/chat/steer` | POST | `{session, message}` — queued into the run; the model gets it at its next step as the person's own words |
| `/api/conversation?session=` | GET | `{session, folder, turns:[{ts, message, reply, reason?, kind: chat\|result\|offer\|running, runId?, offer?}]}` — the conversation in full. An `offer` turn (the agent offered to work in the background) carries `offer: {answered: background\|now, goal?, at}` once the person answered it, from any device: `goal` is the short id of the goal "Work on it" made |
| `/api/billing` | GET | `{now, month:{cost, calls, tokens, from, label}, days:[{day, cost, calls}] (30), byModel, bySession (top 10, kind chat\|job), budget:{monthlyUsd, usedUsd, pct, state: none\|ok\|warn\|over, fixed}, balance:{provider, remainingUsd, at}\|null, logPath}` — the model-call log summed; the balance is the provider's own (OpenRouter credits), cached ten minutes |
| `/api/billing.csv?days=30` | GET | the calls of the last N days as CSV, one row each (time, session, job, model, route, host, background, tokens, cost) |
| `/api/billing/budget` | POST | `{value}` — dollars for the month, or `off`; refused when `MWA_MONTHLY_BUDGET_USD` fixes it |
| `/api/policies/forget` | POST | `{rule}` → `{ok, removed, message}` — removes a standing preference by its words (every engram carrying the rule), the person's own click from the saved card or Memory › Standing preferences |
| `/api/work/start` | POST | `{message, session}` → `{ok, goal, message}` — "Work on it": makes a goal and a job in the conversation's folder, and records the answer on the conversation's waiting offer (the one with these words, else the latest) |

### Sources
| Route | Method | Returns |
|---|---|---|
| `/api/sources?session=` | GET | `{preset, folders:[{path, files, capped, readable}], added:[…]}` — the granted folders the run can read and the files added to this chat |

### Schedule
| Route | Method | Body / effect |
|---|---|---|
| `/api/schedule?person=` | GET | `{scheduled:[{id, kind: reminder\|watch\|task, request, instruction, due, recur, when, paused, tainted, allow, goal?, session?, lastRun?, fails?}]}` — this person's jobs; `session` is the web conversation it reports to (absent for Telegram), so the app shows the job inside the task that set it up; `allow` is `{vault?: [names], click?: [{host, label}]}` or null: what the job may do unattended in the browser (docs/browser.md) |
| `/api/schedule/cancel` | POST | `{id}` — stops it; undo within ten minutes |
| `/api/schedule/uncancel` | POST | `{id}` — the undo |
| `/api/schedule/pause` · `/resume` | POST | `{id}` — a paused job keeps its settings and does not run; resume sets its next natural slot |
| `/api/schedule/update` | POST | `{id, instruction?, at?, daily_at?, days?, every_minutes?}` — the same fields as the model's `schedule_update` |

### Settings (interface slice 2026-10-25)
| Route | Method | Body / effect |
|---|---|---|
| `/api/vault` | GET | `{entries:[{name, site?, fields:[names], savedAt?}]}` — saved logins and keys, never a value |
| `/api/vault/forget` | POST | `{name}` — deletes one entry. **Same-origin only.** Saving stays in the vault card the agent opens (BL-63). |
| `/api/quiet` | GET | `{window: "HH:MM-HH:MM" \| null, timeZone, fixed, invalid}` — quiet hours (BL-07) |
| `/api/quiet` | POST | `{value: "HH:MM-HH:MM" \| "off"}` — sets or clears them in `mwa.config.json`; refused when `MWA_QUIET_HOURS` fixes the window. **Admin only, same-origin.** |

## Status & observability

| Route | Method | Returns |
|---|---|---|
| `/api/status` | GET | provider + connection configuration state |
| `/api/health` | GET | public, and exempt from the Host check. Signed in: `{ok, uptimeSec, db, memoryCount, activeRuns, chatRuns, schedulerRuns, sessions, schedulerLastTickAgoSec}`; anyone else gets only `{ok, db}`. **503** if the DB is unreachable. Used by the Docker healthcheck. |
| `/api/logs?since=<ts>&level=<info\|warn\|error>` | GET | `{logs:[{ts,level,category,msg,data}]}` — recent structured logs, newest first |
| `/api/runs` | GET | recent run-log entries |
| `/api/notifications?since=<ts>` | GET | recent scheduler/agent notifications |
| `/api/suggestions` | GET | starter prompts for the empty state |
| `/api/questions` | GET/POST | open self-learning questions (GET) / answer one (POST) |

## Configuration & connections

| Route | Method | Body / effect |
|---|---|---|
| `/api/save` | POST | `{which: 'anthropic'\|'azure'\|'provider'\|'telegram'\|'google'\|'microsoft'\|'access', …}` — validates with a live test call, writes to `.env` / `mwa.config.json`. Returns `{ok, message}` (never echoes the key). |
| `/api/connections` | GET/POST | configured connectors/secrets state; enable/connect flows |
| `/api/login` | POST | `{password}` → `{ok}` and the `mwa_session` cookie. The same throttle and server-side session as `POST /api/v1/session`. **409** when no password is set, **401** for a wrong one. **Same-origin only.** |

## Write approvals (two-step gate)

The UI half of the tool-approval gate (the agent uses `confirm_action` in chat;
a human can review here instead).

| Route | Method | Body / effect |
|---|---|---|
| `/api/approvals` | GET | `{pending:[{id,tool,summary,expiresInSec,expiresAt,createdAt,tainted,readLocal,kind,session,runId?}], recent:[{id,tool,status,summary,kind,session?,result?,at,createdAt}], auto:[…]}` — `recent` keeps every ending (done, approved, failed, declined as `cancelled`, expired) for a day |
| `/api/approvals/confirm` | POST | `{id?}` — execute a pending action (omit id = the single most recent) |
| `/api/approvals/cancel` | POST | `{id}` — discard a pending action |

## Memory (Glass Box)

The transparency + control surface over what the agent knows and has done. Every fact carries
**provenance** and a **trust** tier (the spine — see
[the-memory-substrate.md](the-memory-substrate.md)).

| Route | Method | Body / returns |
|---|---|---|
| `/api/memories` | GET | `{memories:[{id, concept, content, trust, provenance, origin?}]}` — recent learned facts with provenance/trust, newest first |
| `/api/actions` | GET | `{actions:[{id, verb, summary, effect, tool?, undo?}]}` — the "what I did" side-effecting action log |
| `/api/memory/export` | GET | `text/markdown` attachment — everything MWA knows, portable + provenance-annotated |
| `/api/memory/forget` | POST | `{id}` — hard-delete one memory (privacy). **Same-origin only.** |
| `/api/memory/correct` | POST | `{id, concept, content}` — replace a fact with your authoritative text (becomes trusted); deterministic + rolls back on failure; rejects a non-existent id. **Same-origin only.** |

The state-changing routes (`forget` / `correct`) require a same-origin request (CSRF defense) and
mint nothing for a forged id.

## People & identity (per-person Profile, S1–S6)

The per-person layer (see [true-agent-and-person-profile.md](true-agent-and-person-profile.md)). A
person is resolved from the channel (Telegram chat id, email sender, or the web `?person=<name>` param);
profiles are hard-isolated per person.

| Route | Method | Body / returns |
|---|---|---|
| `/api/people` | GET | `{people:[{personId, notes, fields, missing, dossier}]}` — everyone the agent has a profile for, with intake-field coverage + current dossier. |
| `/api/stepup/issue` | POST | `{personId, purpose?}` → `{ok, challengeId}` or `{ok:false, reason:'no-factor'\|'delivery-failed'}`. Issues a step-up challenge and delivers a one-time code **out-of-band** to the person's validated connection (Telegram). **Same-origin only.** |
| `/api/stepup/verify` | POST | `{challengeId, code}` → `{ok, reason?}` — verify the code; single-use, 3-attempt cap, 5-min TTL. On success the person is step-up-satisfied (and un-suspected). **Same-origin only.** |

`GET /api/chat` also emits per-person SSE events: `person {id, notes}` (who + how much is known),
`identity {level:'mismatch'}` (a self-claim contradicts the record — **the stored name/reasons are NOT
sent to the client**), and `learned {about, count}` (durable facts captured this turn).

When identity is in doubt, a sensitive `confirm_action` is **mechanically blocked** at the approval
gate until a step-up is verified (`isStepUpSatisfied`); suspicion is sticky across turns.

## Ingest

| Route | Method | Body / returns |
|---|---|---|
| `/api/ingest?days=<n>` | GET → SSE | Scan the connected inbox and write durable memories from it. Side-effecting → **same-origin only.** |

# Relevant env vars (both APIs)

| Var | Default | Meaning |
|---|---|---|
| `MWA_SERVE_HOST` | `127.0.0.1` | bind host (`0.0.0.0` in Docker) |
| `MWA_TOPIC_NAMESPACE` | `0` | `1` = scope chat recall + fact-writes to the active topic (no cross-topic bleed); off by default to preserve cross-session continuity |
| `MWA_AUTO_ROUTINES` | `0` | `1` = after a complex successful run, propose a versioned, injection-scanned routine (propose-not-commit) |
| `MWA_ACCESS_PASSWORD` | — | when set, the password session is how a browser signs in, and nobody counts as "this machine" |
| `MWA_ALLOWED_HOSTS` | — | extra host names the server answers to (comma-separated, `*.suffix` allowed, `*` = no Host check). A non-local name also turns on relayed mode |
| `MWA_PUBLIC_URL` | — | the address phones use (pairing links); its host is allowed and turns on relayed mode |
| `MWA_RELAYED` | auto | `1` = never trust a loopback socket as this machine (any relay in front); `0` = force off |
| `MWA_TRUSTED_PROXY` | — | IPs or CIDR ranges whose `X-Forwarded-For` is believed for the sign-in throttle |
| `MWA_MAX_UPLOAD_MB` | `25` | one upload's limit |
| `MWA_UPLOAD_QUOTA_MB` | `2048` | all uploads together |
| `MWA_QUIET_HOURS` / `MWA_MONTHLY_BUDGET_USD` | — | when set, fix quiet hours / the monthly limit so the app can't change them |
| `MWA_MAX_CONCURRENT` | `4` | max parallel agent runs |
| `MWA_MAX_TOKENS` | `400000` | per-run token cap (brain+worker) |
| `MWA_SESSION_TTL_MS` | `1800000` | idle session eviction (30 min) |
| `MWA_CONFIG_PATH` | `mwa.config.json` | config file location |
| `MWA_LOG` | `./data/mwa.log` | structured log file |
| `MWA_DB` / `MWA_ENV_PATH` / `MWA_WORKSPACE` | `./data/*` | DB / secrets / workspace paths |
