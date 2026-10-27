#!/bin/sh
# MWA container entrypoint — ONE front door: the web app (`mwa serve`).
# It shows guided setup on first run, then the chat UI. Everything persistent
# (secrets .env, AWM memory db, workspace) lives on the /data volume (the user's disk).
set -e
mkdir -p /data
ENV_FILE="${MWA_ENV_PATH:-/data/.env}"
touch "$ENV_FILE"

# Tailscale (optional) — join the tailnet so the admin/Glass-Box UI is reachable at the tailnet
# hostname with NO public port. Userspace networking → no TUN device / privileges needed (works on
# Railway, Azure Container Apps, etc.). The auth key (tskey-auth-…) comes from $TAILSCALE_AUTHKEY or,
# if set via the setup UI, the .env on the /data volume. Best-effort: never blocks the app from starting.
if [ -z "${TAILSCALE_AUTHKEY:-}" ] && [ -f "$ENV_FILE" ]; then
  TAILSCALE_AUTHKEY="$(grep -E '^TAILSCALE_AUTHKEY=' "$ENV_FILE" | head -n1 | cut -d= -f2- | tr -d '"' || true)"
fi
if [ -n "${TAILSCALE_AUTHKEY:-}" ]; then
  if command -v tailscaled >/dev/null 2>&1; then
    echo "[mwa] Tailscale: bringing up userspace networking…"
    tailscaled --tun=userspace-networking --state=/data/tailscaled.state --socket=/tmp/tailscaled.sock >/data/tailscaled.log 2>&1 &
    sleep 2
    if tailscale --socket=/tmp/tailscaled.sock up --authkey="$TAILSCALE_AUTHKEY" --hostname="${TAILSCALE_HOSTNAME:-mwa}" --accept-routes 2>&1; then
      echo "[mwa] Tailscale up as '${TAILSCALE_HOSTNAME:-mwa}'."
      # v2 P1: HTTPS on the private address (https://<name>.<tailnet>.ts.net -> MWA), which phones need to install the
      # app, keep it offline and get notifications. Tailnet only: Funnel (a public address) is never switched on.
      # Needs MagicDNS + HTTPS certificates enabled in the Tailscale admin (https://login.tailscale.com/admin/dns).
      # TAILSCALE_SERVE=0 turns it off.
      # A value from the environment wins, then the one saved in the .env on /data (what the app's setup writes; the
      # server reads that file too and never overrides the environment, so this script must not either).
      env_or_file() {
        eval "_v=\${$1:-}"
        if [ -z "$_v" ] && [ -f "$ENV_FILE" ]; then
          _v="$(grep -E "^$1=" "$ENV_FILE" | tail -n1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//' || true)"
        fi
        printf '%s' "$_v"
      }
      if [ "$(env_or_file TAILSCALE_SERVE)" != "0" ]; then
        MWA_PORT="$(env_or_file MWA_SERVE_PORT)"; [ -n "$MWA_PORT" ] || MWA_PORT="$(env_or_file PORT)"; [ -n "$MWA_PORT" ] || MWA_PORT=7788
        if tailscale --socket=/tmp/tailscaled.sock serve --bg --https=443 "http://127.0.0.1:${MWA_PORT}" >/data/tailscale-serve.log 2>&1; then
          echo "[mwa] Tailscale serve: https on the tailnet -> port ${MWA_PORT} (private; Funnel off)."
          # tell MWA its own secure address (pairing links, the install card) — only now that the address works, and
          # never over a value the person set (environment or /data/.env)
          if [ -z "$(env_or_file MWA_PUBLIC_URL)" ]; then
            TS_NAME="$(tailscale --socket=/tmp/tailscaled.sock status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(String((j.Self&&j.Self.DNSName)||"").replace(/[.]$/,""))}catch(e){}})' || true)"
            if [ -n "$TS_NAME" ]; then export MWA_PUBLIC_URL="https://${TS_NAME}"; echo "[mwa] MWA_PUBLIC_URL=${MWA_PUBLIC_URL}"; fi
          fi
        else
          echo "[mwa] Tailscale serve failed (see /data/tailscale-serve.log). Switch on MagicDNS and HTTPS certificates at https://login.tailscale.com/admin/dns. Continuing."
        fi
        # W5: through Tailscale nobody is "this machine", so a password is required (sign in on the phone, then pair it)
        if [ -z "$(env_or_file MWA_ACCESS_PASSWORD)" ]; then
          echo "[mwa] WARNING: set MWA_ACCESS_PASSWORD. Over Tailscale it is required to sign in and pair a phone."
        fi
      fi
    else
      echo "[mwa] Tailscale up failed (continuing without it)."
    fi
  else
    echo "[mwa] TAILSCALE_AUTHKEY set but tailscaled not installed in this image — skipping."
  fi
fi

# Seed a preloaded memory store on first boot: copy $MWA_SEED_DB → $MWA_DB when the target is
# absent. Lets an image ship WITH a memory store, kept on the container's LOCAL disk (so SQLite
# avoids the network-FS locking quirks of a mounted Azure Files / SMB share). One-time per volume.
DB="${MWA_DB:-/data/agent.db}"
if [ -n "${MWA_SEED_DB:-}" ] && [ ! -f "$DB" ] && [ -f "$MWA_SEED_DB" ]; then
  echo "[mwa] seeding memory from $MWA_SEED_DB → $DB"
  mkdir -p "$(dirname "$DB")"
  cp "$MWA_SEED_DB" "$DB" && echo "[mwa] memory store seeded."
fi

echo "[mwa] open http://localhost:7788 — set up a model the first time, then just chat."
# exec NODE directly, not `npx tsx`. Under npx, npm is PID 1 and eats the stop signal: `docker stop`
# printed "npm error signal SIGTERM" and serve.ts's SIGTERM/SIGINT handlers never ran, so a restart
# killed an in-flight run instead of closing it out. On a VM that is every deploy.
exec node --import tsx src/cli.ts serve
