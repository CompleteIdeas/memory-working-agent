/**
 * Fixture mode for Settings › Connections (v2 build, slice S3). Answers /connections, its changes and
 * /accounts/{provider}/connect the way src/api/routes/connections.ts, src/api/routes/settings.ts and
 * src/connection-settings.ts do, with the server's own words. The Settings "Connected" list (/accounts) is read from
 * the same state, so the two pages agree. Passwords, secrets, tokens and keys are kept as "saved" flags only: a value
 * typed here is dropped at once, as the server never sends one back.
 *
 * Scenarios: `first-run` and `not-connected` (nothing connected), `reconnect` (Google's sign-in stopped working), `hosted` (the helper
 * runs on a server: no sign-in in a browser window), `conn-setup` (nothing connected, no sign-in app and no quick
 * Outlook code: every way in needs a setup first); any other: Google signed in with its own sign-in app, Outlook not
 * connected (the code works), no Telegram, a Tailscale key saved.
 * An app password or a bot token with "bad" in it fails the live check. EVERYTHING HERE IS EXAMPLE DATA.
 */
import type { Account, Connections } from '../api/client';

type Resp = { status: number; body: unknown };
const err = (status: number, code: string, message: string): Resp => ({ status, body: { error: { code, message } } });
const LINE = /^[^\r\n\0]*$/;
const str = (v: unknown): string | null => (typeof v === 'string' && v.length <= 4096 && LINE.test(v) ? v.trim() : null);
export const FIXTURE_TS_HOST = 'Railway';

export class ConnectionFixtures {
  google = { signedIn: true, imap: null as string | null, appSaved: true, needsReconnect: false };
  outlook = { connected: false, code: true, appSaved: false, tenant: null as string | null, needsReconnect: false };
  telegram = { connected: false };
  tailscale = { keySaved: true, hostname: null as string | null };
  hosted = false;
  constructor(private scenario: string) {
    if (scenario === 'first-run' || scenario === 'conn-setup' || scenario === 'not-connected') this.google = { signedIn: false, imap: null, appSaved: scenario !== 'conn-setup', needsReconnect: false };
    if (scenario === 'conn-setup') { this.outlook.code = false; this.tailscale.keySaved = false; }
    if (scenario === 'first-run') this.tailscale.keySaved = false;
    if (scenario === 'reconnect') this.google.needsReconnect = true;
    if (scenario === 'hosted') { this.hosted = true; this.google = { signedIn: false, imap: 'robert@gmail.com', appSaved: false, needsReconnect: false }; }
  }

  private browser(appSaved: boolean) { return this.hosted ? 'server' as const : appSaved ? 'ready' as const : 'setup' as const; }
  view(): Connections {
    const g = this.google, o = this.outlook;
    const connected = g.signedIn || !!g.imap;
    return {
      google: {
        connected, method: g.signedIn ? 'sign-in' : g.imap ? 'app-password' : null, address: g.imap && !g.signedIn ? g.imap : null,
        appSaved: g.appSaved, needsReconnect: connected && g.needsReconnect, signIn: this.browser(g.appSaved),
      },
      outlook: {
        connected: o.connected, code: o.code || o.appSaved, appSaved: o.appSaved, tenant: o.tenant, redirectUri: 'http://localhost:7798/oauth',
        needsReconnect: o.connected && o.needsReconnect, browser: this.browser(o.appSaved),
      },
      telegram: { ...this.telegram },
      tailscale: { ...this.tailscale },
      hosted: this.hosted, host: this.hosted ? FIXTURE_TS_HOST : 'your server',
    };
  }
  /** What the Settings "Connected" list shows (GET /accounts), from the same state. */
  accounts(): Account[] {
    const v = this.view();
    return [
      { provider: 'google', label: 'Google', what: 'Calendar and Gmail. I can read them and make drafts. I never send.', connected: v.google.connected, needsReconnect: v.google.needsReconnect,
        method: v.google.method, connect: v.google.signIn === 'ready' ? 'browser' : 'setup' },
      { provider: 'outlook', label: 'Outlook', what: 'Calendar and mail. I can read them and make drafts. I never send.', connected: v.outlook.connected, needsReconnect: v.outlook.needsReconnect,
        method: v.outlook.connected ? 'sign-in' : null, connect: v.outlook.code ? 'code' : v.outlook.browser === 'ready' ? 'browser' : 'setup' },
    ];
  }
  private change(message: string): Resp { return { status: 200, body: { connections: this.view(), message } }; }

  read(path: string): Resp | null {
    if (path === '/connections') return { status: 200, body: this.view() };
    if (path === '/accounts') return { status: 200, body: { accounts: this.accounts() } };
    return null;
  }

