/**
 * The helper's own settings, as v2 Settings shows them (v2 build, slice W5): what the helper is called, the name in
 * the greeting, the time zone, whether first-run setup was finished, and the on/off switches the app may change.
 *
 * Kept in mwa.config.json beside the other settings (`owner.name` is what Today's greeting already reads; the rest
 * under `helper`). A deployment variable always wins and makes that setting read-only here ("fixed"): MWA_OWNER_NAME,
 * MWA_TZ, MWA_FIRE_CAP_USD, MWA_TRIAGE. The ones the server reads from the environment at run time (time zone,
 * per-fire limit, mail sorting) are applied to this process when saved, and again at start (applyStoredSettings), so
 * a change works without a restart and survives one.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { configPath } from '../config.js';
import { validTz } from '../sync/tz.js';
import { calendarSyncOn, mailSyncOn } from '../sync/flags.js';

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
  firstRunDone: boolean;
  features: FeatureView[];
}

export const DEFAULT_HELPER_NAME = 'Your helper';
const MAX_NAME = 40;

/** Whether a variable came from the deployment (set before this module touched it). */
const FROM_ENV = {
  owner: !!process.env.MWA_OWNER_NAME?.trim(),
  tz: !!process.env.MWA_TZ?.trim(),
  fireCap: (process.env.MWA_FIRE_CAP_USD ?? '').trim() !== '',
  triage: (process.env.MWA_TRIAGE ?? '').trim() !== '',
};
/** Note which settings the deployment fixes: called by applyStoredSettings at server start (after .env is loaded),
 *  and by tests. */
export function captureDeploymentEnv(env: NodeJS.ProcessEnv = process.env): void {
  FROM_ENV.owner = !!env.MWA_OWNER_NAME?.trim();
  FROM_ENV.tz = !!env.MWA_TZ?.trim();
  FROM_ENV.fireCap = (env.MWA_FIRE_CAP_USD ?? '').trim() !== '';
  FROM_ENV.triage = (env.MWA_TRIAGE ?? '').trim() !== '';
}

const cleanName = (s: unknown): string => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);

type Raw = Record<string, unknown> & { owner?: { name?: unknown }; helper?: Record<string, unknown> };
function readRaw(): Raw {
  try { if (existsSync(configPath())) return JSON.parse(readFileSync(configPath(), 'utf8')) as Raw; } catch { /* not JSON: treated as empty for reading */ }
  return {};
}
/** Read-modify-write mwa.config.json, as setMonthlyBudget does. Refuses (throws) when the file is not valid JSON. */
function writeRaw(change: (raw: Raw) => void): void {
  let raw: Raw = {};
  if (existsSync(configPath())) {
    try { raw = JSON.parse(readFileSync(configPath(), 'utf8')) as Raw; }
    catch { throw new SettingsError('bad_config', 'The settings file isn’t valid JSON, so nothing was saved. Fix the file first.'); }
  }
  change(raw);
  const tmp = `${configPath()}.tmp`;
  writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n');
  renameSync(tmp, configPath());
}

export class SettingsError extends Error { constructor(public code: string, message: string) { super(message); } }

const helperOf = (raw: Raw): Record<string, unknown> => (raw.helper && typeof raw.helper === 'object' ? raw.helper : {});
const machineTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };
const triageOn = () => !/^(0|off|false|no)$/i.test(String(process.env.MWA_TRIAGE ?? '').trim());

