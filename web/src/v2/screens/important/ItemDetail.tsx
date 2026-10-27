/**
 * An item that is not an email, opened (v2 build, slice W3): a sheet that shows it in place — who, when, why, what its
 * action would do (Add to calendar shows the date as read before any draft is made) — with its action, Open in
 * Calendar for a calendar item, Ask about this (the answer appears here, under "You asked"), and Mark handled /
 * Not important. An email opens in the reader instead (../mail/Reader.tsx).
 */
import { useEffect, useState } from 'react';
import type { ImportantItem } from '../../api/client';
import { useNow } from '../../store/react';
import { Sheet } from '../../shell/sheets';
import { AskAboutButton, AskAboutSheet, QaBlock, useAskAbout } from './AskAbout';
import { CautionTag, PHISHING_HEAD, PHISHING_TEXT, SenderLine } from './ItemRow';
import { CheckIcon, WarnIcon } from './icons';

export interface ItemControls {
  handled: (it: ImportantItem) => void;
  notImportant: (it: ImportantItem) => void;
  run: (it: ImportantItem) => void;
  busy: (it: ImportantItem) => boolean;
  openCalendar?: () => void;
}

const isCalendar = (it: ImportantItem) => it.source === 'calendar-conflict' || it.source === 'calendar-change' || it.source === 'deadline';

/** The date an action would use, as read, before anything is made: "Sat Nov 14, 3–6pm · Oakwood Elementary". */
export function ActionPreview({ it }: { it: ImportantItem }) {
  const p = it.action?.preview;
  if (!p?.when) return null;
  return (
    <div className="preview">
      <p className="soft">{it.action?.kind === 'remind' ? 'I’d remind you' : 'What I read'}</p>
      <p>{p.when}{p.place ? ` · ${p.place}` : ''}</p>
    </div>
  );
}

/** The phishing warning, in fixed words (plus the server's own fixed "why", when it came from an item). */
export function CautionBox({ caution, why }: { caution: ImportantItem['caution'] | undefined; why?: string | null }) {
  if (caution !== 'phishing') return null;
  return (
    <div className="cautionbox" role="note" aria-label={PHISHING_HEAD}>
      <p className="cautionhead"><WarnIcon />{PHISHING_HEAD}</p>
      {why && <p>{why}</p>}
      <p>{PHISHING_TEXT}</p>
    </div>
  );
}

export function ItemDetailSheet({ item, askWith, onClose, controls }: {
  item: ImportantItem | null;
  /** open with its Ask sheet already up and this question filled in (the item's action said "ask": Draft the note) */
  askWith?: string | null;
  onClose: () => void; controls: ItemControls;
}) {
  const now = useNow();
  const [askOpen, setAskOpen] = useState(false);
  useEffect(() => { if (item && askWith) setAskOpen(true); }, [item?.id, askWith]); // eslint-disable-line react-hooks/exhaustive-deps
  const ask = useAskAbout(item ? { kind: 'item', id: item.id } : null, item);
  const phishing = item?.caution === 'phishing';
  const open = item?.state === 'open';
  const act = item?.action && !phishing && item.action.kind !== 'review-reply' ? item.action : null;
  return (
    <>
      <Sheet id="item-dlg" titleId="item-title" title={item?.title ?? ''} open={!!item} onClose={onClose}>
        {item && (
          <div className="sheet-body itemdetail">
            <div className="senderblock"><SenderLine it={item} now={now} /></div>
            {item.caution === 'unverified' && <p><CautionTag caution={item.caution} /></p>}
            {phishing ? <CautionBox caution={item.caution} why={item.why} /> : item.why && <p className="detailwhy">{item.why}</p>}
            {act && <ActionPreview it={item} />}
            <div className="acts dacts">
              {act && open && <button type="button" className={`vbtn${act.kind === 'add-to-calendar' || act.kind === 'draft-note' ? ' vbtn-primary' : ''}`} disabled={controls.busy(item)} onClick={() => controls.run(item)}>{act.label}</button>}
              {isCalendar(item) && controls.openCalendar && <button type="button" className="vbtn" onClick={controls.openCalendar}>Open in Calendar</button>}
              {!phishing && <AskAboutButton onClick={() => setAskOpen(true)} />}
            </div>
            <QaBlock qa={ask.qa} idp={`item-${item.id}`} />
            {open && (
              <div className="itemfoot">
                {!phishing && <button type="button" className="vbtn vbtn-quiet" onClick={() => controls.handled(item)}><CheckIcon />Mark handled</button>}
                <button type="button" className="vbtn vbtn-quiet" onClick={() => controls.notImportant(item)}>Not important</button>
              </div>
            )}
            {item.state === 'handled' && <p className="receipt">You marked this handled.</p>}
          </div>
        )}
      </Sheet>
      <AskAboutSheet id="about-item-dlg" open={askOpen && !!item} onClose={() => setAskOpen(false)} ask={ask} prefill={askWith ?? undefined} />
    </>
  );
}
