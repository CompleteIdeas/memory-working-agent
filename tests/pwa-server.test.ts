// v2 build, slices P1/P2: the server's cache headers for the built UI and which of its files are public behind the
// password (src/pwa.ts), and npm run tailscale:serve's checks (scripts/tailscale-serve.mjs). The real server's answers are checked end to end by scripts/v2-p1p2-smoke.mjs.
import { describe, it, expect } from 'vitest';
import { pwaPublic, pwaFileOnly, uiCacheControl } from '../src/pwa';
import { signedOutPageAllowed } from '../src/api/legacy';
import { SHELL_FETCH } from '../web/src/pwa/sw-logic';
import { assess, funnelOn, servePort, envLines, ADMIN_DNS, existingHandler, statusReadable, OFF_CMD } from '../scripts/tailscale-serve.mjs';

const get = (headers: Record<string, string> = {}) => ({ method: 'GET', headers });

describe('cache headers', () => {
  it('hashed assets are immutable for a year', () => {
    expect(uiCacheControl('assets/index-B9PTCNEz.js')).toBe('public, max-age=31536000, immutable');
    expect(uiCacheControl('assets\\index-DFXNrC8q.css')).toBe('public, max-age=31536000, immutable');
  });
  it('index.html, the worker, the manifests and everything else are always revalidated', () => {
    for (const f of ['index.html', 'sw.js', 'manifest-v2.webmanifest', 'manifest.webmanifest', 'pwa/icon-192.png', 'pwa-build.json', 'assets/logo.svg']) {
      expect(uiCacheControl(f)).toBe('no-cache');
    }
  });
});

describe('public behind the password', () => {
  it('the worker, the manifests and the install icons (a manifest is fetched without cookies)', () => {
    for (const p of ['/sw.js', '/manifest-v2.webmanifest', '/manifest.webmanifest', '/pwa/maskable-512.png', '/pwa/icon.svg', '/icon-192.png']) {
      expect(pwaPublic(p, get())).toBe(true);
    }
  });
  it('index.html is never public by itself; the worker gets the shell as a ?ui=v2 page, which W5’s gate lets in', () => {
    expect(pwaPublic('/index.html', get())).toBe(false);
    expect(pwaPublic('/', get())).toBe(false);
    expect(pwaPublic('/api/v1/sync', get())).toBe(false);
    expect(pwaPublic('/sw.js', { method: 'POST' })).toBe(false);
    expect(SHELL_FETCH).toBe('index.html?ui=v2');
    const u = new URL(SHELL_FETCH, 'https://mwa.tail1a2b.ts.net/');
    expect(signedOutPageAllowed(u.pathname, u.search, false)).toBe(true);
    expect(signedOutPageAllowed('/', '', false)).toBe(false); // a person opening "/" signed out: the sign-in page
  });
  it('review fix 3: only real icon files under /pwa/ are public; anything else there is a file-or-404 path', () => {
    for (const p of ['/pwa/index.html', '/pwa/anything', '/pwa/x/y/z', '/pwa/../api/files', '/pwa/%2e%2e/api/files', '/pwa/sw.js', '/pwa/pwa-build.json']) {
      expect(pwaPublic(p, get())).toBe(false);
    }
    expect(pwaFileOnly('pwa/x/y/z')).toBe(true);
    expect(pwaFileOnly(String.raw`pwa\index.html`)).toBe(true); // Windows path.normalize
    expect(pwaFileOnly('assets/index.html')).toBe(true); // /assets/ is public signed out too: no SPA fallback there
    expect(pwaFileOnly('s/assets/index-AbCd1234.js')).toBe(false); // a share page's assets still strip to assets/
    expect(pwaFileOnly('index.html')).toBe(false);
    expect(pwaFileOnly('')).toBe(false);
  });
});

// npm run tailscale:serve (scripts/tailscale-serve.mjs): its reading of Tailscale's own status

describe('tailscale:serve checks', () => {
  const ready = { BackendState: 'Running', CurrentTailnet: { MagicDNSEnabled: true }, CertDomains: ['mwa.tail1a2b.ts.net'], Self: { DNSName: 'mwa.tail1a2b.ts.net.' } };
  it('ready: the machine\'s name, no problems', () => {
    expect(assess(ready)).toEqual({ ok: true, host: 'mwa.tail1a2b.ts.net', problems: [] });
    const lines = envLines('mwa.tail1a2b.ts.net');
    expect(lines.slice(0, 3)).toEqual(['MWA_PUBLIC_URL=https://mwa.tail1a2b.ts.net', 'MWA_ALLOWED_HOSTS=mwa.tail1a2b.ts.net', 'MWA_TRUSTED_PROXY=127.0.0.1']);
    expect(lines[3]).toMatch(/^MWA_ACCESS_PASSWORD=.*required/);
  });
  it('says plainly how to switch on MagicDNS and HTTPS certificates (as on Robert\'s tailnet today: certificates off)', () => {
    const a = assess({ ...ready, CertDomains: null });
    expect(a.ok).toBe(false);
    expect(a.problems).toEqual([expect.stringContaining(`HTTPS certificates are off. Switch them on: ${ADMIN_DNS} → HTTPS Certificates → Enable HTTPS.`)]);
    const b = assess({ ...ready, CurrentTailnet: { MagicDNSEnabled: false }, CertDomains: [] });
    expect(b.problems[0]).toContain('MagicDNS is off');
    expect(assess({ BackendState: 'NeedsLogin' }).problems[0]).toMatch(/not signed in/);
    expect(assess(null).ok).toBe(false);
  });
  it("review fix 8: --off removes only MWA's '/' handler on 443; another handler is found before it is replaced; an unreadable status stops (fails closed)", () => {
    expect(OFF_CMD).toEqual(['serve', '--https=443', '--set-path=/', 'off']);
    expect(existingHandler({})).toBeNull();
    expect(existingHandler({ Web: { 'mwa.tail1a2b.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } })).toBe('http://127.0.0.1:3000');
    expect(existingHandler({ Web: { 'mwa.tail1a2b.ts.net:443': { Handlers: { '/files': { Path: '/x' } } } } })).toBeNull();
    expect(existingHandler({ Web: { 'mwa.tail1a2b.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:1' } } } } })).toBeNull();
    expect(existingHandler({ Web: { 'mwa.tail1a2b.ts.net:443': { Handlers: { '/': { Text: 'hi' } } } } })).toBe('other');
    expect(statusReadable(0, {})).toBe(true); // "nothing served" is {}
    expect(statusReadable(1, {})).toBe(false);
    expect(statusReadable(0, null)).toBe(false);
  });
  it('Funnel (a public address) on for any port is refused', () => {
    expect(funnelOn({ AllowFunnel: { 'mwa.tail1a2b.ts.net:443': true } })).toBe(true);
    expect(funnelOn({ TCP: { 443: { HTTPS: true } } })).toBe(false);
    expect(funnelOn(null)).toBe(false);
  });
  it('the port: MWA_SERVE_PORT, then PORT, from the environment then .env, then 7788', () => {
    expect(servePort({}, '')).toBe(7788);
    expect(servePort({}, '# MWA_SERVE_PORT=1\nPORT=8080\n')).toBe(8080);
    expect(servePort({ PORT: '9000' }, 'MWA_SERVE_PORT="7799"')).toBe(7799); // MWA_SERVE_PORT wins wherever it is
    expect(servePort({ MWA_SERVE_PORT: '7801' }, 'MWA_SERVE_PORT=7799')).toBe(7801);
  });
});
