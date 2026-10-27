/**
 * Fixture mode for sign-in, pairing, first run and Settings (v2 build, slice W5). The FixtureServer (./fixtures.ts)
 * asks this module first whether a request may go through at all (`gate`: signed out → 401, a phone asking for an
 * admin thing → 403), then hands it /me, /session, /pair, /pair/codes, /devices, /settings, /spending, /accounts,
 * /vault and /files. Shapes follow api/openapi.yaml (tests/web-v2-w5-fixtures.test.ts validates them); refusals use
 * the server's own words (src/api/routes/settings.ts, devices.ts, files.ts).
 *
 * Scenarios (`?scenario=`):
 *   signed-out  a password is set and this browser is not signed in: the sign-in screen (the password is "example")
 *   unpaired    no password, and this is a phone on the network: pairing only (the code K7PQ-M4XZ works)
 *   phone       signed in as the paired phone "Robert’s Pixel" (read, act, approve; no admin)
 *   first-run   this computer, first-run setup not done yet, nothing connected
 *   (any other) this computer signed in with the password, set up, Google connected
 * EVERYTHING HERE IS EXAMPLE DATA.
 */
import type { Account, Device, FileRow, HelperSettings, Me, Spending, VaultEntry } from '../api/client';

type Resp = { status: number; body: unknown; headers?: Record<string, string> };
const err = (status: number, code: string, message: string): Resp => ({ status, body: { error: { code, message } } });
const MINUTE = 60_000, DAY = 86_400_000;
export const FIXTURE_PASSWORD = 'example';
export const FIXTURE_PAIR_CODE = 'K7PQ-M4XZ';
const PHONE_SCOPES = ['read', 'act', 'approve'] as const;
const ALL = ['read', 'act', 'approve', 'admin'] as const;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const norm = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Which requests answer with nobody signed in (the server's public routes). */
const PUBLIC = new Set(['GET /meta', 'GET /me', 'POST /session', 'POST /pair']);
/** Which need admin (a paired phone gets 403). */
const ADMIN: RegExp[] = [/^POST \/session\/sign-out-everywhere$/, /^POST \/pair\/codes$/, /^GET \/devices$/, /^(DELETE|PATCH) \/devices\/[^/]+$/, /^PATCH \/(settings|spending)$/, /^POST \/accounts\/[^/]+\/connect$/, /^GET \/vault$/, /^POST \/vault\/forget$/];

export class SettingsFixtures {
  passwordSet: boolean;
  signedIn: boolean;
  kind: 'session' | 'local' | 'device';
  deviceId: string | null = null;
  devices: Device[];
  settings: HelperSettings;
  spending: Spending;
  accounts: Account[];
  vault: VaultEntry[];
  files = new Map<string, FileRow[]>();
  private codes = new Set<string>([norm(FIXTURE_PAIR_CODE)]);
  private n = 0;

  constructor(private scenario: string, private clock: () => number) {
    const now = clock();
    this.passwordSet = scenario !== 'unpaired' && scenario !== 'first-run';
    this.signedIn = scenario !== 'signed-out' && scenario !== 'unpaired';
    this.kind = scenario === 'phone' ? 'device' : scenario === 'first-run' ? 'local' : 'session';
    this.devices = [
      { id: 'dev_pixel', name: 'Robert’s Pixel', platform: 'android', scopes: [...PHONE_SCOPES], createdAt: now - 3 * DAY, lastSeen: now - 10 * MINUTE, revokedAt: null },
      { id: 'dev_ipad', name: 'Kitchen iPad', platform: 'ios', scopes: [...PHONE_SCOPES], createdAt: now - 16 * DAY, lastSeen: now - 2 * DAY, revokedAt: null },
      { id: 'dev_old', name: 'Old phone', platform: 'android', scopes: [...PHONE_SCOPES], createdAt: now - 60 * DAY, lastSeen: now - 40 * DAY, revokedAt: now - 30 * DAY },
    ];
    if (scenario === 'first-run' || scenario === 'unpaired' || scenario === 'signed-out') this.devices = [];
    if (scenario === 'phone') this.deviceId = 'dev_pixel';
    const first = scenario === 'first-run';
    this.settings = {
      helperName: first ? 'Your helper' : 'Juniper', ownerName: first ? null : 'Robert', ownerNameFixed: false,
      timeZone: 'America/New_York', timeZoneFixed: false, firstRunDone: !first, configError: null,
      // first run on a fresh computer: no address for phones yet (the pairing step asks for it)
      publicUrl: first ? null : 'https://mwa.tail1a2b.ts.net', publicUrlFixed: false,
      features: [
        { id: 'sorting', label: 'Sorting your mail into Important', on: !first, canChange: true, note: 'Reads new mail headers and picks what’s worth a look. A few cents a day, never more than 15¢.' },
        { id: 'calendar', label: 'Keeping your calendar up to date', on: true, canChange: false, note: 'Checks your calendar every 30 minutes.' },
        { id: 'mail', label: 'Keeping your mail up to date', on: true, canChange: false, note: 'Checks for new mail every few minutes. Only the subject lines are kept.' },
      ],
    };
    this.spending = {
      month: { label: 'November 2026', usd: 1.29, calls: 214 },
      limit: { usd: 20, fixed: false, state: 'ok', pct: 6.45 },
      background: [{ purpose: 'triage-headers', label: 'Sorting your mail', usd: 0.31, calls: 42 }, { purpose: 'triage-deep-read', label: 'Reading newsletters for dates', usd: 0.08, calls: 3 }],
      defaults: { handoffMaxUsd: 5, continueMaxUsd: 20, perFireUsd: 0.25, perFireFixed: false },
    };
    this.accounts = [
      { provider: 'google', label: 'Google', what: 'Calendar and Gmail. I can read them and make drafts. I never send.', connected: !first, needsReconnect: false, method: first ? null : 'sign-in', connect: 'browser' },
      { provider: 'outlook', label: 'Outlook', what: 'Calendar and mail. I can read them and make drafts. I never send.', connected: false, needsReconnect: false, method: null, connect: 'code' },
    ];
    this.vault = first ? [] : [
      { name: 'Barn booking site', site: 'bookings.example', fields: ['username', 'password'], savedAt: now - 9 * DAY },
      { name: 'USEF', site: 'usef.example', fields: ['member number', 'password'], savedAt: now - 30 * DAY },
    ];
    this.files.set('general', []);
  }

  me(): Me {
    if (!this.signedIn) return { signedIn: false, kind: null, deviceId: null, deviceName: null, scopes: [], passwordSet: this.passwordSet };
    const scopes = this.kind === 'device' ? [...PHONE_SCOPES] : [...ALL];
    const d = this.deviceId ? this.devices.find((x) => x.id === this.deviceId) : undefined;
    return { signedIn: true, kind: this.kind, deviceId: this.deviceId, deviceName: d?.name ?? null, scopes, passwordSet: this.passwordSet };
  }

  /** Before anything else: nobody signed in gets 401 except on public routes; a phone gets 403 on admin routes. */
  gate(method: string, path: string): Resp | null {
    const key = `${method} ${path}`;
    if (PUBLIC.has(key)) return null;
    if (!this.signedIn) return err(401, 'locked', 'Sign in to continue.');
    if (this.kind === 'device' && ADMIN.some((re) => re.test(key))) return err(403, 'forbidden', 'This device is not allowed to do that. Use the app on your computer, or sign in with the password.');
    return null;
  }

  read(path: string, q: URLSearchParams): Resp | null {
    if (path === '/me') return { status: 200, body: this.me() };
    if (path === '/devices') return { status: 200, body: { devices: this.devices } };
    if (path === '/settings') return { status: 200, body: this.settings };
    if (path === '/spending') return { status: 200, body: this.spending };
    if (path === '/accounts') return { status: 200, body: { accounts: this.accounts } };
    if (path === '/vault') return { status: 200, body: { entries: this.vault } };
    if (path === '/files') {
      const pid = q.get('projectId') || 'general';
      return { status: 200, body: { projectId: pid, folder: `serve/p-${pid}/uploads`, files: this.files.get(pid) ?? [] } };
    }
    return null;
  }

  write(method: string, path: string, body: unknown, query?: URLSearchParams): Resp | null {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    let m: RegExpExecArray | null;
    if (method === 'POST' && path === '/session') {
      if (!this.passwordSet) return err(409, 'no_password', 'No password is set on this helper. Pair this device with a code from the computer instead.');
      if (typeof b.password !== 'string' || !b.password) return err(400, 'bad_body', 'Type your password.');
      if (b.password !== FIXTURE_PASSWORD) return err(401, 'wrong_password', 'That password isn’t right. Try again.');
      this.signedIn = true; this.kind = 'session'; this.deviceId = null;
      return { status: 200, body: { signedIn: true, kind: 'session', scopes: [...ALL] } };
    }
    if (method === 'POST' && path === '/session/sign-out-everywhere') {
      this.signedIn = false;
      return { status: 200, body: { signedOut: 2, message: 'Signed out of 2 browsers.' } };
    }
    if (method === 'DELETE' && path === '/session') {
      if (this.kind !== 'session') return err(400, 'not_a_session', 'This device isn’t signed in with the password.');
      this.signedIn = false;
      return { status: 200, body: { signedOut: true } };
    }
    if (method === 'POST' && path === '/pair') {
      const c = norm(String(b.code ?? ''));
      if (c.length !== 8 || !this.codes.has(c)) return err(400, 'pair_code_invalid', 'That code is wrong, used or expired. Make a new one in Settings on your computer.');
      this.codes.delete(c);
      const id = `dev_new${++this.n}`;
      const name = String(b.name ?? '').trim().slice(0, 60) || 'Phone';
      this.devices = [{ id, name, platform: String(b.platform ?? '') || null, scopes: [...PHONE_SCOPES], createdAt: this.clock(), lastSeen: this.clock(), revokedAt: null }, ...this.devices];
      this.signedIn = true; this.kind = 'device'; this.deviceId = id;
      return { status: 201, body: { deviceId: id, scopes: [...PHONE_SCOPES] } };
    }
    if (method === 'POST' && path === '/pair/codes') {
      let raw = '';
      for (let i = 0; i < 8; i++) raw += CODE_ALPHABET[(this.n * 7 + i * 13 + 5) % CODE_ALPHABET.length];
      this.n++;
      this.codes.add(raw);
      const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
      const base = this.settings.publicUrl ?? 'http://localhost:7788';
      return { status: 201, body: { code, expiresAt: this.clock() + 10 * MINUTE, pairUrl: `${base}/pair#c=${code}`, scopes: [...PHONE_SCOPES], reachable: !!this.settings.publicUrl } };
    }
    if (method === 'POST' && path === '/devices/me/sign-out') {
      if (this.kind !== 'device' || !this.deviceId) return err(400, 'not_a_device', 'Only a paired device can sign itself out.');
      const id = this.deviceId;
      this.devices = this.devices.map((d) => (d.id === id ? { ...d, revokedAt: this.clock() } : d));
      this.signedIn = false; this.deviceId = null;
      return { status: 200, body: { revoked: id } };
    }
    if ((m = /^\/devices\/([^/]+)$/.exec(path)) && (method === 'DELETE' || method === 'PATCH')) {
      const id = decodeURIComponent(m[1]);
      const d = this.devices.find((x) => x.id === id && !x.revokedAt);
      if (method === 'PATCH') {
        const name = typeof b.name === 'string' ? b.name.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
        if (!name) return err(400, 'bad_name', 'Give the device a name.');
        if (!d) return err(404, 'not_found', 'No such device, or it was already removed.');
        const nd = { ...d, name };
        this.devices = this.devices.map((x) => (x.id === id ? nd : x));
        return { status: 200, body: { device: nd } };
      }
      if (!d) return err(404, 'not_found', 'No such device, or it was already removed.');
      this.devices = this.devices.map((x) => (x.id === id ? { ...x, revokedAt: this.clock() } : x));
      return { status: 200, body: { revoked: id } };
    }
    if (method === 'PATCH' && path === '/settings') {
      const known = ['helperName', 'ownerName', 'timeZone', 'firstRunDone', 'features', 'publicUrl'];
      if (!Object.keys(b).length || Object.keys(b).some((x) => !known.includes(x))) return err(400, 'bad_body', `Send one or more of: ${known.join(', ')}.`);
      const s = { ...this.settings };
      if (b.helperName !== undefined) { const n = String(b.helperName).trim().slice(0, 40); if (!n) return err(400, 'bad_name', 'Give your helper a name, or leave it as it is.'); s.helperName = n; }
      if (b.ownerName !== undefined) s.ownerName = b.ownerName === null ? null : String(b.ownerName).trim().slice(0, 40) || null;
      if (b.timeZone !== undefined) {
        const z = String(b.timeZone);
        try { new Intl.DateTimeFormat('en-US', { timeZone: z }); } catch { return err(400, 'bad_time_zone', 'That isn’t a time zone I know. Pick one from the list, for example America/New_York.'); }
        s.timeZone = z;
      }
      if (b.firstRunDone !== undefined) s.firstRunDone = !!b.firstRunDone;
      if (b.publicUrl !== undefined) {
        if (b.publicUrl === null || b.publicUrl === '') s.publicUrl = null;
        else {
          let u: URL | null = null;
          try { const t = String(b.publicUrl).trim(); u = new URL(/^[a-z]+:\/\//i.test(t) ? t : `https://${t}`); } catch { u = null; }
          if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:') || (u.pathname && u.pathname !== '/')) return err(400, 'bad_url', 'That isn’t an address a phone can open. Use the one in your browser’s address bar on the phone, for example https://mwa.tail1a2b.ts.net.');
          s.publicUrl = `${u.protocol}//${u.host}`;
        }
      }
      if (b.features !== undefined) {
        const f = b.features as Record<string, unknown>;
        if (!f || typeof f !== 'object' || Object.keys(f).some((x) => x !== 'sorting')) return err(400, 'bad_body', '`features` is {"sorting": true or false}. The other switches can’t be changed here.');
        if (typeof f.sorting === 'boolean') s.features = s.features.map((x) => (x.id === 'sorting' ? { ...x, on: f.sorting as boolean } : x));
      }
      this.settings = s;
      return { status: 200, body: s };
    }
    if (method === 'PATCH' && path === '/spending') {
      const sp = { ...this.spending, limit: { ...this.spending.limit }, defaults: { ...this.spending.defaults } };
      if (b.monthlyUsd !== undefined) {
        if (b.monthlyUsd !== null && !(typeof b.monthlyUsd === 'number' && b.monthlyUsd >= 1)) return err(400, 'bad_limit', 'Give a monthly limit of at least $1, for example 20.');
        sp.limit.usd = b.monthlyUsd as number | null;
        sp.limit.pct = sp.limit.usd ? Math.round((sp.month.usd / sp.limit.usd) * 10_000) / 100 : null;
        sp.limit.state = sp.limit.usd ? (sp.month.usd >= sp.limit.usd ? 'over' : sp.month.usd >= 0.8 * sp.limit.usd ? 'warn' : 'ok') : 'none';
      }
      if (b.perFireUsd !== undefined) {
        if (b.perFireUsd !== null && !(typeof b.perFireUsd === 'number' && b.perFireUsd > 0 && b.perFireUsd <= 20)) return err(400, 'bad_cap', 'Give a dollar amount above 0 and at most $20, for example 0.25.');
        sp.defaults.perFireUsd = b.perFireUsd === null ? 0.25 : b.perFireUsd as number;
      }
      this.spending = sp;
      return { status: 200, body: sp };
    }
    if (method === 'POST' && (m = /^\/accounts\/([^/]+)\/connect$/.exec(path))) {
      const p = decodeURIComponent(m[1]);
      if (p !== 'google' && p !== 'outlook') return err(404, 'not_found', 'Connect Google or Outlook.');
      // the example world: the sign-in "finishes" at once (nothing really opens)
      this.accounts = this.accounts.map((a) => (a.provider === p ? { ...a, connected: true, needsReconnect: false, method: 'sign-in' } : a));
      if (p === 'outlook') return { status: 200, body: { kind: 'code', provider: p, code: 'QWER-TY12', url: 'https://microsoft.com/devicelogin', expiresIn: 900, message: 'Go to microsoft.com/devicelogin and enter the code QWER-TY12. I’ll show Outlook as connected once you finish.' } };
      return { status: 200, body: { kind: 'browser', provider: p, url: 'https://accounts.google.com/', message: 'Approve access in the Google window that opens, then come back. This works on the computer your helper runs on.' } };
    }
    if (method === 'POST' && path === '/vault/forget') {
      const name = String(b.name ?? '').trim();
      if (!this.vault.some((v) => v.name === name)) return err(404, 'not_found', `No saved login called "${name}".`);
      this.vault = this.vault.filter((v) => v.name !== name);
      return { status: 200, body: { forgot: name, message: `Forgot "${name}". Jobs that used it will ask again.` } };
    }
    if (method === 'POST' && path === '/files') {
      const pid = query?.get('projectId') || 'general';
      const name = (query?.get('name') ?? '').replace(/\\/g, '/').split('/').pop()!.replace(/[^\w.\- ()]/g, '_').replace(/^[.\s]+/, '').trim().slice(0, 120) || 'upload';
      const path2 = `serve/p-${pid}/uploads/${name}`;
      const row: FileRow = { id: path2, path: path2, name, size: 1024, mtime: this.clock() };
      this.files.set(pid, [row, ...(this.files.get(pid) ?? [])]);
      return { status: 201, body: { id: path2, path: path2, name, size: 1024, projectId: pid, pages: 1 } };
    }
    return null;
  }
}
