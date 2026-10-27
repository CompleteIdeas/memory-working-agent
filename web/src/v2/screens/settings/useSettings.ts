/**
 * Settings' data (v2 build, slice W5): who this device is (/me), the helper's settings, spending, accounts, devices
 * and saved logins, read through the typed client and changed through it — every change with its own
 * Idempotency-Key (the client makes one per call; `act` keeps it for the retry of the same tap). Admin-only parts
 * (devices, saved logins, changing limits and connections) are loaded only for a caller with admin.
 *
 * Plain functions over a small state object, so the logic is tested without React (tests/web-v2-w5-store.test.ts).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, NetworkError, SignInRequired, newKey, type Account, type ConnectStart, type Device, type HelperSettings, type Me, type MwaClient, type PairCode, type SettingsPatch, type Spending, type SpendingPatch, type VaultEntry } from '../../api/client';
import { useStore } from '../../store/react';

export interface SettingsData {
  me: Me | null;
  settings: HelperSettings | null;
  spending: Spending | null;
  accounts: Account[] | null;
  devices: Device[] | null;
  vault: VaultEntry[] | null;
  loading: boolean;
  error: string | null;
}
export const EMPTY_DATA: SettingsData = { me: null, settings: null, spending: null, accounts: null, devices: null, vault: null, loading: true, error: null };

export const isAdmin = (me: Me | null) => !!me?.scopes.includes('admin');

/** Everything Settings shows, in one round (the admin-only parts only for admin). A part that fails stays null. */
export async function loadSettingsData(client: MwaClient): Promise<SettingsData> {
  let me: Me;
  try { me = await client.getMe(); } catch (e) { return { ...EMPTY_DATA, loading: false, error: messageOf(e) }; }
  const admin = isAdmin(me);
  const safe = async <T,>(f: () => Promise<T>): Promise<T | null> => { try { return await f(); } catch (e) { if (e instanceof SignInRequired) throw e; return null; } };
  const [settings, spending, accounts, devices, vault] = await Promise.all([
    safe(() => client.getSettings()), safe(() => client.getSpending()), safe(async () => (await client.listAccounts()).accounts),
    admin ? safe(async () => (await client.listDevices()).devices) : Promise.resolve(null),
    admin ? safe(async () => (await client.listVault()).entries) : Promise.resolve(null),
  ]);
  return { me, settings, spending, accounts, devices, vault, loading: false, error: null };
}

/** The server's own words for a refusal; plain words when the helper can't be reached. */
export function messageOf(e: unknown): string {
  if (e instanceof NetworkError) return 'Can’t reach your helper right now. Try again in a moment.';
  if (e instanceof ApiError) return e.message;
  return 'That didn’t work. Try again.';
}

// ---------- plain words ----------

