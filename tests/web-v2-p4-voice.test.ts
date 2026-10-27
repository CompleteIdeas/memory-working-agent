// v2 build, slice P4: voice input. The Dictation controller with a fake recogniser and a manual clock (start/stop,
// hold, interim to final, the automatic restart on the browser's silence cut-off, the 2-minute cap, every error, an
// unsupported browser, an insecure page), feature detection, the transcript into the text box (never sent by
// itself; `source: 'voice'` on the ask), Settings → Voice per device, and the Ask sheet's mic and listening panel
// rendered in node. Pointer, keyboard and the real browser flow: scripts/v2-p4-smoke.mjs.
import { describe, it, expect, beforeEach } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  Dictation, detectVoice, voiceLang, voiceMessage, voicePlatform, joinWords, CAP_MESSAGE, VOICE_CAP_MS,
  type DictationEnv, type RecognizerLike, type RecognitionEventLike,
} from '../web/src/v2/screens/ask/voice/dictation';
import { dictationApi, makeDictation, trackDraft, voiceSource, NO_DRAFT } from '../web/src/v2/screens/ask/voice/useDictation';
import { parseVoicePrefs, readVoicePrefs, writeVoicePrefs, resetVoicePrefsCache, VOICE_PREFS_KEY } from '../web/src/v2/screens/ask/voice/prefs';
import { MicButton, VoicePanel, MIC_NAME } from '../web/src/v2/screens/ask/voice/Mic';
import { VOICE_PRIVACY } from '../web/src/v2/screens/ask/voice/VoiceSettings';
import { MwaClient } from '../web/src/v2/api/client';
import { V2Store } from '../web/src/v2/store/core';
import { MemoryCache } from '../web/src/v2/store/cache';
import { StoreProvider } from '../web/src/v2/store/react';
import { FixtureServer, fixtureFetch } from '../web/src/v2/dev/fixtures';
import { FIXTURE_NOW } from '../web/src/v2/dev/fixture-data';
import { AskSheet } from '../web/src/v2/screens/ask/AskSheet';

// ---------- a fake recogniser and a clock ----------
class FakeRec implements RecognizerLike {
  lang = ''; continuous = false; interimResults = false; maxAlternatives = 0;
  onresult: ((e: RecognitionEventLike) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = 0; stopped = 0; aborted = 0; throwOnStart = false;
  private res: { text: string; final: boolean }[] = [];
  start() { if (this.throwOnStart) throw new Error('InvalidStateError'); this.started++; }
  stop() { this.stopped++; }
  abort() { this.aborted++; }
  /** the browser hears something: result `i` (default: a new one) is now `text` */
  say(text: string, final = false, i = this.res.findIndex((r) => !r.final) >= 0 ? this.res.findIndex((r) => !r.final) : this.res.length) {
    this.res[i] = { text, final };
    const results = Object.assign(this.res.map((r) => Object.assign([{ transcript: r.text }], { isFinal: r.final })), {});
    this.onresult?.({ resultIndex: i, results: results as unknown as RecognitionEventLike['results'] });
  }
  end() { this.onend?.(); }
  error(code: string) { this.onerror?.({ error: code }); this.onend?.(); }
}

function clock() {
  let t = 1_000_000;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let n = 0;
  return {
    now: () => t,
    setTimeout: (fn: () => void, ms: number) => { const id = ++n; timers.push({ at: t + ms, fn, id }); return id; },
    clearTimeout: (id: unknown) => { const i = timers.findIndex((x) => x.id === id); if (i >= 0) timers.splice(i, 1); },
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift(); t = next.at; next.fn();
      }
      t = end;
    },
    pending: () => timers.length,
  };
}

function rig(o: Partial<DictationEnv> = {}) {
  const c = clock();
  const recs: FakeRec[] = [];
  const d = new Dictation({
    create: () => { const r = new FakeRec(); recs.push(r); return r; }, support: 'ok', continuous: true, lang: () => 'en-GB',
    now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, ...o,
  });
  return { d, c, recs, rec: () => recs[recs.length - 1] };
}

