/**
 * The mic (v2 build, slice P4), as approved (prototype-v2 N08; REPLAY-NOTES: the mic is `button "Hold to talk"`, in
 * the Ask bar as `#dock-mic` and in the Ask sheet). Two ways to talk, both ending with the words in the text box to
 * check and send — never sent by themselves:
 *   - tap: starts listening; tap again (or Stop) stops;
 *   - press and hold: listens while held; letting go stops.
 * With a keyboard (or a screen reader) Space or Enter toggles. While listening the button is `aria-pressed="true"`,
 * rings (still, with reduced motion), and the panel above the text box shows "Listening…", the words so far in a
 * polite live region, and a Stop button.
 */
import { useEffect, useRef, type KeyboardEvent, type PointerEvent as RPointerEvent, type MouseEvent as RMouseEvent, type RefObject } from 'react';
import { Mic } from '../../../shell/icons';
import { CAP_MESSAGE, HOLD_MS, voiceMessage } from './dictation';
import type { DictationApi } from './useDictation';
import './voice.css';

export const MIC_NAME = 'Hold to talk';
export const MIC_HINT = 'Tap to talk and tap again to stop, or press and hold and let go to stop. Your words go in the box for you to check and send.';

/**
 * Pointer and keyboard handling shared by the dock mic and the sheet mic. `before` runs before listening starts (the
 * dock opens the Ask sheet). Letting go anywhere after a long press stops (the sheet opens over the dock's mic).
 */
export function useMicPress(d: DictationApi, before?: () => void) {
  const press = useRef<{ at: number; stopOnUp: boolean } | null>(null);
  const dRef = useRef(d); dRef.current = d;
  useEffect(() => {
    const up = () => {
      const p = press.current;
      if (!p) return;
      press.current = null;
      const cur = dRef.current;
      if (p.stopOnUp) { cur.stop(); return; }
      if (Date.now() - p.at >= HOLD_MS) cur.stop(); // a hold: letting go stops
      else cur.setHold(false); // a tap: keep listening until the next tap or Stop
    };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => { window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
  }, []);
  return {
    onPointerDown: (e: RPointerEvent<HTMLButtonElement>) => {
      if (e.button > 0) return;
      e.preventDefault(); // no text selection or long-press menu
      if (d.listening) { press.current = { at: Date.now(), stopOnUp: true }; return; }
      before?.();
      press.current = { at: Date.now(), stopOnUp: false };
      d.start({ hold: true });
    },
    // keyboard (Enter, Space) and assistive tech send a click with no pointer press: toggle
    onClick: (e: RMouseEvent<HTMLButtonElement>) => {
      if (e.detail !== 0) return;
      if (d.listening) { d.stop(); return; }
      before?.();
      d.start({ hold: false });
    },
    // a held Enter repeats: one press is one toggle
    onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => { if (e.repeat && (e.key === 'Enter' || e.key === ' ')) e.preventDefault(); },
    onContextMenu: (e: RMouseEvent) => e.preventDefault(),
  };
}

export function MicButton({ d, id, className, before, describedBy }: { d: DictationApi; id?: string; className: string; before?: () => void; describedBy?: string }) {
  const h = useMicPress(d, before);
  return (
    <button type="button" id={id} className={`${className}${d.listening ? ' listening' : ''}`} aria-label={MIC_NAME} aria-pressed={d.listening}
      aria-describedby={describedBy} {...h}>
      <Mic size={className.includes('micbtn') ? 22 : 20} />
    </button>
  );
}

/** Above the text box: listening (live words, Stop), or why voice did not work. */
export function VoicePanel({ d, stopRef }: { d: DictationApi; stopRef?: RefObject<HTMLButtonElement> }) {
  const s = d.state;
  const listening = d.listening;
  const note = s.error ? voiceMessage(s.error, d.platform) : s.capped ? CAP_MESSAGE : null;
  return (
    <>
      {/* always in the page, so a screen reader hears the words as they come */}
      <div className="voice-live sr-only" aria-live="polite" aria-atomic="false" id="voice-live">{listening ? s.interim : ''}</div>
      {listening && (
        <div className="ask-listen voice-listen" id="ask-listen">
          <span className="pulse" aria-hidden="true" />
          <span className="voice-words" aria-hidden="true">
            {s.phase === 'stopping' ? 'Finishing…' : 'Listening…'}
            {(s.text || s.interim) && <> <span className="voice-heard">{s.text}</span> <span className="voice-interim">{s.interim}</span></>}
          </span>
          <button type="button" ref={stopRef} className="vbtn vbtn-quiet voice-stop" onClick={() => d.stop()} disabled={s.phase === 'stopping'}>Stop</button>
        </div>
      )}
      {!listening && note && (
        <p className={`ask-note voice-note${s.error ? ' error' : ''}`} role={s.error ? 'alert' : 'status'} id="voice-note">{note}</p>
      )}
    </>
  );
}
