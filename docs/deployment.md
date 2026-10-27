# MWA Deployment Guide

How to run MWA (Memory Working Agent) anywhere — local desktop, self-hosted Docker/NAS,
Railway (cloud), or Azure (USEA). One image, one config model; only the **target** and the
**memory backend** change.

> Versions: MWA **0.5.0**, AWM **0.10.0** (pluggable backend). Not yet published to npm —
> deploys build from source (the repo + the vendored AWM submodule).

---

## 0. Pick your target (decision matrix)

| Target | Who it's for | Memory backend | Reachable via | Effort |
|---|---|---|---|---|
| **A · Local desktop** | one person, their own machine | SQLite (file) | the app window | double-click installer |
| **B · Self-host Docker / NAS** | home server, Synology | SQLite volume (or Postgres) | LAN / Tailscale | `docker run` |
| **C · Railway (cloud)** | always-on dogfood, team agent | SQLite volume *or* Railway Postgres | public URL *or* Tailscale | `railway up` |
| **D · Azure Container Apps** | USEA / enterprise tenant | **managed Postgres** (recommended) | Tailscale (no public port) | see `usea-azure-deploy-plan.md` |

**Backend rule of thumb:** embedded **SQLite** for a single always-one-process instance
(local, NAS, single Railway replica). **Postgres** when you need multiple replicas, an
external managed DB, or you're on a network filesystem (Azure Files) where SQLite locking
misbehaves. PGlite is not recommended (single-process; Windows/Node22 crash) — don't use it.

---

## 1. What persists (the 3 things that ARE your install)

Everything else is disposable code. Back these up before any update/migration:

| Thing | What it is | Local desktop path | Docker/cloud path |
|---|---|---|---|
| **`.env`** | secrets: model API keys, Tailscale key, bot tokens | `%APPDATA%\com.completeideas.mwa\data\.env` | `/data/.env` (volume) |
| **memory** | the AWM store (everything it knows) | `…\data\agent.db` (+ `-wal`,`-shm`) | `/data/agent.db` *or* Postgres |
| **`mwa.config.json`** | model choice, access preset, MCP tools | `%LOCALAPPDATA%\MWA\runtime\mwa.config.json` | `/data` or image |

Secrets live **only** here (gitignored, mode 0600). Memory is portable between backends with
`awm export`/`import` (§7).

---

## 2. Target A — Local desktop (the installed app)

The Tauri app (`app.exe --autostart`) supervises a Node **sidecar**
(`runtime\dist\cli.js serve` on `:7788`) and the webview points at it. Backend: SQLite.

