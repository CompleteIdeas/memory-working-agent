/**
 * Notifications on this device (v2 build, slice P3): what this browser can do, in plain words (pure, unit-tested in
 * tests/pwa-push-client.test.ts), and the subscribe / unsubscribe flows Settings › Notifications runs.
 *
 * The permission is asked for only on a tap ("Turn on"), and FIRST in that tap: Safari on iPhone grants it only from
 * the gesture itself. On iPhone and iPad, web push works only in the app installed to the home screen (iOS 16.4+), so
 * Safari in a tab is told to install first. A phone on an insecure address (http://100.x…) has no push at all: it is
 * told the secure address.
 */
import { isIos } from './install';

export type PushState =
  /** notifications are on for this device (a subscription the server knows) */
  | 'on'
  /** allowed or not asked yet, and not subscribed */
  | 'off'
  /** the person (or the browser) said no: only the browser's settings can undo it */
  | 'blocked'
  /** iPhone or iPad in a browser tab: install to the home screen first */
  | 'ios-install'
  /** not a secure address: push needs https (the tailnet name) */
  | 'insecure'
  /** this browser has no web push */
  | 'unsupported';

export interface PushFacts {
  secure: boolean;
  hasWorker: boolean;
  hasPush: boolean;
  hasNotification: boolean;
  permission: 'default' | 'granted' | 'denied';
  userAgent: string;
  touchPoints?: number;
  standalone: boolean;
  /** this browser has a subscription AND the server lists it as this caller's */
  subscribed: boolean;
}

export function pushState(f: PushFacts): PushState {
  if (!f.secure) return 'insecure';
  const ios = isIos(f.userAgent, f.touchPoints);
  // iOS Safari has no PushManager in a tab at all; in the installed app it does (16.4+)
  if (ios && !f.standalone) return 'ios-install';
  if (!f.hasWorker || !f.hasPush || !f.hasNotification) return 'unsupported';
  if (f.permission === 'denied') return 'blocked';
  return f.subscribed && f.permission === 'granted' ? 'on' : 'off';
}

/** How to allow notifications again after "Block", for this browser. */
export function unblockSteps(userAgent: string, standalone: boolean, touchPoints = 0): string {
  if (isIos(userAgent, touchPoints)) return 'Open the iPhone’s Settings › Notifications › MWA, and turn on Allow Notifications.';
  if (/Android/i.test(userAgent)) {
    return standalone
      ? 'Press and hold the MWA icon › App info › Notifications, and allow them. Then come back here.'
      : 'Tap the icon left of the address (the lock or the settings icon) › Permissions › Notifications › Allow. Then reload.';
  }
  return 'Click the icon left of the address (the lock or the settings icon), set Notifications to Allow, then reload.';
}

export interface PushWords { line: string; button: string | null; tone: 'ok' | 'warn' | 'plain' }
export function pushWords(s: PushState, f: Pick<PushFacts, 'userAgent' | 'standalone' | 'touchPoints'>, secureAddress: string): PushWords {
  switch (s) {
    case 'on': return { line: 'On for this device. I’ll tell you when something needs you.', button: 'Turn off', tone: 'ok' };
    case 'off': return { line: 'Off for this device. Turn them on and your phone will ask whether to allow them.', button: 'Turn on notifications', tone: 'plain' };
    case 'blocked': return { line: `Notifications are blocked for MWA on this device. ${unblockSteps(f.userAgent, f.standalone, f.touchPoints)}`, button: null, tone: 'warn' };
    case 'ios-install': return { line: 'On iPhone and iPad, notifications work only in the installed app: add MWA to your Home Screen first (Share › Add to Home Screen), open it from there, then turn them on here.', button: null, tone: 'warn' };
    case 'insecure': return { line: `Notifications need the secure address. Open ${secureAddress} on this device.`, button: null, tone: 'warn' };
    case 'unsupported': return { line: 'This browser can’t show notifications from MWA. Chrome on Android, or the installed app on iPhone (iOS 16.4 or later), can.', button: null, tone: 'warn' };
  }
}

