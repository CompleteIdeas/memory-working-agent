/**
 * Today in the v2 store (v2 build, slice W2): the Today composite (GET /today), kept on the device and kept current.
 * Plain TypeScript (no React), owned by the V2Store (`store.today`) and bound to React by ./today-react.ts.
 *
 *   load       GET /today. The answer is kept in IndexedDB (`today` store, key `today`), so the app opens on the last
 *              known Today ("updated 9:10") even offline.
 *   refetch    on the stream's data-less "today changed" notice (coalesced), when the store (re)connects (which also
 *              covers `online`), and when the window gets the focus or becomes visible again.
 *   seen       once a Today the SERVER sent this session, for the person's current day, has been on screen (and the
 *              page visible) for 2 s — never while loading, after an error, or on a cached or yesterday's Today:
 *              POST /today/seen with `seenAt` = that Today's `now`. "Done for you" then lists only what comes after —
 *              but the lines the person was just reading stay on screen until they leave Today.
 *   check-in / wrap  "Done — show my day" and "Good night" go through the store's outbox with the `day` they dismiss
 *              (a tap queued yesterday is dropped here and ignored by the server). The card goes at once; if the
 *              server refuses, it comes back; after a reload, a tap still waiting in the outbox keeps it gone.
 *
 * Plus the pure helpers the screen renders with (unit-tested): freshness notes, the person's date, trust parts. The
 * screen never parses quotes out of a string: the server sends each line as parts (`{text, outside}`).
 */
import { NetworkError, newKey, type MwaClient, type Schemas, type Today, type TodayAck } from '../api/client';
import type { CacheDb } from './cache';
import type { ActResult, ActionArgs, OutboxEntry, StoreEnv } from './core';

export type TodayNeed = Schemas['TodayNeed'];
export type TodayDone = Schemas['TodayDone'];
export type TodayEvent = Schemas['TodayEvent'];
export type TodayOpen = Schemas['TodayOpen'];
export type Freshness = Today['freshness']['calendar'];
export type Part = Schemas['TodayPart'];

export interface TodayState {
  doc: Today | null;
  /** a GET /today answered at least once (or the cache had one) */
  loaded: boolean;
  loading: boolean;
  /** the server has no /today (an older helper) */
  unsupported: boolean;
  error: string | null;
  /** when this device last got Today from the server (ms) */
  fetchedAt: number | null;
  /** `doc` came from the server in this session (not the device's cache): only such a Today can be marked seen */
  fresh: boolean;
  /** "Done — show my day" tapped for this local date (the card goes at once) */
  checkinDoneFor: string | null;
  /** the line shown in its place: the server's receipt, or ours while it waits to be sent */
  checkinMessage: string | null;
  wrapDoneFor: string | null;
  wrapMessage: string | null;
  /** Done-for-you lines that were on screen when Today was marked seen: kept until the person leaves Today */
  kept: TodayDone[];
}

export interface TodayFeedOptions {
  client: MwaClient;
  cache: CacheDb;
  env: StoreEnv;
  now: () => number;
  /** the store's act(): writes go through its outbox */
  act: (kind: 'today.checkin' | 'today.wrap', label: string, args: ActionArgs) => Promise<ActResult>;
  /** whether the server says it has /today (null: not known yet) */
  supported: () => boolean | null;
  /** window focus (the browser's by default) */
  onFocus?: (fn: () => void) => () => void;
  /** how long Today must be on screen before it counts as seen (ms) */
  seenAfterMs?: number;
  /** a burst of "today changed" notices becomes one GET (ms) */
  coalesceMs?: number;
}

export const SEEN_AFTER_MS = 2_000;
const initial = (): TodayState => ({
  doc: null, loaded: false, loading: false, unsupported: false, error: null, fetchedAt: null, fresh: false,
  checkinDoneFor: null, checkinMessage: null, wrapDoneFor: null, wrapMessage: null, kept: [],
});

function browserFocus(fn: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('focus', fn);
  return () => window.removeEventListener('focus', fn);
}

export class TodayFeed {
  private s: TodayState = initial();
  private listeners = new Set<() => void>();
  private unsubs: (() => void)[] = [];
  private inflight: Promise<void> | null = null;
  private again = false;
  private noticeTimer: unknown = null;
  private seenTimer: unknown = null;
  private onScreen = false;
  private lastFocusLoad = 0;
  private started = false;

