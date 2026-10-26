/**
 * Calendar sync, orchestrated (v2 build, slice A7, 2026-10-26).
 *
 * syncCalendar(provider) runs one connected calendar's sync (Google: src/sync/google-calendar.ts, Outlook:
 * src/sync/outlook-calendar.ts) over the window — yesterday through 14 days ahead, in the person's zone, with real
 * calendar-day boundaries (a 23- or 25-hour day across a clock change) — and records the outcome in sync_state. It
 * never throws: a revoked sign-in (invalid_grant, 401, a missing permission) sets needs_reconnect and last_error;
 * anything else sets last_error and the next tick tries again. No model calls.
 *
 * Accounts are keyed by the signed-in address ('google:me@example.com'; 'google' for a sign-in made before addresses
 * were kept). Rows cached under another key for the same provider belong to a sign-in that was replaced: refresh()
 * clears them.
 *
 * refresh() syncs every connected calendar (one at a time; concurrent callers share the run) and forgets old
 * confirmed/removed drafts — the app calls it when it opens (POST /api/v1/calendar/refresh). startCalendarSync() runs
 * it every 30 minutes in serve.
 */
import { syncGoogleCalendar, type CalWindow, type SyncResult } from './google-calendar.js';
import { syncOutlookCalendar } from './outlook-calendar.js';
import { setSyncState, syncStates, clearCalAccount, pruneOldDrafts, providerOfAccount, type CalProvider } from '../v2/calendar.js';
import { appDb } from '../v2/db.js';
import { localTz, localDate, addDays, localMidnight, iso } from './tz.js';
import { reconnectNeeded, shortError } from './errors.js';
import { calendarSyncOn } from './flags.js';
import { calendarClient, googleConfigured, googleAccountKey } from '../connectors/google.js';
import { graph, microsoftConfigured, outlookAccountKey } from '../connectors/microsoft.js';
import { logger } from '../logger.js';

export const CALENDAR_PROVIDERS: { provider: CalProvider; label: string }[] = [
  { provider: 'google', label: 'Google Calendar' },
  { provider: 'outlook', label: 'Outlook' },
];
export const SYNC_EVERY_MS = 30 * 60_000;
export const WINDOW_BACK_DAYS = 1, WINDOW_AHEAD_DAYS = 14;

export interface CalendarSyncDeps {
  connected: (provider: CalProvider) => boolean;
  /** the cache's account key for a provider's current sign-in */
  accountKey: (provider: CalProvider) => string;
  google: typeof calendarClient;
  graph: typeof graph;
  now: () => number;
  tz: () => string;
}
const DEFAULT_DEPS: CalendarSyncDeps = {
  connected: (p) => (p === 'google' ? googleConfigured() : microsoftConfigured()),
  accountKey: (p) => (p === 'google' ? googleAccountKey() : outlookAccountKey()),
  google: calendarClient, graph, now: Date.now, tz: () => localTz(),
};
let deps: CalendarSyncDeps = DEFAULT_DEPS;
/** Tests: replace parts (a fake clock, a zone). Pass null to restore the defaults. */
export function setCalendarSyncDeps(d: Partial<CalendarSyncDeps> | null): void { deps = d ? { ...DEFAULT_DEPS, ...d } : DEFAULT_DEPS; }

/** The clock and zone the calendar uses (the list_events tool and the API read them too). */
export const calendarNow = (): number => deps.now();
export const calendarTz = (): string => deps.tz();
/** The account key a provider's events are cached under now. */
export const calendarAccountKey = (p: CalProvider): string => deps.accountKey(p);
export const calendarConnected = (p: CalProvider): boolean => deps.connected(p);

/** Local midnight starting the day that holds `now` (a real calendar day in the zone, not now minus 24 h). */
export function todayStart(now = deps.now(), tz = deps.tz()): number {
  return localMidnight(localDate(now, tz), tz);
}

/** Yesterday 00:00 through the end of the 14th day ahead, in the person's zone. */
export function calendarWindow(now = deps.now(), tz = deps.tz()): CalWindow {
  const today = localDate(now, tz);
  const fromMs = localMidnight(addDays(today, -WINDOW_BACK_DAYS), tz), toMs = localMidnight(addDays(today, WINDOW_AHEAD_DAYS + 1), tz);
  return { from: iso(fromMs), to: iso(toMs), fromMs, toMs };
}

