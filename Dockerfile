# MWA benchmark image — turnkey, headless A/B/C run.
# Keys are passed at runtime via --env-file (never baked). The HF embed/rerank
# model cache lives on a mounted volume (HF_HOME) so it persists across runs.
FROM node:22-slim

# better-sqlite3 (transitive via agent-working-memory) compiles a native addon.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 build-essential ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Layer-cache deps: copy manifests first.
COPY package.json package-lock.json* ./
RUN npm ci

# Source.
COPY tsconfig.json ./
COPY src ./src

# AWM's embed/rerank models cache here; mount a volume at /data/hf to persist.
ENV HF_HOME=/data/hf
ENV TRANSFORMERS_CACHE=/data/hf
ENV NODE_ENV=production

# Default: run the full A/B/C benchmark. Override BENCH_* via -e.
CMD ["npx", "tsx", "src/benchmark.ts"]
