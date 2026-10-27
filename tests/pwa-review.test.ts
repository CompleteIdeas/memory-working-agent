// v2 build, P1/P2 review fixes (the store and page side): v1's reload-on-401 at most once (fix 1), "Updating…" gives up
// after ~20 s (fix 4), Reload never drops an action on its way (fix 5), and a 401 clears the device's copy (fix 7).
// The service-worker halves are browser-tested in scripts/v2-p1p2-smoke.mjs and the review's probe-sw.mjs.
import { describe, it, expect } from 'vitest';
import { onLocked } from '../web/src/locked';
import { initialUpdate, reduceUpdate, updateWords, type UpdateEvent, type UpdateState, type Effect } from '../web/src/pwa/update';
import { MwaClient } from '../web/src/v2/api/client';
import { V2Store, SIGNED_OUT_CLEARED, type SignedOutFlag, type StoreEnv, type StreamLike } from '../web/src/v2/store/core';
import { MemoryCache } from '../web/src/v2/store/cache';
import { FixtureServer, FixtureEventSource, fixtureFetch } from '../web/src/v2/dev/fixtures';
import { FIXTURE_NOW } from '../web/src/v2/dev/fixture-data';

describe('fix 1: v1 reloads on a 401 at most once per session, then shows sign-in', () => {
  function env() {
    const store = new Map<string, string>();
    const log: string[] = [];
    return { log, e: { get: () => store.get('k') ?? null, set: (v: string) => { store.set('k', v); }, reload: () => log.push('reload'), showSignIn: () => log.push('sign-in') } };
  }
  it('first 401: one reload; every later 401 in the session: the sign-in notice, never another reload', () => {
    const { log, e } = env();
    expect(onLocked(e)).toBe('reload');
    for (let i = 0; i < 5; i++) onLocked(e);
    expect(log).toEqual(['reload', 'sign-in', 'sign-in', 'sign-in', 'sign-in', 'sign-in']);
  });
  it('no session storage (blocked): never risk a loop — the sign-in notice', () => {
    const log: string[] = [];
    expect(onLocked({ get: () => { throw new Error('blocked'); }, set: () => {}, reload: () => log.push('reload'), showSignIn: () => log.push('sign-in') })).toBe('sign-in');
    expect(log).toEqual(['sign-in']);
  });
});

describe('fix 4: "Updating…" gives up after ~20 s and says so', () => {
  const play = (events: UpdateEvent[], from: UpdateState = initialUpdate) => {
    let s = from; const effects: Effect[] = [];
    for (const e of events) { const r = reduceUpdate(s, e); s = r.state; effects.push(...r.effects); }
    return { s, effects };
  };
  it('Reload arms the give-up timer; nothing arrived: "Couldn’t get the update — try again", and the button works again', () => {
    const a = play([{ type: 'server-too-old' }, { type: 'apply' }]);
    expect(a.effects).toEqual(['check', 'check', 'arm-give-up']);
    expect(updateWords(a.s)!.text).toBe('Updating…');
    const b = play([{ type: 'give-up' }], a.s);
    expect(b.s.phase).toBe('ready');
    expect(updateWords(b.s)).toEqual({ text: 'Couldn’t get the update — try again', button: 'Try again' });
    const c = play([{ type: 'apply' }], b.s);
    expect(c.s.phase).toBe('applying');
    expect(c.s.failed).toBe(false);
  });
  it('a late give-up after the reload started changes nothing', () => {
    const a = play([{ type: 'waiting', pageRunsIt: false }, { type: 'apply' }, { type: 'controller-changed', hadController: true }, { type: 'give-up' }]);
    expect(a.s.phase).toBe('reloading');
    expect(a.effects.filter((e) => e === 'reload')).toHaveLength(1);
  });
});

// a store against the fixture world that looks like a real server (so it is not in fixture mode), with knobs
function world(o: { cache?: MemoryCache; flag?: SignedOutFlag; online?: boolean } = {}) {
  const fx = new FixtureServer('N00');
  let online = o.online ?? true, locked = false, hold: ((r: Response) => void)[] | null = null;
  const base = fixtureFetch(fx);
  const calls: { method: string; url: string; key?: string }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!online) throw new TypeError('Failed to fetch');
    const url = String(input), method = init?.method ?? 'GET';
    calls.push({ method, url, key: new Headers(init?.headers ?? {}).get('idempotency-key') ?? undefined });
    if (locked) return new Response(JSON.stringify({ error: { code: 'locked', message: 'Sign in to continue.' } }), { status: 401 });
    if (hold && method === 'POST') return new Promise<Response>((r) => hold!.push(r));
    const res = await base(input, init);
    if (url.endsWith('/meta')) { const j = await res.json(); return new Response(JSON.stringify({ ...j, server: '0.9.1' }), { status: 200 }); }
    return res;
  }) as typeof fetch;
  const listeners = new Map<string, Set<() => void>>();
  const env: StoreEnv = {
    online: () => online, visible: () => true,
    on(ev, fn) { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev)!.add(fn); return () => listeners.get(ev)!.delete(fn); },
    setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  };
  let flagOn = false;
  const flag: SignedOutFlag = o.flag ?? { get: () => flagOn, set: (v) => { flagOn = v; } };
  const cache = o.cache ?? new MemoryCache();
  const store = new V2Store({ client: new MwaClient({ fetch: f, sleep: async () => {} }), cache, env, stream: (u) => new FixtureEventSource(fx, u) as unknown as StreamLike, now: () => FIXTURE_NOW, backoff: [5], signedOutFlag: flag });
  return {
    fx, store, cache, calls, flag,
    lock() { locked = true; },
    holdPosts() { hold = []; },
    release() { const h = hold ?? []; hold = null; return h; },
    setOnline(v: boolean) { online = v; for (const fn of listeners.get(v ? 'online' : 'offline') ?? []) fn(); },
  };
}
async function until(cond: () => boolean, ms = 3_000) {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 10)); }
}

