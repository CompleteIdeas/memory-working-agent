/**
 * The v2 store (v2 build, slice W1): one place that holds what the screens show, kept current by the live stream,
 * cached on the device, with an outbox for actions made offline. Plain TypeScript (no React) so it is unit-tested
 * in node with fakes; ./react.tsx binds it to hooks.
 *
 * How it stays current:
 *   1. open: the cache (IndexedDB) is read first, so the app shows the last known state at once ("updated 9:10").
 *   2. catch-up: GET /sync?since=<cursor>, page after page while `more` is true. No cursor (first run, or after a
 *      `reset`) takes a snapshot (`reset: true`) that replaces the cached collections.
 *   3. live: an EventSource on /stream?cursor=<cursor>. `change` events carry the current object; the cursor moves
 *      with each one and is saved, so a reload resumes where it stopped. The browser reconnects with Last-Event-ID by
 *      itself; on every reconnect (and on `online`) the store also catches up through /sync. `reset` (the cursor is
 *      older than the server keeps) → a fresh snapshot.
 *   4. the outbox: an action is sent at once when online; when the network fails it is queued WITH its
 *      Idempotency-Key and replayed on `online` and when the app becomes visible — the same key, so the server never
 *      does it twice. A 409 (it changed meanwhile) drops the action and shows the server's current state.
 *
 * Errors: 401 → `auth: 'signin'` (the shell asks to sign in or pair); 426 → `updateReady` ("A new version is
 * ready · Reload"); 403 and other refusals → a notice with the server's own words.
 */
import {
  MwaClient, ApiError, Conflict, Forbidden, NetworkError, SignInRequired, UpdateRequired, TRANSIENT_CONFLICTS, newKey,
  type CalendarItem, type Job, type JobDetail, type MailHeader, type Meta, type Project, type SyncCollection, type SyncResult, type Turn,
  type DraftResult, type MessageSent, type Schemas, type AskBody, type AskChoice, type AskStart, type AskChosen, type TurnMoved,
  type ImportantItem, type ImportantGroup, type ImportantList, type ItemChange, type ItemActionResult, type SkippedList, type TriageRule,
} from '../api/client';
import { STORES, type CacheDb, type StoreName } from './cache';
import { TodayFeed } from './today';

export const THREAD_KEEP = 50;
/** W4: the most turns kept on a thread's earlier pages in memory; past it the oldest go, and "Earlier messages" loads
 *  the thread again from its latest page (the server's cursors are opaque, so a trimmed page cannot be resumed). */
export const OLDER_KEEP = 300;
/** The cursor that says "load the thread again, then page back" after earlier pages were trimmed. */
export const RELOAD_THREAD = '__reload__';
export const COLLECTIONS: SyncCollection[] = ['jobs', 'calendar', 'projects', 'turns'];
/** W3: the Important list's collection, asked for only when the server has it (an older one answers 400 to it). */
export const IMPORTANT_FEATURE = 'important';
const collectionsFor = (meta: Meta | null): SyncCollection[] => (meta?.features.includes(IMPORTANT_FEATURE) ? [...COLLECTIONS, 'important'] : COLLECTIONS);

// ---------- the event source and the environment, injectable for tests ----------

export interface StreamLike {
  readonly readyState: number; // 0 connecting, 1 open, 2 closed
  addEventListener(type: string, fn: (e: MessageEvent) => void): void;
  onerror: ((e: Event) => void) | null;
  close(): void;
}
export type StreamFactory = (url: string) => StreamLike;

export interface StoreEnv {
  online(): boolean;
  visible(): boolean;
  /** subscribe to 'online' | 'offline' | 'visible'; returns an unsubscribe */
  on(event: 'online' | 'offline' | 'visible', fn: () => void): () => void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(t: unknown): void;
}

export function browserEnv(): StoreEnv {
  return {
    online: () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false),
    visible: () => (typeof document === 'undefined' ? true : document.visibilityState !== 'hidden'),
    on(event, fn) {
      if (event === 'visible') {
        const h = () => { if (document.visibilityState === 'visible') fn(); };
        document.addEventListener('visibilitychange', h);
        return () => document.removeEventListener('visibilitychange', h);
      }
      window.addEventListener(event, fn);
      return () => window.removeEventListener(event, fn);
    },
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (t) => globalThis.clearTimeout(t as ReturnType<typeof setTimeout>),
  };
}

// ---------- state ----------

export type Connection = 'starting' | 'connecting' | 'live' | 'offline' | 'unreachable';
/** A notice may carry one action ("Marked handled: … · Undo"). */
export interface NoticeAction { label: string; run: () => void }
export interface Notice { id: string; text: string; tone: 'info' | 'error'; at: number; action?: NoticeAction }
export interface LiveInfo { session: string; type: string; stage: unknown; at: number }
export interface MailState { headers: MailHeader[]; note: string; connected: boolean; loaded: boolean; loading: boolean; error: string | null }
export type CalendarConflict = Schemas['CalendarConflict'];

export type ActionKind =
  | 'job.stop' | 'job.continue' | 'job.startOver' | 'job.open' | 'job.pause' | 'job.resume' | 'job.cancel'
  | 'draft.confirm' | 'draft.remove' | 'message.send'
  // W3: the Important list and the mail reader
  | 'item.handled' | 'item.unhandle' | 'item.notImportant' | 'item.action' | 'mail.important' | 'mail.draft' | 'rule.delete'
  // W4: Ask, a plan's choice, projects and their threads
  | 'ask' | 'ask.choose' | 'turn.move' | 'project.create' | 'project.update' | 'project.stop' | 'project.steer' | 'project.offer'
  // W2: Today's check-in and wrap, and a calendar draft from the person's own input
  | 'today.checkin' | 'today.wrap' | 'draft.create';
/** W2: a draft from the person's own input (POST /calendar/drafts). */
export interface DraftInput { title: string; start: string; end?: string; allDay?: boolean; location?: string; provider?: 'google' | 'outlook'; /** the zone the times were entered in (the device's) */ tz?: string }
export type NotImportantScope = 'sender' | 'domain' | 'kind';
export interface ActionArgs {
  id?: string; capUsd?: number; text?: string; provider?: 'google' | 'outlook';
  /** item.notImportant: what the filter learns (none: the server's default, the sender) */
  scope?: NotImportantScope;
  /** mail.draft: the reply's text */
  body?: string;
  /** mail.important: the skipped list it was picked from (its row leaves that list) */
  group?: ImportantGroup;
  /** draft.create (W2): the new draft */
  draft?: DraftInput;
  /** today.checkin / today.wrap (W2): the person's day the tap dismisses (a tap queued yesterday is dropped) */
  day?: string;
  /** W4: the request body of an ask (`ask`), a plan's choice (`ask.choose`), a move ({projectId}), a project's fields,
   *  the run a Stop or a note is meant for ({runId}) */
  payload?: Record<string, unknown>;
}
export interface ActOptions {
  /** the screen shows a refusal itself (the Not important sheet, a plan card): no error notice as well */
  quiet?: boolean;
}
/** W4: actions about a run happening NOW: never kept for later (a Stop sent an hour late could land on another run). */
const NOW_ONLY: ReadonlySet<ActionKind> = new Set(['project.stop', 'project.steer']);
/** P2: a plan's choice that starts paid work (Do it now / In the background, with its price and ready time) is made
 *  online only: sent hours later the plan may be old and its price wrong. A narrower ask (no price) may wait. */
