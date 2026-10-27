#!/usr/bin/env node
/**
 * v2 build, slice P3 (web push): a Playwright run against a REAL local MWA server serving the BUILT UI, with a fresh
 * data folder and a local MOCK push service. Chromium cannot hand out a real push subscription without Google's
 * service, so the page's PushManager.subscribe is replaced (an init script) by one that returns a subscription at the
 * mock, with keys this script made: the rest is real — the permission (granted to the context), the Settings flow,
 * the server's subscription check (it accepts the mock's loopback origin only because the server runs with
 * NODE_ENV=test and MWA_PUSH_TEST_ORIGIN naming it), the notifier, the RFC 8291 encryption, the service worker.
 *
 *   node --import tsx scripts/v2-p3-push-smoke.mjs --data <empty folder> [--axe <axe.min.js>] [--out <dir>] [--port 7897]
 *
 * It checks:
 *   1. Settings › Notifications says "Off", asks for the permission only on the tap, and turns on (the server lists a
 *      subscription for this machine at the mock)
 *   2. a job that reaches its dollar limit ("waiting for you") makes the server POST to the mock: aes128gcm, a VAPID
 *      JWT, a TTL and Topic; the body decrypts with the browser's keys to exactly {kind:"waiting", id, tag} and holds
 *      no job title; one push only (a second tick sends nothing)
 *   3. that payload delivered to the service worker (CDP ServiceWorker.deliverPushMessage) shows "A job is waiting for
 *      you" with the tag mwa-waiting; a notificationclick on it opens the working sheet at that job in the open page
 *   4. "Send a test" reaches the mock and the page says which push service took it (not "delivered")
 *   3b. with only a classic (v1) tab open, a tap opens the job in v2 there, and the stored choice of v1 is kept
 *   5. Turn off: the server forgets it; axe on the section
 *   6. a paired phone (fixture world) sees the shared settings read-only, with a plain line why; axe
 *   6. the server is stopped by its PID; the mock is closed
 */
import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createECDH, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const OUT = resolve(arg('out', join(ROOT, 'reports', 'v2-p3-push-smoke')));
const DATA = arg('data', '');
const PORT = Number(arg('port', '7897'));
const BASE = `http://localhost:${PORT}`;
if (!DATA) { console.error('Give a fresh data folder: --data <folder>'); process.exit(2); }
mkdirSync(OUT, { recursive: true });
mkdirSync(DATA, { recursive: true });
const { decryptPayload } = await import(pathToFileURL(join(ROOT, 'src', 'v2', 'webpush.ts')).href);

const AXE = arg('axe', process.env.AXE_PATH ?? '');
const axeSrc = AXE && existsSync(AXE) ? readFileSync(AXE, 'utf8') : null;
if (!axeSrc) console.warn('! no axe-core given (--axe): accessibility checks are skipped');
async function axe(pg, label, include) {
  if (!axeSrc) return;
  await pg.addScriptTag({ content: axeSrc }).catch(() => {});
  const v = await pg.evaluate(async (sel) => {
    const r = await window.axe.run(sel ? { include: [sel] } : document, { resultTypes: ['violations'] });
    return r.violations.map((x) => `${x.id} (${x.impact}): ${x.nodes.length} × ${x.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' | ')}`);
  }, include ?? null);
  check(`${label}: axe 0 violations`, v.length === 0, v.join('; '));
}
const results = [];
let failed = 0;
function check(name, ok, detail = '') { results.push({ name, ok: !!ok, detail: String(detail ?? '') }); if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`); }
const H = { 'x-mwa-client': 'web/1.0.0' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- the mock push service ----------
const pushes = [];
const mock = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => { pushes.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) }); res.writeHead(201); res.end(); });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const MOCK = `http://127.0.0.1:${mock.address().port}`;
console.log(`  mock push service at ${MOCK}`);

// the browser's push keys (the subscription the fake PushManager hands out)
const ua = createECDH('prime256v1'); ua.generateKeys();
const AUTH = randomBytes(16);
const FAKE = { endpoint: `${MOCK}/push/${randomBytes(8).toString('hex')}`, p256dh: ua.getPublicKey().toString('base64url'), auth: AUTH.toString('base64url') };

// ---------- build and serve ----------
console.log('building the UI…');
{
  const r = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], { cwd: join(ROOT, 'web'), encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stdout, r.stderr); process.exit(1); }
}
const SRV = join(DATA, `srv-${PORT}`);
mkdirSync(join(SRV, 'data'), { recursive: true });
writeFileSync(join(SRV, '.env'), '');
const child = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'src', 'cli.ts'), 'serve'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env, MWA_SERVE_PORT: String(PORT), MWA_NO_OPEN: '1', MWA_DATA_DIR: join(SRV, 'data'), MWA_ENV_PATH: join(SRV, '.env'), MWA_CONFIG_PATH: join(SRV, 'mwa.config.json'),
    MWA_ACCESS_PASSWORD: '', NODE_ENV: 'test', MWA_PUSH_TEST_ORIGIN: MOCK, MWA_PUSH_TICK_MS: '1000', MWA_TZ: 'UTC',
  },
});
let log = '';
child.stdout.on('data', (d) => { log += d; });
child.stderr.on('data', (d) => { log += d; });
for (let i = 0; ; i++) {
  try { const r = await fetch(`${BASE}/api/health`); if (r.ok) break; } catch { /* not yet */ }
  if (i > 150 || child.exitCode !== null) { console.error(`server did not start:\n${log}`); process.exit(1); }
  await sleep(200);
}
console.log(`  server on ${PORT}: PID ${child.pid}`);
const stop = () => { if (child.exitCode === null) { try { process.kill(child.pid); console.log(`  stopped PID ${child.pid}`); } catch (e) { console.log(`  stop PID ${child.pid}: ${e.message}`); } } };

