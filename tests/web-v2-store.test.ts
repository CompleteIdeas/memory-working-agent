// v2 build, slice W1: the v2 web store (web/src/v2/store/core.ts) — the stream resumes from the saved cursor, a
// `reset` takes a fresh snapshot through /sync, catch-up pages while `more`, actions made offline wait in the outbox
// with their Idempotency-Key and are replayed with the same key, a 409 shows the server's current state, and a 426
// asks for a reload. Plus the pill and the working sheet's groups from all eight server job states.
import { describe, it, expect, beforeEach } from 'vitest';
import { MwaClient, type Job, type JobState, type Turn } from '../web/src/v2/api/client';
import { V2Store, type StoreEnv, type StreamLike, type OutboxEntry } from '../web/src/v2/store/core';
import { MemoryCache } from '../web/src/v2/store/cache';
import { pillFor, groupJobs, monthLine } from '../web/src/v2/store/status';

// ---------- fakes ----------
function job(id: string, state: JobState, extra: Partial<Job> = {}): Job {
  return {
    id, kind: 'background', title: `Job ${id}`, request: null, projectId: null, createdAt: Date.UTC(2026, 10, 2), updatedSeq: 1, lifecycle: 'active',
    status: { state, label: state, detail: '' }, progress: null, remaining: null, whereItStands: null, seenAt: null, capUsd: null, costUsd: 0, tries: 1,
    archived: false, scheduleId: null, goalId: null, session: null, nextRunAt: null, estimate: null, estimateVsActual: null, ...extra,
  };
}
function turn(id: string, projectId: string, ts: number, extra: Partial<Turn> = {}): Turn {
  return { id, projectId, kind: 'chat', ts, message: `m${id}`, reply: `r${id}`, truncated: false, reason: null, tainted: false, runId: null, tryId: null, about: null, provenance: [], offer: null, legacySession: null, movedFrom: null, updatedSeq: ts, ...extra };
}

class FakeES implements StreamLike {
  readyState = 0;
  onerror: ((e: Event) => void) | null = null;
  closed = false;
  ls = new Map<string, ((e: MessageEvent) => void)[]>();
  constructor(public url: string) {}
  addEventListener(t: string, fn: (e: MessageEvent) => void) { this.ls.set(t, [...(this.ls.get(t) ?? []), fn]); }
  close() { this.closed = true; this.readyState = 2; }
  emit(t: string, data: unknown, id?: number) {
    this.readyState = 1;
    for (const fn of this.ls.get(t) ?? []) fn(new MessageEvent(t, { data: JSON.stringify(data), lastEventId: id ? String(id) : '' }));
  }
  drop() { this.readyState = 2; this.onerror?.(new Event('error')); }
  blip() { this.readyState = 0; this.onerror?.(new Event('error')); }
}

interface Call { method: string; path: string; query: URLSearchParams; key?: string; body?: unknown }
type Handler = (c: Call) => { status: number; body?: unknown } | 'network';

