# USEA Gallop-on-MWA — Azure deploy plan (Container Apps + managed Postgres + native Tailscale)

**Status:** plan / reviewable spec. No Azure actions, no prod changes, no secrets touched.
**Date:** 2026-06-30.
**Owner inputs needed:** see §10.

This plans the **shadow** deployment of the USEA Gallop Support successor on the MWA
platform to Azure, using the two enablers verified this cycle: MWA's **native Tailscale**
entrypoint (TB1) and the **AWM Postgres backend** (TA2/TA3). It does **not** plan a
production cutover — those hard safety gates (dryrun→confirm at the tool layer, P2
dual-run diffing, zero safety regressions, one-button rollback) from the migration
decision (task #57) still gate prod and are unchanged.

---

## 0. Scope & non-goals

**In scope:** stand up `gallop-on-mwa` as an isolated Azure service that the team can
reach over Tailscale, backed by managed Postgres, with the existing USEA agent's AWM
memory ported in — so it can be exercised/red-teamed in parallel with prod.

**Non-goals (explicit):**
- No production cutover. The live Azure VM agent (`usea-agent-vm`, gpt-5.4-mini +
  EmbeddedAWM, 14/15 @ $0.0069) stays untouched — it is the rollback.
- `legacy-db` stays pointed at **staging / read-only** with the dryrun→confirm gate until
  the approval flow is proven (per #57 P2). No production SQL Server writes.
- No git push to `USEADEV/gallop-support`, no npm publish, without explicit go.

---

## 1. Target architecture

```
                 ┌─────────────────────────── Azure (tenant: USEA) ───────────────────────────┐
   you ── Tailscale tailnet ──►  Container App: gallop-on-mwa
                 │                  ├─ MWA serve (PWA UI + agent loop + scheduler)
                 │                  ├─ Tailscale userspace (native, from docker-entrypoint.sh) — NO public ingress
                 │                  ├─ 4 domain MCP servers (stdio): freshdesk, legacy-db, usef, ticket-history
                 │                  └─ AWM  ──► Azure Database for PostgreSQL Flexible Server + pgvector
                 │                                   (AWM_STORE_BACKEND=postgres, AWM_DATABASE_URL from Key Vault)
                 │                  secrets ◄─ Key Vault (AZURE_GPT_*, LEGACY_DB_*, FRESHDESK_*, USEF_*,
                 │                                        TAILSCALE_AUTHKEY, AWM_DATABASE_URL, MWA_ACCESS_PASSWORD)
                 └────────────────────────────────────────────────────────────────────────────┘
```

Two layers of access control, no public port:
1. **Tailscale** — the app joins the tailnet at boot; only tailnet devices can reach it.
2. **`MWA_ACCESS_PASSWORD`** — second factor on the UI/API even within the tailnet.

---

## 2. Why Container Apps + native Tailscale (vs the VM + sidecar it has today)

The held `gallop-on-mwa` image (`C:/Users/robert/project/AIAgentBuild/mwa/`) currently
uses a **Tailscale sidecar** via `docker-compose` (`network_mode: service:tailscale`,
tailnet-only). That's a compose-ism. On **Azure Container Apps** there is no compose
sidecar model in the same form, and routing all traffic through a second container is
awkward. MWA now brings up **Tailscale in its own entrypoint** with **userspace
networking** (no TUN device, no `NET_ADMIN`), which is exactly what a locked-down Container
App allows. So for Azure the **native path is simpler and more portable** than the sidecar.

- Container Apps gives: managed TLS-free private networking, Key Vault secret refs,
  scale-to-zero or always-on, revisions/rollback, log streaming.
- Set **ingress = disabled** (or internal-only) — access is purely via Tailscale, so no
  public endpoint exists.
- Alternative kept on the table: an Azure **VM with local disk** (mirrors prod exactly).
  Container Apps is preferred for managed ops + Key Vault; the VM is the fallback if a
  Container Apps constraint (e.g. long-lived outbound for Tailscale, or the embedding
  model cold-start) proves awkward — see §11.

---

## 3. The store — Azure Database for PostgreSQL Flexible Server + pgvector

Why Postgres (not SQLite-on-Azure-Files): AWM's own deployment note — SQLite over Azure
Files SMB has file-locking quirks. Managed Postgres avoids the network-FS-SQLite problem,
is durable, and is multi-replica-safe. TA2/TA3 made AWM speak real Postgres; this is the
first real consumer.

- **Provision:** Azure Database for PostgreSQL **Flexible Server** (Burstable B1ms/B2s is
  ample for one agent's memory; right-size later). Private access (VNet-integrated) so only
  the Container App reaches it; or firewall to the Container App's outbound.
- **pgvector:** enable the extension. On Flexible Server, add `vector` to
  `azure.extensions` server parameter, then the AWM schema's `CREATE EXTENSION IF NOT
  EXISTS vector` succeeds (it runs under the bootstrap advisory lock — TA2).
- **Connection:** `AWM_DATABASE_URL=postgres://<user>:<pass>@<host>:5432/<db>?sslmode=require`
  in Key Vault. Azure PG requires SSL — confirm `pg` honors `sslmode=require` in the URL
  (it does; otherwise pass `ssl: { rejectUnauthorized: true }` via a small adapter tweak).
  **→ verify in §9.**
- **Backend select:** `AWM_STORE_BACKEND=postgres`. MWA's `MwaMemory.init()` (TA1) then
  dynamic-imports `PostgresEngramStore`; the schema/ivfflat-probes bootstrap runs once.
- **ivfflat.probes / pool:** defaults (probes=5, pool max=10) are fine for one agent; the
  per-database probe default is set at bootstrap (TA2). `AWM_PG_POOL_MAX` tunable.

---

## 4. Networking / access — native Tailscale (TB1)

- Put a **Tailscale auth key** (`tskey-auth-…`, reusable or ephemeral, NOT the mgmt API
  key) in Key Vault as `TAILSCALE_AUTHKEY`; optional `TAILSCALE_HOSTNAME=gallop-on-mwa`.
- `docker-entrypoint.sh` (already in MWA) brings up `tailscaled --tun=userspace-networking`
  + `tailscale up --authkey … --hostname … --accept-routes`, best-effort, before `serve`.
- Container App **ingress disabled** → reachable only at its tailnet name. `MWA_SERVE_HOST=0.0.0.0`
  so the tailnet interface can bind.
- Outbound: the Container App needs egress to the Tailscale coordination server
  (`*.tailscale.com`, derp). Confirm the Container App environment allows outbound (default
  does). **→ verify in §9.**
- Clean up the stale tailnet device `usea-agent` (offline 7d) in the admin console; the
  prod VM's device stays.

---

## 5. Secrets & config matrix (all via Key Vault → Container App secret refs)

| Key | Purpose | Source |
|---|---|---|
| `AWM_STORE_BACKEND=postgres` | select the PG backend | plain env |
| `AWM_DATABASE_URL` | managed Postgres connection (sslmode=require) | Key Vault |
| `TAILSCALE_AUTHKEY` | join tailnet (tskey-auth-…) | Key Vault |
| `TAILSCALE_HOSTNAME=gallop-on-mwa` | tailnet name | plain env |
| `MWA_ACCESS_PASSWORD` | second-factor on UI/API | Key Vault |
| `AZURE_GPT_BASE_URL` / `AZURE_GPT_API_KEY` / `AZURE_GPT_DEPLOYMENT` | gpt-5.4-mini (usea-ai-eastus, `…/openai/v1`) | Key Vault |
| `LEGACY_DB_*` | **staging/read-only** SQL Server creds (dryrun→confirm gated) | Key Vault |
| `FRESHDESK_*`, `USEF_*` | domain tool creds | Key Vault |
| `MWA_DOMAIN_PACK=/app/project` | load the USEA AGENT.md + topics | plain env |
| `MWA_SERVE_HOST=0.0.0.0`, `MWA_NO_OPEN=1` | bind + no browser | plain env |

Secrets never echoed; `.env`-on-volume not used on Azure (Key Vault is the source).

---

## 6. AWM memory port (222 memories) — **SOLVED: plain agnostic `awm` commands**

**Update (2026-06-30, AWM 0.10.0 / TC1):** `awm export`/`import` are now **backend-agnostic**
(they route through `openStore()`), and **export includes embedding vectors**. So the earlier
"awm import is SQLite-only → needs a bespoke port script" gap is **closed** — the port is now
two plain commands, and embeddings carry over so **no re-embed is needed** (source and target
both use bge-small 384-d). Proven end-to-end: `scripts/_io-roundtrip.ts` = 14/14 (SQLite →
Postgres, embeddings + associations + supersession all survive).

**Ready-to-run port (no creds in this doc; run when the Azure target exists):**

```sh
# 1) On the prod Azure VM (read-only, safe; SSH 22 closed → use az vm run-command).
#    Export the live store to JSON (engrams + associations + EMBEDDINGS).
az vm run-command invoke -g usea-ai -n usea-agent-vm --command-id RunShellScript --scripts \
  "cd /home/useaadmin/AIAgentBuild && npx --yes agent-working-memory awm export \
     --db /app/data/memory/usea-agent.db --agent <usea-agent-id> \
     --output /tmp/usea-memory.json --all-stages"
#    Pull /tmp/usea-memory.json off the VM (run-command returns stdout, or copy via storage).

# 2) Import INTO the managed Postgres (remap to the agent id MWA serve uses; dedupe for re-runs).
AWM_STORE_BACKEND=postgres \
AWM_DATABASE_URL='postgres://<user>:<pass>@<host>:5432/<db>?sslmode=require' \
  npx agent-working-memory awm import usea-memory.json --remap-agent mwa-serve --dedupe
```

- **Agent-id remap:** the prod store is under the USEA agent's id; MWA serve recalls under
  `mwa-serve` → `--remap-agent mwa-serve` so recall resolves. `--dedupe` makes re-runs safe.
- **Embeddings:** carried in the export and written straight into pgvector — recall works
  immediately, no re-embed. (If the target ever uses a different embedding model, add
  `--no-embeddings` to import and re-embed after.)
- **Bootstrap option:** run step 2 once at provision time, or as a one-shot
  `docker-entrypoint` step guarded by a marker (mirroring the existing SQLite bootstrap).
- **Caveat:** import normalizes `created_at`/`access_count` to import time (documented in the
  AWM 0.10.0 CHANGELOG); all semantic content + embeddings are preserved, so recall is faithful.

---

## 7. Changes to the held `gallop-on-mwa` image

(Repo `USEADEV/gallop-support`, dir `C:/Users/robert/project/AIAgentBuild/mwa/` — outside
this working tree; verify against the actual repo before editing.)

1. **MWA dependency:** currently pins `memory-working-agent ^0.3.0`. The Postgres backend +
   native Tailscale + TA1 async are in **0.4.0 (bumped, NOT published)**. Options:
   (a) **publish MWA 0.4.0** to npm and pin `^0.4.0` (needs explicit go — publish is gated);
   (b) have the image **build MWA from source** (git/local) instead of npm. Pick one in §10.
2. **Drop the Tailscale sidecar** from `docker-compose.yml`; rely on MWA's native entrypoint
   Tailscale (works under Container Apps). Keep a compose file only for local Docker testing.
3. **Add Postgres env** (`AWM_STORE_BACKEND=postgres`, `AWM_DATABASE_URL`) and **remove** the
   SQLite `/data` memory bootstrap; replace with the §6 port-script bootstrap (marker-guarded).
4. Keep: 4 domain MCP servers (14 tools), locked-down access preset, `MWA_DOMAIN_PACK`,
   `read_document` builtin, prewarmed embeddings baked into the image layer (not the volume).

---

## 8. Deploy steps (once §10 inputs are in hand)

1. Provision: resource group, Container Apps environment, Postgres Flexible Server
   (+pgvector enabled), Key Vault. Wire managed identity → Key Vault secret refs.
2. Load secrets into Key Vault (§5). Generate the Tailscale auth key.
3. Build + push the image to ACR (or GHCR) — `linux/amd64`.
4. Export prod memory (§6.1) → run the port script (§6.2–6.3) against the new Postgres.
5. Create the Container App: image, secret refs, `ingress disabled`, always-on (min 1
   replica — avoid scale-to-zero so the agent + scheduler stay live and the embedding model
   stays warm).
6. Verify (§9) over the tailnet.

---

## 9. Verification & gates (PASS bar)

- **Postgres reachability + SSL:** the app boots, `CREATE EXTENSION vector` + schema
  bootstrap succeed, `/api/health` → 200 `{ok:true, db:true}`. (Confirms `AWM_DATABASE_URL`
  + `sslmode=require` work through `pg`.)
- **Tailnet:** the app appears in the Tailscale admin as `gallop-on-mwa`; reachable at its
  tailnet name; **no public ingress** (confirm there is no public FQDN).
- **Memory port:** a `memory_recall` against the ported store returns USEA facts (e.g. the
  membership-type schema columns) — proving the 222 memories + embeddings landed in Postgres
  and pgvector recall works. Spot-check `memoryCount() == 222` (±dedupe).
- **Domain tools:** `smoke` registers all 14 MCP tools; a read-only ticket lookup works.
- **Safety (gates from #57 — unchanged):** dryrun→confirm verified at the `legacy-db` tool
  layer; `legacy-db` pointed at staging/read-only + kill-switch; **no prod cutover** until
  P2 dual-run diffing shows matches/beats 14/15 AND zero safety regressions.

---

## 10. Open decisions — needs Robert

1. **MWA 0.4.0 publish vs build-from-source** for the gallop image (§7.1). Publish is gated
   on your explicit go (version bumped, not published).
2. **Azure footprint:** which subscription/RG (the `usea-ai` rg, or a separate shadow rg?),
   Postgres SKU, Container Apps vs VM. Who provisions (you, or me with creds you supply).
3. **Tailscale:** generate the `tskey-auth-…` for the shadow device; confirm tailnet ACLs
   let your devices reach `gallop-on-mwa`.
4. **The port script (§6.2):** want me to build + locally verify it now (export a sample
   store → port into Docker Postgres → recall), independent of Azure? (This was option C of
   the scope question — easy to do next and de-risks the real port.)
5. **`awm import` Postgres support:** file the backend-agnostic import follow-up now, or
   defer and rely on the port script?

---

## 11. Risks

- **Container Apps + long-lived Tailscale / embedding cold-start:** scale-to-zero would kill
  the tailnet session + drop the warmed embedding model. Mitigation: min 1 replica
  (always-on); if Container Apps fights long-lived outbound, fall back to a VM (mirrors prod).
- **pgvector on Azure Flexible Server:** must be allow-listed in `azure.extensions`; if a
  policy blocks it, fall back to a VM-hosted Postgres or `pgvector`-enabled container.
- **SSL/connection:** Azure PG enforces SSL; confirm `pg` + `sslmode=require` in the URL (or
  add an `ssl` option) — verified in §9, fixable in the adapter if needed.
- **Memory port fidelity:** embeddings must survive the JSON round-trip or be re-embedded;
  agent-id remap must match `mwa-serve` or recall returns nothing. Both covered in §6.
- **Safety drift (the #57 headline risk):** generalized harness semantics
  (compaction/recall/scheduler/gate) could differ from the bespoke harness; the P2 dual-run
  diffing harness is what proves parity before any prod traffic — not in scope here, but the
  gate this shadow exists to feed.
```
