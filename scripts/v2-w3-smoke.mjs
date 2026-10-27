#!/usr/bin/env node
/**
 * v2 build, slice W3: a Playwright run of the Important screen ("Worth a look") and the mail reader against the BUILT
 * UI in fixture mode, at 390×844 and 1440×900 (same pattern as scripts/v2-web-smoke.mjs).
 *
 *   npm run build:ui
 *   node scripts/v2-w3-smoke.mjs [--out <dir>] [--axe <path to axe.min.js>] [--port 4198]
 *
 * Through the Vite fixture middleware (`/?ui=v2`: the real client, EventSource and IndexedDB): the groups render
 * (Today / This week / Earlier) with the sender's address on outside items; the phishing item has the caution style
 * (the warning tokens, not the signal orange), the fixed words and only Not important in its tray; the unverified tag;
 * Handled by swipe with its "Marked handled … Undo" note, Undo, Handled · N; Mark handled from the item sheet; Not
 * important's sheet (sender / domain / kind), the server's 400 for a kind it cannot learn shown plainly with the sender
 * suggested, a free email domain not offered; the rule's effect in the receipt; Show them → This was important; Ask
 * about this answered in place (with "using what I know from Eventing"); the reader (reply-to warning on the phishing
 * message, Draft a reply → "Saved to your drafts. Nothing was sent."); Your rules → Remove; the IndexedDB `items`
 * store; an action made offline; the `sorting` scenario's notes. axe 0 violations, no horizontal overflow.
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('out', join(ROOT, 'reports', 'v2-w3-smoke'));
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
const api = async (path) => (await fetch(`${BASE}/api/v1${path}`, { headers: { 'x-mwa-client': 'web/1.0.0' } })).json();

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
const shot = async (page, name) => { await page.waitForTimeout(350); await page.screenshot({ path: join(OUT, `${name}.png`) }); };
const visible = (loc, ms = 6_000) => loc.first().waitFor({ state: 'visible', timeout: ms }).then(() => true, () => false);
const gone = (loc, ms = 6_000) => loc.first().waitFor({ state: 'detached', timeout: ms }).then(() => true, () => false);

/** Drag a row ~140 px to the left (a swipe; touch and mouse both send pointer events). */
async function swipeLeft(page, loc) {
  const b = await loc.boundingBox();
  const y = b.y + b.height / 2, x = b.x + b.width - 30;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(x - i * 18, y, { steps: 1 });
  await page.mouse.up();
}

// ---------- the run ----------
const browser = await chromium.launch();
const VIEWPORTS = [{ name: 'm390', width: 390, height: 844, mobile: true }, { name: 'd1440', width: 1440, height: 900, mobile: false }];

