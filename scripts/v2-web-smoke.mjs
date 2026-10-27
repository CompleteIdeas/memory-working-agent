#!/usr/bin/env node
/**
 * v2 build, slice W1: a Playwright smoke run of the v2 web shell against the BUILT UI in fixture mode.
 *
 *   npm run build:ui
 *   node scripts/v2-web-smoke.mjs [--out <dir>] [--axe <path to axe.min.js>] [--port 4199]
 *
 * It starts `vite preview` with MWA_FIXTURES=1 (the Vite middleware serves /api/v1 from the prototype's example day),
 * and runs at 390×844 and 1440×900, through the middleware (`/?ui=v2`: the real client, EventSource and IndexedDB)
 * and in-browser fixtures (`/?fixtures=1`). Checks: the pill shows and opens the working sheet with the right groups
 * (title = pill, each group's count = the articles listed); the tabs switch; the Ask bar opens the Ask sheet and a
 * message gets its (simulated) answer over the stream; the IndexedDB cache fills; an action made offline waits in
 * the outbox and is sent when back online; a 426 shows "A newer version is ready · Reload"; axe finds 0 violations;
 * nothing scrolls sideways. Screenshots go to --out.
 * Uses the repo's own playwright-core (a dependency) and its Chromium build; axe-core is passed in with --axe.
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('out', join(ROOT, 'reports', 'v2-web-smoke'));
const AXE = arg('axe', process.env.AXE_PATH ?? '');
const PORT = Number(arg('port', '4199'));
const BASE = `http://localhost:${PORT}`;
mkdirSync(OUT, { recursive: true });
if (!existsSync(join(ROOT, 'dist-ui', 'index.html'))) { console.error('Build the UI first: npm run build:ui'); process.exit(2); }
const axeSrc = AXE && existsSync(AXE) ? readFileSync(AXE, 'utf8') : null;
if (!axeSrc) console.warn('! no axe-core given (--axe): accessibility checks are skipped');

const results = [];
let failed = 0;
function check(name, ok, detail = '') { results.push({ name, ok: !!ok, detail }); if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); }

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
const shot = (page, name) => page.screenshot({ path: join(OUT, `${name}.png`) });

async function sheetGroups(page) {
  return page.evaluate(() => {
    const d = document.querySelector('#work-dlg');
    return {
      title: d.querySelector('#work-title').textContent.trim(),
      groups: [...d.querySelectorAll('section.jobgroup')].map((s) => ({ heading: s.querySelector('h3').textContent.trim(), articles: s.querySelectorAll('article').length })),
      month: d.querySelector('.monthline')?.textContent.trim(),
    };
  });
}
function groupsMatch(label, g, expected) {
  check(`${label}: sheet groups ${expected.join(' / ')}`, JSON.stringify(g.groups.map((x) => x.heading)) === JSON.stringify(expected), JSON.stringify(g.groups));
  check(`${label}: each group's count = the articles listed`, g.groups.every((x) => Number(x.heading.split('·').pop()) === x.articles));
}

// ---------- the run ----------
const browser = await chromium.launch();
const VIEWPORTS = [{ name: 'm390', width: 390, height: 844, mobile: true }, { name: 'd1440', width: 1440, height: 900, mobile: false }];
const MODES = [{ name: 'mw', url: (sc) => `${BASE}/?ui=v2&scenario=${sc}`, middleware: true }, { name: 'fx', url: (sc) => `${BASE}/?fixtures=1&scenario=${sc}`, middleware: false }];

try {
  for (const vp of VIEWPORTS) {
    for (const mode of MODES) {
      const L = `${mode.name}-${vp.name}`;
      if (mode.middleware) await reset('N06');
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.mobile ? 2 : 1, hasTouch: vp.mobile, isMobile: vp.mobile });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(mode.url('N06'));
      const pill = page.locator('#statuspill');
      await pill.filter({ hasText: 'Working on 1 · 1 waiting for you' }).waitFor({ timeout: 15_000 }).catch(() => {});
      check(`${L}: the pill shows "Working on 1 · 1 waiting for you"`, (await pill.textContent())?.trim() === 'Working on 1 · 1 waiting for you', await pill.textContent());
      check(`${L}: the pill is a button by that name`, await page.getByRole('button', { name: 'Working on 1 · 1 waiting for you' }).isVisible());
      check(`${L}: "simulated" tag in fixture mode`, await page.locator('#topbar .simtag').isVisible());
      await page.waitForTimeout(400);
      await shot(page, `${L}-01-today`);
      await axe(page, `${L} today`);
      await noOverflow(page, `${L} today`);

      // the working sheet
      await pill.click();
      const dlg = page.locator('#work-dlg');
      await dlg.waitFor({ state: 'visible' });
      const g = await sheetGroups(page);
      check(`${L}: sheet title = the pill`, g.title === 'Working on 1 · 1 waiting for you', g.title);
      groupsMatch(L, g, ['Waiting for you · 1', 'Working now · 1']);
      check(`${L}: month line (the jobs' own costs this month: $1.25 archived + 4¢ + 15¢)`, g.month === '$1.44 on jobs this month', g.month);
      check(`${L}: jobs are articles named by their titles`, await dlg.getByRole('article', { name: 'Learning the USEF eventing rules' }).isVisible() && await dlg.getByRole('article', { name: 'Gathering this week’s AI news' }).isVisible());
      check(`${L}: project tags`, (await dlg.locator('.ptag').allTextContents()).join(',') === 'Eventing,AI newsletter');
      check(`${L}: "Finish the last 10 pages" on the waiting job`, await dlg.getByRole('button', { name: 'Finish the last 10 pages' }).isVisible());
      await page.waitForTimeout(350);
      await shot(page, `${L}-02-working-sheet`);
      await axe(page, `${L} working sheet`);
      await dlg.getByRole('button', { name: 'Close' }).click();
      await dlg.waitFor({ state: 'hidden' });

      // the tabs
      const bar = page.locator(vp.mobile ? '#tabbar' : '#topbar');
      const H1 = { Today: /^Good (morning|afternoon|evening)(, .+)?$/, Calendar: /^Calendar$/, Important: /^Worth a look$/, Projects: /^Projects$/ };
      for (const [tab, re] of Object.entries(H1).reverse()) {
        await bar.getByRole('button', { name: tab, exact: true }).click();
        const h1 = (await page.locator('#main h1').first().textContent())?.trim() ?? '';
        const current = await bar.getByRole('button', { name: tab, exact: true }).getAttribute('aria-current');
        check(`${L}: tab ${tab} → heading "${h1}"`, re.test(h1) && current === 'page');
        if (tab !== 'Today') { await page.waitForTimeout(300); await shot(page, `${L}-03-${tab.toLowerCase()}`); await axe(page, `${L} ${tab}`); await noOverflow(page, `${L} ${tab}`); }
      }

      // Ask: the bar (phone) or the Ask button (desktop) opens the Ask sheet; a message gets its answer over the stream
      await page.getByRole('button', { name: 'Ask, or hand over a job' }).first().click();
      const ask = page.locator('#ask-dlg');
      await ask.waitFor({ state: 'visible' });
      await ask.getByRole('textbox', { name: 'Message your helper' }).fill('put the book fair (Nov 14, 3–6pm, Oakwood Elementary) on my calendar');
      await ask.getByRole('button', { name: 'Send' }).click();
      const answered = await ask.getByText('This is the example app', { exact: false }).waitFor({ timeout: 10_000 }).then(() => true, () => false);
      check(`${L}: Ask sheet sends and the answer arrives`, answered);
      await shot(page, `${L}-04-ask`);
      await axe(page, `${L} ask sheet`);
      await ask.getByRole('button', { name: 'Close' }).click();

      // Settings
      if (vp.mobile) { await page.locator('#tabbar').getByRole('button', { name: 'Today', exact: true }).click(); await page.locator('#main').getByRole('button', { name: 'Settings' }).click(); }
      else await page.locator('#topbar').getByRole('button', { name: 'Settings' }).click();
      check(`${L}: Settings from the avatar`, ((await page.locator('#main h1').first().textContent()) ?? '').trim() === 'Settings');

      if (mode.middleware) {
        // the IndexedDB cache filled
        const idb = await page.evaluate(() => new Promise((res) => {
          const r = indexedDB.open('mwa-v2');
          r.onsuccess = () => {
            const db = r.result, tx = db.transaction(['jobs', 'meta', 'projects', 'calendar', 'threads'], 'readonly');
            const out = {};
            let n = 0;
            for (const s of ['jobs', 'projects', 'calendar', 'threads']) { const q = tx.objectStore(s).count(); q.onsuccess = () => { out[s] = q.result; if (++n === 5) res(out); }; }
            const c = tx.objectStore('meta').get('cursor'); c.onsuccess = () => { out.cursor = c.result; if (++n === 5) res(out); };
          };
          r.onerror = () => res(null);
        }));
        check(`${L}: IndexedDB cache holds jobs, projects, calendar, threads and the cursor`, idb && idb.jobs >= 5 && idb.projects >= 6 && idb.calendar >= 16 && idb.threads >= 4 && idb.cursor > 0, JSON.stringify(idb));

        // offline: Stop waits in the outbox, then goes when back online (same key → the server stops it once)
        await page.locator(vp.mobile ? '#tabbar' : '#topbar').getByRole('button', { name: 'Today', exact: true }).click();
        await pill.click();
        await dlg.waitFor({ state: 'visible' });
        await ctx.setOffline(true);
        await page.waitForTimeout(300);
        await dlg.getByRole('article', { name: 'Gathering this week’s AI news' }).getByRole('button', { name: 'Stop' }).click();
        const queued = await page.locator('#toasts').getByText('You’re offline', { exact: false }).waitFor({ timeout: 5_000 }).then(() => true, () => false);
        check(`${L}: an action made offline is kept ("You’re offline…")`, queued);
        await dlg.getByRole('button', { name: 'Close' }).click();
        check(`${L}: the header says offline`, await page.locator('.connline').filter({ hasText: 'Offline' }).isVisible());
        await shot(page, `${L}-05-offline`);
        await ctx.setOffline(false);
        const after = await page.getByRole('button', { name: '1 waiting for you' }).waitFor({ timeout: 15_000 }).then(() => true, () => false);
        check(`${L}: back online, the queued Stop is sent and the pill follows ("1 waiting for you")`, after, await pill.textContent());
        const jobs = await (await fetch(`${BASE}/api/v1/jobs`, { headers: { 'x-mwa-client': 'web/1.0.0' } })).json();
        check(`${L}: the server stopped the job`, jobs.jobs.find((j) => j.id === 'j_news')?.status.state === 'stopped_by_you');
      }
      check(`${L}: no page errors`, errors.length === 0, errors.join(' | '));
      await ctx.close();
    }

    // every state at once (in-browser fixtures), and the 426 path, and dark
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.mobile ? 2 : 1, hasTouch: vp.mobile, isMobile: vp.mobile });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/?fixtures=1&scenario=states`);
    const pill = page.getByRole('button', { name: 'Working on 2 · 1 waiting for you · 1 result ready' });
    check(`states-${vp.name}: pill from all eight states`, await pill.waitFor({ timeout: 15_000 }).then(() => true, () => false));
    await noOverflow(page, `states-${vp.name} (the longest pill)`);
    await pill.click();
    await page.locator('#work-dlg').waitFor({ state: 'visible' });
    groupsMatch(`states-${vp.name}`, await sheetGroups(page), ['Waiting for you · 1', 'Working now · 2', 'Finished · 2', 'Stopped · 3', 'Scheduled · 1']);
    await page.waitForTimeout(350);
    await shot(page, `states-${vp.name}-working-sheet`);
    await axe(page, `states-${vp.name} working sheet`);
    await page.goto(`${BASE}/?fixtures=1&scenario=old-client`);
    const upd = await page.getByRole('alert').filter({ hasText: 'A newer version is ready' }).waitFor({ timeout: 10_000 }).then(() => true, () => false);
    check(`old-client-${vp.name}: "A newer version is ready · Reload"`, upd && await page.getByRole('button', { name: 'Reload' }).isVisible());
    await shot(page, `old-client-${vp.name}`);
    await page.goto(`${BASE}/?fixtures=1&scenario=N06&theme=dark`);
    await page.getByRole('button', { name: 'Working on 1 · 1 waiting for you' }).waitFor({ timeout: 15_000 });
    await page.waitForTimeout(300);
    await shot(page, `dark-${vp.name}-today`);
    await axe(page, `dark-${vp.name} today`);
    await ctx.close();
  }

  // v1 is untouched: no ?ui → the v1 app (its header says MWA and it has a Chat tab), and v2 CSS is not loaded
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/`);
  await page.waitForTimeout(1500);
  const v1 = await page.evaluate(() => ({ v2: !!document.querySelector('.v2app'), mwaV2: document.documentElement.classList.contains('mwa-v2'), sheets: [...document.styleSheets].length }));
  check('v1 by default: no v2 shell, no v2 styles', !v1.v2 && !v1.mwaV2, JSON.stringify(v1));
  await ctx.close();
} finally {
  await browser.close();
  stopVite();
}
writeFileSync(join(OUT, 'results.json'), JSON.stringify({ at: new Date().toISOString(), failed, results }, null, 2));
console.log(`\n${results.length - failed}/${results.length} checks passed · screenshots in ${OUT}`);
process.exit(failed ? 1 : 0);
