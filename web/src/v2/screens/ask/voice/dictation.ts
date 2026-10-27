/**
 * Voice input (v2 build, slice P4): the browser's own speech recognition (Web Speech API, `SpeechRecognition` /
 * `webkitSpeechRecognition`) turns speech into text on the device's side; MWA only ever receives the text, sent with
 * the ask as `source: 'voice'` (A6). Server speech (`POST /speech`) is a later flag and is not here.
 *
 * `Dictation` is a plain controller with no React and no globals, so it runs in node tests with a fake recogniser:
 *   - interim and final results; the text of one press is every final result plus, at the end, any interim left over;
 *   - continuous dictation: the browser ends a session on its own after a silence (Chrome ~ 8–10 s, Android after each
 *     phrase, Safari after a pause). While the person still wants to talk it starts a fresh session and keeps the
 *     text. Three quick ends in a row with nothing heard stop it (no endless restart loop);
 *   - a 2-minute cap (`capMs`): it stops by itself and says so;
 *   - errors mapped to plain reasons (`VoiceError`), never a restart after a refusal;
 *   - feature detection (`detectVoice`): no API → unsupported (Firefox); the API but not a secure context (plain
 *     http on a phone) → insecure, since every browser refuses the microphone there.
 */

export type VoiceSupport = 'ok' | 'unsupported' | 'insecure';
export type VoiceError = 'permission' | 'service' | 'no-speech' | 'audio' | 'network' | 'language' | 'unsupported' | 'insecure' | 'failed';
export type DictationPhase = 'idle' | 'listening' | 'stopping';
export type VoicePlatform = 'android' | 'ios' | 'desktop';

export interface DictationState {
  phase: DictationPhase;
  /** what has been heard this press: final results (and, once it ends, any interim left over) */
  text: string;
  /** what the browser is still unsure of: shown live, not yet in the text */
  interim: string;
  error: VoiceError | null;
  /** it stopped by itself at the 2-minute cap */
  capped: boolean;
  /** one number per press of the mic: the Ask sheet uses it to know which text is whose */
  session: number;
  /** started by a press that is being held (letting go stops it) */
  hold: boolean;
}