function harness(opts: { cache?: MemoryCache; online?: boolean } = {}) {
  const calls: Call[] = [];
  const handlers: [RegExp | string, Handler][] = [];
  let online = opts.online ?? true;
  const on = (method: string, path: RegExp | string, h: Handler) => handlers.unshift([typeof path === 'string' ? `${method} ${path}` : new RegExp(`^${method} ${path.source}`), h]);
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x');
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers ?? {});
    const c: Call = { method, path: u.pathname.replace('/api/v1', ''), query: u.searchParams, key: headers.get('idempotency-key') ?? undefined, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined };
    if (!online) throw new TypeError('Failed to fetch');
    calls.push(c);
    const k = `${method} ${c.path}`;
    const h = handlers.find(([p]) => (typeof p === 'string' ? p === k : p.test(k)));
    const r = h ? h[1](c) : { status: 404, body: { error: { code: 'not_found', message: 'No such endpoint.' } } };
    if (r === 'network') throw new TypeError('Failed to fetch');
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  const listeners = new Map<string, Set<() => void>>();
  const env: StoreEnv = {
    online: () => online,
    visible: () => true,
    on(ev, fn) { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev)!.add(fn); return () => listeners.get(ev)!.delete(fn); },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  };
  const fire = (ev: 'online' | 'offline' | 'visible') => { for (const fn of listeners.get(ev) ?? []) fn(); };
  const streams: FakeES[] = [];
  const cache = opts.cache ?? new MemoryCache();
  const client = new MwaClient({ fetch: f, sleep: async () => {} });
  const store = new V2Store({ client, cache, env, stream: (url) => { const s = new FakeES(url); streams.push(s); return s; }, backoff: [5], now: () => Date.UTC(2026, 10, 9, 14, 10) });
  on('GET', '/meta', () => ({ status: 200, body: { api: 'v1', server: '0.9.1', minClient: '1.0.0', secure: true, features: ['jobs', 'calendar', 'mail', 'projects'], importing: null } }));
  return {
    store, cache, calls, streams, on, fire,
    setOnline(v: boolean) { online = v; fire(v ? 'online' : 'offline'); },
    syncs: () => calls.filter((c) => c.path === '/sync'),
    last: () => streams[streams.length - 1],
  };
}
const syncBody = (cursor: number, o: { reset?: boolean; more?: boolean; jobs?: Job[]; deletes?: string[]; turns?: Turn[] } = {}) => ({
  status: 200, body: { cursor, reset: !!o.reset, more: !!o.more, upserts: { jobs: o.jobs ?? [], calendar: [], projects: [], turns: o.turns ?? [] }, deletes: { jobs: o.deletes ?? [], calendar: [], projects: [], turns: [] } },
});
const until = async (cond: () => boolean, ms = 1_000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 2)); } };

