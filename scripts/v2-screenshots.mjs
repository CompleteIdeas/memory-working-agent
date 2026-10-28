#!/usr/bin/env node
/**
 * Documentation screenshots of the new app (docs/images/), taken against the BUILT UI in fixture mode — the same
 * approach as the v2 smokes (scripts/v2-s1-smoke.mjs … v2-s6-smoke.mjs): `vite preview` with MWA_FIXTURES=1 answers
 * /api/v1 from the invented example day (web/src/v2/dev/), so no data dir, no API key and no real account is used.
 *
 *   npm run build:ui
 *   node scripts/v2-screenshots.mjs [--out docs/images] [--port 4210]
 *
 * Every /api/v1 answer is passed through `scrub()` on its way to the page so the pictures carry only invented names
 * (Alex, example.com). Phone = 390×844, desktop = 1440×900, device scale 1 so each PNG stays small.
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('out', join(ROOT, 'docs', 'images'));
const PORT = Number(arg('port', '4210'));
const BASE = `http://localhost:${PORT}`;
mkdirSync(OUT, { recursive: true });
if (!existsSync(join(ROOT, 'dist-ui', 'index.html'))) { console.error('Build the UI first: npm run build:ui'); process.exit(2); }

// ---------- the server (fixture mode; never a real account) ----------
const env = { ...process.env, MWA_FIXTURES: '1', MWA_NO_OPEN: '1' };
for (const k of Object.keys(env)) if (/API_KEY|TOKEN|SECRET|PASSWORD/i.test(k)) delete env[k];
const vite = spawn(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(PORT), '--strictPort'], {
  cwd: join(ROOT, 'web'), env, stdio: ['ignore', 'pipe', 'pipe'],
});
let viteLog = '';
vite.stdout.on('data', (d) => { viteLog += d; });
vite.stderr.on('data', (d) => { viteLog += d; });
const stopVite = () => { try { vite.kill(); } catch { /* gone */ } };
process.on('exit', stopVite);
for (let i = 0; ; i++) {
  try { const r = await fetch(`${BASE}/api/v1/meta`); if (r.ok) break; } catch { /* not yet */ }
  if (i > 100) { console.error('vite preview did not start:\n' + viteLog); process.exit(2); }
  await new Promise((r) => setTimeout(r, 200));
}
const reset = (scenario) => fetch(`${BASE}/__fixtures/reset?scenario=${scenario}`, { method: 'POST' });

// ---------- invented names only ----------
const scrub = (s) => s
  .replace(/dana\.lee\.news@gmail\.com/g, 'dana.lee@example.com')
  .replace(/resolve-team@protonmail\.com/g, 'resolve-team@mail.example')
  .replace(/robert@gmail\.com/g, 'alex@example.com')
  // a fictional brand for the phishing example (no real company's name in the pictures)
  .replace(/paypa1-security/g, 'paywi5e-security')
  .replace(/PayPal/g, 'Paywise')
  .replace(/Robert/g, 'Alex')
  .replace(/robert/g, 'alex');

const browser = await chromium.launch();
const VPS = { phone: { width: 390, height: 844, mobile: true }, desktop: { width: 1440, height: 900, mobile: false } };

async function open(vpName, url, scenario = 'N00') {
  const vp = VPS[vpName];
  await reset(scenario);
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1, hasTouch: vp.mobile, isMobile: vp.mobile, colorScheme: 'light' });
  await ctx.route('**/api/v1/**', async (route) => {
    if (route.request().url().includes('/stream')) return route.continue();
    const res = await route.fetch();
    const type = res.headers()['content-type'] ?? '';
    if (!type.includes('json') && !type.includes('text')) return route.fulfill({ response: res });
    return route.fulfill({ response: res, body: scrub(await res.text()) });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}${url}`);
  return { ctx, page, errors, vp };
}
const visible = (loc, ms = 10_000) => loc.first().waitFor({ state: 'visible', timeout: ms }).then(() => true, () => false);
const made = [];
async function shot(page, name) {
  await page.waitForTimeout(600);
  // no focus ring in the pictures (a dialog focuses its close button when it opens)
  await page.evaluate(() => { const a = document.activeElement; if (a && a !== document.body && typeof a.blur === 'function') a.blur(); });
  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  const kb = Math.round(statSync(file).size / 1024);
  made.push(`${name}.png ${kb} KB`);
  console.log(`saved ${name}.png (${kb} KB)`);
}
async function tab(page, vp, name) { await page.locator(vp.mobile ? '#tabbar' : '#topbar').getByRole('button', { name, exact: true }).click(); }

let failed = 0;
async function take(name, fn) {
  for (const vpName of ['phone', 'desktop']) {
    try { await fn(vpName, `${vpName}-${name}`); }
    catch (e) { failed++; console.error(`FAIL ${vpName}-${name}: ${String(e).split('\n')[0]}`); }
  }
}

try {
  // Today: check-in, Needs you, Next up, Done for you
  await take('today', async (v, n) => {
    const { ctx, page } = await open(v, '/?ui=v2');
    await visible(page.getByRole('heading', { name: /Good (morning|afternoon|evening)/ }));
    await shot(page, n); await ctx.close();
  });
  // a project's conversation
  await take('conversation', async (v, n) => {
    const { ctx, page, vp } = await open(v, '/?ui=v2');
    await visible(page.locator(vp.mobile ? '#tabbar' : '#topbar'));
    await tab(page, vp, 'Projects');
    await page.getByRole('button', { name: /^Family & school/ }).click();
    await visible(page.locator('#main').getByText('using what I know from Eventing'));
    await shot(page, n); await ctx.close();
  });
  // an approval, opened from Today's Needs you
  await take('approvals', async (v, n) => {
    const { ctx, page } = await open(v, '/?ui=v2#/approval/ap_report', 'approvals');
    const ap = page.locator('#approval-dlg');
    await visible(ap.getByRole('button', { name: 'Approve', exact: true }));
    await shot(page, n); await ctx.close();
  });
  // Important ("Worth a look")
  await take('important', async (v, n) => {
    const { ctx, page } = await open(v, '/?ui=v2&view=inbox');
    await visible(page.locator('#main h1'));
    await page.waitForTimeout(800);
    await shot(page, n); await ctx.close();
  });
  // Settings and its pages
  for (const [name, view] of [['settings', 'settings'], ['plugins', 'plugins'], ['connections', 'connections'], ['memory', 'memory']]) {
    await take(name, async (v, n) => {
      const { ctx, page } = await open(v, `/?ui=v2&view=${view}`);
      await visible(page.locator('#main h1'));
      await page.waitForTimeout(800);
      await shot(page, n); await ctx.close();
    });
  }
  // first run on a new computer: pick a brain
  await take('setup', async (v, n) => {
    const { ctx, page } = await open(v, '/?ui=v2', 'fresh');
    await page.getByRole('button', { name: 'Get started' }).click();
    await visible(page.getByRole('heading', { name: 'Pick a brain to think with', level: 1 }));
    await shot(page, n); await ctx.close();
  });
} finally {
  await browser.close();
  stopVite();
}
console.log(`\n${made.length} screenshots in ${OUT}${failed ? `, ${failed} failed` : ''}`);
process.exit(failed ? 1 : 0);
