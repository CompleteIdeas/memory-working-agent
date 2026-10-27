#!/usr/bin/env node
/**
 * v2 build, slice P4: a Playwright run of voice input against the BUILT UI in fixture mode (the Vite fixture
 * middleware, `?ui=v2`, so the ask is a real network request), at 390×844 and 1440×900, with a stubbed
 * SpeechRecognition injected before the page loads (addInitScript). Same pattern as scripts/v2-w5-smoke.mjs.
 *
 *   npm run build:ui
 *   node scripts/v2-p4-smoke.mjs [--out <dir>] [--axe <path to axe.min.js>] [--port 4201]
 *
 *   1. tap the mic (the Ask bar's on a phone, the Ask sheet's on a computer): the sheet listens (aria-pressed, Listening…,
 *      the words live, Stop); Stop → the words are in the box, Send shows, nothing was sent; Send → POST /ask with
 *      source: 'voice';
 *   2. press and hold, let go: the words are in the box, not sent;
 *   3. the keyboard: Enter on the mic starts, Enter again stops;
 *   4. the microphone refused: "I need permission to use the microphone" (an alert);
 *   5. nothing heard: "I didn't catch that";
 *   6. a browser with no speech recognition: no mic in the Ask bar or the sheet; Settings › Voice says why;
 *   7. Settings › Voice: the privacy note; turned off, the mic is hidden;
 * and everywhere: axe 0 violations, nothing scrolls sideways, no page errors.
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('out', join(ROOT, 'reports', 'v2-p4-smoke'));
const AXE = arg('axe', process.env.AXE_PATH ?? '');
const PORT = Number(arg('port', '4201'));
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

// ---------- the stubbed browser speech ----------
// mode: 'ok' (says WORDS one at a time, interim then final, until stopped), 'deny' (not-allowed), 'silent'
// (no-speech), 'none' (no SpeechRecognition at all, like Firefox)
const TRANSCRIPT = 'remind me to email the coach Friday';
function speechStub({ mode, words }) {
  window.__voice = { starts: 0, stops: 0, aborts: 0, lang: null, continuous: null };
  if (mode === 'none') {
    for (const k of ['SpeechRecognition', 'webkitSpeechRecognition']) {
      try { delete window[k]; } catch { /* */ }
      try { Object.defineProperty(window, k, { value: undefined, configurable: true, writable: true }); } catch { /* */ }
    }
    return;
  }
  class FakeRecognition {
    constructor() { this.lang = ''; this.continuous = false; this.interimResults = false; this.maxAlternatives = 1; this.onresult = null; this.onerror = null; this.onend = null; this.timer = null; this.i = 0; this.done = false; }
    emit(text, final) {
      const r = [{ transcript: text }]; r.isFinal = final;
      const results = [r];
      this.onresult && this.onresult({ resultIndex: 0, results });
    }
    start() {
      window.__voice.starts++; window.__voice.lang = this.lang; window.__voice.continuous = this.continuous;
      if (mode === 'deny') { setTimeout(() => { this.onerror && this.onerror({ error: 'not-allowed' }); this.onend && this.onend(); }, 60); return; }
      if (mode === 'silent') { setTimeout(() => { this.onerror && this.onerror({ error: 'no-speech' }); this.onend && this.onend(); }, 300); return; }
      this.timer = setInterval(() => {
        if (this.i < words.length) { this.i++; this.emit(words.slice(0, this.i).join(' '), false); }
      }, 120);
    }
    stop() {
      window.__voice.stops++;
      clearInterval(this.timer);
      if (this.done) return; this.done = true;
      setTimeout(() => { if (this.i > 0) this.emit(words.slice(0, Math.max(this.i, words.length)).join(' '), true); this.onend && this.onend(); }, 80);
    }
    abort() { window.__voice.aborts++; clearInterval(this.timer); if (this.done) return; this.done = true; setTimeout(() => { this.onerror && this.onerror({ error: 'aborted' }); this.onend && this.onend(); }, 10); }
  }
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;
}

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
const shot = async (page, name) => { await page.waitForTimeout(250); await page.screenshot({ path: join(OUT, `${name}.png`) }); };
const visible = (loc, ms = 8_000) => loc.first().waitFor({ state: 'visible', timeout: ms }).then(() => true, () => false);
const until = async (fn, ms = 5_000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };

