# Connecting email (Gmail & Outlook) — and the plan to make it turnkey

## The model: device-local bring-your-own. No managed broker.

MWA connects each user's email with **their own** Google/Microsoft OAuth app, and the
token stays **on their machine** (`data/google-token.json` / `data/microsoft-token.json`,
mode 0600). It is never sent to us or a third party.

**Why not a managed broker (Arcade, Composio, Nango, …):** MWA is an open, self-hosted
project — *not a single organization*. A broker would mean either:
- one shared account fronting **everyone's** usage → a **per-user metered cost** (e.g.
  Arcade bills per OAuth "challenge" + per tool execution) that we cannot carry if this
  spreads in the wild; or
- **every user's mail tokens living in the broker's cloud** — unacceptable token custody
  for an OSS tool whose whole principle is "secrets stay on your machine."

The audience is GitHub users who can handle a few setup steps, so BYO is the right fit.
A **homegrown helper script** (no vendor, no recurring cost) closes the gap to turnkey.

## What's already built

- **Gmail** connector — read + draft (never sends), whole-thread read, attachment text
  extraction. `src/connectors/google.ts`.
- **Outlook / Microsoft 365** connector — same surface over Microsoft Graph (personal
  Outlook.com **and** work/school via `/common`). `src/connectors/microsoft.ts`.
- **Guided setup cards** in the Connections screen: step links, credential fields, a
  read-only vs read+draft toggle, "open consent → poll until connected."
- Loopback OAuth (`localhost:7799` Google, `localhost:7798` Microsoft); read-only modes;
  refresh handled.

## What a user does today (manual BYO)

**Gmail:** Google Cloud Console → create/pick a project → enable Gmail API + Calendar API
→ OAuth consent screen (External, **Testing**, add yourself as a test user) → Credentials
→ Create OAuth client ID → **Desktop app** → paste Client ID + secret into MWA → connect.

**Outlook:** Azure portal → App registrations → New registration ("personal + any org") →
add a **Mobile & desktop** redirect `http://localhost:7798/oauth` → API permissions →
Microsoft Graph **delegated**: `Mail.ReadWrite` (or `Mail.Read`), `Calendars.ReadWrite`,
`User.Read`, `offline_access` → paste the **Application (client) ID** into MWA → connect.

## Caveats that shape the turnkey design

- **Google "Testing" status revokes refresh tokens after 7 days.** A test-mode Gmail app
  re-prompts weekly. Fixes: publish the app to **Production** (Gmail read is a *restricted*
  scope → triggers Google's CASA audit if you want more than ~100 users), or accept weekly
  re-consent for personal use. MWA should detect `invalid_grant` and surface a re-connect
  prompt. Microsoft has no equivalent weekly expiry.
- **Loopback only completes on the same machine as MWA.** `localhost:7799/7798` is the
  *MWA host's* loopback. For a server/NAS install reached from another device, the consent
  redirect can't land — see "remote installs" below.
- **`gmail.compose` grants send.** Google has no draft-only-without-send scope; MWA's
  "never sends" is **code-enforced**, but the consent screen will say the app can send.
  The read-only toggle (`gmail.readonly` / `Mail.Read`) avoids this entirely.

## The turnkey version — what's left to build

A homegrown **`mwa connect`** helper (a Node script, no third-party service). It automates
as much of the per-provider app creation as each cloud's CLI allows, then hands off to the
existing connect flow.

### Per-provider automation feasibility

| Step | Outlook (Azure `az` CLI) | Gmail (Google `gcloud` CLI) |
|---|---|---|
| Sign in | `az login` (once) | `gcloud auth login` (once) |
| Create app/project | `az ad app create` ✅ auto | `gcloud projects create` ✅ auto |
| Enable APIs | (Graph perms, below) | `gcloud services enable gmail.googleapis.com calendar-json.googleapis.com` ✅ auto |
| Redirect URI | `--public-client-redirect-uris http://localhost:7798/oauth` ✅ auto | n/a for Desktop client |
| API permissions | `az ad app permission add` (Graph delegated) ✅ auto | n/a |
| **Create OAuth client ID** | included above ✅ auto | ⚠️ **manual** — Google does not reliably allow programmatic OAuth *client* creation; script **deep-links** the exact console page |
| Capture credential | read `appId` → write `MICROSOFT_CLIENT_ID` ✅ auto | prompt paste of Client ID + secret |

**Net:** Outlook can be **~fully turnkey** via `az`; Gmail is **project + APIs automated,
OAuth-client creation guided** (paste two values). When `az`/`gcloud` aren't installed, the
script falls back to the fully-manual guided steps (the current UI cards).

### Remote / NAS installs (no localhost browser)

1. **Connect-then-copy (document now, works today):** run the one-time connect on a laptop
   (loopback works), then copy `data/google-token.json` / `data/microsoft-token.json` onto
   the server's `/data` volume. Reliable for both providers, zero new code.
2. **Device-code flow (build later):** user enters a short code at a URL on any device — no
   redirect needed. Works well for **Microsoft Graph**; Google's device flow has scope
   limits that may exclude Gmail, so it's provider-dependent.
3. **Real redirect URI:** register the server's HTTPS URL as the redirect (needs a
   domain/cert; `tailscale serve` can provide HTTPS on a tailnet).

### Completion checklist

- [x] `mwa connect <gmail|outlook>` CLI: Azure path (`az ad app create` + Graph delegated
      perms → fully automated) / Google path (`gcloud` project + API enable, then deep-link
      the OAuth client + capture pasted creds) → run the existing loopback connect.
      (`src/connectors/setup-helper.ts`.)
- [x] Detect `az` / `gcloud`; gracefully fall back to printed manual steps when absent.
- [ ] Token import/export helper for remote installs (document "connect-then-copy" now).
- [ ] `invalid_grant` detection → re-consent prompt (handles Google's 7-day Testing expiry).
- [ ] (Optional) Microsoft device-code flow for headless/remote.
- [x] Read-only scope option (already shipped — toggle in the Connections card).
- [x] Both connectors + guided UI cards (already shipped).
