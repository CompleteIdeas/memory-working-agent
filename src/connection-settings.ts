/**
 * Connections (v2 build, slice S3): Gmail with an app password, the Google and Microsoft sign-in apps, Telegram,
 * Tailscale, and disconnecting. ONE implementation that both the classic page (serve.ts POST /api/connections
 * actions connect-gmail-imap / disconnect-gmail / disconnect-outlook / disconnect-telegram, and POST /api/save
 * which: 'telegram' | 'google' | 'microsoft' | 'tailscale') and the v1 routes (src/api/routes/connections.ts) call, so
 * the two can never drift apart.
 *
 * What changed from the code that sat in serve.ts (both paths get it):
 *   - inputs are checked first, each on one line: an email address; an app password of 16 letters (spaces allowed, as
 *     Google shows it); a Telegram bot token shaped like one (it goes into the Telegram address, so a "/" or "?" in it
 *     could change which address is called); a Google client ID ending in .apps.googleusercontent.com and a secret;
 *     a Microsoft client ID that is a GUID and a tenant that is a name; a Tailscale auth key (tskey-…) and a host name
 *     of letters, digits and dashes (it used to be cut down silently);
 *   - a check that fails never echoes what was typed back (Telegram's and IMAP's errors are scrubbed);
 *   - the key, password and token values are never logged and never sent back: the state says only whether one is
 *     saved.
 *
 * The live checks, .env writes and the sign-in token removal go through setConnectionDeps so tests never call
 * Google, Telegram or IMAP and never touch the real .env.
 */
import { verifyGmailImap } from './connectors/gmail-imap.js';
import { googleConfigured, disconnectGoogle } from './connectors/google.js';
import { microsoftConfigured, microsoftClientReady, disconnectMicrosoft } from './connectors/microsoft.js';
import { testTelegram, upsertEnv, removeEnv } from './wizard.js';
import { scrub, type Outcome } from './assistant-settings.js';

export interface ConnectionDeps {
  checkGmail: (address: string, appPassword: string) => Promise<{ ok: boolean; message: string }>;
  checkTelegram: (token: string) => Promise<{ ok: boolean; message: string }>;
  /** write to .env and this process (wizard.ts upsertEnv) */
  saveEnv: (kv: Record<string, string>) => void;
  /** remove from .env and this process (wizard.ts removeEnv) */
  removeEnv: (names: string[]) => void;
  /** remove the stored Google / Microsoft sign-in (and what was cached from that calendar) */
  forgetGoogle: () => void;
  forgetMicrosoft: () => void;
  env: (name: string) => string | undefined;
  googleSignedIn: () => boolean;
  outlookSignedIn: () => boolean;
  /** Microsoft's quick sign-in (a code) works: an app ID of your own, or the one this build ships with */
  outlookCodeReady: () => boolean;
}
const realDeps: ConnectionDeps = {
  checkGmail: (a, p) => verifyGmailImap(a, p),
  checkTelegram: (t) => testTelegram(t),
  saveEnv: (kv) => upsertEnv(kv),
  removeEnv: (n) => removeEnv(n),
  forgetGoogle: () => disconnectGoogle(),
  forgetMicrosoft: () => disconnectMicrosoft(),
  env: (n) => process.env[n],
  googleSignedIn: () => googleConfigured(),
  outlookSignedIn: () => microsoftConfigured(),
  outlookCodeReady: () => microsoftClientReady(),
};
let deps: ConnectionDeps = realDeps;
export function setConnectionDeps(d: Partial<ConnectionDeps> | null): void { deps = d ? { ...realDeps, ...d } : realDeps; }

const fail = (code: string, message: string): Outcome => ({ ok: false, code, message });
const LINE = /^[^\r\n\0]*$/;
const str = (v: unknown): string | null => (typeof v === 'string' && v.length <= 4096 && LINE.test(v) ? v.trim() : null);

