/**
 * One day's agenda, a draft awaiting Confirm, and the event sheet (v2 build, slice W2), as approved in the prototype
 * (prototype-v2 app.js agendaHtml / openEvent; REPLAY-NOTES: `group "Draft: Book fair"`, `button "Confirm"`). Used by
 * the Calendar screen and by Today's "Your day" column.
 *
 * Words from the calendar (titles, places) came from outside — an invitation can say anything — so they are plain text
 * (React escapes them; nothing is turned into a link). A draft says where it came from: "Added by your helper after
 * reading an email — check it" when the helper had read outside content first.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { CalendarItem } from '../../api/client';
import { useStore } from '../../store/react';
import { useDraftActions } from '../../store/today-react';
import {
  clockLabel, dayName, draftIcs, icsName, itemSpan, overlapsOf, spanLabel, type CalendarConflict, type DisplayItem,
} from '../../store/calendar-ops';
import { Sheet } from '../../shell/sheets';
import { Spark } from '../../shell/icons';
import './calendar.css';

const Check = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" /></svg>
);
export const Warn = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l9 16H3z" fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" /><path d="M12 10v4.5M12 17.2v.3" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" /></svg>
);

/** Where a draft came from, in plain words. */
export function originLine(i: Pick<CalendarItem, 'origin' | 'originNote'>): string {
  if (i.origin === 'you') return 'Your draft';
  if (i.origin === 'helper-after-reading') {
    const n = i.originNote ?? '';
    const what = /email/i.test(n) && !/web/i.test(n) ? 'an email' : /web/i.test(n) && !/email/i.test(n) ? 'a web page' : 'an email or a web page';
    return `Added by your helper after reading ${what} — check it`;
  }
  return 'Draft from your helper';
}
export const providerName = (p: CalendarItem['provider']) => (p === 'outlook' ? 'Outlook' : p === 'google' ? 'Google Calendar' : null);
const when = (i: CalendarItem) => { if (i.allDay) return 'All day'; const [s, e] = itemSpan(i); return spanLabel(s, e); };
const sub = (i: CalendarItem) => `${when(i)}${i.location ? ` · ${i.location}` : ''}`;

/** "Download book-fair.ics": the server's file; in fixture mode (no file server) one made on the device. */
export function IcsLink({ item, fixtures }: { item: CalendarItem; fixtures: boolean }) {
  const store = useStore();
  const name = icsName(item.title);
  const blobUrl = useMemo(() => (fixtures && typeof URL !== 'undefined' && URL.createObjectURL ? URL.createObjectURL(new Blob([draftIcs(item)], { type: 'text/calendar' })) : null), [fixtures, item]);
  useEffect(() => () => { if (blobUrl) URL.revokeObjectURL(blobUrl); }, [blobUrl]);
  return <a className="icslink" href={blobUrl ?? store.client.calendarDraftIcsUrl(item.id)} download={name}>Download {name}</a>;
}

/** A draft awaiting Confirm: dashed, with where it came from, Confirm / Remove, and the calendar file. */
export function DraftCard({ item, fixtures, highlight }: { item: DisplayItem; fixtures: boolean; highlight?: boolean }) {
  const d = useDraftActions();
  const p = item.pending;
  return (
    <div className={`evcard draft${highlight ? ' is-new' : ''}`} id={`ev-${item.id}`} role="group" aria-label={`Draft: ${item.title}`}>
      <span className="t">{item.title}</span>
      <span className="s">{sub(item)}</span>
      <span className={`draftline${item.origin === 'helper-after-reading' ? ' outside-origin' : ''}`}><Spark size={16} />{originLine(item)}</span>
      {item.origin === 'helper-after-reading' && item.originNote && <span className="originnote">{item.originNote}</span>}
      {p ? (
        <span className="pendingline" role="status">{p.kind === 'confirm' ? (p.queued ? 'Waiting to be sent — it goes on your calendar when you’re back online.' : 'Adding to your calendar…') : 'Removing…'}</span>
      ) : (
        <span className="acts">
          <button type="button" className="vbtn vbtn-primary" onClick={() => void d.confirm(item)}>Confirm</button>
          <button type="button" className="vbtn vbtn-quiet" onClick={() => void d.remove(item)}>Remove</button>
        </span>
      )}
      {!p && <IcsLink item={item} fixtures={fixtures} />}
    </div>
  );
}

