#!/bin/sh
# MWA container entrypoint — ONE front door: the web app (`mwa serve`).
# It shows guided setup on first run, then the chat UI. Everything persistent
# (secrets .env, AWM memory db, workspace) lives on the /data volume (the user's disk).
set -e
mkdir -p /data
touch "${MWA_ENV_PATH:-/data/.env}"
echo "[mwa] open http://localhost:7788 — set up a model the first time, then just chat."
exec npx tsx src/cli.ts serve
