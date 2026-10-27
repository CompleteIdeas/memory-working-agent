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

// ── web push (slice P3) ────────────────────────────────────────────────────────────────────────────────────────
//
// A push carries ONLY `{kind, id, tag}` (src/v2/push.ts): it passes through Google's, Apple's, Mozilla's or
// Microsoft's push service, so no title, sender or word of mail is ever in it. The words a phone shows are fixed
// here, per kind; the app fetches the details after it opens, at the place the notification is about.

export type PushKindW = 'approval' | 'waiting' | 'result' | 'morning' | 'test';
export interface PushData { kind: PushKindW; id: string | null; tag: string }
const KINDS: readonly PushKindW[] = ['approval', 'waiting', 'result', 'morning', 'test'];

/** The payload as sent, or null when it is not one of ours (then a generic notice is shown: a push must show one). */
export function parsePush(text: string | null | undefined): PushData | null {
  if (!text) return null;
  let o: unknown;
  try { o = JSON.parse(text); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  if (!KINDS.includes(r.kind as PushKindW)) return null;
  const id = typeof r.id === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(r.id) ? r.id : null;
  return { kind: r.kind as PushKindW, id, tag: `mwa-${r.kind as string}` };
}

/** The fixed words per kind. Nothing from the payload is shown but the kind. */
export const PUSH_WORDS: Record<PushKindW | 'other', { title: string; body: string }> = {
  approval: { title: 'Your helper', body: 'Something needs your OK' },
  waiting: { title: 'Your helper', body: 'A job is waiting for you' },
  result: { title: 'Your helper', body: 'A result is ready' },
  morning: { title: 'Your helper', body: 'Here’s your morning' },
  test: { title: 'Your helper', body: 'Notifications are working on this device' },
  other: { title: 'Your helper', body: 'Something new — open to see' },
};

/** Where tapping a notification opens the app: the v2 app at Today, the approval, the job (the working sheet). */
export function pushTarget(p: PushData | null, scope: string): string {
  const base = new URL('./?ui=v2', scope).href;
  if (!p) return `${base}#/today`;
  const id = p.id ? encodeURIComponent(p.id) : null;
  switch (p.kind) {
    case 'approval': return id ? `${base}#/approval/${id}` : `${base}#/today`;
    case 'waiting': case 'result': return id ? `${base}#/job/${id}` : `${base}#/work`;
    case 'test': return `${base}#/settings/notifications`;
    default: return `${base}#/today`;
  }
}

export interface NotificationPlan { title: string; options: { body: string; tag: string; renotify: boolean; icon: string; badge: string; data: { url: string; kind: string } } }
/** What to show for one push. One tag per kind: a newer notification of a kind replaces the older one. */
export function notificationFor(text: string | null | undefined, scope: string): NotificationPlan {
  const p = parsePush(text);
  const w = PUSH_WORDS[p?.kind ?? 'other'];
  return {
    title: w.title,
    options: {
      body: w.body, tag: p?.tag ?? 'mwa-other', renotify: true,
      icon: new URL('pwa/icon-192.png', scope).href, badge: new URL('pwa/monochrome-512.png', scope).href,
      data: { url: pushTarget(p, scope), kind: p?.kind ?? 'other' },
    },
  };
}

export interface ClientLike { url: string; type?: string; focused?: boolean; visibilityState?: string }
/** Which open window to reuse for a tap: a focused one of ours first, then a visible one, then any; null = open one. */
export function pickClient<T extends ClientLike>(clients: readonly T[], scope: string): T | null {
  const ours = clients.filter((c) => (c.type ?? 'window') === 'window' && c.url.startsWith(new URL(scope).origin));
  return ours.find((c) => c.focused) ?? ours.find((c) => c.visibilityState === 'visible') ?? ours[0] ?? null;
}

/** A notification's own URL, kept only if it is the app at our origin (anything else opens Today). */
export function safeTarget(url: unknown, scope: string): string {
  try {
    const u = new URL(String(url));
    if (u.origin === new URL(scope).origin) return u.href;
  } catch { /* fall through */ }
  return pushTarget(null, scope);
}

/** The message the worker posts to an open page to move it to the notification's place. */
export interface OpenMessage { type: 'MWA_OPEN'; url: string }

/** Tap on a notification with this window open: tell the v2 page where to go (it stays loaded, keeping what it has),
 *  or load the v2 app there (a v1 tab, or a page that is not the app). */
export function clickPlan(client: ClientLike | null): { kind: 'message' } | { kind: 'navigate' } | { kind: 'open' } {
  if (!client) return { kind: 'open' };
  return /[?&]ui=v2(&|#|$)/.test(client.url) ? { kind: 'message' } : { kind: 'navigate' };
}

/** The browser replaced the push subscription (pushsubscriptionchange): the request that tells the server. */
export function resubscribeRequest(sub: { endpoint?: string; expirationTime?: number | null; keys?: Record<string, string> }, oldEndpoint: string | null, version: string, key: string): { headers: Record<string, string>; body: string } | null {
  if (!sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) return null;
  return {
    headers: { 'content-type': 'application/json', 'idempotency-key': key, 'x-mwa-client': `web/${version}` },
    body: JSON.stringify({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, expirationTime: sub.expirationTime ?? null, ...(oldEndpoint && oldEndpoint !== sub.endpoint ? { replaces: oldEndpoint } : {}) }),
  };
}

/** base64url to bytes (the VAPID public key for PushManager.subscribe). */
export function keyBytes(b64u: string): Uint8Array {
  const s = b64u.replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (s.length % 4)) % 4;
  const bin = atob(s + '='.repeat(pad));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
