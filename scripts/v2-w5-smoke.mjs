#!/usr/bin/env node
/**
 * v2 build, slice W5: a Playwright run of sign-in, pairing, first run and Settings against the BUILT UI in fixture
 * mode, at 390×844 and 1440×900 (same pattern as scripts/v2-web-smoke.mjs).
 *
 *   npm run build:ui
 *   node scripts/v2-w5-smoke.mjs [--out <dir>] [--axe <path to axe.min.js>] [--port 4199]
 *
 * Through the Vite fixture middleware (the real client, EventSource and IndexedDB): signed out with a password →
 * "Sign in to your helper", a wrong password refused in plain words, the right one opens the app; a phone with no
 * password → "Pair this device first" → a wrong code refused → the right code pairs it; the pairing link
 * (/pair#c=CODE) fills the code in and clears it from the address bar; first run on the computer (names, Connect
 * Google, turn on what's off, the pairing code and its QR, Finish); Settings (every section; Connect Outlook shows its
 * code; the monthly limit saved; a device renamed and removed; Pair a new device shows a QR; a rule removed); a
 * paired phone's Settings (admin parts read-only, Sign out this phone); dark mode. axe 0 violations, no horizontal
 * overflow, no page errors.
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('out', join(ROOT, 'reports', 'v2-w5-smoke'));
const AXE = arg('axe', process.env.AXE_PATH ?? '');
const PORT = Number(arg('port', '4199'));
const BASE = `http://localhost:${PORT}`;
mkdirSync(OUT, { recursive: true });
if (!existsSync(join(ROOT, 'dist-ui', 'index.html'))) { console.error('Build the UI first: npm run build:ui'); process.exit(2); }
const axeSrc = AXE && existsSync(AXE) ? readFileSync(AXE, 'utf8') : null;
if (!axeSrc) console.warn('! no axe-core given (--axe): accessibility checks are skipped');

const results = [];
let failed = 0;
function check(name, ok, detail = '') { results.push({ name, ok: !!ok, detail }); if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`); }

// ---------- the server ----------
const vite = spawn(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(PORT), '--strictPort'], {
  cwd: join(ROOT, 'web'), env: { ...process.env, MWA_FIXTURES: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
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

// ---------- helpers ----------
async function axe(page, label) {
  if (!axeSrc) return;
  await page.addScriptTag({ content: axeSrc }).catch(() => {});
  const v = await page.evaluate(async () => {
    const r = await window.axe.run(document, { resultTypes: ['violations'] });
    return r.violations.map((x) => `${x.id} (${x.impact}): ${x.nodes.length} × ${x.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' | ')}`);
  });
  check(`${label}: axe 0 violations`, v.length === 0, v.join('; '));
}
async function noOverflow(page, label) {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
  check(`${label}: no horizontal overflow`, o.sw <= o.w, `${o.sw} > ${o.w}`);
}
const shot = async (page, name, full = false) => { await page.waitForTimeout(350); await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: full }); };
const visible = (loc, ms = 8_000) => loc.first().waitFor({ state: 'visible', timeout: ms }).then(() => true, () => false);
const gone = (loc, ms = 6_000) => loc.first().waitFor({ state: 'detached', timeout: ms }).then(() => true, () => false);

const browser = await chromium.launch();
const VIEWPORTS = [{ name: 'm390', width: 390, height: 844, mobile: true }, { name: 'd1440', width: 1440, height: 900, mobile: false }];
async function open(vp, url, scenario) {
  await reset(scenario);
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.mobile ? 2 : 1, hasTouch: vp.mobile, isMobile: vp.mobile });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}${url}`);
  return { ctx, page, errors };
}
const appOpen = (page, vp) => visible(page.locator(vp.mobile ? '#tabbar' : '#topbar').getByRole('button', { name: 'Today', exact: true }), 10_000);

try {
  for (const vp of VIEWPORTS) {
    const L = vp.name;

    // 1. signed out, a password set: sign in
    {
      const { ctx, page, errors } = await open(vp, '/?ui=v2', 'signed-out');
      check(`${L}: signed out → "Sign in to your helper"`, await visible(page.getByRole('heading', { name: 'Sign in to your helper', level: 1 })));
      check(`${L}: no tabs while signed out`, !(await page.locator('#tabbar, #topbar').count()));
      await shot(page, `${L}-01-signin`);
      await axe(page, `${L} sign in`);
      await noOverflow(page, `${L} sign in`);
      await page.getByLabel('Password').fill('nope');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      check(`${L}: a wrong password is refused in plain words`, await visible(page.getByRole('alert').filter({ hasText: 'That password isn’t right. Try again.' })));
      await axe(page, `${L} sign in refused`);
      await page.getByLabel('Password').fill('example');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      check(`${L}: the right password opens the app`, await appOpen(page, vp));
      check(`${L}: sign in: no page errors`, !errors.length, errors.join(' | '));
      await ctx.close();
    }

    // 2. a phone with no password: pair with a code
    {
      const { ctx, page, errors } = await open(vp, '/?ui=v2', 'unpaired');
      check(`${L}: not paired → "Pair this device first"`, await visible(page.getByRole('heading', { name: 'Pair this device first', level: 1 })));
      await axe(page, `${L} not paired`);
      await page.getByRole('button', { name: 'Type a code' }).click();
      check(`${L}: "Pair this phone with MWA?"`, await visible(page.getByRole('heading', { name: 'Pair this phone with MWA?', level: 1 })));
      check(`${L}: what the phone may do, in plain words`, await visible(page.getByText('It can’t change connections or keys.', { exact: false })));
      await page.getByLabel('Code from your computer').fill('ABCD-EFGH');
      await page.getByLabel('Name for this phone').fill('Robert’s Pixel');
      await page.getByRole('button', { name: 'Pair', exact: true }).click();
      check(`${L}: a wrong code is refused in the server's words`, await visible(page.getByRole('alert').filter({ hasText: 'That code is wrong, used or expired.' })));
      await page.getByLabel('Code from your computer').fill('abc');
      await page.getByRole('button', { name: 'Pair', exact: true }).click();
      check(`${L}: a code that can't be one is explained`, await visible(page.getByRole('alert').filter({ hasText: 'The code has 8 letters and numbers' })));
      await shot(page, `${L}-02-pair-refused`);
      await axe(page, `${L} pair (refused)`);
      await noOverflow(page, `${L} pair`);
      await page.getByLabel('Code from your computer').fill('k7pq m4xz');
      await page.getByRole('button', { name: 'Pair', exact: true }).click();
      check(`${L}: the right code pairs the phone`, await visible(page.getByRole('heading', { name: 'This phone is paired', level: 1 })));
      await shot(page, `${L}-03-paired`);
      await page.getByRole('button', { name: 'Open MWA' }).click();
      check(`${L}: and the app opens`, await appOpen(page, vp));
      check(`${L}: pair: no page errors`, !errors.length, errors.join(' | '));
      await ctx.close();
    }

    // 3. the pairing link from the QR: the code is filled in, then cleared from the address bar
    {
      const { ctx, page, errors } = await open(vp, '/pair#c=K7PQ-M4XZ', 'unpaired');
      check(`${L}: /pair opens the v2 pairing page`, await visible(page.getByRole('heading', { name: 'Pair this phone with MWA?', level: 1 })));
      check(`${L}: the link's code is filled in`, (await page.getByLabel('Code from your computer').inputValue()) === 'K7PQ-M4XZ');
      check(`${L}: and taken out of the address bar`, !page.url().includes('#c='), page.url());
      await shot(page, `${L}-04-pair-link`);
      await page.getByRole('button', { name: 'Pair', exact: true }).click();
      check(`${L}: pairs from the link`, await visible(page.getByRole('heading', { name: 'This phone is paired', level: 1 })));
      await page.getByRole('button', { name: 'Open MWA' }).click();
      check(`${L}: the app opens after the link`, await appOpen(page, vp));
      check(`${L}: the pairing page is left behind`, !new URL(page.url()).pathname.startsWith('/pair'), page.url());
      check(`${L}: pair link: no page errors`, !errors.length, errors.join(' | '));
      await ctx.close();
    }

    // 4. first run on the computer
    {
      const { ctx, page, errors } = await open(vp, '/?ui=v2', 'first-run');
      check(`${L}: first run → "Hi, I’m your helper."`, await visible(page.getByRole('heading', { name: 'Hi, I’m your helper.', level: 1 })));
      await shot(page, `${L}-05-first-run-welcome`);
      await axe(page, `${L} first run welcome`);
      await page.getByRole('button', { name: 'Get started' }).click();
      check(`${L}: names step`, await visible(page.getByRole('heading', { name: 'Let’s get to know each other' })));
      await page.getByLabel('What should I call myself?').fill('Juniper');
      await page.getByLabel('What should I call you?').fill('Robert');
      await axe(page, `${L} first run names`);
      await page.getByRole('button', { name: 'Next' }).click();
      check(`${L}: connect step`, await visible(page.getByRole('heading', { name: 'Connect your calendar and email' })));
      check(`${L}: "Skip for now" while nothing is connected`, await page.getByRole('button', { name: 'Skip for now' }).isVisible());
      await page.getByRole('button', { name: /^Google/ }).click();
      check(`${L}: Google shows as connected`, await visible(page.getByRole('button', { name: /^Google.*Connected/ })));
      await shot(page, `${L}-06-first-run-connect`);
      await axe(page, `${L} first run connect`);
      await page.getByRole('button', { name: 'Next' }).click();
      check(`${L}: what's off: "A few things are off"`, await visible(page.getByRole('heading', { name: 'A few things are off' })));
      await page.getByRole('button', { name: 'Turn it on' }).click();
      check(`${L}: sorting turned on`, await gone(page.getByRole('button', { name: 'Turn it on' })));
      await axe(page, `${L} first run switches`);
      await page.getByRole('button', { name: 'Next' }).click();
      check(`${L}: the phone step with a QR code`, await visible(page.getByRole('img', { name: /Pairing code [A-Z2-9]{4}-[A-Z2-9]{4}, as a QR code/ })));
      check(`${L}: and the code as text`, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test((await page.locator('.paircode').first().textContent()) ?? ''));
      const qr = await page.locator('svg.qr').evaluate((s) => ({ w: s.getBoundingClientRect().width, path: s.querySelector('path')?.getAttribute('d')?.length ?? 0 }));
      check(`${L}: the QR is drawn (at least 150 px, real modules)`, qr.w >= 150 && qr.path > 500, JSON.stringify(qr));
      // W5 security review (8): a fresh computer doesn't know its address yet: the phone can't open "localhost"
      check(`${L}: no address known → "Your phone can’t reach ‘localhost’"`, await visible(page.getByText('Your phone can’t reach “localhost”.', { exact: false })));
      await page.getByLabel('Your helper’s address').fill('mwa.tail1a2b.ts.net');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      check(`${L}: with the address saved, a new code without the warning`, await gone(page.getByText('Your phone can’t reach “localhost”.', { exact: false })));
      await shot(page, `${L}-07-first-run-qr`, true);
      await axe(page, `${L} first run QR`);
      await noOverflow(page, `${L} first run QR`);
      await page.getByRole('button', { name: 'Finish' }).click();
      check(`${L}: Finish opens the app`, await appOpen(page, vp));
      check(`${L}: first run: no page errors`, !errors.length, errors.join(' | '));
      await ctx.close();
    }

    // 5. Settings on the computer (signed in with the password)
    {
      const { ctx, page, errors } = await open(vp, '/?ui=v2', 'N00');
      await appOpen(page, vp);
      await page.getByRole('button', { name: 'Settings' }).first().click();
      const main = page.locator('#main');
      check(`${L}: Settings opens from the avatar`, await visible(main.getByRole('heading', { name: 'Settings', level: 1 })));
      const want = ['Connected', 'This month', 'Devices', 'Your rules', 'Your helper', 'What I keep up to date', 'Saved logins', 'Notifications', 'Look', 'About'];
      const have = await main.getByRole('heading', { level: 2 }).allTextContents();
      check(`${L}: every section`, want.every((w) => have.includes(w)), JSON.stringify(have));
      check(`${L}: Google connected, Outlook offers "Connect Outlook"`, await visible(main.getByText('· connected')) && await main.getByRole('button', { name: 'Connect Outlook' }).isVisible());
      check(`${L}: spending "$1.29 of your $20 limit" and the background line`, await visible(main.getByText('$1.29 of your $20 limit')) && await main.getByText(/In the background: sorting your mail 31¢/).isVisible());
      check(`${L}: the default limits per kind`, await main.getByText('Set from its estimate, at most $5.', { exact: false }).isVisible() && await main.getByText('25¢ a run, unless the job has its own limit.').isVisible());
      check(`${L}: Sign out everywhere offered to the password session`, await main.getByRole('button', { name: 'Sign out everywhere' }).isVisible());
      check(`${L}: the helper's address for phones`, (await main.getByLabel('Your helper’s address for phones').inputValue()) === 'https://mwa.tail1a2b.ts.net');
      // P3 replaced W5's "Coming soon" card: this device's state, the kinds, and the privacy note (scripts/v2-p3-push-smoke.mjs drives it)
      check(`${L}: Notifications: this device's state, the kinds and the privacy note, in plain words`, await visible(main.locator('#notify-state')) && await main.getByRole('checkbox', { name: 'Something needs your OK' }).isVisible() && await main.getByText(/never contain your messages or titles/).isVisible());
      check(`${L}: About: the version, the minimum app version and the classic app`, await main.getByText(/Version fixtures\. Works with this app from version 1\.0\.0\./).isVisible() && await main.getByRole('button', { name: 'Use the classic app' }).isVisible());
      await shot(page, `${L}-08-settings-top`);
      await shot(page, `${L}-09-settings-full`, true);
      await axe(page, `${L} settings`);
      await noOverflow(page, `${L} settings`);

      await main.getByRole('button', { name: 'Connect Outlook' }).click();
      check(`${L}: Connect Outlook shows the code to type at Microsoft`, await visible(main.getByText('QWER-TY12')));
      await axe(page, `${L} settings connect`);

      await main.getByLabel('Monthly limit').fill('30');
      await main.locator('form.dollarform').first().getByRole('button', { name: 'Save' }).click();
      check(`${L}: the monthly limit is saved`, await visible(main.getByText('$1.29 of your $30 limit')));

      const ipad = main.getByRole('group', { name: 'Kitchen iPad' });
      check(`${L}: the devices, with when each was last used`, await visible(ipad) && /Used 2 days ago/.test((await ipad.textContent()) ?? ''));
      check(`${L}: a removed device is not listed`, !(await main.getByRole('group', { name: 'Old phone' }).count()));
      await main.getByRole('button', { name: 'Rename Robert’s Pixel' }).click();
      await main.getByLabel('New name for Robert’s Pixel').fill('Pixel 9');
      await main.locator('form.setrow').getByRole('button', { name: 'Save' }).click();
      check(`${L}: a device renamed`, await visible(main.getByRole('group', { name: 'Pixel 9' })));
      await main.getByRole('button', { name: 'Remove Kitchen iPad' }).click();
      check(`${L}: Remove asks first, in plain words`, await visible(main.getByText('Remove Kitchen iPad? It stops working at once.', { exact: false })));
      await shot(page, `${L}-10-settings-remove-device`);
      await axe(page, `${L} settings remove device`);
      await ipad.getByRole('button', { name: 'Remove', exact: true }).click();
      check(`${L}: the device is removed`, await gone(main.getByRole('group', { name: 'Kitchen iPad' })) && await visible(main.getByText('Removed Kitchen iPad. It can’t reach your helper any more.')));

      await main.getByRole('button', { name: 'Pair a new device' }).click();
      check(`${L}: Pair a new device shows a QR and the code`, await visible(main.getByRole('img', { name: /as a QR code/ })));
      await main.getByRole('img', { name: /as a QR code/ }).scrollIntoViewIfNeeded();
      await shot(page, `${L}-11-settings-pair-qr`);
      await axe(page, `${L} settings pair`);
      await main.getByRole('button', { name: 'Done' }).click();

      const rule = main.getByRole('group', { name: 'Skip messages from news@medium.example' });
      check(`${L}: your rules, with their effect`, await visible(rule) && /Hides|Nothing in your recent mail/.test((await rule.textContent()) ?? ''));
      await rule.getByRole('button', { name: /^Remove the rule/ }).click();
      check(`${L}: a rule removed`, await gone(rule));
      await rule.first().waitFor({ state: 'detached', timeout: 1000 }).catch(() => {});
      check(`${L}: the rule stays removed on the server`, !((await (await fetch(`${BASE}/api/v1/triage/rules`)).json()).rules.some((r) => r.value === 'news@medium.example')));

      await main.getByRole('switch', { name: 'Sorting your mail into Important' }).click();
      check(`${L}: a switch turns sorting off`, await visible(main.getByRole('switch', { name: 'Sorting your mail into Important', checked: false })));
      await main.getByLabel('What should I call myself?').fill('Juniper Two');
      await main.locator('form.setform').getByRole('button', { name: 'Save' }).click();
      check(`${L}: the helper's name saved`, await visible(main.locator('form.setform').getByText('Saved.')));
      await axe(page, `${L} settings after changes`);
      await noOverflow(page, `${L} settings after changes`);
      check(`${L}: settings: no page errors`, !errors.length, errors.join(' | '));
      await ctx.close();
    }

    // 6. a paired phone's Settings: read-only where it needs admin; Sign out this phone
    {
      const { ctx, page, errors } = await open(vp, '/?ui=v2&view=settings', 'phone');
      const main = page.locator('#main');
      check(`${L}: phone: Settings`, await visible(main.getByRole('heading', { name: 'Settings', level: 1 })));
      check(`${L}: phone: one line says why some parts can't be changed`, await visible(main.getByRole('note')));
      check(`${L}: phone: this device marked`, await visible(main.getByText('This device')) && /Robert’s Pixel/.test((await main.locator('#sec-devices').textContent()) ?? ''));
      check(`${L}: phone: no admin controls`, !(await main.getByRole('button', { name: 'Pair a new device' }).count()) && !(await main.getByRole('button', { name: 'Connect Outlook' }).count())
        // P4: Settings › Voice is this device's own switch, not an admin one
        && (await main.getByRole('switch').count()) === (await main.locator('#sec-voice').getByRole('switch').count()) && !(await main.getByRole('heading', { name: 'Saved logins' }).count()));
      await shot(page, `${L}-12-phone-settings`);
      await axe(page, `${L} phone settings`);
      await noOverflow(page, `${L} phone settings`);
      await main.getByRole('button', { name: 'Sign out this phone' }).click();
      check(`${L}: Sign out this phone → pair again`, await visible(page.getByRole('heading', { name: /Sign in to your helper|Pair this device first/, level: 1 })));
      check(`${L}: phone: no page errors`, !errors.length, errors.join(' | '));
      await ctx.close();
    }

    // 7. dark mode
    {
      const { ctx, page, errors } = await open(vp, '/?ui=v2&view=settings&theme=dark', 'N00');
      const main = page.locator('#main');
      await visible(main.getByRole('heading', { name: 'Settings', level: 1 }));
      await main.getByRole('button', { name: 'Pair a new device' }).click();
      await visible(main.getByRole('img', { name: /as a QR code/ }));
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      check(`${L}: dark mode is dark`, bg === 'rgb(22, 24, 28)', bg);
      const qrBg = await page.locator('svg.qr rect').getAttribute('fill');
      check(`${L}: the QR stays dark on light in dark mode`, qrBg === '#ffffff');
      await shot(page, `${L}-13-settings-dark`);
      await axe(page, `${L} settings dark`);
      await ctx.close();
      const s = await open(vp, '/?ui=v2&theme=dark', 'signed-out');
      await visible(s.page.getByRole('heading', { name: 'Sign in to your helper' }));
      await shot(s.page, `${L}-14-signin-dark`);
      await axe(s.page, `${L} sign in dark`);
      check(`${L}: dark: no page errors`, !errors.length && !s.errors.length, [...errors, ...s.errors].join(' | '));
      await s.ctx.close();
    }
  }
} catch (e) {
  check('the run finished', false, String(e?.stack ?? e));
} finally {
  await browser.close();
  stopVite();
}
writeFileSync(join(OUT, 'results.json'), JSON.stringify({ failed, results }, null, 2));
console.log(`\n${results.length - failed}/${results.length} checks passed · screenshots in ${OUT}`);
process.exit(failed ? 1 : 0);