function findAppDb(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (f === 'app.db') return p;
    if (statSync(p).isDirectory()) { const x = findAppDb(p); if (x) return x; }
  }
  return null;
}

// the full Chromium in new headless mode: the old headless shell reports Notification.permission as "denied" always
const browser = await chromium.launch({ channel: 'chromium' });
try {
  {
    const r = await fetch(`${BASE}/api/v1/settings`, { method: 'PATCH', headers: { ...H, 'content-type': 'application/json', 'idempotency-key': `p3-${Date.now()}`, origin: BASE }, body: JSON.stringify({ firstRunDone: true }) });
    check('setup: first run marked done on the fresh helper', r.ok, `${r.status} ${await r.text()}`);
  }
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  await ctx.grantPermissions(['notifications'], { origin: BASE });
  // the page's PushManager: a subscription at the mock, with this script's keys (the only thing that is not real)
  await ctx.addInitScript((f) => {
    if (typeof PushManager === 'undefined') return;
    const b64 = (s) => { const t = s.replace(/-/g, '+').replace(/_/g, '/'); const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4)); return Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer; };
    // kept across reloads, as a real subscription is
    const saved = () => { try { const k = localStorage.getItem('__fake_push_key'); return k ? Uint8Array.from(JSON.parse(k)).buffer : null; } catch { return null; } };
    const make = (key) => ({
      endpoint: f.endpoint, expirationTime: null, options: { applicationServerKey: key, userVisibleOnly: true },
      getKey: (n) => b64(n === 'p256dh' ? f.p256dh : f.auth),
      toJSON: () => ({ endpoint: f.endpoint, expirationTime: null, keys: { p256dh: f.p256dh, auth: f.auth } }),
      unsubscribe: async () => { current = null; localStorage.removeItem('__fake_push_key'); return true; },
    });
    let current = saved() ? make(saved()) : null;
    PushManager.prototype.subscribe = async function (o) {
      window.__subscribeCalls = (window.__subscribeCalls ?? 0) + 1;
      const key = o.applicationServerKey instanceof ArrayBuffer ? o.applicationServerKey : o.applicationServerKey.buffer;
      localStorage.setItem('__fake_push_key', JSON.stringify(Array.from(new Uint8Array(key))));
      current = make(key); return current;
    };
    PushManager.prototype.getSubscription = async function () { return current; };
  }, FAKE);
  let page = await ctx.newPage();
  await page.goto(`${BASE}/?ui=v2&view=settings`);
  // the worker must control the page (it shows the notification and answers the tap)
  for (let i = 0; i < 75 && !(await page.evaluate(() => !!navigator.serviceWorker.controller).catch(() => false)); i++) await sleep(200);
  check('the service worker controls the page', await page.evaluate(() => !!navigator.serviceWorker.controller));

  // ---------- 1. turn on ----------
  const state = page.locator('#notify-state');
  await state.waitFor({ timeout: 15_000 });
  check('Settings › Notifications: "Off" before the tap, and nothing asked yet', (await state.getAttribute('data-state')) === 'off' && !(await page.evaluate(() => window.__subscribeCalls ?? 0)), await state.textContent());
  await page.getByRole('button', { name: 'Turn on notifications' }).click();
  await page.waitForFunction(() => document.querySelector('#notify-state')?.getAttribute('data-state') === 'on', null, { timeout: 15_000 }).catch(() => {});
  check('after the tap: "On for this device"', (await state.getAttribute('data-state')) === 'on', await state.textContent());
  await page.screenshot({ path: join(OUT, '1-notifications-on.png'), fullPage: true });
  const list = await (await fetch(`${BASE}/api/v1/push/subscriptions`, { headers: H })).json();
  check('the server keeps one subscription, at the test push service, for this machine', list.subscriptions.length === 1 && list.subscriptions[0].vendor === 'test' && list.subscriptions[0].owner === 'local', JSON.stringify(list.subscriptions));
  const foreign = await fetch(`${BASE}/api/v1/push/subscriptions`, { method: 'POST', headers: { ...H, origin: BASE, 'content-type': 'application/json', 'idempotency-key': `p3-f-${Date.now()}` }, body: JSON.stringify({ endpoint: 'https://evil.example/push', keys: { p256dh: FAKE.p256dh, auth: FAKE.auth } }) });
  check('a foreign push address is refused (400 bad_endpoint)', foreign.status === 400 && (await foreign.json()).error.code === 'bad_endpoint');

  // ---------- 2. a job waits for the person: the server pushes ----------
  const appDb = findAppDb(SRV);
  check('found the server\'s app.db', !!appDb, SRV);
  process.env.MWA_APP_DB = appDb;
  const jobs = await import(pathToFileURL(join(ROOT, 'src', 'v2', 'jobs.ts')).href);
  const TITLE = 'PLANTED Dr Smith biopsy results';
  const j = jobs.createJob({ kind: 'background', title: TITLE, request: TITLE, capUsd: 0.5 }, { trigger: 'first' });
  jobs.claimTry(j.try.id, {});
  jobs.endTry(j.try.id, { reason: 'budget', outcome: 'changed', capHit: 'usd', summary: 'Read 3 of 10 pages about PLANTED', progress: { done: 3, total: 10, unit: 'pages' } });
  const before = pushes.length;
  for (let i = 0; i < 75 && pushes.length === before; i++) await sleep(200);
  const p = pushes[before];
  check('the server POSTed to the push service within a few seconds', !!p, `pushes: ${pushes.length}`);
  let payloadText = '';
  if (p) {
    check('…encrypted (aes128gcm) with a VAPID token, a TTL and a Topic', p.headers['content-encoding'] === 'aes128gcm' && /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/.test(p.headers.authorization ?? '') && Number(p.headers.ttl) > 0 && p.headers.topic === 'waiting', JSON.stringify(p.headers));
    check('…to this browser\'s subscription', p.url === new URL(FAKE.endpoint).pathname);
    try { payloadText = decryptPayload(p.body, ua.getPrivateKey(), AUTH).toString('utf8'); } catch (e) { payloadText = `(could not decrypt: ${e.message})`; }
    check('…which decrypts to exactly {kind:"waiting", id, tag} — no title', payloadText === JSON.stringify({ kind: 'waiting', id: j.job.id, tag: 'mwa-waiting' }), payloadText);
    check('…and the raw body does not hold the job\'s title', !p.body.includes(Buffer.from('PLANTED')));
  }
  await sleep(2500);
  check('one notification for the job, not one per tick', pushes.length === before + 1, `pushes: ${pushes.length - before}`);

  // ---------- 3. the worker shows it, and a tap opens the job ----------
  const cdp = await ctx.newCDPSession(page);
  let regId = null;
  cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => { for (const r of e.registrations) if (!r.isDeleted && r.scopeURL.startsWith(BASE)) regId = r.registrationId; });
  await cdp.send('ServiceWorker.enable');
  for (let i = 0; i < 25 && !regId; i++) await sleep(200);
  check('found the worker\'s registration', !!regId);
  // back to Today first, so the tap visibly moves the page
  await page.goto(`${BASE}/?ui=v2`);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10_000 }).catch(() => {});
  await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 10_000 }).catch(() => {});
  if (regId && payloadText) {
    await cdp.send('ServiceWorker.deliverPushMessage', { origin: `${BASE}/`, registrationId: String(regId), data: payloadText });
    const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker', { timeout: 5000 }).catch(() => null);
    let shown = [];
    for (let i = 0; i < 25 && !shown.length && sw; i++) { shown = await sw.evaluate(async () => (await self.registration.getNotifications()).map((n) => ({ title: n.title, body: n.body, tag: n.tag, data: n.data }))); if (!shown.length) await sleep(200); }
    check('the worker shows "A job is waiting for you" (tag mwa-waiting), no title', shown.length === 1 && shown[0].body === 'A job is waiting for you' && shown[0].tag === 'mwa-waiting' && !JSON.stringify(shown).includes('PLANTED'), JSON.stringify(shown));
    check('…pointing at the job (v2 for this visit only: from=notification)', shown[0]?.data?.url === `${BASE}/?ui=v2&from=notification#/job/${j.job.id}`, JSON.stringify(shown[0]?.data));
    if (sw && shown.length) {
      await sw.evaluate(async () => {
        const [n] = await self.registration.getNotifications();
        self.dispatchEvent(new NotificationEvent('notificationclick', { notification: n }));
      });
      const card = page.locator(`#jt-${j.job.id}`);
      check('a tap opens the working sheet at that job in the open page', await card.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false));
      await page.screenshot({ path: join(OUT, '3-tap-opens-job.png') });
    }
  }

  // ---------- 3b. a tap with only the classic app open: v2 for that tap, the person's choice of v1 kept ----------
  if (regId && payloadText) {
    await page.close();
    page = await ctx.newPage();
    await page.goto(`${BASE}/?ui=v1`); // the person chose the classic app (Settings remembers it as mwa-ui=v1)
    await page.evaluate(() => localStorage.setItem('mwa-ui', 'v1'));
    for (let i = 0; i < 50 && !(await page.evaluate(() => !!navigator.serviceWorker.controller).catch(() => false)); i++) await sleep(200);
    const cdp2 = await ctx.newCDPSession(page);
    await cdp2.send('ServiceWorker.enable');
    await cdp2.send('ServiceWorker.deliverPushMessage', { origin: `${BASE}/`, registrationId: String(regId), data: payloadText });
    const sw = ctx.serviceWorkers()[0];
    let n = 0;
    for (let i = 0; i < 25 && !n && sw; i++) { n = await sw.evaluate(async () => (await self.registration.getNotifications()).length); if (!n) await sleep(200); }
    await sw?.evaluate(async () => { const [x] = await self.registration.getNotifications(); self.dispatchEvent(new NotificationEvent('notificationclick', { notification: x })); });
    await page.waitForURL(/from=notification/, { timeout: 10_000 }).catch(() => {});
    const card = page.locator(`#jt-${j.job.id}`);
    const opened = await card.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false);
    const kept = await page.evaluate(() => localStorage.getItem('mwa-ui'));
    check('a tap with only a classic (v1) tab: that tab opens the job in v2, and the person\'s choice of v1 is kept', opened && kept === 'v1', `opened=${opened} mwa-ui=${kept} url=${page.url()}`);
  }

  // ---------- 4. Send a test ----------
  await page.goto(`${BASE}/?ui=v2&view=settings`);
  await page.locator('#notify-state[data-state="on"]').waitFor({ timeout: 15_000 }).catch(() => {});
  const beforeTest = pushes.length;
  await page.getByRole('button', { name: 'Send a test' }).click();
  const note = page.locator('#notify-card .setnote');
  await note.waitFor({ timeout: 10_000 }).catch(() => {});
  const said = (await note.textContent().catch(() => '')) ?? '';
  check('"Send a test" reaches the push service, and says which one took it (not "delivered")', pushes.length === beforeTest + 1 && /test push service/.test(said) && !/delivered/i.test(said), `${pushes.length - beforeTest} · ${said}`);
  const t = pushes[beforeTest];
  if (t) check('…the test payload is {kind:"test"} only', decryptPayload(t.body, ua.getPrivateKey(), AUTH).toString('utf8') === JSON.stringify({ kind: 'test', id: null, tag: 'mwa-test' }));

  // ---------- 5. Turn off ----------
  await page.getByRole('button', { name: 'Turn off' }).click();
  await page.waitForFunction(() => document.querySelector('#notify-state')?.getAttribute('data-state') === 'off', null, { timeout: 10_000 }).catch(() => {});
  const after = await (await fetch(`${BASE}/api/v1/push/subscriptions`, { headers: H })).json();
  check('Turn off: the server forgets this device', after.subscriptions.length === 0 && (await page.locator('#notify-state').getAttribute('data-state')) === 'off');
  await page.screenshot({ path: join(OUT, '5-notifications-off.png'), fullPage: true });
  await axe(page, 'Settings › Notifications (off)', '#sec-notify');

  // ---------- 6. a paired phone sees the shared settings read-only (fixture world: a phone, no admin) ----------
  const phone = await ctx.newPage();
  await phone.goto(`${BASE}/?fixtures=1&scenario=phone&view=settings`);
  const ro = await phone.locator('#notify-readonly').waitFor({ timeout: 15_000 }).then(() => true, () => false);
  const disabled = ro && await phone.getByRole('checkbox', { name: 'Something needs your OK' }).isDisabled();
  const quietRo = ro && await phone.locator('#notify-quiet-ro').isVisible();
  check('a paired phone: kinds, morning time and quiet hours read-only, with a plain line why', ro && disabled && quietRo, `ro=${ro} disabled=${disabled} quiet=${quietRo}`);
  await phone.screenshot({ path: join(OUT, '6-phone-read-only.png'), fullPage: true });
  await axe(phone, 'Settings › Notifications (phone, read-only)', '#sec-notify');
} catch (e) {
  check('the run finished without an error', false, e.stack ?? e.message);
} finally {
  await browser.close();
  stop();
  mock.close();
}
writeFileSync(join(OUT, 'results.json'), JSON.stringify({ at: new Date().toISOString(), failed, results }, null, 2));
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