/** One day: the events (each opens its sheet), drafts with Confirm, the "now" line on today; honest when empty. */
export function DayAgenda({ day, items, conflicts, now, isToday, empty, highlight, onOpen, fixtures, label }: {
  day: number; items: DisplayItem[]; conflicts: CalendarConflict[]; now: number; isToday: boolean; empty: ReactNode;
  highlight?: string | null; onOpen: (i: CalendarItem) => void; fixtures: boolean; label?: string;
}) {
  const rows: ReactNode[] = [];
  let nowDone = !isToday;
  const nowLine = <li key="now" className="nowline" aria-hidden="true"><span className="lbl">{clockLabel(now)}</span></li>;
  for (const i of items) {
    const [s] = itemSpan(i);
    if (!nowDone && !i.allDay && s > now) { rows.push(nowLine); nowDone = true; }
    const whenLabel = i.allDay ? 'All day' : clockLabel(Math.max(s, day));
    const hl = highlight === i.id;
    if (i.kind === 'draft') {
      rows.push(<li key={i.id}><span className="when">{whenLabel}</span><DraftCard item={i} fixtures={fixtures} highlight={hl} /></li>);
      continue;
    }
    const clash = overlapsOf(i.id, conflicts);
    rows.push(
      <li key={i.id}><span className="when">{whenLabel}</span>
        <button type="button" className={`evcard cal-${i.provider ?? 'none'}${clash.length ? ' clash' : ''}${hl ? ' is-new' : ''}`} id={`ev-${i.id}`} onClick={() => onOpen(i)}>
          <span className="t">{i.title}</span>
          <span className="s">{sub(i)}</span>
          {i.addedByHelper && <span className="receiptline"><Check /><span>Added by your helper. No invites were sent.</span></span>}
          {clash.length > 0 && <span className="clashline"><Warn /><span>Overlaps with {clash.join(' and ')}</span></span>}
        </button>
      </li>,
    );
  }
  if (!nowDone && items.length) rows.push(nowLine);
  if (!items.length) return <ul className="agenda" aria-label={label ?? dayName(day)}><li className="empty">{empty}</li></ul>;
  return <ul className="agenda" aria-label={label ?? dayName(day)}>{rows}</ul>;
}

/** An event (or a draft) in a sheet: when, where, which calendar, what it overlaps, and Ask about this. */
export function EventSheet({ item, conflicts, fixtures, onClose, onAsk }: {
  item: DisplayItem | null; conflicts: CalendarConflict[]; fixtures: boolean; onClose: () => void; onAsk: (label: string) => void;
}) {
  const [shown, setShown] = useState<DisplayItem | null>(item);
  useEffect(() => { if (item) setShown(item); }, [item]);
  const i = item ?? shown;
  const clash = i ? overlapsOf(i.id, conflicts) : [];
  const [s] = i ? itemSpan(i) : [0];
  const label = i ? `${i.title} · ${new Date(s).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}` : '';
  return (
    <Sheet id="event-dlg" titleId="event-title" title={i?.title ?? ''} open={!!item} onClose={onClose}>
      {i && (
        <div className="sheet-body evsheet">
          <p style={{ fontWeight: 600 }}>{dayName(s)}</p>
          <p>{when(i)}</p>
          {i.location && <p className="soft" style={{ marginTop: 6 }}>{i.location}</p>}
          {providerName(i.provider) && <p style={{ marginTop: 10 }}>{i.kind === 'draft' ? `Goes on your ${providerName(i.provider)} when you confirm it` : `On your ${providerName(i.provider)}`}</p>}
          {i.kind === 'event' && i.addedByHelper && <p className="receiptline"><Check /><span>Added by your helper. No invites were sent.</span></p>}
          {clash.length > 0 && <p className="clashline"><Warn /><span>Overlaps with {clash.join(' and ')}</span></p>}
          {i.kind === 'draft' && <div style={{ marginTop: 14 }}><DraftCard item={i} fixtures={fixtures} /></div>}
          {/* TODO(W4): <AskAbout kind="event" id={i.id} label={label}/> replaces this thin call (the answer then shows here) */}
          <div className="acts dacts">
            <button type="button" className="vbtn vbtn-helper" onClick={() => onAsk(label)}><Spark />Ask about this</button>
          </div>
        </div>
      )}
    </Sheet>
  );
}