  constructor(private o: TodayFeedOptions) {}

  getState = (): TodayState => this.s;
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private set(p: Partial<TodayState>) { this.s = { ...this.s, ...p }; for (const l of [...this.listeners]) l(); }

  /** The cached Today first, then follow focus and visibility. The store loads it from the server when it connects. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      const [doc] = await this.o.cache.all<Today>('today');
      const fetchedAt = await this.o.cache.getMeta<number>('todayAt');
      // the server's answer may have landed while the cache was being read: never go back to the older one
      if (doc && !this.s.doc) this.set({ doc, loaded: true, fetchedAt: fetchedAt ?? doc.now });
    } catch { /* no cache: the first load fills it */ }
    if (!this.started) return;
    const again = () => { if (Date.now() - this.lastFocusLoad < 1_000) return; this.lastFocusLoad = Date.now(); void this.load(); };
    this.unsubs.push((this.o.onFocus ?? browserFocus)(again), this.o.env.on('visible', () => { again(); this.armSeen(); }));
  }

  stop(): void {
    this.started = false;
    this.again = false;
    for (const u of this.unsubs.splice(0)) u();
    if (this.noticeTimer) { this.o.env.clearTimeout(this.noticeTimer); this.noticeTimer = null; }
    this.disarmSeen();
  }

  /** The stream said Today changed: GET it again (a burst of notices is one GET). */
  changed(): void {
    if (!this.started || this.noticeTimer) return;
    this.noticeTimer = this.o.env.setTimeout(() => { this.noticeTimer = null; void this.load(); }, this.o.coalesceMs ?? 300);
  }

  /** GET /today (one at a time; a call made meanwhile runs once more after it). Offline: the cached one stays. */
  load(): Promise<void> {
    if (!this.started) return Promise.resolve();
    if (this.o.supported() === false) { if (!this.s.unsupported) this.set({ unsupported: true, loaded: true }); return Promise.resolve(); }
    if (this.inflight) { this.again = true; return this.inflight; }
    this.inflight = (async () => {
      try {
        do {
          this.again = false;
          this.set({ loading: true });
          try {
            const doc = await this.o.client.getToday();
            this.apply(doc);
          } catch (e) {
            // offline or refused: what is on screen stays (the shell says offline / sign in / reload)
            this.set({ loading: false, loaded: true, error: e instanceof NetworkError ? null : e instanceof Error ? e.message : 'Could not load Today.' });
            break;
          }
        } while (this.again && this.started);
      } finally { this.inflight = null; if (this.s.loading) this.set({ loading: false }); }
    })();
    return this.inflight;
  }

  /** A Today from the server (GET, an ack, a /sync document). An older one never replaces a newer one. */
  apply(doc: Today | null | undefined): void {
    if (!doc) return;
    const cur = this.s.doc;
    if (cur && doc.now < cur.now) return;
    const fetchedAt = this.o.now();
    const patch: Partial<TodayState> = { doc, loaded: true, loading: false, error: null, fetchedAt, unsupported: false, fresh: true };
    // a new day: yesterday's dismissals and kept lines no longer apply
    if (cur && cur.date !== doc.date) Object.assign(patch, { checkinDoneFor: null, checkinMessage: null, wrapDoneFor: null, wrapMessage: null, kept: [] });
    this.set(patch);
    if (this.onScreen && !this.seenTimer) this.armSeen(); // a Today on screen now: it can count as seen
    void this.o.cache.replace('today', [{ key: 'today', value: doc }]).then(() => this.o.cache.setMeta({ todayAt: fetchedAt })).catch(() => {});
  }

  // ---------- "I looked" ----------
  /** The Today screen is on screen (true) or left (false). Seen is marked after it has been visible for 2 s. */
  viewing(on: boolean): void {
    this.onScreen = on;
    if (on) this.armSeen();
    else { this.disarmSeen(); if (this.s.kept.length) this.set({ kept: [] }); }
  }
  /** What is on screen can count as seen: a Today from the server this session, for the person's current day, no
   *  error over it, the page visible (W2 review M1: not while loading, not an error, not a stale cache). */
  private seeable(): boolean {
    const st = this.s, doc = st.doc;
    return this.onScreen && this.o.env.visible() && !!doc && st.fresh && !st.error && doc.date === dateIn(this.o.now(), doc.tz);
  }
  private armSeen() {
    this.disarmSeen();
    if (!this.seeable()) return;
    this.seenTimer = this.o.env.setTimeout(() => { this.seenTimer = null; void this.markSeen(); }, this.o.seenAfterMs ?? SEEN_AFTER_MS);
  }
  private disarmSeen() { if (this.seenTimer) { this.o.env.clearTimeout(this.seenTimer); this.seenTimer = null; } }

  /** POST /today/seen. What was being read stays on screen; a failure (offline) is quiet: it is only a bookmark. */
  async markSeen(): Promise<void> {
    if (!this.seeable() || this.o.supported() === false) return;
    const doc = this.s.doc!;
    if (doc.doneForYou.length) this.set({ kept: mergeDone(this.s.kept, doc.doneForYou) });
    // the Today that was looked at, not the clock now: what arrived since it was fetched is still "new"
    try { await this.o.client.markTodaySeen({ seenAt: doc.now }, { key: newKey(this.o.now()) }); } catch { /* next time */ }
  }

  // ---------- the check-in and the wrap ----------
  finishCheckin(): Promise<ActResult> { return this.finish('checkin'); }
  finishWrap(): Promise<ActResult> { return this.finish('wrap'); }

  /** The person's current day: in their zone (the Today's `tz`), else this device's. */
  currentDay(): string {
    const doc = this.s.doc;
    return doc ? dateIn(this.o.now(), doc.tz) : localDateOf(this.o.now());
  }

  /** After a reload: a check-in or wrap tap still waiting in the outbox keeps its card gone (W2 review M3). */
  adoptOutbox(outbox: OutboxEntry[]): void {
    const patch: Partial<TodayState> = {};
    for (const e of outbox) {
      if (!e.args.day) continue;
      if (e.kind === 'today.checkin') Object.assign(patch, { checkinDoneFor: e.args.day, checkinMessage: 'Morning check-in done.' });
      if (e.kind === 'today.wrap') Object.assign(patch, { wrapDoneFor: e.args.day, wrapMessage: 'See you in the morning.' });
    }
    if (Object.keys(patch).length) this.set(patch);
  }

  private async finish(what: 'checkin' | 'wrap'): Promise<ActResult> {
    const date = this.s.doc ? this.currentDay() : null;
    const local = what === 'checkin' ? `Morning check-in done.${this.s.doc ? ` Have a good ${this.s.doc.weekday}.` : ''}` : 'See you in the morning.';
    const keys = what === 'checkin' ? (['checkinDoneFor', 'checkinMessage'] as const) : (['wrapDoneFor', 'wrapMessage'] as const);
    this.set({ [keys[0]]: date, [keys[1]]: local } as Partial<TodayState>);
    const r = await this.o.act(what === 'checkin' ? 'today.checkin' : 'today.wrap', what === 'checkin' ? 'Done — show my day' : 'Good night', date ? { day: date } : {});
    if (r.ok) {
      const ack = r.data as TodayAck | undefined;
      if (ack?.message) this.set({ [keys[1]]: ack.message } as Partial<TodayState>);
    } else if (!r.queued) {
      // refused: the card comes back (the store already said why)
      this.set({ [keys[0]]: null, [keys[1]]: null } as Partial<TodayState>);
    }
    return r;
  }
}

