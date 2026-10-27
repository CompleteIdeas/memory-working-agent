/**
 * Settings, sign-in and "who am I" for the v2 app (v2 build, slice W5).
 *
 *   GET    /me                          who this request is (public): signed in or not, as what, with which scopes, and
 *                                        whether a password is set (the sign-in screen offers it, or pairing only)
 *   POST   /session                     sign in with the password (public; throttled); sets the mwa_session cookie
 *   DELETE /session                     sign out of the password session on this browser
 *   PATCH  /devices/{id}                rename a paired device (admin)
 *   GET    /settings  · PATCH /settings the helper's name, the greeting name, the time zone, first run, switches
 *   GET    /spending  · PATCH /spending this month, the limit, the background line, the default limits per kind
 *   GET    /accounts                    Google / Outlook: connected, needs reconnecting, how Connect works here
 *   POST   /accounts/{provider}/connect start the existing sign-in flow (admin): a page to open, a code, or a setup note
 *   POST   /accounts/{provider}/cancel  stop waiting for a sign-in that was started (S3 review) (admin)
 *                                        (S3: the setup is Settings › Connections in this app; body { method, readOnly }
 *                                        picks Outlook's code or browser sign-in, and read-only access)
 *   GET    /vault  · POST /vault/forget saved logins, names only, and Forget (admin)
 *
 * The server's own parts (the password, the session token, the Google/Microsoft flows) come from serve.ts through
 * setSettingsRouteDeps, so these routes are tested over HTTP without a running MWA.
 */
import type { IncomingMessage } from 'node:http';
import { ApiError, type Route } from '../router.js';
import { deviceName, renameDevice, type Caller } from '../auth.js';
import { signInWithPassword, sessionCookie } from '../signin.js';
import { revokeSessionOf, revokeAllSessions } from '../sessions.js';
import { readSettings, updateSettings, setFireCap, fireCapFixed, SettingsError } from '../../v2/settings.js';
import { billingSummary, readCalls, monthStart, monthlyBudget, setMonthlyBudget } from '../../billing.js';
import { fireCapUsd, HANDOFF_CAP_MAX_USD, CAP_MAX_USD } from '../../v2/estimate.js';
import { calendarAccounts } from '../../sync/calendar.js';
import { mailAccounts } from '../../sync/mail.js';
import { vaultRows, forgetVaultEntry } from '../../settings-api.js';
import { isHosted } from '../../hosting.js';
import { cancelSignIn } from '../../connection-settings.js';

export interface ConnectStart { url?: string; user_code?: string; verification_uri?: string; expires_in?: number }
export interface SettingsRouteDeps {
  passwordSet: () => boolean;
  /** constant-time comparison with MWA_ACCESS_PASSWORD */
  checkPassword: (pw: string) => boolean;
  /** what is set up for Google and Outlook on this server */
  connections?: () => { googleClient: boolean; gmailAppPassword: boolean; googleConnected: boolean; outlookDeviceCode: boolean; microsoftClient: boolean; outlookConnected: boolean };
  /** the existing flows (src/connect): a consent page for this computer, or Microsoft's device code */
  startGoogle?: (readOnly?: boolean) => string;
  startOutlookDeviceCode?: (readOnly?: boolean) => Promise<ConnectStart>;
  startOutlook?: (readOnly?: boolean) => string;
}
let deps: SettingsRouteDeps | null = null;
export function setSettingsRouteDeps(d: SettingsRouteDeps | null): void { deps = d; }

const bodyOf = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : {});
const usd = (n: number) => Math.round(n * 10_000) / 10_000;
const asApi = (e: unknown): never => {
  if (e instanceof SettingsError) throw new ApiError(e.code === 'bad_config' ? 409 : 400, e.code, e.message);
  throw e;
};


export function meOf(who: Caller | null) {
  const passwordSet = !!deps?.passwordSet();
  if (!who) return { signedIn: false, kind: null, deviceId: null, deviceName: null, scopes: [] as string[], passwordSet };
  return {
    signedIn: true, kind: who.kind, deviceId: who.kind === 'device' ? who.id : null,
    deviceName: who.kind === 'device' ? deviceName(who.id) : null, scopes: [...who.scopes], passwordSet,
  };
}

