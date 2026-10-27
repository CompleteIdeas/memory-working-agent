/**
 * The page's side of the service worker and of installing (v2 build, slices P1/P2). In the main bundle (main.tsx
 * calls startPwa before anything renders), because the browser's install prompt fires early and both UIs share the one
 * worker (sw-logic.ts says why).
 *
 *   - registers dist-ui/sw.js (production builds in a browser; never in the desktop app, never on a share link's page)
 *   - feeds the update machine (update.ts) the worker's events and carries out what it decides; screens read it with
 *     useUpdate() (react.ts) and call applyUpdate() from their Reload button; the v2 store's 426 calls serverTooOld()
 *   - keeps the install prompt (beforeinstallprompt) for Settings › This device › Install on this phone
 *   - v2 only: points the page at the v2 manifest (start_url opens v2) and icons before the browser reads them
 */
import { GIVE_UP_MS, initialUpdate, reduceUpdate, type Effect, type UpdateEvent, type UpdateState } from './update';
import type { BuildReply } from './sw-logic';

type Listener = () => void;
const listeners = new Set<Listener>();
const emit = () => { for (const l of [...listeners]) l(); };
export function subscribePwa(fn: Listener): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }

// ---------- updates ----------
let update: UpdateState = initialUpdate;
let reg: ServiceWorkerRegistration | null = null;
let hadController = false;
/** How long Reload waits for the new worker to take over before reloading anyway. */
const APPLY_TIMEOUT_MS = 4_000;
let giveUpTimer: ReturnType<typeof setTimeout> | undefined;

export const getUpdate = (): UpdateState => update;

export function dispatchUpdate(e: UpdateEvent): void {
  const r = reduceUpdate(update, e);
  if (r.state !== update) { update = r.state; emit(); }
  for (const eff of r.effects) run(eff);
}

function run(eff: Effect) {
  if (eff === 'skip-waiting') reg?.waiting?.postMessage({ type: 'SKIP_WAITING' });
  else if (eff === 'reload') location.reload();
  else if (eff === 'arm-timeout') setTimeout(() => dispatchUpdate({ type: 'apply-timeout' }), APPLY_TIMEOUT_MS);
  else if (eff === 'arm-give-up') { clearTimeout(giveUpTimer); giveUpTimer = setTimeout(() => dispatchUpdate({ type: 'give-up' }), GIVE_UP_MS); }
  else if (eff === 'check') void checkForUpdate();
}

/** The person tapped Reload. */
export function applyUpdate(): void { dispatchUpdate({ type: 'apply' }); }
/** The API said this client is too old (426). */
export function serverTooOld(): void { dispatchUpdate({ type: 'server-too-old' }); }

/** The entry script this page loaded ("assets/index-AbC.js"), as the worker lists it. */
export function pageEntry(doc: Pick<Document, 'querySelector'> = document): string | null {
  const src = doc.querySelector('script[type="module"][src]')?.getAttribute('src');
  return src ? src.replace(/^\.?\//, '') : null;
}

function askBuild(w: ServiceWorker): Promise<BuildReply | null> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const t = setTimeout(() => resolve(null), 2_000);
    ch.port1.onmessage = (m) => { clearTimeout(t); resolve(m.data && m.data.type === 'BUILD' ? (m.data as BuildReply) : null); };
    try { w.postMessage({ type: 'GET_BUILD' }, [ch.port2]); } catch { clearTimeout(t); resolve(null); }
  });
}

async function onWaiting(w: ServiceWorker) {
  const b = await askBuild(w);
  const mine = pageEntry();
  dispatchUpdate({ type: 'waiting', pageRunsIt: !!b && !!mine && b.entry === mine });
}

function watchInstalling(w: ServiceWorker | null) {
  if (!w) return;
  const done = () => {
    if (w.state === 'installed' && reg?.active && reg.waiting === w) void onWaiting(w);
    // a failed install (the server sent a sign-in page, the network dropped): nothing new after all
    else if (w.state === 'redundant') dispatchUpdate({ type: 'checked', found: false });
  };
  w.addEventListener('statechange', done);
}

async function checkForUpdate() {
  if (!reg) { dispatchUpdate({ type: 'checked', found: false }); return; }
  // a hung update check must not hold "Updating…" (the give-up timer covers the rest)
  try { await Promise.race([reg.update(), new Promise((r) => setTimeout(r, 15_000))]); } catch { /* offline, or the server is down */ }
  if (reg.waiting) { dispatchUpdate({ type: 'checked', found: true }); void onWaiting(reg.waiting); return; }
  if (reg.installing) { dispatchUpdate({ type: 'checked', found: true }); watchInstalling(reg.installing); return; }
  dispatchUpdate({ type: 'checked', found: false });
}