// ── the browser side ────────────────────────────────────────────────────────────────────────────────────────────

export function readFacts(subscribed: boolean): PushFacts {
  const w = typeof window === 'undefined' ? undefined : window;
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  const N = (w as unknown as { Notification?: { permission: NotificationPermission } } | undefined)?.Notification;
  return {
    secure: w?.isSecureContext === true,
    hasWorker: !!nav && 'serviceWorker' in nav,
    hasPush: !!w && 'PushManager' in w,
    hasNotification: !!N,
    permission: (N?.permission ?? 'default') as PushFacts['permission'],
    userAgent: nav?.userAgent ?? '',
    touchPoints: nav?.maxTouchPoints ?? 0,
    standalone: !!w && (w.matchMedia?.('(display-mode: standalone)').matches || (nav as unknown as { standalone?: boolean })?.standalone === true),
    subscribed,
  };
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  const now = await navigator.serviceWorker.getRegistration();
  if (now) return now;
  // a first visit: the worker is still installing
  return Promise.race([navigator.serviceWorker.ready, new Promise<null>((r) => setTimeout(() => r(null), 8_000))]);
}

/** This browser's push subscription, if any. */
export async function browserSubscription(): Promise<PushSubscription | null> {
  try { return (await (await registration())?.pushManager.getSubscription()) ?? null; } catch { return null; }
}

export function keyBytes(b64u: string): Uint8Array {
  const s = b64u.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const sameKey = (a: ArrayBuffer | null | undefined, b: Uint8Array) => !!a && a.byteLength === b.length && new Uint8Array(a).every((x, i) => x === b[i]);

export function platformName(ua: string, touchPoints = 0): string {
  if (isIos(ua, touchPoints)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Mac OS X/i.test(ua)) return 'mac';
  return 'other';
}

export type TurnOnResult = { ok: true; subscription: PushSubscriptionJSON } | { ok: false; reason: 'denied' | 'dismissed' | 'no-worker' | 'failed'; message: string };

/**
 * The first step of "Turn on", run synchronously inside the tap: ask for the permission (iOS grants it only from the
 * gesture). Returns the browser's answer as a promise.
 */
export function askPermission(): Promise<NotificationPermission> {
  const N = (window as unknown as { Notification?: typeof Notification }).Notification;
  if (!N) return Promise.resolve('denied');
  if (N.permission !== 'default') return Promise.resolve(N.permission);
  try {
    const r = N.requestPermission();
    return r && typeof (r as Promise<NotificationPermission>).then === 'function' ? r : Promise.resolve(N.permission);
  } catch { return Promise.resolve(N.permission); }
}

/** Then: subscribe with the server's key (a subscription made with another key is replaced). */
export async function subscribeBrowser(permission: Promise<NotificationPermission>, vapidPublicKey: string): Promise<TurnOnResult> {
  const p = await permission;
  if (p === 'denied') return { ok: false, reason: 'denied', message: 'Notifications were blocked. You can allow them in your browser’s settings.' };
  if (p !== 'granted') return { ok: false, reason: 'dismissed', message: 'Notifications weren’t allowed. Tap Turn on again when you want them.' };
  const reg = await registration();
  if (!reg) return { ok: false, reason: 'no-worker', message: 'The app isn’t fully installed on this device yet. Reload, then try again.' };
  try {
    const key = keyBytes(vapidPublicKey);
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub.options?.applicationServerKey, key)) { await sub.unsubscribe().catch(() => false); sub = null; }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key as BufferSource });
    return { ok: true, subscription: sub.toJSON() };
  } catch {
    return { ok: false, reason: 'failed', message: 'This browser couldn’t set up notifications just now. Try again in a moment.' };
  }
}

/** Turn this browser's subscription off (the server's copy is removed by the caller). Returns its endpoint. */
export async function unsubscribeBrowser(): Promise<string | null> {
  const sub = await browserSubscription();
  if (!sub) return null;
  const ep = sub.endpoint;
  await sub.unsubscribe().catch(() => false);
  return ep;
}
