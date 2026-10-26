/**
 * Calendar sync, orchestrated (v2 build, slice A7, 2026-10-26).
 *
 * syncCalendar(account) runs one account's sync (Google: src/sync/google-calendar.ts, Outlook:
 * src/sync/outlook-calendar.ts) over the window — yesterday through 14 days ahead, in the person's zone — and
 * records the outcome in sync_state. It never throws: a revoked sign-in (invalid_grant, 401, a missing permission)
 * sets needs_reconnect and last_error; anything else sets last_error and the next tick tries again. No model calls.
 *
 * refresh() syncs every connected account (one at a time; concurrent callers share the run) — the app calls it when
 * it opens (POST /api/v1/calendar/refresh). startCalendarSync() runs it every 30 minutes in serve.
 */
import { syncGoogleCalendar, GOOGLE_ACCOUNT, type CalWindow, type SyncResult } from './google-calendar.js';
import { syncOutlookCalendar, OUTLOOK_ACCOUNT } from './outlook-calendar.js';
import { getSyncState, setSyncState, syncStates, clearCalAccount, type CalProvider } from '../v2/calendar.js';
import { localTz, localDate, addDays, localMidnight, iso } from './tz.js';
import { reconnectNeeded, shortError } from './errors.js';
import { calendarClient, googleConfigured } from '../connectors/google.js';
import { graph, microsoftConfigured } from '../connectors/microsoft.js';
import { logger } from '../logger.js';

export const CALENDAR_ACCOUNTS: { account: string; provider: CalProvider; label: string }[] = [
  { account: GOOGLE_ACCOUNT, provider: 'google', label: 'Google Calendar' },
  { account: OUTLOOK_ACCOUNT, provider: 'outlook', label: 'Outlook' },
];
export const SYNC_EVERY_MS = 30 * 60_000;
export const WINDOW_BACK_DAYS = 1, WINDOW_AHEAD_DAYS = 14;

export interface CalendarSyncDeps {
  connected: (provider: CalProvider) => boolean;
  google: typeof calendarClient;
  graph: typeof graph;
  now: () => number;
  tz: () => string;
}
const DEFAULT_DEPS: CalendarSyncDeps = {
  connected: (p) => (p === 'google' ? googleConfigured() : microsoftConfigured()),
  google: calendarClient, graph, now: Date.now, tz: () => localTz(),
};
let deps: CalendarSyncDeps = DEFAULT_DEPS;
/** Tests: replace parts (a fake clock, a zone). Pass null to restore the defaults. */
export function setCalendarSyncDeps(d: Partial<CalendarSyncDeps> | null): void { deps = d ? { ...DEFAULT_DEPS, ...d } : DEFAULT_DEPS; }

/** Yesterday 00:00 through the end of the 14th day ahead, in the person's zone. */
export function calendarWindow(now = deps.now(), tz = deps.tz()): CalWindow {
  const today = localDate(now, tz);
  const fromMs = localMidnight(addDays(today, -WINDOW_BACK_DAYS), tz), toMs = localMidnight(addDays(today, WINDOW_AHEAD_DAYS + 1), tz);
  return { from: iso(fromMs), to: iso(toMs), fromMs, toMs };
}

export interface AccountOutcome { account: string; ok: boolean; result?: SyncResult; error?: string; needsReconnect?: boolean; skipped?: 'not_connected' }

/** One account's sync. Never throws. */
export async function syncCalendar(account: string): Promise<AccountOutcome> {
  const a = CALENDAR_ACCOUNTS.find((x) => x.account === account);
  if (!a) return { account, ok: false, error: 'unknown account' };
  if (!deps.connected(a.provider)) return { account, ok: false, skipped: 'not_connected' };
  const window = calendarWindow();
  try {
    const result = a.provider === 'google'
      ? await syncGoogleCalendar({ calendar: () => deps.google(), window, tz: deps.tz() })
      : await syncOutlookCalendar({ graph: deps.graph, window, tz: deps.tz() });
    setSyncState(account, 'calendar', { last_ok: deps.now(), last_error: null, needs_reconnect: 0 });
    return { account, ok: true, result };
  } catch (e) {
    const again = reconnectNeeded(e), error = shortError(e);
    try {
      setSyncState(account, 'calendar', { last_error: error, ...(again ? { needs_reconnect: 1 } : {}) });
    } catch { /* the database is busy: the next tick records it */ }
    logger.warn('calendar', 'sync failed', { account, error, needsReconnect: again });
    return { account, ok: false, error, needsReconnect: again };
  }
}

let running: Promise<AccountOutcome[]> | null = null;

/** Sync every connected calendar now. Concurrent calls share one run. A disconnected account's cache is cleared. */
export function refresh(): Promise<AccountOutcome[]> {
  if (running) return running;
  running = (async () => {
    const out: AccountOutcome[] = [];
    for (const a of CALENDAR_ACCOUNTS) {
      if (!deps.connected(a.provider)) {
        // signed out: what MWA cached from that calendar goes too
        if (getSyncState(a.account, 'calendar')) {
          try { clearCalAccount(a.account); setSyncState(a.account, 'calendar', { cursor: null, window_from: null, window_to: null, needs_reconnect: 0, last_error: null }); } catch { /* next time */ }
        }
        out.push({ account: a.account, ok: false, skipped: 'not_connected' });
        continue;
      }
      out.push(await syncCalendar(a.account));
    }
    return out;
  })().finally(() => { running = null; });
  return running;
}

/** Which calendars are connected and whether one needs signing in again (GET /calendar/accounts). */
export function calendarAccounts() {
  const states = new Map(syncStates('calendar').map((s) => [s.account, s]));
  return CALENDAR_ACCOUNTS.map((a) => {
    const s = states.get(a.account);
    const connected = deps.connected(a.provider);
    return {
      account: a.account, provider: a.provider, label: a.label, connected,
      needsReconnect: connected && s?.needs_reconnect === 1,
      lastOk: s?.last_ok ?? null, lastError: connected ? s?.last_error ?? null : null,
    };
  });
}

/** serve: sync shortly after start, then every 30 minutes. Returns a stop function. MWA_CALENDAR_SYNC=0 turns it off. */
export function startCalendarSync(opts: { everyMs?: number; firstAfterMs?: number } = {}): () => void {
  if (process.env.MWA_CALENDAR_SYNC === '0') return () => {};
  const tick = () => { void refresh().catch((e) => logger.warn('calendar', 'refresh failed', { error: shortError(e) })); };
  const first = setTimeout(tick, opts.firstAfterMs ?? 5_000);
  const every = setInterval(tick, opts.everyMs ?? SYNC_EVERY_MS);
  first.unref?.(); every.unref?.();
  return () => { clearTimeout(first); clearInterval(every); };
}
