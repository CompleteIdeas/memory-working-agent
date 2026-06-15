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
 && apt-get install -y --no-install-recommends python3 build-essential ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Workspace manifests first → npm install layer caches across source-only changes.
# (npm needs every workspace's package.json present, not the sources, to resolve links.)
COPY package.json package-lock.json* ./
COPY web/package.json ./web/
COPY vendor/agent-working-memory/package.json ./vendor/agent-working-memory/
RUN npm install

# Sources needed to build: the AWM submodule, the SPA, the agent, bundled MCP servers.
COPY vendor/agent-working-memory ./vendor/agent-working-memory
COPY web ./web
COPY src ./src
COPY tsconfig.json ./
COPY mcp-servers ./mcp-servers
RUN npm run build    # build:awm (tsc) + tsc + build:ui (vite → dist-ui)

COPY docker-entrypoint.sh ./
RUN sed -i 's/\r$//' docker-entrypoint.sh && chmod +x docker-entrypoint.sh

# Persistent state on /data. Bind 0.0.0.0 so the mapped port is reachable; lock it down
# with MWA_ACCESS_PASSWORD and/or Tailscale (see README/docs/deploy-nas.md). No browser
# auto-open inside a container.
ENV MWA_ENV_PATH=/data/.env \
    MWA_DB=/data/agent.db \
    MWA_WORKSPACE=/data/mwa-workspace \
    MWA_SERVE_HOST=0.0.0.0 \
    MWA_NO_OPEN=1 \
    HF_HOME=/data/hf \
    TRANSFORMERS_CACHE=/data/hf \
    NODE_ENV=production
VOLUME ["/data"]
EXPOSE 7788

# Lets Synology / Docker report health and restart a wedged container.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7788/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
