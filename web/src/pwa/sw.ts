/**
 * MWA's service worker (v2 build, slices P1/P2). Bundled by web/vite-pwa.ts into dist-ui/sw.js after the app is
 * built, with this build's file list as `__MWA_BUILD__`. The decisions are in sw-logic.ts (unit-tested); this file only
 * wires them to the worker's events. Not part of the page bundle.
 */
import {
  acceptable, cacheName, cachesToDelete, NAV_TIMEOUT_MS, pageAnswer, PRECACHE_HEADER, precacheUrls, route,
  type BuildInfo, type BuildReply, type ToWorker,
} from './sw-logic';

// the few worker types this file needs (the web tsconfig has the DOM lib, not WebWorker)
interface ExtendableEvent extends Event { waitUntil(p: Promise<unknown>): void }
interface FetchEvent extends ExtendableEvent { request: Request; respondWith(r: Response | Promise<Response>): void }
interface MessageEventW extends ExtendableEvent { data: unknown; ports: readonly MessagePort[]; source: { postMessage(m: unknown): void } | null }
interface WorkerScope {
  registration: { scope: string };
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  addEventListener(t: 'install' | 'activate', f: (e: ExtendableEvent) => void): void;
  addEventListener(t: 'fetch', f: (e: FetchEvent) => void): void;
  addEventListener(t: 'message', f: (e: MessageEventW) => void): void;
}
declare const __MWA_BUILD__: BuildInfo;
const sw = self as unknown as WorkerScope;

const INFO = __MWA_BUILD__;
const CURRENT = cacheName(INFO.buildId);
const scope = () => sw.registration.scope;
let precached: Set<string> | null = null;
const precachedSet = () => (precached ??= new Set(precacheUrls(INFO, scope())));
const shellUrl = () => new URL('index.html', scope()).href;

/** All of this build's files, or none: fetched first, then stored. */
async function precache(): Promise<void> {
  const s = scope();
  const got = await Promise.all(INFO.files.map(async (f) => {
    const url = new URL(f.url, s).href;
    const res = await fetch(url, {
      cache: 'reload', credentials: 'same-origin',
      headers: f.url === 'index.html' ? { [PRECACHE_HEADER]: 'precache' } : undefined,
    });
    const body = f.url === 'index.html' ? await res.clone().text() : null;
    const bad = acceptable(f, res, body, INFO);
    if (bad) throw new Error(`MWA precache: ${bad}`);
    return [url, res] as const;
  }));
  const cache = await caches.open(CURRENT);
  try {
    await Promise.all(got.map(([u, r]) => cache.put(u, r)));
  } catch (e) {
    await caches.delete(CURRENT); // half a shell is no shell
    throw e;
  }
}

sw.addEventListener('install', (e) => {
  // no skipWaiting here: a new worker waits until the page says so (the person tapped Reload, or the page already
  // runs this build)
  e.waitUntil(precache().catch(async (err) => { await caches.delete(CURRENT).catch(() => false); throw err; }));
});

sw.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(cachesToDelete(keys, CURRENT).map((k) => caches.delete(k)));
    await sw.clients.claim();
  })());
});

sw.addEventListener('message', (e) => {
  const m = e.data as ToWorker | null;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'SKIP_WAITING') { e.waitUntil(sw.skipWaiting()); return; }
  if (m.type === 'GET_BUILD') {
    const reply: BuildReply = { type: 'BUILD', buildId: INFO.buildId, entry: INFO.entry, version: INFO.version };
    if (e.ports[0]) e.ports[0].postMessage(reply); else e.source?.postMessage(reply);
  }
});

async function cachedShell(): Promise<Response | undefined> {
  const c = await caches.open(CURRENT);
  return (await c.match(shellUrl())) ?? (await caches.match(shellUrl()));
}

async function page(req: Request): Promise<Response> {
  const shell = await cachedShell();
  const net = fetch(req);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), NAV_TIMEOUT_MS); });
  const first = await Promise.race([net.then((r) => r, () => 'failed' as const), timeout]);
  clearTimeout(timer);
  const answer = pageAnswer(first, !!shell);
  if (answer === 'shell') return shell!;
  if (first instanceof Response) return first;
  if (answer === 'network') return net; // slow, and nothing cached to show instead: wait for it
  return Response.error();
}

async function anyCache(req: Request, key?: string): Promise<Response> {
  const hit = key ? (await (await caches.open(CURRENT)).match(key)) ?? (await caches.match(key)) : await caches.match(req, { ignoreSearch: true });
  return hit ?? fetch(req);
}

sw.addEventListener('fetch', (e) => {
  const req = e.request;
  const r = route({ method: req.method, url: req.url, mode: req.mode }, scope(), precachedSet());
  if (r.kind === 'pass') return;
  if (r.kind === 'page') { e.respondWith(page(req)); return; }
  if (r.kind === 'precached') { e.respondWith(anyCache(req, r.key)); return; }
  e.respondWith(anyCache(req));
});
