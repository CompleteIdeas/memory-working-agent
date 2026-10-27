#!/usr/bin/env node
/**
 * v2 build, slice S2: a Playwright run of Settings › Your assistant against the BUILT UI in fixture mode, at 360×740,
 * 390×844 and 1440×900 (same pattern as scripts/v2-s1-smoke.mjs).
 *
 *   npm run build:ui
 *   node scripts/v2-s2-smoke.mjs [--out <dir>] [--axe <path to axe.min.js>] [--port 4199]
 *
 * On the computer: Settings → Your assistant (its own screen) with AI brain / Making pictures / What it can touch /
 * How I work with you. The brain: Change, a provider, a key in a password field, Load models, a weak model warns that
 * adding plug-ins from npm turns off, Check and save says so, the typed key is nowhere on the page, and the Plug-ins
 * page then says npm is off; a bad key is refused without echoing it. Pictures: set up, then turn off. Access: Developer
 * asks first; a folder added, a whole drive and the helper's own folder refused, a folder removed. Style: Direct.
 * A paired phone: read-only with the note. model-fixed: no Change. Dark mode. axe 0 violations, no horizontal overflow,
 * no page errors.
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('out', join(ROOT, 'reports', 'v2-s2-smoke'));
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
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.mobile ? 2 : 1, hasTouch: vp.mobile, isMobile: vp.mobile });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}${url}`);
  return { ctx, page, errors };
}
const section = (main, title) => main.locator(`section:has(> h2.sh:text-is("${title}"))`);

const SECRET = 'sk-ant-smokeTYPEDsecret123';
const BADKEY = 'sk-or-bad-smoke-998877';
try {
  for (const vp of VIEWPORTS) {
    const L = vp.name;

    // 1. on the computer: Settings → Your assistant, and every change
    {
      const { ctx, page, errors } = await open(vp, '/?ui=v2&view=settings', 'N00');
      const main = page.locator('#main');
      check(`${L}: Settings`, await visible(main.getByRole('heading', { name: 'Settings', level: 1 })));
      check(`${L}: Settings has a Your assistant section`, await visible(main.getByRole('heading', { name: 'Your assistant', level: 2 })));
      await main.locator('#open-assistant').click();
      check(`${L}: Your assistant opens as its own screen`, await visible(main.getByRole('heading', { name: 'Your assistant', level: 1 })));
      for (const t of ['AI brain', 'Making pictures', 'What it can touch', 'How I work with you']) check(`${L}: section "${t}"`, await visible(main.getByRole('heading', { name: t, level: 2, exact: true })));
      const brain = section(main, 'AI brain');
      check(`${L}: the brain is shown`, await visible(brain.locator('#brain-now').getByText('openrouter:openai/gpt-6.1-sol')));
      check(`${L}: npm plug-ins: on, and who checks them`, await visible(brain.locator('#npm-line').getByText(/^On\./)));
      await shot(page, `${L}-01-assistant`, true);
      await axe(page, `${L} assistant`);
      await noOverflow(page, `${L} assistant`);

      // the brain: a bad key is refused without echoing it
      await brain.getByRole('button', { name: 'Change the AI brain' }).click();
      const form = brain.getByRole('form', { name: 'Change the AI brain' });
      check(`${L}: the brain form opens`, await visible(form.getByLabel('AI provider')));
      check(`${L}: the key field is a password field`, (await form.getByLabel(/^API key/).getAttribute('type')) === 'password');
      await form.getByLabel(/^API key/).fill(BADKEY);
      await form.getByRole('button', { name: 'Load models' }).click();
      check(`${L}: models load`, await visible(form.getByLabel('Model', { exact: true })));
      await form.getByRole('button', { name: 'Check and save' }).click();
      check(`${L}: a bad key is refused`, await visible(form.getByText(/Incorrect API key/)));
      check(`${L}: …and its value is nowhere on the page`, !(await page.content()).includes(BADKEY));
      check(`${L}: …and the key field is cleared`, (await form.getByLabel(/^API key/).inputValue()) === '');
      await axe(page, `${L} brain form`);
      await noOverflow(page, `${L} brain form`);

      // a weak model: the page says what it does to npm plug-ins before saving
      await form.getByLabel('Model', { exact: true }).selectOption('openai/gpt-6-luna');
      check(`${L}: a weak model warns npm plug-ins turn off`, await visible(form.getByText('With this model, adding plug-ins from npm turns off: it needs a stronger model to check them.')));
      await shot(page, `${L}-02-brain-form`);
      await form.getByRole('button', { name: 'Check and save' }).click();
      check(`${L}: saved, and the message says npm is off now`, await visible(brain.getByText(/Adding plug-ins from npm is off now/)));
      check(`${L}: the new brain is shown`, await visible(brain.locator('#brain-now').getByText('openrouter:openai/gpt-6-luna')));
      check(`${L}: npm line says off`, await visible(brain.locator('#npm-line').getByText(/^Off\./)));

      // another provider with a new key: written once, never shown
      await brain.getByRole('button', { name: 'Change the AI brain' }).click();
      await form.getByLabel('AI provider').selectOption('anthropic');
      await form.getByLabel(/^API key/).fill(SECRET);
      await form.getByRole('button', { name: 'Load models' }).click();
      await visible(form.getByLabel('Model', { exact: true }));
      await form.getByRole('button', { name: 'Check and save' }).click();
      check(`${L}: Anthropic saved, npm back on`, await visible(brain.getByText(/Adding plug-ins from npm is available now/)));
      check(`${L}: the typed key is nowhere on the page`, !(await page.content()).includes(SECRET));
      check(`${L}: …nor in what the server sends`, !(await (await fetch(`${BASE}/api/v1/assistant`)).text()).includes(SECRET));

      // the weak brain had turned npm off on the Plug-ins page too: the link goes there
      await brain.getByRole('button', { name: /^Plug-ins/ }).click();
      check(`${L}: the Plug-ins link opens Plug-ins`, await visible(main.getByRole('heading', { name: 'Plug-ins', level: 1 })));
      check(`${L}: Plug-ins can add from npm again`, await visible(main.getByLabel('npm package')));
      await main.getByRole('button', { name: 'Settings' }).first().click();
      await main.locator('#open-assistant').click();
      await visible(main.getByRole('heading', { name: 'Your assistant', level: 1 }));

      // pictures: set up, then off
      const pics = section(main, 'Making pictures');
      check(`${L}: pictures off`, await visible(pics.getByText(/^Off\. Set one up/)));
      await pics.getByRole('button', { name: 'Set up an image model' }).click();
      const iform = pics.getByRole('form', { name: 'Change the image model' });
      check(`${L}: Anthropic isn't offered for pictures`, !(await iform.getByLabel('Image provider').locator('option[value="anthropic"]').count()));
      await iform.getByRole('button', { name: 'Load models' }).click();
      check(`${L}: image models load`, await visible(iform.getByLabel('Image model', { exact: true })));
      await axe(page, `${L} image form`);
      await iform.getByRole('button', { name: 'Save', exact: true }).click();
      check(`${L}: image model set`, await visible(pics.getByText('Image model set to openrouter:black-forest-labs/flux-2.', { exact: false })));
      await pics.getByRole('button', { name: 'Turn off' }).click();
      check(`${L}: pictures turned off`, await visible(pics.getByText('Image generation turned off.')));

      // what it can touch: Developer asks first
      const touch = section(main, 'What it can touch');
      await touch.getByRole('radio', { name: /^Developer/ }).check();
      const ask = touch.getByRole('region', { name: 'Switch to Developer?' });
      check(`${L}: Developer asks first`, await visible(ask));
      await shot(page, `${L}-03-developer-confirm`);
      await axe(page, `${L} developer confirm`);
      await ask.getByRole('button', { name: 'Keep Assistant' }).click();
      check(`${L}: Keep leaves Assistant`, await gone(ask) && await touch.getByRole('radio', { name: /^Assistant/ }).isChecked());
      await touch.getByRole('radio', { name: /^Locked-down/ }).check();
      check(`${L}: Locked-down saved`, await visible(touch.getByText(/these folders aren’t used right now/)));
      await touch.getByRole('radio', { name: /^Assistant/ }).check();
      await gone(touch.getByText(/these folders aren’t used right now/));

      // folders: add, refuse, remove
      const field = touch.getByLabel('Add a folder');
      await field.fill('/Users/robert/Documents/Show results');
      await touch.getByRole('button', { name: 'Add', exact: true }).click();
      check(`${L}: a folder is added`, await visible(touch.getByRole('group', { name: '/Users/robert/Documents/Show results' })));
      check(`${L}: …and the field is cleared`, (await field.inputValue()) === '');
      await field.fill('/');
      await touch.getByRole('button', { name: 'Add', exact: true }).click();
      check(`${L}: a whole drive is refused`, await visible(touch.getByText('A whole drive can’t be granted. Pick a folder on it, like Documents.')));
      await field.fill('/Users/robert');
      await touch.getByRole('button', { name: 'Add', exact: true }).click();
      check(`${L}: the helper's own folder is refused`, await visible(touch.getByText(/holds your helper’s own keys and settings/)));
      check(`${L}: a missing folder says so`, await visible(touch.getByText('This folder isn’t there any more.')));
      await touch.getByRole('button', { name: 'Remove /Users/robert/Old project' }).click();
      check(`${L}: a folder is removed`, await gone(touch.getByRole('group', { name: '/Users/robert/Old project' })));
      await shot(page, `${L}-04-touch`);
      await axe(page, `${L} touch`);
      await noOverflow(page, `${L} touch`);

      // style
      const style = section(main, 'How I work with you');
      await style.getByRole('radio', { name: /^Direct/ }).check();
      check(`${L}: Direct saved`, await visible(style.getByText('Switched to Direct — concise replies.')));

      await main.getByRole('button', { name: 'Settings' }).first().click();
      check(`${L}: Back goes to Settings`, await visible(main.getByRole('heading', { name: 'Settings', level: 1 })));
      check(`${L}: computer: no page errors`, !errors.length, errors.join(' | '));
      await ctx.close();
    }

    // 2. a paired phone: read-only
    {
      const { ctx, page, errors } = await open(vp, '/?ui=v2&view=assistant', 'phone');
      const main = page.locator('#main');
      check(`${L}: phone: Your assistant`, await visible(main.getByRole('heading', { name: 'Your assistant', level: 1 })));
      check(`${L}: phone: says where to change it`, await visible(main.getByRole('note').getByText(/can see how your assistant is set up but not change it/)));
      check(`${L}: phone: no forms, radios or Change`, !(await main.locator('input, select').count()) && !(await main.getByRole('button', { name: /^(Change|Set up|Turn off|Remove|Add)/ }).count()));
      check(`${L}: phone: the brain, level and style are still shown`, await visible(main.getByText('openrouter:openai/gpt-6.1-sol')) && await visible(main.getByText('Access level: Assistant')) && await visible(main.getByText('Style: Guided')));
      await shot(page, `${L}-05-phone`, true);
      await axe(page, `${L} phone`);
      await noOverflow(page, `${L} phone`);
      check(`${L}: phone: no page errors`, !errors.length, errors.join(' | '));
      await ctx.close();
    }

    // 3. the server's MWA_MODEL chooses the model
    {
      const { ctx, page, errors } = await open(vp, '/?ui=v2&view=assistant', 'model-fixed');
      const main = page.locator('#main');
      check(`${L}: fixed: says the server chooses`, await visible(main.getByText(/MWA_MODEL setting chooses this/)));
      check(`${L}: fixed: no Change for the brain`, !(await main.getByRole('button', { name: 'Change the AI brain' }).count()));
      await axe(page, `${L} fixed`);
      check(`${L}: fixed: no page errors`, !errors.length, errors.join(' | '));
      await ctx.close();
    }

    // 4. dark mode
    {
      const { ctx, page, errors } = await open(vp, '/?ui=v2&view=assistant&theme=dark', 'N00');
      const main = page.locator('#main');
      await visible(main.getByRole('heading', { name: 'Your assistant', level: 1 }));
      await shot(page, `${L}-06-dark`, true);
      await axe(page, `${L} dark`);
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
