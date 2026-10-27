/**
 * One row of "Worth a look" (v2 build, slice W3), as approved: a source mark, who it is from, a time, the title, one
 * line on why it matters, and at most one action — filled only when it needs the person. Swipe left (touch, or a
 * mouse drag) and the row turns into a tray with Not important and Handled; the keyboard path is the row itself
 * (it opens the item, with Mark handled and Not important).
 *
 * Trust: an item's title, why and sender are someone else's words (`trust: untrusted`): plain text, no links. The
 * sender's address shows beside the name on anything from outside. A phishing item gets the caution style (the warning
 * tokens, never the orange that means "needs you"), the server's fixed words, and only Open and Not important. An
 * unverified urgent one gets a quieter "unverified sender" tag.
 */
import { useEffect, useRef, type PointerEvent as RPointerEvent } from 'react';
import type { ImportantItem } from '../../api/client';
import { CheckIcon, SourceIcon, WarnIcon } from './icons';
import { showName } from '../../store/text';

const DAY = 86_400_000;
const startOfDay = (ms: number) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
/** "7:12 AM" today, "Yesterday", "Sat" this week, "Nov 3" before that. */
export function itemTime(ts: number, now: number): string {
  const d0 = startOfDay(now), d = startOfDay(ts);
  if (d >= d0) return new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (d >= d0 - DAY) return 'Yesterday';
  if (d >= d0 - 6 * DAY) return new Date(ts).toLocaleDateString('en-US', { weekday: 'short' });
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** The words for the phishing caution: fixed, never the message's own. */
export const PHISHING_HEAD = 'This may not be who it says it is';
export const PHISHING_TEXT = 'Don’t reply with personal details. If you’re unsure, check with the company in its own app or website.';

/** Whether the row shows its action as a button: Open on an email duplicates the row itself, so it is left out. */
export function rowAction(it: ImportantItem): ImportantItem['action'] {
  if (!it.action || it.caution === 'phishing') return null;
  if (it.action.kind === 'review-reply') return null;
  return it.action;
}
/** An action that needs the person (adds to the calendar, drafts a note) is filled; a reminder or a link is outlined. */
const primaryAction = (it: ImportantItem) => it.action?.kind === 'add-to-calendar' || it.action?.kind === 'draft-note' || it.action?.kind === 'review-approval' || it.action?.kind === 'reconnect';

/**
 * Who it is from: the name (which never holds an address: the server strips it) and, on anything from outside, the
 * REAL address on its own line, never cut short (review of W3: a long display name could push it out of sight).
 */
export function SenderLine({ it, now, cls = 'srcmark' }: { it: ImportantItem; now: number; cls?: string }) {
  const showAddr = it.trust === 'untrusted' && !!it.fromAddress && it.caution !== 'phishing';
  return (
    <>
      <span className={cls}>
        <SourceIcon source={it.source} />
        <span className="srcname">{showName(it.from) ?? it.fromAddress ?? 'Your helper'}</span>
        <span className="time">{itemTime(it.ts, now)}</span>
      </span>
      {showAddr && <span className="addrline">{it.fromAddress}</span>}
    </>
  );
}

export type Caution = ImportantItem['caution'];
export function CautionTag({ caution }: { caution: Caution | undefined }) {
  if (caution === 'phishing') return <span className="cautiontag phishing"><WarnIcon size={15} />{PHISHING_HEAD}</span>;
  if (caution === 'unverified') return <span className="cautiontag unverified">unverified sender</span>;
  return null;
}

export function ItemRow({ it, now, swiped, busy, onOpen, onAction, onSwipe, onUnswipe, onHandled, onNotImportant }: {
  it: ImportantItem; now: number; swiped: boolean; busy: boolean;
  onOpen: () => void; onAction: () => void; onSwipe: () => void; onUnswipe: () => void; onHandled: () => void; onNotImportant: () => void;
}) {
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const moved = useRef(0);
  const tray = useRef<HTMLDivElement>(null);
  useEffect(() => { if (swiped) tray.current?.querySelector<HTMLButtonElement>('[data-first]')?.focus({ preventScroll: true }); }, [swiped]);

  const down = (e: RPointerEvent) => { if (e.button === 0 || e.pointerType !== 'mouse') { start.current = { x: e.clientX, y: e.clientY, id: e.pointerId }; moved.current = 0; } };
  const move = (e: RPointerEvent) => {
    const s = start.current;
    if (!s || s.id !== e.pointerId) return;
    const dx = e.clientX - s.x, dy = e.clientY - s.y;
    if (Math.abs(dy) > 30 && Math.abs(dy) > Math.abs(dx)) { start.current = null; return; } // a scroll, not a swipe
    moved.current = Math.max(moved.current, Math.abs(dx));
    if (dx < -60) { start.current = null; onSwipe(); }
  };
  const up = () => { start.current = null; };
  const phishing = it.caution === 'phishing';
  const act = rowAction(it);

  if (swiped) {
    return (
      <li className="item swiped">
        <div className="swipetray" role="group" aria-label={it.title} ref={tray}>
          <span className="it-t">{it.title}</span>
          <span className="it-why">{phishing ? 'Not the kind of thing you want here? Swipe right or tap elsewhere to keep it.' : 'Done with this, or not the kind of thing you want here? Swipe right or tap elsewhere to keep it.'}</span>
          <span className="trayacts">
            <button type="button" className="vbtn vbtn-quiet" {...(phishing ? { 'data-first': '' } : {})} disabled={busy} onClick={onNotImportant}>Not important</button>
            {!phishing && <button type="button" className="vbtn" data-first="" disabled={busy} onClick={onHandled}><CheckIcon />Handled</button>}
            <button type="button" className="vbtn vbtn-quiet sr-only-focusable" onClick={onUnswipe}>Keep it</button>
          </span>
        </div>
      </li>
    );
  }
  return (
    <li className={`item${it.caution ? ` caution-${it.caution}` : ''}`}>
      <button type="button" className="itemrow" onClick={() => { if (moved.current > 12) { moved.current = 0; return; } onOpen(); }}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <SenderLine it={it} now={now} />
        {it.caution && <CautionTag caution={it.caution} />}
        <span className="it-t">{it.title}</span>
        {phishing && it.fromAddress && <span className="it-addr">Sent from <span className="addrmono">{it.fromAddress}</span></span>}
        {it.why && <span className="it-why">{it.why}</span>}
      </button>
      {act && (
        <div className="it-act">
          <button type="button" className={`vbtn${primaryAction(it) ? ' vbtn-primary' : ''}`} disabled={busy} onClick={onAction}>{act.label}</button>
        </div>
      )}
    </li>
  );
}
