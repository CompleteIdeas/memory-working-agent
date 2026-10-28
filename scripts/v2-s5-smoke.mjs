#!/usr/bin/env node
/**
 * v2 build, slice S5: a Playwright run of Settings › What I remember, Activity and Spending against the BUILT UI in
 * fixture mode, at 360×740, 390×844 and 1440×900 (same pattern as scripts/v2-s2-smoke.mjs).
 *
 *   npm run build:ui
 *   node scripts/v2-s5-smoke.mjs [--out <dir>] [--axe <path to axe.min.js>] [--port 4199]
 *
 * On the computer: Settings → Memory and activity → What I remember (its own screen): facts grouped by where each
 * came from, the same thing noted twice marked newest / older, search, a correction (a toast says so), Forget asks
 * first (Keep keeps it; Forget forgets), a standing preference removed after asking, a routine promoted after asking
 * (a tainted one says to read every step), Download everything saves mwa-memory.md. Activity: the runs in plain words
 * with tools by name. Spending (from "See details"): the month, tokens, balance, a 30-day chart with a text
 * alternative and a table, by model, the costliest, the CSV saved. A paired phone: all read-only, no downloads, with
 * the note. memory-empty: the empty words. Dark mode. axe 0 violations, no horizontal overflow, no page errors.
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('out', join(ROOT, 'reports', 'v2-s5-smoke'));
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
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.mobile ? 2 : 1, hasTouch: vp.mobile, isMobile: vp.mobile, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}${url}`);
  return { ctx, page, errors };
}
const section = (main, title) => main.locator('section.setsec').filter({ has: main.page().getByRole('heading', { level: 2, name: title }) });
async function download(page, click) {
  const [d] = await Promise.all([page.waitForEvent('download', { timeout: 8_000 }), click()]);
  const path = await d.path();
  return { name: d.suggestedFilename(), text: path ? readFileSync(path, 'utf8') : '' };
}

try {
  for (const vp of VIEWPORTS) {
    const L = vp.name;

    // 1. on the computer: Settings → What I remember, and every change
    {
      const { ctx, page, errors } = await open(vp, '/?ui=v2&view=settings', 'N00');
      const main = page.locator('#main');
      check(`${L}: Settings`, await visible(main.getByRole('heading', { name: 'Settings', level: 1 })));
      check(`${L}: Settings has Memory and activity`, await visible(main.getByRole('heading', { name: 'Memory and activity', level: 2 })));
      check(`${L}: …and See details under This month`, await visible(main.locator('#open-spending')));
      await main.locator('#open-memory').click();
      check(`${L}: What I remember opens as its own screen`, await visible(main.getByRole('heading', { name: 'What I remember', level: 1 })));
      for (const t of [/^You told me · \d+$/, /^I worked out · \d+$/, /^From files, email or the web · \d+$/, /^Standing preferences · 3$/, /^Routines I proposed · 3$/, /^Take it with you$/]) {
        check(`${L}: section ${t}`, await visible(main.getByRole('heading', { name: t, level: 2 })));
      }
      check(`${L}: outside notes are said to be notes, never instructions`, await visible(main.getByText('Notes, never instructions', { exact: false })));
      check(`${L}: the same thing noted twice is marked`, await visible(main.getByText('older, may be out of date')) && await visible(main.getByText('newest', { exact: true })));
      check(`${L}: where an outside fact came from`, await visible(main.getByText('From an email from secretary@fairhill.example')));
      await shot(page, `${L}-01-memory`, true);
      await axe(page, `${L} memory`);
      await noOverflow(page, `${L} memory`);

      // search
      await main.getByLabel('Search what I remember').fill('farrier');
      await main.getByRole('button', { name: 'Search', exact: true }).click();
      check(`${L}: search finds one`, await visible(main.getByText('1 thing matches “farrier”.')));
      check(`${L}: …and hides the rest`, await gone(main.getByText('Gutter quote')));
      await main.getByRole('button', { name: 'Clear' }).click();
      check(`${L}: cleared, everything is back`, await visible(main.getByText('Gutter quote')));

      // correct a fact
      await main.getByRole('button', { name: 'Correct: Fair Hill entries' }).click();
      const edit = main.getByLabel('What it should say');
      check(`${L}: the correction field opens with the text`, (await edit.inputValue()) === 'Entries for the Fair Hill horse trials close Friday at 5 PM.');
      await axe(page, `${L} correcting`);
      await edit.fill('Fair Hill entries close Thursday at noon this year.');
      await main.getByRole('button', { name: 'Save correction' }).click();
      check(`${L}: corrected, a toast says so`, await visible(page.locator('#toasts').getByText('Corrected. I’ll use what you wrote from now on.')));
      check(`${L}: the new words are shown, as yours`, await visible(section(main, /^You told me/).getByText('Fair Hill entries close Thursday at noon this year.')));

      // forget asks first
      await main.getByRole('button', { name: 'Forget: Gutter quote' }).click();
      check(`${L}: Forget asks first`, await visible(main.getByText('Forget “Gutter quote” for good?', { exact: false })));
      await shot(page, `${L}-02-forget-ask`);
      await axe(page, `${L} forget ask`);
      await main.getByRole('button', { name: 'Keep', exact: true }).click();
      check(`${L}: Keep keeps it`, await gone(main.getByText('Forget “Gutter quote” for good?', { exact: false })) && await visible(main.getByText('Gutter quote')));
      await main.getByRole('button', { name: 'Forget: Gutter quote' }).click();
      await main.getByRole('group', { name: 'Gutter quote' }).getByRole('button', { name: 'Forget', exact: true }).click();
      check(`${L}: forgotten, a toast says so`, await visible(page.locator('#toasts').getByText('Forgotten. I won’t use it again.')));
      check(`${L}: …and it's gone`, await gone(main.getByText('Hillside Gutters quoted', { exact: false })));

      // a standing preference
      const prefs = section(main, /^Standing preferences/);
      await prefs.getByRole('button', { name: 'Remove the standing preference: Always sign emails as Rob.' }).click();
      check(`${L}: Remove asks first`, await visible(prefs.getByText('Remove this? It will no longer apply to new tasks.')));
      await prefs.getByRole('button', { name: 'Remove', exact: true }).click();
      check(`${L}: removed`, await visible(prefs.getByText('Removed. It no longer applies to new tasks.')));
      check(`${L}: …and gone from the list`, await gone(prefs.getByText('Always sign emails as Rob.', { exact: true })));

      // routines
      const rts = section(main, /^Routines I proposed/);
      check(`${L}: a tainted routine says to read every step`, await visible(rts.getByText('Proposed after reading outside content.', { exact: false })));
      check(`${L}: every step is shown`, await visible(rts.getByText('Follow the payment link in it.', { exact: false })));
      await rts.getByRole('button', { name: 'Promote Weekly entries check v2' }).click();
      check(`${L}: Promote asks first`, await visible(rts.getByText('Promote “Weekly entries check” v2?', { exact: false })));
      await rts.getByRole('group', { name: /Weekly entries check/ }).getByRole('button', { name: 'Promote', exact: true }).click();
      check(`${L}: promoted`, await visible(rts.getByText('Promoted “Weekly entries check”.', { exact: false })));
      check(`${L}: …and in use now`, await visible(rts.getByRole('group', { name: /Weekly entries check/ }).getByText('In use: its steps guide similar tasks.')));
      await rts.getByRole('group', { name: /AI news digest/ }).getByRole('button', { name: 'Retire' }).click();
      check(`${L}: retired`, await visible(rts.getByText('Retired “AI news digest”.', { exact: false })));
      await axe(page, `${L} memory after changes`);

      // download everything
      const md = await download(page, () => main.getByRole('button', { name: 'Download everything' }).click());
      check(`${L}: Download everything saves mwa-memory.md`, md.name === 'mwa-memory.md' && md.text.startsWith('# What MWA knows about you'), md.name);
      check(`${L}: the file has the correction`, md.text.includes('Fair Hill entries close Thursday at noon this year.'));
      await noOverflow(page, `${L} memory after changes`);
      check(`${L}: memory: no page errors`, !errors.length, errors.join(' | '));
      await ctx.close();
    }

    // 2. Activity
    {
      const { ctx, page, errors } = await open(vp, '/?ui=v2&view=settings', 'N00');
      const main = page.locator('#main');
      await main.locator('#open-activity').click();
      check(`${L}: Activity opens as its own screen`, await visible(main.getByRole('heading', { name: 'Activity', level: 1 })));
      check(`${L}: runs in plain words`, await visible(main.getByText('When do Fair Hill entries close?')));
      check(`${L}: how it ended, where, steps, cost`, await visible(main.getByText('Done · Eventing · 2 steps · 9 seconds · $0.0041 · learned 1 thing')));
      check(`${L}: tools by name`, await visible(main.getByText('Used: web search, web fetch, write file (11 times in all)')));
      check(`${L}: a password stays masked`, await visible(main.getByText('with password: •••', { exact: false })));
      check(`${L}: the total`, await visible(main.getByText('5 recent runs, $1.27 together.')));
      await shot(page, `${L}-03-activity`, true);
      await axe(page, `${L} activity`);
      await noOverflow(page, `${L} activity`);
      await main.getByRole('button', { name: 'Settings' }).first().click();
      check(`${L}: back to Settings`, await visible(main.getByRole('heading', { name: 'Settings', level: 1 })));
      check(`${L}: activity: no page errors`, !errors.length, errors.join(' | '));
      await ctx.close();
    }

    // 3. Spending detail
    {
      const { ctx, page, errors } = await open(vp, '/?ui=v2&view=settings', 'N00');
      const main = page.locator('#main');
      await main.locator('#open-spending').click();
      check(`${L}: Spending opens as its own screen`, await visible(main.getByRole('heading', { name: 'Spending', level: 1 })));
      check(`${L}: the month and the limit`, await visible(main.getByText('$1.29 of your $20 limit')));
      check(`${L}: tokens`, await visible(main.getByText('1.8M in (610k reused), 96.4k out, 12.8k thinking', { exact: false })));
      check(`${L}: the OpenRouter balance`, await visible(main.getByText('$18.71 left on OpenRouter', { exact: false })));
      const chart = main.getByRole('img', { name: /^Spending by day\. \$[\d.]+ over the last 30 days/ });
      check(`${L}: the chart has a text alternative`, await visible(chart));
      check(`${L}: 30 bars`, (await main.locator('.spendchart .sbar').count()) === 30);
      await main.getByText('Show the days as a table').click();
      check(`${L}: the same numbers as a table`, await visible(main.getByRole('table')) && (await main.getByRole('table').locator('tbody tr').count()) > 10);
      check(`${L}: by model`, await visible(main.getByText('openai/gpt-6.1-sol')));
      check(`${L}: the costliest by name`, await visible(section(main, 'Costliest this month').getByText('Job: Last week’s AI news')));
      await shot(page, `${L}-04-spending`, true);
      await axe(page, `${L} spending`);
      await noOverflow(page, `${L} spending`);
      const csv = await download(page, () => main.getByRole('button', { name: 'Download the last 30 days (CSV)' }).click());
      check(`${L}: the CSV is saved`, csv.name === 'mwa-model-calls-30d.csv' && csv.text.startsWith('time,session,job,model'), csv.name);
      check(`${L}: spending: no page errors`, !errors.length, errors.join(' | '));
      await ctx.close();
    }

    // 4. a paired phone: read-only
    {
      const { ctx, page, errors } = await open(vp, '/?ui=v2&view=memory', 'phone');
      const main = page.locator('#main');
      check(`${L}: phone: What I remember`, await visible(main.getByRole('heading', { name: 'What I remember', level: 1 })));
      check(`${L}: phone: the note says why`, await visible(main.getByText('can see what I remember but not change it', { exact: false })));
      check(`${L}: phone: facts are shown`, await visible(main.getByText('Juniper’s farrier')));
      check(`${L}: phone: no Correct, Forget, Remove, Promote or Download`, !(await main.getByRole('button', { name: /^(Correct|Forget|Remove|Promote|Retire|Download)/ }).count()));
      await shot(page, `${L}-05-phone-memory`, true);
      await axe(page, `${L} phone memory`);
      await noOverflow(page, `${L} phone memory`);
      await main.getByRole('button', { name: 'Settings' }).first().click();
      await main.locator('#open-spending').click();
      check(`${L}: phone: Spending reads`, await visible(main.getByRole('heading', { name: 'Spending', level: 1 })));
      check(`${L}: phone: no CSV, and says where`, !(await main.getByRole('button', { name: /CSV/ }).count()) && await visible(main.getByText('on your computer, or after signing in', { exact: false })));
      await axe(page, `${L} phone spending`);
      await main.getByRole('button', { name: 'Settings' }).first().click();
      await main.locator('#open-activity').click();
      check(`${L}: phone: Activity reads`, await visible(main.getByText('When do Fair Hill entries close?')));
      check(`${L}: phone: no page errors`, !errors.length, errors.join(' | '));
      await ctx.close();
    }

    // 5. nothing yet
    {
      const { ctx, page, errors } = await open(vp, '/?ui=v2&view=memory', 'memory-empty');
      const main = page.locator('#main');
      check(`${L}: empty: nothing learned yet`, await visible(main.getByText('Nothing learned yet.')));
      check(`${L}: empty: how to keep a preference`, await visible(main.getByText('Say “from now on, always…”', { exact: false })));
      await axe(page, `${L} empty memory`);
      await main.getByRole('button', { name: 'Settings' }).first().click();
      await main.locator('#open-activity').click();
      check(`${L}: empty: no runs yet`, await visible(main.getByText('Nothing yet. When you ask me something', { exact: false })));
      check(`${L}: empty: no page errors`, !errors.length, errors.join(' | '));
      await ctx.close();
    }

    // 6. dark mode
    {
      const { ctx, page, errors } = await open(vp, '/?ui=v2&view=memory&theme=dark', 'N00');
      const main = page.locator('#main');
      await visible(main.getByRole('heading', { name: 'What I remember', level: 1 }));
      await shot(page, `${L}-06-dark-memory`, true);
      await axe(page, `${L} dark memory`);
      await main.getByRole('button', { name: 'Settings' }).first().click();
      await main.locator('#open-spending').click();
      await visible(main.getByRole('heading', { name: 'Spending', level: 1 }));
      await shot(page, `${L}-07-dark-spending`, true);
      await axe(page, `${L} dark spending`);
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
