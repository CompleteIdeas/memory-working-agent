/**
 * The helper's own settings, as v2 Settings shows them (v2 build, slice W5): what the helper is called, the name in
 * the greeting, the time zone, the helper's address for phones, whether first-run setup was finished, and the on/off
 * switches the app may change.
 *
 * Names, time zone and switches live in mwa.config.json beside the other settings (`owner.name` is what Today's
 * greeting already reads; the rest under `helper`). First run and the public address live in app.db (W5 security
 * review: a broken config file must not trap the owner in first run). A deployment variable always wins and makes
 * that setting read-only here ("fixed"): MWA_OWNER_NAME, MWA_TZ, MWA_FIRE_CAP_USD, MWA_TRIAGE, MWA_PUBLIC_URL. The ones
 * the server reads from the environment at run time are applied to this process when saved, and again at start
 * (applyStoredSettings). A config file that is not valid JSON is reported (`configError`) instead of read as empty.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { configPath } from '../config.js';
import { validTz } from '../sync/tz.js';
import { calendarSyncOn, mailSyncOn } from '../sync/flags.js';
import { getAppSetting, setAppSetting } from '../api/sessions.js';

export interface FeatureView {
  id: 'sorting' | 'calendar' | 'mail';
  label: string;
  on: boolean;
  /** the app may switch it (false: fixed by the deployment, or it needs a restart) */
  canChange: boolean;
  /** plain words for what it does, or why it can't be changed here */
  note: string;
}
export interface HelperSettings {
  helperName: string;
  ownerName: string | null;
  ownerNameFixed: boolean;
  timeZone: string;
  timeZoneFixed: boolean;
  /** where phones reach the helper ("https://mwa.tail1a2b.ts.net"); null when not known */
  publicUrl: string | null;
  publicUrlFixed: boolean;
  firstRunDone: boolean;
  /** the settings file can't be read (not valid JSON): what is wrong, in plain words; null when fine */
  configError: string | null;
  features: FeatureView[];
}

export const DEFAULT_HELPER_NAME = 'Your helper';
const MAX_NAME = 40;

/** Whether a variable came from the deployment (set before this module touched it). */
const FROM_ENV = { owner: false, tz: false, fireCap: false, triage: false, publicUrl: false };
/** Note which settings the deployment fixes: called by applyStoredSettings at server start (after .env is loaded),
 *  and by tests. */
export function captureDeploymentEnv(env: NodeJS.ProcessEnv = process.env): void {
  FROM_ENV.owner = !!env.MWA_OWNER_NAME?.trim();
  FROM_ENV.tz = !!env.MWA_TZ?.trim();
  FROM_ENV.fireCap = (env.MWA_FIRE_CAP_USD ?? '').trim() !== '';
  FROM_ENV.triage = (env.MWA_TRIAGE ?? '').trim() !== '';
  FROM_ENV.publicUrl = !!env.MWA_PUBLIC_URL?.trim();
}
captureDeploymentEnv();

/** A name as stored: a string only (anything else is ignored), control characters out, trimmed, capped. */
const cleanName = (s: unknown): string => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) : '');

type Raw = Record<string, unknown> & { owner?: { name?: unknown }; helper?: Record<string, unknown> };
function readRaw(): { raw: Raw; error: string | null } {
  if (!existsSync(configPath())) return { raw: {}, error: null };
  let text = '';
  try { text = readFileSync(configPath(), 'utf8'); } catch (e) { return { raw: {}, error: `The settings file ${configPath()} can’t be read: ${(e as Error).message.slice(0, 120)}` }; }
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { raw: {}, error: `The settings file ${configPath()} must hold one { … } object.` };
    return { raw: v as Raw, error: null };
  } catch (e) {
    return { raw: {}, error: `The settings file ${configPath()} isn’t valid JSON (${(e as Error).message.slice(0, 120)}). Fix it or remove it, then reload.` };
  }
}
/** Read-modify-write mwa.config.json, as setMonthlyBudget does. Refuses (throws) when the file is not valid JSON. */
function writeRaw(change: (raw: Raw) => void): void {
  const { raw, error } = readRaw();
  if (error) throw new SettingsError('bad_config', `${error} Nothing was saved.`);
  change(raw);
  const tmp = `${configPath()}.tmp`;
  writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n');
  renameSync(tmp, configPath());
}

export class SettingsError extends Error { constructor(public code: string, message: string) { super(message); } }

const helperOf = (raw: Raw): Record<string, unknown> => (raw.helper && typeof raw.helper === 'object' && !Array.isArray(raw.helper) ? raw.helper : {});
const machineTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };
const triageOn = () => !/^(0|off|false|no)$/i.test(String(process.env.MWA_TRIAGE ?? '').trim());