describe('P4 Dictation: start, stop, hold, interim to final', () => {
  it('start configures the recogniser (language, continuous, interim results) and listens', () => {
    const { d, rec } = rig();
    expect(d.start()).toBe(true);
    const r = rec();
    expect(r.started).toBe(1);
    expect([r.lang, r.continuous, r.interimResults, r.maxAlternatives]).toEqual(['en-GB', true, true, 1]);
    expect(d.getState()).toMatchObject({ phase: 'listening', text: '', interim: '', error: null, session: 1, hold: false });
    expect(d.start()).toBe(true); // already listening: nothing new
    expect(r.started).toBe(1);
  });

  it('interim words show live; a final result moves them into the text', () => {
    const { d, rec } = rig();
    d.start();
    rec().say('remind me');
    expect(d.getState()).toMatchObject({ text: '', interim: 'remind me' });
    rec().say('remind me to email', false, 0);
    expect(d.getState().interim).toBe('remind me to email');
    rec().say('remind me to email the coach', true, 0);
    expect(d.getState()).toMatchObject({ text: 'remind me to email the coach', interim: '' });
    rec().say(' Friday'); // later results come with a leading space
    expect(d.getState()).toMatchObject({ text: 'remind me to email the coach', interim: 'Friday' });
    rec().say(' Friday', true, 1);
    expect(d.getState().text).toBe('remind me to email the coach Friday');
  });

  it('Stop asks the browser for its last words, then ends idle with the text kept', () => {
    const { d, rec } = rig();
    d.start();
    rec().say('add milk', true);
    rec().say('and eggs');
    d.stop();
    expect(d.getState().phase).toBe('stopping');
    expect(rec().stopped).toBe(1);
    rec().say('and eggs', true, 1);
    rec().end();
    expect(d.getState()).toMatchObject({ phase: 'idle', text: 'add milk and eggs', interim: '', error: null });
  });

  it('an interim result left over when it ends still counts (the person said it)', () => {
    const { d, rec } = rig();
    d.start(); rec().say('book the vet'); d.stop(); rec().end();
    expect(d.getState()).toMatchObject({ phase: 'idle', text: 'book the vet' });
  });

  it('a browser that never ends after Stop is let go after 2 s, keeping the words', () => {
    const { d, c, rec } = rig();
    d.start(); rec().say('call mum'); d.stop();
    c.advance(1_999);
    expect(d.getState().phase).toBe('stopping');
    c.advance(1);
    expect(d.getState()).toMatchObject({ phase: 'idle', text: 'call mum' });
    expect(rec().aborted).toBe(1);
  });

  it('hold: a press being held is marked; it can become a tap', () => {
    const { d } = rig();
    d.start({ hold: true });
    expect(d.getState().hold).toBe(true);
    d.setHold(false);
    expect(d.getState().hold).toBe(false);
    d.stop();
  });

  it('cancel (the sheet closed) stops at once and keeps no interim', () => {
    const { d, rec, c } = rig();
    d.start(); rec().say('half a');
    d.cancel();
    expect(d.getState()).toMatchObject({ phase: 'idle', interim: '' });
    expect(rec().aborted).toBe(1);
    expect(c.pending()).toBe(0); // the cap timer is gone too
  });

  it('a new press starts a new session with empty text', () => {
    const { d, rec } = rig();
    d.start(); rec().say('one', true); d.stop(); rec().end();
    d.start();
    expect(d.getState()).toMatchObject({ session: 2, text: '', phase: 'listening' });
  });
});

