// v2 build, slices P1/P2: the service worker. Its decisions (web/src/pwa/sw-logic.ts) as a table, the build step that
// lists the files (web/vite-pwa.ts), and the worker itself (web/src/pwa/sw.ts) run against a fake CacheStorage and
// network: the shell is cached all or nothing, pages are network-first with the cached shell offline, /api is never
// touched, old caches go (but the one before stays), and a new worker waits for SKIP_WAITING.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  route, cachesToDelete, acceptable, pageAnswer, precacheUrls, cacheName, CACHE_PREFIX, PRECACHE_HEADER, NAV_TIMEOUT_MS, type BuildInfo,
} from '../web/src/pwa/sw-logic';
import { buildInfo, entryOf } from '../web/vite-pwa';

const SCOPE = 'https://mwa.tail1a2b.ts.net/';
const PRE = new Set([`${SCOPE}index.html`, `${SCOPE}assets/index-AbCd1234.js`, `${SCOPE}manifest-v2.webmanifest`]);

describe('route: what the worker does with each request', () => {
  const r = (url: string, mode = 'cors', method = 'GET') => route({ method, url, mode }, SCOPE, PRE).kind;
  it('never touches the API, the SSE stream, sign-in, writes, other sites or the worker itself', () => {
    expect(r(`${SCOPE}api/v1/sync`)).toBe('pass');
    expect(r(`${SCOPE}api/v1/stream?cursor=4`)).toBe('pass');
    expect(r(`${SCOPE}api/login`, 'cors', 'POST')).toBe('pass');
    expect(r(`${SCOPE}api/chat?q=x`, 'navigate')).toBe('pass'); // even a navigation
    expect(r(`${SCOPE}api`, 'navigate')).toBe('pass');
    expect(r(`${SCOPE}assets/index-AbCd1234.js`, 'cors', 'POST')).toBe('pass');
    expect(r('https://fonts.googleapis.com/css2', 'no-cors')).toBe('pass');
    expect(r(`${SCOPE}sw.js`)).toBe('pass');
    expect(r(`${SCOPE}__fixtures/reset`)).toBe('pass');
  });
  it('pages (v1 and v2 alike) are network-first with the shell behind them; files and share links are not', () => {
    for (const u of ['', '?ui=v2', '?ui=v2&source=pwa&ask=1', 'pair', 'view?path=a.md', 'index.html', '?ui=v1']) expect(r(`${SCOPE}${u}`, 'navigate')).toBe('page');
    expect(r(`${SCOPE}s/abc123`, 'navigate')).toBe('pass');
    expect(r(`${SCOPE}report.pdf`, 'navigate')).toBe('pass');
    expect(r(`${SCOPE}review-guide.html`, 'navigate')).toBe('pass');
  });
  it('precached files come from the cache (the query string ignored); another build\'s hashed file from any cache', () => {
    expect(route({ method: 'GET', url: `${SCOPE}assets/index-AbCd1234.js?v=1` }, SCOPE, PRE)).toEqual({ kind: 'precached', key: `${SCOPE}assets/index-AbCd1234.js` });
    expect(r(`${SCOPE}manifest-v2.webmanifest`)).toBe('precached');
    expect(r(`${SCOPE}assets/index-OlderOne9.js`)).toBe('asset');
    expect(r(`${SCOPE}icon-999.png`)).toBe('pass');
  });
  it('outside the worker\'s scope: not touched', () => {
    expect(route({ method: 'GET', url: 'https://mwa.tail1a2b.ts.net/other/x', mode: 'navigate' }, 'https://mwa.tail1a2b.ts.net/app/', new Set()).kind).toBe('pass');
  });
});

