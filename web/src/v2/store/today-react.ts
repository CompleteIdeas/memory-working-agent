/**
 * React hooks for Today and the Calendar (v2 build, slice W2), beside ./react.tsx:
 *
 *   useToday()             the Today composite (cached, refetched on the stream's notice, focus and online), what the
 *                          screen shows (todayView), and its taps: check-in done, wrap done, reload, viewing (seen).
 *   useDraftActions()      Confirm / Remove a calendar draft, shown at once (optimistic, rolled back if refused),
 *                          and the last receipt; queued taps are cleared once their action has left the outbox.
 *   useCalendarAccounts()  which calendars are connected and how fresh they are (GET /calendar/accounts), Refresh.
 *   useSpeech()            "Read it to me": the browser's speechSynthesis, with a stop; `supported` false hides it.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useStore, useNow } from './react';
import { todayView } from './today';
import { PendingDrafts, calendarHonesty, type CalendarAccount } from './calendar-ops';
import type { V2Store } from './core';
import type { CalendarItem } from '../api/client';

export function useToday() {
  const store = useStore();
  const st = useSyncExternalStore(store.today.subscribe, store.today.getState);
  const now = useNow();
  const view = useMemo(() => todayView(st, now), [st, now]);
  return {
    state: st,
    view,
    finishCheckin: () => store.today.finishCheckin(),
    finishWrap: () => store.today.finishWrap(),
    reload: () => store.today.load(),
    viewing: (on: boolean) => store.today.viewing(on),
  };
}

const pendings = new WeakMap<V2Store, PendingDrafts>();
function pendingFor(store: V2Store): PendingDrafts {
  let p = pendings.get(store);
  if (!p) { p = new PendingDrafts(); pendings.set(store, p); }
  return p;
}

export function useDraftActions() {
  const store = useStore();
  const p = pendingFor(store);
  const st = useSyncExternalStore(p.subscribe, p.getState);
  const outbox = useSyncExternalStore(store.subscribe, () => store.getState().outbox);
  useEffect(() => { p.reconcile(outbox); }, [p, outbox]);
  return {
    ops: st.ops,
    receipt: st.receipt,
    confirm: (i: CalendarItem) => p.run(store, 'confirm', i, store.now()),
    remove: (i: CalendarItem) => p.run(store, 'remove', i, store.now()),
    clearReceipt: () => p.clearReceipt(),
  };
}

export function useCalendarAccounts() {
  const store = useStore();
  const connection = useSyncExternalStore(store.subscribe, () => store.getState().connection);
  const [accounts, setAccounts] = useState<CalendarAccount[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (connection !== 'live') return;
    let on = true;
    store.client.getCalendarAccounts().then((r) => { if (on) { setAccounts(r.accounts); setError(null); } }, (e) => { if (on) setError(e instanceof Error ? e.message : 'Could not check your calendars.'); });
    return () => { on = false; };
  }, [store, connection]);
  const refresh = useCallback(async (window?: { from: string; to: string }) => {
    setRefreshing(true);
    try {
      const r = await store.client.refreshCalendar();
      setAccounts(r.accounts);
      setError(null);
      const failed = (r.results ?? []).filter((x) => !x.ok && !x.skipped);
      if (window) await store.loadCalendar(window.from, window.to);
      void store.today.load();
      return failed.length ? `Couldn’t update ${failed.length === 1 ? 'one calendar' : `${failed.length} calendars`}: ${failed[0].error ?? 'try again in a moment.'}` : 'Your calendar is up to date.';
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Could not refresh.';
      setError(m);
      return m;
    } finally { setRefreshing(false); }
  }, [store]);
  const now = useNow();
  const honesty = useMemo(() => calendarHonesty(accounts, now), [accounts, now]);
  return { accounts, honesty, refresh, refreshing, error };
}

export function useSpeech() {
  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function';
  const [speaking, setSpeaking] = useState(false);
  useEffect(() => () => { if (supported) { try { window.speechSynthesis.cancel(); } catch { /* */ } } }, [supported]);
  const speak = useCallback((text: string) => {
    if (!supported) return;
    try {
      window.speechSynthesis.cancel();
      const u = new window.SpeechSynthesisUtterance(text);
      u.onend = () => setSpeaking(false);
      u.onerror = () => setSpeaking(false);
      setSpeaking(true);
      window.speechSynthesis.speak(u);
    } catch { setSpeaking(false); }
  }, [supported]);
  const stop = useCallback(() => { if (supported) { try { window.speechSynthesis.cancel(); } catch { /* */ } } setSpeaking(false); }, [supported]);
  return { supported, speaking, speak, stop };
}
