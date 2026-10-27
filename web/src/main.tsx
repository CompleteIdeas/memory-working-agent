import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { openExternal } from './api';
import { FilePage } from './components/FileViewer';
import { startPwa } from './pwa/register';
import { chooseUi } from './v2/choose';

// In the desktop app the Tauri webview swallows target="_blank" links, so external links
// (setup guides, BotFather, etc.) appear dead. Intercept clicks on external http(s) links
// and open them in the real OS browser via the backend whenever the server is THIS machine
// — i.e. the desktop app (shell sets window.__MWA_DESKTOP__) or a local browser tab on
// localhost (opening server-side is the same machine). When MWA is reached remotely over a
// LAN/host, we don't intercept, so the visitor's own browser handles the link normally.
const isLocalHost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
document.addEventListener('click', (e) => {
  const desktop = (window as unknown as { __MWA_DESKTOP__?: boolean }).__MWA_DESKTOP__;
  if (!desktop && !isLocalHost) return;
  const a = (e.target as HTMLElement | null)?.closest?.('a');
  const href = a?.getAttribute('href') ?? '';
  if (/^https?:\/\//i.test(href) && !href.startsWith(location.origin)) {
    e.preventDefault();
    void openExternal(href);
  }
});

const isDesktop = !!(
  (window as unknown as { __MWA_DESKTOP__?: boolean }).__MWA_DESKTOP__ ||
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ ||
  (window as unknown as { __TAURI__?: unknown }).__TAURI__
);
// P1/P2: the worker, the install prompt and (v2) the v2 manifest, before anything renders
{
  let stored: string | null = null;
  try { stored = localStorage.getItem('mwa-ui'); } catch { /* private mode */ }
  startPwa({ prod: import.meta.env.PROD, desktop: isDesktop, v2: chooseUi(location.search, stored) === 'v2' });
}

// BL-70: a popped-out file (/view?path=) and a share link (/s/<token>) are pages of their own.
const sharedToken = /^\/s\/([A-Za-z0-9_-]+)\/?$/.exec(location.pathname)?.[1];
const viewPath = location.pathname === '/view' ? new URLSearchParams(location.search).get('path') : null;
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {sharedToken ? <FilePage src={{ kind: 'shared', token: sharedToken }} />
      : viewPath ? <FilePage src={{ kind: 'own', path: viewPath }} />
      : <App />}
  </StrictMode>,
);

// The service worker (v2 build, P1/P2: src/pwa/). In the DESKTOP app (Tauri) the local server is always present, so the
// worker adds nothing — and an offline-shell fallback can serve a STALE screen during an update or the brief restart
// window (this is what made an update look like "settings reset"). So in the desktop we DON'T register it AND we
// actively remove any worker + caches a previous build left behind, so the install self-heals on next open. In a real
// browser (and an installed phone app) one worker serves both UIs: it precaches this build's files all or nothing,
// answers pages from the network first (the cached shell when offline), never touches /api, and a new build's worker
// waits for the person's Reload ("A new version is ready") instead of swapping code under them (src/pwa/sw-logic.ts).
if ('serviceWorker' in navigator && isDesktop) {
  navigator.serviceWorker.getRegistrations()
    .then((rs) => Promise.all(rs.map((r) => r.unregister())))
    .catch(() => { /* non-fatal */ });
  if ('caches' in window) {
    caches.keys().then((ks) => Promise.all(ks.map((k) => caches.delete(k)))).catch(() => { /* non-fatal */ });
  }
}
