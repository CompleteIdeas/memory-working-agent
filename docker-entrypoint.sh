#!/bin/sh
# MWA container entrypoint — onboard-then-run.
# Everything persistent lives on the /data volume (the user's disk): the .env
# (secrets), the AWM memory db, and the workspace (inbox/outputs/outbox).
set -e
mwa() { npx tsx src/cli.ts "$@"; }

ENVF="${MWA_ENV_PATH:-/data/.env}"
mkdir -p /data
touch "$ENVF"

# The setup wizard is always available (configure / reconfigure at http://localhost:7788).
mwa wizard &

# Run the agent only once a model provider is configured; otherwise wait on the wizard.
if grep -qE '^(ANTHROPIC_API_KEY|AZURE_GPT_API_KEY)=.+' "$ENVF"; then
  if grep -qE '^TELEGRAM_BOT_TOKEN=.+' "$ENVF"; then
    echo "[mwa] configured → starting Telegram connector (+ wizard on :7788)"
    mwa connect telegram
  else
    echo "[mwa] configured → watching the mailbox at /data/mwa-workspace/inbox (+ wizard on :7788)"
    mwa watch
  fi
else
  echo "[mwa] not configured yet — open http://localhost:7788 to add a model provider key, then restart the container."
  wait   # keep the wizard alive
fi