  /** POST /accounts/{provider}/connect: the example world's sign-in "finishes" at once (nothing really opens). */
  connect(p: 'google' | 'outlook', b: Record<string, unknown>): Resp {
    if (b.method !== undefined && b.method !== 'browser' && b.method !== 'code') return err(400, 'bad_method', 'Pick browser or code.');
    if (b.method === 'code' && p === 'google') return err(400, 'bad_method', 'Google connects with a sign-in window or an app password, not a code.');
    const v = this.view();
    const how = p === 'google' ? (v.google.signIn === 'setup' ? 'setup' : 'browser')
      : b.method === 'browser' ? (v.outlook.browser === 'setup' ? 'setup' : 'browser')
        : v.outlook.code ? 'code' : v.outlook.browser === 'ready' ? 'browser' : 'setup';
    if (how === 'browser' && this.hosted) {
      return err(400, 'browser_not_here', p === 'google'
        ? 'Google sign-in can’t finish on a server: it comes back to the computer your helper runs on. Connect Gmail with an app password instead.'
        : 'Signing in to Outlook in a browser window can’t finish on a server. Connect with a code instead.');
    }
    if (how === 'setup') {
      return { status: 200, body: { kind: 'setup', provider: p, url: `/?view=connections&at=${p}`,
        message: p === 'google' ? 'Google needs a one-time setup first: a Gmail app password, or your own Google sign-in app. Both are in Settings › Connections.'
          : b.method === 'browser' ? 'Signing in to Outlook in a browser window needs your own Microsoft app first. It’s in Settings › Connections.'
            : 'Outlook needs a one-time setup first: your own Microsoft app. It’s in Settings › Connections.' } };
    }
    if (p === 'google') this.google = { ...this.google, signedIn: true, needsReconnect: false };
    else this.outlook = { ...this.outlook, connected: true, needsReconnect: false };
    if (how === 'code') return { status: 200, body: { kind: 'code', provider: p, code: 'QWER-TY12', url: 'https://microsoft.com/devicelogin', expiresIn: 900, message: 'Go to microsoft.com/devicelogin and enter the code QWER-TY12. I’ll show Outlook as connected once you finish.' } };
    return { status: 200, body: { kind: 'browser', provider: p, url: p === 'google' ? 'https://accounts.google.com/' : 'https://login.microsoftonline.com/', message: `Approve access in the ${p === 'google' ? 'Google' : 'Microsoft'} window that opens, then come back. This works on the computer your helper runs on.` } };
  }