try {
  for (const vp of VIEWPORTS) {
    const L = vp.name;
    await reset('N00');
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.mobile ? 2 : 1, hasTouch: vp.mobile, isMobile: vp.mobile });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${BASE}/?ui=v2`);
    const bar = page.locator(vp.mobile ? '#tabbar' : '#topbar');
    await bar.getByRole('button', { name: 'Important', exact: true }).click();
    const main = page.locator('#main');
    const listCol = vp.mobile ? main : main.locator('.listcol');
    const pane = vp.mobile ? main : main.locator('.pane');
    const backToList = async () => { if (vp.mobile) await main.getByRole('button', { name: 'Worth a look' }).click(); };

    // 1. the list
    check(`${L}: heading "Worth a look"`, await visible(main.getByRole('heading', { name: 'Worth a look', level: 1 }), 15_000));
    check(`${L}: groups Today / This week / Earlier`, await visible(main.getByRole('heading', { name: 'Today', exact: true }))
      && await main.getByRole('heading', { name: 'This week', exact: true }).isVisible() && await main.getByRole('heading', { name: 'Earlier', exact: true }).isVisible());
    const ellen = listCol.getByRole('button', { name: /Coach Ellen.*Saturday schooling/ });
    check(`${L}: an item is a button named by who, time, title and why`, await ellen.isVisible());
    check(`${L}: the sender's address beside the name on an outside item`, ((await ellen.textContent()) ?? '').includes('ellen@willowcreekfarm.example'));
    const addr = await ellen.locator('.addrline').evaluate((el) => { const r = el.getBoundingClientRect(), row = el.closest('.itemrow').getBoundingClientRect(); return { text: el.textContent, clipped: el.scrollWidth > el.clientWidth + 1, inside: r.right <= row.right + 1 }; }).catch(() => null);
    check(`${L}: the real address has its own line, never cut short (review of W3)`, addr && addr.text === 'ellen@willowcreekfarm.example' && !addr.clipped && addr.inside, JSON.stringify(addr));
    check(`${L}: the one action, filled when it needs you ("Add to calendar")`, await listCol.getByRole('button', { name: 'Add to calendar' }).first().isVisible()
      && /vbtn-primary/.test(await listCol.getByRole('button', { name: 'Add to calendar' }).first().getAttribute('class')));
    const skipLines = await listCol.locator('.skipline').allTextContents();
    check(`${L}: skipped lines per group ("I skipped 5 others today: …")`, skipLines.length === 3 && /^I skipped 5 others today: newsletters, promotions, receipts · Show them$/.test(skipLines[0].trim()), JSON.stringify(skipLines));
    check(`${L}: the earlier line names what you marked not important`, /what you marked not important/.test(skipLines[2] ?? ''), skipLines[2]);
    await shot(page, `${L}-01-list`);
    await axe(page, `${L} list`);
    await noOverflow(page, `${L} list`);

    // 2. phishing and unverified
    const phish = listCol.locator('.item.caution-phishing');
    const ph = await phish.evaluate((li) => {
      const row = li.querySelector('.itemrow'), cs = getComputedStyle(row), root = getComputedStyle(document.documentElement);
      return { text: li.textContent, bg: cs.backgroundColor, warn: root.getPropertyValue('--warn-bg').trim(), signal: root.getPropertyValue('--signal').trim(), act: !!li.querySelector('.it-act') };
    }).catch(() => null);
    const hex = (h) => { const n = parseInt(h.replace('#', ''), 16); return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`; };
    check(`${L}: phishing item in the caution style (the warning tokens, not the signal orange)`, ph && ph.bg === hex(ph.warn) && ph.bg !== hex(ph.signal), JSON.stringify(ph));
    check(`${L}: phishing item: the fixed words and the address it came from`, ph && ph.text.includes('This may not be who it says it is') && ph.text.includes('Sent from service@paypa1-security.example'), ph?.text);
    check(`${L}: phishing item: no action button`, ph && !ph.act);
    check(`${L}: unverified item: a quieter "unverified sender" tag`, await listCol.locator('.item.caution-unverified .cautiontag.unverified').filter({ hasText: 'unverified sender' }).isVisible());
    await swipeLeft(page, listCol.getByRole('button', { name: /Your account has been limited/ }));
    const phTray = listCol.getByRole('group', { name: 'Your account has been limited' });
    check(`${L}: phishing tray offers only Not important`, await visible(phTray) && await phTray.getByRole('button', { name: 'Not important' }).isVisible() && !(await phTray.getByRole('button', { name: 'Handled' }).count()));
    await page.keyboard.press('Escape');
    await main.getByRole('heading', { name: 'Worth a look', level: 1 }).click(); // tap elsewhere: the row comes back
    check(`${L}: a tap elsewhere puts the row back`, await gone(phTray));

    // 3. Handled by swipe, its note with Undo, Handled · N
    const board = listCol.getByRole('button', { name: /Board call moved to Wednesday 2pm/ });
    await swipeLeft(page, board);
    const tray = listCol.getByRole('group', { name: 'Board call moved to Wednesday 2pm' });
    check(`${L}: swipe left turns the row into a tray (Not important, Handled)`, await visible(tray) && await tray.getByRole('button', { name: 'Not important' }).isVisible());
    await shot(page, `${L}-02-swiped`);
    await tray.getByRole('button', { name: 'Handled' }).click();
    const note = page.locator('#toasts .toast').filter({ hasText: 'Marked handled: Board call moved to Wednesday 2pm' });
    check(`${L}: "Marked handled: … · Undo"`, await visible(note) && await note.getByRole('button', { name: 'Undo' }).isVisible());
    check(`${L}: it left the list at once`, !(await listCol.getByRole('button', { name: /Board call moved to Wednesday 2pm/ }).count()));
    check(`${L}: Handled · 1`, await visible(listCol.getByRole('button', { name: 'Handled · 1' })));
    await shot(page, `${L}-03-handled`);
    if (!vp.mobile) {
      await page.waitForTimeout(7_000);
      check(`${L}: the Undo note is still there after 7 s (it lasts 10 s)`, await note.isVisible());
      await note.hover();
      await page.waitForTimeout(4_500);
      check(`${L}: … and holds while hovered (11.5 s)`, await note.isVisible());
    }
    await note.getByRole('button', { name: 'Undo' }).click();
    check(`${L}: Undo puts it back`, await visible(listCol.getByRole('button', { name: /Board call moved to Wednesday 2pm/ })) && await gone(listCol.getByRole('button', { name: /^Handled · / })));
    const srvBoard = (await api('/items')).groups.flatMap((g) => g.items).find((i) => i.id === 'it_board');
    check(`${L}: the server has it open again`, srvBoard?.state === 'open', srvBoard?.state);

    // the keyboard path: open a non-email item → the sheet → Mark handled; Handled · 1 → Undo
    await listCol.getByRole('button', { name: /Two gutter quotes came in/ }).click();
    const itemDlg = page.locator('#item-dlg');
    check(`${L}: a non-email item opens in a sheet with Ask about this`, await visible(itemDlg.getByRole('heading', { name: 'Two gutter quotes came in' })) && await itemDlg.getByRole('button', { name: 'Ask about this' }).isVisible());
    await shot(page, `${L}-04-item-sheet`);
    await axe(page, `${L} item sheet`);
    await itemDlg.getByRole('button', { name: 'Mark handled' }).click();
    check(`${L}: Mark handled closes the sheet; Handled · 1`, await gone(itemDlg.getByRole('heading', { name: 'Two gutter quotes came in' })) && await visible(listCol.getByRole('button', { name: 'Handled · 1' })));
    await listCol.getByRole('button', { name: 'Handled · 1' }).click();
    const handledList = listCol.locator('.handled .skiplist');
    check(`${L}: Handled · 1 opens with Undo per item`, await visible(handledList.getByRole('button', { name: 'Undo' })) && ((await handledList.textContent()) ?? '').includes('Two gutter quotes came in'));
    await handledList.getByRole('button', { name: 'Undo' }).click();
    check(`${L}: Undo from Handled puts it back`, await visible(listCol.getByRole('button', { name: /Two gutter quotes came in/ })));

    // 4. Show them → This was important
    await listCol.getByRole('button', { name: 'Show them' }).first().click();
    const skip = page.locator('#skip-dlg');
    check(`${L}: Show them → "Skipped today · 5"`, await visible(skip.getByRole('heading', { name: 'Skipped today · 5' })));
    check(`${L}: each skipped row has "This was important"`, (await skip.getByRole('button', { name: 'This was important' }).count()) === 5);
    await shot(page, `${L}-05-skipped`);
    await axe(page, `${L} skipped sheet`);
    await skip.getByRole('button', { name: 'This was important' }).first().click();
    check(`${L}: "Thanks — I'll show messages like this from The Batch."`, await visible(skip.getByText('Thanks — I\'ll show messages like this from The Batch.')));
    check(`${L}: "Skipped today · 4"`, await visible(skip.getByRole('heading', { name: 'Skipped today · 4' })));
    await skip.getByRole('button', { name: 'Close' }).click();
    check(`${L}: The Batch is on the list`, await visible(listCol.getByRole('button', { name: /This week in AI/ })));

    // 5. Ask about this, answered in place (the book-fair newsletter, in the reader)
    await listCol.getByRole('button', { name: /Oakwood school newsletter/ }).click();
    check(`${L}: the newsletter opens in the reader`, await visible(pane.getByRole('heading', { name: 'Book fair this Saturday, 3–6pm' })));
    await pane.getByRole('button', { name: 'Ask about this' }).click();
    const askDlg = page.locator('dialog[open][id^="about-"]');
    check(`${L}: the Ask sheet is tied to it ("About: Book fair · Sat Nov 14")`, await visible(askDlg.getByText('About: Book fair · Sat Nov 14')));
    check(`${L}: three questions specific to it`, await visible(askDlg.getByRole('button', { name: 'Who else is going?' })) && await askDlg.getByRole('button', { name: 'Remind me the day before' }).isVisible()
      && (await askDlg.locator('.sugg').count()) === 3);
    await shot(page, `${L}-06-ask-tied`);
    await axe(page, `${L} ask sheet`);
    await askDlg.getByRole('button', { name: 'Who else is going?' }).click();
    check(`${L}: the sheet closes by itself`, await gone(page.locator('dialog[open][id^="about-"]')));
    const qa = pane.locator('.qa');
    check(`${L}: the answer appears under the item ("Sam’s family is going")`, await visible(qa.getByText(/Sam’s family is going/), 10_000));
    check(`${L}: … with "using what I know from Eventing"`, await visible(qa.getByText('using what I know from Eventing'), 6_000));
    check(`${L}: … under "You asked", with the item still there`, await qa.getByRole('heading', { name: 'You asked' }).isVisible() && await pane.getByRole('heading', { name: 'Book fair this Saturday, 3–6pm' }).isVisible());
    check(`${L}: an answer that read the email says so ("Based on what the email says — check before acting")`, await qa.getByText('Based on what the email says — check before acting').first().isVisible());
    await pane.getByRole('button', { name: 'Ask about this' }).click();
    await page.locator('dialog[open][id^="about-"]').getByRole('button', { name: 'What did the newsletter say about it?' }).click();
    const linkAns = qa.getByText(/sign up at oakwoodpta\.example\./);
    check(`${L}: a link in an answer shows as its host only`, await visible(linkAns, 10_000) && !/https?:\/\//.test((await qa.textContent()) ?? ''), await qa.textContent());
    await qa.scrollIntoViewIfNeeded();
    await shot(page, `${L}-07-answer-in-place`);
    // the item's action in the helper's note: the date as read, then a calendar DRAFT on the tap
    const hb = pane.locator('.helperbox');
    check(`${L}: the reader shows the item's action with the date as read`, await hb.getByRole('button', { name: 'Add to calendar' }).isVisible() && ((await hb.locator('.preview').textContent()) ?? '').includes('Sat Nov 14, 3–6pm · Oakwood Elementary'));
    await hb.getByRole('button', { name: 'Add to calendar' }).click();
    check(`${L}: Add to calendar → "Added to your calendar as a draft. Confirm it in MWA."`, await visible(page.locator('#toasts').getByText('Added to your calendar as a draft. Confirm it in MWA.')));
    check(`${L}: … and the server holds the draft`, (await api('/calendar')).items.some((i) => i.id === 'cd_bookfair' && i.kind === 'draft'));
    const thread = await api('/projects/family/thread');
    check(`${L}: the ask is also in the item's project ("About Book fair · Sat Nov 14: Who else is going?")`, thread.turns.some((t) => t.message === 'About Book fair · Sat Nov 14: Who else is going?'));
    await backToList();

    // 6. the reader: Draft a reply (saved, never sent)
    await listCol.getByRole('button', { name: /Coach Ellen.*Saturday schooling/ }).click();
    check(`${L}: the reader: subject, sender and address`, await visible(pane.getByRole('heading', { name: 'Saturday schooling — are you in?' })) && ((await pane.locator('.reader .meta').textContent()) ?? '').includes('ellen@willowcreekfarm.example'));
    await pane.getByRole('button', { name: 'Draft a reply' }).click();
    await pane.getByRole('textbox', { name: 'Draft reply' }).fill('Hi Ellen, yes please — count Willow and me in for the 7am trailer on Saturday. Thanks! Robert');
    await pane.getByRole('button', { name: 'Save draft' }).click();
    check(`${L}: "Saved to your drafts. Nothing was sent."`, await visible(pane.getByText('Saved to your drafts. Nothing was sent.')));
    await shot(page, `${L}-08-reader-draft-saved`);
    await axe(page, `${L} reader`);
    await noOverflow(page, `${L} reader`);
    await backToList();

    // the phishing message in the reader: the reply-to warning, only Open (this) and Not important
    await listCol.getByRole('button', { name: /Your account has been limited/ }).click();
    check(`${L}: phishing reader: the caution box`, await visible(pane.locator('.cautionbox').filter({ hasText: 'This may not be who it says it is' })));
    check(`${L}: phishing reader: "Your reply will go to … (not the sender)."`, await visible(pane.getByText('Your reply will go to resolve-team@protonmail.com (not the sender).')));
    check(`${L}: phishing reader: no Draft a reply, no Ask about this, no Mark handled; Not important`,
      !(await pane.getByRole('button', { name: 'Draft a reply' }).count()) && !(await pane.getByRole('button', { name: 'Ask about this' }).count())
      && !(await pane.getByRole('button', { name: 'Mark handled' }).count()) && await pane.getByRole('button', { name: 'Not important' }).isVisible());
    await shot(page, `${L}-09-reader-phishing`);
    await axe(page, `${L} phishing reader`);
    await noOverflow(page, `${L} phishing reader`);
    await backToList();

    // review of W3: the same phishing message opened from All email keeps its caution, with no reply and no Ask
    await listCol.getByRole('button', { name: 'All email', exact: true }).click();
    const pxRow = listCol.locator('.mailrow', { hasText: 'Your account has been limited' });
    check(`${L}: All email: the phishing row carries the caution tag`, await visible(pxRow.locator('.cautiontag.phishing')));
    check(`${L}: All email: the unverified row carries its tag`, await listCol.locator('.mailrow', { hasText: 'Action required: confirm your payment details' }).locator('.cautiontag.unverified').isVisible());
    check(`${L}: All email: the real address on its own line`, ((await pxRow.locator('.addrline').textContent()) ?? '') === 'service@paypa1-security.example');
    await pxRow.click();
    check(`${L}: m_px1 from All email: the caution box`, await visible(pane.locator('.cautionbox').filter({ hasText: 'This may not be who it says it is' })));
    check(`${L}: m_px1 from All email: no Draft a reply, no Ask about this`, !(await pane.getByRole('button', { name: 'Draft a reply' }).count()) && !(await pane.getByRole('button', { name: 'Ask about this' }).count()));
    await shot(page, `${L}-09b-phishing-from-all-email`);
    await axe(page, `${L} phishing from All email`);
    if (vp.mobile) await main.getByRole('button', { name: 'All email' }).first().click();
    await listCol.locator('.mailrow', { hasText: 'Action required: confirm your payment details' }).click();
    check(`${L}: an unverified message: the tag, and Ask about this is allowed`, await visible(pane.locator('.cautiontag.unverified')) && await pane.getByRole('button', { name: 'Ask about this' }).isVisible());
    if (vp.mobile) await main.getByRole('button', { name: 'All email' }).first().click();
    await listCol.getByRole('button', { name: 'Worth a look' }).first().click();

    // 7. Not important: the sheet, a free email domain not offered, the 400 shown plainly, the sender suggested
    await listCol.getByRole('button', { name: /Dana is waiting on your top 3 stories/ }).click();
    await pane.getByRole('button', { name: 'Not important' }).click();
    const ni = page.locator('#notimp-dlg');
    check(`${L}: Not important (gmail.com sender): only "Messages from …", and why`, await visible(ni.getByRole('button', { name: 'Messages from dana.lee.news@gmail.com' }))
      && !(await ni.getByRole('button', { name: /Everything from gmail.com/ }).count()) && await ni.getByText(/gmail\.com is a free email service/).isVisible());
    await shot(page, `${L}-10-notimp-freemail`);
    await ni.getByRole('button', { name: 'Close' }).click();
    await backToList();
    await listCol.getByRole('button', { name: /Hillside Hardware/ }).click();
    await pane.getByRole('button', { name: 'Not important' }).click();
    check(`${L}: Not important (a shop): sender, domain, kind`, await visible(ni.getByRole('button', { name: 'Messages from orders@hillside.example' }))
      && await ni.getByRole('button', { name: 'Everything from hillside.example' }).isVisible() && await ni.getByRole('button', { name: 'All receipts' }).isVisible());
    await ni.getByRole('button', { name: 'All receipts' }).click();
    const refusal = ni.getByRole('alert');
    check(`${L}: the server's 400 shown plainly`, await visible(refusal) && /I can only learn a kind from how a message is sent/.test((await refusal.textContent()) ?? ''), await refusal.textContent().catch(() => ''));
    check(`${L}: … and "messages from <address>" suggested`, /vbtn-primary/.test((await ni.getByRole('button', { name: 'Messages from orders@hillside.example' }).getAttribute('class')) ?? '')
      && await ni.getByText('Suggested: messages from orders@hillside.example.').isVisible());
    await shot(page, `${L}-11-notimp-refused`);
    await axe(page, `${L} not-important sheet`);
    await ni.getByRole('button', { name: 'Messages from orders@hillside.example' }).click();
    check(`${L}: "Got it. I'll skip messages like this from orders@hillside.example."`, await visible(page.locator('#toasts').getByText('Got it. I\'ll skip messages like this from orders@hillside.example.')));
    check(`${L}: Hillside left the list`, !(await listCol.getByRole('button', { name: /Hillside Hardware/ }).count()));

    // the rule's effect in the receipt: all newsletters (several senders)
    await listCol.getByRole('button', { name: /Stable View newsletter/ }).click();
    await pane.getByRole('button', { name: 'Not important' }).click();
    await ni.getByRole('button', { name: 'All newsletters' }).click();
    const eff = page.locator('#toasts').getByText(/Got it\. I'll skip newsletters\. This will hide mail from \d+ senders \(\d+ messages now\)\./);
    check(`${L}: the rule's effect ("This will hide mail from N senders")`, await visible(eff), await page.locator('#toasts').textContent());
    await shot(page, `${L}-12-rule-effect`);

    // 8. Your rules → Remove
    if (vp.mobile && await main.getByRole('button', { name: 'Worth a look' }).count()) await backToList();
    await listCol.getByRole('button', { name: 'Your rules' }).click();
    const rules = page.locator('#rules-dlg');
    check(`${L}: Your rules lists what was taught, with its effect`, await visible(rules.getByText('Skip messages from news@medium.example')) && await rules.getByText('Skip messages from orders@hillside.example').isVisible()
      && await rules.getByText('Skip newsletters').isVisible() && (await rules.locator('.skipsub').count()) >= 3);
    await shot(page, `${L}-13-rules`);
    await axe(page, `${L} rules sheet`);
    await rules.locator('.skiprow').filter({ hasText: 'news@medium.example' }).getByRole('button', { name: 'Remove' }).click();
    check(`${L}: Remove → "Undone. I'll sort messages from news@medium.example as usual again."`, await visible(rules.getByText("Undone. I'll sort messages from news@medium.example as usual again.")));
    check(`${L}: the rule is gone`, await gone(rules.getByText('Skip messages from news@medium.example')));
    await rules.getByRole('button', { name: 'Close' }).click();

    // 9. offline: Handled waits in the outbox, the item leaves at once, and is sent when back online
    await ctx.setOffline(true);
    await page.waitForTimeout(300);
    await listCol.getByRole('button', { name: /Thursday at 4 is double-booked/ }).click();
    await itemDlg.getByRole('button', { name: 'Mark handled' }).click();
    check(`${L}: offline: kept ("You’re offline…") and gone from the list`, await visible(page.locator('#toasts').getByText('You’re offline', { exact: false }))
      && !(await listCol.getByRole('button', { name: /Thursday at 4 is double-booked/ }).count()));
    await ctx.setOffline(false);
    let sent = false;
    for (let i = 0; i < 40 && !sent; i++) { await page.waitForTimeout(250); sent = (await api('/items?state=handled')).groups.flatMap((g) => g.items).some((x) => x.id === 'it_clash'); }
    check(`${L}: back online, the queued Handled reached the server`, sent);

    // 10. the device cache holds the list
    const idb = await page.evaluate(() => new Promise((res) => {
      const r = indexedDB.open('mwa-v2');
      r.onsuccess = () => { const q = r.result.transaction('items', 'readonly').objectStore('items').count(); q.onsuccess = () => res(q.result); q.onerror = () => res(-1); };
      r.onerror = () => res(-1);
    }));
    check(`${L}: IndexedDB "items" holds the list`, idb >= 8, String(idb));

    // 11. Today: the same list's top 3 (phone) with See all; the desktop's left column
    await bar.getByRole('button', { name: 'Today', exact: true }).click();
    if (vp.mobile) {
      check(`${L}: Today › Worth a look: the top 3 and See all`, await visible(main.locator('.items .item'), 6_000) && (await main.locator('.items .item').count()) === 3 && await main.getByRole('button', { name: /^See all \(\d+\)$/ }).isVisible());
    } else {
      check(`${L}: Today's left column is the list`, await visible(main.locator('.inboxcol .items .item')));
    }
    await main.getByRole('button', { name: /Coach Ellen.*Saturday schooling/ }).first().click();
    check(`${L}: from Today, an email opens in a sheet`, await visible(page.locator('#mail-dlg').getByRole('heading', { name: 'Saturday schooling — are you in?' })));
    await shot(page, `${L}-14-today-reader-sheet`);
    await axe(page, `${L} today reader sheet`);
    await page.locator('#mail-dlg').getByRole('button', { name: 'Close' }).first().click();
    check(`${L}: no page errors`, errors.length === 0, errors.join(' | '));
    await ctx.close();

    // the sorting scenario (in-browser fixtures): how sorting is going
    const c2 = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.mobile ? 2 : 1, hasTouch: vp.mobile, isMobile: vp.mobile });
    const p2 = await c2.newPage();
    await p2.goto(`${BASE}/?fixtures=1&scenario=sorting&view=inbox`);
    const sn = p2.locator('.sortnote');
    check(`sorting-${L}: "3 messages are waiting to be sorted"`, await visible(sn, 15_000) && /3 messages are waiting to be sorted\./.test((await sn.textContent()) ?? ''));
    check(`sorting-${L}: "Older mail … wasn't sorted yet"`, /Older mail \(120 messages more than 2 days old\) wasn't sorted yet\./.test((await sn.textContent()) ?? ''));
    await shot(p2, `sorting-${L}`);
    await axe(p2, `sorting-${L}`);
    await p2.goto(`${BASE}/?fixtures=1&view=inbox&theme=dark`);
    await visible(p2.locator('.item.caution-phishing'), 15_000);
    await shot(p2, `dark-${L}-list`);
    await axe(p2, `dark-${L} list`);
    await c2.close();
  }
} finally {
  await browser.close();
  stopVite();
}
writeFileSync(join(OUT, 'results.json'), JSON.stringify({ at: new Date().toISOString(), failed, results }, null, 2));
console.log(`\n${results.length - failed}/${results.length} checks passed · screenshots in ${OUT}`);
process.exit(failed ? 1 : 0);