// ── spending ────────────────────────────────────────────────────────────────────────────────────────────────────
export function spendingView(now = Date.now()) {
  const s = billingSummary(readCalls(undefined, monthStart(now)), now, monthlyBudget().usd, monthlyBudget().fixed);
  const fire = fireCapUsd();
  return {
    month: { label: s.month.label, usd: usd(s.month.cost), calls: s.month.calls },
    limit: { usd: s.budget.monthlyUsd, fixed: s.budget.fixed, state: s.budget.state, pct: s.budget.pct },
    background: s.byPurpose.map((p) => ({ purpose: p.purpose, label: p.label, usd: usd(p.cost), calls: p.calls })),
    defaults: {
      handoffMaxUsd: HANDOFF_CAP_MAX_USD, continueMaxUsd: CAP_MAX_USD,
      perFireUsd: fire ?? null, perFireFixed: fireCapFixed(),
    },
  };
}

// ── accounts ────────────────────────────────────────────────────────────────────────────────────────────────────
type Provider = 'google' | 'outlook';
export function accountsView() {
  const c = deps?.connections?.() ?? { googleClient: false, gmailAppPassword: false, googleConnected: false, outlookDeviceCode: false, microsoftClient: false, outlookConnected: false };
  let cal: ReturnType<typeof calendarAccounts> = [], mail: ReturnType<typeof mailAccounts> = [];
  try { cal = calendarAccounts(); } catch { /* not configured */ }
  try { mail = mailAccounts(); } catch { /* not configured */ }
  const reconnect = (p: Provider) => cal.some((a) => a.provider === p && a.needsReconnect)
    || mail.some((a) => (p === 'google' ? a.provider === 'gmail' || a.provider === 'imap' : a.provider === 'outlook') && a.needsReconnect);
  const google = {
    provider: 'google' as const, label: 'Google', what: 'Calendar and Gmail. I can read them and make drafts. I never send.',
    connected: c.googleConnected, needsReconnect: c.googleConnected && reconnect('google'),
    method: c.googleConnected ? (c.googleClient ? 'sign-in' : c.gmailAppPassword ? 'app-password' : 'sign-in') : null,
    // S3 (review): a sign-in in a browser window comes back to localhost where the helper runs: never on a server
    connect: c.googleClient && !isHosted() ? 'browser' : 'setup',
  };
  const outlook = {
    provider: 'outlook' as const, label: 'Outlook', what: 'Calendar and mail. I can read them and make drafts. I never send.',
    connected: c.outlookConnected, needsReconnect: c.outlookConnected && reconnect('outlook'),
    method: c.outlookConnected ? 'sign-in' : null,
    connect: c.outlookDeviceCode ? 'code' : c.microsoftClient && !isHosted() ? 'browser' : 'setup',
  };
  return { accounts: [google, outlook] };
}

/** S3: a one-time setup happens in this app, on Settings › Connections, at that provider. */
export const setupUrl = (p: Provider) => `/?view=connections&at=${p}`;
export interface ConnectChoice { method?: 'browser' | 'code'; readOnly?: boolean }
export async function startConnect(p: Provider, choice: ConnectChoice = {}) {
  const a = accountsView().accounts.find((x) => x.provider === p)!;
  const c = deps?.connections?.();
  // Outlook: the code works whenever this build or your own app allows it; the browser sign-in needs your own app
  const outlookBrowser = !!c?.microsoftClient;
  const how = p === 'google' && choice.method === 'browser' ? (c?.googleClient ? 'browser' : 'setup')
    : p === 'outlook' && choice.method === 'browser' ? (outlookBrowser ? 'browser' : 'setup')
    : p === 'outlook' && choice.method === 'code' ? (c?.outlookDeviceCode ? 'code' : 'setup')
      : a.connect;
  const readOnly = choice.readOnly === true;
  // S3 (review): the browser sign-in finishes on localhost where the helper runs, so it can't work on a server
  if (how === 'browser' && isHosted()) {
    throw new ApiError(400, 'browser_not_here', p === 'google'
      ? 'Google sign-in can’t finish on a server: it comes back to the computer your helper runs on. Connect Gmail with an app password instead.'
      : 'Signing in to Outlook in a browser window can’t finish on a server. Connect with a code instead.');
  }
  if (how === 'setup') {
    return {
      kind: 'setup' as const, provider: p, url: setupUrl(p),
      message: p === 'google'
        ? 'Google needs a one-time setup first: a Gmail app password, or your own Google sign-in app. Both are in Settings › Connections.'
        : choice.method === 'browser'
          ? 'Signing in to Outlook in a browser window needs your own Microsoft app first. It’s in Settings › Connections.'
          : 'Outlook needs a one-time setup first: your own Microsoft app. It’s in Settings › Connections.',
    };
  }
  try {
    if (p === 'outlook' && how === 'code' && deps?.startOutlookDeviceCode) {
      const dc = await deps.startOutlookDeviceCode(readOnly);
      if (!dc.user_code || !dc.verification_uri) throw new Error('no code');
      return {
        kind: 'code' as const, provider: p, code: dc.user_code, url: dc.verification_uri, expiresIn: dc.expires_in ?? 900,
        message: `Go to ${dc.verification_uri.replace(/^https?:\/\//, '')} and enter the code ${dc.user_code}. I’ll show Outlook as connected once you finish.`,
      };
    }
    const url = p === 'google' ? deps?.startGoogle?.(readOnly) : deps?.startOutlook?.(readOnly);
    if (!url) throw new Error('no flow');
    return {
      kind: 'browser' as const, provider: p, url,
      message: `Approve access in the ${p === 'google' ? 'Google' : 'Microsoft'} window that opens, then come back. This works on the computer your helper runs on.`,
    };
  } catch (e) {
    throw new ApiError(503, 'provider_unavailable', `I couldn’t start the ${p === 'google' ? 'Google' : 'Outlook'} sign-in just now. Try again in a moment.`, true);
  }
}

