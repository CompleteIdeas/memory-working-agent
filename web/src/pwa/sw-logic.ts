/**
 * The service worker's decisions (v2 build, slices P1/P2), as pure functions so they are unit-tested
 * (tests/pwa-sw-logic.test.ts). The worker itself (sw.ts) only wires these to the browser's events.
 *
 * ONE worker serves both UIs. v1 and v2 are the same build — one index.html, v2 a lazy chunk of it — at the same
 * origin and path, so two workers would fight over one scope. What it does:
 *   - precache: every file of the build (the hashed assets, index.html, the manifests and icons), fetched together at
 *     install into a cache named after the build. If one file fails, or index.html is not the page that loads this
 *     build's entry script (a sign-in page, a half-copied deploy), the install fails and the old worker stays: the
 *     shell is cached all or nothing, so an index.html never points at hashed files the cache lacks.
 *   - a page (navigation): the network first (a sign-in page, a fresh deploy and v1's "reload on 401" keep working),
 *     the cached index.html only when the device is offline or the request really fails (or the proxy says the
 *     server is down, 5xx). A SLOW answer is waited for: serving the shell after a timeout put a signed-out v1 user
 *     on a slow link into a reload loop (review of P1/P2). That index.html and its assets are one build.
 *   - a precached file: from the cache (hashed names never change content); the network if it is somehow missing.
 *   - everything else, and always /api/*, cross-origin, and anything but GET: not touched. Data lives in IndexedDB
 *     through the store, never in this cache.
 *   - updates: a new worker installs its own cache beside the old one and WAITS. The cache is named after the build AND
 *     the worker's own code, and an install only ever deletes a cache it created itself, so a failed install of a
 *     worker-only change can never delete the cache the active worker serves from. The page asks it to take over
 *     (SKIP_WAITING) when the person taps Reload, or quietly when the page already runs the new build. On activate
 *     it keeps its own cache and the one before it (a tab still open on the old build can load its lazy chunks), and
 *     deletes the rest, including v1's old network-first cache (`mwa-shell-*`).
 */

export const CACHE_PREFIX = 'mwa-precache-';
/** The v1 worker's runtime cache names (`mwa-shell-v2`): removed on activate. */
export const LEGACY_PREFIX = 'mwa-shell-';
/** Each precache fetch gives up after this long (a stalled download must not leave an install hanging forever). */
export const PRECACHE_TIMEOUT_MS = 30_000;
/** The install fetches the shell as index.html?ui=v2 (stored as index.html): behind a password, W5's gate hands the app
 *  page to a v2 request without a session (signedOutPageAllowed), so a phone's worker can always cache the shell, while
 *  a person opening "/" still gets the sign-in page. (It replaced a spoofable x-mwa-sw header, review of P1/P2.) */
export const SHELL_FETCH = 'index.html?ui=v2';

export interface PrecacheEntry {
  /** relative to the worker's folder, e.g. "index.html", "assets/index-AbC123.js" */
  url: string;
  /** a content hash for files whose name does not change (index.html, manifests, icons); null for hashed names */
  rev: string | null;
}
export interface BuildInfo {
  /** changes whenever any precached file changes */
  buildId: string;
  /** the entry script index.html loads, relative ("assets/index-AbC123.js") */
  entry: string;
  /** the web app's version (web/package.json, or MWA_WEB_VERSION at build) */
  version: string;
  /** a hash of the worker's own code (set by the build after bundling; part of the cache name) */
  swHash?: string;
  files: PrecacheEntry[];
}

export const cacheName = (buildId: string, swHash = ''): string => `${CACHE_PREFIX}${buildId}${swHash ? `-${swHash}` : ''}`;

/** Ask the network at all? Not when the device says it is offline and a cached shell exists. */
export function tryNetwork(online: boolean, haveShell: boolean): boolean {
  return online || !haveShell;
}

/** What a page request gets: the network's answer however long it takes, unless it really failed, or the server behind
 *  the proxy is down (a 5xx from `tailscale serve` while the computer sleeps), and a cached shell exists. Never the
 *  shell for a slow answer: the network's page (a sign-in page) must win, or v1's reload-on-401 loops. */