/** "https://mwa.tail1a2b.ts.net" from what was given (scheme defaults to https); null when it can't be one. */
export function cleanPublicUrl(v: string): string | null {
  const s = v.trim().replace(/\/+$/, '');
  if (!s || s.length > 200) return null;
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== '/')) return null;
    return `${u.protocol}//${u.host}`;
  } catch { return null; }
}
/** Where a phone reaches the helper: MWA_PUBLIC_URL, else the address saved in Settings, else a tailnet name in
 *  MWA_ALLOWED_HOSTS. Null when none is known. */
export function publicBaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env.MWA_PUBLIC_URL ? cleanPublicUrl(env.MWA_PUBLIC_URL) : null;
  if (fromEnv) return fromEnv;
  try { const saved = getAppSetting('public_url'); if (saved) return saved; } catch { /* app.db unavailable */ }
  const ts = String(env.MWA_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).find((h) => /^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(h));
  return ts ? `https://${ts}` : null;
}

export function readSettings(): HelperSettings {
  const { raw, error } = readRaw();
  const h = helperOf(raw);
  const ownerName = FROM_ENV.owner ? cleanName(process.env.MWA_OWNER_NAME) : cleanName(raw.owner && typeof raw.owner === 'object' ? raw.owner.name : undefined);
  const tzSet = String(process.env.MWA_TZ ?? '').trim();
  let firstRunDone = false;
  try { firstRunDone = getAppSetting('first_run_done') === '1'; } catch { /* app.db unavailable */ }
  return {
    helperName: cleanName(h.name) || DEFAULT_HELPER_NAME,
    ownerName: ownerName || null,
    ownerNameFixed: FROM_ENV.owner,
    timeZone: tzSet && validTz(tzSet) ? tzSet : machineTz(),
    timeZoneFixed: FROM_ENV.tz,
    publicUrl: publicBaseUrl(),
    publicUrlFixed: FROM_ENV.publicUrl,
    firstRunDone,
    configError: error,
    features: [
      {
        id: 'sorting', label: 'Sorting your mail into Important', on: triageOn(), canChange: !FROM_ENV.triage,
        note: FROM_ENV.triage ? 'Set when this helper was installed, so it can’t be changed here.' : 'Reads new mail headers and picks what’s worth a look. A few cents a day, never more than 15¢.',
      },
      {
        id: 'calendar', label: 'Keeping your calendar up to date', on: calendarSyncOn(), canChange: false,
        note: calendarSyncOn() ? 'Checks your calendar every 30 minutes.' : 'Turned off when this helper was installed. It can be turned on there.',
      },
      {
        id: 'mail', label: 'Keeping your mail up to date', on: mailSyncOn(), canChange: false,
        note: mailSyncOn() ? 'Checks for new mail every few minutes. Only the subject lines are kept.' : 'Turned off when this helper was installed. It can be turned on there.',
      },
    ],
  };
}