export interface AccountOutcome { account: string; provider: CalProvider; ok: boolean; result?: SyncResult; error?: string; needsReconnect?: boolean; skipped?: 'not_connected' }

/** One provider's sync (under its current account key). Never throws. */
export async function syncCalendar(provider: CalProvider): Promise<AccountOutcome> {
  if (!deps.connected(provider)) return { account: provider, provider, ok: false, skipped: 'not_connected' };
  let account: string = provider;
  try {
    account = deps.accountKey(provider);
    const window = calendarWindow();
    const result = provider === 'google'
      ? await syncGoogleCalendar({ calendar: () => deps.google(), window, tz: deps.tz(), account })
      : await syncOutlookCalendar({ graph: deps.graph, window, tz: deps.tz(), account });
    // a listing cut short keeps the note it left in last_error; otherwise a success clears the errors
    setSyncState(account, 'calendar', { last_ok: deps.now(), needs_reconnect: 0, ...(result.truncated ? {} : { last_error: null }) });
    return { account, provider, ok: true, result };
  } catch (e) {
    const again = reconnectNeeded(e), error = shortError(e);
    try {
      setSyncState(account, 'calendar', { last_error: error, ...(again ? { needs_reconnect: 1 } : {}) });
    } catch { /* the database is busy: the next tick records it */ }
    logger.warn('calendar', 'sync failed', { account, error, needsReconnect: again });
    return { account, provider, ok: false, error, needsReconnect: again };
  }
}

/** Calendar rows (events, sync state) kept for `provider` under any key but `keep`: a replaced or gone sign-in's. */
function clearOtherAccounts(provider: CalProvider, keep: string | null): void {
  const d = appDb();
  const keys = new Set<string>([
    ...(d.prepare('SELECT DISTINCT account FROM cal_events WHERE provider = ?').all(provider) as { account: string }[]).map((r) => r.account),
    ...syncStates('calendar').map((s) => s.account).filter((a) => providerOfAccount(a) === provider),
  ]);
  for (const k of keys) {
    if (k === keep) continue;
    d.transaction(() => {
      clearCalAccount(k, d);
      d.prepare(`DELETE FROM sync_state WHERE account = ? AND resource = 'calendar'`).run(k);
    })();
  }
}

let running: Promise<AccountOutcome[]> | null = null;

/** Sync every connected calendar now. Concurrent calls share one run. A disconnected or replaced sign-in's cache is cleared. */
export function refresh(): Promise<AccountOutcome[]> {
  if (running) return running;
  running = (async () => {
    const out: AccountOutcome[] = [];
    try { pruneOldDrafts(deps.now()); } catch { /* next time */ }
    for (const { provider } of CALENDAR_PROVIDERS) {
      const connected = deps.connected(provider);
      try { clearOtherAccounts(provider, connected ? deps.accountKey(provider) : null); } catch { /* next time */ }
      if (!connected) { out.push({ account: provider, provider, ok: false, skipped: 'not_connected' }); continue; }
      out.push(await syncCalendar(provider));
    }
    return out;
  })().finally(() => { running = null; });
  return running;
}

/** Which calendars are connected and whether one needs signing in again (GET /calendar/accounts). */
export function calendarAccounts() {
  const states = new Map(syncStates('calendar').map((s) => [s.account, s]));
  return CALENDAR_PROVIDERS.map(({ provider, label }) => {
    const connected = deps.connected(provider);
    const account = connected ? deps.accountKey(provider) : provider;
    const s = states.get(account);
    return {
      account, provider, label, connected,
      needsReconnect: connected && s?.needs_reconnect === 1,
      lastOk: s?.last_ok ?? null, lastError: connected ? s?.last_error ?? null : null,
    };
  });
}

/** serve: sync shortly after start, then every 30 minutes. Returns a stop function. MWA_CALENDAR_SYNC=0 turns it off. */
export function startCalendarSync(opts: { everyMs?: number; firstAfterMs?: number } = {}): () => void {
  if (!calendarSyncOn()) return () => {};
  const tick = () => { void refresh().catch((e) => logger.warn('calendar', 'refresh failed', { error: shortError(e) })); };
  const first = setTimeout(tick, opts.firstAfterMs ?? 5_000);
  const every = setInterval(tick, opts.everyMs ?? SYNC_EVERY_MS);
  first.unref?.(); every.unref?.();
  return () => { clearTimeout(first); clearInterval(every); };
}
