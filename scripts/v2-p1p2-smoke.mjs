#!/usr/bin/env node
/**
 * v2 build, slices P1 (installable app) and P2 (offline and updates): a Playwright run against a REAL local MWA server
 * serving the BUILT UI, with a fresh data folder. Chromium treats http://localhost as a secure context, so the service
 * worker, the install criteria and IndexedDB all work here as they will on the phone's https://<name>.<tailnet>.ts.net
 * (the real phone test needs Robert's tailnet: see the P1 notes in docs/onboarding-and-pairing.html).
 *
 *   node scripts/v2-p1p2-smoke.mjs --data <empty folder> [--axe <axe.min.js>] [--out <dir>] [--port 7899]
 *
 * It builds the UI (build A, web 1.0.0), starts `mwa serve` on the port (MWA_NO_OPEN=1), and checks:
 *   1. headers: hashed assets immutable; index.html, sw.js and the manifest no-cache; behind a password the worker,
 *      manifest and icons are public while "/" is still the sign-in page and index.html is public only to the precache
 *   2. install: the v2 manifest (start_url opens v2, standalone, maskable + monochrome icons, shortcuts) and Chromium's
 *      own installability check (no errors); the worker controls the page; Settings › This device shows the install card
 *   3. offline (the pages offline AND the server stopped: see dark()), reload — the app shell and the cached Today show with "Offline · showing what I had at …"
 *   4. an action made offline (New project) waits with a visible count, and is sent ONCE when back online
 *   5. a priced plan choice is refused offline in plain words (unit-tested in the store; here: Stop's refusal path is
 *      W4's smoke) — skipped here, no model on a fresh server
 *   6. a new deploy (build B, web 1.0.1): a page opened offline still gets build A whole (no stale index → deleted
 *      assets); the open page shows "A new version is ready · Reload"; with an action held in the outbox, Reload
 *      takes build B and the outbox is intact, then sent once
 *   7. v1 (?ui=v1) still loads and works, offline too; axe 0 violations on the banners and the install card
 *   8. the server is stopped by its PID; dist-ui is rebuilt with the default version at the end
 */
import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const OUT = resolve(arg('out', join(ROOT, 'reports', 'v2-p1p2-smoke')));
const DATA = arg('data', '');
const AXE = arg('axe', process.env.AXE_PATH ?? '');
const PORT = Number(arg('port', '7899'));
const BASE = `http://localhost:${PORT}`;
if (!DATA) { console.error('Give a fresh data folder: --data <folder>'); process.exit(2); }
mkdirSync(OUT, { recursive: true });
mkdirSync(DATA, { recursive: true });
const axeSrc = AXE && existsSync(AXE) ? readFileSync(AXE, 'utf8') : null;
if (!axeSrc) console.warn('! no axe-core given (--axe): accessibility checks are skipped');

const results = [];
let failed = 0;
function check(name, ok, detail = '') { results.push({ name, ok: !!ok, detail: String(detail ?? '') }); if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`); }
const H = { 'x-mwa-client': 'web/1.0.0' };

// ---------- build ----------
function build(version) {
  const r = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
    cwd: join(ROOT, 'web'), env: { ...process.env, MWA_WEB_VERSION: version }, encoding: 'utf8',
  });
  if (r.status !== 0) { console.error(r.stdout, r.stderr); throw new Error(`build ${version} failed`); }
  return JSON.parse(readFileSync(join(ROOT, 'dist-ui', 'pwa-build.json'), 'utf8'));
}

// ---------- the server ----------
const servers = [];
async function startServer(port, env = {}) {
  const dir = join(DATA, `srv-${port}`);
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, '.env'), '');
  const child = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'src', 'cli.ts'), 'serve'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MWA_SERVE_PORT: String(port), MWA_NO_OPEN: '1', MWA_DATA_DIR: join(dir, 'data'), MWA_ENV_PATH: join(dir, '.env'), MWA_CONFIG_PATH: join(dir, 'mwa.config.json'), MWA_ACCESS_PASSWORD: '', ...env },
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  servers.push(child);
  for (let i = 0; ; i++) {
    try { const r = await fetch(`http://localhost:${port}/api/health`); if (r.ok) break; } catch { /* not yet */ }
    if (i > 150 || child.exitCode !== null) { console.error(`server on ${port} did not start:\n${log}`); throw new Error('server'); }
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log(`  server on ${port}: PID ${child.pid}`);
  return { child, log: () => log };
}
function stopServer(s) {
  if (s.child.exitCode !== null) return;
  try { process.kill(s.child.pid); console.log(`  stopped PID ${s.child.pid}`); } catch (e) { console.log(`  stop PID ${s.child.pid}: ${e.message}`); }
}