export function money(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return '';
  if (usd > 0 && usd < 1) return `${Math.round(usd * 100)}¢`;
  return `$${usd.toFixed(2).replace(/\.00$/, '')}`;
}
/** "$1.29 of your $20 limit" / "$1.29 so far, no limit" */
export function spendLine(s: Spending): string {
  const used = `$${s.month.usd.toFixed(2)}`;
  return s.limit.usd ? `${used} of your ${money(s.limit.usd)} limit` : `${used} so far · no monthly limit`;
}
export function backgroundLine(s: Spending): string | null {
  if (!s.background.length) return null;
  return `In the background: ${s.background.map((b) => `${b.label.toLowerCase()} ${money(b.usd) || '$0'}`).join(' · ')}`;
}
/** "Used 10 minutes ago", "Used yesterday", "Used Oct 12" */
export function lastUsed(ms: number | null, now: number): string {
  if (!ms) return 'Not used yet';
  const m = Math.round((now - ms) / 60_000);
  if (m < 2) return 'Used just now';
  if (m < 60) return `Used ${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `Used ${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'Used yesterday';
  if (d < 7) return `Used ${d} days ago`;
  return `Used ${new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}
export function accountLine(a: Account): string {
  if (a.needsReconnect) return 'The sign-in stopped working. Reconnect to keep your day up to date.';
  if (a.connected) return a.what;
  return 'Not connected.';
}
/** The active devices, this one first, then the most recently used. */
export function activeDevices(list: Device[], thisId: string | null): Device[] {
  return list.filter((d) => !d.revokedAt).sort((a, b) => Number(b.id === thisId) - Number(a.id === thisId) || (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
}
/** A name for this phone before it is paired: "Android phone", "iPhone", "This computer". */
export function guessDeviceName(ua: string): string {
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? 'Android phone' : 'Android tablet';
  if (/Windows|Macintosh|Linux/i.test(ua)) return 'Computer';
  return 'Phone';
}
export function guessPlatform(ua: string): string | undefined {
  if (/iPhone|iPad/i.test(ua)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Macintosh/i.test(ua)) return 'mac';
  return undefined;
}
/** A code from a link (#c=ABCD-EFGH) or typed: upper case, the dash put back. Null when it can't be one. */
export function normalizeCode(raw: string): string | null {
  const c = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (c.length !== 8) return null;
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}
export function codeFromHash(hash: string): string | null {
  const m = /(?:^#|&)c=([A-Za-z0-9-]{8,12})/.exec(hash);
  return m ? normalizeCode(m[1]) : null;
}

// ---------- the hook ----------

export type ActOutcome = { ok: true; message?: string } | { ok: false; message: string };

export function useSettingsData() {
  const store = useStore();
  const client = store.client;
  const [data, setData] = useState<SettingsData>(EMPTY_DATA);
  const reload = useCallback(async () => {
    try { setData(await loadSettingsData(client)); }
    catch (e) { if (e instanceof SignInRequired) store.signedOut(); else setData({ ...EMPTY_DATA, loading: false, error: messageOf(e) }); }
  }, [client, store]);
  useEffect(() => { void reload(); }, [reload]);

  const actions = useMemo(() => {
    /** One tap: its own key (a retry of the same tap would reuse it); 401 → the sign-in screens. */
    const act = async <T,>(run: (key: string) => Promise<T>, apply?: (r: T) => void, ok?: (r: T) => string | undefined): Promise<ActOutcome> => {
      const key = newKey();
      try {
        const r = await run(key);
        apply?.(r);
        return { ok: true, message: ok?.(r) };
      } catch (e) {
        if (e instanceof SignInRequired) { store.signedOut(); return { ok: false, message: e.message }; }
        return { ok: false, message: messageOf(e) };
      }
    };
    return {
      updateSettings: (p: SettingsPatch) => act((key) => client.updateSettings(p, { key }), (s) => setData((d) => ({ ...d, settings: s })), () => 'Saved.'),
      updateSpending: (p: SpendingPatch) => act((key) => client.updateSpending(p, { key }), (s) => setData((d) => ({ ...d, spending: s })), () => 'Saved.'),
      connect: (provider: 'google' | 'outlook') => {
        let started: ConnectStart | null = null;
        return act((key) => client.connectAccount(provider, { key }), (r) => { started = r; }, (r) => r.message).then((o) => ({ ...o, start: started as ConnectStart | null }));
      },
      refreshAccounts: async () => { try { const r = await client.listAccounts(); setData((d) => ({ ...d, accounts: r.accounts })); return r.accounts; } catch { return null; } },
      renameDevice: (id: string, name: string) => act((key) => client.renameDevice(id, name, { key }), (r) => setData((d) => ({ ...d, devices: (d.devices ?? []).map((x) => (x.id === id ? r.device : x)) })), () => 'Renamed.'),
      removeDevice: (dv: Device) => act((key) => client.revokeDevice(dv.id, { key }), () => setData((d) => ({ ...d, devices: (d.devices ?? []).map((x) => (x.id === dv.id ? { ...x, revokedAt: store.now() } : x)) })), () => `Removed ${dv.name}. It can’t reach your helper any more.`),
      createPairCode: async (): Promise<{ ok: true; code: PairCode } | { ok: false; message: string }> => {
        try { return { ok: true, code: await client.createPairCode({ key: newKey() }) }; }
        catch (e) { if (e instanceof SignInRequired) store.signedOut(); return { ok: false, message: messageOf(e) }; }
      },
      forgetLogin: (name: string) => act((key) => client.forgetVaultEntry(name, { key }), () => setData((d) => ({ ...d, vault: (d.vault ?? []).filter((v) => v.name !== name) })), (r) => r.message),
      /** Sign this device out: a paired device revokes itself; a password session ends. Then the sign-in screens. */
      signOut: async (): Promise<ActOutcome> => {
        const me = data.me;
        const out = me?.kind === 'device'
          ? await act((key) => client.signOutThisDevice({ key }))
          : await act((key) => client.signOut({ key }));
        if (out.ok) store.signedOut();
        return out;
      },
    };
  }, [client, store, data.me]);

  return { ...data, admin: isAdmin(data.me), reload, ...actions };
}
