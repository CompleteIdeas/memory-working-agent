/**
 * React side of voice input (v2 build, slice P4).
 *
 *   useVoicePrefs()   Settings → Voice (on/off, language), per device.
 *   useDictation()    one Dictation controller for the app (made once, in the shell): its state, start/stop/cancel,
 *                     and whether to show a mic at all (`available`: voice on and the browser has speech recognition;
 *                     an insecure page still shows the mic, which then says to use the secure address).
 *   useVoiceDraft()   the Ask sheet's text box and the transcript: the words heard go after whatever was typed, live,
 *                     and the ask is marked spoken (`source: 'voice'`) until the box is cleared or sent. Never sends.
 *
 * `create` (and `env`) can be injected: tests use a fake recogniser, the browser uses SpeechRecognition.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Dictation, detectVoice, voiceLang, joinWords, type DictationEnv, type DictationState, type RecognizerLike, type VoicePlatform, type VoiceSupport } from './dictation';
import { readVoicePrefs, subscribeVoicePrefs, writeVoicePrefs, type VoicePrefs } from './prefs';

export function useVoicePrefs(): [VoicePrefs, (p: Partial<VoicePrefs>) => void] {
  const prefs = useSyncExternalStore(subscribeVoicePrefs, () => readVoicePrefs(), () => readVoicePrefs());
  return [prefs, useCallback((p: Partial<VoicePrefs>) => writeVoicePrefs(p), [])];
}

export interface DictationApi {
  state: DictationState;
  support: VoiceSupport;
  platform: VoicePlatform;
  /** voice is on in Settings and the browser has a recogniser */
  available: boolean;
  listening: boolean;
  start: (o?: { hold?: boolean }) => boolean;
  stop: () => void;
  cancel: () => void;
  setHold: (hold: boolean) => void;
  clearError: () => void;
}

export function makeDictation(o: { create?: (() => RecognizerLike) | null; support?: VoiceSupport; platform?: VoicePlatform; env?: Partial<DictationEnv> } = {}): { d: Dictation; platform: VoicePlatform } {
  const found = detectVoice();
  const create = o.create !== undefined ? o.create : found.create;
  const support: VoiceSupport = o.support ?? (o.create !== undefined ? (o.create ? 'ok' : 'unsupported') : found.support);
  const platform = o.platform ?? found.platform;
  const d = new Dictation({
    create, support, continuous: platform !== 'android',
    lang: () => voiceLang(readVoicePrefs().lang, typeof navigator !== 'undefined' ? navigator : undefined),
    ...o.env,
  });
  return { d, platform };
}

export function useDictation(o?: Parameters<typeof makeDictation>[0]): DictationApi {
  // made once: the dock and the Ask sheet share it
  const { d, platform } = useMemo(() => makeDictation(o), []); // eslint-disable-line react-hooks/exhaustive-deps
  const state = useSyncExternalStore(d.subscribe, d.getState, d.getState);
  const [prefs] = useVoicePrefs();
  useEffect(() => () => d.cancel(), [d]);
  // voice turned off while listening: stop
  useEffect(() => { if (!prefs.on) d.cancel(); }, [prefs.on, d]);
  return useMemo(() => dictationApi(d, { platform, on: prefs.on, state }), [d, platform, prefs.on, state]);
}

/** The API over one controller, outside React too (tests render the Ask sheet with a fake recogniser through it). */
export function dictationApi(d: Dictation, o: { platform?: VoicePlatform; on?: boolean; state?: DictationState } = {}): DictationApi {
  const state = o.state ?? d.getState();
  return {
    state, support: d.support, platform: o.platform ?? 'desktop',
    available: (o.on ?? true) && d.support !== 'unsupported',
    listening: state.phase !== 'idle',
    start: (x?: { hold?: boolean }) => d.start(x),
    stop: () => d.stop(),
    cancel: () => d.cancel(),
    setHold: (h: boolean) => d.setHold(h),
    clearError: () => d.clearError(),
  };
}

/** Where a press's words go: after the text that was in the box when the press began. */
export interface DraftTrack { session: number; base: string; spoken: boolean; /** the words last put in the box */ heard: string }
export const NO_DRAFT: DraftTrack = { session: 0, base: '', spoken: false, heard: '' };

/**
 * One step of the transcript into the text box (pure, for tests): given the dictation state and the box's value now,
 * the next track and the text to put in the box (null: leave the box alone). It only ever writes the box; sending
 * is the person's tap.
 */
export function trackDraft(t: DraftTrack, st: Pick<DictationState, 'session' | 'text' | 'phase'>, box: string): { track: DraftTrack; text: string | null } {
  let track = t;
  if (st.session !== t.session) {
    if (st.phase === 'idle' && !st.text) return { track, text: null }; // nothing from that press
    track = { ...t, session: st.session, base: box, heard: '' };
  }
  // only new words write the box: an edit after the press is the person's
  if (!st.text || st.text === track.heard) return { track, text: null };
  return { track: { ...track, spoken: true, heard: st.text }, text: joinWords(track.base, st.text) };
}

/** The ask's `source`: 'voice' when its words came from the mic (A6 records it on the ask and the turn). */
export function voiceSource(spoken: boolean, words: string): { source: 'voice' } | Record<string, never> {
  return spoken && words.trim() ? { source: 'voice' } : {};
}

/**
 * The transcript in the Ask sheet's text box. `textRef` holds the box's value now (the sheet resets it when it opens),
 * so a press adds its words after what was there. Returns whether the draft was spoken, and `reset` for after Send.
 */
export function useVoiceDraft(d: DictationApi, textRef: { current: string }, setText: (t: string) => void, text: string) {
  // a press from before this sheet existed is not this draft's
  const track = useRef<DraftTrack>({ ...NO_DRAFT, session: d.state.session });
  const [spoken, setSpoken] = useState(false);
  const { session, text: heard, phase } = d.state;
  useEffect(() => {
    const r = trackDraft(track.current, { session, text: heard, phase }, textRef.current);
    track.current = r.track;
    if (r.text !== null) { setText(r.text); setSpoken(true); }
  }, [session, heard, phase]); // eslint-disable-line react-hooks/exhaustive-deps
  // an emptied box is no longer a spoken ask
  // (on the person's edit only: when a press ends, its words arrive in the same render as the end)
  const idle = phase === 'idle';
  const idleRef = useRef(idle); idleRef.current = idle;
  useEffect(() => { if (!text.trim() && idleRef.current) { setSpoken(false); track.current = { ...track.current, spoken: false }; } }, [text]);
  const reset = useCallback(() => { setSpoken(false); track.current = { ...track.current, base: '', spoken: false }; }, []);
  return { spoken, reset };
}
