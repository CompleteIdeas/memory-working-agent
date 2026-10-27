/**
 * Settings › Connections' data (v2 build, slice S3): GET /connections (and the address for phones from /settings, for
 * the Tailscale explanation), and every change through the typed client, each with its own Idempotency-Key.
 * Passwords, secrets, tokens and keys are write-only: what is typed goes to the server and is cleared from the screen;
 * the page only ever says whether one is saved.
 *
 * Where a link lands (Today's Reconnect, the Calendar's Connect, a setup note): `openConnectionsAt` before going to the
 * screen, or `?view=connections&at=<google|outlook|telegram|tailscale>` in the address.
 *
 * The words are plain functions, tested without React (tests/web-v2-s3.test.ts).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { SignInRequired, newKey, type ConnectStart, type ConnectionChange, type ConnectionService, type Connections, type Me } from '../../api/client';
import { useStore } from '../../store/react';
import { isAdmin, messageOf, type ActOutcome } from './useSettings';

export type ConnTarget = ConnectionService;
const TARGETS: ConnTarget[] = ['google', 'outlook', 'telegram', 'tailscale'];
let pendingAt: ConnTarget | null = null;
/** Land on this part of the Connections screen the next time it opens. */
export function openConnectionsAt(t: ConnTarget | null): void { pendingAt = t; }
/** Where to land: what was asked in the app, else `at` in the address. Asked once: taking it clears it. */
export function takeConnectionsAt(search = typeof location !== 'undefined' ? location.search : ''): ConnTarget | null {
  const t = pendingAt;
  pendingAt = null;
  if (t) return t;
  const q = new URLSearchParams(search).get('at');
  return q && (TARGETS as string[]).includes(q) ? (q as ConnTarget) : null;
}
/** Today and the Calendar name an account ("google:me@x.com", "outlook:…"): which part of the screen is it? */
export function providerOfAccount(id: string | null | undefined): 'google' | 'outlook' | null {
  if (!id) return null;
  const p = id.split(':')[0].toLowerCase();
  return p === 'outlook' || p === 'microsoft' ? 'outlook' : p === 'google' || p === 'gmail' || p === 'imap' ? 'google' : null;
}

// ---------- plain words ----------

export function googleLine(c: Connections): string {
  const g = c.google;
  if (g.needsReconnect) return 'The sign-in stopped working. Reconnect to keep your mail and day up to date.';
  if (g.method === 'sign-in') return 'Connected with Google sign-in: Gmail and Google Calendar. I can read them and make drafts. I never send.';
  if (g.method === 'app-password') return `Connected with an app password${g.address ? ` (${g.address})` : ''}: Gmail only. I can read it and make drafts. I never send. Calendar needs Google sign-in.`;
  return 'Not connected.';
}
export function outlookLine(c: Connections): string {
  const o = c.outlook;
  if (o.needsReconnect) return 'The sign-in stopped working. Reconnect to keep your mail and day up to date.';
  if (o.connected) return 'Connected: Outlook mail and calendar. I can read them and make drafts. I never send.';
  return 'Not connected.';
}
/** Why a sign-in in a browser window isn't offered (null when it is). */
export function browserNote(state: 'ready' | 'setup' | 'server', provider: 'google' | 'outlook', host: string): string | null {
  if (state === 'ready') return null;
  if (state === 'server') {
    return provider === 'google'
      ? `Google sign-in finishes on the computer your helper runs on, so it can’t work on your ${host} server. Use an app password instead (Gmail only).`
      : `Signing in in a browser window finishes on the computer your helper runs on, so it can’t work on your ${host} server. Use the code instead.`;
  }
  return provider === 'google'
    ? 'Google sign-in needs your own Google sign-in app first (a one-time setup, below). Or use an app password: no setup, Gmail only.'
    : 'Signing in in a browser window needs your own Microsoft app first (a one-time setup, below).';
}
/** What stops working when this is disconnected: said before asking. */
export function disconnectWarning(service: ConnTarget, c: Connections): string {
  if (service === 'google') {
    const what = c.google.method === 'app-password'
      ? 'I’ll stop reading your Gmail, so I stop sorting your mail and making drafts there.'
      : 'I’ll stop reading your Gmail and Google Calendar: I stop sorting your mail and making drafts, and your Google events leave Today and the Calendar.';
    return `${what} Drafts I already made stay in Gmail.${c.google.appSaved ? ' Your Google sign-in app is removed too, so signing in again means setting it up again.' : ''}`;
  }
  if (service === 'outlook') {
    return `I’ll stop reading your Outlook mail and calendar: I stop sorting your mail and making drafts, and your Outlook events leave Today and the Calendar. Drafts I already made stay in Outlook.${c.outlook.appSaved ? ' Your own Microsoft app is removed too.' : ''}`;
  }
  if (service === 'telegram') return 'I’ll stop answering you on Telegram, and approvals and notes stop going there. Your bot stays in Telegram; you can connect it again later.';
  return 'When your helper next restarts, it leaves your tailnet: a phone that reaches it at its tailnet address can’t any more. Pair your phones with another address first.';
}
export const SERVICE_LABEL: Record<ConnTarget, string> = { google: 'Google', outlook: 'Outlook', telegram: 'Telegram', tailscale: 'Tailscale' };
/** "Expires in 14 minutes" for a code. */
export function codeLeft(expiresAt: number, now: number): string {
  const m = Math.ceil((expiresAt - now) / 60_000);
  if (m <= 0) return 'This code has run out. Get a new one.';
  return m === 1 ? 'This code works for about 1 more minute.' : `This code works for ${m} more minutes.`;
}
export function tailscaleLine(c: Connections): string {
  if (!c.tailscale.keySaved) return 'Not set up.';
  return `Key saved. Name on your tailnet: ${c.tailscale.hostname ?? 'mwa'}. Used when your helper starts.`;
}

