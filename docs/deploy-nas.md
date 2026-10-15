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

The Telegram connector works with a NAS setup too, but the container doesn't start it: run
`mwa connect telegram` alongside, with a bot token from setup, and you can message the agent (and
get scheduled summaries) from your phone with no UI open. Useful
when the NAS is Tailscale-only.

Quiet hours apply to the Telegram connector, which sends pushes. The container itself runs only
the web app, whose chat pushes nothing, so on its own it has nothing to hold. If you run the
connector (`mwa connect telegram`), say "set my quiet hours to 22:00-07:00" in a chat, or set
`MWA_QUIET_HOURS=22:00-07:00`, which a chat can't change. A window can be at most 16 hours, and
times follow the machine's `TZ` (a plain `docker run` is UTC). Scheduled jobs still run on time. Their Telegram
messages and approval cards wait until the window ends, then arrive in order. Each job sends only
its latest result, with a count of how many it had, so a monitor's 03:00 "down" followed by 03:05
"back up" arrives as "back up", marked as one of 2 results. A job you asked to be told about "the moment" something happens can be marked
urgent and skip the window.

Each scheduled result leaves a delivery receipt in `/data`. Every process keeps its own file:
`deliveries-serve.jsonl` for the web app and `deliveries-telegram.jsonl` for the connector. Ask
"what's scheduled?" and each job shows what happened to its last result: sent to Telegram, held,
failed or dropped (with Telegram's reason), saved in the app, shown in an open app tab, or not sent
because the job only reports changes. A job whose last three results reached no one is flagged.
"Shown" means an open app tab fetched the result, which it does whether or not anyone is looking
(and, without an access password, any client on your network could have). It doesn't prove anyone
read it.

Or drop a file. Put an instruction in a `.md` or `.txt` file in `mwa-workspace/inbox/` inside
your data folder (in the container: `/data/mwa-workspace/inbox/`). MWA picks it up once the
file has stopped changing for a couple of seconds, so a slow copy isn't read half-written. Tasks
run one at a time and unattended, so anything that needs approval waits in the app's approvals
panel. Each run gets its own id, so dropping the same name twice runs it twice:

- the report goes to `mwa-workspace/outbox/<name>-<id>.md`;
- any files it made go to `mwa-workspace/outputs/<name>-<id>/`;
- your file moves to `mwa-workspace/done/`;
- the result is posted in the chat.

If MWA stops in the middle of a task, it reports that task as interrupted within a few minutes of
starting again, rather than running it a second time. Without a mounted data folder, copy a file in with
`docker cp task.md <container>:/data/mwa-workspace/inbox/`. Set `MWA_INBOX=0`, in the container's
environment or in `/data/.env`, to turn it off.

Anyone who can write to that inbox folder can give MWA instructions, even without the app's
password, so share it as carefully as the password. MWA's own file writing never touches the inbox,
the outbox or `done/`, whatever folders you grant it. A command you approve, or Developer mode,
still can.

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