describe('fix 5: Reload never drops an action on its way', () => {
  it('an action still in flight is put in the outbox with its key (saved), and sent again after the "reload" with the same key', async () => {
    const w = world();
    await w.store.start();
    await until(() => w.store.getState().connection === 'live');
    w.holdPosts();
    const job = Object.values(w.store.getState().jobs)[0];
    void w.store.act('job.open', { id: job.id }, 'Open');
    await until(() => w.store.getState().inflight.length === 1);
    const key = w.store.getState().inflight[0].key;
    expect(await w.store.parkInflight()).toBe(1);
    const saved = await w.cache.all<{ key: string; kind: string }>('outbox');
    expect(saved).toEqual([expect.objectContaining({ key, kind: 'job.open' })]);
    // the page reloads: a new store on the same device cache sends it again with the SAME key
    w.release();
    const again = world({ cache: w.cache });
    await again.store.start();
    await until(() => again.calls.some((c) => c.method === 'POST' && c.url.includes(`/jobs/${job.id}/open`)));
    expect(again.calls.find((c) => c.method === 'POST')!.key).toBe(key);
    w.store.stop(); again.store.stop();
  });
  it('Stop and "Add to it" are about now: never parked', async () => {
    const w = world();
    await w.store.start();
    await until(() => w.store.getState().connection === 'live');
    w.holdPosts();
    void w.store.act('project.stop', { id: 'p-eventing', payload: {} }, 'Stop');
    await until(() => w.store.getState().inflight.length === 1);
    expect(await w.store.parkInflight()).toBe(0);
    expect(w.store.getState().outbox).toHaveLength(0);
    w.release(); w.store.stop();
  });
});

describe('fix 7: a 401 clears this device\'s copy', () => {
  it('the cached data and the outbox go (memory and IndexedDB), the person is told, and "signed out" is remembered', async () => {
    const w = world();
    await w.store.start();
    await until(() => w.store.getState().connection === 'live' && Object.keys(w.store.getState().jobs).length > 0);
    w.setOnline(false);
    await w.store.act('job.open', { id: Object.keys(w.store.getState().jobs)[0] }, 'Open');
    await w.store.idle();
    expect((await w.cache.all('jobs')).length).toBeGreaterThan(0);
    expect((await w.cache.all('outbox')).length).toBe(1);
    w.lock();
    w.setOnline(true);
    await until(() => w.store.getState().auth === 'signin');
    await until(() => w.store.getState().notices.some((n) => n.text === SIGNED_OUT_CLEARED));
    await w.store.idle();
    const s = w.store.getState();
    expect(Object.keys(s.jobs)).toHaveLength(0);
    expect(s.outbox).toHaveLength(0);
    for (const n of ['jobs', 'projects', 'calendar', 'threads', 'outbox', 'today', 'items'] as const) expect(await w.cache.all(n)).toEqual([]);
    expect(w.flag.get()).toBe(true);
    w.store.stop();
  });
  it('an action refused with 401 says so (not "saved")', async () => {
    const w = world();
    await w.store.start();
    await until(() => w.store.getState().connection === 'live');
    w.lock();
    const r = await w.store.act('job.open', { id: Object.keys(w.store.getState().jobs)[0] }, 'Open');
    expect(r).toMatchObject({ ok: false, queued: false, code: 'locked' });
    expect(r.message).toContain(SIGNED_OUT_CLEARED);
    w.store.stop();
  });
  it('offline, last known "signed out": nothing cached is shown — the sign-in screen', async () => {
    const cache = new MemoryCache();
    await cache.put('jobs', [{ key: 'old', value: { id: 'old' } }]);
    let on = true;
    const w = world({ cache, online: false, flag: { get: () => on, set: (v) => { on = v; } } });
    await w.store.start();
    expect(w.store.getState().auth).toBe('signin');
    expect(w.store.getState().jobs).toEqual({});
    expect(await cache.all('jobs')).toEqual([]);
    w.store.stop();
  });
  it('signed in again (a good connect) forgets "signed out"', async () => {
    let on = true;
    const w = world({ flag: { get: () => on, set: (v) => { on = v; } } });
    await w.store.start();
    await until(() => w.store.getState().connection === 'live');
    expect(on).toBe(false);
    w.store.stop();
  });
});
