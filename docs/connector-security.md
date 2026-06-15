# Connector security model

An MCP connector is **code MWA runs as a child process with your privileges** — installing
one is, by design, code execution on your machine. MWA doesn't pretend a single check makes
that safe; it layers defenses, and a human approves anything outside the vetted library.

## Trust tiers

| Tier | What | How it installs |
|---|---|---|
| **Curated library** | Connectors we vet + version-pin (`src/connectors/registry.ts`) | The agent can enable these itself (`install_connector`); a light confirm. Allowed even in autonomous runs. |
| **Known / external** | Any npm package you/the agent name | Goes through the **review pipeline** + your explicit approval. |
| **Arbitrary** | A random repo/URL | Same review, strong warnings, default-deny when non-interactive. |

`tools.installPolicy`: `curated-only` | `review-required` (default) | `off`. Autonomous and
scheduled runs clamp to **curated-only** regardless.

## The layered defenses

1. **Curated default.** The library ships full and useful, so most users never install
   anything unvetted. Entries are **version-pinned** (verified on the npm registry).
2. **Quality-gated review model.** Reviews use *your* configured model. If it isn't strong
   enough to vet code (`isReviewCapable`), external installs are **off** with a clear reason
   — we never let a weak model wave code through. Onboarding nudges you toward a capable one.
3. **Static metadata analysis** (`analyze.ts`): install scripts, dependency sprawl, package
   age, downloads, maintainers, typosquat distance.
4. **Deep source scan + integrity** (`deepscan.ts`): downloads the tarball, **verifies its
   sha512 against the registry's `dist.integrity`** (a mismatch is an automatic `dangerous`),
   then scans the *actual* source (no deps — gunzip + a tiny tar reader) for eval / dynamic
   require / child_process / network-near-`process.env` (exfil) / obfuscated base64 payloads
   / raw-IP URLs. Large packages (>8 MB) are skipped with a note.
5. **Model verdict.** The model judges metadata + scan findings and returns
   safe/caution/dangerous. It is an **advisor**: automated `danger` findings can only *raise*
   the verdict, an integrity mismatch forces `dangerous`, and a human still approves.
6. **Least-privilege spawn.** MCP children get a **minimal environment** — the SDK default
   plus only the vars a connector declares. They never receive MWA's API keychain. Secrets
   live in `.env`; only `${VAR}` references sit in config.
7. **Audit log.** Every enable/approve is appended to `data/installs.jsonl` (id, source,
   tier, pinned version, verdict, integrity).

## Sandbox

True per-process sandboxing is OS-specific and not yet built. The intended boundary is the
**Docker deployment**: connectors run inside the container, so their blast radius is the
container + the `/data` volume + network — not your whole machine. Running MWA in Docker
(see [deploy-nas.md](deploy-nas.md)) is the recommended posture if you'll install connectors
beyond the curated library. Per-connector network/filesystem policy is future work (Phase 3+).

## What's still not guaranteed

- `npx -y pkg@version` fetches from npm **at run time**; the scan sees a specific tarball,
  but transitive deps and post-review republishes aren't re-scanned each run (pinning +
  integrity narrow this, they don't eliminate it).
- The review model can be wrong. Treat `caution`/`dangerous` seriously, and prefer the
  curated library + the Docker boundary for anything sensitive.
