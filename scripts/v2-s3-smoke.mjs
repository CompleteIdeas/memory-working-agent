#!/usr/bin/env node
/**
 * v2 build, slice S3: a Playwright run of Settings › Connections against the BUILT UI in fixture mode, at 360×740,
 * 390×844 and 1440×900 (same pattern as scripts/v2-s2-smoke.mjs).
 *
 *   npm run build:ui
 *   node scripts/v2-s3-smoke.mjs [--out <dir>] [--axe <path to axe.min.js>] [--port 4198]
 *
 * On the computer: Settings › Connected › All connections opens Connections (Google, Outlook, Telegram, Reach it from
 * anywhere). Google: Disconnect asks first and says what stops working (Keep, then Disconnect); an app password (a bad
 * one refused without echoing it, the field cleared); your own Google sign-in app (the secret in a password field,
 * never shown); then "Add Calendar: sign in with Google" finishes. Outlook: the code card (code, link, time left) and
 * the sign-in finishing; disconnect; your own Microsoft app (the redirect address shown) and the browser-window
 * option. Telegram: a bad token refused, a good one saved and never shown, disconnect. Tailscale: what it is and how it
 * relates to the address for phones, a key + name saved, an API token refused, remove, and the link to Address for
 * phones. Today's and the Calendar's Reconnect / Connect land here at the right account (never the classic app);
 * a setup from the Settings list lands here; on a server the browser sign-in says why it can't work; a paired phone
 * is read-only. Dark mode. axe 0 violations, no horizontal overflow, no page errors.
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('out', join(ROOT, 'reports', 'v2-s3-smoke'));
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
  await ctx.route(/accounts\.google\.com|login\.microsoftonline\.com|microsoft\.com\/devicelogin/, (r) => r.fulfill({ status: 200, body: 'stub' }));
  const page = await ctx.newPage();
  // the sign-in windows a Connect opens: closed at once (nothing real is contacted)
  page.on('popup', (p) => { void p.close().catch(() => {}); });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}${url}`);
  return { ctx, page, errors };
}
const section = (main, title) => main.locator(`section:has(> h2.sh:text-is("${title}"))`);
const focusedHeading = (page) => page.evaluate(() => (document.activeElement?.tagName === 'H2' ? document.activeElement.textContent : null));

const BAD_PW = 'badbadbadbadbadx';
const GOOD_PW = 'abcd efgh ijkl mnop';
const SECRET = 'GOCSPX-smokeTYPEDsecret';
const TOKEN = '123456789:AAHsmokeTOKENexampleTOKEN0123456';
const TS_KEY = 'tskey-auth-smokeTYPEDkey123';
try {
  for (const vp of VIEWPORTS) {
    const L = vp.name;

    // 1. on the computer: Settings › Connected › All connections, and every change
    {
      const { ctx, page, errors } = await open(vp, '/?ui=v2&view=settings', 'N00');
      const main = page.locator('#main');
      check(`${L}: Settings`, await visible(main.getByRole('heading', { name: 'Settings', level: 1 })));
      await main.locator('#open-connections').click();
      check(`${L}: Connections opens as its own screen`, await visible(main.getByRole('heading', { name: 'Connections', level: 1 })));
      for (const t of ['Google', 'Outlook', 'Telegram', 'Reach it from anywhere']) check(`${L}: section "${t}"`, await visible(main.getByRole('heading', { name: t, level: 2, exact: true })));
      const google = section(main, 'Google');
      check(`${L}: Google connected with sign-in`, await visible(google.locator('#google-line').getByText(/^Connected with Google sign-in/)));
      await shot(page, `${L}-01-connections`, true);
      await axe(page, `${L} connections`);
      await noOverflow(page, `${L} connections`);

      // Google: disconnect asks first, says what stops working; Keep leaves it
      await google.getByRole('button', { name: 'Disconnect', exact: true }).click();
      const ask = google.getByRole('region', { name: 'Disconnect Google?' });
      check(`${L}: disconnect asks first`, await visible(ask));
      check(`${L}: …and says mail sorting and the calendar stop`, await visible(ask.getByText(/stop sorting your mail.*Google events leave Today and the Calendar/)));
      await shot(page, `${L}-02-disconnect-ask`);
      await axe(page, `${L} disconnect ask`);
      await ask.getByRole('button', { name: 'Keep Google' }).click();
      check(`${L}: Keep leaves Google connected`, await gone(ask) && await visible(google.locator('#google-line').getByText(/^Connected with Google sign-in/)));
      await google.getByRole('button', { name: 'Disconnect', exact: true }).click();
      await ask.getByRole('button', { name: 'Disconnect Google' }).click();
      check(`${L}: Google disconnected`, await visible(google.getByText('Google disconnected. Its sign-in was removed from your helper.')));
      check(`${L}: …now not connected, sign-in app gone`, await visible(google.locator('#google-line').getByText('Not connected.')) && await visible(google.getByText(/^Not set up\. You need it once/)));
      check(`${L}: …and says sign-in needs the setup`, await visible(google.getByText(/needs your own Google sign-in app first/)));

      // an app password: a bad one refused without echoing it, a good one connects
      await google.getByRole('button', { name: 'Use an app password' }).click();
      const pw = google.getByRole('form', { name: 'Connect Gmail with an app password' });
      check(`${L}: app password form`, await visible(pw.getByLabel('Gmail address')));
      check(`${L}: the app password is a password field`, (await pw.getByLabel('App password').getAttribute('type')) === 'password');
      await pw.getByLabel('Gmail address').fill('robert@gmail.com');
      await pw.getByLabel('App password').fill(BAD_PW);
      await pw.getByRole('button', { name: 'Check and connect' }).click();
      check(`${L}: a bad app password is refused`, await visible(pw.getByText(/Sign-in failed/)));
      check(`${L}: …its value is nowhere on the page and the field is cleared`, !(await page.content()).includes(BAD_PW) && (await pw.getByLabel('App password').inputValue()) === '');
      await axe(page, `${L} app password form`);
      await noOverflow(page, `${L} app password form`);
      await pw.getByLabel('App password').fill(GOOD_PW);
      await pw.getByRole('button', { name: 'Check and connect' }).click();
      check(`${L}: Gmail connected with an app password`, await visible(google.locator('#google-line').getByText(/app password \(robert@gmail\.com\): Gmail only/)));
      check(`${L}: …the password is nowhere on the page`, !(await page.content()).includes(GOOD_PW.replace(/ /g, '')) && !(await page.content()).includes(GOOD_PW));

      // your own Google sign-in app, then add Calendar by signing in
      await google.getByRole('button', { name: 'Set up Google sign-in' }).click();
      const gapp = google.getByRole('form', { name: 'Set up Google sign-in' });
      check(`${L}: the client secret is a password field`, (await gapp.getByLabel('Client secret').getAttribute('type')) === 'password');
      await gapp.getByLabel('Client ID').fill('not-an-id');
      await gapp.getByLabel('Client secret').fill(SECRET);
      await gapp.getByRole('button', { name: 'Save', exact: true }).click();
      check(`${L}: a wrong client ID is refused`, await visible(gapp.getByText(/doesn’t look like a Client ID/)));
      check(`${L}: …and the secret field is cleared`, (await gapp.getByLabel('Client secret').inputValue()) === '');
      await gapp.getByLabel('Client ID').fill('123-abc.apps.googleusercontent.com');
      await gapp.getByLabel('Client secret').fill(SECRET);
      await gapp.getByRole('button', { name: 'Save', exact: true }).click();
      check(`${L}: Google sign-in app saved`, await visible(google.getByText('Saved. Now sign in with Google.')));
      check(`${L}: …the secret is nowhere on the page, nor in what the server sends`, !(await page.content()).includes(SECRET) && !(await (await fetch(`${BASE}/api/v1/connections`)).text()).includes(SECRET));
      await google.getByRole('button', { name: 'Add Calendar: sign in with Google' }).click();
      check(`${L}: the Google sign-in steps show`, await visible(google.getByRole('status', { name: 'Google sign-in' })));
      check(`${L}: …and it finishes`, await visible(google.getByText('Google is connected.'), 12_000) && await visible(google.locator('#google-line').getByText(/^Connected with Google sign-in/)));

      // Outlook: the code, and the sign-in finishing
      const outlook = section(main, 'Outlook');
      await outlook.getByRole('button', { name: 'Connect with a code' }).click();
      const card = outlook.getByRole('status', { name: 'Your sign-in code' });
      check(`${L}: the code card shows the code, the link and the time left`, await visible(card.getByText('QWER-TY12')) && await visible(card.getByRole('link', { name: 'microsoft.com/devicelogin' })) && await visible(card.getByText(/This code works for 15 more minutes/)));
      await shot(page, `${L}-03-outlook-code`);
      await axe(page, `${L} outlook code`);
      await noOverflow(page, `${L} outlook code`);
      check(`${L}: Outlook connects`, await visible(outlook.getByText('Outlook is connected.'), 12_000) && await visible(outlook.locator('#outlook-line').getByText(/^Connected: Outlook mail and calendar/)));
      await outlook.getByRole('button', { name: 'Disconnect', exact: true }).click();
      const oask = outlook.getByRole('region', { name: 'Disconnect Outlook?' });
      check(`${L}: Outlook disconnect says the calendar stops`, await visible(oask.getByText(/Outlook events leave Today and the Calendar/)));
      await oask.getByRole('button', { name: 'Disconnect Outlook' }).click();
      check(`${L}: Outlook disconnected`, await visible(outlook.getByText(/^Outlook disconnected\./)));
      // your own Microsoft app
      await outlook.getByRole('button', { name: 'Set up your own Microsoft app' }).click();
      const mapp = outlook.getByRole('form', { name: 'Set up your own Microsoft app' });
      check(`${L}: the redirect address is shown`, await visible(mapp.getByText('http://localhost:7798/oauth')));
      await mapp.getByLabel('Application (client) ID').fill('11111111-2222-3333-4444-555555555555');
      await mapp.getByRole('button', { name: 'Save', exact: true }).click();
      check(`${L}: Microsoft app saved`, await visible(outlook.getByText(/^Saved\. Now connect Outlook\./)));
      check(`${L}: …the browser-window sign-in is offered`, await visible(outlook.getByRole('button', { name: 'Sign in in a browser window' })));
      await axe(page, `${L} outlook`);

      // Telegram
      const tg = section(main, 'Telegram');
      await tg.getByRole('button', { name: 'Set up Telegram' }).click();
      const tform = tg.getByRole('form', { name: 'Connect Telegram' });
      check(`${L}: the bot token is a password field`, (await tform.getByLabel('Bot token').getAttribute('type')) === 'password');
      await tform.getByLabel('Bot token').fill('not a token');
      await tform.getByRole('button', { name: 'Check and save' }).click();
      check(`${L}: a wrong token is refused`, await visible(tform.getByText(/doesn’t look like a bot token/)));
      await tform.getByLabel('Bot token').fill(TOKEN);
      await tform.getByRole('button', { name: 'Check and save' }).click();
      check(`${L}: Telegram connected`, await visible(tg.getByText(/^Your bot @juniper_helper_bot works/)));
      check(`${L}: …the token is nowhere on the page`, !(await page.content()).includes(TOKEN));
      await tg.getByRole('button', { name: 'Disconnect', exact: true }).click();
      const task = tg.getByRole('region', { name: 'Disconnect Telegram?' });
      check(`${L}: Telegram disconnect says what stops`, await visible(task.getByText(/stop answering you on Telegram/)));
      await task.getByRole('button', { name: 'Disconnect Telegram' }).click();
      check(`${L}: Telegram disconnected`, await visible(tg.getByText('Telegram disconnected.')));

      // Tailscale
      const ts = section(main, 'Reach it from anywhere');
      check(`${L}: Tailscale says what it is and how it relates to the address for phones`, await visible(ts.getByText(/lets your phone reach a helper running in Docker or the cloud privately/)) && await visible(ts.locator('#tailscale-address').getByText(/Address for phones now:/)) && await visible(ts.getByText('https://mwa.tail1a2b.ts.net')));
      await ts.getByRole('button', { name: 'Change the key or name' }).click();
      const tsf = ts.getByRole('form', { name: 'Set up Tailscale' });
      check(`${L}: the auth key is a password field`, (await tsf.getByLabel('Auth key').getAttribute('type')) === 'password');
      await tsf.getByLabel('Auth key').fill('tskey-api-smoke');
      await tsf.getByRole('button', { name: 'Save', exact: true }).click();
      check(`${L}: an API token is refused`, await visible(tsf.getByText(/That’s a Tailscale API access token/)));
      await tsf.getByLabel('Auth key').fill(TS_KEY);
      await tsf.getByLabel(/^Name on your tailnet/).fill('barn');
      await tsf.getByRole('button', { name: 'Save', exact: true }).click();
      check(`${L}: Tailscale key saved, after a restart`, await visible(ts.getByText(/^Tailscale key saved\. It takes effect after your helper restarts/)) && await visible(ts.getByText(/Name on your tailnet: barn/)));
      // only the name, back to the default: the key may be left empty
      await ts.getByRole('button', { name: 'Change the key or name' }).click();
      check(`${L}: the name field shows the saved name`, (await tsf.getByLabel(/^Name on your tailnet/).inputValue()) === 'barn');
      await tsf.getByLabel(/^Name on your tailnet/).fill('');
      await tsf.getByRole('button', { name: 'Save', exact: true }).click();
      check(`${L}: the name cleared, key kept`, await visible(ts.getByText(/^Saved\. The name mwa \(the default\) takes effect after your helper restarts/)) && await visible(ts.getByText(/Name on your tailnet: mwa/)));
      check(`${L}: …the key is nowhere on the page`, !(await page.content()).includes(TS_KEY));
      await shot(page, `${L}-04-tailscale`);
      await axe(page, `${L} tailscale`);
      await noOverflow(page, `${L} tailscale`);
      await ts.getByRole('button', { name: 'Remove key' }).click();
      const tsask = ts.getByRole('region', { name: 'Remove the Tailscale key?' });
      check(`${L}: removing the key says what happens`, await visible(tsask.getByText(/leaves your tailnet/)));
      await tsask.getByRole('button', { name: 'Remove the Tailscale key' }).click();
      check(`${L}: key removed, after a restart`, await visible(ts.getByText(/^Tailscale key removed\. It takes effect after a restart/)));
      await ts.getByRole('button', { name: /^Address for phones/ }).click();
      check(`${L}: Address for phones goes to Settings › Your helper`, await visible(main.getByRole('heading', { name: 'Settings', level: 1 })) && await visible(main.getByRole('heading', { name: 'Your helper', level: 2 })));
      await page.waitForTimeout(300);
      check(`${L}: …scrolled to it`, await main.getByRole('heading', { name: 'Your helper', level: 2 }).evaluate((h) => { const r = h.getBoundingClientRect(); return r.top >= -2 && r.top < window.innerHeight; }));
      // back to Connections, then Back lands on the Connected list
      await main.locator('#open-connections').click();
      await visible(main.getByRole('heading', { name: 'Connections', level: 1 }));
      await main.getByRole('button', { name: 'Settings' }).first().click();
      check(`${L}: Back goes to Settings`, await visible(main.getByRole('heading', { name: 'Settings', level: 1 })));
      check(`${L}: computer: never the classic app`, !page.url().includes('ui=v1'));
      check(`${L}: computer: no page errors`, !errors.length, errors.join(' | '));
      await ctx.close();
    }

    // 1b. the Settings list's Connect Outlook: Close on the code card cancels the sign-in on the server too
    {
      const { ctx, page, errors } = await open(vp, '/?ui=v2&view=settings', 'N00');
      const main = page.locator('#main');
      const cancels = [];
      page.on('request', (r) => { if (r.method() === 'POST' && /\/api\/v1\/accounts\/outlook\/cancel$/.test(r.url())) cancels.push(r.url()); });
      await main.getByRole('button', { name: 'Connect Outlook' }).click();
      const steps = main.locator('.connectsteps');
      check(`${L}: Settings list: the Outlook code card shows`, await visible(steps.getByText('QWER-TY12')));
      await steps.getByRole('button', { name: 'Close' }).click();
      check(`${L}: Close hides the card`, await gone(steps));
      await page.waitForTimeout(300);
      check(`${L}: …and cancels the sign-in on the server`, cancels.length === 1, String(cancels.length));
      check(`${L}: close-cancel: no page errors`, !errors.length, errors.join(' | '));
      await ctx.close();
    }

    // 2. Today's Reconnect lands on Connections at Google (not the classic app)
    {
      const { ctx, page, errors } = await open(vp, '/?ui=v2', 'reconnect');
      const main = page.locator('#main');
      const btn = main.getByRole('button', { name: 'Reconnect' });
      check(`${L}: Today offers Reconnect`, await visible(btn));
      await btn.first().click();
      check(`${L}: Reconnect opens Connections`, await visible(main.getByRole('heading', { name: 'Connections', level: 1 })));
      await page.waitForTimeout(300);
      check(`${L}: …at Google (focused)`, (await focusedHeading(page)) === 'Google', String(await focusedHeading(page)));
      check(`${L}: …which says the sign-in stopped working and offers Reconnect`, await visible(section(main, 'Google').getByText(/stopped working/)) && await visible(section(main, 'Google').getByRole('button', { name: 'Reconnect' })));
      check(`${L}: …and stayed in the new app`, !page.url().includes('ui=v1'));
      await axe(page, `${L} reconnect`);
      check(`${L}: reconnect: no page errors`, !errors.length, errors.join(' | '));
      await ctx.close();
    }

    // 3. the Calendar's Connect a calendar lands on Connections
    {
      const { ctx, page, errors } = await open(vp, '/?ui=v2&view=calendar', 'not-connected');
      const main = page.locator('#main');
      const btn = main.getByRole('button', { name: 'Connect a calendar' });
      check(`${L}: the Calendar offers to connect`, await visible(btn));
      await btn.click();
      check(`${L}: Connect a calendar opens Connections`, await visible(main.getByRole('heading', { name: 'Connections', level: 1 })) && !page.url().includes('ui=v1'));
      check(`${L}: …where Google can sign in`, await visible(section(main, 'Google').getByRole('button', { name: 'Sign in with Google' })));
      check(`${L}: calendar connect: no page errors`, !errors.length, errors.join(' | '));
      await ctx.close();
    }

    // 4. nothing set up: the Settings list's "Set up Google" lands at Google; Outlook says it needs an app
    {
      const { ctx, page, errors } = await open(vp, '/?ui=v2&view=settings', 'conn-setup');
      const main = page.locator('#main');
      await main.getByRole('button', { name: 'Set up Google' }).click();
      check(`${L}: Set up Google opens Connections`, await visible(main.getByRole('heading', { name: 'Connections', level: 1 })));
      await page.waitForTimeout(300);
      check(`${L}: …at Google (focused)`, (await focusedHeading(page)) === 'Google', String(await focusedHeading(page)));
      check(`${L}: …with the app password first`, await visible(section(main, 'Google').getByRole('button', { name: 'Use an app password' })));
      check(`${L}: Outlook says it needs your own app first`, await visible(section(main, 'Outlook').getByText('Outlook needs your own Microsoft app first (a one-time setup, below).')));
      await axe(page, `${L} setup`);
      check(`${L}: setup: no page errors`, !errors.length, errors.join(' | '));
      await ctx.close();
    }

    // 5. on a server: the browser sign-in says why it can't work; the code still does
    {
      const { ctx, page, errors } = await open(vp, '/?ui=v2&view=connections&at=outlook', 'hosted');
      const main = page.locator('#main');
      check(`${L}: hosted: Connections`, await visible(main.getByRole('heading', { name: 'Connections', level: 1 })));
      await page.waitForTimeout(300);
      check(`${L}: hosted: ?at=outlook lands at Outlook`, (await focusedHeading(page)) === 'Outlook', String(await focusedHeading(page)));
      const google = section(main, 'Google');
      check(`${L}: hosted: Google sign-in can't work on the server`, await visible(google.getByText(/can’t be used on your Railway server/)) && !(await google.getByRole('button', { name: /Set up Google sign-in|Sign in with Google/ }).count()));
      check(`${L}: hosted: Gmail connected with an app password`, await visible(google.getByText(/app password \(robert@gmail\.com\)/)));
      check(`${L}: hosted: Outlook's code is offered, not the browser window`, await visible(section(main, 'Outlook').getByRole('button', { name: 'Connect with a code' })) && !(await section(main, 'Outlook').getByRole('button', { name: 'Sign in in a browser window' }).count()));
      await shot(page, `${L}-05-hosted`, true);
      await axe(page, `${L} hosted`);
      check(`${L}: hosted: no page errors`, !errors.length, errors.join(' | '));
      await ctx.close();
    }

    // 6. a paired phone: read-only
    {
      const { ctx, page, errors } = await open(vp, '/?ui=v2&view=connections', 'phone');
      const main = page.locator('#main');
      check(`${L}: phone: Connections`, await visible(main.getByRole('heading', { name: 'Connections', level: 1 })));
      check(`${L}: phone: says where to change it`, await visible(main.getByRole('note').getByText(/can see what’s connected but not change it/)));
      check(`${L}: phone: no fields and no change buttons`, !(await main.locator('input, select').count()) && !(await main.getByRole('button', { name: /^(Disconnect|Connect|Set up|Use an|Replace|Remove|Sign in|Reconnect|Add Calendar)/ }).count()));
      check(`${L}: phone: what's connected is still shown`, await visible(main.getByText(/^Connected with Google sign-in/)) && await visible(main.getByText(/^Key saved\./)));
      await shot(page, `${L}-06-phone`, true);
      await axe(page, `${L} phone`);
      await noOverflow(page, `${L} phone`);
      check(`${L}: phone: no page errors`, !errors.length, errors.join(' | '));
      await ctx.close();
    }

    // 7. dark mode
    {
      const { ctx, page, errors } = await open(vp, '/?ui=v2&view=connections&theme=dark', 'N00');
      const main = page.locator('#main');
      await visible(main.getByRole('heading', { name: 'Connections', level: 1 }));
      await section(main, 'Google').getByRole('button', { name: 'Disconnect', exact: true }).click();
      await shot(page, `${L}-07-dark`, true);
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