// ---------- the stream and catch-up ----------
describe('the live stream and /sync catch-up', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => { h = harness(); });

  it('starts from the cached state and cursor, catches up from it, and opens the stream there', async () => {
    await h.cache.setMeta({ cursor: 41, updatedAt: 1 });
    await h.cache.put('jobs', [{ key: 'old', value: job('old', 'done') }]);
    h.on('GET', '/sync', (c) => (c.query.get('since') === '41' ? syncBody(45, { jobs: [job('a', 'working')] }) : syncBody(0)));
    await h.store.start();
    expect(h.store.getState().jobs.old).toBeTruthy(); // the cache came first
    expect(h.syncs()[0].query.get('since')).toBe('41');
    expect(h.syncs()[0].query.get('collections')).toBe('jobs,calendar,projects,turns');
    expect(h.store.getState().jobs.a.status.state).toBe('working');
    expect(h.last().url).toBe('/api/v1/stream?cursor=45');
    h.last().emit('hello', { cursor: 45, head: 45 });
    expect(h.store.getState().connection).toBe('live');
  });

  it('applies changes, moves and saves the cursor, and resumes from it after the stream closes', async () => {
    h.on('GET', '/sync', (c) => syncBody(c.query.get('since') ? Number(c.query.get('since')) : 10));
    await h.store.start();
    const es = h.last();
    es.emit('hello', { cursor: 10, head: 10 });
    es.emit('change', { seq: 11, entity: 'job', id: 'j1', op: 'upsert', data: job('j1', 'working') }, 11);
    es.emit('change', { seq: 12, entity: 'job', id: 'j1', op: 'upsert', data: job('j1', 'waiting') }, 12);
    es.emit('live', { session: 'job_j1', type: 'step', stage: { n: 2 }, at: 5 });
    await h.store.idle();
    expect(h.store.getState().jobs.j1.status.state).toBe('waiting');
    expect(h.store.getState().live.job_j1.type).toBe('step');
    expect(h.store.getState().cursor).toBe(12);
    expect(await h.cache.getMeta('cursor')).toBe(12);
    expect((await h.cache.all<Job>('jobs')).map((j) => j.status.state)).toEqual(['waiting']);
    es.emit('change', { seq: 13, entity: 'job', id: 'j1', op: 'delete' }, 13);
    expect(h.store.getState().jobs.j1).toBeUndefined();

    es.drop(); // the server went away: the store reconnects itself, catching up from the saved cursor first
    await until(() => h.streams.length === 2);
    expect(h.syncs().at(-1)!.query.get('since')).toBe('13');
    expect(h.last().url).toBe('/api/v1/stream?cursor=13');
    expect(es.closed).toBe(true);
  });

  it('catches up through /sync when the browser reconnects the stream by itself (a second hello)', async () => {
    h.on('GET', '/sync', () => syncBody(20));
    await h.store.start();
    const es = h.last();
    es.emit('hello', { cursor: 20, head: 20 });
    const before = h.syncs().length;
    es.blip(); // EventSource retries on its own, with Last-Event-ID
    expect(h.store.getState().connection).toBe('connecting');
    es.emit('hello', { cursor: 20, head: 20 });
    await h.store.idle();
    expect(h.syncs().length).toBe(before + 1);
    expect(h.streams.length).toBe(1); // the same EventSource
  });

  it('on `reset`, takes a snapshot that replaces what the device held', async () => {
    let snap = false;
    h.on('GET', '/sync', (c) => {
      if (!c.query.get('since')) { snap = true; return syncBody(90, { reset: true, jobs: [job('fresh', 'done')] }); }
      return syncBody(5, { jobs: [job('stale', 'working')] });
    });
    await h.cache.setMeta({ cursor: 3 });
    await h.store.start();
    expect(h.store.getState().jobs.stale).toBeTruthy();
    h.last().emit('reset', { cursor: 90, reason: 'Too much changed while you were away. Sync again.' });
    await until(() => snap);
    await h.store.idle();
    expect(Object.keys(h.store.getState().jobs)).toEqual(['fresh']);
    expect((await h.cache.all<Job>('jobs')).map((j) => j.id)).toEqual(['fresh']);
    expect(h.store.getState().cursor).toBe(90);
  });

  it('a cache filled by a fixture server is replaced by a snapshot when a real helper answers', async () => {
    await h.cache.setMeta({ cursor: 42, meta: { api: 'v1', server: 'fixtures', minClient: '1.0.0', secure: true, features: [], importing: null } });
    await h.cache.put('jobs', [{ key: 'j_news', value: job('j_news', 'working') }]);
    h.on('GET', '/sync', (c) => (c.query.get('since') ? syncBody(50, { jobs: [] }) : syncBody(7, { reset: true, jobs: [job('real', 'done')] })));
    await h.store.start();
    expect(h.syncs()[0].query.get('since')).toBeNull();
    expect(Object.keys(h.store.getState().jobs)).toEqual(['real']);
    expect(h.store.getState().fixtures).toBe(false);
  });

  it('pages through /sync while `more` is true', async () => {
    await h.cache.setMeta({ cursor: 10 });
    h.on('GET', '/sync', (c) => {
      const s = c.query.get('since');
      if (s === '10') return syncBody(20, { more: true, jobs: [job('p1', 'done')] });
      if (s === '20') return syncBody(25, { jobs: [job('p2', 'done')], deletes: ['p1'] });
      return syncBody(0);
    });
    await h.store.start();
    expect(h.syncs().map((c) => c.query.get('since'))).toEqual(['10', '20']);
    expect(Object.keys(h.store.getState().jobs)).toEqual(['p2']);
    expect(h.store.getState().cursor).toBe(25);
  });

  it('keeps each thread to its last 50 turns, moves a turn between threads, and never lets a summary replace a whole turn', async () => {
    const many = Array.from({ length: 55 }, (_, i) => turn(`t${i}`, 'p1', 1000 + i));
    h.on('GET', '/sync', () => syncBody(5, { reset: true, turns: many }));
    await h.store.start();
    expect(h.store.getState().threads.p1).toHaveLength(50);
    expect(h.store.getState().threads.p1[0].id).toBe('t5');
    const es = h.last();
    es.emit('change', { seq: 6, entity: 'turn', id: 't54', op: 'upsert', data: turn('t54', 'p2', 1054, { movedFrom: 'p1' }) }, 6);
    expect(h.store.getState().threads.p1.map((t) => t.id)).not.toContain('t54');
    expect(h.store.getState().threads.p2.map((t) => t.id)).toEqual(['t54']);
    const whole = turn('t53', 'p1', 1053, { reply: 'x'.repeat(900), updatedSeq: 7 });
    es.emit('change', { seq: 7, entity: 'turn', id: 't53', op: 'upsert', data: whole }, 7);
    es.emit('change', { seq: 8, entity: 'turn', id: 't53', op: 'upsert', data: { ...whole, reply: 'x'.repeat(500), truncated: true } }, 8);
    expect(h.store.getState().threads.p1.find((t) => t.id === 't53')!.reply).toHaveLength(900);
    await h.store.idle();
    expect((await h.cache.all<{ projectId: string; turns: Turn[] }>('threads')).find((t) => t.projectId === 'p2')!.turns).toHaveLength(1);
  });
});