// ---------- pure helpers (tests/web-v2-today.test.ts) ----------

/** Lines kept on screen plus the server's, newest first, each once. */
export function mergeDone(kept: TodayDone[], fresh: TodayDone[]): TodayDone[] {
  const by = new Map<string, TodayDone>();
  for (const d of [...kept, ...fresh]) by.set(d.id, d);
  return [...by.values()].sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));
}

export interface TodayView {
  doc: Today;
  checkin: Today['checkin'];
  checkinBanner: string | null;
  wrap: Today['wrap'];
  wrapBanner: string | null;
  done: TodayDone[];
  doneMore: number;
  /** the doc is from another day (the cache, while the helper can't be reached) */
  staleDay: boolean;
  calendar: CalendarFreshnessView;
  mailNote: string | null;
}

/** What the screen shows: the server's Today with this device's pending taps and kept lines laid over it. `now` is
 *  read in the person's zone (the Today's `tz`): a phone abroad still knows which day the Today is for. */
export function todayView(st: TodayState, now: number): TodayView | null {
  const doc = st.doc;
  if (!doc) return null;
  const today = dateIn(now, doc.tz);
  const checkinDone = st.checkinDoneFor !== null && st.checkinDoneFor === doc.date;
  const wrapDone = st.wrapDoneFor !== null && st.wrapDoneFor === doc.date;
  const done = st.kept.length ? mergeDone(st.kept, doc.doneForYou) : doc.doneForYou;
  return {
    doc,
    checkin: checkinDone ? null : doc.checkin,
    checkinBanner: checkinDone ? st.checkinMessage : null,
    wrap: wrapDone ? null : doc.wrap,
    wrapBanner: wrapDone ? st.wrapMessage : null,
    done: done.slice(0, 3),
    doneMore: doc.doneMore + Math.max(0, done.length - 3),
    staleDay: doc.date !== today,
    calendar: calendarFreshness(doc),
    mailNote: doc.freshness.mail === 'ok' ? null : doc.freshness.mailNote,
  };
}