  write(method: string, path: string, body: unknown): Resp | null {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    let m: RegExpExecArray | null;
    if (method === 'POST' && (m = /^\/accounts\/([^/]+)\/cancel$/.exec(path))) {
      const p = decodeURIComponent(m[1]);
      if (p !== 'google' && p !== 'outlook') return err(404, 'not_found', 'Cancel a Google or Outlook sign-in.');
      return { status: 200, body: { cancelled: false, message: 'No sign-in was waiting.' } }; // the example world finishes at once
    }
    if (method === 'POST' && (m = /^\/accounts\/([^/]+)\/connect$/.exec(path))) {
      const p = decodeURIComponent(m[1]);
      if (p !== 'google' && p !== 'outlook') return err(404, 'not_found', 'Connect Google or Outlook.');
      return this.connect(p, b);
    }
    if (method === 'POST' && path === '/connections/gmail/app-password') {
      const address = str(b.address);
      if (!address || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return err(400, 'bad_address', 'Type your Gmail address, like you@gmail.com.');
      const pass = typeof b.appPassword === 'string' ? b.appPassword.replace(/\s+/g, '') : '';
      if (!/^[A-Za-z]{16}$/.test(pass)) return err(400, 'bad_app_password', 'An app password is 16 letters. Google shows it as four groups of four; paste it as it is.');
      if (/bad/i.test(pass)) return err(400, 'check_failed', 'Sign-in failed — check the address and app password (and that 2-Step Verification is on).');
      this.google = { ...this.google, imap: address, needsReconnect: false }; // the password itself is not kept
      return this.change(`Connected ${address}. I can read your mail and make drafts. I never send. Calendar needs Google sign-in.`);
    }
    if (method === 'PUT' && path === '/connections/google/app') {
      const id = str(b.clientId) ?? '', secret = str(b.clientSecret) ?? '';
      if (!id || !secret) return err(400, 'bad_client', 'Paste both the Client ID and the Client secret.');
      if (!/^[A-Za-z0-9-]+\.apps\.googleusercontent\.com$/.test(id)) return err(400, 'bad_client_id', 'That doesn’t look like a Client ID. It ends in .apps.googleusercontent.com.');
      if (/\s/.test(secret)) return err(400, 'bad_client_secret', 'That doesn’t look like a Client secret. Paste it again, on one line.');
      this.google = { ...this.google, appSaved: true };
      return this.change('Saved. Now sign in with Google.');
    }
    if (method === 'PUT' && path === '/connections/outlook/app') {
      const id = str(b.clientId) ?? '';
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return err(400, 'bad_client_id', id ? 'That doesn’t look like a client ID. It looks like 11111111-2222-3333-4444-555555555555.' : 'Paste the Application (client) ID from your Microsoft app.');
      const tenant = b.tenant === undefined || b.tenant === null ? '' : str(b.tenant);
      if (tenant === null || (tenant && !/^[A-Za-z0-9][A-Za-z0-9.-]{0,99}$/.test(tenant))) return err(400, 'bad_tenant', 'The tenant is a name like common or contoso.onmicrosoft.com, or a GUID. Leave it empty for most accounts.');
      const changed = !!tenant && tenant !== (this.outlook.tenant ?? '');
      this.outlook = { ...this.outlook, appSaved: true, tenant: tenant || this.outlook.tenant };
      return this.change(`Saved. Now connect Outlook.${changed ? ' The tenant is used after your helper restarts.' : ''}`);
    }
    if (method === 'PUT' && path === '/connections/telegram') {
      const token = str(b.token) ?? '';
      if (!token) return err(400, 'bad_token', 'Paste the bot token BotFather gave you.');
      if (!/^\d{5,15}:[A-Za-z0-9_-]{30,64}$/.test(token)) return err(400, 'bad_token', 'That doesn’t look like a bot token. It looks like 123456789:ABCdef… Paste it again.');
      if (/bad/i.test(token)) return err(400, 'check_failed', 'Telegram failed: Unauthorized');
      this.telegram = { connected: true };
      return this.change('Your bot @juniper_helper_bot works. Message it on Telegram to talk to your helper.');
    }
    if (method === 'PUT' && path === '/connections/tailscale') {
      const typed = b.authKey === undefined || b.authKey === null ? '' : str(b.authKey) ?? '\0';
      const keep = !typed && this.tailscale.keySaved;
      if (!keep && (!typed.startsWith('tskey-') || /\s/.test(typed))) return err(400, 'bad_auth_key', 'That doesn’t look like a Tailscale auth key. It starts with tskey-auth-. Make one under Settings › Keys › Generate auth key in Tailscale (not an API access token).');
      if (!keep && typed.startsWith('tskey-api-')) return err(400, 'bad_auth_key', 'That’s a Tailscale API access token. Your helper needs an auth key: Settings › Keys › Generate auth key.');
      const host = b.hostname === undefined ? undefined : b.hostname === null ? '' : str(b.hostname);
      if (host === null || (host && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?$/.test(host))) return err(400, 'bad_hostname', 'The name may use letters, numbers and dashes (up to 40), like mwa or barn-helper.');
      if (keep && host === undefined) return err(400, 'bad_auth_key', 'Paste a Tailscale auth key, or change the name.');
      this.tailscale = { keySaved: true, hostname: host ? host.toLowerCase() : host === '' ? null : this.tailscale.hostname };
      return this.change(keep
        ? `Saved. The name ${host ? host.toLowerCase() : 'mwa (the default)'} takes effect after your helper restarts.`
        : 'Tailscale key saved. It takes effect after your helper restarts: then it joins your tailnet and is reachable at its tailnet name, with no public port.');
    }
    if (method === 'DELETE' && (m = /^\/connections\/([^/]+)$/.exec(path))) {
      const s = decodeURIComponent(m[1]);
      if (s === 'google') { this.google = { signedIn: false, imap: null, appSaved: false, needsReconnect: false }; return this.change('Google disconnected. Its sign-in was removed from your helper.'); }
      if (s === 'outlook') { this.outlook = { ...this.outlook, connected: false, appSaved: false, tenant: null, needsReconnect: false }; return this.change('Outlook disconnected. Its sign-in was removed from your helper.'); }
      if (s === 'telegram') { this.telegram = { connected: false }; return this.change('Telegram disconnected.'); }
      if (s === 'tailscale') { this.tailscale = { keySaved: false, hostname: null }; return this.change('Tailscale key removed. It takes effect after a restart: until then your helper stays on your tailnet.'); }
      return err(404, 'not_found', 'Disconnect Google, Outlook, Telegram or Tailscale.');
    }
    return null;
  }
}