// ---------- the outbox ----------
describe('the outbox', () => {
  it('queues an action made offline with its key, and replays it with the same key when back online', async () => {
    const cache = new MemoryCache();
    const h = harness({ cache, online: false });
    h.on('GET', '/sync', () => syncBody(5, { jobs: [job('j1', 'working')] }));
    h.on('POST', /\/jobs\/[^/]+\/stop/, () => ({ status: 200, body: { job: job('j1', 'stopped_by_you'), tries: [], message: 'Stopped.' } }));
    await cache.put('jobs', [{ key: 'j1', value: job('j1', 'working') }]);
    await h.store.start();
    expect(h.store.getState().connection).toBe('offline');
    const r = await h.store.act('job.stop', { id: 'j1' }, 'Stop “Job j1”');
    expect(r).toMatchObject({ ok: false, queued: true });
    await h.store.idle();
    const [queued] = await cache.all<OutboxEntry>('outbox');
    expect(queued.key).toMatch(/^[0-9A-Z]{26}$/);
    expect(h.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(h.store.getState().notices.at(-1)!.text).toMatch(/offline/);

    h.setOnline(true);
    await until(() => h.store.getState().outbox.length === 0);
    await h.store.idle();
    const posts = h.calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => [c.path, c.key])).toEqual([['/jobs/j1/stop', queued.key]]);
    expect(h.store.getState().jobs.j1.status.state).toBe('stopped_by_you');
    expect(await cache.all('outbox')).toEqual([]);
  });

  it('keeps the same key across failed replays, and a reloaded app replays what the last one queued', async () => {
    const cache = new MemoryCache();
    const h = harness({ cache });
    let fail = true;
    h.on('GET', '/sync', () => syncBody(5));
    h.on('POST', /\/calendar\/drafts\/[^/]+\/confirm/, () => (fail ? 'network' : { status: 200, body: { draft: { id: 'cd_1', kind: 'draft', title: 'Book fair', start: 'a', end: 'b', allDay: false, location: null, provider: 'google', state: 'confirmed' }, message: 'Added by your helper just now. No invites were sent.' } }));
    await h.store.start();
    const r = await h.store.act('draft.confirm', { id: 'cd_1' }, 'Confirm “Book fair”');
    expect(r.queued).toBe(true); // the network failed mid-request: kept, not lost
    h.fire('visible');
    await h.store.idle();
    expect(h.store.getState().outbox).toHaveLength(1);
    expect(h.store.getState().outbox[0].attempts).toBe(1);
    h.store.stop();

    // the app is closed and opened again
    fail = false;
    const h2 = harness({ cache });
    h2.on('GET', '/sync', () => syncBody(5));
    h2.on('POST', /\/calendar\/drafts\/[^/]+\/confirm/, () => ({ status: 200, body: { draft: { id: 'cd_1', kind: 'draft', title: 'Book fair', start: 'a', end: 'b', allDay: false, location: null, provider: 'google', state: 'confirmed' }, message: 'Added.' } }));
    await h2.store.start();
    await until(() => h2.store.getState().outbox.length === 0);
    const keys = [...h.calls, ...h2.calls].filter((c) => c.method === 'POST').map((c) => c.key);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
  });

  it('a 409 during replay drops the action and shows what the server holds now', async () => {
    const h = harness({ online: false });
    h.on('GET', '/sync', () => syncBody(5));
    h.on('POST', /\/jobs\/[^/]+\/continue/, () => ({ status: 409, body: { error: { code: 'running', message: 'It is already working.' } } }));
    h.on('GET', /\/jobs\/j9$/, () => ({ status: 200, body: { job: job('j9', 'working'), tries: [] } }));
    await h.store.start();
    await h.store.act('job.continue', { id: 'j9' }, 'Continue “Job j9”');
    h.setOnline(true);
    await until(() => h.store.getState().outbox.length === 0);
    await h.store.idle();
    expect(h.store.getState().jobs.j9.status.state).toBe('working');
    expect(h.store.getState().notices.map((n) => n.text)).toContain('Continue “Job j9”: It is already working.');
  });

  it('a 409 on a live action also refreshes the job and says why', async () => {
    const h = harness();
    h.on('GET', '/sync', () => syncBody(5, { jobs: [job('j2', 'waiting')] }));
    h.on('POST', /\/jobs\/[^/]+\/continue/, () => ({ status: 409, body: { error: { code: 'running', message: 'It is already working.' } } }));
    h.on('GET', /\/jobs\/j2$/, () => ({ status: 200, body: { job: job('j2', 'working'), tries: [] } }));
    await h.store.start();
    const r = await h.store.act('job.continue', { id: 'j2' }, 'Continue');
    expect(r).toMatchObject({ ok: false, queued: false, code: 'running', message: 'It is already working.' });
    expect(h.store.getState().jobs.j2.status.state).toBe('working');
  });
});