describe('P4 Dictation: continuous dictation and the cap', () => {
  it('the browser\'s silence cut-off: a fresh recogniser starts and the words carry on', () => {
    const { d, recs, rec } = rig();
    d.start();
    rec().say('first part', true);
    rec().end(); // Chrome ended the session after a silence
    expect(recs).toHaveLength(2);
    expect(rec().started).toBe(1);
    expect(d.getState()).toMatchObject({ phase: 'listening', text: 'first part' });
    rec().say('second part', true);
    expect(d.getState().text).toBe('first part second part');
    d.stop(); rec().end();
    expect(d.getState()).toMatchObject({ phase: 'idle', text: 'first part second part' });
  });

  it('silence after words is a pause, not an error (no-speech then restart)', () => {
    const { d, recs, rec, c } = rig();
    d.start(); rec().say('hello', true);
    c.advance(5_000);
    rec().error('no-speech');
    expect(d.getState()).toMatchObject({ phase: 'listening', error: null });
    expect(recs).toHaveLength(2);
  });

  it('three quick ends in a row with nothing heard stop it (no endless restarts)', () => {
    const { d, recs, rec } = rig();
    d.start();
    rec().end(); rec().end(); rec().end();
    expect(recs).toHaveLength(3);
    expect(d.getState()).toMatchObject({ phase: 'idle', error: 'no-speech' });
  });

  it('quick ends after words were heard stop quietly and keep the words', () => {
    const { d, rec, c } = rig();
    d.start(); c.advance(2_000); rec().say('keep this', true); rec().end();
    rec().end(); rec().end(); rec().end();
    expect(d.getState()).toMatchObject({ phase: 'idle', error: null, text: 'keep this' });
  });

  it('Android listens phrase by phrase (continuous off) and still restarts; a computer listens continuously', () => {
    const made: FakeRec[] = [];
    const a = makeDictation({ create: () => { const r = new FakeRec(); made.push(r); return r; }, platform: 'android' }).d;
    a.start();
    expect(made[0].continuous).toBe(false);
    made[0].say('one', true); made[0].end();
    expect(made).toHaveLength(2);
    expect(a.getState()).toMatchObject({ phase: 'listening', text: 'one' });
    a.cancel();
    const desk = makeDictation({ create: () => { const r = new FakeRec(); made.push(r); return r; }, platform: 'desktop' }).d;
    desk.start();
    expect(made[2].continuous).toBe(true);
    desk.cancel();
  });

  it('the 2-minute cap stops it by itself and says so', () => {
    const { d, c, rec } = rig();
    d.start(); rec().say('a long list', true);
    c.advance(VOICE_CAP_MS - 1);
    expect(d.getState().phase).toBe('listening');
    c.advance(1);
    expect(d.getState()).toMatchObject({ phase: 'stopping', capped: true });
    expect(rec().stopped).toBe(1);
    rec().end();
    expect(d.getState()).toMatchObject({ phase: 'idle', capped: true, text: 'a long list' });
    expect(CAP_MESSAGE).toContain('2 minutes');
    d.clearError();
    expect(d.getState().capped).toBe(false);
  });

  it('the cap covers the whole press across restarts', () => {
    const { d, c, rec } = rig({ capMs: 10_000 });
    d.start(); c.advance(6_000); rec().say('a', true); rec().end();
    c.advance(4_000);
    expect(d.getState().capped).toBe(true);
  });
});