const browser = await chromium.launch();
const VIEWPORTS = [{ name: 'm390', width: 390, height: 844, mobile: true }, { name: 'd1440', width: 1440, height: 900, mobile: false }];
async function open(vp, mode, url = '/?ui=v2', prefs = null) {
  await reset('N00');
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.mobile ? 2 : 1, hasTouch: vp.mobile, isMobile: vp.mobile,
    // the phone run is Android Chrome (the permission help and phrase-by-phrase listening are Android's)
    ...(vp.mobile ? { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36' } : {}) });
  await ctx.addInitScript(speechStub, { mode, words: TRANSCRIPT.split(' ') });
  if (prefs) await ctx.addInitScript((p) => { try { localStorage.setItem('mwa-v2-voice', p); } catch { /* */ } }, JSON.stringify(prefs));
  const page = await ctx.newPage();
  const errors = [];
  const asks = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('request', (r) => { if (r.method() === 'POST' && /\/api\/v1\/ask$/.test(new URL(r.url()).pathname)) { try { asks.push(JSON.parse(r.postData() ?? '{}')); } catch { asks.push({}); } } });
  await page.goto(`${BASE}${url}`);
  return { ctx, page, errors, asks };
}
const appOpen = (page, vp) => visible(page.locator(vp.mobile ? '#tabbar' : '#topbar').getByRole('button', { name: 'Today', exact: true }), 15_000);
const sheet = (page) => page.locator('#ask-dlg');
const sheetMic = (page) => sheet(page).getByRole('button', { name: 'Hold to talk' });
const box = (page) => sheet(page).getByRole('textbox', { name: 'Message your helper' });
/** where the person taps the mic: the Ask bar on a phone; on a computer the Ask sheet (opened from Ask) */
async function micToTap(page, vp) {
  if (vp.mobile) return page.locator('#dock-mic');
  await page.getByRole('button', { name: 'Ask, or hand over a job' }).first().click();
  await sheet(page).waitFor({ state: 'visible' });
  return sheetMic(page);
}

try {
  for (const vp of VIEWPORTS) {
    const L = vp.name;

    // 1. tap, listen, Stop, check the words, Send
    {
      const { ctx, page, errors, asks } = await open(vp, 'ok');
      check(`${L}: the app is up`, await appOpen(page, vp));
      if (vp.mobile) check(`${L}: the Ask bar has the mic ("Hold to talk")`, await visible(page.locator('#dock-mic').and(page.getByRole('button', { name: 'Hold to talk' }))));
      const mic = await micToTap(page, vp);
      await mic.click();
      check(`${L}: tap → the Ask sheet is listening`, await visible(sheet(page).getByText('Listening…')));
      check(`${L}: the mic is aria-pressed while listening`, await until(async () => (await sheetMic(page).getAttribute('aria-pressed')) === 'true'));
      check(`${L}: the words come live (interim) and are in a polite live region`, await until(async () => ((await page.locator('#voice-live').textContent()) ?? '').includes('remind me to')) && (await page.locator('#voice-live').getAttribute('aria-live')) === 'polite');
      check(`${L}: Stop is there; Send is not while listening`, await visible(sheet(page).getByRole('button', { name: 'Stop', exact: true })) && !(await sheet(page).getByRole('button', { name: 'Send' }).count()));
      check(`${L}: the language is the browser's`, (await page.evaluate(() => window.__voice.lang)) === 'en-US', await page.evaluate(() => window.__voice.lang));
      await page.waitForTimeout(700);
      await shot(page, `${L}-01-listening`);
      await axe(page, `${L} listening`);
      await noOverflow(page, `${L} listening`);
      await sheet(page).getByRole('button', { name: 'Stop', exact: true }).click();
      check(`${L}: Stop → the transcript fills the box`, await until(async () => (await box(page).inputValue()) === TRANSCRIPT), await box(page).inputValue());
      check(`${L}: not listening any more (aria-pressed false, no "Listening…")`, await until(async () => (await sheetMic(page).getAttribute('aria-pressed')) === 'false') && !(await sheet(page).getByText('Listening…').count()));
      check(`${L}: Send shows; nothing was sent by itself`, await visible(sheet(page).getByRole('button', { name: 'Send' })) && asks.length === 0, `${asks.length} sent`);
      await page.waitForTimeout(1200);
      check(`${L}: still nothing sent a moment later`, asks.length === 0);
      await shot(page, `${L}-02-transcript`);
      await axe(page, `${L} transcript`);
      // the person edits a word, then sends
      await box(page).fill(TRANSCRIPT.replace('Friday', 'Friday at 9'));
      await sheet(page).getByRole('button', { name: 'Send' }).click();
      check(`${L}: Send posts the ask with source: 'voice'`, await until(() => asks.length === 1) && asks[0].source === 'voice' && asks[0].text === `${TRANSCRIPT.replace('Friday', 'Friday at 9')}`, JSON.stringify(asks));
      check(`${L}: the ask shows in the conversation`, await visible(sheet(page).locator('.msg-you').filter({ hasText: 'Friday at 9' })));
      await page.waitForTimeout(800);
      await shot(page, `${L}-03-sent`);
      // a typed ask afterwards is not voice
      await box(page).fill('What’s on today?');
      await sheet(page).getByRole('button', { name: 'Send' }).click();
      check(`${L}: a typed ask afterwards has no source voice`, await until(() => asks.length === 2) && !asks[1].source, JSON.stringify(asks[1]));
      await sheet(page).getByRole('button', { name: 'Close' }).first().click();
      check(`${L}: 1: no page errors`, !errors.length, errors.join(' | '));
      await ctx.close();
    }

    // 2. press and hold, let go; 3. the keyboard
    {
      const { ctx, page, errors, asks } = await open(vp, 'ok');
      await appOpen(page, vp);
      const mic = await micToTap(page, vp);
      const b = await mic.boundingBox();
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await page.mouse.down();
      check(`${L}: hold → listening`, await visible(sheet(page).getByText('Listening…')));
      await page.waitForTimeout(1_300);
      await page.mouse.up();
      check(`${L}: let go → the words are in the box`, await until(async () => (await box(page).inputValue()) === TRANSCRIPT), await box(page).inputValue());
      check(`${L}: let go → listening stops, nothing sent`, await until(async () => (await sheetMic(page).getAttribute('aria-pressed')) === 'false') && asks.length === 0);
      // keyboard: clear the box, then Enter on the mic toggles
      await box(page).fill('');
      await sheetMic(page).focus();
      await page.keyboard.press('Enter');
      check(`${L}: Enter on the mic starts listening`, await until(async () => (await sheetMic(page).getAttribute('aria-pressed')) === 'true'));
      await page.waitForTimeout(500);
      await sheetMic(page).focus();
      await page.keyboard.press('Enter');
      check(`${L}: Enter again stops; the words are in the box`, await until(async () => (await sheetMic(page).getAttribute('aria-pressed')) === 'false') && await until(async () => (await box(page).inputValue()).length > 0));
      check(`${L}: the keyboard is not trapped (Tab leaves the mic)`, await (async () => { await page.keyboard.press('Tab'); return page.evaluate(() => document.activeElement?.getAttribute('aria-label') !== 'Hold to talk'); })());
      // closing the sheet while listening stops the microphone
      await box(page).fill('');
      await sheetMic(page).click();
      await visible(sheet(page).getByText('Listening…'));
      await page.keyboard.press('Escape');
      check(`${L}: closing the sheet stops listening`, await until(() => page.evaluate(() => window.__voice.aborts > 0)) && asks.length === 0);
      check(`${L}: 2–3: no page errors`, !errors.length, errors.join(' | '));
      await ctx.close();
    }

    // 4. the microphone refused
    {
      const { ctx, page, errors } = await open(vp, 'deny');
      await appOpen(page, vp);
      const mic = await micToTap(page, vp);
      await mic.click();
      check(`${L}: refused → "I need permission to use the microphone" (alert)`, await visible(sheet(page).getByRole('alert').filter({ hasText: 'I need permission to use the microphone' })));
      check(`${L}: …with how to allow it`, await visible(sheet(page).getByRole('alert').filter({ hasText: vp.mobile ? 'On Android: tap the icon left of the address › Permissions › Microphone › Allow' : 'Microphone › Allow, then try again' })));
      if (vp.mobile) check(`${L}: Android listens phrase by phrase (continuous off)`, (await page.evaluate(() => window.__voice.continuous)) === false);
      check(`${L}: refused → not listening, no restart`, (await sheetMic(page).getAttribute('aria-pressed')) === 'false' && (await page.evaluate(() => window.__voice.starts)) === 1);
      await shot(page, `${L}-04-permission`);
      await axe(page, `${L} permission refused`);
      await noOverflow(page, `${L} permission refused`);
      check(`${L}: 4: no page errors`, !errors.length, errors.join(' | '));
      await ctx.close();
    }

    // 5. nothing heard
    {
      const { ctx, page, errors } = await open(vp, 'silent');
      await appOpen(page, vp);
      const mic = await micToTap(page, vp);
      await mic.click();
      check(`${L}: nothing heard → "I didn’t catch that"`, await visible(sheet(page).getByRole('alert').filter({ hasText: 'I didn’t catch that' })));
      await shot(page, `${L}-05-no-speech`);
      check(`${L}: 5: no page errors`, !errors.length, errors.join(' | '));
      await ctx.close();
    }

    // 6. no speech recognition in this browser
    {
      const { ctx, page, errors } = await open(vp, 'none');
      await appOpen(page, vp);
      check(`${L}: unsupported → no mic in the Ask bar`, !(await page.locator('#dock-mic').count()));
      await page.getByRole('button', { name: 'Ask, or hand over a job' }).first().click();
      await sheet(page).waitFor({ state: 'visible' });
      check(`${L}: unsupported → no mic in the Ask sheet`, !(await sheetMic(page).count()));
      await shot(page, `${L}-06-unsupported-ask`);
      await axe(page, `${L} unsupported ask`);
      await sheet(page).getByRole('button', { name: 'Close' }).first().click();
      await page.goto(`${BASE}/?ui=v2&view=settings`);
      const voice = page.locator('#sec-voice');
      check(`${L}: Settings › Voice says it isn't available here`, await visible(voice.getByText('Voice isn’t available in this browser — type instead.', { exact: false })));
      await voice.scrollIntoViewIfNeeded();
      await shot(page, `${L}-07-settings-unsupported`);
      check(`${L}: 6: no page errors`, !errors.length, errors.join(' | '));
      await ctx.close();
    }

    // 7. Settings › Voice: privacy, the language, off hides the mic
    {
      const { ctx, page, errors } = await open(vp, 'ok', '/?ui=v2&view=settings');
      const voice = page.locator('#sec-voice');
      check(`${L}: Settings › Voice`, await visible(voice.getByRole('heading', { name: 'Voice', level: 2 })));
      check(`${L}: the privacy note`, await visible(voice.getByText('Your browser’s speech service turns your voice into text (on Android and Chrome this may use Google’s servers). MWA only receives the text.')));
      await voice.getByRole('combobox', { name: 'Language I listen for' }).selectOption('fr-FR');
      await voice.scrollIntoViewIfNeeded();
      await shot(page, `${L}-08-settings-voice`);
      await axe(page, `${L} settings voice`);
      await noOverflow(page, `${L} settings voice`);
      const sw = voice.getByRole('switch', { name: 'Talk to your helper' });
      check(`${L}: voice is on by default`, (await sw.getAttribute('aria-checked')) === 'true');
      await sw.click();
      check(`${L}: switched off`, (await sw.getAttribute('aria-checked')) === 'false' && await visible(voice.getByText('Off for this device. The mic is hidden.')));
      await page.locator(vp.mobile ? '#tabbar' : '#topbar').getByRole('button', { name: 'Today', exact: true }).click();
      check(`${L}: off → no mic in the Ask bar`, !(await page.locator('#dock-mic').count()));
      await page.getByRole('button', { name: 'Ask, or hand over a job' }).first().click();
      await sheet(page).waitFor({ state: 'visible' });
      check(`${L}: off → no mic in the Ask sheet`, !(await sheetMic(page).count()));
      await sheet(page).getByRole('button', { name: 'Close' }).first().click();
      // kept on this device: a reload remembers it; turned back on, the chosen language is used
      await page.goto(`${BASE}/?ui=v2&view=settings`);
      const sw2 = page.locator('#sec-voice').getByRole('switch', { name: 'Talk to your helper' });
      await visible(sw2);
      check(`${L}: off is remembered on this device`, (await sw2.getAttribute('aria-checked')) === 'false');
      await sw2.click();
      await page.locator(vp.mobile ? '#tabbar' : '#topbar').getByRole('button', { name: 'Today', exact: true }).click();
      const mic = await micToTap(page, vp);
      await mic.click();
      check(`${L}: the chosen language is used (fr-FR)`, await until(() => page.evaluate(() => window.__voice.lang === 'fr-FR')), await page.evaluate(() => window.__voice.lang));
      await sheet(page).getByRole('button', { name: 'Stop', exact: true }).click();
      check(`${L}: 7: no page errors`, !errors.length, errors.join(' | '));
      await ctx.close();
    }

    // dark mode: listening
    {
      const { ctx, page, errors } = await open(vp, 'ok', '/?ui=v2&theme=dark');
      await appOpen(page, vp);
      const mic = await micToTap(page, vp);
      await mic.click();
      await visible(sheet(page).getByText('Listening…'));
      await page.waitForTimeout(600);
      await shot(page, `${L}-09-listening-dark`);
      await axe(page, `${L} listening dark`);
      await sheet(page).getByRole('button', { name: 'Stop', exact: true }).click();
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