export function nowOnly(kind: ActionKind, args: ActionArgs): boolean {
  if (NOW_ONLY.has(kind)) return true;
  return kind === 'ask.choose' && typeof args.payload?.mode === 'string';
}
const OFFLINE_WORDS: Partial<Record<ActionKind, string>> = {
  'project.stop': 'You’re offline — I can’t stop it from here right now.',
  'project.steer': 'You’re offline — I can’t add to it from here right now.',
  'ask.choose': 'You’re offline — choose when you’re back online, so the price and the time are still right.',
};

// ---------- the Important list (W3) ----------
export interface ImportantMeta { handledCount: number; skipped: ImportantList['skipped']; sorting: ImportantList['sorting'] }
export interface ImportantState { meta: ImportantMeta | null; loading: boolean; loaded: boolean; error: string | null }
export type SkippedRow = SkippedList['skipped'][number];
export interface SkippedState { rows: SkippedRow[]; count: number; loading: boolean; loaded: boolean; error: string | null }
export interface RulesState { list: TriageRule[]; loading: boolean; loaded: boolean; error: string | null }
export interface OutboxEntry {
  id: string;
  /** the Idempotency-Key, the same on every try */
  key: string;
  kind: ActionKind;
  args: ActionArgs;
  /** plain words for the person: "Stop “Gathering this week’s AI news”" */
  label: string;
  createdAt: number;
  attempts: number;
  lastError?: string;
}
export type ActResult =
  | { ok: true; queued: false; message?: string; data?: unknown; entryId?: string }
  | { ok: false; queued: true; message: string; code?: string; entryId?: string }
  | { ok: false; queued: false; message: string; code?: string; entryId?: string };
export interface ActOptions {
  /** no notice for a refusal: the screen says it in place (a plan's "This plan is old — ask again") */
  quiet?: boolean;
}
/** W4: what an ask (sent now, or replayed from the outbox) became, by its outbox entry id. */
export interface AskOutcome { entryId: string; start: AskStart; text: string; at: number; replayed: boolean }
export type AskRecord = Schemas['Ask'];

export interface StoreState {
  ready: boolean;
  connection: Connection;
  auth: 'ok' | 'signin';
  updateReady: boolean;
  meta: Meta | null;
  cursor: number;
  updatedAt: number | null;
  jobs: Record<string, Job>;
  calendar: Record<string, CalendarItem>;
  conflicts: Record<string, CalendarConflict[]>;
  projects: Record<string, Project>;
  threads: Record<string, Turn[]>;
  threadLoaded: Record<string, boolean>;
  live: Record<string, LiveInfo>;
  /** W4: a thread's pages before its latest 50 (loaded on "Earlier messages"), and the cursor for the next one */
  threadOlder: Record<string, Turn[]>;
  threadNext: Record<string, string | null>;
  /** W4: asks this device made, by outbox entry id; plan choices by ask id; asks as the server last said (stream) */
  askOutcomes: Record<string, AskOutcome>;
  /** W4: actions refused when the outbox sent them (by outbox entry id): the screen that made them says so in place */
  refused: Record<string, { kind: ActionKind; code?: string; message: string; askId?: string }>;
  /** W4: plans the person put aside ("Not now") — no longer offered when the Ask sheet opens */
  dismissedPlans: Record<string, true>;
  askChoices: Record<string, AskChosen>;
  asks: Record<string, AskRecord>;
  mail: MailState;
  outbox: OutboxEntry[];
  /** actions being sent right now (not queued): with the outbox, what the screens show optimistically */
  inflight: OutboxEntry[];
  notices: Notice[];
  fixtures: boolean;
  /** W3: the Important list's items by id (open, snoozed, and handled for 30 days), kept by /sync and the stream */
  items: Record<string, ImportantItem>;
  /** W3: what GET /items adds to the items: the skipped counts per group, Handled · N, how sorting is going */
  important: ImportantState;
  /** W3: "Show them" — the skipped mail of a group (headers only, never kept on the device) */
  skipped: Partial<Record<ImportantGroup, SkippedState>>;
  /** W3: the rules the person taught */
  rules: RulesState;
}

export interface StoreOptions {
  client: MwaClient;
  cache: CacheDb;
  stream: StreamFactory;
  env?: StoreEnv;
  now?: () => number;
  fixtures?: boolean;
  /** reconnect backoff (ms) after the stream closes or the server cannot be reached */
  backoff?: number[];
  /** P2: "this device was signed out" survives a reload (localStorage in the browser; memory in tests) */
  signedOutFlag?: SignedOutFlag;
}

/** P2 (review): remembers that this device was signed out, so an offline start shows no cached data. */
export interface SignedOutFlag { get(): boolean; set(on: boolean): void }
export const SIGNED_OUT_KEY = 'mwa-v2-signed-out';
export function browserSignedOutFlag(): SignedOutFlag {
  let mem = false;
  return {
    get: () => { try { return typeof localStorage !== 'undefined' ? localStorage.getItem(SIGNED_OUT_KEY) === '1' : mem; } catch { return mem; } },
    set: (on) => { mem = on; try { if (typeof localStorage !== 'undefined') { if (on) localStorage.setItem(SIGNED_OUT_KEY, '1'); else localStorage.removeItem(SIGNED_OUT_KEY); } } catch { /* private mode */ } },
  };
}
/** What the person is told when a 401 cleared this device's copy. */
export const SIGNED_OUT_CLEARED = 'Signed out — this phone’s copy was cleared';

const initial = (fixtures: boolean): StoreState => ({
  ready: false, connection: 'starting', auth: 'ok', updateReady: false, meta: null, cursor: 0, updatedAt: null,
  jobs: {}, calendar: {}, conflicts: {}, projects: {}, threads: {}, threadLoaded: {}, live: {},
  threadOlder: {}, threadNext: {}, askOutcomes: {}, askChoices: {}, asks: {}, refused: {}, dismissedPlans: {},
  mail: { headers: [], note: '', connected: false, loaded: false, loading: false, error: null },
  outbox: [], inflight: [], notices: [], fixtures,
  items: {}, important: { meta: null, loading: false, loaded: false, error: null }, skipped: {},
  rules: { list: [], loading: false, loaded: false, error: null },
});

const byId = <T extends { id: string }>(xs: T[]) => Object.fromEntries(xs.map((x) => [x.id, x])) as Record<string, T>;
const entries = <T extends { id: string }>(xs: T[]) => xs.map((x) => ({ key: x.id, value: x }));