export function readSettings(): HelperSettings {
  const raw = readRaw(), h = helperOf(raw);
  const ownerName = FROM_ENV.owner ? cleanName(process.env.MWA_OWNER_NAME) : cleanName(raw.owner?.name) || null;
  const tzSet = String(process.env.MWA_TZ ?? '').trim();
  return {
    helperName: cleanName(h.name) || DEFAULT_HELPER_NAME,
    ownerName: ownerName || null,
    ownerNameFixed: FROM_ENV.owner,
    timeZone: tzSet && validTz(tzSet) ? tzSet : machineTz(),
    timeZoneFixed: FROM_ENV.tz,
    firstRunDone: h.firstRunDone === true,
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

export interface SettingsPatch { helperName?: unknown; ownerName?: unknown; timeZone?: unknown; firstRunDone?: unknown; features?: unknown }

/** Apply a change from Settings (admin). Throws SettingsError with plain words for a refusal. */
export function updateSettings(p: SettingsPatch): HelperSettings {
  const set: Record<string, unknown> = {};
  let owner: string | null | undefined, tz: string | undefined, sorting: boolean | undefined;
  if (p.helperName !== undefined) {
    const n = cleanName(p.helperName);
    if (!n) throw new SettingsError('bad_name', 'Give your helper a name, or leave it as it is.');
    set.name = n;
  }
  if (p.ownerName !== undefined) {
    if (FROM_ENV.owner) throw new SettingsError('fixed', 'Your name was set when this helper was installed, so it can’t be changed here.');
    owner = p.ownerName === null ? null : cleanName(p.ownerName) || null;
  }
  if (p.timeZone !== undefined) {
    if (FROM_ENV.tz) throw new SettingsError('fixed', 'The time zone was set when this helper was installed, so it can’t be changed here.');
    const z = String(p.timeZone ?? '').trim();
    if (!z || z.length > 64 || !validTz(z)) throw new SettingsError('bad_time_zone', 'That isn’t a time zone I know. Pick one from the list, for example America/New_York.');
    tz = z;
  }
  if (p.firstRunDone !== undefined) {
    if (typeof p.firstRunDone !== 'boolean') throw new SettingsError('bad_body', '`firstRunDone` is true or false.');
    set.firstRunDone = p.firstRunDone;
  }
  if (p.features !== undefined) {
    const f = p.features as Record<string, unknown> | null;
    if (!f || typeof f !== 'object' || Array.isArray(f) || Object.keys(f).some((k) => k !== 'sorting') || (f.sorting !== undefined && typeof f.sorting !== 'boolean')) {
      throw new SettingsError('bad_body', '`features` is {"sorting": true or false}. The other switches can’t be changed here.');
    }
    if (f.sorting !== undefined) {
      if (FROM_ENV.triage) throw new SettingsError('fixed', 'Mail sorting was set when this helper was installed, so it can’t be changed here.');
      sorting = f.sorting as boolean;
    }
  }
  writeRaw((raw) => {
    const h = { ...helperOf(raw), ...set };
    if (tz !== undefined) h.timeZone = tz;
    if (sorting !== undefined) h.sorting = sorting;
    raw.helper = h;
    if (owner !== undefined) {
      const o = { ...(raw.owner && typeof raw.owner === 'object' ? raw.owner : {}) } as Record<string, unknown>;
      if (owner) o.name = owner; else delete o.name;
      raw.owner = o;
    }
  });
  if (tz !== undefined) process.env.MWA_TZ = tz;
  if (sorting !== undefined) process.env.MWA_TRIAGE = sorting ? '1' : '0';
  return readSettings();
}

/** The per-fire limit stored by Settings (null: the default). Applied to MWA_FIRE_CAP_USD unless the deployment set it. */
export function fireCapFixed(): boolean { return FROM_ENV.fireCap; }
export function setFireCap(usd: number | null): void {
  if (FROM_ENV.fireCap) throw new SettingsError('fixed', 'The limit for repeating jobs was set when this helper was installed, so it can’t be changed here.');
  if (usd !== null && !(Number.isFinite(usd) && usd > 0 && usd <= 20)) throw new SettingsError('bad_cap', 'Give a dollar amount above 0 and at most $20, for example 0.25.');
  writeRaw((raw) => {
    const h = { ...helperOf(raw) };
    if (usd === null) delete h.fireCapUsd; else h.fireCapUsd = Math.round(usd * 100) / 100;
    raw.helper = h;
  });
  if (usd === null) delete process.env.MWA_FIRE_CAP_USD; else process.env.MWA_FIRE_CAP_USD = String(Math.round(usd * 100) / 100);
}

/** At server start: settings saved here that the server reads from the environment, unless the deployment set them. */
let captured = false;
export function applyStoredSettings(): void {
  if (!captured) { captureDeploymentEnv(); captured = true; } // once: a second call must not count our own values as the deployment's
  const h = helperOf(readRaw());
  if (!FROM_ENV.tz && typeof h.timeZone === 'string' && validTz(h.timeZone)) process.env.MWA_TZ = h.timeZone;
  if (!FROM_ENV.triage && typeof h.sorting === 'boolean') process.env.MWA_TRIAGE = h.sorting ? '1' : '0';
  if (!FROM_ENV.fireCap && typeof h.fireCapUsd === 'number' && h.fireCapUsd > 0 && h.fireCapUsd <= 20) process.env.MWA_FIRE_CAP_USD = String(h.fireCapUsd);
}
