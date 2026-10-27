/**
 * Settings → Voice (v2 build, slice P4): on or off and the language, for this device only; whether this browser can
 * listen at all; and what happens to the sound. What each browser does (checked 2026-10):
 *   - Chrome (computer and Android): the Web Speech API sends the audio to Google's speech servers. On Android it goes
 *     through the phone's Google speech service, which may work on the device for some languages.
 *   - Edge: Microsoft's online speech service.
 *   - Safari (iPhone, iPad, Mac): Apple's speech recognition (Siri & Dictation); some on the device, some on Apple's
 *     servers.
 *   - Firefox: no speech recognition, so no mic.
 * In every case MWA never gets the sound, only the text the browser hands back.
 */
import { useState } from 'react';
import { detectVoice, voiceLang } from './dictation';
import { VOICE_LANGS } from './prefs';
import { useVoicePrefs } from './useDictation';

export const VOICE_PRIVACY = 'Your browser’s speech service turns your voice into text (on Android and Chrome this may use Google’s servers). MWA only receives the text.';
export const VOICE_PRIVACY_MORE = 'Chrome sends the sound to Google, Edge to Microsoft, and Safari on iPhone and Mac to Apple (some is done on the device). MWA never gets the sound; it only notes that an ask was spoken.';

export function VoiceSettings() {
  const [prefs, setPrefs] = useVoicePrefs();
  const [{ support }] = useState(() => detectVoice());
  const browserLang = voiceLang('', typeof navigator !== 'undefined' ? navigator : undefined);
  const status = support === 'unsupported' ? 'Voice isn’t available in this browser — type instead. It works in Chrome, Edge and Safari.'
    : support === 'insecure' ? 'Voice needs the secure address (the one that starts with https://). Open MWA from that link to talk to it.'
      : prefs.on ? 'On for this device. Tap or hold the mic when you ask.' : 'Off for this device. The mic is hidden.';
  return (
    <section aria-labelledby="set-voice" id="sec-voice" className="setsec">
      <h2 className="sh" id="set-voice">Voice</h2>
      <div className="card setcard">
        <div className="setrow">
          <div className="grow">
            <span className="rowtitle" id="sw-voice">Talk to your helper</span>
            <span className="s" id="sw-voice-note">{status}</span>
          </div>
          {support !== 'unsupported' ? (
            <button type="button" className="switch" role="switch" id="voice-switch" aria-checked={prefs.on} aria-labelledby="sw-voice" aria-describedby="sw-voice-note"
              onClick={() => setPrefs({ on: !prefs.on })} />
          ) : <span className="onoff">Not available</span>}
        </div>
        {support !== 'unsupported' && (
          <div className="setrow col voice-langrow">
            <label className="rowtitle" htmlFor="voice-lang">Language I listen for</label>
            <select id="voice-lang" className="setinput" value={prefs.lang} disabled={!prefs.on} onChange={(e) => setPrefs({ lang: e.target.value })} aria-describedby="voice-lang-help">
              <option value="">Same as this browser ({browserLang})</option>
              {VOICE_LANGS.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
            </select>
            <span className="s" id="voice-lang-help">Speak in this language. Not every browser knows every language.</span>
          </div>
        )}
        <p className="soft" id="voice-privacy">{VOICE_PRIVACY}</p>
        <p className="soft">{VOICE_PRIVACY_MORE}</p>
      </div>
    </section>
  );
}