describe('P4 Dictation: errors in plain words', () => {
  const cases: [string, string, RegExp][] = [
    ['not-allowed', 'permission', /I need permission to use the microphone/],
    ['service-not-allowed', 'service', /speech service isn’t available/],
    ['audio-capture', 'audio', /can’t hear a microphone/],
    ['network', 'network', /needs the internet/],
    ['language-not-supported', 'language', /can’t listen in that language/],
    ['bad-grammar', 'failed', /Voice stopped working/],
  ];
  for (const [code, err, words] of cases) {
    it(`${code} → ${err}, no restart`, () => {
      const { d, recs, rec } = rig();
      d.start(); rec().error(code);
      expect(d.getState()).toMatchObject({ phase: 'idle', error: err });
      expect(recs).toHaveLength(1);
      expect(voiceMessage(d.getState().error!)).toMatch(words);
    });
  }

  it('no speech at all → "I didn\'t catch that"', () => {
    const { d, recs, rec } = rig();
    d.start(); rec().error('no-speech');
    expect(d.getState()).toMatchObject({ phase: 'idle', error: 'no-speech' });
    expect(recs).toHaveLength(1);
    expect(voiceMessage('no-speech')).toBe('I didn’t catch that. Try again, a little closer to the microphone.');
  });

  it('"aborted" (our own cancel) is not an error', () => {
    const { d, rec } = rig();
    d.start(); rec().say('x', true); d.stop(); rec().onerror?.({ error: 'aborted' });
    expect(d.getState().error).toBeNull();
  });

  it('a recogniser that throws on start fails cleanly', () => {
    const c = clock();
    const d = new Dictation({ create: () => Object.assign(new FakeRec(), { throwOnStart: true }), support: 'ok', continuous: true, lang: () => 'en-US', setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, now: c.now });
    expect(d.start()).toBe(false);
    expect(d.getState()).toMatchObject({ phase: 'idle', error: 'failed' });
    expect(c.pending()).toBe(0);
  });

  it('a new press clears the last error; typing clears it too', () => {
    const { d, rec } = rig();
    d.start(); rec().error('not-allowed');
    d.clearError();
    expect(d.getState().error).toBeNull();
    d.start(); rec().error('not-allowed');
    d.start();
    expect(d.getState().error).toBeNull();
  });

  it('the permission message says how to allow it on Android, iPhone and a computer', () => {
    expect(voiceMessage('permission', 'android')).toMatch(/^I need permission to use the microphone\. On Android: .*Microphone › Allow/);
    expect(voiceMessage('permission', 'ios')).toMatch(/On iPhone: tap aA .*Microphone › Allow/);
    expect(voiceMessage('permission', 'desktop')).toMatch(/Microphone › Allow, then try again/);
    expect(voiceMessage('service', 'ios')).toMatch(/Dictation/);
  });
});

