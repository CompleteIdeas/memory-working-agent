#!/usr/bin/env node
/**
 * v2 build, slice S4: a Playwright run of approvals in the new app against the BUILT UI in fixture mode (scenario
 * `approvals`, web/src/v2/dev/fixtures-approvals.ts), at 360×740, 390×844 and 1440×900 (same pattern as
 * scripts/v2-s3-smoke.mjs).
 *
 *   npm run build:ui
 *   node scripts/v2-s4-smoke.mjs [--out <dir>] [--axe <path to axe.min.js>] [--port 4199]
 *
 * It checks:
 *   1. Today: "2 things need your OK" (never the phishing one) → Review opens the approval sheet in place (the page
 *      stays the v2 app: no ?ui=v1), listing the three waiting, the phishing one marked
 *   2. a normal one (Replace weekly-report.md, for the job "Write the weekly report"): what happens, the file's text on
 *      demand, the reviewer's opinion, no confirm step; Approve → "Done. It ran." → Done closes; the job is no longer
 *      waiting; deciding it again is impossible (the sheet shows the outcome)
 *   3. a high-risk one (Delete old-drafts, after outside content): the red warnings; Approve asks "Are you sure?" (the
 *      focus moves to it) — a fast double click on Approve does not approve; Go back; Not this time with a note
 *      → "OK — it won't run"; no Next (the phishing one is never offered)
 *   4. the phishing one: the alert first ("Warning: this may be a phishing trick"), confirm step, Not this time
 *   5. the working sheet (the pill): "Needs your OK" group and a waiting job's Review open the right approval
 *   6. Important: the phishing approval's Review opens it in the sheet
 *   7. a tapped notification (#/approval/ap_clean) opens that approval
 *   8. dark mode; axe 0 violations, no horizontal overflow, no page errors at each step
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('out', join(ROOT, 'reports', 'v2-s4-smoke'));
const AXE = arg('axe', process.env.AXE_PATH ?? '');
const PORT = Number(arg('port', '4199'));
const BASE = `http://localhost:${PORT}`;
mkdirSync(OUT, { recursive: true });
if (!existsSync(join(ROOT, 'dist-ui', 'index.html'))) { console.error('Build the UI first: npm run build:ui'); process.exit(2); }
const axeSrc = AXE && existsSync(AXE) ? readFileSync(AXE, 'utf8') : null;
if (!axeSrc) console.warn('! no axe-core given (--axe): accessibility checks are skipped');

const results = [];
let failed = 0;
function check(name, ok, detail = '') { results.push({ name, ok: !!ok, detail: String(detail ?? '') }); if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`); }

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
const H = { 'x-mwa-client': 'web/1.0.0' };
const api = async (path) => (await fetch(`${BASE}/api/v1${path}`, { headers: H })).json();

// ---------- helpers ----------
async function axe(page, label, include) {
  if (!axeSrc) return;
  await page.addScriptTag({ content: axeSrc }).catch(() => {});
  const v = await page.evaluate(async (sel) => {
    const r = await window.axe.run(sel ? { include: [sel] } : document, { resultTypes: ['violations'] });
    return r.violations.map((x) => `${x.id} (${x.impact}): ${x.nodes.length} × ${x.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' | ')}`);
  }, include ?? null);
  check(`${label}: axe 0 violations`, v.length === 0, v.join('; '));
}
async function noOverflow(page, label) {
  const o = await page.evaluate(() => {
    const d = document.querySelector('#approval-dlg[open]');
    return { sw: document.documentElement.scrollWidth, w: window.innerWidth, dw: d ? d.scrollWidth : 0, dc: d ? d.clientWidth : 0 };
  });
  check(`${label}: no horizontal overflow`, o.sw <= o.w && o.dw <= o.dc + 1, JSON.stringify(o));
}
const shot = async (page, name, full = false) => { await page.waitForTimeout(350); await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: full }); };
const visible = (loc, ms = 8_000) => loc.first().waitFor({ state: 'visible', timeout: ms }).then(() => true, () => false);
const hidden = (loc, ms = 6_000) => loc.first().waitFor({ state: 'hidden', timeout: ms }).then(() => true, () => false);
const focusedText = (page) => page.evaluate(() => document.activeElement?.textContent ?? '');

const browser = await chromium.launch();
const VIEWPORTS = [
  { name: 'm360', width: 360, height: 740, mobile: true },
  { name: 'm390', width: 390, height: 844, mobile: true },
  { name: 'd1440', width: 1440, height: 900, mobile: false },
];
async function open(vp, url, scenario = 'approvals') {
  await reset(scenario);
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.mobile ? 2 : 1, hasTouch: vp.mobile, isMobile: vp.mobile });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}${url}`);
  return { ctx, page, errors };
}
const sheet = (page) => page.locator('#approval-dlg');

try {
  for (const vp of VIEWPORTS) {
    const L = vp.name;

    // 1–4. from Today: the list, a normal one, a high-risk one, the phishing one
    {
      const { ctx, page, errors } = await open(vp, '/?ui=v2');
      const main = page.locator('#main');
      const needs = main.locator('section:has(#sh-needs)');
      check(`${L}: Today: "2 things need your OK" in Needs you`, await visible(needs.getByText('2 things need your OK')));
      check(`${L}: Today: the phishing one is never a Needs-you card`, (await needs.getByText('contacts.csv').count()) === 0);
      await shot(page, `${L}-01-today`);
      await needs.locator('.needcard', { hasText: '2 things need your OK' }).getByRole('button', { name: 'Review' }).click();
      const dlg = sheet(page);
      check(`${L}: Review opens the approval sheet in place`, await visible(dlg.getByRole('heading', { name: 'Needs your OK', level: 2 })));
      check(`${L}: …in the new app (no hand-off to the classic app)`, !/ui=v1/.test(page.url()), page.url());
      check(`${L}: the list: yours, two waiting`, await visible(dlg.getByRole('heading', { name: 'Waiting for your OK · 2' })));
      check(`${L}: the list: the phishing one is not listed (only behind Important's warning)`, (await dlg.getByText('contacts.csv').count()) === 0);
      check(`${L}: the list: someone else's apart, "From others · 1"`, await visible(dlg.getByRole('heading', { name: 'From others · 1' })));
      check(`${L}: the list says what was decided today`, await visible(dlg.getByText(/Save a standing preference/)));
      await shot(page, `${L}-02-list`);
      await axe(page, `${L} list`, '#approval-dlg');
      await noOverflow(page, `${L} list`);

      // 2. the normal one
      await dlg.getByRole('button', { name: /Replace weekly-report\.md/ }).click();
      const ap = dlg.locator('article.ap[data-approval="ap_report"]');
      check(`${L}: report: what will happen`, await visible(ap.getByRole('heading', { name: 'Replace weekly-report.md', level: 3 })));
      check(`${L}: report: for its job`, await visible(ap.getByText('Your helper asks, for the job “Write the weekly report”')));
      check(`${L}: report: to what and where`, await visible(ap.getByText('Reports (a folder you granted)')) && await visible(ap.getByText('weekly-report.md is written there, replacing what it holds now.')));
      check(`${L}: report: the reviewer's opinion`, await visible(ap.getByText(/MWA’s reviewer would have let this run/)));
      check(`${L}: report: no red warning for an ordinary write`, (await ap.locator('.ap-risks.high').count()) === 0);
      await ap.getByText('What it will write').click();
      check(`${L}: report: the text it will write, on demand`, await visible(ap.getByText(/Entries for Saturday’s schooling are in/)));
      check(`${L}: report: how long it waits`, await visible(ap.getByText(/^It waits for you until/)));
      const approveBtn = ap.getByRole('button', { name: 'Approve', exact: true });
      const box = await approveBtn.boundingBox();
      check(`${L}: report: Approve is big (≥ 48 px tall)`, (box?.height ?? 0) >= 48, JSON.stringify(box));
      await shot(page, `${L}-03-report`, false);
      await axe(page, `${L} report`, '#approval-dlg');
      await noOverflow(page, `${L} report`);
      await approveBtn.click();
      check(`${L}: report: no confirm step for a normal one; "Done. It ran."`, await visible(ap.getByText('Done. It ran.')));
      check(`${L}: report: the focus moves to the outcome`, (await focusedText(page)) === 'Done. It ran.', await focusedText(page));
      check(`${L}: report: the decision buttons are gone`, (await ap.getByRole('button', { name: 'Approve', exact: true }).count()) === 0);
      check(`${L}: report: the server has it done`, (await api('/approvals/ap_report')).approval.state === 'done');
      check(`${L}: report: Next offers the next one waiting`, await visible(ap.getByRole('button', { name: /^Next: / })));
      await shot(page, `${L}-04-report-done`);
      await ap.getByRole('button', { name: 'Done' }).click();
      check(`${L}: Done closes the sheet, back on Today`, await hidden(dlg) && await visible(main.getByRole('heading', { level: 1 })));
      check(`${L}: Today now counts one`, await visible(needs.getByText('Delete old-drafts')));

      // 3. the high-risk one, from Today's card (now a single approval: it opens that one)
      await needs.locator('.needcard', { hasText: 'Delete old-drafts' }).getByRole('button', { name: 'Review' }).click();
      const cl = dlg.locator('article.ap[data-approval="ap_clean"]');
      check(`${L}: clean: opens that one directly`, await visible(cl.getByRole('heading', { name: 'Delete old-drafts', level: 3 })));
      const reds = cl.locator('.ap-risks.high li');
      check(`${L}: clean: the red warnings (outside content, deletes, outside its folder)`, (await reds.count()) === 3 && await visible(reds.getByText(/deletes something/)), String(await reds.count()));
      await cl.getByText('The exact action').click();
      check(`${L}: clean: the exact command on demand`, await visible(cl.getByText(/rm -r ~\/Documents\/old-drafts/)));
      await shot(page, `${L}-05-clean`, false);
      await axe(page, `${L} clean`, '#approval-dlg');
      await noOverflow(page, `${L} clean`);
      // a fast double click on Approve: the second click must not say yes to "Are you sure?"
      await cl.getByRole('button', { name: 'Approve', exact: true }).dblclick();
      await page.waitForTimeout(400);
      // (the second click lands on Go back, or on Yes while it still ignores taps: either way nothing is approved)
      check(`${L}: clean: a double click on Approve does not approve`, (await api('/approvals/ap_clean')).approval.state === 'pending');
      if (!(await cl.getByRole('heading', { name: 'Are you sure?' }).count())) await cl.getByRole('button', { name: 'Approve', exact: true }).click();
      check(`${L}: clean: Go back sits where Approve was, Yes after it`, await cl.locator('.ap-confirm .ap-acts button').first().textContent() === 'Go back');
      check(`${L}: clean: Approve asks "Are you sure?" first`, await visible(cl.getByRole('heading', { name: 'Are you sure?' })));
      check(`${L}: clean: …with the reasons`, await visible(cl.getByText(/Approve it even though it was proposed after reading outside content, it deletes something and it reaches outside its own folder\?/)));
      check(`${L}: clean: the focus moves to the question`, (await focusedText(page)) === 'Are you sure?', await focusedText(page));
      check(`${L}: clean: nothing decided yet`, (await api('/approvals/ap_clean')).approval.state === 'pending');
      await shot(page, `${L}-06-confirm`);
      await axe(page, `${L} confirm`, '#approval-dlg');
      await cl.getByRole('button', { name: 'Go back' }).click();
      await cl.getByText('Add a note for your helper (if you say no)').click();
      await cl.getByLabel(/Your note is kept with this decision/).fill('Keep the drafts until Friday');
      await cl.getByRole('button', { name: 'Not this time' }).click();
      check(`${L}: clean: Not this time → "OK — it won’t run"`, await visible(cl.getByText('OK — it won’t run. Nothing was changed.')));
      const after = (await api('/approvals/ap_clean')).approval;
      check(`${L}: clean: declined with the note`, after.state === 'declined' && after.result === 'declined by the person: Keep the drafts until Friday', JSON.stringify(after));
      check(`${L}: clean: no Next (the phishing one is never offered)`, (await cl.getByRole('button', { name: /^Next: / }).count()) === 0);
      await cl.getByRole('button', { name: 'Done' }).click();
      check(`${L}: Today: nothing needs your OK any more`, await hidden(main.locator('.needcard', { hasText: 'need your OK' })) && await hidden(main.locator('.needcard', { hasText: 'Delete old-drafts' })));
      check(`${L}: Today: no page errors`, !errors.length, errors.join(' | '));
      await ctx.close();
    }

    // 4. the phishing one: only from its Important item's detail, behind the warning
    {
      const { ctx, page, errors } = await open(vp, '/?ui=v2&view=inbox');
      const main = page.locator('#main');
      const dlg = sheet(page);
      const row = main.locator('.item', { hasText: 'Run a command on contacts.csv' });
      check(`${L}: Important: the phishing approval is listed with its caution`, await visible(row));
      check(`${L}: Important: no action button on the phishing row itself`, (await row.getByRole('button', { name: 'Review' }).count()) === 0);
      await row.locator('.itemrow').click();
      const detail = page.locator('#item-dlg');
      check(`${L}: Important: its detail warns first`, await visible(detail.getByRole('note')));
      await detail.getByRole('button', { name: 'Review' }).click();
      const ph = dlg.locator('article.ap[data-approval="ap_phish"]');
      check(`${L}: phish: the alert comes first`, await visible(ph.getByRole('alert').getByText('Warning: this may be a phishing trick')));
      const order = await ph.evaluate((el) => { const a = el.querySelector('.ap-phish'); const t = el.querySelector('.ap-title'); return !!a && !!t && !!(a.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING); });
      check(`${L}: phish: above the title`, order);
      await shot(page, `${L}-07-phish`, false);
      await axe(page, `${L} phish`, '#approval-dlg');
      await noOverflow(page, `${L} phish`);
      await ph.getByRole('button', { name: 'Approve', exact: true }).click();
      await page.waitForTimeout(700);
      check(`${L}: phish: Approve asks first, naming phishing`, await visible(ph.getByText(/looks like phishing/)) && await visible(ph.getByRole('button', { name: 'Yes, approve it' })));
      await ph.getByRole('button', { name: 'Go back' }).click();
      await ph.getByRole('button', { name: 'Not this time' }).click();
      check(`${L}: phish: declined`, await visible(ph.getByText('OK — it won’t run. Nothing was changed.')) && (await api('/approvals/ap_phish')).approval.state === 'declined');
      await ph.getByRole('button', { name: 'Done' }).click();
      const ordinary = main.locator('.item', { hasText: 'Delete old-drafts' });
      if (await page.locator('#item-dlg[open]').count()) await page.locator('#item-dlg').getByRole('button', { name: 'Close' }).click();
      await ordinary.getByRole('button', { name: 'Review' }).click();
      check(`${L}: Important: an ordinary approval's row Review opens it`, await visible(dlg.locator('article.ap[data-approval="ap_clean"]')));
      check(`${L}: Important: no page errors`, !errors.length, errors.join(' | '));
      await ctx.close();
    }

    // 5. the working sheet (the status pill): the group, and a waiting job's Review
    {
      const { ctx, page, errors } = await open(vp, '/?ui=v2');
      await page.locator('#statuspill').click();
      const work = page.locator('#work-dlg');
      check(`${L}: pill: counts your chat approval too ("2 waiting for you")`, /2 waiting for you/.test(await page.locator('#statuspill').textContent() ?? ''), await page.locator('#statuspill').textContent());
      check(`${L}: pill: the working sheet lists "Needs your OK · 2" first`, await visible(work.getByRole('heading', { name: 'Needs your OK · 2' })));
      check(`${L}: pill: no phishing one in the group`, (await work.getByText('contacts.csv').count()) === 0);
      check(`${L}: pill: someone else's in a quieter "From others · 1"`, await visible(work.getByRole('heading', { name: 'From others · 1' })));
      const firstGroup = await work.locator('.jobgroup').first().getAttribute('class');
      check(`${L}: pill: …above the jobs`, /approvals/.test(firstGroup ?? ''), firstGroup);
      await axe(page, `${L} working sheet`, '#work-dlg');
      await shot(page, `${L}-08-working-sheet`);
      const job = work.locator('article.job', { has: page.locator('#jt-j_report') });
      check(`${L}: pill: the job waiting for you`, await visible(job.getByText('It needs your OK before it goes on.')));
      await job.getByRole('button', { name: 'Review' }).click();
      check(`${L}: pill: the job's Review opens its approval`, await visible(sheet(page).locator('article.ap[data-approval="ap_report"]')) && await hidden(work));
      await sheet(page).getByRole('button', { name: 'Close' }).click();
      await page.locator('#statuspill').click();
      await work.locator('article', { has: page.locator('#apt-ap_clean') }).getByRole('button', { name: 'Review' }).click();
      check(`${L}: pill: the group's Review opens that approval`, await visible(sheet(page).locator('article.ap[data-approval="ap_clean"]')));
      check(`${L}: pill: no page errors`, !errors.length, errors.join(' | '));
      await ctx.close();
    }

    // 7. a tapped notification: #/approval/<id>
    {
      const { ctx, page, errors } = await open(vp, '/?ui=v2&from=notification#/approval/ap_clean');
      check(`${L}: notification: opens that approval`, await visible(sheet(page).locator('article.ap[data-approval="ap_clean"]')));
      check(`${L}: notification: the hash is not kept`, !page.url().includes('#/approval'), page.url());
      // the confirmed path: Approve, Are you sure? (a moment), Yes — the server gets confirmed: true and it runs
      const cl = sheet(page).locator('article.ap[data-approval="ap_clean"]');
      await cl.getByRole('button', { name: 'Approve', exact: true }).click();
      await page.waitForTimeout(700);
      await cl.getByRole('button', { name: 'Yes, approve it' }).click();
      check(`${L}: notification: Yes, approve it runs it (confirmed)`, await visible(cl.getByText('Done. It ran.')) && (await api('/approvals/ap_clean')).approval.state === 'done');
      await page.goto(`${BASE}/?ui=v2#/approval/ap_gone`);
      check(`${L}: notification: one that is gone says so`, await visible(sheet(page).getByText(/This request is no longer there/)));
      check(`${L}: notification: no page errors`, !errors.length, errors.join(' | '));
      await ctx.close();
    }

    // 8. dark mode
    {
      const { ctx, page, errors } = await open(vp, '/?ui=v2&theme=dark#/approval/ap_phish');
      const ph = sheet(page).locator('article.ap[data-approval="ap_phish"]');
      await visible(ph);
      await ph.getByRole('button', { name: 'Approve', exact: true }).click();
      await visible(ph.getByRole('heading', { name: 'Are you sure?' }));
      await shot(page, `${L}-09-dark`);
      await axe(page, `${L} dark`, '#approval-dlg');
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