describe('caches, answers and acceptance', () => {
  it('on activate: keeps this build and the one before it, removes older ones and v1\'s runtime cache, leaves others alone', () => {
    const keys = ['mwa-shell-v2', `${CACHE_PREFIX}aaa`, `${CACHE_PREFIX}bbb`, 'someone-else', `${CACHE_PREFIX}ccc`];
    expect(cachesToDelete(keys, `${CACHE_PREFIX}ccc`)).toEqual(['mwa-shell-v2', `${CACHE_PREFIX}aaa`]);
    expect(cachesToDelete([`${CACHE_PREFIX}ccc`], `${CACHE_PREFIX}ccc`)).toEqual([]);
    expect(cacheName('abc')).toBe(`${CACHE_PREFIX}abc`);
  });
  it('a page: the network unless it failed, was slow, or the server behind the proxy is down (5xx)', () => {
    expect(pageAnswer({ status: 200 }, true)).toBe('network');
    expect(pageAnswer({ status: 401 }, true)).toBe('network'); // a sign-in page is the server's answer
    expect(pageAnswer({ status: 502 }, true)).toBe('shell');
    expect(pageAnswer({ status: 502 }, false)).toBe('network');
    expect(pageAnswer('failed', true)).toBe('shell');
    expect(pageAnswer('failed', false)).toBe('error');
    expect(pageAnswer('timeout', true)).toBe('shell');
    expect(pageAnswer('timeout', false)).toBe('network'); // nothing to show instead: keep waiting
  });
  it('index.html must be this build\'s page; every file a plain 200', () => {
    const info = { entry: 'assets/index-AbCd1234.js' };
    expect(acceptable({ url: 'index.html', rev: 'x' }, { ok: true, status: 200 }, '<script type="module" src="./assets/index-AbCd1234.js">', info)).toBeNull();
    expect(acceptable({ url: 'index.html', rev: 'x' }, { ok: true, status: 200 }, '<form>Unlock</form>', info)).toMatch(/not this build/);
    expect(acceptable({ url: 'assets/a-12345678.js', rev: null }, { ok: false, status: 404 }, null, info)).toMatch(/404/);
    expect(acceptable({ url: 'icon-192.png', rev: 'x' }, { ok: true, status: 200, redirected: true }, null, info)).toMatch(/redirected/);
  });
  it('precache URLs are absolute, beside the worker', () => {
    expect(precacheUrls({ files: [{ url: 'index.html', rev: 'a' }, { url: 'assets/x-12345678.js', rev: null }] }, SCOPE)).toEqual([`${SCOPE}index.html`, `${SCOPE}assets/x-12345678.js`]);
  });
});