describe('P4 feature detection: unsupported and insecure', () => {
  function Ctor(this: unknown) { return new FakeRec(); }
  it('no SpeechRecognition (Firefox) → unsupported: start refuses with the plain reason', () => {
    expect(detectVoice({ isSecureContext: true, navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0' } }).support).toBe('unsupported');
    const d = new Dictation({ create: null, support: 'unsupported', continuous: true, lang: () => 'en-US' });
    expect(d.start()).toBe(false);
    expect(d.getState()).toMatchObject({ phase: 'idle', error: 'unsupported' });
    expect(voiceMessage('unsupported')).toMatch(/^Voice isn’t available in this browser — type instead/);
    expect(dictationApi(d).available).toBe(false);
  });
  it('webkitSpeechRecognition (Chrome, Safari) or SpeechRecognition → ok on a secure page', () => {
    const a = detectVoice({ webkitSpeechRecognition: Ctor as never, isSecureContext: true, navigator: {} });
    expect(a.support).toBe('ok');
    expect(a.create!()).toBeInstanceOf(FakeRec);
    expect(detectVoice({ SpeechRecognition: Ctor as never, isSecureContext: true, navigator: {} }).support).toBe('ok');
  });
  it('the API on a plain http page → insecure: the mic shows, and says to use the secure address', () => {
    const v = detectVoice({ webkitSpeechRecognition: Ctor as never, isSecureContext: false, navigator: {} });
    expect(v.support).toBe('insecure');
    const d = new Dictation({ create: v.create, support: v.support, continuous: true, lang: () => 'en-US' });
    expect(d.start()).toBe(false);
    expect(d.getState().error).toBe('insecure');
    expect(voiceMessage('insecure')).toMatch(/needs the secure address/);
    expect(dictationApi(d).available).toBe(true);
  });
  it('no window at all (server render) → unsupported', () => {
    expect(detectVoice(undefined).support).toBe('unsupported');
  });
  it('platforms: Android, iPhone, iPad (as a Mac with touch), a computer', () => {
    expect(voicePlatform({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/130' })).toBe('android');
    expect(voicePlatform({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1' })).toBe('ios');
    expect(voicePlatform({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', maxTouchPoints: 5 })).toBe('ios');
    expect(voicePlatform({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', maxTouchPoints: 0 })).toBe('desktop');
    expect(voicePlatform({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130' })).toBe('desktop');
  });
  it('the language: the one chosen, else the browser\'s, else en-US', () => {
    expect(voiceLang('fr-FR', { language: 'en-GB' })).toBe('fr-FR');
    expect(voiceLang('', { language: 'en-GB' })).toBe('en-GB');
    expect(voiceLang('', {})).toBe('en-US');
  });
});

describe('P4 the transcript into the text box: never sent by itself, sent as voice', () => {
  it('words go after what was typed; the box is only written, never sent', () => {
    const { d, rec } = rig();
    let track = NO_DRAFT; let box = 'Please';
    const step = () => { const r = trackDraft(track, d.getState(), box); track = r.track; if (r.text !== null) box = r.text; };
    d.start(); step();
    expect(track).toMatchObject({ session: 1, base: 'Please', spoken: false });
    rec().say('remind me', true); step();
    expect(box).toBe('Please remind me');
    rec().say('Friday', true); step();
    expect(box).toBe('Please remind me Friday');
    d.stop(); rec().end(); step();
    expect(d.getState().phase).toBe('idle');
    expect(box).toBe('Please remind me Friday');
    expect(track.spoken).toBe(true);
    // the person edits it; nothing from the finished press writes over the edit
    box = 'Please remind me Thursday'; step();
    expect(box).toBe('Please remind me Thursday');
  });

  it('a press that heard nothing leaves the box alone', () => {
    const { d, rec } = rig();
    let track = NO_DRAFT; const box = 'typed';
    d.start(); rec().error('no-speech');
    const r = trackDraft(track, d.getState(), box); track = r.track;
    expect(r.text).toBeNull();
    expect(track.spoken).toBe(false);
  });

  it('source: voice only for a spoken ask with words', () => {
    expect(voiceSource(true, 'remind me')).toEqual({ source: 'voice' });
    expect(voiceSource(false, 'remind me')).toEqual({});
    expect(voiceSource(true, '   ')).toEqual({});
  });

  it('POST /ask with source voice is accepted and recorded (fixture server, as the real server: A6)', async () => {
    const fx = new FixtureServer('N00'); fx.answerDelay = -1;
    const calls: { path: string; body: unknown }[] = [];
    const f = fixtureFetch(fx);
    const client = new MwaClient({ fetch: (async (u: RequestInfo | URL, init?: RequestInit) => { calls.push({ path: new URL(String(u), 'http://x').pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined }); return f(u, init); }) as typeof fetch });
    const r = await client.ask({ text: 'remind me to email the coach Friday', ...voiceSource(true, 'remind me to email the coach Friday') });
    expect(r).toBeTruthy();
    const post = calls.find((c) => c.path.endsWith('/ask'));
    expect(post?.body).toMatchObject({ text: 'remind me to email the coach Friday', source: 'voice' });
  });
});

describe('P4 Settings → Voice: per device', () => {
  beforeEach(() => resetVoicePrefsCache());
  it('defaults on, the browser\'s language; bad values fall back', () => {
    expect(parseVoicePrefs(null)).toEqual({ on: true, lang: '' });
    expect(parseVoicePrefs('{"on":false,"lang":"fr-FR"}')).toEqual({ on: false, lang: 'fr-FR' });
    expect(parseVoicePrefs('{"lang":"<script>"}')).toEqual({ on: true, lang: '' });
    expect(parseVoicePrefs('not json')).toEqual({ on: true, lang: '' });
  });
  it('kept in this device\'s storage', () => {
    const m = new Map<string, string>();
    const s = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
    writeVoicePrefs({ on: false }, s);
    expect(JSON.parse(m.get(VOICE_PREFS_KEY)!)).toEqual({ on: false, lang: '' });
    resetVoicePrefsCache();
    expect(readVoicePrefs(s)).toEqual({ on: false, lang: '' });
    resetVoicePrefsCache();
  });
  it('the privacy note says what the browser does and that MWA only receives the text', () => {
    expect(VOICE_PRIVACY).toBe('Your browser’s speech service turns your voice into text (on Android and Chrome this may use Google’s servers). MWA only receives the text.');
  });
});

describe('P4 the mic and the listening panel (rendered)', () => {
  const html = (el: ReturnType<typeof h>) => renderToStaticMarkup(el);
  it('the mic is "Hold to talk", aria-pressed while listening', () => {
    const { d, rec } = rig();
    expect(html(h(MicButton, { d: dictationApi(d), className: 'micbtn' }))).toContain(`aria-label="${MIC_NAME}"`);
    expect(html(h(MicButton, { d: dictationApi(d), className: 'micbtn' }))).toContain('aria-pressed="false"');
    d.start(); rec().say('hello');
    const on = html(h(MicButton, { d: dictationApi(d), className: 'micbtn' }));
    expect(on).toContain('aria-pressed="true"');
    expect(on).toContain('listening');
  });
  it('listening: "Listening…", the words in a polite live region, and Stop', () => {
    const { d, rec } = rig();
    d.start(); rec().say('remind me', true); rec().say('to call');
    const out = html(h(VoicePanel, { d: dictationApi(d) }));
    expect(out).toContain('Listening…');
    expect(out).toMatch(/aria-live="polite"[^>]*>to call</);
    expect(out).toContain('>Stop</button>');
  });
  it('an error shows as an alert in plain words; the cap as a status', () => {
    const { d, rec, c } = rig();
    d.start(); rec().error('not-allowed');
    expect(html(h(VoicePanel, { d: dictationApi(d, { platform: 'android' }) }))).toMatch(/role="alert"[^>]*>I need permission to use the microphone\. On Android/);
    d.start(); c.advance(VOICE_CAP_MS); rec().end();
    expect(html(h(VoicePanel, { d: dictationApi(d) }))).toMatch(/role="status"[^>]*>I stopped listening after 2 minutes/);
  });

  function sheet(d: ReturnType<typeof dictationApi>) {
    const fx = new FixtureServer('N00'); fx.answerDelay = -1;
    const store = new V2Store({ client: new MwaClient({ fetch: fixtureFetch(fx) }), cache: new MemoryCache(), stream: () => { throw new Error('no stream'); }, now: () => FIXTURE_NOW, fixtures: true });
    return renderToStaticMarkup(h(StoreProvider, { store }, h(AskSheet, { open: false, about: null, onClose: () => {}, dictation: d })));
  }
  it('the Ask sheet: the mic when voice works; none when unsupported or turned off', () => {
    const { d } = rig();
    expect(sheet(dictationApi(d))).toContain('aria-label="Hold to talk"');
    expect(sheet(dictationApi(d))).toContain('Tap to talk and tap again to stop');
    const none = new Dictation({ create: null, support: 'unsupported', continuous: true, lang: () => 'en-US' });
    expect(sheet(dictationApi(none))).not.toContain('Hold to talk');
    expect(sheet(dictationApi(d, { on: false }))).not.toContain('Hold to talk');
  });
  it('the Ask sheet while listening: the mic pressed, Stop, no Send, the box read-only until it stops', () => {
    const { d, rec } = rig();
    d.start(); rec().say('remind me');
    const out = sheet(dictationApi(d));
    expect(out).toContain('aria-pressed="true"');
    expect(out).toContain('>Stop</button>');
    expect(out).not.toContain('aria-label="Send"');
    expect(out).toMatch(/id="ask-input"[^>]*readOnly|readonly[^>]*id="ask-input"|<input[^>]*readonly=""[^>]*id="ask-input"/i);
  });
});

it('joinWords tidies spaces', () => {
  expect(joinWords(' a ', '', ' b  c', undefined)).toBe('a b c');
});