export class V2Store {
  readonly client: MwaClient;
  private cache: CacheDb;
  private makeStream: StreamFactory;
  private env: StoreEnv;
  readonly now: () => number;
  private signedOutFlag: SignedOutFlag;
  private backoff: number[];
  private s: StoreState;
  private listeners = new Set<() => void>();
  private es: StreamLike | null = null;
  private hellos = 0;
  private unsubs: (() => void)[] = [];
  private timers = new Set<unknown>();
  private retryN = 0;
  private started = false;
  private writes: Promise<void> = Promise.resolve();
  private syncing: Promise<void> | null = null;
  private syncAgain = false;
  private replaying: Promise<void> | null = null;
  private mailTimer: unknown = null;
  /** W2: the Today composite (./today.ts) */
  readonly today: TodayFeed;

  constructor(o: StoreOptions) {
    this.signedOutFlag = o.signedOutFlag ?? browserSignedOutFlag();
    this.client = o.client;
    this.cache = o.cache;
    this.makeStream = o.stream;
    this.env = o.env ?? browserEnv();
    this.now = o.now ?? (() => Date.now());
    this.backoff = o.backoff ?? [1_000, 3_000, 10_000, 30_000];
    this.s = initial(!!o.fixtures);
    this.today = new TodayFeed({
      client: this.client, cache: this.cache, env: this.env, now: this.now,
      act: (kind, label, args) => this.act(kind, args, label),
      supported: () => (this.s.meta ? this.s.meta.features.includes('today') : null),
    });
  }

  // ---------- subscription (useSyncExternalStore) ----------
  getState = (): StoreState => this.s;
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private set(patch: Partial<StoreState>) { this.s = { ...this.s, ...patch }; for (const l of [...this.listeners]) l(); }

  /** Resolves when queued cache writes, a catch-up and an outbox replay have all finished (tests). */
  async idle(): Promise<void> {
    for (let i = 0; i < 5; i++) { await this.writes; await this.syncing; await this.replaying; await Promise.resolve(); }
  }
  private persist(fn: (c: CacheDb) => Promise<void>) {
    this.writes = this.writes.then(() => fn(this.cache)).catch(() => { /* a failed cache write only costs offline freshness */ });
  }