// ---------- installing ----------
interface InstallPromptEvent extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }
let installPrompt: InstallPromptEvent | null = null;
let justInstalled = false;
export const canPromptInstall = (): boolean => !!installPrompt;
export const wasJustInstalled = (): boolean => justInstalled;

/** Shows the browser's own Install dialog. 'unavailable' when the browser has not offered one. */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const p = installPrompt;
  if (!p) return 'unavailable';
  installPrompt = null; emit(); // a prompt can be shown once
  try { await p.prompt(); const c = await p.userChoice; return c.outcome; } catch { return 'unavailable'; }
}

export function isStandalone(): boolean {
  try {
    return window.matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
  } catch { return false; }
}

// ---------- the v2 manifest ----------
/** Points the page at the v2 manifest and icons (start_url opens v2). v1 keeps its own manifest untouched. */
export function applyV2Head(doc: Document = document): void {
  const set = (sel: string, make: () => HTMLElement, attrs: Record<string, string>) => {
    const el = (doc.head.querySelector(sel) as HTMLElement | null) ?? doc.head.appendChild(make());
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  };
  set('link[rel="manifest"]', () => doc.createElement('link'), { rel: 'manifest', href: 'manifest-v2.webmanifest' });
  set('link[rel="icon"]', () => doc.createElement('link'), { rel: 'icon', type: 'image/svg+xml', href: 'pwa/icon.svg' });
  // PNG icons for browsers without SVG favicons: the light tile, and the night tile in dark mode
  for (const [media, href] of [['(prefers-color-scheme: light)', 'pwa/icon-192.png'], ['(prefers-color-scheme: dark)', 'pwa/icon-dark-192.png']]) {
    const l = doc.createElement('link'); l.rel = 'icon'; l.type = 'image/png'; l.setAttribute('sizes', '192x192'); l.media = media; l.href = href; doc.head.appendChild(l);
  }
  set('link[rel="apple-touch-icon"]', () => doc.createElement('link'), { rel: 'apple-touch-icon', href: 'pwa/apple-touch-icon.png' });
  set('meta[name="apple-mobile-web-app-title"]', () => doc.createElement('meta'), { name: 'apple-mobile-web-app-title', content: 'MWA' });
  // the bar colour follows light and dark (the Instrument bone and night)
  doc.head.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
  for (const [media, color] of [['(prefers-color-scheme: light)', '#e8e6e1'], ['(prefers-color-scheme: dark)', '#16181c']]) {
    const m = doc.createElement('meta'); m.name = 'theme-color'; m.media = media; m.content = color; doc.head.appendChild(m);
  }
}

// ---------- start ----------
export interface StartOptions { prod: boolean; desktop: boolean; v2: boolean }

/** Pages that are not the app: a share link and a popped-out file never register the worker. */
export function registersWorker(pathname: string, o: StartOptions): boolean {
  if (!o.prod || o.desktop) return false;
  if (pathname.startsWith('/s/') || pathname === '/view') return false;
  return true;
}

export function startPwa(o: StartOptions): void {
  if (o.v2) { try { applyV2Head(); } catch { /* the page still works */ } }
  if (typeof window === 'undefined') return;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e as InstallPromptEvent; emit(); });
  window.addEventListener('appinstalled', () => { installPrompt = null; justInstalled = true; emit(); });
  if (!('serviceWorker' in navigator) || !registersWorker(location.pathname, o)) return;
  hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    dispatchUpdate({ type: 'controller-changed', hadController });
    hadController = true;
  });
  const go = async () => {
    try {
      reg = await navigator.serviceWorker.register(new URL('sw.js', document.baseURI).href, { updateViaCache: 'none' });
    } catch { return; /* not a secure context, or blocked: the app still works online */ }
    reg.addEventListener('updatefound', () => watchInstalling(reg?.installing ?? null));
    if (reg.waiting && navigator.serviceWorker.controller) void onWaiting(reg.waiting);
    else if (reg.installing) watchInstalling(reg.installing);
    // a page left open for days still hears about a deploy: look again when it comes back, and every half hour
    const look = () => { if (navigator.onLine !== false) reg?.update().catch(() => { /* offline */ }); };
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') look(); });
    setInterval(look, 30 * 60_000);
  };
  if (document.readyState === 'complete') void go(); else window.addEventListener('load', () => { void go(); }, { once: true });
}
