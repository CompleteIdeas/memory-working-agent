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
 * Errors: 401 → `auth: 'signin'` (the shell asks to sign in or pair); 426 → `updateReady` ("A newer version is
 * ready · Reload"); 403 and other refusals → a notice with the server's own words.
 */
import {
  MwaClient, ApiError, Conflict, Forbidden, NetworkError, SignInRequired, UpdateRequired, TRANSIENT_CONFLICTS, newKey,
  type CalendarItem, type Job, type JobDetail, type MailHeader, type Meta, type Project, type SyncCollection, type SyncResult, type Turn,
  type DraftResult, type MessageSent, type Schemas, type AskBody, type AskChoice, type AskStart, type AskChosen, type TurnMoved,
} from '../api/client';
import type { CacheDb, StoreName } from './cache';

export const THREAD_KEEP = 50;
export const COLLECTIONS: SyncCollection[] = ['jobs', 'calendar', 'projects', 'turns'];

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
export interface Notice { id: string; text: string; tone: 'info' | 'error'; at: number }
export interface LiveInfo { session: string; type: string; stage: unknown; at: number }
export interface MailState { headers: MailHeader[]; note: string; connected: boolean; loaded: boolean; loading: boolean; error: string | null }
export type CalendarConflict = Schemas['CalendarConflict'];

export type ActionKind =
  | 'job.stop' | 'job.continue' | 'job.startOver' | 'job.open' | 'job.pause' | 'job.resume' | 'job.cancel'
  | 'draft.confirm' | 'draft.remove' | 'message.send'
  // W4: Ask, a plan's choice, projects and their threads
  | 'ask' | 'ask.choose' | 'turn.move' | 'project.create' | 'project.update' | 'project.stop' | 'project.steer' | 'project.offer';
export interface ActionArgs {
  id?: string; capUsd?: number; text?: string; provider?: 'google' | 'outlook';
  /** W4: the request body of an ask (`ask`), a plan's choice (`ask.choose`), a move ({projectId}), a project's fields */
  body?: Record<string, unknown>;
}
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
  | { ok: false; queued: true; message: string; entryId?: string }
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
  askChoices: Record<string, AskChosen>;
  asks: Record<string, AskRecord>;
  mail: MailState;
  outbox: OutboxEntry[];
  notices: Notice[];
  fixtures: boolean;
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
}

const initial = (fixtures: boolean): StoreState => ({
  ready: false, connection: 'starting', auth: 'ok', updateReady: false, meta: null, cursor: 0, updatedAt: null,
  jobs: {}, calendar: {}, conflicts: {}, projects: {}, threads: {}, threadLoaded: {}, live: {},
  threadOlder: {}, threadNext: {}, askOutcomes: {}, askChoices: {}, asks: {},
  mail: { headers: [], note: '', connected: false, loaded: false, loading: false, error: null },
  outbox: [], notices: [], fixtures,
});

const byId = <T extends { id: string }>(xs: T[]) => Object.fromEntries(xs.map((x) => [x.id, x])) as Record<string, T>;
const entries = <T extends { id: string }>(xs: T[]) => xs.map((x) => ({ key: x.id, value: x }));

export class V2Store {
  readonly client: MwaClient;
  private cache: CacheDb;
  private makeStream: StreamFactory;
  private env: StoreEnv;
  readonly now: () => number;
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

  constructor(o: StoreOptions) {
    this.client = o.client;
    this.cache = o.cache;
    this.makeStream = o.stream;
    this.env = o.env ?? browserEnv();
    this.now = o.now ?? (() => Date.now());
    this.backoff = o.backoff ?? [1_000, 3_000, 10_000, 30_000];
    this.s = initial(!!o.fixtures);
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
    await this.loadCache();
    if (!this.started) return; // stopped while the cache was loading (React StrictMode mounts twice)
    this.unsubs.push(
      this.env.on('online', () => { void this.connect('online'); }),
      this.env.on('offline', () => { this.closeStream(); this.set({ connection: 'offline' }); }),
      this.env.on('visible', () => { void this.replayOutbox(); if (!this.es && this.env.online() && this.s.auth === 'ok') void this.connect('visible'); }),
    );
    if (this.env.online()) await this.connect('open');
    else this.set({ connection: 'offline' });
  }

