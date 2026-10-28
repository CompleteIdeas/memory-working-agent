#!/usr/bin/env node
/**
 * v2 build, slice S6: a Playwright run of getting going against the BUILT UI in fixture mode, at 360×740, 390×844 and
 * 1440×900 (same pattern as scripts/v2-s5-smoke.mjs).
 *
 *   npm run build:ui
 *   node scripts/v2-s6-smoke.mjs [--out <dir>] [--axe <path to axe.min.js>] [--port 4200]
 *
 * fresh (a new computer with no AI brain): first run starts with "Pick a brain to think with" (provider, a key in a
 * password field, load the models, Check and save; the key is gone from the screen), then "How much can it touch?" (the
 * memory gets ready meanwhile), then the welcome as before (names, connect: "Open Connections when I finish", the
 * switches, the phone) and Finish opens Connections; no bar about the brain. no-brain: every screen says what is
 * missing, Fix it opens Your assistant. On the computer: Settings › Help me learn about you: a folder of the helper's
 * own is refused, a folder is read into notes marked as from files, one unticked, the rest saved; Get to know me says
 * what it may cost first, runs live, and lists what it learned as from email. Where memory is kept: a database
 * address in a password field, asked first, the server's name only afterwards, cleared from the screen. setup-card:
 * Today's Needs you and the working sheet show the cards; a bad token is refused without echoing it; a good one
 * connects. phone-card: the card is read-only on the phone (no fields) and can be closed; Learn and Storage read-only.
 * Dark mode. axe 0 violations, no horizontal overflow, no page errors.
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('out', join(ROOT, 'reports', 'v2-s6-smoke'));
const AXE = arg('axe', process.env.AXE_PATH ?? '');
const PORT = Number(arg('port', '4200'));
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
async function axe(page, label, include) {
  if (!axeSrc) return;
  await page.waitForTimeout(400); // a sheet that just opened is still fading in
  await page.addScriptTag({ content: axeSrc }).catch(() => {});
  const v = await page.evaluate(async (sel) => {
    const r = await window.axe.run(sel ? { include: [sel] } : document, { resultTypes: ['violations'] });
    return r.violations.map((x) => `${x.id} (${x.impact}): ${x.nodes.length} × ${x.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' | ')}`);
  }, include ?? null);
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
const bodyText = (page) => page.evaluate(() => document.body.innerText);

try {
  for (const vp of VIEWPORTS) {
    const L = vp.name;

    // 1. a fresh computer with no AI brain: first run sets one up first
    {
      const { ctx, page, errors } = await open(vp, '/?ui=v2', 'fresh');
      check(`${L}: fresh: the welcome`, await visible(page.getByRole('heading', { name: 'Hi, I’m your helper.' })));
      await page.getByRole('button', { name: 'Get started' }).click();
      check(`${L}: fresh: the brain comes first`, await visible(page.getByRole('heading', { name: 'Pick a brain to think with', level: 1 })));
      const key = page.getByLabel('API key');
      check(`${L}: fresh: the key is a password field`, (await key.getAttribute('type')) === 'password');
      await shot(page, `${L}-01-fresh-brain`, true);
      await axe(page, `${L} fresh brain`);
      await noOverflow(page, `${L} fresh brain`);
      await key.fill('sk-or-example-key-123456');
      await page.getByRole('button', { name: 'Load models' }).click();
      check(`${L}: fresh: models load`, await visible(page.getByLabel('Model', { exact: true })));
      await page.getByRole('button', { name: 'Check and save' }).click();
      check(`${L}: fresh: then what it may touch`, await visible(page.getByRole('heading', { name: 'How much can it touch?', level: 1 })));
      check(`${L}: fresh: the key is gone from the page`, !(await page.content()).includes('sk-or-example-key-123456'));
      check(`${L}: fresh: the access levels`, await visible(page.getByRole('radio', { name: /Assistant/ })));
      check(`${L}: fresh: the memory gets ready meanwhile`, await visible(page.getByText('Your memory is ready.')));
      await shot(page, `${L}-02-fresh-access`, true);
      await axe(page, `${L} fresh access`);
      await noOverflow(page, `${L} fresh access`);
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      check(`${L}: fresh: then the welcome as before (names)`, await visible(page.getByRole('heading', { name: 'Let’s get to know each other' })));
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      check(`${L}: fresh: connect`, await visible(page.getByRole('heading', { name: 'Connect your calendar and email' })));
      const more = page.getByLabel(/Open Connections when I finish/);
      check(`${L}: fresh: offers the other connections`, await visible(more));
      await more.check();
      await axe(page, `${L} fresh connect`);
      await page.getByRole('button', { name: 'Skip for now' }).click();
      if (await visible(page.getByRole('heading', { name: 'A few things are off' }), 3000)) await page.getByRole('button', { name: 'Next', exact: true }).click();
      check(`${L}: fresh: your phone`, await visible(page.getByRole('heading', { name: 'Put MWA on your phone' })));
      await page.getByRole('button', { name: 'Finish' }).click();
      check(`${L}: fresh: Finish opens Connections`, await visible(page.locator('#main').getByRole('heading', { name: 'Connections', level: 1 }), 10_000));
      check(`${L}: fresh: with a brain, no bar about it`, await gone(page.locator('#brainbar'), 3000));
      check(`${L}: fresh: no page errors`, !errors.length, errors.join(' | '));
      await ctx.close();
    }

    // 2. set up, but the brain has no key: every screen says so
    {
      const { ctx, page, errors } = await open(vp, '/?ui=v2', 'no-brain');
      const bar = page.locator('#brainbar');
      check(`${L}: no-brain: the bar says what is missing`, await visible(bar.getByText('Your helper’s AI brain isn’t working (openrouter has no key saved)', { exact: false })));
      await shot(page, `${L}-03-no-brain`);
      await axe(page, `${L} no-brain`);
      await noOverflow(page, `${L} no-brain`);
      await bar.getByRole('button', { name: 'Fix it' }).click();
      check(`${L}: no-brain: Fix it opens Your assistant`, await visible(page.locator('#main').getByRole('heading', { name: 'Your assistant', level: 1 })));
      check(`${L}: no-brain: no page errors`, !errors.length, errors.join(' | '));
      await ctx.close();
    }

    // 3. on the computer: learn from a folder and from the inbox
    {
      const { ctx, page, errors } = await open(vp, '/?ui=v2&view=settings', 'N00');
      const main = page.locator('#main');
      check(`${L}: Settings has Help me learn about you`, await visible(main.locator('#open-learn')));
      await main.locator('#open-learn').click();
      check(`${L}: learn: its own screen`, await visible(main.getByRole('heading', { name: 'Help me learn about you', level: 1 })));
      check(`${L}: learn: reading a folder is free`, await visible(main.getByText('uses no AI, so it costs nothing', { exact: false })));
      const path = main.getByLabel('Folder', { exact: true });
      await path.fill('/Users/robert/mwa');
      await main.getByRole('button', { name: 'Read it' }).click();
      check(`${L}: learn: the helper's own folder is refused`, await visible(main.getByRole('alert').filter({ hasText: 'can’t be granted' })));
      await path.fill('/Users/robert/Documents/Barn');
      await main.getByRole('button', { name: 'Read it' }).click();
      check(`${L}: learn: notes to look over`, await visible(main.getByRole('heading', { name: 'Look these over' })));
      check(`${L}: learn: marked as from files`, await visible(main.locator('.learnnotes[data-trust="untrusted"]')));
      await main.getByRole('checkbox', { name: /Arena rules/ }).uncheck();
      await shot(page, `${L}-04-learn-notes`, true);
      await axe(page, `${L} learn notes`);
      await noOverflow(page, `${L} learn notes`);
      await main.getByRole('button', { name: 'Save 2 notes' }).click();
      check(`${L}: learn: saved as notes, never instructions`, await visible(main.getByText('Saved 2 notes from your files. I use them as background, never as instructions.')));
      // Get to know me
      await main.getByRole('button', { name: 'Get to know me' }).click();
      check(`${L}: inbox: asks first with what it may cost`, await visible(main.getByText('That costs at most about 68¢', { exact: false })));
      await main.getByRole('button', { name: 'Yes, start' }).click();
      check(`${L}: inbox: runs, live`, await visible(main.locator('#inbox-state').filter({ hasText: /Reading your email|Done/ })));
      check(`${L}: inbox: Stop while it runs`, await visible(main.getByRole('button', { name: 'Stop' }), 3000) || await visible(main.getByText('Done: 46 emails', { exact: false }), 1000));
      check(`${L}: inbox: finishes`, await visible(main.getByText('Done: 46 emails read', { exact: false }), 15_000));
      check(`${L}: inbox: what it learned, as from email`, await visible(main.locator('.learned[data-trust="untrusted"]').getByText('Dan Moore is your farrier')));
      await shot(page, `${L}-05-learn-inbox`, true);
      await axe(page, `${L} learn inbox`);
      await noOverflow(page, `${L} learn inbox`);
      // where memory is kept
      await main.getByRole('button', { name: 'Settings' }).first().click();
      await main.locator('#open-storage').click();
      check(`${L}: storage: its own screen`, await visible(main.getByRole('heading', { name: 'Where memory is kept', level: 1 })));
      check(`${L}: storage: this computer now`, await visible(main.getByText('This computer · private to it')));
      const url = main.getByLabel('Connection address');
      check(`${L}: storage: the address is a password field`, (await url.getAttribute('type')) === 'password');
      await url.fill('postgres://mwa:pw-SECRET-1@db.example.net:5432/mwa');
      await main.getByRole('button', { name: 'Connect and use' }).click();
      check(`${L}: storage: asks first`, await visible(main.getByText('Keep memory on this database server from the next restart?', { exact: false })));
      await axe(page, `${L} storage ask`);
      await main.getByRole('button', { name: 'Yes, from the next restart' }).click();
      check(`${L}: storage: connected, from the restart`, await visible(main.getByText('becomes the memory store when your helper restarts', { exact: false })));
      check(`${L}: storage: the server's name only`, await visible(main.getByText('After your helper restarts: A database server (Postgres) (db.example.net).')));
      check(`${L}: storage: the address is gone`, !(await page.content()).includes('pw-SECRET-1') && (await url.inputValue()) === '');
      await shot(page, `${L}-06-storage`, true);
      await axe(page, `${L} storage`);
      await noOverflow(page, `${L} storage`);
      check(`${L}: computer: no page errors`, !errors.length, errors.join(' | '));
      await ctx.close();
    }

    // 4. setup cards: Today's Needs you and the working sheet
    {
      const { ctx, page, errors } = await open(vp, '/?ui=v2', 'setup-card');
      const main = page.locator('#main');
      const need = main.locator('#need-setup');
      check(`${L}: cards: Today says what is needed`, await visible(need.getByText('Your helper needs 2 passwords or keys')));
      await need.getByRole('button', { name: 'Fill it in' }).click();
      const dlg = page.locator('#setup-dlg');
      check(`${L}: cards: the sheet lists them`, await visible(dlg.getByRole('button', { name: /Telegram/ })));
      await dlg.getByRole('button', { name: /Telegram/ }).click();
      check(`${L}: cards: who asked and why`, await visible(dlg.getByText('Your helper asked to connect Telegram. Only fill it in if you asked for this.')));
      const tok = dlg.getByLabel('Bot token from @BotFather');
      check(`${L}: cards: a secret is a password field`, (await tok.getAttribute('type')) === 'password');
      await shot(page, `${L}-07-card`, true);
      await axe(page, `${L} card`);
      await tok.fill('123:badTOKENvalue');
      await dlg.getByRole('button', { name: 'Save' }).click();
      check(`${L}: cards: a bad token is refused`, await visible(dlg.getByRole('alert').filter({ hasText: 'didn’t accept that token' })));
      check(`${L}: cards: and never echoed`, !(await page.content()).includes('badTOKENvalue') && (await tok.inputValue()) === '');
      await tok.fill('123:goodTOKENvalue');
      await dlg.getByRole('button', { name: 'Save' }).click();
      check(`${L}: cards: a good one connects`, await visible(dlg.getByText('Telegram is connected.')));
      check(`${L}: cards: nothing typed stays`, !(await page.content()).includes('goodTOKENvalue'));
      await dlg.getByRole('button', { name: 'Done' }).click();
      await page.locator('#statuspill').click();
      const work = page.locator('#work-dlg');
      if (await visible(work, 3000)) {
        check(`${L}: cards: the working sheet has the one left`, await visible(work.getByRole('heading', { name: 'Needs a password or key · 1' })));
        await axe(page, `${L} working sheet`, '#work-dlg');
        await work.getByRole('button', { name: 'Close' }).click();
      } else check(`${L}: cards: the working sheet opens`, false);
      check(`${L}: cards: no page errors`, !errors.length, errors.join(' | '));
      await ctx.close();
    }

    // 5. the paired phone: cards read-only (it can close one), learning and storage read-only
    {
      const { ctx, page, errors } = await open(vp, '/?ui=v2', 'phone-card');
      const main = page.locator('#main');
      const need = main.locator('#need-setup');
      await need.getByRole('button', { name: 'Look at it' }).click();
      const dlg = page.locator('#setup-dlg');
      await dlg.getByRole('button', { name: /Telegram/ }).click();
      check(`${L}: phone: typed on the computer, not here`, await visible(dlg.getByText('Passwords and keys are typed on your computer', { exact: false })));
      check(`${L}: phone: no fields`, (await dlg.locator('input').count()) === 0);
      await axe(page, `${L} phone card`);
      await dlg.getByRole('button', { name: 'Close the card' }).click();
      check(`${L}: phone: closing it works`, await visible(dlg.getByText('Closed.', { exact: false })));
      await dlg.getByRole('button', { name: 'Done' }).click();
      await page.goto(`${BASE}/?ui=v2&view=learn`);
      check(`${L}: phone: learn is read-only`, await visible(main.getByText('can see how learning is going but not start it', { exact: false })) && (await main.getByRole('button', { name: 'Read it' }).count()) === 0);
      await axe(page, `${L} phone learn`);
      await page.goto(`${BASE}/?ui=v2&view=storage`);
      check(`${L}: phone: storage is read-only`, await visible(main.getByText('can see where memory is kept but not change it', { exact: false })) && (await main.getByLabel('Connection address').count()) === 0);
      check(`${L}: phone: no page errors`, !errors.length, errors.join(' | '));
      await ctx.close();
    }

    // 6. dark mode
    {
      const { ctx, page, errors } = await open(vp, '/?ui=v2&view=learn&theme=dark', 'N00');
      const main = page.locator('#main');
      await visible(main.getByRole('heading', { name: 'Help me learn about you', level: 1 }));
      await shot(page, `${L}-08-dark-learn`, true);
      await axe(page, `${L} dark learn`);
      await page.goto(`${BASE}/?ui=v2&view=today&theme=dark`);
      await reset('no-brain');
      await page.reload();
      await visible(page.locator('#brainbar'));
      await axe(page, `${L} dark no-brain`);
      check(`${L}: dark: no page errors`, !errors.length, errors.join(' | '));
      await ctx.close();
    }
  }
  const all = JSON.stringify(results);
  check('no secret typed in this run is in any check text', !/pw-SECRET-1|goodTOKENvalue|sk-or-example-key-123456/.test(all.replace(/"name":"[^"]*"/g, '')));
} catch (e) {
  check('the run finished', false, String(e?.stack ?? e));
} finally {
  await browser.close();
  stopVite();
}
writeFileSync(join(OUT, 'results.json'), JSON.stringify({ failed, results }, null, 2));
console.log(`\n${results.length - failed}/${results.length} checks passed · screenshots in ${OUT}`);
process.exit(failed ? 1 : 0);