/** What each disconnect removes from .env (the classic page's lists). */
const GOOGLE_ENV = ['MWA_GMAIL_USER', 'MWA_GMAIL_APP_PASSWORD', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'];
const OUTLOOK_ENV = ['MICROSOFT_CLIENT_ID', 'MICROSOFT_TENANT'];
const TELEGRAM_ENV = ['TELEGRAM_BOT_TOKEN'];
const TAILSCALE_ENV = ['TAILSCALE_AUTHKEY', 'TAILSCALE_HOSTNAME'];

// ── Gmail with an app password ──────────────────────────────────────────────────────────────────────────────────

export async function connectGmailAppPassword(b: { address?: unknown; appPassword?: unknown }): Promise<Outcome> {
  const address = str(b.address);
  if (!address || address.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return fail('bad_address', 'Type your Gmail address, like you@gmail.com.');
  const raw = typeof b.appPassword === 'string' && b.appPassword.length <= 200 && LINE.test(b.appPassword) ? b.appPassword : null;
  const pass = raw?.replace(/\s+/g, '') ?? '';
  if (!/^[A-Za-z]{16}$/.test(pass)) return fail('bad_app_password', 'An app password is 16 letters. Google shows it as four groups of four; paste it as it is.');
  let r: { ok: boolean; message: string };
  try { r = await deps.checkGmail(address, pass); } catch (e) { r = { ok: false, message: `Couldn’t reach Gmail: ${(e as Error).message}` }; }
  if (!r.ok) return fail('check_failed', scrub(r.message, pass).slice(0, 300));
  deps.saveEnv({ MWA_GMAIL_USER: address, MWA_GMAIL_APP_PASSWORD: pass });
  return { ok: true, message: `Connected ${address}. I can read your mail and make drafts. I never send. Calendar needs Google sign-in.` };
}

// ── the sign-in apps (advanced) ─────────────────────────────────────────────────────────────────────────────────

export function saveGoogleApp(b: { clientId?: unknown; clientSecret?: unknown }): Outcome {
  const id = str(b.clientId) ?? '', secret = str(b.clientSecret) ?? '';
  if (!id || !secret) return fail('bad_client', 'Paste both the Client ID and the Client secret.');
  if (id.length > 300 || !/^[A-Za-z0-9-]+\.apps\.googleusercontent\.com$/.test(id)) return fail('bad_client_id', 'That doesn’t look like a Client ID. It ends in .apps.googleusercontent.com.');
  if (secret.length > 300 || /\s/.test(secret)) return fail('bad_client_secret', 'That doesn’t look like a Client secret. Paste it again, on one line.');
  deps.saveEnv({ GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: secret });
  return { ok: true, message: 'Saved. Now sign in with Google.' };
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function saveMicrosoftApp(b: { clientId?: unknown; tenant?: unknown }): Outcome {
  const id = str(b.clientId) ?? '';
  if (!id) return fail('bad_client_id', 'Paste the Application (client) ID from your Microsoft app.');
  if (!GUID.test(id)) return fail('bad_client_id', 'That doesn’t look like a client ID. It looks like 11111111-2222-3333-4444-555555555555.');
  const tenant = b.tenant === undefined || b.tenant === null ? '' : str(b.tenant);
  if (tenant === null || (tenant && !/^[A-Za-z0-9][A-Za-z0-9.-]{0,99}$/.test(tenant))) return fail('bad_tenant', 'The tenant is a name like common or contoso.onmicrosoft.com, or a GUID. Leave it empty for most accounts.');
  const changedTenant = !!tenant && tenant !== (deps.env('MICROSOFT_TENANT') ?? '');
  deps.saveEnv({ MICROSOFT_CLIENT_ID: id, ...(tenant ? { MICROSOFT_TENANT: tenant } : {}) });
  return { ok: true, message: `Saved. Now connect Outlook.${changedTenant ? ' The tenant is used after your helper restarts.' : ''}` };
}

// ── Telegram ────────────────────────────────────────────────────────────────────────────────────────────────────

export async function saveTelegram(b: { token?: unknown }): Promise<Outcome> {
  const token = str(b.token) ?? '';
  if (!token) return fail('bad_token', 'Paste the bot token BotFather gave you.');
  if (!/^\d{5,15}:[A-Za-z0-9_-]{30,64}$/.test(token)) return fail('bad_token', 'That doesn’t look like a bot token. It looks like 123456789:ABCdef… Paste it again.');
  let r: { ok: boolean; message: string };
  try { r = await deps.checkTelegram(token); } catch (e) { r = { ok: false, message: `Telegram failed: ${(e as Error).message}` }; }
  if (!r.ok) return fail('check_failed', scrub(r.message, token).replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot•••').slice(0, 300));
  deps.saveEnv({ TELEGRAM_BOT_TOKEN: token });
  return { ok: true, message: `${r.message.replace(/ ✓$/, '').replace(/^Bot /, 'Your bot ')}. Message it on Telegram to talk to your helper.` };
}

// ── Tailscale ───────────────────────────────────────────────────────────────────────────────────────────────────

export function saveTailscale(b: { authKey?: unknown; hostname?: unknown }): Outcome {
  const key = str(b.authKey) ?? '';
  if (!key.startsWith('tskey-') || key.length > 300 || /\s/.test(key)) {
    return fail('bad_auth_key', 'That doesn’t look like a Tailscale auth key. It starts with tskey-auth-. Make one under Settings › Keys › Generate auth key in Tailscale (not an API access token).');
  }
  if (key.startsWith('tskey-api-')) return fail('bad_auth_key', 'That’s a Tailscale API access token. Your helper needs an auth key: Settings › Keys › Generate auth key.');
  const host = b.hostname === undefined || b.hostname === null ? '' : str(b.hostname);
  if (host === null || (host && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?$/.test(host))) return fail('bad_hostname', 'The name may use letters, numbers and dashes (up to 40), like mwa or barn-helper.');
  deps.saveEnv({ TAILSCALE_AUTHKEY: key, ...(host ? { TAILSCALE_HOSTNAME: host.toLowerCase() } : {}) });
  return { ok: true, message: 'Tailscale key saved. When your helper next restarts, it joins your tailnet and is reachable at its tailnet name. No public port needed.' };
}

// ── disconnecting ───────────────────────────────────────────────────────────────────────────────────────────────

export type Service = 'google' | 'outlook' | 'telegram' | 'tailscale';
export const SERVICES: readonly Service[] = ['google', 'outlook', 'telegram', 'tailscale'];
export function disconnect(service: Service): Outcome {
  if (service === 'google') { deps.forgetGoogle(); deps.removeEnv(GOOGLE_ENV); return { ok: true, message: 'Google disconnected. Its sign-in was removed from your helper.' }; }
  if (service === 'outlook') { deps.forgetMicrosoft(); deps.removeEnv(OUTLOOK_ENV); return { ok: true, message: 'Outlook disconnected. Its sign-in was removed from your helper.' }; }
  if (service === 'telegram') { deps.removeEnv(TELEGRAM_ENV); return { ok: true, message: 'Telegram disconnected.' }; }
  if (service === 'tailscale') { deps.removeEnv(TAILSCALE_ENV); return { ok: true, message: 'Tailscale key removed. Your helper leaves your tailnet when it next restarts.' }; }
  return fail('not_found', 'Disconnect Google, Outlook, Telegram or Tailscale.');
}

// ── the classic page (POST /api/connections and POST /api/save) ─────────────────────────────────────────────────

export const LEGACY_ACTIONS = new Set(['connect-gmail-imap', 'disconnect-gmail', 'disconnect-outlook', 'disconnect-telegram']);
/** serve.ts /api/connections for these four actions: the same functions as the v1 routes, in the classic shape. */
export async function legacyConnectionAction(b: Record<string, any>): Promise<{ ok: boolean; message: string }> {
  let r: Outcome;
  if (b.action === 'connect-gmail-imap') r = await connectGmailAppPassword({ address: b.user, appPassword: b.appPassword });
  else if (b.action === 'disconnect-gmail') r = disconnect('google');
  else if (b.action === 'disconnect-outlook') r = disconnect('outlook');
  else if (b.action === 'disconnect-telegram') r = disconnect('telegram');
  else return { ok: false, message: 'unknown action' };
  return { ok: r.ok, message: r.message };
}
export const LEGACY_CONNECTION_WHICH = new Set(['telegram', 'google', 'microsoft', 'tailscale']);
/** serve.ts /api/save for these four. */
export async function legacyConnectionSave(b: Record<string, any>): Promise<{ ok: boolean; message: string }> {
  let r: Outcome;
  if (b.which === 'telegram') r = await saveTelegram({ token: b.TELEGRAM_BOT_TOKEN });
  else if (b.which === 'google') r = saveGoogleApp({ clientId: b.GOOGLE_CLIENT_ID, clientSecret: b.GOOGLE_CLIENT_SECRET });
  else if (b.which === 'microsoft') r = saveMicrosoftApp({ clientId: b.MICROSOFT_CLIENT_ID, tenant: b.MICROSOFT_TENANT || undefined });
  else if (b.which === 'tailscale') r = saveTailscale({ authKey: b.TAILSCALE_AUTHKEY ?? b.key, hostname: b.hostname || undefined });
  else return { ok: false, message: 'unknown field' };
  return { ok: r.ok, message: r.message };
}

// ── the state ───────────────────────────────────────────────────────────────────────────────────────────────────

/** What is set up, never a value: an address is shown (it is yours), keys, secrets, passwords and tokens are not. */
export function connectionState() {
  const has = (n: string) => !!deps.env(n);
  const imap = has('MWA_GMAIL_USER') && has('MWA_GMAIL_APP_PASSWORD');
  const googleApp = has('GOOGLE_CLIENT_ID') && has('GOOGLE_CLIENT_SECRET');
  const signedIn = deps.googleSignedIn();
  return {
    google: {
      connected: signedIn || imap,
      method: signedIn ? 'sign-in' as const : imap ? 'app-password' as const : null,
      address: imap && !signedIn ? deps.env('MWA_GMAIL_USER') ?? null : null,
      appSaved: googleApp,
    },
    outlook: {
      connected: deps.outlookSignedIn(),
      code: deps.outlookCodeReady(),
      appSaved: has('MICROSOFT_CLIENT_ID'),
      tenant: deps.env('MICROSOFT_TENANT') || null,
      redirectUri: `http://localhost:${Number(deps.env('MWA_MS_OAUTH_PORT') ?? 7798)}/oauth`,
    },
    telegram: { connected: has('TELEGRAM_BOT_TOKEN') },
    tailscale: { keySaved: has('TAILSCALE_AUTHKEY'), hostname: deps.env('TAILSCALE_HOSTNAME') || null },
  };
}
