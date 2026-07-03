import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { openExternal } from './api';

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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// PWA service worker. In the DESKTOP app (Tauri) the local server is always present, so the SW
// adds nothing — and its offline-shell fallback can serve a STALE screen during an update or the
// brief restart window (this is what made an update look like "settings reset"). So in the desktop
// we DON'T register it AND we actively remove any SW + caches a previous build left behind, so the
// install self-heals on next open. In a real browser (PWA install) we keep it: it's network-first
// + skipWaiting, so it self-updates.
const isDesktop = !!(
  (window as unknown as { __MWA_DESKTOP__?: boolean }).__MWA_DESKTOP__ ||
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ ||
  (window as unknown as { __TAURI__?: unknown }).__TAURI__
);
if ('serviceWorker' in navigator) {
  if (isDesktop) {
    navigator.serviceWorker.getRegistrations()
      .then((rs) => Promise.all(rs.map((r) => r.unregister())))
      .catch(() => { /* non-fatal */ });
    if ('caches' in window) {
      caches.keys().then((ks) => Promise.all(ks.map((k) => caches.delete(k)))).catch(() => { /* non-fatal */ });
    }
  } else if (import.meta.env.PROD) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => { /* non-fatal */ });
    });
  }
}