**Update an existing install to a new version** (the proven, no-data-loss procedure):
1. `npm run build` in the repo (builds AWM + tsc + UI).
2. **Back up** `%APPDATA%\com.completeideas.mwa\data\` + `%LOCALAPPDATA%\MWA\runtime\mwa.config.json`.
3. **Deploy code only** (never touch the data dir):
   - `dist/*` → `%LOCALAPPDATA%\MWA\runtime\dist\`
   - `dist-ui/*` → `%LOCALAPPDATA%\MWA\runtime\dist-ui\`
   - `vendor/agent-working-memory/dist/*` → `…\runtime\node_modules\agent-working-memory\dist\`
4. **Restart**: `Stop-Process` the sidecar PID (find via `Get-CimInstance Win32_Process` where
   CommandLine matches `MWA\runtime` — **never** broad `taskkill`); `app.exe` respawns it.
5. **Verify**: `GET :7788/api/health` → `memoryCount` unchanged + `uptimeSec` reset.
6. **Quit and reopen the whole app** (not just reload the window) so the webview loads the new
   UI — a window-reload can serve a stale service-worker shell.

> Local Postgres: the desktop runtime doesn't bundle `pg`. If you ever point the local app at a
> Postgres server, add it once: `npm i pg --prefix %LOCALAPPDATA%\MWA\runtime`. SQLite is the
> right local backend otherwise.

---

## 3. Target B — Self-host Docker / NAS

```sh
docker run -d --name mwa -p 7788:7788 -v mwa-data:/data \
  -e MWA_ACCESS_PASSWORD=change-me \
  ghcr.io/completeideas/mwa     # or: docker build -t mwa . && docker run … mwa
```
- Open `http://<host>:7788`, unlock, finish setup in the browser.
- `/data` (volume) holds `.env`, `agent.db`, the workspace. Recall models are baked into the
  image layer (NOT the volume) — don't move them.
- **Always** set `MWA_ACCESS_PASSWORD` *or* keep it reachable only over Tailscale (§6).
- Synology/NAS: prefer `docker-compose.yml` + a bind mount `/volume1/docker/mwa/data:/data`.
  See `docs/deploy-nas.md`.

---

## 4. Target C — Railway (cloud dogfood)

The quickest always-on path. Railway's AUP permits this agent class.

1. **Project**: new Railway project → deploy from the repo (Dockerfile build) or `railway up`.
2. **Volume**: attach a volume mounted at `/data` (secrets + SQLite + workspace live there).
   *Gotcha:* Railway volumes are NOT mounted during BUILD — that's why the Dockerfile bakes
   recall models into an image layer, not `/data`. Don't change that.
3. **Backend choice**:
   - *Simple:* SQLite on the `/data` volume (one replica). Nothing to set.
   - *Scale:* add a **Railway Postgres** plugin → set `AWM_STORE_BACKEND=postgres` +
     `AWM_DATABASE_URL=<the plugin's DATABASE_URL>` (enable the `vector` extension).
4. **Access** (pick one):
   - Public URL + `MWA_ACCESS_PASSWORD` (set it — the URL is internet-facing), **or**
   - **Tailscale**: set `TAILSCALE_AUTHKEY=tskey-auth-…` → reachable at its tailnet name with
     **no public port** (set Railway ingress off). Password becomes a second factor.
5. **Model**: set the brain by env — `MWA_MODEL=<provider:model>` (e.g.
   `openrouter:~google/gemini-flash-latest`) + the provider key (`OPENROUTER_API_KEY` /
   `ANTHROPIC_API_KEY` / `AZURE_GPT_*`). `MWA_MODEL` makes the container come up **ready-to-chat**
   with no config file on a fresh volume.
6. **Env to set**: `MWA_ACCESS_PASSWORD`, `MWA_MODEL` + the model key, `MWA_CONFIG_PATH=/data/mwa.config.json`
   (so UI setting changes persist on the volume), optional `TELEGRAM_BOT_TOKEN`, optional
   `TAILSCALE_AUTHKEY`, and (if scale) `AWM_STORE_BACKEND` + `AWM_DATABASE_URL`.
7. **Verify**: open the URL → "MWA — Sign in" → unlock with the password → it's ready on your model.

### Railway gotchas (verified 2026-06-30)
- **`VOLUME` in the Dockerfile is rejected** — *"docker VOLUME … is not supported, use Railway
  Volumes."* MWA's Dockerfile no longer has a `VOLUME` line; persistence is the Railway Volume you
  attach at `/data` (`railway volume add -m /data`). For self-host/NAS the `-v` run-flag still works.
- **Port** — Railway routes to its own port, not 7788. MWA now honors `$PORT` (PaaS-injected) so it
  binds the right port automatically. If you ever see persistent `502`, set `MWA_SERVE_PORT=8080`.
- **CLI quick reference** (account token = `RAILWAY_API_TOKEN`, NOT `RAILWAY_TOKEN`):
  ```sh
  railway init -n <name>
  railway add --service <svc> --variables "MWA_MODEL=openrouter:…" --variables "MWA_ACCESS_PASSWORD=…"
  printf '%s' "$KEY" | railway variable set OPENROUTER_API_KEY --stdin -s <svc> --skip-deploys   # secret, no echo
  railway service <svc>; MSYS_NO_PATHCONV=1 railway volume add -m /data                            # Git Bash mangles /data → MSYS_NO_PATHCONV=1
  railway up -d            # build + deploy (Dockerfile)
  railway domain          # public URL
  ```

---

## 5. Target D — Azure Container Apps (USEA)

Keeps USEA data in USEA's Azure tenant; Postgres + Tailscale; no public port. Full runbook
(provisioning, Key Vault, the domain MCP servers, the memory port, safety gates) is in
**`docs/usea-azure-deploy-plan.md`** — that doc is the source of truth for the USEA deploy.
Summary: Container App (ingress disabled) → **Azure Database for PostgreSQL + pgvector**
(`AWM_STORE_BACKEND=postgres`, `AWM_DATABASE_URL` from Key Vault) → native Tailscale at boot →
domain pack (`MWA_DOMAIN_PACK`) + 4 domain MCP servers → port the existing 222-memory store in (§7).
**Shadow only** until the migration safety gates (dryrun→confirm, dual-run parity) pass.

---

## 6. Cross-cutting setup

### Backend (SQLite ⇄ Postgres)
- **In the app:** Connections → **Memory storage** → *This computer* (SQLite) or *Database
  server* (paste a `postgres://…` URL; it's validated by connecting + provisions the schema).
- **By env:** `AWM_STORE_BACKEND=sqlite|postgres`; for Postgres also `AWM_DATABASE_URL`
  (`…?sslmode=require` on Azure). Takes effect on restart.
- Postgres needs the **pgvector** extension available (the `pgvector/pgvector` image has it;
  Azure Flexible Server: add `vector` to `azure.extensions`).

### Private access (Tailscale)
- Generate a Tailscale **auth key** (`tskey-auth-…`, NOT the management API key).
- Set it in the app (Connections → Tailscale) or as `TAILSCALE_AUTHKEY`. At boot the container
  joins your tailnet (userspace networking) and is reachable at its tailnet name — **no public
  port**. Keep `MWA_ACCESS_PASSWORD` as a second factor.
- HTTPS for phones (v2 P1): the container also runs `tailscale serve --bg --https=443 http://127.0.0.1:<port>` (tailnet
  only, Funnel never on) and sets `MWA_PUBLIC_URL=https://<name>.<tailnet>.ts.net` unless you set it. Phones need that
  https address to install the app and keep it offline. Needs MagicDNS + HTTPS certificates enabled in the Tailscale admin
  (https://login.tailscale.com/admin/dns). `TAILSCALE_SERVE=0` turns it off. On a computer (no Docker):
  `npm run tailscale:serve`, which prints the .env lines: `MWA_PUBLIC_URL`, `MWA_ALLOWED_HOSTS=<name>.<tailnet>.ts.net`,
  optionally `MWA_TRUSTED_PROXY=127.0.0.1`, and `MWA_ACCESS_PASSWORD` (required: relayed, nobody is "this machine")
  (see docs/onboarding-and-pairing.html#secure-address).

### Secrets
- Local/Docker: `.env` on the data volume (0600, gitignored). Azure: **Key Vault** → secret refs.
- Never commit secrets; never log them. Setup endpoints are same-origin guarded (CSRF) and strip
  newlines from values.

### Health & rollback
- Health: `GET /api/health` → `{ok, db, memoryCount, uptimeSec, schedulerLastTickAgoSec}`
  (503 if the DB is unreachable). Docker `HEALTHCHECK` uses it.
- Rollback (desktop): restore the pre-update backup dir + restart the sidecar.
- Rollback (cloud): redeploy the previous image/revision; `/data` (or Postgres) is unchanged.

---

## 7. Moving memory between installs (backend-agnostic)

`awm export`/`import` work across SQLite ⇄ Postgres and carry embeddings (no re-embed):

```sh
# Export from any source (a SQLite file here):
awm export --db /path/agent.db --agent <agent-id> --output mem.json --all-stages
# Import into the target — SQLite:
awm import mem.json --db /path/target.db --dedupe
# …or into Postgres (the same JSON):
AWM_STORE_BACKEND=postgres AWM_DATABASE_URL='postgres://…?sslmode=require' \
  awm import mem.json --remap-agent mwa-serve --dedupe
```
- `--remap-agent mwa-serve` so the importing serve recalls it; `--dedupe` makes re-runs safe.
- `--no-embeddings` only if source/target embedding models differ (then re-embed).
- Note: import normalizes `created_at`/`access_count` to import time; all content + embeddings
  are preserved (recall is faithful).

---

## 8. Pre-flight checklist (any cloud target)

- [ ] Memory backend chosen (SQLite volume vs Postgres URL) and, for Postgres, pgvector enabled.
- [ ] `MWA_ACCESS_PASSWORD` set **and/or** Tailscale auth key set (never an open public port).
- [ ] Model key(s) set; a model picked (or set `mwa.config.json` `models.fetch`).
- [ ] Volume/managed-DB provisioned and attached.
- [ ] (USEA) domain pack + MCP server creds in Key Vault; `legacy-db` on staging/read-only.
- [ ] `/api/health` → 200; one live message works; memory persists across a restart.
- [ ] (If migrating) memory ported (§7) and `memoryCount` matches.
```