  // ---------- life cycle ----------
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    // P2 (review): this device was signed out last time: show nothing cached (and make sure nothing is left)
    if (this.signedOutFlag.get()) await this.clearDeviceCopy();
    else await this.loadCache();
    this.today.adoptOutbox(this.s.outbox); // W2: a check-in or wrap tap still waiting keeps its card gone after a reload
    await this.today.start();
    if (!this.started) return; // stopped while the cache was loading (React StrictMode mounts twice)
    this.unsubs.push(
      this.env.on('online', () => { void this.connect('online'); }),
      this.env.on('offline', () => { this.closeStream(); this.set({ connection: 'offline' }); }),
      this.env.on('visible', () => { void this.replayOutbox(); if (!this.es && this.env.online() && this.s.auth === 'ok') void this.connect('visible'); }),
    );
    if (this.env.online()) await this.connect('open');
    else this.set({ connection: 'offline', ...(this.signedOutFlag.get() && !this.s.fixtures ? { auth: 'signin' as const } : {}) });
  }

  // ---------- P2 (review): a 401 clears this device's copy ----------
  /** The server says this device is not signed in (revoked, signed out, expired): the cached data and the outbox are
   *  removed from IndexedDB and memory, "signed out" is remembered for an offline start, and the person is told. */
  private async lockedOut(): Promise<void> {
    this.closeStream();
    const had = this.s.outbox.length + Object.keys(this.s.jobs).length + Object.keys(this.s.projects).length + Object.keys(this.s.calendar).length + Object.keys(this.s.items).length > 0 || !!this.today.getState().doc;
    this.set({ auth: 'signin', connection: 'unreachable' });
    if (this.s.fixtures) return;
    this.signedOutFlag.set(true);
    await this.clearDeviceCopy();
    if (had) this.notice(SIGNED_OUT_CLEARED, 'info');
  }
  private async clearDeviceCopy(): Promise<void> {
    this.set({
      jobs: {}, calendar: {}, conflicts: {}, projects: {}, threads: {}, threadLoaded: {}, live: {}, threadOlder: {}, threadNext: {},
      askOutcomes: {}, askChoices: {}, asks: {}, refused: {}, items: {}, outbox: [], inflight: [], cursor: 0, updatedAt: null, ready: true,
      important: { meta: null, loading: false, loaded: false, error: null }, skipped: {}, rules: { list: [], loading: false, loaded: false, error: null },
      mail: { headers: [], note: '', connected: false, loaded: false, loading: false, error: null },
    });
    this.today.clear();
    await this.writes;
    const c = this.cache;
    await Promise.all(STORES.map((n) => c.clear(n).catch(() => {}))).catch(() => {});
  }

  /** P2 (review): before the app reloads for an update, an action still on its way is put in the outbox (with its
   *  key), so it is sent again after the reload — the server answers a repeat key with the first answer — and never
   *  lost. Stop and "Add to it" are about now: not kept. Resolves when the outbox is saved. */
  async parkInflight(): Promise<number> {
    const park = this.s.inflight.filter((e) => !nowOnly(e.kind, e.args) && !this.s.outbox.some((x) => x.id === e.id));
    if (park.length) {
      this.set({ outbox: [...this.s.outbox, ...park] });
      this.persist((c) => c.put('outbox', park.map((e) => ({ key: e.id, value: e }))));
    }
    await this.writes;
    return park.length;
  }

  stop(): void {
    this.started = false;
    this.closeStream();
    this.today.stop();
    for (const u of this.unsubs.splice(0)) u();
    for (const t of this.timers) this.env.clearTimeout(t);
    this.timers.clear();
    if (this.mailTimer) { this.env.clearTimeout(this.mailTimer); this.mailTimer = null; }
    if (this.importantTimer) { this.env.clearTimeout(this.importantTimer); this.importantTimer = null; }
  }

  private later(fn: () => void, ms: number) {
    const t = this.env.setTimeout(() => { this.timers.delete(t); fn(); }, ms);
    this.timers.add(t);
  }

  private async loadCache() {
    const c = this.cache;
    try {
      const [jobs, calendar, projects, threads, outbox, cursor, updatedAt, meta, items] = await Promise.all([
        c.all<Job>('jobs'), c.all<CalendarItem>('calendar'), c.all<Project>('projects'),
        c.all<{ projectId: string; turns: Turn[] }>('threads'), c.all<OutboxEntry>('outbox'),
        c.getMeta<number>('cursor'), c.getMeta<number>('updatedAt'), c.getMeta<Meta>('meta'), c.all<ImportantItem>('items'),
      ]);
      this.set({
        ready: true, jobs: byId(jobs), calendar: byId(calendar), projects: byId(projects), items: byId(items),
        threads: Object.fromEntries(threads.map((t) => [t.projectId, t.turns])),
        outbox: outbox.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1)),
        cursor: cursor ?? 0, updatedAt: updatedAt ?? null, meta: meta ?? null,
      });
    } catch {
      this.set({ ready: true });
    }
  }

  /** (Re)connect: server facts, catch up, follow the stream, send what waited in the outbox. */
  private async connect(reason: 'open' | 'online' | 'visible' | 'retry'): Promise<void> {
    if (!this.started) return;
    if (this.s.auth === 'signin' || this.s.updateReady) return;
    this.set({ connection: 'connecting' });
    try {
      const meta = await this.client.getMeta();
      // a server that is the fixture world (the Vite middleware, MWA_FIXTURES=1) says so in its version. A cache
      // filled by the other kind (example data vs a real helper, on the same dev origin) is replaced by a snapshot.
      const was = this.s.meta;
      if (was && (was.server === 'fixtures') !== (meta.server === 'fixtures')) this.set({ cursor: 0 });
      this.set({ meta, fixtures: this.s.fixtures || meta.server === 'fixtures' });
      this.persist((c) => c.setMeta({ meta, apiVersion: meta.api }));
      await this.catchUp();
    } catch (e) {
      this.handleFailure(e, reason);
      return;
    }
    if (!this.started) return;
    this.retryN = 0;
    this.signedOutFlag.set(false); // signed in (again): an offline start may show the cache
    this.openStream();
    void this.replayOutbox();
    void this.today.load(); // W2: Today as it is now (on open, online, and every reconnect)
  }

  /** W5: signed in or paired just now: forget the 401 and connect again (catch up, the stream, the outbox). */
  async resume(): Promise<void> {
    this.set({ auth: 'ok' });
    await this.connect('open');
  }
  /** W5: this device signed out (or was told it is not signed in): stop the stream and show the sign-in screens. P2
   *  (review): and clear the device's copy — the cached data and the outbox — and remember it for an offline start. */
  signedOut(): void {
    void this.lockedOut();
  }

  private handleFailure(e: unknown, _reason: string) {
    if (e instanceof SignInRequired) { void this.lockedOut(); return; }
    if (e instanceof UpdateRequired) { this.closeStream(); this.set({ updateReady: true, connection: 'unreachable' }); return; }
    if (e instanceof Forbidden) { this.closeStream(); this.set({ connection: 'unreachable' }); this.notice(e.message, 'error'); return; }
    // the network or the server is down: try again with a growing pause
    this.set({ connection: this.env.online() ? 'unreachable' : 'offline' });
    if (!this.env.online()) return; // 'online' will reconnect
    const ms = this.backoff[Math.min(this.retryN++, this.backoff.length - 1)];
    this.later(() => { void this.connect('retry'); }, ms);
  }

  // ---------- catch-up through /sync ----------
  /** Catch up with what changed since the cursor (a snapshot when there is none). One at a time; a call made while
   *  one runs makes it run once more afterwards. */
  catchUp(): Promise<void> {
    if (this.syncing) { this.syncAgain = true; return this.syncing; }
    this.syncing = (async () => {
      try {
        do {
          this.syncAgain = false;
          for (let page = 0; page < 1000; page++) {
            const r = await this.client.sync({ since: this.s.cursor || undefined, collections: collectionsFor(this.s.meta) });
            this.applySync(r);
            if (!r.more) break;
          }
        } while (this.syncAgain);
      } finally { this.syncing = null; }
    })();
    return this.syncing;
  }

  private applySync(r: SyncResult) {
    const up = r.upserts ?? {}, del = r.deletes ?? {};
    if (r.reset) {
      const jobs = (up.jobs ?? []) as Job[], calendar = (up.calendar ?? []) as CalendarItem[], projects = (up.projects ?? []) as Project[];
      const threads = groupTurns((up.turns ?? []) as Turn[]);
      this.set({ jobs: byId(jobs), calendar: byId(calendar), projects: byId(projects), threads, threadLoaded: {}, conflicts: {}, threadOlder: {}, threadNext: {} });
      this.persist(async (c) => {
        await c.replace('jobs', entries(jobs));
        await c.replace('calendar', entries(calendar));
        await c.replace('projects', entries(projects));
        await c.replace('threads', Object.entries(threads).map(([projectId, turns]) => ({ key: projectId, value: { projectId, turns } })));
      });
      // the Important list only when it was asked for (an older server's snapshot has no such collection)
      if (up.important) {
        const items = up.important as ImportantItem[];
        this.set({ items: byId(items) });
        this.persist((c) => c.replace('items', entries(items)));
      }
    } else {
      this.upsert('jobs', (up.jobs ?? []) as Job[], del.jobs ?? []);
      this.upsert('calendar', (up.calendar ?? []) as CalendarItem[], del.calendar ?? []);
      this.upsert('projects', (up.projects ?? []) as Project[], del.projects ?? []);
      this.applyTurns((up.turns ?? []) as Turn[], del.turns ?? []);
      this.upsert('items', (up.important ?? []) as ImportantItem[], del.important ?? []);
    }
    this.setCursor(r.cursor, true);
  }

  private setCursor(seq: number, force = false) {
    if (!force && seq <= this.s.cursor) return;
    const updatedAt = this.now();
    this.set({ cursor: seq, updatedAt });
    this.persist((c) => c.setMeta({ cursor: seq, updatedAt }));
  }

  private upsert(coll: 'jobs' | 'calendar' | 'projects' | 'items', ups: { id: string }[], dels: string[]) {
    if (!ups.length && !dels.length) return;
    const next = { ...(this.s[coll] as Record<string, { id: string }>) };
    for (const x of ups) next[x.id] = x;
    for (const id of dels) delete next[id];
    this.set({ [coll]: next } as Partial<StoreState>);
    this.persist(async (c) => { await c.put(coll as StoreName, entries(ups)); await c.remove(coll as StoreName, dels); });
  }

  /** Turns go into their project's thread (a moved turn leaves the old one); each thread keeps its last 50. A summary
   *  (truncated) never replaces the whole turn already held at the same or a newer sequence. */
  private applyTurns(ups: Turn[], dels: string[]) {
    if (!ups.length && !dels.length) return;
    const threads = { ...this.s.threads };
    const touched = new Set<string>();
    const gone = new Set([...dels, ...ups.map((t) => t.id)]);
    const held = new Map<string, Turn>();
    for (const [pid, turns] of Object.entries(threads)) {
      if (!turns.some((t) => gone.has(t.id))) continue;
      for (const t of turns) if (gone.has(t.id)) held.set(t.id, t);
      threads[pid] = turns.filter((t) => !gone.has(t.id));
      touched.add(pid);
    }
    // W4: an earlier page loses a turn that moved away or was removed (it is shown where it is now)
    let older = this.s.threadOlder;
    for (const [pid, turns] of Object.entries(older)) {
      if (!turns.some((t) => gone.has(t.id))) continue;
      for (const t of turns) if (gone.has(t.id) && !held.has(t.id)) held.set(t.id, t);
      older = { ...older, [pid]: turns.filter((t) => !gone.has(t.id)) };
    }
    for (const t of ups) {
      const old = held.get(t.id);
      const keep = old && t.truncated && !old.truncated && old.updatedSeq >= t.updatedSeq && old.projectId === t.projectId ? old : t;
      const sorted = [...(threads[t.projectId] ?? []), keep].sort(byTs);
      threads[t.projectId] = sorted.slice(-THREAD_KEEP);
      // W4: a turn pushed out of the latest 50 (or moved back in older than them) stays on the thread's earlier
      // pages once the thread is open, so neither the page the person is reading nor "Earlier messages" skips it
      const spill = sorted.slice(0, Math.max(0, sorted.length - THREAD_KEEP));
      if (spill.length && this.s.threadLoaded[t.projectId]) {
        const ids = new Set(spill.map((x) => x.id));
        older = { ...older, [t.projectId]: [...(older[t.projectId] ?? []).filter((x) => !ids.has(x.id)), ...spill].sort(byTs) };
      }
      touched.add(t.projectId);
    }
    if (older !== this.s.threadOlder) this.setOlder(older);
    this.set({ threads });
    this.persist((c) => c.put('threads', [...touched].map((pid) => ({ key: pid, value: { projectId: pid, turns: threads[pid] ?? [] } }))));
  }

  // ---------- the live stream ----------
  private openStream() {
    this.closeStream();
    this.hellos = 0;
    const es = this.makeStream(this.client.streamUrl(this.s.cursor || undefined));
    this.es = es;
    es.addEventListener('hello', () => {
      if (this.es !== es) return;
      this.hellos++;
      this.set({ connection: 'live' });
      // the browser reconnected by itself (Last-Event-ID): catch up as well, for anything the stream does not replay
      if (this.hellos > 1) void this.catchUp().catch((e) => this.handleFailure(e, 'reconnect'));
    });
    es.addEventListener('change', (e) => { if (this.es === es) this.onChange(e); });
    es.addEventListener('live', (e) => {
      if (this.es !== es) return;
      const d = parse<LiveInfo>(e.data);
      if (d?.session) this.set({ live: { ...this.s.live, [d.session]: d } });
    });
    es.addEventListener('reset', () => {
      if (this.es !== es) return;
      // the cursor is older than what the server keeps: take a snapshot
      this.set({ cursor: 0 });
      void this.catchUp().catch((err) => this.handleFailure(err, 'reset'));
    });
    es.onerror = () => {
      if (this.es !== es) return;
      if (es.readyState === 2) {
        // closed for good (a refusal, or the browser gave up): reconnect ourselves, catching up first
        this.closeStream();
        this.set({ connection: this.env.online() ? 'connecting' : 'offline' });
        if (this.env.online()) this.later(() => { void this.connect('retry'); }, this.backoff[Math.min(this.retryN++, this.backoff.length - 1)]);
      } else {
        this.set({ connection: this.env.online() ? 'connecting' : 'offline' });
      }
    };
  }
  private closeStream() { if (this.es) { const es = this.es; this.es = null; es.onerror = null; es.close(); } }

  private onChange(e: MessageEvent) {
    const m = parse<{ seq: number; entity: string; id: string; op: 'upsert' | 'delete'; data?: unknown }>(e.data);
    if (!m) return;
    const seq = Number(m.seq ?? e.lastEventId) || 0;
    const del = m.op === 'delete' || m.data == null;
    if (m.entity === 'today') this.today.changed(); // W2: a data-less notice: GET /today again
    switch (m.entity) {
      case 'job': this.upsert('jobs', del ? [] : [m.data as Job], del ? [m.id] : []); break;
      case 'calendar': this.upsert('calendar', del ? [] : [m.data as CalendarItem], del ? [m.id] : []); break;
      case 'project': this.upsert('projects', del ? [] : [m.data as Project], del ? [m.id] : []); break;
      case 'turn': this.applyTurns(del ? [] : [m.data as Turn], del ? [m.id] : []); break;
      case 'mail': this.mailChanged(); break;
      case 'ask': if (!del && m.data) this.set({ asks: { ...this.s.asks, [m.id]: m.data as AskRecord } }); break;
      case 'item': this.upsert('items', del ? [] : [m.data as ImportantItem], del ? [m.id] : []); this.importantChanged(); break;
      default: break; // devices and anything newer: nothing on these screens
    }
    if (seq) this.setCursor(seq);
  }

  // ---------- reads the screens ask for ----------
  /** A project's thread, whole (the stream and /sync carry 500-character summaries). */
  async loadThread(projectId: string): Promise<void> {
    try {
      const r = await this.client.getProjectThread(projectId, { limit: THREAD_KEEP });
      const turns = r.turns.slice(-THREAD_KEEP);
      // W4: the cursor for the page before this one ("Earlier messages"); earlier pages start empty again
      this.set({ threads: { ...this.s.threads, [projectId]: turns }, threadLoaded: { ...this.s.threadLoaded, [projectId]: true },
        threadNext: { ...this.s.threadNext, [projectId]: r.next }, threadOlder: { ...this.s.threadOlder, [projectId]: [] } });
      this.upsert('projects', [r.project], []);
      this.persist((c) => c.put('threads', [{ key: projectId, value: { projectId, turns } }]));
    } catch (e) { this.noteError(e); }
  }

  /** W4: earlier pages, at most OLDER_KEEP turns a thread: past it the oldest go and the thread's cursor says
   *  "load again" (RELOAD_THREAD). */
  private setOlder(older: Record<string, Turn[]>) {
    let next = this.s.threadNext;
    for (const [pid, turns] of Object.entries(older)) {
      if (turns.length <= OLDER_KEEP) continue;
      older = { ...older, [pid]: turns.slice(-OLDER_KEEP) };
      next = { ...next, [pid]: RELOAD_THREAD };
    }
    this.set({ threadOlder: older, ...(next !== this.s.threadNext ? { threadNext: next } : {}) });
  }

  /** W4: the page of a thread before what is shown ("Earlier messages"). Kept apart from the latest 50 (which the
   *  stream keeps current) and not cached on the device. Resolves false when there is nothing earlier. */
  async loadEarlier(projectId: string, limit = 30): Promise<boolean> {
    const before = this.s.threadNext[projectId];
    if (!before) return false;
    if (before === RELOAD_THREAD) { await this.loadThread(projectId); return true; }
    try {
      const r = await this.client.getProjectThread(projectId, { before, limit });
      const have = new Set([...(this.s.threadOlder[projectId] ?? []), ...(this.s.threads[projectId] ?? [])].map((t) => t.id));
      const fresh = r.turns.filter((t) => !have.has(t.id) && t.projectId === projectId);
      this.set({ threadNext: { ...this.s.threadNext, [projectId]: r.next } });
      this.setOlder({ ...this.s.threadOlder, [projectId]: [...fresh, ...(this.s.threadOlder[projectId] ?? [])].sort(byTs) });
      return true;
    } catch (e) { this.noteError(e); return false; }
  }

  /** W4: a project's jobs (its Work tab); they join the store's jobs so the stream keeps them current. */
  async loadProjectWork(projectId: string): Promise<string[] | null> {
    try {
      const r = await this.client.getProjectWork(projectId);
      this.upsert('jobs', r.jobs, []);
      return r.jobs.map((j) => j.id);
    } catch (e) { this.noteError(e, true); return null; }
  }

  /** W4: an ask as it stands, and its turn (the answer whole, not the stream's 500-character summary). */
  async loadAsk(askId: string): Promise<AskRecord | null> {
    try {
      const r = await this.client.getAsk(askId);
      this.set({ asks: { ...this.s.asks, [askId]: r.ask } });
      if (r.turn) this.applyTurns([r.turn], []);
      return r.ask;
    } catch (e) { this.noteError(e, true); return null; }
  }

  /** The calendar for a window, with its double-bookings (the server works those out). */
  async loadCalendar(from: string, to: string): Promise<void> {
    try {
      const r = await this.client.getCalendar({ from, to });
      this.upsert('calendar', r.items, []);
      this.set({ conflicts: { ...this.s.conflicts, [`${from}|${to}`]: r.conflicts } });
    } catch (e) { this.noteError(e, true); }
  }

  /** The plain mailbox's first page (headers only, never stored on the device). */
  async loadMail(): Promise<void> {
    this.set({ mail: { ...this.s.mail, loading: true } });
    try {
      const r = await this.client.listMail({ limit: 50 });
      this.set({ mail: { headers: r.mail, note: r.note, connected: r.connected, loaded: true, loading: false, error: null } });
    } catch (e) {
      this.set({ mail: { ...this.s.mail, loading: false, error: e instanceof Error ? e.message : 'Could not load your mail.' } });
      this.noteError(e, true);
    }
  }
  private mailChanged() {
    if (!this.s.mail.loaded || this.mailTimer) return;
    this.mailTimer = this.env.setTimeout(() => { this.mailTimer = null; void this.loadMail(); }, 1_500);
  }

  // ---------- the Important list (W3) ----------
  /**
   * The list as the server sorts it now: GET /items (open) and /items?state=handled. Its items replace what was held
   * (one gone from both lists has left: a rule hid it, its source went away); a held copy newer than the answer (a
   * stream change that raced the request) is kept. Also the skipped counts, Handled · N and how sorting is going.
   */
  async loadImportant(): Promise<void> {
    if (this.importantLoading) return this.importantLoading;
    this.set({ important: { ...this.s.important, loading: true } });
    this.importantLoading = (async () => {
      try {
        const [open, handled] = await Promise.all([this.client.listImportant(), this.client.listImportant({ state: 'handled' })]);
        const fresh = [...open.groups, ...handled.groups].flatMap((g) => g.items);
        const next: Record<string, ImportantItem> = {};
        for (const it of fresh) { const held = this.s.items[it.id]; next[it.id] = held && held.updatedSeq > it.updatedSeq ? held : it; }
        this.set({
          items: next,
          important: { meta: { handledCount: open.handledCount, skipped: open.skipped, sorting: open.sorting }, loading: false, loaded: true, error: null },
        });
        this.persist((c) => c.replace('items', entries(Object.values(next))));
      } catch (e) {
        this.set({ important: { ...this.s.important, loading: false, error: e instanceof Error ? e.message : 'Could not load the list.' } });
        this.noteError(e, true);
      } finally { this.importantLoading = null; }
    })();
    return this.importantLoading;
  }
  private importantLoading: Promise<void> | null = null;
  private importantTimer: unknown = null;
  /** An item changed on the stream: the counts beside the list (skipped, sorting) may have too. */
  private importantChanged() {
    if (!this.s.important.loaded || this.importantTimer) return;
    this.importantTimer = this.env.setTimeout(() => { this.importantTimer = null; void this.loadImportant(); }, 1_500);
  }

  /** "Show them": the skipped mail of one group, each with why it was skipped. */
  async loadSkipped(group: ImportantGroup): Promise<void> {
    const cur = this.s.skipped[group];
    this.set({ skipped: { ...this.s.skipped, [group]: { rows: cur?.rows ?? [], count: cur?.count ?? 0, loaded: cur?.loaded ?? false, loading: true, error: null } } });
    try {
      const r = await this.client.listSkipped({ group });
      this.set({ skipped: { ...this.s.skipped, [group]: { rows: r.skipped, count: r.count, loading: false, loaded: true, error: null } } });
    } catch (e) {
      this.set({ skipped: { ...this.s.skipped, [group]: { rows: cur?.rows ?? [], count: cur?.count ?? 0, loaded: cur?.loaded ?? false, loading: false, error: e instanceof Error ? e.message : 'Could not load them.' } } });
      this.noteError(e, true);
    }
  }

  /** The rules the person taught (Not important, This was important), each with what it decides now. */
  async loadRules(): Promise<void> {
    this.set({ rules: { ...this.s.rules, loading: true } });
    try {
      const r = await this.client.listTriageRules();
      this.set({ rules: { list: r.rules, loading: false, loaded: true, error: null } });
    } catch (e) {
      this.set({ rules: { ...this.s.rules, loading: false, error: e instanceof Error ? e.message : 'Could not load your rules.' } });
      this.noteError(e, true);
    }
  }

  // ---------- actions and the outbox ----------
  /** Do something now, or — when the network is down — keep it with its key and send it when back online. */
  async act(kind: ActionKind, args: ActionArgs, label: string, opts: ActOptions = {}): Promise<ActResult> {
    // W4: a plan's choice is made once: a second tap (or a second card) while one is on its way gets that one's answer
    if (kind === 'ask.choose' && args.id) {
      const going = this.choosing.get(args.id);
      if (going) return going;
      if (this.s.outbox.some((x) => x.kind === 'ask.choose' && x.args.id === args.id)) return { ok: false, queued: true, message: 'Your choice is waiting to be sent.' };
      const p = this.actInOrder(kind, args, label, opts);
      this.choosing.set(args.id, p);
      try { return await p; } finally { this.choosing.delete(args.id); }
    }
    return this.actInOrder(kind, args, label, opts);
  }
  private choosing = new Map<string, Promise<ActResult>>();

  /**
   * Actions on the same thing (the same id) are serialised (review of W3: an Undo tapped while Handled was still on
   * its way reached the server first): a new one waits until the one before it has landed, and while one waits in
   * the outbox, the next waits behind it there — so the server sees them in the order the person tapped them, online
   * or offline. Meanwhile both show at once, in that order.
   */
  private async actInOrder(kind: ActionKind, args: ActionArgs, label: string, opts: ActOptions): Promise<ActResult> {
    const entry: OutboxEntry = { id: newKey(this.now()), key: newKey(this.now()), kind, args, label, createdAt: this.now(), attempts: 0 };
    // while it is on its way the screens show it done (an item leaves the list at once); if it fails, it is dropped
    // from here and what they show goes back to what the server holds
    this.set({ inflight: [...this.s.inflight, entry] });
    const id = args.id;
    const before = id ? this.chains.get(id) : undefined;
    let release!: () => void;
    const mine = new Promise<void>((r) => { release = r; });
    const chain = (before ?? Promise.resolve()).then(() => mine);
    if (id) this.chains.set(id, chain);
    try {
      if (before) await before;
      return await this.actNow(entry, opts);
    } finally {
      release();
      if (id && this.chains.get(id) === chain) this.chains.delete(id);
    }
  }
  private chains = new Map<string, Promise<void>>();

  private async actNow(entry: OutboxEntry, opts: ActOptions): Promise<ActResult> {
    const entryId = entry.id, kind = entry.kind;
    const landed = () => this.set({ inflight: this.s.inflight.filter((x) => x.id !== entry.id) });
    // queued: it moves from in flight to the outbox in one step, so the screen does not flicker back
    const requeue = (m?: string, quietly = false) => { landed(); return this.enqueue(entry, m, quietly); };
    // W4: Stop and "Add to it" are about the run going now: refused in place, never kept for later
    const isNowOnly = nowOnly(kind, entry.args);
    const refuse = (code: string, message: string): ActResult => { landed(); return { ok: false, queued: false, code, message, entryId }; };
    const offline = () => refuse('offline', OFFLINE_WORDS[kind] ?? 'You’re offline — this needs your helper right now.');
    if (!this.env.online() || this.s.connection === 'offline') return isNowOnly ? offline() : requeue();
    if (this.s.updateReady) return isNowOnly ? refuse('client_too_old', 'Reload the app first.') : requeue('Saved. It will be sent after you reload.');
    if (this.s.auth === 'signin') return refuse('locked', 'Sign in again first.');
    // an earlier action on the same thing is still waiting in the outbox: this one goes behind it, in order
    if (!isNowOnly && entry.args.id && this.s.outbox.some((x) => x.args.id === entry.args.id)) {
      const r = requeue('It will be sent right after the change before it.', true);
      void this.replayOutbox();
      return r;
    }
    try {
      const data = await this.send(entry);
      landed();
      return { ok: true, queued: false, data, message: messageOf(data), entryId };
    } catch (e) {
      if (e instanceof NetworkError) return isNowOnly ? offline() : requeue();
      if (e instanceof UpdateRequired) { this.set({ updateReady: true }); return isNowOnly ? refuse('client_too_old', 'Reload the app first.') : requeue('Saved. It will be sent after you reload.'); }
      if (e instanceof SignInRequired) { void this.lockedOut(); return refuse('locked', `${SIGNED_OUT_CLEARED}. Sign in again, then try again.`); }
      landed();
      if (e instanceof Conflict && !TRANSIENT_CONFLICTS.has(e.code)) { await this.showCurrent(entry); }
      const message = e instanceof Error ? e.message : 'That didn’t work.';
      if (!opts.quiet) this.notice(message, 'error');
      return { ok: false, queued: false, message, code: e instanceof ApiError ? e.code : undefined, entryId };
    }
  }

  private enqueue(entry: OutboxEntry, message = 'You’re offline. I’ll send this when you’re back online.', quietly = false): ActResult {
    this.set({ outbox: [...this.s.outbox, entry] });
    this.persist((c) => c.put('outbox', [{ key: entry.id, value: entry }]));
    if (!quietly) this.notice(message, 'info');
    return { ok: false, queued: true, message, entryId: entry.id };
  }
  private dropFromOutbox(id: string) {
    this.set({ outbox: this.s.outbox.filter((x) => x.id !== id) });
    this.persist((c) => c.remove('outbox', [id]));
  }

  /** Send what waited, in order, each with its own key. Stops at the first failure that may pass (network, sign-in,
   *  update, still in progress) so the order holds. */
  replayOutbox(): Promise<void> {
    if (this.replaying) return this.replaying;
    if (!this.s.outbox.length || !this.env.online() || this.s.auth === 'signin' || this.s.updateReady) return Promise.resolve();
    this.replaying = (async () => {
      try {
        // in order, until none is left: one queued while this runs (behind an earlier one on the same thing) is sent too
        const done = new Set<string>();
        for (;;) {
          const entry = this.s.outbox.find((x) => !done.has(x.id));
          if (!entry) break;
          done.add(entry.id);
          // W2: a check-in or wrap tap for a day that has passed dismisses nothing now: dropped, quietly
          if (entry.kind.startsWith('today.') && entry.args.day && entry.args.day !== this.today.currentDay()) { this.dropFromOutbox(entry.id); continue; }
          const tried = { ...entry, attempts: entry.attempts + 1 };
          try {
            await this.send(tried, true);
            this.dropFromOutbox(entry.id);
          } catch (e) {
            if (e instanceof NetworkError) { this.keep(tried, e.message); break; }
            if (e instanceof UpdateRequired) { this.keep(tried, e.message); this.set({ updateReady: true }); break; }
            if (e instanceof SignInRequired) { void this.lockedOut(); break; }
            if (e instanceof Conflict && TRANSIENT_CONFLICTS.has(e.code)) { this.keep(tried, e.message); break; }
            // refused for good (409 changed meanwhile, 403, 404…): drop it, say so, show what is true now; the screen
            // that made it finds why in `refused` (a plan card shows it with Ask again)
            this.dropFromOutbox(entry.id);
            this.set({ refused: { ...this.s.refused, [entry.id]: { kind: entry.kind, code: e instanceof ApiError ? e.code : undefined,
              message: e instanceof Error ? e.message : 'It didn’t go through.', ...(entry.kind === 'ask.choose' && entry.args.id ? { askId: entry.args.id } : {}) } } });
            if (e instanceof Conflict) await this.showCurrent(entry);
            this.notice(`${entry.label}: ${e instanceof Error ? e.message : 'it didn’t go through.'}`, 'error');
          }
        }
      } finally { this.replaying = null; }
    })();
    return this.replaying;
  }
  private keep(entry: OutboxEntry, err: string) {
    const kept = { ...entry, lastError: err };
    this.set({ outbox: this.s.outbox.map((x) => (x.id === entry.id ? kept : x)) });
    this.persist((c) => c.put('outbox', [{ key: kept.id, value: kept }]));
  }

  /** One action → one API call, with the action's key. Its answer updates the store. */
  private async send(e: OutboxEntry, replayed = false): Promise<unknown> {
    const c = this.client, key = { key: e.key }, id = e.args.id ?? '', b = e.args.payload ?? {};
    let out: unknown;
    switch (e.kind) {
      case 'job.stop': out = await c.stopJob(id, key); break;
      case 'job.continue': out = await c.continueJob(id, e.args.capUsd !== undefined ? { capUsd: e.args.capUsd } : {}, key); break;
      case 'job.startOver': out = await c.startJobOver(id, e.args.capUsd !== undefined ? { capUsd: e.args.capUsd } : {}, key); break;
      case 'job.open': out = await c.openJob(id, key); break;
      case 'job.pause': out = await c.pauseJob(id, key); break;
      case 'job.resume': out = await c.resumeJob(id, key); break;
      case 'job.cancel': out = await c.cancelJob(id, key); break;
      case 'draft.confirm': out = await c.confirmCalendarDraft(id, e.args.provider ? { provider: e.args.provider } : {}, key); break;
      case 'draft.remove': out = await c.removeCalendarDraft(id, key); break;
      case 'message.send': out = await c.sendProjectMessage(id, { text: e.args.text ?? '' }, key); break;
      case 'ask': out = await c.ask(b as AskBody, key); break;
      case 'ask.choose': out = await c.chooseAsk(id, b as AskChoice, key); break;
      case 'turn.move': out = await c.moveTurn(id, { projectId: String(b.projectId ?? '') }, key); break;
      case 'project.create': out = await c.createProject(b as { name: string; icon?: string | null }, key); break;
      case 'project.update': out = await c.updateProject(id, b as { name?: string; icon?: string | null; archived?: boolean; sort?: number }, key); break;
      case 'project.stop': out = await c.stopProjectRun(id, typeof b.runId === 'string' ? { runId: b.runId } : {}, key); break;
      case 'project.steer': out = await c.steerProjectRun(id, { text: e.args.text ?? '', ...(typeof b.runId === 'string' ? { runId: b.runId } : {}) }, key); break;
      case 'project.offer': out = await c.acceptProjectOffer(id, e.args.text ? { message: e.args.text } : {}, key); break;
      case 'item.handled': out = await c.markItemHandled(id, key); break;
      case 'item.unhandle': out = await c.unhandleItem(id, key); break;
      case 'item.notImportant': out = await c.markItemNotImportant(id, e.args.scope ? { scope: e.args.scope } : {}, key); break;
      case 'item.action': out = await c.runItemAction(id, key); break;
      case 'mail.important': out = await c.markMailImportant(id, key); break;
      case 'mail.draft': out = await c.saveMailDraft(id, { body: e.args.body ?? '' }, key); break;
      case 'rule.delete': out = await c.deleteTriageRule(id, key); break;
      case 'today.checkin': out = await c.finishCheckin(e.args.day ? { day: e.args.day } : {}, key); break;
      case 'today.wrap': out = await c.finishWrap(e.args.day ? { day: e.args.day } : {}, key); break;
      case 'draft.create': out = await c.createCalendarDraft(e.args.draft ?? { title: '', start: '' }, key); break;
    }
    this.applyResult(e.kind, out, e, replayed);
    return out;
  }
  private applyResult(kind: ActionKind, out: unknown, e?: OutboxEntry, replayed = false) {
    const args: ActionArgs = e?.args ?? {};
    if (kind.startsWith('today.')) { this.today.apply((out as { today?: Schemas['Today'] } | null)?.today); return; }
    if (kind === 'ask' && e) {
      const start = out as AskStart;
      if (!start?.askId) return;
      this.set({ askOutcomes: { ...this.s.askOutcomes, [e.id]: { entryId: e.id, start, text: String(e.args.payload?.text ?? ''), at: this.now(), replayed } } });
      // a plan sent from the outbox waits for a choice: say so, since the screen that asked may be gone
      if (replayed && start.kind === 'plan') this.notice('Something you asked while offline needs a choice before I start. Open Ask to choose.', 'info');
      return;
    }
    if (kind === 'ask.choose' && e?.args.id) {
      const chosen = out as AskChosen;
      if (chosen?.askId) this.set({ askChoices: { ...this.s.askChoices, [e.args.id]: chosen } });
      return;
    }
    if (kind === 'turn.move') { const m = out as TurnMoved; if (m?.turn) this.applyTurns([m.turn], []); return; }
    if (kind === 'project.create' || kind === 'project.update') { const p = (out as { project?: Project })?.project; if (p) this.upsert('projects', [p], []); return; }
    if (kind.startsWith('job.')) { const d = out as JobDetail; if (d?.job) this.upsert('jobs', [d.job], []); return; }
    if (kind.startsWith('item.') || kind === 'mail.important') {
      const d = out as ItemChange | ItemActionResult | null;
      if (d?.item) this.upsert('items', [d.item], []);
      const draft = (d as ItemActionResult | null)?.draft;
      if (draft) this.upsert('calendar', [draft], []);
      if (kind === 'mail.important' && args.id) {
        // the message leaves the skipped list it was picked from
        const g = args.group, cur = g ? this.s.skipped[g] : undefined;
        if (g && cur) this.set({ skipped: { ...this.s.skipped, [g]: { ...cur, rows: cur.rows.filter((r) => r.mail.id !== args.id), count: Math.max(0, cur.count - (cur.rows.some((r) => r.mail.id === args.id) ? 1 : 0)) } } });
      }
      // a rule changes the skipped counts beside the list
      if ((kind === 'item.notImportant' || kind === 'mail.important') && this.s.important.loaded) void this.loadImportant();
      return;
    }
    if (kind === 'rule.delete') {
      if (args.id) this.set({ rules: { ...this.s.rules, list: this.s.rules.list.filter((r) => r.id !== args.id) } });
      if (this.s.important.loaded) void this.loadImportant();
      return;
    }
    if (kind.startsWith('draft.')) {
      const d = out as DraftResult;
      if (!d?.draft) return;
      if (d.draft.state === 'removed') this.upsert('calendar', [], [d.draft.id]); else this.upsert('calendar', [d.draft], []);
    }
  }

  /** After a 409: what the server holds now replaces what this device thought. */
  private async showCurrent(e: OutboxEntry) {
    try {
      await this.catchUp();
      // the job itself last: the most direct answer wins over a catch-up that raced it
      if (e.kind.startsWith('job.') && e.args.id) { const d = await this.client.getJob(e.args.id); this.upsert('jobs', [d.job], []); }
    } catch { /* the stream will bring it */ }
  }

  /** W4: a plan the person puts aside ("Not now"): the Ask sheet stops offering it. */
  dismissPlan(askId: string) { this.set({ dismissedPlans: { ...this.s.dismissedPlans, [askId]: true } }); }

  // ---------- notices ----------
  notice(text: string, tone: Notice['tone'] = 'info', action?: NoticeAction): string {
    const n: Notice = { id: newKey(this.now()), text, tone, at: this.now(), ...(action ? { action } : {}) };
    this.set({ notices: [...this.s.notices.slice(-3), n] });
    return n.id;
  }
  dismiss(id: string) { this.set({ notices: this.s.notices.filter((n) => n.id !== id) }); }
  private noteError(e: unknown, quiet = false) {
    if (e instanceof SignInRequired) { void this.lockedOut(); return; }
    if (e instanceof UpdateRequired) { this.set({ updateReady: true }); return; }
    if (e instanceof NetworkError) return; // offline: the cache is what there is
    if (e instanceof Forbidden || !quiet) this.notice(e instanceof Error ? e.message : 'That didn’t work.', 'error');
  }
}

const byTs = (a: Turn, b: Turn) => a.ts - b.ts || (a.id < b.id ? -1 : 1);
function groupTurns(turns: Turn[]): Record<string, Turn[]> {
  const out: Record<string, Turn[]> = {};
  for (const t of turns) (out[t.projectId] ??= []).push(t);
  for (const k of Object.keys(out)) out[k] = out[k].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1)).slice(-THREAD_KEEP);
  return out;
}
function parse<T>(s: unknown): T | null { try { return JSON.parse(String(s)) as T; } catch { return null; } }
function messageOf(x: unknown): string | undefined {
  const m = (x as { message?: unknown } | null)?.message;
  return typeof m === 'string' ? m : undefined;
}
export type { MessageSent };
