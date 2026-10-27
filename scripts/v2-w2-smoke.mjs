#!/usr/bin/env node
/**
 * v2 build, slice W2: a Playwright smoke run of Today and the Calendar against the BUILT UI in fixture mode.
 *
 *   npm run build:ui
 *   node scripts/v2-w2-smoke.mjs [--out <dir>] [--axe <path to axe.min.js>] [--port 4197]
 *
 * `vite preview` with MWA_FIXTURES=1, at 390×844 and 1440×900. In-browser fixtures (`?fixtures=1&scenario=…`, each
 * scenario with its own clock) for the screens; the middleware (`?ui=v2`, the real client, EventSource, IndexedDB) for
 * the offline check-in and the cache. Checks (the prototype's names, REPLAY-NOTES.md):
 *   N01 Today — "Good morning, Robert", Needs you with "Draft the note", Next up with "See your whole day", Done for
 *     you (a line opens "Done for you" with See it and Ask about this), Worth a look without the double-booking, the
 *     week line; N05 the check-in ("Your morning check-in", "double-booked" once, "Done — show my day" → "Morning
 *     check-in done."), N05 the desktop's three columns, N09 the wrap ("That’s Monday", Good night → "See you in the
 *     morning."); N02 the Calendar — the day strip, Thursday's double-booking with its options, a helper's draft with
 *     where it came from, Confirm → "Added by your helper just now. No invites were sent.", New event → a draft on
 *     Saturday, November 14, the week view, the calendar file; partial and not-connected notes; check-in done offline
 *     (queued, then sent); S4: a Needs-you approval's Review opens the approval sheet in this app (no classic-app
 *     hand-off); axe 0 violations, no horizontal overflow, dark mode. Screenshots in --out.
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('out', join(ROOT, 'reports', 'v2-w2-smoke'));
const AXE = arg('axe', process.env.AXE_PATH ?? '');
const PORT = Number(arg('port', '4197'));
const BASE = `http://localhost:${PORT}`;
mkdirSync(OUT, { recursive: true });
if (!existsSync(join(ROOT, 'dist-ui', 'index.html'))) { console.error('Build the UI first: npm run build:ui'); process.exit(2); }
const axeSrc = AXE && existsSync(AXE) ? readFileSync(AXE, 'utf8') : null;
if (!axeSrc) console.warn('! no axe-core given (--axe): accessibility checks are skipped');

const results = [];
let failed = 0;
function check(name, ok, detail = '') { results.push({ name, ok: !!ok, detail }); if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`); }

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
const seen = (loc, ms = 10_000) => loc.first().waitFor({ timeout: ms }).then(() => true, () => false);
const main = (page) => page.locator('#main');

const browser = await chromium.launch();
const VIEWPORTS = [{ name: 'm390', width: 390, height: 844, mobile: true }, { name: 'd1440', width: 1440, height: 900, mobile: false }];
const newPage = async (vp, extra = {}) => {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.mobile ? 2 : 1, hasTouch: vp.mobile, isMobile: vp.mobile, ...extra });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  return { ctx, page, errors };
};
const tab = (page, vp, name) => page.locator(vp.mobile ? '#tabbar' : '#topbar').getByRole('button', { name, exact: true }).click();

try {
  for (const vp of VIEWPORTS) {
    const L = vp.name;
    // ---------- N01: the default Today (9:10 AM) ----------
    {
      const { ctx, page, errors } = await newPage(vp);
      await page.goto(`${BASE}/?fixtures=1&scenario=N00`);
      check(`${L} N01: "Good morning, Robert"`, await seen(page.getByRole('heading', { level: 1, name: 'Good morning, Robert' })));
      check(`${L} N01: kicker "Monday, November 9, 2026"`, await seen(page.getByText('Monday, November 9, 2026')));
      check(`${L} N01: Needs you — the double-booking with "Draft the note"`, await seen(page.getByRole('heading', { name: 'Needs you' })) && await page.getByRole('button', { name: 'Draft the note' }).first().isVisible());
      if (vp.mobile) {
        check(`${L} N01: Next up with "See your whole day"`, await seen(main(page).getByText('See your whole day')) && await main(page).getByText('Call with Dana').first().isVisible());
      } else {
        check(`${L} N01: desktop — three columns (Worth a look · Today · Your day)`, await seen(page.locator('#ib-h')) && await page.locator('#cd-h').isVisible() && await page.getByRole('list', { name: 'Your day' }).isVisible());
      }
      const done = main(page).locator('.donebtn');
      await done.first().waitFor({ timeout: 5_000 }).catch(() => {});
      check(`${L} N01: three Done-for-you lines`, (await done.count()) === 3, String(await done.count()));
      check(`${L} N01: the untrusted title is shown as a quote`, await main(page).locator('.donebtn q.outside').filter({ hasText: 'Riley — dentist' }).isVisible());
      const worth = await seen(main(page).locator('.itemrow').filter({ hasText: 'Saturday schooling' }));
      check(`${L} N01: Worth a look has Coach Ellen's item`, worth);
      check(`${L} N01: Worth a look leaves out the double-booking (shown once, as Needs you)`, (await main(page).getByText('double-booked').count()) === 1, String(await main(page).getByText('double-booked').count()));
      check(`${L} N01: the week line`, await main(page).getByText('In the last 7 days: 6 replies drafted').isVisible());
      await page.waitForTimeout(400);
      await shot(page, `N01-${L}-today`);
      await axe(page, `${L} N01 today`);
      await noOverflow(page, `${L} N01 today`);
      // a Done line opens its sheet
      await main(page).getByRole('button', { name: /I drafted a yes to Coach Ellen/ }).click();
      const dd = page.locator('#done-dlg');
      check(`${L} N01: a Done line opens "Done for you" with See it and Ask about this (about the email)`, await seen(dd.getByRole('heading', { name: 'Done for you' })) && await dd.getByRole('button', { name: 'See it' }).isVisible() && await dd.getByRole('button', { name: 'Ask about this' }).isVisible());
      await page.waitForTimeout(300);
      await shot(page, `N01-${L}-done-sheet`);
      await axe(page, `${L} N01 done sheet`);
      await dd.getByRole('button', { name: 'Close' }).click();
      // Draft the note → the Ask sheet about the double-booking, prefilled
      await page.getByRole('button', { name: 'Draft the note' }).first().click();
      const about = page.locator('dialog[open][id^="about-need"]');
      check(`${L} N01: Draft the note opens Ask about the double-booking, prefilled`, await seen(about) && (await about.locator('input').inputValue()).startsWith('Draft a note'));
      await page.waitForTimeout(300);
      await shot(page, `N01-${L}-draft-note`);
      await about.getByRole('button', { name: 'Close' }).click();
      // Not now
      await main(page).getByRole('button', { name: 'Not now' }).first().click();
      check(`${L} N01: Not now → "OK, I’ll bring it up again tomorrow."`, await seen(page.locator('#toasts').getByText('OK, I’ll bring it up again tomorrow.')) && !(await page.getByRole('heading', { name: 'Needs you' }).isVisible()));
      check(`${L} N01: no page errors`, errors.length === 0, errors.join(' | '));
      await ctx.close();
    }

    // ---------- N05: the morning check-in (7:30 AM) ----------
    {
      const { ctx, page, errors } = await newPage(vp);
      await page.goto(`${BASE}/?fixtures=1&scenario=N05`);
      check(`${L} N05: heading "Your morning check-in"`, await seen(page.getByRole('heading', { name: 'Your morning check-in' })));
      check(`${L} N05: counts only`, await main(page).getByText('Here’s your Monday: 5 things on your calendar, 1 thing needs you, and I did 3 things overnight. It’s all below.').isVisible());
      check(`${L} N05: "double-booked" appears once on Today`, (await main(page).getByText('double-booked').count()) === 1);
      check(`${L} N05: Read it to me (the browser can speak)`, await main(page).getByRole('button', { name: 'Read it to me' }).isVisible());
      await page.waitForTimeout(400);
      await shot(page, `N05-${L}-01-checkin`);
      await axe(page, `${L} N05 check-in`);
      await noOverflow(page, `${L} N05`);
      await main(page).getByRole('button', { name: 'Done — show my day' }).click();
      check(`${L} N05: Done → "Morning check-in done. Have a good Monday."`, await seen(main(page).getByText('Morning check-in done. Have a good Monday.')) && !(await page.getByRole('heading', { name: 'Your morning check-in' }).isVisible()));
      check(`${L} N05: the focus moves to Needs you`, await page.evaluate(() => document.activeElement?.id === 'sh-needs'));
      await page.waitForTimeout(300);
      await shot(page, `N05-${L}-02-checkin-done`);
      check(`${L} N05: no page errors`, errors.length === 0, errors.join(' | '));
      await ctx.close();
    }

    // ---------- N09: the evening wrap (6:30 PM) ----------
    {
      const { ctx, page, errors } = await newPage(vp);
      await page.goto(`${BASE}/?fixtures=1&scenario=N09`);
      check(`${L} N09: "Good evening, Robert" and "That’s Monday"`, await seen(page.getByRole('heading', { name: 'That’s Monday' })) && await page.getByRole('heading', { level: 1, name: 'Good evening, Robert' }).isVisible());
      check(`${L} N09: the title is quoted ("an event called “School drop-off”")`, await main(page).locator('q.outside').filter({ hasText: 'School drop-off' }).isVisible());
      await page.waitForTimeout(400);
      await shot(page, `N09-${L}-01-wrap`);
      await axe(page, `${L} N09 wrap`);
      await main(page).getByRole('button', { name: 'Good night' }).click();
      check(`${L} N09: Good night → "See you in the morning."`, await seen(main(page).getByText('See you in the morning.')));
      await page.waitForTimeout(300);
      await shot(page, `N09-${L}-02-wrapped`);
      check(`${L} N09: no page errors`, errors.length === 0, errors.join(' | '));
      await ctx.close();
    }

    // ---------- N02: the Calendar ----------
    {
      const { ctx, page, errors } = await newPage(vp);
      await page.goto(`${BASE}/?fixtures=1&scenario=N00`);
      await seen(page.getByRole('heading', { level: 1, name: 'Good morning, Robert' }));
      await tab(page, vp, 'Calendar');
      check(`${L} N02: Calendar — "November 9–15"`, await seen(page.getByRole('heading', { level: 1, name: 'Calendar' })) && await main(page).getByText('November 9–15').isVisible());
      check(`${L} N02: the account line with Refresh`, await seen(main(page).getByText('Google Calendar')) && await main(page).getByRole('button', { name: 'Refresh' }).isVisible());
      const strip = page.getByRole('tablist', { name: 'Days this week' });
      // the day strip's arrow keys: the next day is chosen and focused
      await strip.getByRole('tab', { name: /^Monday, November 9/ }).focus();
      await page.keyboard.press('ArrowRight');
      check(`${L} N02: arrow keys move along the day strip (and the focus)`, await seen(strip.getByRole('tab', { name: /^Tuesday, November 10/, selected: true }))
        && await page.evaluate(() => (document.activeElement?.getAttribute('aria-label') ?? '').startsWith('Tuesday, November 10')));
      await page.keyboard.press('ArrowLeft');
      check(`${L} N02: the day strip`, await strip.isVisible() && await strip.getByRole('tab', { name: /^Monday, November 9, today, \d+ items$/ }).isVisible());
      await strip.getByRole('tab', { name: /^Thursday, November 12, .*double-booked$/ }).click();
      check(`${L} N02: Thursday's double-booking card with its options`, await seen(main(page).getByRole('group', { name: /Thursday at 4.*is double-booked/ }))
        && await main(page).getByRole('button', { name: 'Draft the note' }).isVisible() && await main(page).getByRole('button', { name: 'Not now' }).isVisible());
      check(`${L} N02: both events say what they overlap`, (await main(page).locator('.evcard.clash').count()) === 2 && await main(page).getByText('Overlaps with Farrier at the barn').isVisible());
      await page.waitForTimeout(300);
      await shot(page, `N02-${L}-01-double-booking`);
      await axe(page, `${L} N02 double-booking`);
      await noOverflow(page, `${L} N02 calendar`);
      // an event opens its sheet with Ask about this
      await main(page).getByRole('button', { name: /Farrier at the barn/ }).first().click();
      const evd = page.locator('#event-dlg');
      check(`${L} N02: an event opens its sheet with Ask about this`, await seen(evd.getByRole('heading', { name: 'Farrier at the barn' })) && await evd.getByRole('button', { name: 'Ask about this' }).isVisible());
      await evd.getByRole('button', { name: 'Ask about this' }).click();
      check(`${L} N02: Ask about this is tied to the event ("About: Farrier at the barn")`, await seen(evd.getByText(/About: Farrier at the barn/)));
      const sugg = evd.locator('.sugg').first();
      if (await seen(sugg, 5_000)) await sugg.click(); else { await evd.getByRole('textbox', { name: /^Ask about/ }).fill('What should I bring?'); await evd.getByRole('button', { name: 'Send' }).click(); }
      check(`${L} N02: the answer shows in the event's sheet, under "You asked"`, await seen(evd.getByRole('heading', { name: 'You asked' })) && await seen(evd.locator('.qa-a .who'), 15_000));
      await page.waitForTimeout(300);
      await shot(page, `N02-${L}-01b-event-ask`);
      await axe(page, `${L} N02 event sheet`);
      await evd.getByRole('button', { name: 'Close' }).click();
      // Wednesday: the helper's draft, with where it came from
      await strip.getByRole('tab', { name: /^Wednesday, November 11/ }).click();
      const draft = main(page).getByRole('group', { name: 'Draft: Riley — dentist' });
      check(`${L} N02: a draft awaiting Confirm says where it came from`, await seen(draft) && await draft.getByText('Added by your helper after reading an email — check it').isVisible());
      check(`${L} N02: the calendar file "Download riley-dentist.ics"`, await draft.getByRole('link', { name: 'Download riley-dentist.ics' }).isVisible());
      await shot(page, `N02-${L}-02-draft`);
      await draft.getByRole('button', { name: 'Confirm' }).click();
      check(`${L} N02: Confirm → "Added by your helper just now. No invites were sent."`, await seen(main(page).getByText('Added by your helper just now. No invites were sent.')));
      check(`${L} N02: the confirmed event is on the calendar, marked`, await seen(main(page).getByRole('button', { name: /Riley — dentist.*Added by your helper/ })));
      await page.waitForTimeout(300);
      await shot(page, `N02-${L}-03-confirmed`);
      // New event: a draft from your own input
      await main(page).getByRole('button', { name: '+ New event' }).click();
      const nd = page.locator('#newevent-dlg');
      await nd.getByRole('textbox', { name: 'What' }).fill('Book fair');
      await nd.getByLabel('Day', { exact: true }).fill('2026-11-14');
      await nd.getByLabel('Starts').fill('15:00');
      await nd.getByLabel('Ends').fill('18:00');
      await nd.getByRole('textbox', { name: /Where/ }).fill('Oakwood Elementary');
      await page.waitForTimeout(250);
      await shot(page, `N02-${L}-04-new-event`);
      await axe(page, `${L} N02 new event`);
      await nd.getByRole('button', { name: 'Add as a draft' }).click();
      check(`${L} N02: New event → a draft on Saturday, November 14`, await seen(main(page).getByRole('heading', { name: 'Saturday, November 14' })) && await seen(main(page).getByRole('group', { name: 'Draft: Book fair' })));
      check(`${L} N02: its receipt`, await main(page).getByText('Added as a draft. Nothing is on your calendar until you confirm it.').isVisible());
      await page.waitForTimeout(350);
      await shot(page, `N02-${L}-05-book-fair-draft`);
      await main(page).getByRole('group', { name: 'Draft: Book fair' }).getByRole('button', { name: 'Confirm' }).click();
      check(`${L} N02: the book fair confirmed`, await seen(main(page).getByText('Added by your helper just now. No invites were sent.')));
      // the Day/Week radio group: one tab stop, arrow keys move the choice
      await main(page).getByRole('radio', { name: 'Day' }).focus();
      await page.keyboard.press('ArrowRight');
      check(`${L} N02: arrow keys move the Day/Week choice (and the focus)`, await seen(main(page).getByRole('radio', { name: 'Week', checked: true })) && await page.evaluate(() => document.activeElement?.getAttribute('data-v') === 'week')
        && (await main(page).getByRole('radio', { name: 'Day' }).getAttribute('tabindex')) === '-1');
      await page.keyboard.press('ArrowLeft');
      // the week view
      await main(page).getByRole('radio', { name: 'Week' }).click();
      check(`${L} N02: the week view lists every day`, (await main(page).locator('.wkday').count()) === 7);
      check(`${L} N02: a confirmed draft shows once (no leftover draft beside its event)`, (await main(page).locator('.wkitem.draft').count()) === 0 && (await main(page).locator('.wkitem').filter({ hasText: 'Book fair' }).count()) === 1);
      await page.waitForTimeout(250);
      await shot(page, `N02-${L}-06-week`);
      await axe(page, `${L} N02 week`);
      await noOverflow(page, `${L} N02 week`);
      await main(page).getByRole('radio', { name: 'Day' }).click();
      check(`${L} N02: no page errors`, errors.length === 0, errors.join(' | '));
      await ctx.close();
    }

    // ---------- partial and not connected ----------
    {
      const { ctx, page, errors } = await newPage(vp);
      await page.goto(`${BASE}/?fixtures=1&scenario=partial`);
      check(`${L} partial: Today names the calendar that hasn't synced`, await seen(main(page).getByText('Your Outlook calendar hasn\'t synced yet, so your day may be missing things.')));
      await shot(page, `partial-${L}-today`);
      await tab(page, vp, 'Calendar');
      check(`${L} partial: the Calendar says so too`, await seen(main(page).getByText('Your Outlook calendar hasn’t synced yet, so your days may be missing things.')));
      await shot(page, `partial-${L}-calendar`);
      await axe(page, `${L} partial calendar`);
      await page.goto(`${BASE}/?fixtures=1&scenario=not-connected`);
      check(`${L} not-connected: Today says it (not "Nothing else today") and offers to connect`, await seen(main(page).getByText('Your calendar isn\'t connected, so I can\'t show what\'s next.')) && (vp.mobile ? await main(page).getByRole('button', { name: 'Connect your calendar' }).isVisible() : true) && !(await main(page).getByText('Nothing else').count()));
      await shot(page, `not-connected-${L}-today`);
      await tab(page, vp, 'Calendar');
      check(`${L} not-connected: the Calendar offers to connect`, await seen(main(page).getByRole('button', { name: 'Connect a calendar' })) && !(await main(page).getByText('A free day').count()));
      await shot(page, `not-connected-${L}-calendar`);
      await axe(page, `${L} not-connected calendar`);
      check(`${L} honest states: no page errors`, errors.length === 0, errors.join(' | '));
      await ctx.close();
    }

    // ---------- S4: a Needs-you approval opens in this app (it used to hand off to the classic app) ----------
    {
      const { ctx, page, errors } = await newPage(vp);
      await page.goto(`${BASE}/?fixtures=1&scenario=approvals`);
      const card = main(page).locator('.needcard', { hasText: '2 things need your OK' });
      check(`${L} approvals: Needs you says "2 things need your OK"`, await seen(card));
      await card.getByRole('button', { name: 'Review' }).click();
      check(`${L} approvals: Review opens the approval sheet here, not the classic app`, await seen(page.locator('#approval-dlg').getByRole('heading', { name: 'Waiting for your OK · 3' })) && !/ui=v1/.test(page.url()), page.url());
      await shot(page, `approvals-${L}-sheet`);
      await axe(page, `${L} approvals sheet`);
      check(`${L} approvals: no page errors`, errors.length === 0, errors.join(' | '));
      await ctx.close();
    }

    // ---------- the middleware: IndexedDB, and the check-in done offline ----------
    {
      await reset('N05');
      const { ctx, page, errors } = await newPage(vp);
      await page.goto(`${BASE}/?ui=v2&now=2026-11-09T07:30:00`);
      check(`${L} mw: the check-in through the real client`, await seen(page.getByRole('heading', { name: 'Your morning check-in' }), 15_000));
      const idb = await page.evaluate(() => new Promise((res) => {
        const r = indexedDB.open('mwa-v2');
        r.onsuccess = () => { const q = r.result.transaction('today', 'readonly').objectStore('today').get('today'); q.onsuccess = () => res(q.result?.id ?? null); q.onerror = () => res(null); };
        r.onerror = () => res(null);
      }));
      check(`${L} mw: Today is kept in IndexedDB (today)`, idb === 'today', String(idb));
      await ctx.setOffline(true);
      await page.waitForTimeout(300);
      await main(page).getByRole('button', { name: 'Done — show my day' }).click();
      check(`${L} mw: offline, the card goes at once and the tap waits ("You’re offline…")`, await seen(page.locator('#toasts').getByText('You’re offline', { exact: false }), 5_000) && !(await page.getByRole('heading', { name: 'Your morning check-in' }).isVisible()));
      const before = await (await fetch(`${BASE}/api/v1/today`, { headers: { 'x-mwa-client': 'web/1.0.0' } })).json();
      check(`${L} mw: …and has not reached the server yet`, before.checkin !== null);
      await shot(page, `mw-${L}-checkin-offline`);
      await ctx.setOffline(false);
      let after = null;
      for (let i = 0; i < 50; i++) { after = await (await fetch(`${BASE}/api/v1/today`, { headers: { 'x-mwa-client': 'web/1.0.0' } })).json(); if (after.checkin === null) break; await page.waitForTimeout(200); }
      check(`${L} mw: back online, it is sent and the server's check-in is done`, after?.checkin === null);
      check(`${L} mw: no page errors`, errors.length === 0, errors.join(' | '));
      await ctx.close();
    }

    // ---------- dark ----------
    {
      const { ctx, page } = await newPage(vp);
      await page.goto(`${BASE}/?fixtures=1&scenario=N05&theme=dark`);
      await seen(page.getByRole('heading', { name: 'Your morning check-in' }));
      await page.waitForTimeout(400);
      await shot(page, `dark-${L}-today`);
      await axe(page, `${L} dark today`);
      await tab(page, vp, 'Calendar');
      await page.getByRole('tablist', { name: 'Days this week' }).getByRole('tab', { name: /^Wednesday/ }).click();
      await page.waitForTimeout(300);
      await shot(page, `dark-${L}-calendar`);
      await axe(page, `${L} dark calendar`);
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  stopVite();
}
writeFileSync(join(OUT, 'results.json'), JSON.stringify({ at: new Date().toISOString(), failed, results }, null, 2));
console.log(`\n${results.length - failed}/${results.length} checks passed · screenshots in ${OUT}`);
process.exit(failed ? 1 : 0);