export interface SettingsPatch { helperName?: unknown; ownerName?: unknown; timeZone?: unknown; firstRunDone?: unknown; features?: unknown; publicUrl?: unknown }
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** Apply a change from Settings (admin). Throws SettingsError with plain words for a refusal; nothing is saved then. */
export function updateSettings(p: SettingsPatch): HelperSettings {
  const set: Record<string, unknown> = {};
  let owner: string | null | undefined, tz: string | undefined, sorting: boolean | undefined, pub: string | null | undefined;
  if (p.helperName !== undefined) {
    if (typeof p.helperName !== 'string') throw new SettingsError('bad_body', '`helperName` is text.');
    const n = cleanName(p.helperName);
    if (!n) throw new SettingsError('bad_name', 'Give your helper a name, or leave it as it is.');
    set.name = n;
  }
  if (p.ownerName !== undefined) {
    if (p.ownerName !== null && typeof p.ownerName !== 'string') throw new SettingsError('bad_body', '`ownerName` is text, or null.');
    if (FROM_ENV.owner) throw new SettingsError('fixed', 'Your name was set when this helper was installed, so it can’t be changed here.');
    owner = p.ownerName === null ? null : cleanName(p.ownerName) || null;
  }
  if (p.timeZone !== undefined) {
    if (typeof p.timeZone !== 'string') throw new SettingsError('bad_body', '`timeZone` is text, for example America/New_York.');
    if (FROM_ENV.tz) throw new SettingsError('fixed', 'The time zone was set when this helper was installed, so it can’t be changed here.');
    const z = p.timeZone.trim();
    if (!z || z.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(z) || !validTz(z)) throw new SettingsError('bad_time_zone', 'That isn’t a time zone I know. Pick one from the list, for example America/New_York.');
    tz = z;
  }
  if (p.firstRunDone !== undefined) {
    if (typeof p.firstRunDone !== 'boolean') throw new SettingsError('bad_body', '`firstRunDone` is true or false.');
  }
  if (p.publicUrl !== undefined) {
    if (p.publicUrl !== null && typeof p.publicUrl !== 'string') throw new SettingsError('bad_body', '`publicUrl` is an address, or null.');
    if (FROM_ENV.publicUrl) throw new SettingsError('fixed', 'Your helper’s address was set when it was installed (MWA_PUBLIC_URL), so it can’t be changed here.');
    if (p.publicUrl === null || p.publicUrl.trim() === '') pub = null;
    else {
      pub = cleanPublicUrl(p.publicUrl);
      if (!pub) throw new SettingsError('bad_url', 'That isn’t an address a phone can open. Use the one in your browser’s address bar on the phone, for example https://mwa.tail1a2b.ts.net.');
    }
  }
  if (p.features !== undefined) {
    const f = p.features as Record<string, unknown> | null;
    if (!f || typeof f !== 'object' || Array.isArray(f) || Object.getPrototypeOf(f) !== Object.prototype
      || Object.keys(f).some((k) => k !== 'sorting') || (own(f, 'sorting') && typeof f.sorting !== 'boolean')) {
      throw new SettingsError('bad_body', '`features` is {"sorting": true or false}. The other switches can’t be changed here.');
    }
    if (own(f, 'sorting')) {
      if (FROM_ENV.triage) throw new SettingsError('fixed', 'Mail sorting was set when this helper was installed, so it can’t be changed here.');
      sorting = f.sorting as boolean;
    }
  }
  if (Object.keys(set).length || owner !== undefined || tz !== undefined || sorting !== undefined) {
    writeRaw((raw) => {
      const h = { ...helperOf(raw), ...set };
      if (tz !== undefined) h.timeZone = tz;
      if (sorting !== undefined) h.sorting = sorting;
      raw.helper = h;
      if (owner !== undefined) {
        const o = { ...(raw.owner && typeof raw.owner === 'object' && !Array.isArray(raw.owner) ? raw.owner : {}) } as Record<string, unknown>;
        if (owner) o.name = owner; else delete o.name;
        raw.owner = o;
      }
    });
  }
  if (p.firstRunDone !== undefined) setAppSetting('first_run_done', p.firstRunDone ? '1' : null);
  if (pub !== undefined) setAppSetting('public_url', pub);
  if (tz !== undefined) process.env.MWA_TZ = tz;
  if (sorting !== undefined) process.env.MWA_TRIAGE = sorting ? '1' : '0';
  return readSettings();
}

/** The per-fire limit stored by Settings (null: the default). Applied to MWA_FIRE_CAP_USD unless the deployment set it. */
export function fireCapFixed(): boolean { return FROM_ENV.fireCap; }
/** null or 0: back to the default (25¢). Rounded to the cent first, then at least 1¢ and at most $20 — so 0.001 is
 *  refused rather than becoming "no limit" (W5 security review, finding 4). */
export function setFireCap(usd: number | null): void {
  if (FROM_ENV.fireCap) throw new SettingsError('fixed', 'The limit for repeating jobs was set when this helper was installed, so it can’t be changed here.');
  let v: number | null = usd;
  if (v !== null) {
    if (!Number.isFinite(v)) throw new SettingsError('bad_cap', 'Give a dollar amount from $0.01 to $20, for example 0.25.');
    if (v === 0) v = null;
    else {
      v = Math.round(v * 100) / 100;
      if (!(v >= 0.01 && v <= 20)) throw new SettingsError('bad_cap', 'Give a dollar amount from $0.01 to $20, for example 0.25.');
    }
  }
  writeRaw((raw) => {
    const h = { ...helperOf(raw) };
    if (v === null) delete h.fireCapUsd; else h.fireCapUsd = v;
    raw.helper = h;
  });
  if (v === null) delete process.env.MWA_FIRE_CAP_USD; else process.env.MWA_FIRE_CAP_USD = String(v);
}

/** At server start: settings saved here that the server reads from the environment, unless the deployment set them. */
let captured = false;
export function applyStoredSettings(): void {
  if (!captured) { captureDeploymentEnv(); captured = true; } // once: a second call must not count our own values as the deployment's
  const h = helperOf(readRaw().raw);
  if (!FROM_ENV.tz && typeof h.timeZone === 'string' && validTz(h.timeZone)) process.env.MWA_TZ = h.timeZone;
  if (!FROM_ENV.triage && typeof h.sorting === 'boolean') process.env.MWA_TRIAGE = h.sorting ? '1' : '0';
  if (!FROM_ENV.fireCap && typeof h.fireCapUsd === 'number' && h.fireCapUsd >= 0.01 && h.fireCapUsd <= 20) process.env.MWA_FIRE_CAP_USD = String(h.fireCapUsd);
}
