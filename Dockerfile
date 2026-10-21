# MWA — freestanding web app. Built from source so it runs on linux/amd64 + linux/arm64
# (Synology DSM, generic Docker hosts, etc.). Everything persistent — secrets (.env), the
# AWM memory db, the workspace, and the recall model cache — lives on the /data volume.
#
#   docker run -d -p 7788:7788 -v mwa-data:/data \
#     -e MWA_ACCESS_PASSWORD=change-me --name mwa ghcr.io/completeideas/mwa
#   → open http://<host>:7788 (or your Tailscale name), unlock, pick a model, chat.
#
# On a NAS, prefer the docker-compose.yml + a bind mount (/volume1/docker/mwa/data:/data)
# and ALWAYS set MWA_ACCESS_PASSWORD (or keep it reachable only over Tailscale).
FROM node:22

# better-sqlite3 (via agent-working-memory) compiles a native addon at install time.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 build-essential ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# Tailscale (optional, userspace) — lets a cloud deploy join your tailnet so the admin UI is reachable
# privately with no public port. Only activates when TAILSCALE_AUTHKEY is provided (see entrypoint).
RUN curl -fsSL https://tailscale.com/install.sh | sh

WORKDIR /app

# Workspace manifests first → npm install layer caches across source-only changes.
# (npm needs every workspace's package.json present, not the sources, to resolve links.)
COPY package.json package-lock.json* ./
COPY web/package.json ./web/
COPY vendor/agent-working-memory/package.json ./vendor/agent-working-memory/
RUN npm install

# BL-64: the agent browser — Chromium (headless shell) and its system libraries, for playwright-core. ~250 MB.
# Set MWA_BROWSER=0 to keep the tools off; build with --build-arg MWA_NO_BROWSER=1 to leave Chromium out.
ARG MWA_NO_BROWSER=
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN if [ -z "$MWA_NO_BROWSER" ]; then npx playwright-core install --with-deps --only-shell chromium && rm -rf /var/lib/apt/lists/*; fi

# Sources needed to build: the AWM submodule, the SPA, the agent, bundled MCP servers.
COPY vendor/agent-working-memory ./vendor/agent-working-memory
COPY web ./web
COPY src ./src
COPY tsconfig.json ./
COPY mcp-servers ./mcp-servers
RUN npm run build    # build:awm (tsc) + tsc + build:ui (vite → dist-ui)

# Bake the recall models INTO the image so the first reply is fast and the agent works
# offline. A throwaway write+recall pre-downloads them; @huggingface/transformers caches
# under node_modules/@huggingface/transformers/.cache (an image layer, NOT the /data
# volume — so a NAS bind mount can't mask them). ~216 MB (embedding + reranker).
COPY scripts/prewarm.ts ./scripts/prewarm.ts
RUN MWA_DB=/tmp/prewarm.db npx tsx scripts/prewarm.ts && rm -rf /tmp/prewarm.db*

COPY docker-entrypoint.sh ./
RUN sed -i 's/\r$//' docker-entrypoint.sh && chmod +x docker-entrypoint.sh

# Persistent state on /data. Bind 0.0.0.0 so the mapped port is reachable; lock it down
# with MWA_ACCESS_PASSWORD and/or Tailscale (see README/docs/deploy-nas.md). No browser
# auto-open inside a container.
ENV MWA_ENV_PATH=/data/.env \
    MWA_DB=/data/agent.db \
    MWA_WORKSPACE=/data/mwa-workspace \
    MWA_CONFIG_PATH=/data/mwa.config.json \
    MWA_VAULT_PATH=/data/vault.json \
    MWA_BROWSER_DIR=/data/browser \
    MWA_RUNLOG=/data/runs.jsonl \
    MWA_NOTIFY=/data/notifications.jsonl \
    MWA_LOG=/data/mwa.log \
    MWA_SERVE_HOST=0.0.0.0 \
    MWA_NO_OPEN=1 \
    NODE_ENV=production
# RUNLOG / NOTIFY / LOG / CONFIG_PATH belong on /data too, and did not used to be: they default
# to ./data/* which inside the image is /app/data — the EPHEMERAL layer. The database and the
# workspace were persisted while the entire audit trail was not, so every image rebuild or
# `--force-recreate` silently wiped the run history, the Log tab, and any scheduled-task result
# not yet delivered to a browser. On a VM that is every deploy. Measured 2026-10-14: /data held
# agent.db + mwa-workspace while /app/data held runs.jsonl, notifications.jsonl and mwa.log.
# NOTE: no `VOLUME ["/data"]` — persistence is provided by the host at run time
# (`-v mwa-data:/data` for self-host/NAS) or by the platform's own volume (Railway
# Volumes, Azure). Railway's builder explicitly rejects a Dockerfile VOLUME directive.
EXPOSE 7788

# Lets Synology / Docker report health and restart a wedged container.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7788/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
