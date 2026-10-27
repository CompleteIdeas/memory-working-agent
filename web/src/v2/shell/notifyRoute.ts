/**
 * Where a tapped notification opens the app (v2 build, slice P3). The service worker opens `/?ui=v2#/<place>` (a new
 * window), or tells an open v2 page `{type: 'MWA_OPEN', url}`; either way the place is the hash:
 *   #/today                    Today
 *   #/approval/<id>            Today, where the "needs your OK" card is (approvals are reviewed from there)
 *   #/job/<id>                 the working sheet, scrolled to that job
 *   #/work                     the working sheet
 *   #/settings/notifications   Settings › Notifications (after "Send a test")
 * Pure parsing here (tests/pwa-push-client.test.ts); useNotificationRoutes wires it to the shell.
 */
import { useEffect } from 'react';

export type NotifyRoute =
  | { to: 'today' }
  | { to: 'approval'; id: string }
  | { to: 'job'; id: string }
  | { to: 'work' }
  | { to: 'settings' };

const ID = /^[A-Za-z0-9_.:-]{1,100}$/;
export function parseNotifyHash(hash: string): NotifyRoute | null {
  const m = /^#\/([a-z]+)(?:\/([^/?#]*))?$/.exec(hash);
  if (!m) return null;
  let id: string | null = null;
  try { id = m[2] ? decodeURIComponent(m[2]) : null; } catch { id = null; }
  const ok = id && ID.test(id) ? id : null;
  switch (m[1]) {
    case 'today': return { to: 'today' };
    case 'approval': return ok ? { to: 'approval', id: ok } : { to: 'today' };
    case 'job': return ok ? { to: 'job', id: ok } : { to: 'work' };
    case 'work': return { to: 'work' };
    case 'settings': return { to: 'settings' };
    default: return null;
  }
}

/** The hash of a URL the worker sent, if it is this app's (same origin). */
export function hashOfOpenUrl(url: unknown, origin: string): string | null {
  try { const u = new URL(String(url)); return u.origin === origin ? u.hash : null; } catch { return null; }
}

export function useNotificationRoutes(o: { go: (v: 'today' | 'settings') => void; openWork: () => void; ready: boolean }): void {
  const { go, openWork, ready } = o;
  useEffect(() => {
    if (!ready) return;
    const apply = (hash: string) => {
      const r = parseNotifyHash(hash);
      if (!r) return;
      // the place is taken; the hash is not kept (a reload must not open the sheet again)
      history.replaceState(null, '', location.pathname + location.search + (r.to === 'settings' ? '#notifications' : ''));
      if (r.to === 'settings') { go('settings'); return; }
      go('today');
      if (r.to === 'job' || r.to === 'work') {
        openWork();
        if (r.to === 'job') {
          const id = r.id;
          let n = 0;
          const find = () => {
            const el = document.getElementById(`jt-${id}`);
            if (el) { el.scrollIntoView({ block: 'center' }); return; }
            if (++n < 20) setTimeout(find, 150);
          };
          setTimeout(find, 50);
        }
      }
    };
    apply(location.hash);
    const onHash = () => apply(location.hash);
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: unknown; url?: unknown } | null;
      if (!d || d.type !== 'MWA_OPEN') return;
      const h = hashOfOpenUrl(d.url, location.origin);
      if (h) apply(h);
    };
    window.addEventListener('hashchange', onHash);
    const sw = typeof navigator !== 'undefined' && 'serviceWorker' in navigator ? navigator.serviceWorker : null;
    sw?.addEventListener('message', onMsg);
    return () => { window.removeEventListener('hashchange', onHash); sw?.removeEventListener('message', onMsg); };
  }, [go, openWork, ready]);
}
