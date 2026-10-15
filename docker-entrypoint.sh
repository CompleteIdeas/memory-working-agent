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
    tailscale --socket=/tmp/tailscaled.sock up --authkey="$TAILSCALE_AUTHKEY" --hostname="${TAILSCALE_HOSTNAME:-mwa}" --accept-routes 2>&1 \
      && echo "[mwa] Tailscale up as '${TAILSCALE_HOSTNAME:-mwa}'." \
      || echo "[mwa] Tailscale up failed (continuing without it)."
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
