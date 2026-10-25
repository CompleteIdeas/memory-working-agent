/**
 * Settings the app shows in one place (interface slice of the usability review, 2026-10-25, D5): the saved logins
 * in the vault (names, sites and field names only, never a value) with Forget, and the quiet-hours window. Saving a
 * login stays in the vault card (BL-63); quiet hours could only be set by asking the model before this.
 */
import { vaultList, vaultForget } from './vault/vault.js';
import { quietWindow, setQuietHours, quietEnvInvalid, timeZoneName } from './quiet.js';

export interface VaultRow { name: string; site?: string; fields: string[]; savedAt?: number }

/** What is saved, without a single value. */
export function vaultRows(): VaultRow[] {
  return vaultList().map((v) => ({ name: v.name, ...(v.site ? { site: v.site } : {}), fields: v.fields, ...(v.savedAt ? { savedAt: v.savedAt } : {}) }));
}

export function forgetVaultEntry(name: string): { ok: boolean; message: string } {
  const n = String(name ?? '').trim();
  if (!n) return { ok: false, message: 'Which entry?' };
  return vaultForget(n) ? { ok: true, message: `Forgot "${n}". Jobs that used it will ask again.` } : { ok: false, message: `No saved login called "${n}".` };
}

export interface QuietState { window: string | null; timeZone: string; fixed: boolean; invalid: boolean }

export function quietState(): QuietState {
  const fixed = (process.env.MWA_QUIET_HOURS ?? '').trim() !== '';
  return { window: quietWindow()?.label ?? null, timeZone: timeZoneName(), fixed, invalid: quietEnvInvalid() };
}

/** "HH:MM-HH:MM" or "off". Refused when the deployment fixes the window. */
export function setQuiet(value: string): { ok: boolean; message: string; state: QuietState } {
  if ((process.env.MWA_QUIET_HOURS ?? '').trim() !== '') return { ok: false, message: 'Quiet hours are fixed by this deployment (MWA_QUIET_HOURS).', state: quietState() };
  try {
    const w = setQuietHours(String(value ?? ''));
    return { ok: true, message: w ? `Quiet hours ${w.label}. Jobs still run on time; messages wait until the window ends.` : 'Quiet hours off.', state: quietState() };
  } catch (e) { return { ok: false, message: (e as Error).message, state: quietState() }; }
}