  stop(): void {
    this.started = false;
    this.closeStream();
    for (const u of this.unsubs.splice(0)) u();
    for (const t of this.timers) this.env.clearTimeout(t);
    this.timers.clear();
    if (this.mailTimer) { this.env.clearTimeout(this.mailTimer); this.mailTimer = null; }
  }

  private later(fn: () => void, ms: number) {
    const t = this.env.setTimeout(() => { this.timers.delete(t); fn(); }, ms);
    this.timers.add(t);
  }

  private async loadCache() {
    const c = this.cache;
    try {
      const [jobs, calendar, projects, threads, outbox, cursor, updatedAt, meta] = await Promise.all([
        c.all<Job>('jobs'), c.all<CalendarItem>('calendar'), c.all<Project>('projects'),
        c.all<{ projectId: string; turns: Turn[] }>('threads'), c.all<OutboxEntry>('outbox'),
        c.getMeta<number>('cursor'), c.getMeta<number>('updatedAt'), c.getMeta<Meta>('meta'),
      ]);
      this.set({
        ready: true, jobs: byId(jobs), calendar: byId(calendar), projects: byId(projects),
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
    this.openStream();
    void this.replayOutbox();
  }

  private handleFailure(e: unknown, _reason: string) {
    if (e instanceof SignInRequired) { this.closeStream(); this.set({ auth: 'signin', connection: 'unreachable' }); return; }
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
            const r = await this.client.sync({ since: this.s.cursor || undefined, collections: COLLECTIONS });
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
    } else {
      this.upsert('jobs', (up.jobs ?? []) as Job[], del.jobs ?? []);
      this.upsert('calendar', (up.calendar ?? []) as CalendarItem[], del.calendar ?? []);
      this.upsert('projects', (up.projects ?? []) as Project[], del.projects ?? []);
      this.applyTurns((up.turns ?? []) as Turn[], del.turns ?? []);
    }
    this.setCursor(r.cursor, true);
  }

  private setCursor(seq: number, force = false) {
    if (!force && seq <= this.s.cursor) return;
    const updatedAt = this.now();
    this.set({ cursor: seq, updatedAt });
    this.persist((c) => c.setMeta({ cursor: seq, updatedAt }));
  }

  private upsert(coll: 'jobs' | 'calendar' | 'projects', ups: { id: string }[], dels: string[]) {
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
    if (older !== this.s.threadOlder) this.set({ threadOlder: older });
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
    switch (m.entity) {
      case 'job': this.upsert('jobs', del ? [] : [m.data as Job], del ? [m.id] : []); break;
      case 'calendar': this.upsert('calendar', del ? [] : [m.data as CalendarItem], del ? [m.id] : []); break;
      case 'project': this.upsert('projects', del ? [] : [m.data as Project], del ? [m.id] : []); break;
      case 'turn': this.applyTurns(del ? [] : [m.data as Turn], del ? [m.id] : []); break;
      case 'mail': this.mailChanged(); break;
      case 'ask': if (!del && m.data) this.set({ asks: { ...this.s.asks, [m.id]: m.data as AskRecord } }); break;
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

  /** W4: the page of a thread before what is shown ("Earlier messages"). Kept apart from the latest 50 (which the
   *  stream keeps current) and not cached on the device. Resolves false when there is nothing earlier. */
  async loadEarlier(projectId: string, limit = 30): Promise<boolean> {
    const before = this.s.threadNext[projectId];
    if (!before) return false;
    try {
      const r = await this.client.getProjectThread(projectId, { before, limit });
      const have = new Set([...(this.s.threadOlder[projectId] ?? []), ...(this.s.threads[projectId] ?? [])].map((t) => t.id));
      const fresh = r.turns.filter((t) => !have.has(t.id) && t.projectId === projectId);
      this.set({
        threadOlder: { ...this.s.threadOlder, [projectId]: [...fresh, ...(this.s.threadOlder[projectId] ?? [])].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1)) },
        threadNext: { ...this.s.threadNext, [projectId]: r.next },
      });
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

  // ---------- actions and the outbox ----------
  /** Do something now, or — when the network is down — keep it with its key and send it when back online. */
  async act(kind: ActionKind, args: ActionArgs, label: string, opts: ActOptions = {}): Promise<ActResult> {
    const entry: OutboxEntry = { id: newKey(this.now()), key: newKey(this.now()), kind, args, label, createdAt: this.now(), attempts: 0 };
    const entryId = entry.id;
    if (!this.env.online() || this.s.connection === 'offline') return this.enqueue(entry);
    if (this.s.updateReady) return this.enqueue(entry, 'Saved. It will be sent after you reload.');
    if (this.s.auth === 'signin') return this.enqueue(entry, 'Saved. It will be sent once you sign in again.');
    try {
      const data = await this.send(entry);
      return { ok: true, queued: false, data, message: messageOf(data), entryId };
    } catch (e) {
      if (e instanceof NetworkError) return this.enqueue(entry);
      if (e instanceof UpdateRequired) { this.set({ updateReady: true }); return this.enqueue(entry, 'Saved. It will be sent after you reload.'); }
      if (e instanceof SignInRequired) { this.set({ auth: 'signin' }); return this.enqueue(entry, 'Saved. It will be sent once you sign in again.'); }
      if (e instanceof Conflict && !TRANSIENT_CONFLICTS.has(e.code)) { await this.showCurrent(entry); }
      const message = e instanceof Error ? e.message : 'That didn’t work.';
      if (!opts.quiet) this.notice(message, 'error');
      return { ok: false, queued: false, message, code: e instanceof ApiError ? e.code : undefined, entryId };
    }
  }

  private enqueue(entry: OutboxEntry, message = 'You’re offline. I’ll send this when you’re back online.'): ActResult {
    this.set({ outbox: [...this.s.outbox, entry] });
    this.persist((c) => c.put('outbox', [{ key: entry.id, value: entry }]));
    this.notice(message, 'info');
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
        for (const entry of [...this.s.outbox]) {
          const tried = { ...entry, attempts: entry.attempts + 1 };
          try {
            await this.send(tried, true);
            this.dropFromOutbox(entry.id);
          } catch (e) {
            if (e instanceof NetworkError) { this.keep(tried, e.message); break; }
            if (e instanceof UpdateRequired) { this.keep(tried, e.message); this.set({ updateReady: true }); break; }
            if (e instanceof SignInRequired) { this.keep(tried, e.message); this.set({ auth: 'signin' }); break; }
            if (e instanceof Conflict && TRANSIENT_CONFLICTS.has(e.code)) { this.keep(tried, e.message); break; }
            // refused for good (409 changed meanwhile, 403, 404…): drop it, say so, show what is true now
            this.dropFromOutbox(entry.id);
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
    const c = this.client, key = { key: e.key }, id = e.args.id ?? '', b = e.args.body ?? {};
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
      case 'project.stop': out = await c.stopProjectRun(id, key); break;
      case 'project.steer': out = await c.steerProjectRun(id, { text: e.args.text ?? '' }, key); break;
      case 'project.offer': out = await c.acceptProjectOffer(id, e.args.text ? { message: e.args.text } : {}, key); break;
    }
    this.applyResult(e.kind, out, e, replayed);
    return out;
  }
  private applyResult(kind: ActionKind, out: unknown, e?: OutboxEntry, replayed = false) {
    if (kind === 'ask' && e) {
      const start = out as AskStart;
      if (!start?.askId) return;
      this.set({ askOutcomes: { ...this.s.askOutcomes, [e.id]: { entryId: e.id, start, text: String(e.args.body?.text ?? ''), at: this.now(), replayed } } });
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

  // ---------- notices ----------
  notice(text: string, tone: Notice['tone'] = 'info') {
    const n: Notice = { id: newKey(this.now()), text, tone, at: this.now() };
    this.set({ notices: [...this.s.notices.slice(-3), n] });
  }
  dismiss(id: string) { this.set({ notices: this.s.notices.filter((n) => n.id !== id) }); }
  private noteError(e: unknown, quiet = false) {
    if (e instanceof SignInRequired) { this.set({ auth: 'signin' }); return; }
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