// ---------- the hook ----------

export interface ConnectionsData { me: Me | null; c: Connections | null; publicUrl: string | null; loading: boolean; error: string | null }

export function useConnections() {
  const store = useStore();
  const client = store.client;
  const [data, setData] = useState<ConnectionsData>({ me: null, c: null, publicUrl: null, loading: true, error: null });
  const reload = useCallback(async () => {
    try {
      const [me, c, settings] = await Promise.all([client.getMe(), client.getConnections(), client.getSettings().catch(() => null)]);
      setData({ me, c, publicUrl: settings?.publicUrl ?? null, loading: false, error: null });
    } catch (e) {
      if (e instanceof SignInRequired) { store.signedOut(); return; }
      setData((d) => ({ ...d, loading: false, error: messageOf(e) }));
    }
  }, [client, store]);
  useEffect(() => { void reload(); }, [reload]);

  const actions = useMemo(() => {
    const act = async (run: (key: string) => Promise<ConnectionChange>): Promise<ActOutcome> => {
      try {
        const r = await run(newKey());
        setData((d) => ({ ...d, c: r.connections }));
        return { ok: true, message: r.message };
      } catch (e) {
        if (e instanceof SignInRequired) { store.signedOut(); return { ok: false, message: e.message }; }
        return { ok: false, message: messageOf(e) };
      }
    };
    return {
      /** look again (a sign-in finishing on the provider's page); null when it couldn't */
      refresh: async (): Promise<Connections | null> => {
        try { const c = await client.getConnections(); setData((d) => ({ ...d, c })); return c; } catch { return null; }
      },
      start: async (provider: 'google' | 'outlook', o: { method?: 'browser' | 'code'; readOnly?: boolean } = {}): Promise<{ ok: true; start: ConnectStart } | { ok: false; message: string }> => {
        try { return { ok: true, start: await client.connectAccount(provider, { key: newKey(), ...o }) }; }
        catch (e) { if (e instanceof SignInRequired) store.signedOut(); return { ok: false, message: messageOf(e) }; }
      },
      /** Cancel: the server stops waiting too, so a code finished later connects nothing */
      cancel: async (provider: 'google' | 'outlook'): Promise<void> => { try { await client.cancelConnect(provider, { key: newKey() }); } catch (e) { if (e instanceof SignInRequired) store.signedOut(); } },
      appPassword: (address: string, password: string) => act((k) => client.connectGmailAppPassword(address, password, { key: k })),
      saveGoogleApp: (id: string, secret: string) => act((k) => client.saveGoogleApp(id, secret, { key: k })),
      saveOutlookApp: (id: string, tenant?: string) => act((k) => client.saveOutlookApp(id, tenant, { key: k })),
      saveTelegram: (token: string) => act((k) => client.saveTelegram(token, { key: k })),
      saveTailscale: (key: string, hostname?: string) => act((k) => client.saveTailscale(key, hostname, { key: k })),
      disconnect: (s: ConnTarget) => act((k) => client.disconnect(s, { key: k })),
    };
  }, [client, store]);

  return { ...data, admin: isAdmin(data.me), reload, ...actions };
}