export function pageAnswer(network: { status: number } | 'failed', haveShell: boolean): 'network' | 'shell' | 'error' {
  if (network === 'failed') return haveShell ? 'shell' : 'error';
  if (network.status >= 500 && haveShell) return 'shell';
  return 'network';
}

export type Route =
  | { kind: 'pass' }
  /** a page: network first, the cached shell (index.html) as the fallback */
  | { kind: 'page' }
  /** a precached file: the cache first; `key` is the absolute URL it is stored under */
  | { kind: 'precached'; key: string }
  /** a hashed asset this build does not list: any cache that has it, else the network */
  | { kind: 'asset' };

export interface RequestLike { method: string; url: string; mode?: string; destination?: string }

/**
 * What to do with one request. `scope` is the worker's scope URL (".../"), `precached` the absolute URLs in the
 * current cache (without query strings).
 */
export function route(req: RequestLike, scope: string, precached: ReadonlySet<string>): Route {
  if (req.method !== 'GET') return { kind: 'pass' };
  let u: URL, s: URL;
  try { u = new URL(req.url); s = new URL(scope); } catch { return { kind: 'pass' }; }
  if (u.origin !== s.origin) return { kind: 'pass' };
  if (!u.pathname.startsWith(s.pathname)) return { kind: 'pass' };
  const rel = u.pathname.slice(s.pathname.length);
  // the API (data, the SSE stream, sign-in), the dev fixtures' controls, the worker itself: never
  if (rel === 'api' || rel.startsWith('api/') || rel.startsWith('__') || rel === 'sw.js') return { kind: 'pass' };
  if (req.mode === 'navigate') {
    // a share link (/s/<token>) and a popped-out file (/view) are pages of their own that need the server anyway;
    // a path with an extension is a file (a download), not the app
    if (rel.startsWith('s/')) return { kind: 'pass' };
    if (/\.[a-z0-9]+$/i.test(rel) && rel !== 'index.html') return { kind: 'pass' };
    return { kind: 'page' };
  }
  const key = `${u.origin}${u.pathname}`;
  if (precached.has(key)) return { kind: 'precached', key };
  // a hashed file of another build (a tab still open on the build before): from whichever cache has it, else the network
  if (rel.startsWith('assets/')) return { kind: 'asset' };
  return { kind: 'pass' };
}

/** The absolute URLs a build's files are cached under. */
export function precacheUrls(info: Pick<BuildInfo, 'files'>, scope: string): string[] {
  return info.files.map((f) => new URL(f.url, scope).href.replace(/[?#].*$/, ''));
}

/** Caches to delete when the worker for `current` activates: every other precache but the newest one before it,
 *  and v1's runtime cache. `keys` is in creation order (CacheStorage.keys()). Caches that are not MWA's are kept. */
export function cachesToDelete(keys: readonly string[], current: string): string[] {
  const ours = keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== current);
  const keepPrevious = ours.length ? ours[ours.length - 1] : null;
  return keys.filter((k) => k.startsWith(LEGACY_PREFIX) || (k.startsWith(CACHE_PREFIX) && k !== current && k !== keepPrevious));
}

/**
 * Is this response a usable copy of one build file? index.html must be the page that loads this build's entry
 * script (a password page answered for it, or a half-finished deploy, is not); every file must be a 200 that is not a
 * redirect.
 */
export function acceptable(file: PrecacheEntry, res: { ok: boolean; status: number; redirected?: boolean; type?: string }, body: string | null, info: Pick<BuildInfo, 'entry'>): string | null {
  if (!res.ok || res.status !== 200) return `${file.url}: ${res.status}`;
  if (res.redirected) return `${file.url}: redirected`;
  if (file.url === 'index.html') {
    if (body === null) return 'index.html: unread';
    if (!body.includes(info.entry)) return 'index.html is not this build’s page';
  }
  return null;
}

/** Messages the page sends the worker. */
export type ToWorker = { type: 'SKIP_WAITING' } | { type: 'GET_BUILD' };
/** The worker's answer to GET_BUILD. */
export interface BuildReply { type: 'BUILD'; buildId: string; entry: string; version: string }
