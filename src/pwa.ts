/**
 * The server's side of the installable app (v2 build, slices P1/P2): cache headers for the built UI, and which of
 * its files are public behind the password. Unit-tested in tests/pwa-server.test.ts.
 *
 * Cache headers (dist-ui):
 *   assets/<name>-<hash>.<ext>  public, max-age=1 year, immutable — the name changes whenever the content does
 *   index.html, sw.js, the manifests, pwa-build.json, and every other file
 *                               no-cache — always revalidated, so a deploy is seen at once and the service worker
 *                               (which precaches the hashed files with the page that names them) decides what a
 *                               phone runs offline
 *
 * Public without a password session (the same reasoning as /assets/, already public for share links): the service
 * worker script, the manifests and the install icons. Browsers fetch a manifest WITHOUT cookies, so behind the gate it
 * came back as the sign-in page and the app could not be installed. W5's signedOutPageAllowed (src/api/legacy.ts)
 * already lets in single files at the root and a ?ui=v2 page (the worker precaches the shell as index.html?ui=v2);
 * this adds the icons under /pwa/. Nothing here is secret: it is the same code /assets/ serves. Unknown paths under
 * /pwa/ and /assets/ (both public signed out) are 404s, never the SPA fallback (pwaFileOnly).
 */
import type { IncomingMessage } from 'node:http';

const HASHED = /^assets\/.+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;
const PUBLIC_FILES = new Set(['/sw.js', '/manifest.webmanifest', '/manifest-v2.webmanifest', '/icon-192.png', '/icon-512.png']);

/** An install icon: one file name directly under /pwa/ (no folders, no "..", only images). */
const PWA_ICON = /^\/pwa\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.(?:png|svg)$/;

/** True for a path under /pwa/ or /assets/ that must be a real file there: a missing one is a 404, never index.html
 *  (review of P1/P2: /pwa/x/y/z, /pwa/index.html and /assets/index.html came back as the app's page, signed out,
 *  through the SPA fallback and its folder stripping). A share page's s/assets/… still strips to assets/… first. */
export function pwaFileOnly(rel: string): boolean {
  return /^(pwa|assets)[\\/]/.test(rel.replace(/^[\\/]+/, ''));
}

/** Cache-Control for a file of the built UI, by its path relative to dist-ui ("assets/index-AbC.js", "index.html"). */
export function uiCacheControl(rel: string): string {
  const r = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  return HASHED.test(r) ? 'public, max-age=31536000, immutable' : 'no-cache';
}

/** True for a built-UI file anyone may fetch without the password session (see the header). */
export function pwaPublic(pathname: string, req: Pick<IncomingMessage, 'method'>): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  return PUBLIC_FILES.has(pathname) || PWA_ICON.test(pathname);
}
