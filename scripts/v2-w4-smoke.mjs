#!/usr/bin/env node
/**
 * v2 build, slice W4: a Playwright smoke run of the Projects screens and the Ask flow against the BUILT UI in
 * fixture mode (the same pattern as scripts/v2-web-smoke.mjs).
 *
 *   npm run build:ui
 *   node scripts/v2-w4-smoke.mjs [--out <dir>] [--axe <path to axe.min.js>] [--port 4198]
 *
 * At 390×844 and 1440×900 (in-browser fixtures, `?fixtures=1`, unless noted):
 *   1. the Ask sheet: typing shows "To: Family & school · suggested"; Change picks Eventing and the person's choice wins;
 *   2. N04: two PDFs + "learn everything from these two PDFs" → the plan card ("This is a big read — 149 pages…",
 *      "Do it now · about 40¢", "In the background · about 15¢ · ready around 10:10 AM"); Or narrow it… (the
 *      server's labels) and back; Details → "Stop if it costs more than $" 0.30 → 0.50 → In the background →
 *      "I’ll let you know · ready around 10:10 AM · stops at $0.50" → the working sheet shows the job;
 *   3. an old plan: "This plan is old — ask again" with Ask again;
 *   4. Projects › Family & school: provenance "using what I know from Eventing", the "About" chip; move a message to
 *      Eventing and Undo; the composer's answer arrives live; Stop on a running answer;
 *   5. Work tab: "Ask about this" on a job → "What has it cost?" → "4¢ so far." in place; Files tab;
 *   6. New project, rename, archive, restore; paging ("Earlier messages", scenario thread-long);
 *   7. through the Vite middleware (`?ui=v2`): a message sent offline waits ("Waiting to send.") and is answered once
 *      back online;
 * and on every screen: axe 0 violations, nothing scrolls sideways, no page errors. Screenshots go to --out.
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('out', join(ROOT, 'reports', 'v2-w4-smoke'));
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

// two example PDFs to attach (fixture mode counts them by name: 76 and 73 pages)
const FILES = join(OUT, 'files');
mkdirSync(FILES, { recursive: true });
for (const n of ['icp-eventing-handbook.pdf', 'usef-eventing-rules-2025.pdf']) writeFileSync(join(FILES, n), '%PDF-1.4\n% example file for the W4 smoke run\n');

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
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth, d: document.querySelector('dialog[open]') ? Math.max(...[...document.querySelectorAll('dialog[open] *')].map((e) => e.getBoundingClientRect().right)) : 0 }));
  check(`${label}: no horizontal overflow`, o.sw <= o.w && o.d <= o.w + 1, `${o.sw} / dialog ${Math.round(o.d)} > ${o.w}`);
}
const shot = (page, name) => page.screenshot({ path: join(OUT, `${name}.png`) });
const seen = (loc, timeout = 8_000) => loc.first().waitFor({ state: 'visible', timeout }).then(() => true, () => false);

async function openAsk(page) {
  await page.getByRole('button', { name: 'Ask, or hand over a job' }).first().click();
  const ask = page.locator('#ask-dlg');
  await ask.waitFor({ state: 'visible' });
  return ask;
}
async function closeSheet(page, sel) { await page.locator(sel).getByRole('button', { name: 'Close' }).first().click(); await page.locator(sel).waitFor({ state: 'hidden' }); }
async function tab(page, vp, name) { await page.locator(vp.mobile ? '#tabbar' : '#topbar').getByRole('button', { name, exact: true }).click(); }

// ---------- the run ----------
const browser = await chromium.launch();
const VIEWPORTS = [{ name: 'm390', width: 390, height: 844, mobile: true }, { name: 'd1440', width: 1440, height: 900, mobile: false }];

try {
  for (const vp of VIEWPORTS) {
    const L = vp.name;
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.mobile ? 2 : 1, hasTouch: vp.mobile, isMobile: vp.mobile });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${BASE}/?fixtures=1&scenario=N00`);
    check(`${L}: the app is up ("Working on 1 thing")`, await seen(page.getByRole('button', { name: 'Working on 1 thing' }), 15_000));

    // 1. the Ask sheet: where it goes, while typing; the person's choice wins
    let ask = await openAsk(page);
    check(`${L}: Ask sheet has the prototype's names`, await seen(ask.getByRole('textbox', { name: 'Message your helper' })) && await seen(ask.getByRole('button', { name: 'Hold to talk' })) && await seen(ask.getByRole('button', { name: 'Add files' })));
    await ask.getByRole('textbox', { name: 'Message your helper' }).fill('Can Riley go to the book fair on Saturday?');
    const sug = await seen(ask.locator('#ask-route').filter({ hasText: 'To: Family & school · suggested' }));
    check(`${L}: typing suggests "To: Family & school · suggested"`, sug, await ask.locator('#ask-route').textContent().catch(() => ''));
    await page.waitForTimeout(250);
    await shot(page, `${L}-01-ask-suggested`);
    await axe(page, `${L} ask sheet (suggested)`);
    await noOverflow(page, `${L} ask sheet`);
    await ask.locator('#ask-route').getByRole('button', { name: /Change where this goes/ }).click();
    await ask.getByRole('combobox', { name: 'To:' }).selectOption({ label: 'Eventing' });
    const routeWords = () => ask.locator('#ask-route > span').first().textContent().then((t) => t?.trim());
    check(`${L}: the person's choice wins ("To: Eventing")`, await seen(ask.locator('#ask-route > span').filter({ hasText: /^To: Eventing$/ })), await routeWords());
    await ask.getByRole('textbox', { name: 'Message your helper' }).fill('Can Riley go to the book fair on Saturday? Riley Riley school');
    await page.waitForTimeout(700);
    check(`${L}: a suggestion made after the choice does not replace it`, (await routeWords()) === 'To: Eventing', await routeWords());
    await ask.getByRole('button', { name: 'Send' }).click();
    check(`${L}: the answer arrives (followed live) in the chosen project`, await seen(ask.getByText('here, in Eventing', { exact: false }), 10_000) && await seen(ask.locator('.routeto').filter({ hasText: 'To: Eventing' })));
    await closeSheet(page, '#ask-dlg');

    // 2. N04: the big read
    ask = await openAsk(page);
    await ask.locator('#ask-file').setInputFiles([join(FILES, 'icp-eventing-handbook.pdf'), join(FILES, 'usef-eventing-rules-2025.pdf')]);
    check(`${L}: the two files are attached`, await seen(ask.locator('.filechip').filter({ hasText: 'usef-eventing-rules-2025.pdf' })) && (await ask.locator('.filechip').count()) === 2);
    await ask.getByRole('textbox', { name: 'Message your helper' }).fill('learn everything from these two PDFs');
    await shot(page, `${L}-02-ask-files`);
    await ask.getByRole('button', { name: 'Send' }).click();
    const planMsg = 'This is a big read — 149 pages, about 20 minutes. Do it now, or in the background for less and I’ll tell you when it’s done?';
    check(`${L}: N04 plan message`, await seen(ask.getByText(planMsg)));
    const nowBtn = ask.getByRole('button', { name: 'Do it now · about 40¢' });
    const bgBtn = ask.getByRole('button', { name: 'In the background · about 15¢ · ready around 10:10 AM' });
    check(`${L}: N04 both choices with price and time (local)`, await nowBtn.isVisible() && await bgBtn.isVisible());
    check(`${L}: one decision at a time (the text box waits)`, !(await ask.locator('#ask-form').isVisible()));
    await page.waitForTimeout(250);
    await shot(page, `${L}-03-plan`);
    await axe(page, `${L} plan card`);
    await noOverflow(page, `${L} plan card`);
    await ask.getByRole('button', { name: 'Or narrow it…' }).click();
    const narrow = ['Only icp eventing handbook · 76 pages, about 8¢', 'Only usef eventing rules 2025 · 73 pages, about 8¢', 'Just the rules for moving up a level'];
    let allNarrow = true;
    for (const n of narrow) allNarrow = allNarrow && await ask.getByRole('button', { name: n }).isVisible();
    check(`${L}: Or narrow it… lists the server's narrower asks`, allNarrow);
    await shot(page, `${L}-04-narrow`);
    await axe(page, `${L} narrow`);
    await ask.getByRole('button', { name: 'Back to the full read' }).click();
    await ask.getByRole('button', { name: 'Details' }).click();
    const limit = ask.getByRole('spinbutton', { name: 'Stop if it costs more than $' });
    check(`${L}: Details: "Stop if it costs more than $" 0.30`, (await limit.inputValue()) === '0.30');
    check(`${L}: Details: the size`, await seen(ask.getByText('Size: 149 pages')));
    await limit.fill('25');
    check(`${L}: a limit over $20 is refused in plain words`, await seen(ask.getByText('The most is $20.')));
    await limit.fill('0.50');
    await shot(page, `${L}-05-details`);
    await axe(page, `${L} details`);
    await ask.getByRole('button', { name: /^In the background/ }).click();
    check(`${L}: background → "I’ll let you know · ready around 10:10 AM · stops at $0.50"`, await seen(ask.getByText('I’ll let you know · ready around 10:10 AM · stops at $0.50')));
    check(`${L}: "You chose: In the background…"`, await seen(ask.getByText(/^You chose: In the background/)));
    await page.waitForTimeout(200);
    await shot(page, `${L}-06-background`);
    await ask.getByRole('button', { name: 'See what I’m working on' }).click();
    const work = page.locator('#work-dlg');
    await work.waitFor({ state: 'visible' });
    const job = work.getByRole('article', { name: 'Learning your 2 eventing PDFs' });
    check(`${L}: the job is in the working sheet`, await seen(job));
    check(`${L}: … with its limit (stops at $0.50)`, await seen(job.getByText('stops at $0.50', { exact: false })));
    check(`${L}: the pill counts it ("Working on 2 things")`, await seen(page.getByRole('button', { name: 'Working on 2 things' })));
    await page.waitForTimeout(300);
    await shot(page, `${L}-07-working-sheet`);
    await closeSheet(page, '#work-dlg');

    // 3. an old plan
    ask = await openAsk(page);
    await ask.getByRole('textbox', { name: 'Message your helper' }).fill('[old] go through all my newsletters');
    await ask.getByRole('button', { name: 'Send' }).click();
    const guess = ask.getByRole('button', { name: 'Do it now · a first guess, about 60¢' });
    check(`${L}: a plan without files says "a first guess"`, await seen(guess));
    await guess.click();
    check(`${L}: 410 → "This plan is old — ask again." with Ask again`, await seen(ask.getByText('This plan is old — ask again.')) && await ask.getByRole('button', { name: 'Ask again' }).isVisible());
    await shot(page, `${L}-08-expired`);
    await ask.getByRole('button', { name: 'Ask again' }).click();
    check(`${L}: Ask again puts the words back`, (await ask.getByRole('textbox', { name: 'Message your helper' }).inputValue()) === '[old] go through all my newsletters');
    await closeSheet(page, '#ask-dlg');

    // 4. a project's thread
    await tab(page, vp, 'Projects');
    check(`${L}: Projects list shows what each is doing`, await seen(page.getByRole('button', { name: /AI newsletter.*Working: gathering this week’s AI news/ })));
    await shot(page, `${L}-09-projects`);
    await axe(page, `${L} projects list`);
    await noOverflow(page, `${L} projects list`);
    await page.getByRole('button', { name: /^Family & school/ }).click();
    check(`${L}: Family & school opens`, await seen(page.locator('#main h1').filter({ hasText: 'Family & school' })));
    check(`${L}: provenance "using what I know from Eventing"`, await seen(page.locator('#main').getByText('using what I know from Eventing').first()));
    check(`${L}: an item-scoped question shows its About chip`, await seen(page.locator('#main .turnabout')));
    await page.waitForTimeout(200);
    await shot(page, `${L}-10-thread`);
    await axe(page, `${L} thread`);
    await noOverflow(page, `${L} thread`);
    // move a message to Eventing, then Undo
    const libq = 'Can Riley go on the Saturday morning library trip?';
    await page.locator('#main').getByRole('button', { name: `Move to another project: ${libq}` }).click();
    await page.locator('#main').getByRole('menu', { name: 'Move to' }).getByRole('menuitem', { name: 'Eventing' }).click();
    check(`${L}: moved: "Moved to Eventing." and it leaves this thread`, await seen(page.locator('.movednote').filter({ hasText: 'Moved to Eventing.' })) && await page.locator('#main').getByText(libq).count() === 0);
    await shot(page, `${L}-11-moved`);
    await page.locator('.movednote').getByRole('button', { name: 'Undo' }).click();
    check(`${L}: Undo moves it back`, await seen(page.locator('#main').getByText(libq)));
    // the composer: an answer followed live, then Stop on another
    const composer = page.locator('#main').getByRole('textbox', { name: 'Message Family & school' });
    await composer.fill('What’s coming up for Riley?');
    await page.locator('#main').getByRole('button', { name: 'Send to Family & school' }).click();
    const runningSeen = await seen(page.locator('#main .liveans'), 3_000);
    check(`${L}: the composer's answer arrives live`, runningSeen && await seen(page.locator('#main').getByText('here, in Family & school', { exact: false }).last(), 10_000));
    await composer.fill('Find a babysitter for Friday');
    await page.locator('#main').getByRole('button', { name: 'Send to Family & school' }).click();
    const stopBtn = page.locator('#main .liveans').getByRole('button', { name: 'Stop' });
    if (await seen(stopBtn, 2_000)) {
      await shot(page, `${L}-12-running`);
      await stopBtn.click();
      check(`${L}: Stop on the running answer`, await seen(page.locator('#main').getByText('Stopped by you.', { exact: false }), 8_000));
    } else check(`${L}: Stop on the running answer`, false, 'the running answer was not seen');

    // 5. the Work tab and "Ask about this" in place; the Files tab
    if (vp.mobile) await page.locator('#main').getByRole('button', { name: 'Projects' }).first().click();
    await page.getByRole('button', { name: /^AI newsletter/ }).click();
    await page.locator('#main').getByRole('tab', { name: 'Work' }).click();
    const news = page.locator('#main').getByRole('article', { name: 'Gathering this week’s AI news' });
    check(`${L}: Work tab lists the project's job with its action`, await seen(news) && await seen(news.getByRole('button', { name: 'Stop' })));
    await news.getByRole('button', { name: 'Ask about this' }).click();
    check(`${L}: Ask about this: the chip and the job's questions`, await seen(news.getByText('About: Gathering this week’s AI news')) && await seen(news.getByRole('button', { name: 'What has it cost?' })));
    await news.getByRole('button', { name: 'What has it cost?' }).click();
    check(`${L}: the answer appears in place under "You asked": "4¢ so far."`, await seen(news.getByRole('heading', { name: 'You asked' })) && await seen(news.locator('.qa').getByText('4¢ so far.'), 10_000));
    await page.waitForTimeout(200);
    await shot(page, `${L}-13-work-askabout`);
    await axe(page, `${L} work tab`);
    await page.locator('#main').getByRole('tab', { name: 'Files' }).click();
    check(`${L}: Files tab lists the project's files`, await seen(page.locator('#main').getByText('candidates-week45.md')));
    await shot(page, `${L}-14-files`);
    await axe(page, `${L} files tab`);

    // 6. create, rename, archive, restore
    if (vp.mobile) await page.locator('#main').getByRole('button', { name: 'Projects' }).first().click();
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByRole('textbox', { name: 'New project' }).fill('Garden club');
    await shot(page, `${L}-15-new-project`);
    await axe(page, `${L} new project form`);
    await page.getByRole('button', { name: 'Create' }).click();
    check(`${L}: a new project opens`, await seen(page.locator('#main h1').filter({ hasText: 'Garden club' })));
    await page.locator('#main').getByRole('button', { name: 'Project options' }).click();
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    await page.getByRole('textbox', { name: 'New name for Garden club' }).fill('Garden & allotment');
    await page.getByRole('button', { name: 'Save' }).click();
    check(`${L}: renamed`, await seen(page.locator('#main h1').filter({ hasText: 'Garden & allotment' })));
    await page.locator('#main').getByRole('button', { name: 'Project options' }).click();
    await page.getByRole('menuitem', { name: 'Archive' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Archive' }).click();
    check(`${L}: archived: it leaves the list ("Archived · 1")`, await seen(page.getByRole('button', { name: 'Archived · 1' })) && await page.getByRole('button', { name: /^Garden & allotment/ }).count() === 0);
    await page.getByRole('button', { name: 'Archived · 1' }).click();
    await page.getByRole('button', { name: 'Restore Garden & allotment' }).click();
    check(`${L}: restored`, await seen(page.getByRole('button', { name: /^Garden & allotment/ })));
    check(`${L}: no page errors`, errors.length === 0, errors.join(' | '));
    await ctx.close();

    // paging: a long thread
    const c2 = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.mobile ? 2 : 1, hasTouch: vp.mobile, isMobile: vp.mobile });
    const p2 = await c2.newPage();
    await p2.goto(`${BASE}/?fixtures=1&scenario=thread-long&view=projects&project=eventing`);
    const earlier = p2.getByRole('button', { name: 'Earlier messages' });
    check(`${L}: a long thread offers "Earlier messages"`, await seen(earlier, 15_000));
    const before = await p2.locator('#main .turn').count();
    await earlier.click();
    await p2.waitForFunction((n) => document.querySelectorAll('#main .turn').length > n, before, { timeout: 8_000 }).catch(() => {});
    const after = await p2.locator('#main .turn').count();
    check(`${L}: … and loads the page before (${before} → ${after})`, after > before);
    await earlier.click();
    await p2.waitForTimeout(600);
    check(`${L}: … until the start of the thread`, await p2.getByRole('button', { name: 'Earlier messages' }).count() === 0 && await seen(p2.locator('#main .msg-you').filter({ hasText: /Old question 1$/ })));
    await shot(p2, `${L}-16-earlier`);
    await c2.close();

    // dark: a thread and the plan card
    const cd = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.mobile ? 2 : 1, hasTouch: vp.mobile, isMobile: vp.mobile });
    const pd = await cd.newPage();
    await pd.goto(`${BASE}/?fixtures=1&scenario=N00&theme=dark&view=projects&project=family`);
    await seen(pd.locator('#main').getByText('using what I know from Eventing'), 15_000);
    await pd.waitForTimeout(300);
    await shot(pd, `${L}-dark-thread`);
    await axe(pd, `${L} dark thread`);
    const askD = await openAsk(pd);
    await askD.locator('#ask-file').setInputFiles([join(FILES, 'icp-eventing-handbook.pdf'), join(FILES, 'usef-eventing-rules-2025.pdf')]);
    await askD.getByRole('textbox', { name: 'Message your helper' }).fill('learn everything from these two PDFs');
    await askD.getByRole('button', { name: 'Send' }).click();
    await seen(askD.getByRole('button', { name: 'Details' }));
    await askD.getByRole('button', { name: 'Details' }).click();
    await pd.waitForTimeout(300);
    await shot(pd, `${L}-dark-plan`);
    await axe(pd, `${L} dark plan card`);
    await cd.close();

    // 7. the middleware: a message sent offline waits and is answered back online
    await reset('N00');
    const c3 = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.mobile ? 2 : 1, hasTouch: vp.mobile, isMobile: vp.mobile });
    const p3 = await c3.newPage();
    await p3.goto(`${BASE}/?ui=v2&view=projects&project=health`);
    const box = p3.locator('#main').getByRole('textbox', { name: 'Message Health' });
    await box.waitFor({ timeout: 15_000 });
    await seen(p3.locator('#main').getByText('Nothing said here yet', { exact: false }), 8_000);
    await c3.setOffline(true);
    await p3.waitForTimeout(300);
    await box.fill('When is my next checkup?');
    await p3.locator('#main').getByRole('button', { name: 'Send to Health' }).click();
    check(`${L}: offline: the message waits ("Waiting to send.")`, await seen(p3.locator('#main').getByText('Waiting to send.', { exact: false })));
    await shot(p3, `${L}-17-offline`);
    await c3.setOffline(false);
    check(`${L}: back online, it is sent and answered`, await seen(p3.locator('#main').getByText('“When is my next checkup?” here, in Health', { exact: false }), 20_000));
    const asks = await (await fetch(`${BASE}/api/v1/projects/health/thread`, { headers: { 'x-mwa-client': 'web/1.0.0' } })).json();
    check(`${L}: the server got it once`, asks.turns.filter((t) => t.message === 'When is my next checkup?').length === 1, JSON.stringify(asks.turns.map((t) => t.message)));
    await c3.close();
  }
} finally {
  await browser.close();
  stopVite();
}
writeFileSync(join(OUT, 'results.json'), JSON.stringify({ at: new Date().toISOString(), failed, results }, null, 2));
console.log(`\n${results.length - failed}/${results.length} checks passed · screenshots in ${OUT}`);
process.exit(failed ? 1 : 0);
