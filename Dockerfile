# MWA installer image — onboard-then-run autonomous agent.
# Run it, open the localhost wizard to add your keys (stored locally on the /data
# volume, never sent to a server), and it starts the agent. Everything persistent
# (secrets, AWM memory, workspace) lives on /data.
#
#   docker build -t mwa .
#   docker run -d -p 127.0.0.1:7788:7788 -v mwa-data:/data --name mwa mwa
#   → open http://localhost:7788, add a provider key, then: docker restart mwa
# (-p 127.0.0.1:… keeps the wizard reachable only from your machine.)
FROM node:22-slim

# better-sqlite3 (transitive via agent-working-memory) compiles a native addon.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 build-essential ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Layer-cache deps.
COPY package.json package-lock.json* ./
RUN npm ci

# Source + bundled MCP servers + entrypoint.
COPY tsconfig.json ./
COPY src ./src
COPY mcp-servers ./mcp-servers
COPY docker-entrypoint.sh ./
RUN sed -i 's/\r$//' docker-entrypoint.sh && chmod +x docker-entrypoint.sh

# Persistent state on the /data volume: secrets (.env), AWM db, workspace.
ENV MWA_ENV_PATH=/data/.env \
    MWA_DB=/data/agent.db \
    MWA_WORKSPACE=/data/mwa-workspace \
    MWA_WIZARD_HOST=0.0.0.0 \
    HF_HOME=/data/hf \
    TRANSFORMERS_CACHE=/data/hf \
    NODE_ENV=production
VOLUME ["/data"]
EXPOSE 7788

ENTRYPOINT ["./docker-entrypoint.sh"]