export interface CalendarFreshnessView {
  state: Freshness;
  /** say this (never "Nothing else today") */
  note: string | null;
  /** the day is known well enough to list what's next (partial, stale and reconnect still show what is known) */
  showEvents: boolean;
  /** "Nothing else today" may be said: the whole day is known */
  canSayFree: boolean;
  /** a way out: connect a calendar, or sign in to one again */
  offer: 'connect' | 'reconnect' | null;
}

/** The honest calendar line for Today: an unknown day is never shown as a free one. */
export function calendarFreshness(doc: Pick<Today, 'freshness'>): CalendarFreshnessView {
  const f = doc.freshness;
  const fallback: Record<Freshness, string | null> = {
    ok: null,
    stale: 'Your calendar hasn’t updated for a while.',
    partial: 'One of your calendars hasn’t synced yet, so your day may be missing things.',
    not_synced: 'Your calendar hasn’t synced yet, so I can’t tell what’s next. That doesn’t mean your day is free.',
    reconnect: 'Your calendar needs to be reconnected, so your day may be out of date.',
    not_connected: 'Your calendar isn’t connected, so I can’t show what’s next.',
  };
  const state = f.calendar;
  return {
    state,
    note: state === 'ok' ? null : f.calendarNote ?? fallback[state],
    showEvents: state !== 'not_connected' && state !== 'not_synced',
    canSayFree: state === 'ok',
    offer: state === 'not_connected' ? 'connect' : state === 'reconnect' ? 'reconnect' : null,
  };
}

/**
 * A line's parts, for rendering. The server sends them (`parts`, `titleParts`, `textParts`, `lineParts`): outside words
 * are marked there and carry no quote marks, so nothing can close a quote and speak as the helper. The screen NEVER
 * parses quotes out of the flat text (W2 review). The server's parts are authoritative (a wrap's first line is the
 * helper's own words though the wrap quotes a title). Without parts (an older server, an older cached Today), an
 * untrusted line is outside words as a whole, with a "From outside:" lead-in (`lead`); a trusted one is the helper's.
 */
export function partsOf(text: string, parts: Part[] | undefined | null, trust: 'trusted' | 'untrusted'): { parts: Part[]; lead: boolean } {
  if (parts && parts.length) return { parts, lead: false };
  return { parts: [{ text, outside: trust === 'untrusted' }], lead: trust === 'untrusted' };
}

/** The date (YYYY-MM-DD) of an instant in an IANA zone (this device's when the zone is unknown). */
export function dateIn(ms: number, tz: string | null | undefined): string {
  if (tz) {
    try {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(ms).map((x) => [x.type, x.value]));
      return `${p.year}-${p.month}-${p.day}`;
    } catch { /* an unknown zone: this device's */ }
  }
  return localDateOf(ms);
}

/** The local date (YYYY-MM-DD) of an instant on this device. */
export function localDateOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
