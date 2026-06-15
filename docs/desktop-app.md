# Running MWA without a terminal (the non-technical front door)

The engine is a web app (`mwa serve` → a browser UI). Two ways to give a non-technical
person ("the Mom test") a no-terminal way to run it. **Neither is built/verified in the
dev sandbox** (no Rust toolchain for Tauri; the Docker image needs a from-source rebuild
pass). This doc is the exact recipe to produce each on a toolchain-equipped machine.

The entrypoint already targets the new front door: `docker-entrypoint.sh` runs
`mwa serve`, and `serve` reads `MWA_SERVE_HOST=0.0.0.0` so the container port maps out.

---

## Path A — Docker (one command to run; no dev setup)

> Status: the **current `Dockerfile` is stale for v0.2** — it does `npm ci` before the
> `vendor/agent-working-memory` git submodule and the `web/` workspace are copied, so the
> workspace install fails. It must be reworked as below, then built + verified.

Rework `Dockerfile` to build the SPA + AWM from source:

```dockerfile
FROM node:22                      # full image: has the build tools for better-sqlite3
WORKDIR /app
# workspace manifests first (layer cache)
COPY package.json package-lock.json* ./
COPY web/package.json ./web/
COPY vendor/agent-working-memory/package.json ./vendor/agent-working-memory/
# full sources needed to build
COPY vendor/agent-working-memory ./vendor/agent-working-memory
COPY web ./web
COPY src ./src
COPY tsconfig.json mcp-servers ./
RUN npm install                   # links workspaces, compiles better-sqlite3
RUN npm run build                 # build:awm (tsc) + tsc + build:ui (vite → dist-ui)
COPY docker-entrypoint.sh ./
RUN sed -i 's/\r$//' docker-entrypoint.sh && chmod +x docker-entrypoint.sh
ENV MWA_ENV_PATH=/data/.env MWA_DB=/data/agent.db MWA_WORKSPACE=/data/mwa-workspace \
    MWA_SERVE_HOST=0.0.0.0 MWA_NO_OPEN=1 HF_HOME=/data/hf TRANSFORMERS_CACHE=/data/hf \
    NODE_ENV=production
VOLUME ["/data"]
EXPOSE 7788
ENTRYPOINT ["./docker-entrypoint.sh"]
```

Build + run + **verify**:
```bash
docker build -t mwa .
docker run -d -p 127.0.0.1:7788:7788 -v mwa-data:/data --name mwa mwa
# open http://localhost:7788 → guided setup → chat. Verify the SPA loads (not the
# inline fallback) and /api/status returns ready after you connect a model.
```
Notes: `.dockerignore` must NOT exclude `vendor/agent-working-memory` sources (only its
`node_modules`/`dist`). Image is large (~2.5 GB; transformers model cache). Publish to
GHCR so users `docker run ghcr.io/completeideas/mwa` without building.

---

## Path B — Tauri desktop installer (double-click; the real "Mom" path)

Produces a signed `.dmg` / `.exe` / AppImage that opens MWA in a native window — no Node,
no terminal. The same `web/` bundle is the UI; a **Node sidecar** runs `mwa serve` as the
backend; Tauri's webview points at `http://localhost:7788`. WebView2 (Windows runtime) is
already present on this machine; the **build** needs:

Prerequisites (not in the dev sandbox):
- **Rust** + cargo (`rustup`), and the **Tauri CLI** (`npm i -D @tauri-apps/cli`).
- A **code-signing certificate** for a trusted (non-"unknown publisher") installer.

Steps:
1. `npm create tauri-app@latest` (or `npx tauri init`) → creates `src-tauri/`.
2. `src-tauri/tauri.conf.json`: set `build.frontendDist` to `../dist-ui`,
   `build.beforeBuildCommand` to `npm run build`, and register the Node runtime + the MWA
   sources as a **sidecar** (`tauri.bundle.externalBin` / `resources`).
3. In `src-tauri/src/main.rs`: on startup, spawn the sidecar (`node`/`tsx src/cli.ts serve`
   with `MWA_HOME` pointed at the OS app-data dir and `MWA_NO_OPEN=1`), wait for
   `http://localhost:7788/api/status` to answer, then load that URL in the window. Store
   secrets via the OS keychain (`tauri-plugin-stronghold` or keyring) instead of a plain
   `.env`, to keep the "secrets never leave your machine" promise.
4. `npm run tauri build` → installers under `src-tauri/target/release/bundle/`.
5. Sign + notarize per OS (Windows: signtool; macOS: notarytool).

When a Rust toolchain is available, this becomes buildable + verifiable; until then it is
**BLOCKED** (tracked as list item #15).

---

## Path C — hosted (later)

The same SPA at a URL — zero install, any device. Needs an auth layer + a server-side
secrets vault; reopens the local-secrets tradeoff (see AWM memory `3a240a87`). Out of
scope for v1.