/** The parts of the Web Speech API's SpeechRecognition this uses (and that a test fake provides). */
export interface RecognitionAlternativeLike { transcript: string }
export interface RecognitionResultLike { readonly isFinal: boolean; readonly length: number; readonly [i: number]: RecognitionAlternativeLike }
export interface RecognitionEventLike { readonly resultIndex: number; readonly results: { readonly length: number; readonly [i: number]: RecognitionResultLike } }
export interface RecognizerLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: RecognitionEventLike) => void) | null;
  onerror: ((e: { error: string; message?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export interface DictationEnv {
  /** makes a recogniser; null when the browser has none */
  create: (() => RecognizerLike) | null;
  support: VoiceSupport;
  /** the language to listen for, read at each start (Settings → Voice can change it) */
  lang: () => string;
  /** false on Android: Chrome there repeats earlier words in continuous mode, so it listens phrase by phrase */
  continuous: boolean;
  capMs?: number;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (t: unknown) => void;
}

export const VOICE_CAP_MS = 120_000;
/** a press longer than this is a hold: letting go stops listening. A shorter one is a tap: tap again to stop. */
export const HOLD_MS = 450;
/** how long to wait for the browser's last words after Stop before giving up on them */
const STOP_GRACE_MS = 2_000;
/** a session that ends this soon with nothing heard counts as a quick end; three in a row stop it */
const QUICK_END_MS = 1_000;
const MAX_QUICK_ENDS = 3;

const IDLE: DictationState = { phase: 'idle', text: '', interim: '', error: null, capped: false, session: 0, hold: false };

/** Words joined with single spaces (browsers put a leading space on later results in continuous mode). */
export function joinWords(...parts: (string | undefined | null)[]): string {
  return parts.map((p) => (p ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ');
}

export class Dictation {
  private st: DictationState = IDLE;
  private listeners = new Set<() => void>();
  private rec: RecognizerLike | null = null;
  /** this recogniser's results by index (a later event can change an earlier interim result) */
  private segs: { text: string; final: boolean }[] = [];
  /** the text of earlier recognisers in this press (before an automatic restart) */
  private committed = '';
  private heard = false;
  private heardThisRound = false;
  private want = false;
  private quickEnds = 0;
  private startedAt = 0;
  private capTimer: unknown = null;
  private stopTimer: unknown = null;
  private seq = 0;

  constructor(private env: DictationEnv) {}

  get support(): VoiceSupport { return this.env.support; }
  getState = (): DictationState => this.st;
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };

  private set(p: Partial<DictationState>) {
    this.st = { ...this.st, ...p };
    for (const fn of [...this.listeners]) fn();
  }
  private now() { return (this.env.now ?? Date.now)(); }
  private later(fn: () => void, ms: number) { return (this.env.setTimeout ?? ((f, m) => setTimeout(f, m)))(fn, ms); }
  private clear(t: unknown) { if (t != null) (this.env.clearTimeout ?? ((x) => clearTimeout(x as ReturnType<typeof setTimeout>)))(t); }

  /** Start listening. Returns false (with `error` set) when it cannot. Starting while listening does nothing. */
  start(o: { hold?: boolean } = {}): boolean {
    if (this.st.phase !== 'idle') return true;
    if (this.env.support !== 'ok' || !this.env.create) {
      this.set({ error: this.env.support === 'insecure' ? 'insecure' : 'unsupported', interim: '', capped: false });
      return false;
    }
    this.seq++;
    this.committed = ''; this.segs = []; this.heard = false; this.want = true; this.quickEnds = 0;
    this.set({ phase: 'listening', text: '', interim: '', error: null, capped: false, session: this.seq, hold: !!o.hold });
    this.capTimer = this.later(() => { this.capTimer = null; if (this.st.phase === 'listening') { this.set({ capped: true }); this.stop(); } }, this.env.capMs ?? VOICE_CAP_MS);
    return this.open();
  }

  /** A press that began as a hold is now a tap (or the other way round). */
  setHold(hold: boolean) { if (this.st.phase === 'listening' && this.st.hold !== hold) this.set({ hold }); }

  private open(): boolean {
    let r: RecognizerLike;
    try { r = this.env.create!(); } catch { this.fail('unsupported'); return false; }
    try {
      r.lang = this.env.lang();
      r.continuous = this.env.continuous;
      r.interimResults = true;
      r.maxAlternatives = 1;
    } catch { /* a recogniser without one of these still works */ }
    this.segs = []; this.heardThisRound = false;
    r.onresult = (e) => { if (r === this.rec) this.onResult(e); };
    r.onerror = (e) => { if (r === this.rec) this.onError(String(e?.error ?? '')); };
    r.onend = () => { if (r === this.rec) this.onEnd(); };
    this.rec = r;
    this.startedAt = this.now();
    try { r.start(); } catch { this.fail('failed'); return false; }
    return true;
  }

  private onResult(e: RecognitionEventLike) {
    const results = e.results;
    for (let i = Math.max(0, e.resultIndex | 0); i < results.length; i++) {
      const res = results[i];
      if (!res) continue;
      const text = res.length > 0 && res[0] ? String(res[0].transcript ?? '') : '';
      this.segs[i] = { text, final: !!res.isFinal };
      if (text.trim()) { this.heard = true; this.heardThisRound = true; }
    }
    this.publish();
  }

  private publish() {
    const finals = this.segs.filter((s) => s && s.final).map((s) => s.text);
    const interim = this.segs.filter((s) => s && !s.final).map((s) => s.text);
    this.set({ text: joinWords(this.committed, ...finals), interim: joinWords(...interim) });
  }

  /** The recogniser ended: keep everything it heard (an interim result left over counts: the person said it). */
  private commit() {
    this.committed = joinWords(this.committed, ...this.segs.filter(Boolean).map((s) => s.text));
    this.segs = [];
  }

  private onError(code: string) {
    switch (code) {
      case 'aborted': return; // we stopped it
      case 'no-speech':
        // silence at the start of a press is "I didn't catch that"; silence after words is a pause: carry on
        if (!this.heard) this.fail('no-speech');
        return;
      case 'not-allowed': return this.fail(this.env.support === 'insecure' ? 'insecure' : 'permission');
      case 'service-not-allowed': return this.fail('service');
      case 'audio-capture': return this.fail('audio');
      case 'network': return this.fail('network');
      case 'language-not-supported': return this.fail('language');
      default: return this.fail('failed');
    }
  }

  private onEnd() {
    this.commit();
    this.rec = null;
    if (this.want && this.st.phase === 'listening') {
      const quick = this.now() - this.startedAt < QUICK_END_MS && !this.heardThisRound;
      this.quickEnds = quick ? this.quickEnds + 1 : 0;
      if (this.quickEnds >= MAX_QUICK_ENDS) {
        if (this.heard) this.finish(); else this.fail('no-speech');
        return;
      }
      this.publish();
      this.open(); // the browser's silence cut-off: keep listening
      return;
    }
    this.finish();
  }

  /** Stop listening and keep the words (the browser sends its last result, then ends). */
  stop() {
    if (this.st.phase !== 'listening') return;
    this.want = false;
    const r = this.rec;
    if (!r) { this.finish(); return; }
    this.set({ phase: 'stopping' });
    try { r.stop(); } catch { this.commit(); this.rec = null; this.finish(); return; }
    this.clear(this.stopTimer);
    this.stopTimer = this.later(() => {
      this.stopTimer = null;
      if (this.st.phase !== 'stopping' || this.rec !== r) return;
      // the browser never ended: keep what it had, and drop it
      this.commit(); this.rec = null;
      try { r.abort(); } catch { /* gone */ }
      this.finish();
    }, STOP_GRACE_MS);
  }

  /** Stop at once without waiting for the last words (the sheet was closed). Keeps nothing pending. */
  cancel() {
    this.want = false;
    const r = this.rec;
    this.rec = null;
    if (r) { try { r.abort(); } catch { /* gone */ } }
    this.clear(this.capTimer); this.capTimer = null;
    this.clear(this.stopTimer); this.stopTimer = null;
    if (this.st.phase !== 'idle' || this.st.interim) this.set({ phase: 'idle', interim: '', hold: false });
  }

  clearError() { if (this.st.error || this.st.capped) this.set({ error: null, capped: false }); }

  private finish() {
    this.clear(this.capTimer); this.capTimer = null;
    this.clear(this.stopTimer); this.stopTimer = null;
    this.want = false;
    this.set({ phase: 'idle', text: this.committed, interim: '', hold: false });
  }

  private fail(error: VoiceError) {
    this.want = false;
    const r = this.rec;
    this.commit();
    this.rec = null;
    if (r) { try { r.abort(); } catch { /* gone */ } }
    this.clear(this.capTimer); this.capTimer = null;
    this.clear(this.stopTimer); this.stopTimer = null;
    this.set({ phase: 'idle', text: this.committed, interim: '', error, hold: false });
  }
}

// ---------- the browser ----------

type RecognizerCtor = new () => RecognizerLike;
interface VoiceWindow {
  SpeechRecognition?: RecognizerCtor;
  webkitSpeechRecognition?: RecognizerCtor;
  isSecureContext?: boolean;
  navigator?: { userAgent?: string; language?: string; maxTouchPoints?: number; platform?: string };
}

export function voicePlatform(nav?: { userAgent?: string; maxTouchPoints?: number; platform?: string }): VoicePlatform {
  const ua = nav?.userAgent ?? '';
  if (/Android/i.test(ua)) return 'android';
  // iPadOS reports itself as a Mac: a Mac with touch is an iPad
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && (nav?.maxTouchPoints ?? 0) > 1)) return 'ios';
  return 'desktop';
}

/** What this browser can do: the recogniser (if any), and whether it may use the microphone here. */
export function detectVoice(w: VoiceWindow | undefined = typeof window !== 'undefined' ? (window as unknown as VoiceWindow) : undefined): { support: VoiceSupport; create: (() => RecognizerLike) | null; platform: VoicePlatform } {
  const Ctor = w?.SpeechRecognition ?? w?.webkitSpeechRecognition;
  const platform = voicePlatform(w?.navigator);
  if (typeof Ctor !== 'function') return { support: 'unsupported', create: null, platform };
  const create = () => new Ctor();
  if (w?.isSecureContext === false) return { support: 'insecure', create, platform };
  return { support: 'ok', create, platform };
}

/** The language to listen for: the one chosen in Settings → Voice, else this browser's. */
export function voiceLang(chosen: string, nav?: { language?: string }): string {
  return chosen || nav?.language || 'en-US';
}

// ---------- plain words ----------

const ALLOW: Record<VoicePlatform, string> = {
  android: 'On Android: tap the icon left of the address › Permissions › Microphone › Allow. In the installed app: Settings › Apps › MWA › Permissions › Microphone.',
  ios: 'On iPhone: tap aA in the address bar › Website Settings › Microphone › Allow. Also check Settings › Privacy & Security › Speech Recognition.',
  desktop: 'Click the icon left of the address › Microphone › Allow, then try again.',
};

/** What went wrong, in plain words, for the person (shown under the text box). */
export function voiceMessage(e: VoiceError, platform: VoicePlatform = 'desktop'): string {
  switch (e) {
    case 'permission': return `I need permission to use the microphone. ${ALLOW[platform]}`;
    case 'service': return platform === 'ios'
      ? 'Voice is switched off on this device. Turn on Dictation (Settings › General › Keyboard), or type instead.'
      : 'This browser’s speech service isn’t available right now. Type instead, or try again later.';
    case 'no-speech': return 'I didn’t catch that. Try again, a little closer to the microphone.';
    case 'audio': return 'I can’t hear a microphone. Check one is connected and not in use by another app.';
    case 'network': return 'Voice needs the internet: your browser’s speech service couldn’t be reached. Type instead, or try again.';
    case 'language': return 'This browser can’t listen in that language. Choose another in Settings › Voice, or type instead.';
    case 'unsupported': return 'Voice isn’t available in this browser — type instead. It works in Chrome, Edge and Safari.';
    case 'insecure': return 'Voice needs the secure address (the one that starts with https://). Open MWA from that link to talk to it.';
    default: return 'Voice stopped working just then. Try again, or type instead.';
  }
}

export const CAP_MESSAGE = 'I stopped listening after 2 minutes. Check the text, then tap the mic to keep going.';
