#!/usr/bin/env node
/**
 * v2 build, slice S1: a Playwright run of Settings › Plug-ins against the BUILT UI in fixture mode, at 360×740,
 * 390×844 and 1440×900 (same pattern as scripts/v2-w5-smoke.mjs).
 *
 *   npm run build:ui
 *   node scripts/v2-s1-smoke.mjs [--out <dir>] [--axe <path to axe.min.js>] [--port 4198]
 *
 * On the computer: Settings → Plug-ins (its own screen) with On / Available / Your own / Add from npm; GitHub's switch
 * asks for its key first, the key goes in a password field, Save and turn on moves it to On and the typed key is
 * nowhere on the page afterwards; Read web pages turned off; a hand-added plug-in removed after a confirm; Add from npm
 * shows the safety review before Install, a dangerous one needs "I trust where this came from"; Back to Settings. A
 * paired phone: the same list read-only with the note. npm-off: the reason. Dark mode. axe 0 violations, no horizontal
 * overflow, no page errors.
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('out', join(ROOT, 'reports', 'v2-s1-smoke'));
const AXE = arg('axe', process.env.AXE_PATH ?? '');
const PORT = Number(arg('port', '4198'));
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
  cwd: join(ROOT, 'web'), env: { ...process.env, MWA_FIXTURES: '1', MWA_NO_OPEN: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
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
const VIEWPORTS = [
  { name: 'm360', width: 360, height: 740, mobile: true },
  { name: 'm390', width: 390, height: 844, mobile: true },
  { name: 'd1440', width: 1440, height: 900, mobile: false },
];
async function open(vp, url, scenario) {
  await reset(scenario);
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.mobile ? 2 : 1, hasTouch: vp.mobile, isMobile: vp.mobile });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}${url}`);
  return { ctx, page, errors };
}
const group = (main, title) => main.locator(`section:has(> h2.sh:text-is("${title}"))`);
const row = (sec, name) => sec.getByRole('group', { name, exact: true });

const SECRET = 'ghp_smokeTYPEDsecret123';
try {
  for (const vp of VIEWPORTS) {
    const L = vp.name;

    // 1. on the computer: Settings → Plug-ins, and every change
    {
      const { ctx, page, errors } = await open(vp, '/?ui=v2&view=settings', 'N00');
      const main = page.locator('#main');
      check(`${L}: Settings`, await visible(main.getByRole('heading', { name: 'Settings', level: 1 })));
      check(`${L}: Settings has a Plug-ins section`, await visible(main.getByRole('heading', { name: 'Plug-ins', level: 2 })));
      await main.locator('#open-plugins').click();
      check(`${L}: Plug-ins opens as its own screen`, await visible(main.getByRole('heading', { name: 'Plug-ins', level: 1 })));
      for (const t of ['On', 'Available', 'Your own', 'Add from npm']) check(`${L}: group "${t}"`, await visible(main.getByRole('heading', { name: t, level: 2, exact: true })));
      const on = group(main, 'On'), avail = group(main, 'Available'), own = group(main, 'Your own');
      check(`${L}: web search is on and says what it can touch`, await visible(row(on, 'Web search').getByText('Sends search queries to the web. No account, no files.')));
      check(`${L}: GitHub is available and says it needs a key`, await visible(row(avail, 'GitHub').getByText('Needs your GitHub personal access token before it can turn on.')));
      check(`${L}: Notion shows its key as saved, not the key`, await visible(row(avail, 'Notion').getByText('Notion integration token saved.')));
      await shot(page, `${L}-01-plugins`, true);
      await axe(page, `${L} plug-ins`);
      await noOverflow(page, `${L} plug-ins`);

      // GitHub: the switch asks for the key first
      await row(avail, 'GitHub').getByRole('switch').click();
      const keyField = main.getByLabel('GitHub personal access token');
      check(`${L}: the switch opens the key form first`, await visible(keyField));
      check(`${L}: the key field is a password field`, (await keyField.getAttribute('type')) === 'password');
      await axe(page, `${L} key form`);
      await noOverflow(page, `${L} key form`);
      await shot(page, `${L}-02-key-form`);
      await keyField.fill(SECRET);
      await main.getByRole('button', { name: 'Save and turn on' }).click();
      check(`${L}: GitHub moves to On`, await visible(row(on, 'GitHub').getByRole('switch', { checked: true })));
      check(`${L}: a notice says it is on, from the next message`, await visible(page.locator('#toasts').getByText('GitHub is on. Changes take effect on your next message.')));
      check(`${L}: GitHub's key now shows as saved`, await visible(row(on, 'GitHub').getByText('GitHub personal access token saved.')));
      const html = await page.content();
      check(`${L}: the typed key is nowhere on the page`, !html.includes(SECRET));
      check(`${L}: the key went over as PUT and never came back`, !(await (await fetch(`${BASE}/api/v1/plugins`)).text()).includes(SECRET));

      // Read web pages: off
      await row(on, 'Read web pages').getByRole('switch').click();
      check(`${L}: Read web pages moves to Available, off`, await visible(row(avail, 'Read web pages').getByRole('switch', { checked: false })));

      // your own: remove after a confirm
      await row(own, 'barn-notes').getByRole('button', { name: 'Remove barn-notes' }).click();
      check(`${L}: Remove asks first`, await visible(own.getByText('Remove barn-notes? Your helper stops using it from your next message.')));
      check(`${L}: an env value is never shown, only its name`, await visible(own.getByText('Has its own settings: BARN_NOTES_TOKEN (not shown).')));
      await own.getByRole('button', { name: 'Remove', exact: true }).click();
      check(`${L}: barn-notes is gone`, await gone(row(own, 'barn-notes')));

      // add from npm: the review first, then Install
      const npm = group(main, 'Add from npm');
      await npm.getByLabel('npm package').fill('weather-mcp');
      await npm.getByRole('button', { name: 'Review' }).click();
      const review = npm.getByRole('region', { name: 'Safety review of weather-mcp' });
      check(`${L}: the safety review shows before anything is installed`, await visible(review.getByText('Looks safe')));
      check(`${L}: the review says what it could do`, await visible(review.getByText('looks up weather forecasts')));
      await shot(page, `${L}-03-review-safe`);
      await axe(page, `${L} review safe`);
      await noOverflow(page, `${L} review safe`);
      await review.getByRole('button', { name: 'Install weather-mcp' }).click();
      check(`${L}: installed, from the next message`, await visible(npm.getByText('Installed weather-mcp@1.0.0. Its tools are available on your next message.')));
      check(`${L}: it is under Your own`, await visible(row(own, 'weather-mcp')));

      await npm.getByLabel('npm package').fill('shady-mcp');
      await npm.getByRole('button', { name: 'Review' }).click();
      const bad = npm.getByRole('region', { name: 'Safety review of shady-mcp' });
      check(`${L}: a dangerous package says so, with its warnings`, await visible(bad.getByText('Dangerous')) && await visible(bad.getByText('reads every saved key')));
      const anyway = bad.getByRole('button', { name: 'Install anyway' });
      check(`${L}: Install anyway waits for "I trust where this came from"`, await anyway.isDisabled());
      await bad.getByLabel(/I trust where this came from/).check();
      check(`${L}: …then it can be pressed`, await anyway.isEnabled());
      await shot(page, `${L}-04-review-dangerous`);
      await axe(page, `${L} review dangerous`);
      await bad.getByRole('button', { name: 'Don’t install' }).click();
      check(`${L}: Don’t install closes the review`, await gone(bad));

      await main.getByRole('button', { name: 'Settings' }).first().click();
      check(`${L}: Back goes to Settings`, await visible(main.getByRole('heading', { name: 'Settings', level: 1 })));
      check(`${L}: computer: no page errors`, !errors.length, errors.join(' | '));
      await ctx.close();
    }

    // 2. a paired phone: read-only
    {
      const { ctx, page, errors } = await open(vp, '/?ui=v2&view=plugins', 'phone');
      const main = page.locator('#main');
      check(`${L}: phone: Plug-ins`, await visible(main.getByRole('heading', { name: 'Plug-ins', level: 1 })));
      check(`${L}: phone: says where to change them`, await visible(main.getByRole('note').getByText(/can see your plug-ins but not change them/)));
      check(`${L}: phone: no switches, keys or Remove`, !(await main.getByRole('switch').count()) && !(await main.getByRole('button', { name: /^(Add key|Change key|Remove)/ }).count()) && !(await main.locator('input').count()));
      check(`${L}: phone: what each can touch is still there`, await visible(main.getByText('Your GitHub, scoped to the personal access token you provide.')));
      await shot(page, `${L}-05-phone`, true);
      await axe(page, `${L} phone plug-ins`);
      await noOverflow(page, `${L} phone plug-ins`);
      check(`${L}: phone: no page errors`, !errors.length, errors.join(' | '));
      await ctx.close();
    }

    // 3. adding from npm is off: the reason
    {
      const { ctx, page, errors } = await open(vp, '/?ui=v2&view=plugins', 'npm-off');
      const main = page.locator('#main');
      check(`${L}: npm off: the reason is shown`, await visible(main.locator('#npm-off').getByText('Installing connectors from outside the library is turned off')));
      check(`${L}: npm off: no package field`, !(await main.getByLabel('npm package').count()));
      await axe(page, `${L} npm off`);
      check(`${L}: npm off: no page errors`, !errors.length, errors.join(' | '));
      await ctx.close();
    }

    // 4. dark mode
    {
      const { ctx, page, errors } = await open(vp, '/?ui=v2&view=plugins&theme=dark', 'N00');
      const main = page.locator('#main');
      await visible(main.getByRole('heading', { name: 'Plug-ins', level: 1 }));
      await shot(page, `${L}-06-dark`, true);
      await axe(page, `${L} plug-ins dark`);
      check(`${L}: dark: no page errors`, !errors.length, errors.join(' | '));
      await ctx.close();
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