// ---------- helpers ----------
async function axe(page, label, include) {
  if (!axeSrc) return;
  await page.addScriptTag({ content: axeSrc }).catch(() => {});
  const v = await page.evaluate(async (sel) => {
    const r = await window.axe.run(sel ? { include: [sel] } : document, { resultTypes: ['violations'] });
    return r.violations.map((x) => `${x.id} (${x.impact}): ${x.nodes.length} × ${x.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' | ')}`);
  }, include ?? null);
  check(`${label}: axe 0 violations`, v.length === 0, v.join('; '));
}
const shot = (page, name) => page.screenshot({ path: join(OUT, `${name}.png`) });
const seen = (loc, ms = 10_000) => loc.waitFor({ state: 'visible', timeout: ms }).then(() => true, () => false);
const controlled = (page) => page.evaluate(() => !!navigator.serviceWorker.controller);
async function waitControlled(page, ms = 15_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await controlled(page).catch(() => false)) return true; await page.waitForTimeout(200); }
  return false;
}
/** The entry script the page loaded. */
const entryOf = (page) => page.evaluate(() => document.querySelector('script[type="module"][src]')?.getAttribute('src')?.replace(/^\.?\//, ''));
/** What the store keeps in IndexedDB. */
const idb = (page) => page.evaluate(() => new Promise((res) => {
  const r = indexedDB.open('mwa-v2');
  r.onsuccess = () => {
    const db = r.result;
    const tx = db.transaction(['outbox', 'today', 'meta'], 'readonly');
    const out = {};
    let n = 0;
    const done = () => { if (++n === 3) { db.close(); res(out); } };
    const o = tx.objectStore('outbox').getAll(); o.onsuccess = () => { out.outbox = o.result.map((x) => ({ kind: x.kind, key: x.key, name: x.args?.payload?.name })); done(); };
    const t = tx.objectStore('today').count(); t.onsuccess = () => { out.today = t.result; done(); };
    const u = tx.objectStore('meta').get('updatedAt'); u.onsuccess = () => { out.updatedAt = u.result; done(); };
  };
  r.onerror = () => res(null);
}));
async function projectsNamed(name) {
  const j = await (await fetch(`${BASE}/api/v1/projects?archived=1`, { headers: H })).json();
  return (j.projects ?? []).filter((p) => p.name === name).length;
}

/**
 * Offline, for real. Playwright's setOffline does not reach a service worker's own fetches (Chromium emulates the
 * network per page), so a worker would still get pages from the server. Offline here is both: the pages are offline
 * (navigator.onLine false, their requests fail) AND the server is stopped, so the cache is the only place a page can
 * come from. light() starts it again on the same data folder and port.
 */
async function dark(ctx) { await ctx.setOffline(true); if (srv && srv.child.exitCode === null) { const gone = new Promise((r) => srv.child.once('exit', r)); stopServer(srv); await gone; } }
async function light(ctx) { srv = await startServer(PORT); await ctx.setOffline(false); }

const browser = await chromium.launch({ args: [`--host-resolver-rules=MAP mwa-insecure.test 127.0.0.1`] });
let srv = null, locked = null;
try {
  console.log('building A (web 1.0.0)…');
  const A = build('1.0.0');
  srv = await startServer(PORT);

  // ---------- 1. headers ----------
  {
    const hashed = await fetch(`${BASE}/${A.entry}`);
    check('headers: a hashed asset is immutable for a year', hashed.headers.get('cache-control') === 'public, max-age=31536000, immutable', hashed.headers.get('cache-control'));
    for (const p of ['/', '/index.html', '/sw.js', '/manifest-v2.webmanifest']) {
      const r = await fetch(`${BASE}${p}`);
      check(`headers: ${p} is no-cache`, r.status === 200 && r.headers.get('cache-control') === 'no-cache', `${r.status} ${r.headers.get('cache-control')}`);
    }
    const m = await fetch(`${BASE}/manifest-v2.webmanifest`);
    check('headers: the manifest is application/manifest+json', m.headers.get('content-type') === 'application/manifest+json');
    const sw = await (await fetch(`${BASE}/sw.js`)).text();
    check('the worker lists this build', sw.includes(A.buildId) && sw.includes(A.entry));

    locked = await startServer(PORT + 1, { MWA_ACCESS_PASSWORD: 'p1p2-test-password' });
    const L = `http://localhost:${PORT + 1}`;
    const get = (p, h = {}) => fetch(`${L}${p}`, { headers: h, redirect: 'manual' });
    const root = await (await get('/')).text();
    check('behind a password: "/" is still the sign-in page', root.includes('/api/login'));
    for (const p of ['/sw.js', '/manifest-v2.webmanifest', '/pwa/maskable-512.png', '/pwa/icon.svg']) {
      const r = await get(p); const t = await r.text();
      check(`behind a password: ${p} is public (not the sign-in page)`, r.status === 200 && !t.includes('/api/login'));
    }
    check('behind a password: index.html is the sign-in page for a person…', (await (await get('/index.html')).text()).includes('/api/login'));
    const pre = await (await get('/index.html', { 'x-mwa-sw': 'precache' })).text();
    check('…and the app shell for the worker\'s precache request', pre.includes(A.entry) && !pre.includes('/api/login'));
    check('behind a password: the API is still locked', (await get('/api/v1/projects', H)).status === 401);
    for (const p of ['/pwa/x/y/z', '/pwa/index.html', '/pwa/anything']) {
      const open = await fetch(`${BASE}${p}`); const ot = await open.text();
      check(`fix 3: ${p} is a 404 (never the app's page through the SPA fallback)`, open.status === 404 && !ot.includes('assets/index-'), `${open.status}`);
      check(`fix 3: behind a password, ${p} is the sign-in page (not public, not the app)`, !(await (await get(p)).text()).includes('assets/index-'));
    }
    stopServer(locked);
  }

  // ---------- 2. install ----------
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await ctx.addInitScript(() => { window.addEventListener('beforeinstallprompt', () => { window.__bip = true; }); });
  await page.goto(`${BASE}/?ui=v2`);
  check('v2 opens on the real server (Today)', await seen(page.locator('#main h1'), 20_000), await page.locator('body').innerText().catch(() => ''));
  check('the worker installs and controls the page', await waitControlled(page));
  const cdp = await ctx.newCDPSession(page);
  const man = await cdp.send('Page.getAppManifest');
  check('the page links the v2 manifest', /manifest-v2\.webmanifest$/.test(man.url), man.url);
  check('the manifest parses without errors', (man.errors ?? []).length === 0, JSON.stringify(man.errors));
  const mj = JSON.parse(man.data);
  check('manifest: start_url opens v2 from the home screen; standalone; an id', mj.start_url === './?ui=v2&source=pwa' && mj.display === 'standalone' && !!mj.id && mj.scope === './');
  const v1m = await (await fetch(`${BASE}/manifest.webmanifest`)).json();
  check('fix 9: v1 and v2 manifests share one id (home-screen installs survive the W6 cutover)', v1m.id === mj.id && mj.id === './', `${v1m.id} / ${mj.id}`);
  check('manifest: maskable 192 + 512 and a monochrome icon', ['192x192', '512x512'].every((s) => mj.icons.some((i) => i.purpose === 'maskable' && i.sizes === s)) && mj.icons.some((i) => i.purpose === 'monochrome'));
  check('manifest: shortcuts Ask, Today, Important', JSON.stringify(mj.shortcuts.map((s) => s.name)) === JSON.stringify(['Ask', 'Today', 'Important']));
  check('manifest: theme and background from the Instrument tokens', mj.theme_color === '#e8e6e1' && mj.background_color === '#e8e6e1');
  for (const i of mj.icons) {
    const r = await fetch(new URL(i.src, `${BASE}/`));
    check(`icon ${i.src} is served (${i.type})`, r.ok && (r.headers.get('content-type') ?? '').startsWith(i.type.split('+')[0]));
  }
  const inst = await cdp.send('Page.getInstallabilityErrors');
  check('Chromium: installable (no installability errors)', inst.installabilityErrors.length === 0, JSON.stringify(inst.installabilityErrors));
  const bip = await page.evaluate(() => !!window.__bip);
  console.log(`  (beforeinstallprompt ${bip ? 'fired' : 'did not fire in headless Chromium; the manifest/worker check above stands in for it'})`);
  const ver = await (await fetch(`${BASE}/api/v1/meta`)).json();
  check('/meta: secure on localhost, minClient reported', ver.secure === true && !!ver.minClient, JSON.stringify(ver));

  // Settings › This device › Install on this phone
  await page.goto(`${BASE}/?ui=v2&view=settings`);
  const card = page.locator('#install-card');
  check('Settings › This device: the install card', await seen(card));
  check('the install card says how (Install, or the browser\'s menu)', /Install/.test(await card.innerText()));
  await shot(page, '01-settings-install');
  await axe(page, 'Settings with the install card');
  // an address the phone will not install from (Chromium: http on a name that is not localhost)
  {
    const ic = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const p2 = await ic.newPage();
    await p2.goto(`http://mwa-insecure.test:${PORT}/?fixtures=1&view=settings`);
    const t = await p2.locator('#install-card').innerText({ timeout: 15_000 }).catch(() => '');
    check('insecure address: "Your phone needs the secure address to install — open https://…ts.net"', t.includes('Your phone needs the secure address to install — open https://<your-helper>.<your-tailnet>.ts.net'), t);
    check('insecure address: no worker registered', !(await p2.evaluate(() => navigator.serviceWorker ? navigator.serviceWorker.getRegistrations().then((r) => r.length) : 0)));
    await shot(p2, '02-insecure-install');
    await ic.close();
  }

  // ---------- 3. offline: the shell and the cached Today ----------
  await page.goto(`${BASE}/?ui=v2`);
  await seen(page.locator('#main h1'), 20_000);
  await page.waitForTimeout(1_500); // Today fetched and cached
  const before = await idb(page);
  check('online: Today and the time it was saved are in IndexedDB', before && before.today >= 1 && before.updatedAt > 0, JSON.stringify(before));
  const h1 = await page.locator('#main h1').innerText();
  await dark(ctx);
  await page.reload();
  check('offline reload: the app shell opens (from the worker\'s cache)', await seen(page.locator('#main h1'), 15_000));
  check('offline reload: the cached Today shows', (await page.locator('#main h1').innerText().catch(() => '')) === h1);
  const savedAt = new Date(before.updatedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const bar = page.locator('#offlinebar');
  check(`offline banner: "Offline · showing what I had at ${savedAt}"`, await seen(bar) && (await bar.innerText()).includes(`Offline · showing what I had at ${savedAt}`), await bar.innerText().catch(() => ''));

  // ---------- 4. an action made offline: a visible count, sent once ----------
  const NAME = 'Made offline (P2)';
  const posts = [];
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/v1/projects')) posts.push(r.headers()['idempotency-key']); });
  await page.locator('#tabbar').getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('button', { name: 'New project' }).click();
  await page.locator('#np-name').fill(NAME);
  await page.getByRole('button', { name: 'Create' }).click();
  check('offline: the new project waits ("You’re offline…")', await seen(page.locator('#toasts').getByText('You’re offline', { exact: false }), 5_000));
  check('offline banner: "1 thing will be sent when you’re back online"', (await bar.innerText()).includes('1 thing will be sent when you’re back online'), await bar.innerText());
  await shot(page, '03-offline-banner');
  await axe(page, 'offline banner', '#offlinebar');
  const held = await idb(page);
  check('the outbox holds it in IndexedDB with its key', held.outbox.length === 1 && held.outbox[0].kind === 'project.create' && !!held.outbox[0].key, JSON.stringify(held.outbox));
  await light(ctx);
  const t0 = Date.now();
  while (Date.now() - t0 < 15_000 && (await idb(page)).outbox.length) await page.waitForTimeout(200);
  await page.waitForTimeout(500);
  check('back online: sent, the outbox is empty, the banner gone', (await idb(page)).outbox.length === 0 && !(await bar.isVisible()));
  check('the server made it once', (await projectsNamed(NAME)) === 1, `${await projectsNamed(NAME)} projects named "${NAME}"`);
  check('one request, with the key it was queued with', posts.length === 1 && posts[0] === held.outbox[0].key, JSON.stringify(posts));

  // ---------- 6. a new deploy ----------
  console.log('building B (web 1.0.1)…');
  const B = build('1.0.1');
  check('build B is a different build with a different entry', B.buildId !== A.buildId && B.entry !== A.entry);
  check('build A\'s entry is gone from the server (deleted hashed asset)', (await fetch(`${BASE}/${A.entry}`)).status === 404);
  // a page opened offline before the update is taken: build A, whole, from the cache
  {
    await dark(ctx);
    const p3 = await ctx.newPage();
    const p3errors = [];
    p3.on('pageerror', (e) => p3errors.push(String(e)));
    await p3.goto(`${BASE}/?ui=v2`);
    const ok3 = await seen(p3.locator('#main h1'), 15_000), e3 = await entryOf(p3);
    await shot(p3, '04a-offline-after-deploy');
    check('offline after the deploy: a new page opens build A from the cache (never an index.html whose assets are gone)', ok3 && e3 === A.entry,
      `h1 ${ok3} · entry ${e3} · A ${A.entry} · B ${B.entry} · ${p3errors.join(' | ')} · ${await p3.locator('body').innerText().catch(() => '')}`.slice(0, 600));
    await p3.close();
    await light(ctx);
  }
  // an action that cannot get through right now (the API unreachable for it): it waits in the outbox across the update
  const NAME2 = 'Waits through the update (P2)';
  // review fix 5: a third action is left hanging (never answered) to be IN FLIGHT when Reload is tapped
  const NAME3 = 'In flight at Reload (P2)';
  const heldKeys = [];
  await page.route('**/api/v1/projects', (r) => {
    const q = r.request();
    if (q.method() !== 'POST') return r.continue();
    if ((q.postData() ?? '').includes(NAME3)) { heldKeys.push(q.headers()['idempotency-key']); return undefined; } // never answered
    return r.abort('internetdisconnected');
  });
  await page.getByRole('button', { name: 'New project' }).click();
  await page.locator('#np-name').fill(NAME2);
  await page.getByRole('button', { name: 'Create' }).click();
  await page.waitForTimeout(500);
  const kept = await idb(page);
  check('an action that could not be sent waits in the outbox', kept.outbox.length === 1 && kept.outbox[0].name === NAME2, JSON.stringify(kept.outbox));
  // the browser looks for a new worker (on navigation, focus, or every half hour); ask now
  await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r && r.update()));
  const banner = page.getByRole('alert').filter({ hasText: 'A new version is ready' });
  check('the open page: "A new version is ready · Reload"', await seen(banner, 20_000) && await banner.getByRole('button', { name: 'Reload' }).isVisible());
  check('…and nothing reloaded by itself (still build A)', (await entryOf(page)) === A.entry);
  await shot(page, '04-update-ready');
  await axe(page, 'update banner', '.updatebar');
  const waitingBuild = await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => !!r?.waiting));
  check('the new worker is waiting', waitingBuild);
  await page.getByRole('button', { name: 'New project' }).click();
  await page.locator('#np-name').fill(NAME3);
  await page.getByRole('button', { name: 'Create' }).click();
  for (let i = 0; i < 50 && !heldKeys.length; i++) await page.waitForTimeout(100);
  check('fix 5: an action is in flight (its request never answered) when Reload is tapped', heldKeys.length === 1);
  const tReload = Date.now();
  await Promise.all([page.waitForEvent('load', { timeout: 45_000 }), banner.getByRole('button', { name: 'Reload' }).click()]);
  console.log(`  (Reload waited ${((Date.now() - tReload) / 1000).toFixed(1)} s for the action in flight, then parked it)`);
  await seen(page.locator('#main h1'), 20_000);
  check('Reload: the page runs build B', (await entryOf(page)) === B.entry, await entryOf(page));
  const swNow = await page.evaluate(() => new Promise((res) => {
    const c = navigator.serviceWorker.controller; if (!c) return res(null);
    const ch = new MessageChannel(); ch.port1.onmessage = (m) => res(m.data); c.postMessage({ type: 'GET_BUILD' }, [ch.port2]);
    setTimeout(() => res(null), 3_000);
  }));
  check('Reload: build B\'s worker controls the page', swNow && swNow.buildId === B.buildId, JSON.stringify(swNow));
  check('Reload: no update banner any more', !(await banner.isVisible().catch(() => false)));
  const after = await idb(page);
  check('the outbox survived the update', after.outbox.some((x) => x.name === NAME2 && x.key === kept.outbox[0].key), JSON.stringify(after.outbox));
  check('fix 5: the action in flight at Reload is in the outbox after it, with its key (not lost)', after.outbox.some((x) => x.name === NAME3 && x.key === heldKeys[0]), JSON.stringify(after.outbox));
  await page.unroute('**/api/v1/projects');
  await ctx.setOffline(true); await page.waitForTimeout(300); await ctx.setOffline(false); // the network comes back
  const t1 = Date.now();
  while (Date.now() - t1 < 15_000 && (await idb(page)).outbox.length) await page.waitForTimeout(200);
  check('…and is sent once after it', (await projectsNamed(NAME2)) === 1, `${await projectsNamed(NAME2)}`);
  check('fix 5: …and the one in flight too, once', (await projectsNamed(NAME3)) === 1, `${await projectsNamed(NAME3)}`);
  // offline again: build B from its own cache
  await dark(ctx);
  await page.reload();
  check('offline after the update: build B from the cache', await seen(page.locator('#main h1'), 15_000) && (await entryOf(page)) === B.entry);
  await light(ctx);

  // ---------- fix 7: a 401 clears the phone's copy ----------
  {
    await page.route('**/api/v1/**', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'locked', message: 'Sign in to continue.' } }) }));
    await page.reload();
    const signin = page.getByRole('heading', { name: 'Sign in to continue' });
    check('fix 7: a 401 shows the sign-in screen', await seen(signin, 15_000));
    check('fix 7: and says "Signed out — this phone’s copy was cleared"', await seen(page.getByText('Signed out — this phone’s copy was cleared'), 5_000));
    await page.waitForTimeout(500);
    const wiped = await idb(page);
    check('fix 7: IndexedDB is empty (Today, the outbox)', wiped.today === 0 && wiped.outbox.length === 0 && !wiped.updatedAt, JSON.stringify(wiped));
    await shot(page, '07-signed-out-cleared');
    await axe(page, 'signed out');
    // offline, last known "signed out": nothing cached shows
    await dark(ctx);
    await page.unroute('**/api/v1/**');
    await page.reload();
    check('fix 7: offline after a sign-out: the sign-in screen, no cached Today', await seen(signin, 15_000) && !(await page.locator('#offlinebar').isVisible().catch(() => false)));
    await light(ctx);
    await page.reload();
    check('fix 7: signed in again (a good connect): the app is back', await seen(page.locator('#main h1').filter({ hasNotText: 'Sign in to continue' }), 20_000));
  }

  // ---------- 7. v1 ----------
  const v1 = await ctx.newPage();
  const v1errors = [];
  v1.on('pageerror', (e) => v1errors.push(String(e)));
  await v1.goto(`${BASE}/?ui=v1`);
  // a fresh server has no model yet, so v1 opens on its setup ("Pick a brain to think with.")
  const v1first = v1.getByRole('heading', { name: 'Pick a brain to think with.' });
  check('v1 (?ui=v1) loads (its first-run setup, on a server with no model yet)', await seen(v1first, 20_000));
  const v1manifest = await v1.evaluate(() => document.querySelector('link[rel="manifest"]')?.getAttribute('href'));
  check('v1 keeps its own manifest', v1manifest === 'manifest.webmanifest', v1manifest);
  check('v1 is controlled by the same worker', await controlled(v1));
  const st = await v1.evaluate(() => fetch('/api/status').then((r) => r.status));
  check('v1 works: its API answers through the page', st === 200, String(st));
  await v1.getByRole('button', { name: /^Local/ }).first().click();
  check('v1 works: its setup moves on (Local · Ollama)', await seen(v1.getByText(/Ollama/i).nth(1), 10_000).catch(() => false) || !(await v1first.isVisible()));
  await shot(v1, '05-v1');
  await dark(ctx);
  await v1.reload();
  check('v1 offline: its shell opens from the cache', await seen(v1.locator('#root *').first(), 15_000) && (await v1.locator('#root').innerText()).trim().length > 0);
  await shot(v1, '06-v1-offline');
  await light(ctx);
  // fix 1: v1's reload-on-401 happens once; a second 401 shows a sign-in notice instead of reloading again
  {
    let navs = 0;
    v1.on('framenavigated', (f) => { if (f === v1.mainFrame()) navs++; });
    await v1.route('**/api/status', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"locked"}' }));
    await v1.evaluate(() => sessionStorage.removeItem('mwa-401-reloaded'));
    navs = 0;
    await v1.reload();
    await v1.waitForTimeout(6_000);
    const notice = v1.getByRole('alertdialog', { name: 'Sign in to continue' });
    check('fix 1: v1 with a 401 that a reload cannot fix: one reload, then the sign-in notice (no loop)', navs <= 2 && await seen(notice, 5_000), `${navs} navigations`);
    await shot(v1, '08-v1-signin-notice');
    await axe(v1, 'v1 sign-in notice', '#mwa-signin-notice');
    await v1.unroute('**/api/status');
  }
  check('v1: no page errors', v1errors.length === 0, v1errors.join(' | '));
  check('v2: no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) {
  check('the run finished', false, e.stack ?? String(e));
} finally {
  await browser.close().catch(() => {});
  for (const s of [srv, locked]) if (s) stopServer(s);
  console.log('rebuilding dist-ui with the default version…');
  try { build(JSON.parse(readFileSync(join(ROOT, 'web', 'package.json'), 'utf8')).version); } catch (e) { console.error(String(e)); }
}

writeFileSync(join(OUT, 'results.json'), JSON.stringify({ at: new Date().toISOString(), failed, results }, null, 2));
console.log(`\n${results.length - failed}/${results.length} passed${failed ? ` — ${failed} FAILED` : ''}. Screenshots: ${OUT}`);
process.exit(failed ? 1 : 0);