export const settingsRoutes: Route[] = [
  { method: 'GET', path: '/me', scope: 'public', handler: ({ who }) => ({ body: meOf(who) }) },
  {
    method: 'POST', path: '/session', scope: 'public',
    handler: async ({ req, body }) => {
      if (!deps?.passwordSet()) throw new ApiError(409, 'no_password', 'No password is set on this helper. Pair this device with a code from the computer instead.');
      const pw = bodyOf(body).password;
      if (typeof pw !== 'string' || !pw || pw.length > 1000) throw new ApiError(400, 'bad_body', 'Type your password.');
      // the sign-in gate: wrong tries from one place make that place wait longer; the right password always gets in
      const cookie = await signInWithPassword(req, pw, deps.checkPassword);
      if (!cookie) throw new ApiError(401, 'wrong_password', 'That password isn’t right. Try again.');
      return { body: { signedIn: true, kind: 'session', scopes: ['read', 'act', 'approve', 'admin'] }, headers: { 'set-cookie': cookie } };
    },
  },
  {
    method: 'DELETE', path: '/session', scope: 'read',
    handler: ({ req, who }) => {
      if (who?.kind !== 'session') throw new ApiError(400, 'not_a_session', 'This device isn’t signed in with the password.');
      revokeSessionOf(req); // the session itself ends on the server: a copied cookie stops working too
      // P2 (review): the browser drops what it kept for this helper — the app's caches and its storage (IndexedDB,
      // the outbox) — as "Sign out this phone" already does (routes/devices.ts). Not "cookies": on *.ts.net that could
      // reach the whole tailnet domain (A2 review); the session cookie is ended above by name.
      return { body: { signedOut: true }, headers: { 'set-cookie': sessionCookie(req, 'x', 0), 'clear-site-data': '"cache", "storage"' } };
    },
  },
  {
    // "Sign out everywhere": every password session ends (this one too). Paired devices are removed one by one.
    method: 'POST', path: '/session/sign-out-everywhere', scope: 'admin',
    handler: ({ req }) => {
      const n = revokeAllSessions();
      return { body: { signedOut: n, message: n === 1 ? 'Signed out of 1 browser.' : `Signed out of ${n} browsers.` }, headers: { 'set-cookie': sessionCookie(req, 'x', 0), 'clear-site-data': '"cache", "storage"' } };
    },
  },
  {
    method: 'PATCH', path: '/devices/{id}', scope: 'admin',
    handler: ({ params, body }) => {
      const name = bodyOf(body).name;
      if (typeof name !== 'string' || !name.trim()) throw new ApiError(400, 'bad_name', 'Give the device a name.');
      const d = renameDevice(params.id, name);
      if (!d) throw new ApiError(404, 'not_found', 'No such device, or it was already removed.');
      return { body: { device: d } };
    },
  },
  { method: 'GET', path: '/settings', scope: 'read', handler: () => ({ body: readSettings() }) },
  {
    method: 'PATCH', path: '/settings', scope: 'admin',
    handler: ({ body }) => {
      const b = bodyOf(body);
      const known = ['helperName', 'ownerName', 'timeZone', 'firstRunDone', 'features', 'publicUrl'];
      const extra = Object.keys(b).filter((k) => !known.includes(k));
      if (extra.length || !Object.keys(b).length) throw new ApiError(400, 'bad_body', `Send one or more of: ${known.join(', ')}.`);
      try { return { body: updateSettings(b) }; } catch (e) { return asApi(e); }
    },
  },
  { method: 'GET', path: '/spending', scope: 'read', handler: () => ({ body: spendingView() }) },
  {
    method: 'PATCH', path: '/spending', scope: 'admin',
    handler: ({ body }) => {
      const b = bodyOf(body);
      const extra = Object.keys(b).filter((k) => k !== 'monthlyUsd' && k !== 'perFireUsd');
      if (extra.length || !Object.keys(b).length) throw new ApiError(400, 'bad_body', 'Send monthlyUsd (dollars, or null for no limit) and/or perFireUsd (dollars, or null for the default).');
      const num = (v: unknown, name: string) => {
        if (v === null) return null;
        if (typeof v !== 'number' || !Number.isFinite(v)) throw new ApiError(400, 'bad_body', `\`${name}\` is a number of dollars, or null.`);
        return v;
      };
      const monthly = b.monthlyUsd === undefined ? undefined : num(b.monthlyUsd, 'monthlyUsd');
      const fire = b.perFireUsd === undefined ? undefined : num(b.perFireUsd, 'perFireUsd');
      // check both before saving either (a refusal saves nothing)
      if (monthly !== undefined) {
        if (monthlyBudget().fixed) throw new ApiError(400, 'fixed', 'The monthly limit was set when this helper was installed, so it can’t be changed here.');
        if (monthly !== null && !(monthly >= 1 && monthly < 1_000_000)) throw new ApiError(400, 'bad_limit', 'Give a monthly limit of at least $1, for example 20.');
      }
      if (fire !== undefined && fire !== null && fire !== 0) {
        const r = Math.round(fire * 100) / 100;
        if (!(r >= 0.01 && r <= 20)) throw new ApiError(400, 'bad_cap', 'Give a dollar amount from $0.01 to $20, for example 0.25.');
      }
      if (fire !== undefined && fireCapFixed()) throw new ApiError(400, 'fixed', 'The limit for repeating jobs was set when this helper was installed, so it can’t be changed here.');
      if (monthly !== undefined) {
        const r = setMonthlyBudget(monthly === null ? 'off' : String(Math.round(monthly * 100) / 100));
        if (!r.ok) throw new ApiError(409, 'bad_config', r.message);
      }
      if (fire !== undefined) { try { setFireCap(fire); } catch (e) { asApi(e); } }
      return { body: spendingView() };
    },
  },
  { method: 'GET', path: '/accounts', scope: 'read', handler: () => ({ body: accountsView() }) },
  {
    method: 'POST', path: '/accounts/{provider}/connect', scope: 'admin',
    handler: async ({ params, body }) => {
      if (params.provider !== 'google' && params.provider !== 'outlook') throw new ApiError(404, 'not_found', 'Connect Google or Outlook.');
      const b = bodyOf(body);
      if (b.method !== undefined && b.method !== 'browser' && b.method !== 'code') throw new ApiError(400, 'bad_method', 'Pick browser or code.');
      if (b.method === 'code' && params.provider === 'google') throw new ApiError(400, 'bad_method', 'Google connects with a sign-in window or an app password, not a code.');
      if (b.readOnly !== undefined && typeof b.readOnly !== 'boolean') throw new ApiError(400, 'bad_body', '`readOnly` is true or false.');
      return { body: await startConnect(params.provider, { method: b.method as ConnectChoice['method'], readOnly: b.readOnly as boolean | undefined }) };
    },
  },
  {
    method: 'POST', path: '/accounts/{provider}/cancel', scope: 'admin',
    handler: ({ params }) => {
      if (params.provider !== 'google' && params.provider !== 'outlook') throw new ApiError(404, 'not_found', 'Cancel a Google or Outlook sign-in.');
      const cancelled = cancelSignIn(params.provider);
      return { body: { cancelled, message: cancelled ? 'Stopped. That sign-in won’t connect anything now.' : 'No sign-in was waiting.' } };
    },
  },
  {
    method: 'GET', path: '/vault', scope: 'admin',
    handler: () => {
      let entries: ReturnType<typeof vaultRows> = [];
      try { entries = vaultRows(); } catch { entries = []; }
      return { body: { entries } };
    },
  },
  {
    method: 'POST', path: '/vault/forget', scope: 'admin',
    handler: ({ body }) => {
      const name = bodyOf(body).name;
      if (typeof name !== 'string' || !name.trim()) throw new ApiError(400, 'bad_body', 'Which saved login?');
      const r = forgetVaultEntry(name);
      if (!r.ok) throw new ApiError(404, 'not_found', r.message);
      return { body: { forgot: name.trim(), message: r.message } };
    },
  },
];