// ---------- 426 and 401 ----------
describe('a server that wants a newer app, or a sign-in', () => {
  it('426 on catch-up: "A newer version is ready", no stream, nothing more is sent', async () => {
    const h = harness();
    h.on('GET', '/sync', () => ({ status: 426, body: { error: { code: 'client_too_old', message: 'A newer version of the app is needed. Reload to update.' } } }));
    await h.store.start();
    expect(h.store.getState().updateReady).toBe(true);
    expect(h.streams).toHaveLength(0);
    const r = await h.store.act('job.stop', { id: 'j1' }, 'Stop');
    expect(r.queued).toBe(true); // kept for after the reload
    await h.store.replayOutbox();
    expect(h.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('426 on an action: the action waits in the outbox and the app offers the reload', async () => {
    const h = harness();
    h.on('GET', '/sync', () => syncBody(1));
    h.on('POST', /\/jobs\/[^/]+\/open/, () => ({ status: 426, body: { error: { code: 'client_too_old', message: 'A newer version of the app is needed. Reload to update.' } } }));
    await h.store.start();
    const r = await h.store.act('job.open', { id: 'j1' }, 'Open');
    expect(r.queued).toBe(true);
    expect(h.store.getState().updateReady).toBe(true);
    expect(h.store.getState().outbox).toHaveLength(1);
  });

  it('401 asks to sign in or pair again', async () => {
    const h = harness();
    h.on('GET', '/sync', () => ({ status: 401, body: { error: { code: 'locked', message: 'Sign in to continue.' } } }));
    await h.store.start();
    expect(h.store.getState().auth).toBe('signin');
    expect(h.streams).toHaveLength(0);
  });

  it('a server that cannot be reached is retried, and the cache is what shows meanwhile', async () => {
    const cache = new MemoryCache();
    await cache.put('jobs', [{ key: 'c', value: job('c', 'working') }]);
    const h = harness({ cache });
    let down = true;
    h.on('GET', '/sync', () => (down ? 'network' : syncBody(3)));
    await h.store.start();
    expect(h.store.getState().connection).toBe('unreachable');
    expect(h.store.getState().jobs.c).toBeTruthy();
    down = false;
    await until(() => h.streams.length === 1);
  });
});

// ---------- the pill and the working sheet ----------
describe('the status pill and the working sheet, from the server\'s eight job states', () => {
  const ALL: JobState[] = ['working', 'waiting', 'continuing', 'stopped_by_you', 'partly_done', 'stopped', 'scheduled', 'done'];
  const one = (state: JobState, extra: Partial<Job> = {}) => [job('x', state, extra)];

  it('each state alone', () => {
    const expected: Record<JobState, string> = {
      working: 'Working on 1 thing', continuing: 'Working on 1 thing', waiting: '1 waiting for you',
      stopped_by_you: 'Helper is resting', partly_done: 'Helper is resting', stopped: 'Helper is resting', scheduled: 'Helper is resting', done: 'Helper is resting',
    };
    for (const s of ALL) expect(`${s}: ${pillFor(one(s)).text}`).toBe(`${s}: ${expected[s]}`);
    expect(pillFor(one('done', { status: { state: 'done', label: 'Result ready', detail: '', resultReady: true } })).text).toBe('1 result ready');
    expect(pillFor([]).text).toBe('Helper is resting');
  });

  it('the prototype\'s combinations, and the tone', () => {
    const w = (id: string) => job(id, 'working'), wait = (id: string) => job(id, 'waiting');
    const ready = (id: string) => job(id, 'done', { status: { state: 'done', label: 'Result ready', detail: '', resultReady: true } });
    expect(pillFor([w('a'), w('b')])).toMatchObject({ text: 'Working on 2 things', tone: 'working' });
    expect(pillFor([w('a'), wait('b')])).toMatchObject({ text: 'Working on 1 · 1 waiting for you', tone: 'needs' });
    expect(pillFor([w('a'), ready('b')])).toMatchObject({ text: 'Working on 1 · 1 result ready', tone: 'needs' });
    expect(pillFor([ready('a'), ready('b')]).text).toBe('2 results ready');
    expect(pillFor([w('a'), wait('b'), ready('c')]).text).toBe('Working on 1 · 1 waiting for you · 1 result ready');
    expect(pillFor([job('z', 'stopped')])).toMatchObject({ tone: 'resting' });
    expect(pillFor([job('arch', 'working', { archived: true })]).text).toBe('Helper is resting');
  });

  it('groups: the pill\'s numbers are the group sizes, and every state lands in exactly one group', () => {
    const jobs = ALL.map((s, i) => job(`j${i}`, s, { updatedSeq: i, ...(s === 'done' ? { status: { state: 'done' as const, label: 'Result ready', detail: '', resultReady: true } } : {}) }));
    const groups = groupJobs(jobs);
    expect(groups.map((g) => `${g.title} · ${g.jobs.length}`)).toEqual(['Waiting for you · 1', 'Working now · 2', 'Finished · 1', 'Stopped · 3', 'Scheduled · 1']);
    expect(groups.flatMap((g) => g.jobs).length).toBe(ALL.length);
    const pill = pillFor(jobs);
    expect(pill.waiting).toBe(groups.find((g) => g.key === 'waiting')!.jobs.length);
    expect(pill.working).toBe(groups.find((g) => g.key === 'working')!.jobs.length);
  });

  it('lists every result not opened, and only the latest few finished and stopped', () => {
    const done = Array.from({ length: 9 }, (_, i) => job(`d${i}`, 'done', { updatedSeq: i }));
    const ready = job('r', 'done', { updatedSeq: 0, status: { state: 'done', label: 'Result ready', detail: '', resultReady: true } });
    const g = groupJobs([...done, ready]).find((x) => x.key === 'finished')!;
    expect(g.jobs.map((j) => j.id)).toEqual(['r', 'd8', 'd7', 'd6', 'd5']);
  });

  it('the month line counts this month\'s jobs, archived ones too', () => {
    const now = Date.UTC(2026, 10, 9, 15);
    const jobs = [job('a', 'done', { costUsd: 1.25, archived: true, createdAt: Date.UTC(2026, 10, 3, 12) }), job('b', 'working', { costUsd: 0.04, createdAt: Date.UTC(2026, 10, 9, 12) }), job('c', 'done', { costUsd: 9, createdAt: Date.UTC(2026, 9, 20) })];
    expect(monthLine(jobs, now)).toBe('$1.29 on jobs this month');
    expect(monthLine(jobs, now, 20)).toBe('$1.29 on jobs this month · limit $20');
  });
});