describe('the build step (vite-pwa.ts)', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mwa-pwa-'));
    mkdirSync(join(dir, 'assets')); mkdirSync(join(dir, 'pwa'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><script type="module" crossorigin src="./assets/index-AbCd1234.js"></script>');
    writeFileSync(join(dir, 'assets', 'index-AbCd1234.js'), 'console.log(1)');
    writeFileSync(join(dir, 'assets', 'index-AbCd1234.js.map'), '{}');
    writeFileSync(join(dir, 'pwa', 'icon-192.png'), 'png');
    writeFileSync(join(dir, 'sw.js'), 'old worker');
    writeFileSync(join(dir, 'pwa-build.json'), '{}');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  it('lists every file but the worker, its facts and source maps; hashed names carry no revision', () => {
    const info = buildInfo(dir, '1.0.0');
    expect(info.entry).toBe('assets/index-AbCd1234.js');
    expect(info.files.map((f) => f.url).sort()).toEqual(['assets/index-AbCd1234.js', 'index.html', 'pwa/icon-192.png']);
    expect(info.files.find((f) => f.url === 'assets/index-AbCd1234.js')!.rev).toBeNull();
    expect(info.files.find((f) => f.url === 'index.html')!.rev).toMatch(/^[0-9a-f]{16}$/);
  });
  it('the build id changes when any file or the version changes, and only then', () => {
    const a = buildInfo(dir, '1.0.0').buildId;
    expect(buildInfo(dir, '1.0.0').buildId).toBe(a);
    expect(buildInfo(dir, '1.0.1').buildId).not.toBe(a);
    writeFileSync(join(dir, 'pwa', 'icon-192.png'), 'png2');
    expect(buildInfo(dir, '1.0.0').buildId).not.toBe(a);
  });
  it('finds the entry script whichever way Vite writes it', () => {
    expect(entryOf('<script type="module" crossorigin src="/assets/index-X1234567.js">')).toBe('assets/index-X1234567.js');
    expect(() => entryOf('<html></html>')).toThrow();
  });
});

// ---------- the worker itself, against fakes ----------
class FakeCache {
  m = new Map<string, { body: string; status: number; headers: Record<string, string> }>();
  private k(req: string | { url: string }) { return (typeof req === 'string' ? req : req.url).replace(/[?#].*$/, ''); }
  async match(req: string | { url: string }) { const v = this.m.get(this.k(req)); return v ? new Response(v.body, { status: v.status, headers: v.headers }) : undefined; }
  async put(req: string, res: Response) { this.m.set(this.k(req), { body: await res.text(), status: res.status, headers: Object.fromEntries(res.headers) }); }
}
class FakeCaches {
  stores = new Map<string, FakeCache>();
  failPut = false;
  async open(n: string) {
    if (!this.stores.has(n)) this.stores.set(n, new FakeCache());
    const c = this.stores.get(n)!;
    if (this.failPut) c.put = async () => { throw new Error('QuotaExceededError'); };
    return c;
  }
  async keys() { return [...this.stores.keys()]; }
  async delete(n: string) { return this.stores.delete(n); }
  async match(req: string | { url: string }) { for (const c of this.stores.values()) { const r = await c.match(req); if (r) return r; } return undefined; }
}

const INFO: BuildInfo = {
  buildId: 'b1', entry: 'assets/index-AbCd1234.js', version: '1.0.0',
  files: [{ url: 'index.html', rev: 'r1' }, { url: 'assets/index-AbCd1234.js', rev: null }, { url: 'manifest-v2.webmanifest', rev: 'r2' }],
};
const PAGE = `<!doctype html><div id="root"></div><script type="module" src="./assets/index-AbCd1234.js"></script>`;

type Handler = (e: Record<string, unknown>) => void;
async function loadWorker(net: (url: string, init?: RequestInit) => Promise<Response>, info = INFO) {
  vi.resetModules();
  const handlers: Record<string, Handler> = {};
  const self = {
    registration: { scope: SCOPE },
    skipWaiting: vi.fn(async () => {}),
    clients: { claim: vi.fn(async () => {}) },
    addEventListener: (t: string, f: Handler) => { handlers[t] = f; },
  };
  const caches = new FakeCaches();
  const seen: { url: string; headers: Record<string, string> }[] = [];
  vi.stubGlobal('self', self);
  vi.stubGlobal('caches', caches);
  vi.stubGlobal('__MWA_BUILD__', info);
  vi.stubGlobal('fetch', async (input: string | { url: string }, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    seen.push({ url, headers: Object.fromEntries(new Headers(init?.headers ?? {})) });
    return net(url, init);
  });
  await import('../web/src/pwa/sw');
  const run = async (type: string, extra: Record<string, unknown> = {}) => {
    let waited: Promise<unknown> | undefined, responded: Promise<Response> | Response | undefined;
    handlers[type]({ ...extra, waitUntil: (p: Promise<unknown>) => { waited = p; }, respondWith: (r: Promise<Response> | Response) => { responded = r; } });
    return { waited, responded };
  };
  const install = async () => { const { waited } = await run('install'); await waited; };
  const fetchEv = async (url: string, mode = 'cors', method = 'GET') => {
    const { responded } = await run('fetch', { request: { url, mode, method } });
    return responded === undefined ? undefined : await responded;
  };
  return { self, caches, seen, run, install, fetchEv };
}
const files: Record<string, string> = { [`${SCOPE}index.html`]: PAGE, [`${SCOPE}assets/index-AbCd1234.js`]: 'app()', [`${SCOPE}manifest-v2.webmanifest`]: '{}' };
const server = (over: Record<string, Response | 'down'> = {}) => async (url: string) => {
  const o = over[url.replace(/[?#].*$/, '')];
  if (o === 'down') throw new TypeError('Failed to fetch');
  if (o) return o.clone();
  const b = files[url.replace(/[?#].*$/, '')];
  return b === undefined ? new Response('not found', { status: 404 }) : new Response(b, { status: 200 });
};

describe('the worker (sw.ts) against a fake browser', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('install: caches every file of the build in its own cache; index.html is asked for with the precache header; no skipWaiting', async () => {
    const w = await loadWorker(server());
    await w.install();
    const c = w.caches.stores.get(cacheName('b1'))!;
    expect([...c.m.keys()].sort()).toEqual([`${SCOPE}assets/index-AbCd1234.js`, `${SCOPE}index.html`, `${SCOPE}manifest-v2.webmanifest`]);
    expect(w.seen.find((s) => s.url.endsWith('index.html'))!.headers[PRECACHE_HEADER]).toBe('precache');
    expect(w.self.skipWaiting).not.toHaveBeenCalled(); // a new worker waits for the page
  });
  it('install is all or nothing: one missing file, or a sign-in page for index.html, and no cache is left', async () => {
    const a = await loadWorker(server({ [`${SCOPE}assets/index-AbCd1234.js`]: new Response('gone', { status: 404 }) }));
    await expect(a.install()).rejects.toThrow(/404/);
    expect(await a.caches.keys()).toEqual([]);
    const b = await loadWorker(server({ [`${SCOPE}index.html`]: new Response('<form>Unlock</form>', { status: 200 }) }));
    await expect(b.install()).rejects.toThrow(/not this build/);
    expect(await b.caches.keys()).toEqual([]);
  });
  it('a storage failure half way through leaves no half-filled shell', async () => {
    const w = await loadWorker(server());
    w.caches.failPut = true;
    await expect(w.install()).rejects.toThrow(/Quota/);
    expect(await w.caches.keys()).toEqual([]);
  });
  it('pages: the network when it answers (a sign-in page too); the cached shell offline or on a 502', async () => {
    let mode: 'up' | 'down' | '502' | 'login' = 'up';
    const w = await loadWorker(async (url, init) => {
      if (mode === 'down') throw new TypeError('Failed to fetch');
      if (url === `${SCOPE}?ui=v2` && mode === '502') return new Response('bad gateway', { status: 502 });
      if (url === `${SCOPE}?ui=v2` && mode === 'login') return new Response('<form>Unlock</form>', { status: 200 });
      return server()(url, init);
    });
    await w.install();
    mode = 'login';
    expect(await (await w.fetchEv(`${SCOPE}?ui=v2`, 'navigate'))!.text()).toContain('Unlock');
    mode = 'down';
    expect(await (await w.fetchEv(`${SCOPE}?ui=v2`, 'navigate'))!.text()).toBe(PAGE);
    mode = '502';
    expect(await (await w.fetchEv(`${SCOPE}?ui=v2`, 'navigate'))!.text()).toBe(PAGE);
  });
  it('a slow network: the cached shell after the timeout', async () => {
    let slow = false;
    const w = await loadWorker(async (url, init) => (slow ? new Promise<Response>(() => {}) : server()(url, init)));
    await w.install();
    slow = true;
    vi.useFakeTimers();
    const p = w.fetchEv(`${SCOPE}`, 'navigate');
    await vi.advanceTimersByTimeAsync(NAV_TIMEOUT_MS + 10);
    expect(await (await p)!.text()).toBe(PAGE);
  });
  it('offline before anything was cached: a page fails the normal way (the browser\'s own offline page)', async () => {
    const w = await loadWorker(async () => { throw new TypeError('Failed to fetch'); });
    const r = await w.fetchEv(`${SCOPE}`, 'navigate');
    expect(r!.type).toBe('error');
  });
  it('precached files come from the cache with the network down; /api is never answered by the worker', async () => {
    let down = false;
    const w = await loadWorker(async (url, init) => { if (down) throw new TypeError('Failed to fetch'); return server()(url, init); });
    await w.install();
    down = true;
    expect(await (await w.fetchEv(`${SCOPE}assets/index-AbCd1234.js`))!.text()).toBe('app()');
    expect(await w.fetchEv(`${SCOPE}api/v1/sync?since=3`)).toBeUndefined();
    expect(await w.fetchEv(`${SCOPE}api/v1/jobs/j1/stop`, 'cors', 'POST')).toBeUndefined();
  });
  it('activate: removes all but this build and the one before, then claims the pages', async () => {
    const w = await loadWorker(server(), { ...INFO, buildId: 'b3' });
    for (const k of ['mwa-shell-v2', cacheName('b1'), cacheName('b2')]) await w.caches.open(k);
    await w.install();
    const { waited } = await w.run('activate');
    await waited;
    expect(await w.caches.keys()).toEqual([cacheName('b2'), cacheName('b3')]);
    expect(w.self.clients.claim).toHaveBeenCalled();
  });
  it('an old tab\'s lazy chunk (the build before) still loads from the cache it was saved in', async () => {
    const w = await loadWorker(async () => { throw new TypeError('Failed to fetch'); }, { ...INFO, buildId: 'b2' });
    const old = await w.caches.open(cacheName('b1'));
    await old.put(`${SCOPE}assets/ProjectThread-OldHash1.js`, new Response('old chunk'));
    expect(await (await w.fetchEv(`${SCOPE}assets/ProjectThread-OldHash1.js`))!.text()).toBe('old chunk');
  });
  it('messages: SKIP_WAITING takes over; GET_BUILD says which build it is', async () => {
    const w = await loadWorker(server());
    await w.run('message', { data: { type: 'SKIP_WAITING' }, ports: [], source: null });
    expect(w.self.skipWaiting).toHaveBeenCalledTimes(1);
    const got: unknown[] = [];
    await w.run('message', { data: { type: 'GET_BUILD' }, ports: [{ postMessage: (m: unknown) => got.push(m) }], source: null });
    expect(got).toEqual([{ type: 'BUILD', buildId: 'b1', entry: 'assets/index-AbCd1234.js', version: '1.0.0' }]);
    await w.run('message', { data: 'nonsense', ports: [], source: null });
    expect(w.self.skipWaiting).toHaveBeenCalledTimes(1);
  });
});
