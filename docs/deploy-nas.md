# Run MWA on a Synology NAS (always-on, freestanding)

MWA is a single web app. On a NAS it runs 24/7, so scheduled tasks ("every morning,
summarize my inbox") actually fire, and you reach it from any device on your network —
or, better, only over [Tailscale](#networking--access).

This guide targets **DSM 7.2+ Container Manager** on a **Plus-series (Intel/amd64)** box
such as the **DS425+**. ARM models work too — the published image is multi-arch
(amd64 + arm64).

> **RAM matters.** MWA loads its recall models (embedding + reranker + query expander)
> in-process — about **1.5 GB**. A 2 GB NAS is tight; **4 GB+ is recommended** (the
> DS425+ takes a cheap SODIMM upgrade). The compose file sets a 3 GB limit.

---

## 1. Get the image

The image is published to the GitHub Container Registry, so the NAS just pulls it — it
never has to build anything (NAS hardware builds slowly):

```
ghcr.io/completeideas/mwa:latest
```

In **Container Manager → Registry**, search/add `ghcr.io/completeideas/mwa` and download
the `latest` tag. (If the package is private, create a GHCR personal access token with
`read:packages` and add it under Registry → Settings.)

## 2. Create the data folder

In **File Station**, make a folder for everything persistent (secrets, memory db,
workspace, model cache):

```
/volume1/docker/mwa/data
```

Back this folder up and MWA survives image updates and reinstalls.

## 3. Run it — the easy way (Project)

The repo ships a `docker-compose.yml`. In **Container Manager → Project → Create**:

1. **Source:** upload `docker-compose.yml` (and a `.env` beside it — copy `.env.example`
   and set `MWA_ACCESS_PASSWORD`).
2. Container Manager maps `./data` → `/data`; point that at
   `/volume1/docker/mwa/data`.
3. Build/start the project.

Or wire it by hand in **Container Manager → Container → Create** from the downloaded
image:

| Setting | Value |
|---|---|
| Port | `7788` (local) → `7788` (container) |
| Volume | `/volume1/docker/mwa/data` → `/data` |
| Environment | `MWA_ACCESS_PASSWORD` = a strong password |
| Environment | `TZ` = your timezone (so "7am" means your 7am) |
| Restart policy | **Always restart** (keeps the scheduler alive) |

## 4. First run

Open `http://<nas-ip>:7788`. You'll see the **lock screen** (because you set a
password) → unlock → the **guided setup** asks which AI model to use (paste a key, or
pick local Ollama). Then you're in the chat. Your provider key is written to
`/data/.env` on the NAS — it never leaves the box except to call the model you chose.

---

## Networking & access

The container binds `0.0.0.0` so the mapped port is reachable. That means **anything
that can reach the NAS on port 7788 can reach the agent** — and your keys, email, and
chat sit behind it. Pick at least one:

- **Tailscale (recommended).** Install the Tailscale package on the NAS (or run the
  Tailscale container) and reach MWA at `http://<nas-tailscale-name>:7788`. Don't expose
  port 7788 to the LAN/internet at all — your tailnet is the only door. This matches how
  the other agents here are accessed.
- **Access password.** `MWA_ACCESS_PASSWORD` locks the whole UI + API behind one
  password (cookie session). Keep it set even behind Tailscale — defense in depth.
- **Synology reverse proxy.** Front it with DSM's reverse proxy + HTTPS if you want a
  hostname and DSM-managed certs. Still keep the password on.

Do **not** port-forward 7788 from your router. If you need remote access, use Tailscale.

## Talk to it without the browser

The Telegram connector still works on the NAS — connect a bot token in setup and you can
message the agent (and get scheduled summaries) from your phone with no UI open. Useful
when the NAS is Tailscale-only.

## Updating

```
# Container Manager → pull ghcr.io/completeideas/mwa:latest, then recreate the container.
# Your /data volume (memory, keys, workspace) carries over untouched.
```

## Troubleshooting

- **Out of memory / container restarts under load** → add RAM, or raise `mem_limit`. The
  models need headroom on first recall.
- **First reply is slow** → on first run MWA downloads the recall models to `/data/hf`
  (one time; needs internet). After that they're cached on the volume.
- **Can't reach it** → confirm the container is running and the port mapping is `7788`,
  and that you're hitting the NAS IP / Tailscale name, not `localhost`.
- **Scheduled task never fired** → the container must be running at the scheduled time
  (set Restart = Always) and the task must be due *after* it started. Recurring tasks
  ("every day at 7am") fire at the next occurrence.
