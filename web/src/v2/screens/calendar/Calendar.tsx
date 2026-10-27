/**
 * The Calendar screen (v2 build, slice W2), as approved (prototype-v2 V.calendar; SCENARIOS N02, the N00 tour):
 *
 *   - the week ("November 9–15") with a day strip (`tablist "Days this week"`, each day `tab "Saturday, November 14,
 *     3 items"`) and the chosen day's agenda; or the whole week as a list by day (a seven-column grid on a desktop);
 *     earlier / later weeks; "Today" goes back;
 *   - a double-booking highlighted: a card ("Thursday at 4 PM is double-booked") with what the prototype offers —
 *     Draft the note (through its Important item), Ask about this, Not now — and both events marked "Overlaps with …";
 *   - drafts awaiting Confirm (Confirm / Remove, shown at once and rolled back if refused, where they came from, and the
 *     calendar file);
 *   - New event: a draft from your own input (title, day, start and end or all day, where) — nothing reaches the
 *     calendar until it is confirmed;
 *   - the accounts and how fresh they are, with Refresh; honest states: nothing connected (offer to connect), one to
 *     reconnect, never synced, one calendar missing (named) — an unknown day is never called free;
 *   - an event opens in a sheet with Ask about this (W4's AskAbout: the answer shows in the sheet).
 */
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { CalendarItem } from '../../api/client';
import { useCalendar, useItems, useMeta, useNow, useStore } from '../../store/react';
import { useCalendarAccounts, useDraftActions, useToday } from '../../store/today-react';
import {
  addDays, conflictText, conflictTitle, conflictsOnDay, dayKey, dayName, displayItems, draftInput, fromDayKey, itemsOnDay,
  startOfDay, takeCalendarRequest, weekLabel, weekStart, type CalendarConflict, type DisplayItem, type DraftForm,
} from '../../store/calendar-ops';
import type { ActResult } from '../../store/core';
import type { ScreenProps } from '../../shell/screens';
import { Sheet } from '../../shell/sheets';
import { Back, Chev, Spark } from '../../shell/icons';
import { AskAbout } from '../ask/AskAbout';
import { DayAgenda, EventSheet, Warn } from './Agenda';
import { useNotNow } from './notnow';
import { openConnectionsAt } from '../settings/useConnections';
import './calendar.css';

const DRAFT_NOTE_PREFILL = 'Draft a note asking to move one of them';

/**
 * "Draft the note" for a double-booking: its Important item's action (the server routes it to Ask: the helper drafts
 * the note when the person sends it), then the Ask sheet about it, prefilled. Without an item: the Ask sheet about the
 * double-booking itself. Each tap opens it again (`n`).
 */
export function useDraftNote() {
  const store = useStore();
  const [asking, setAsking] = useState<{ n: number } | null>(null);
  const run = async (itemId: string | null, label: string) => {
    if (itemId) {
      const r = await store.act('item.action', { id: itemId }, `Draft the note: ${label}`);
      if (!r.ok) return; // refused (the store said why) or waiting in the outbox
      const d = r.data as { done?: boolean; message?: string } | undefined;
      if (d?.done) { store.notice(d.message ?? 'Done.'); return; }
    }
    setAsking({ n: Date.now() });
  };
  return { asking, run };
}

/** "Ask about this" for a double-booking (W4's one component; through its Important item when it has one). */
export function ConflictAskAbout({ conflictId, itemId, label, asking, sheetId }: { conflictId: string; itemId: string | null; label: string; asking: { n: number } | null; sheetId: string }) {
  const items = useItems();
  return (
    <AskAbout key={`${itemId ?? conflictId}:${asking?.n ?? 0}`} kind={itemId ? 'item' : 'conflict'} id={itemId ?? conflictId} label={label}
      item={itemId ? items.byId[itemId] ?? null : null} form="sheet" sheetId={sheetId} prefill={asking ? DRAFT_NOTE_PREFILL : null} />
  );
}

function ConflictCard({ c, today, itemId, onNotNow }: { c: CalendarConflict; today: number; itemId: string | null; onNotNow: () => void }) {
  const note = useDraftNote();
  const title = conflictTitle(c, today);
  const idp = `cf-${c.id.replace(/[^a-z0-9]/gi, '-')}`;
  return (
    <div className="card needcard conflictcard" role="group" aria-labelledby={`${idp}-h`}>
      <h3 id={`${idp}-h`}><Warn /> {title}</h3>
      <p>{conflictText(c)}</p>
      <div className="acts">
        {itemId && <button type="button" className="vbtn vbtn-primary" onClick={() => void note.run(itemId, title)}>Draft the note</button>}
        <button type="button" className="vbtn vbtn-quiet" onClick={onNotNow}>Not now</button>
      </div>
      <ConflictAskAbout conflictId={c.id} itemId={itemId} label={title} asking={note.asking} sheetId={`about-${idp}`} />
    </div>
  );
}

function useCalView(): ['day' | 'week', (v: 'day' | 'week') => void] {
  const [v, setV] = useState<'day' | 'week'>(() => { try { return localStorage.getItem('mwa-v2-calview') === 'week' ? 'week' : 'day'; } catch { return 'day'; } });
  return [v, (x) => { setV(x); try { localStorage.setItem('mwa-v2-calview', x); } catch { /* private mode */ } }];
}

export function Calendar({ desk, go }: ScreenProps) {
  const store = useStore();
  const now = useNow();
  const { fixtures, connection } = useMeta();
  const today = startOfDay(now);
  const [req] = useState(() => takeCalendarRequest());
  const [selected, setSelected] = useState(() => (req ? fromDayKey(req.day) : today));
  const [highlight, setHighlight] = useState<string | null>(req?.highlight ?? null);
  const [view, setView] = useCalView();
  const [open, setOpen] = useState<DisplayItem | null>(null);
  const [creating, setCreating] = useState(false);
  const [say, setSay] = useState<string | null>(null);
  const week = weekStart(selected);
  const range = useMemo(() => ({ from: new Date(week), to: new Date(addDays(week, 7)) }), [week]);
  const cal = useCalendar(range);
  const drafts = useDraftActions();
  const acc = useCalendarAccounts();
  const t = useToday();
  // "Not now" is for the person's day (their zone), with the same ids as Today's cards
  const notNow = useNotNow(t.view?.doc.date ?? dayKey(today));
  const items = useItems();
  const shown = useMemo(() => displayItems(cal.items, drafts.ops), [cal.items, drafts.ops]);
  const conflicts = useMemo(() => cal.conflicts.filter((c) => !notNow.isHidden(`conflict:${c.id}`)), [cal.conflicts, notNow]);
  const days = Array.from({ length: 7 }, (_, k) => addDays(week, k));

  // a highlight fades after a few seconds; a receipt from Confirm shows at the top
  useEffect(() => { if (!highlight) return; const x = setTimeout(() => setHighlight(null), 3_200); return () => clearTimeout(x); }, [highlight]);
  useEffect(() => { if (drafts.receipt) setSay(drafts.receipt.text); }, [drafts.receipt]);
  useEffect(() => () => drafts.clearReceipt(), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) { const i = shown.find((x) => x.id === open.id); if (!i) setOpen(null); else if (i !== open) setOpen(i); } }, [shown, open]);
  useEffect(() => {
    if (!highlight) return;
    const el = document.getElementById(`ev-${highlight}`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [highlight, selected]);

  const itemFor = (c: CalendarConflict): string | null => {
    const need = t.view?.doc.needsYou.find((n) => n.kind === 'conflict' && n.id === `need:conflict:${c.id}`);
    if (need?.itemId) return need.itemId;
    const it = Object.values(items.byId).find((x) => x.source === 'calendar-conflict' && x.state === 'open' && (x.sourceRef === `conflict:${c.id}` || x.sourceRef === c.id));
    return it?.id ?? null;
  };
  const honest = acc.honesty;
  const emptyDay = honest.state === 'not_connected' || honest.state === 'not_synced'
    ? <>{honest.note}</>
    : honest.state === 'partial' ? <>Nothing on the calendars I can see.</>
      : cal.loading && !shown.length ? <>Loading…</> : <><span className="big" aria-hidden="true">☀︎</span>Nothing planned. A free day!</>;
  // S3: connecting (or reconnecting) a calendar is Settings › Connections, at the account that needs it
  const offerConnect = () => { openConnectionsAt(acc.accounts?.find((a) => a.connected && a.needsReconnect)?.provider ?? null); go('connections'); };
  const pickDay = (d: number) => { setSelected(d); setSay(null); };
  const onKeyStrip = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = days.indexOf(selected);
    let n = -1;
    if (e.key === 'ArrowRight') n = Math.min(6, i + 1); else if (e.key === 'ArrowLeft') n = Math.max(0, i - 1); else if (e.key === 'Home') n = 0; else if (e.key === 'End') n = 6;
    if (n < 0) return;
    e.preventDefault();
    const strip = e.currentTarget; // React clears currentTarget once the handler returns
    pickDay(days[n]);
    setTimeout(() => strip.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus(), 0);
  };
  const accountsLine = acc.accounts && acc.accounts.some((a) => a.connected) ? (
    <p className="calacct">
      <span>{acc.accounts.filter((a) => a.connected).map((a) => a.label).join(' and ')}{honest.asOf ? <span className="soft"> · updated {new Date(honest.asOf).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span> : null}</span>
      <button type="button" className="linkish quietlink" disabled={acc.refreshing || connection !== 'live'} onClick={async () => { const m = await acc.refresh({ from: range.from.toISOString(), to: range.to.toISOString() }); setSay(m); }}>
        {acc.refreshing ? 'Refreshing…' : 'Refresh'}
      </button>
    </p>
  ) : null;
  const honestNote = honest.note && honest.state !== 'stale' ? (
    <div className={`card calnote ${honest.state}`} role="note">
      <p>{honest.note}</p>
      {honest.state === 'not_connected' && <div className="acts"><button type="button" className="vbtn vbtn-primary" onClick={offerConnect}>Connect a calendar</button></div>}
      {honest.state === 'reconnect' && <div className="acts"><button type="button" className="vbtn vbtn-primary" onClick={offerConnect}>Reconnect</button></div>}
    </div>
  ) : null;
  const dayConflicts = (d: number) => conflictsOnDay(conflicts, d);
  const conflictCards = (list: CalendarConflict[]) => list.map((c) => (
    <ConflictCard key={c.id} c={c} today={today} itemId={itemFor(c)} onNotNow={() => notNow.hide(`conflict:${c.id}`, 'OK, I’ll bring it up again tomorrow.')} />
  ));

  const body = (
    <>
      <header className="vh"><div className="vh-text"><p className="vh-kicker">{weekLabel(week)}</p><h1>Calendar</h1></div>
        {selected !== today && <button type="button" className="vbtn vbtn-quiet" onClick={() => pickDay(today)}>Today</button>}
      </header>
      {accountsLine}
      {honestNote}
      {say && <div className="helpsay" role="status"><Spark /><p>{say}{fixtures ? <span className="simmini">simulated</span> : null}</p></div>}
      <div className="caltools">
        <button type="button" className="iconbtn" aria-label="Earlier week" onClick={() => pickDay(addDays(week, -7))}><Back /></button>
        {/* a radio group: one tab stop (the chosen one); arrow keys move the choice (W2 review) */}
        <div className="seg calseg" role="radiogroup" aria-label="Show" onKeyDown={(e) => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
          e.preventDefault();
          const group = e.currentTarget; // React clears currentTarget once the handler returns
          const next = view === 'day' ? 'week' : 'day';
          setView(next);
          setTimeout(() => group.querySelector<HTMLButtonElement>(`[data-v="${next}"]`)?.focus(), 0);
        }}>
          <button type="button" role="radio" data-v="day" aria-checked={view === 'day'} tabIndex={view === 'day' ? 0 : -1} onClick={() => setView('day')}>Day</button>
          <button type="button" role="radio" data-v="week" aria-checked={view === 'week'} tabIndex={view === 'week' ? 0 : -1} onClick={() => setView('week')}>Week</button>
        </div>
        <button type="button" className="iconbtn" aria-label="Later week" onClick={() => pickDay(addDays(week, 7))}><Chev /></button>
        <span className="grow" />
        <button type="button" className="vbtn newev" onClick={() => setCreating(true)}>+ New event</button>
      </div>

      {view === 'day' ? (
        <>
          <div className="weekstrip" role="tablist" aria-label="Days this week" onKeyDown={onKeyStrip}>
            {days.map((d) => {
              const n = itemsOnDay(shown, d).length, sel = d === selected, clash = dayConflicts(d).length > 0;
              return (
                <button key={d} type="button" role="tab" className={`daybtn${d === today ? ' today' : ''}${clash ? ' hasclash' : ''}`} aria-selected={sel} tabIndex={sel ? 0 : -1} aria-controls="dayagenda"
                  aria-label={`${dayName(d)}${d === today ? ', today' : ''}, ${n} ${n === 1 ? 'item' : 'items'}${clash ? ', double-booked' : ''}`} onClick={() => pickDay(d)}>
                  <span className="dn" aria-hidden="true">{new Date(d).toLocaleDateString('en-US', { weekday: 'short' })}</span>
                  <span className="dd" aria-hidden="true">{new Date(d).getDate()}</span>
                  <span className="dots" aria-hidden="true">{Array.from({ length: Math.min(n, 3) }, (_, k) => <i key={k} />)}</span>
                </button>
              );
            })}
          </div>
          <div role="tabpanel" id="dayagenda" aria-label={dayName(selected)}>
            <div className="dayhead"><h2>{dayName(selected)}</h2>{selected === today && <span className="soft">Today</span>}</div>
            {conflictCards(dayConflicts(selected))}
            <DayAgenda day={selected} items={itemsOnDay(shown, selected)} conflicts={conflicts} now={now} isToday={selected === today} empty={emptyDay}
              highlight={highlight} onOpen={(i) => setOpen(i)} fixtures={fixtures} />
          </div>
        </>
      ) : (
        <>
          {(() => {
            const wk = conflicts.filter((c) => { const s = Date.parse(c.start); return s >= week && s < addDays(week, 7); });
            return wk.length > 0 && <section aria-labelledby="wk-clash-h"><h2 className="sh" id="wk-clash-h">Double-booked this week</h2>{conflictCards(wk)}</section>;
          })()}
          <div className="weeklist">
            {days.map((d) => {
              const list = itemsOnDay(shown, d);
              return (
                <section key={d} className={`wkday${d === today ? ' today' : ''}`} aria-labelledby={`wk-${dayKey(d)}`}>
                  <h2 id={`wk-${dayKey(d)}`} className="wkhead">
                    <button type="button" className="wkdaybtn" onClick={() => { pickDay(d); setView('day'); }}>
                      {desk ? <><span className="dn">{new Date(d).toLocaleDateString('en-US', { weekday: 'short' })}</span> <span className="dd">{new Date(d).getDate()}</span></> : dayName(d)}
                      <span className="sr-only">{desk ? `, ${dayName(d)}` : ''}{d === today ? ', today' : ''}</span>
                    </button>
                  </h2>
                  {list.length ? (
                    <ul className="wkitems">
                      {list.map((i) => (
                        <li key={i.id}>
                          <button type="button" className={`wkitem${i.kind === 'draft' ? ' draft' : ` cal-${i.provider ?? 'none'}`}${dayConflicts(d).some((c) => c.between.includes(i.id)) ? ' clash' : ''}`} onClick={() => setOpen(i)}>
                            <span className="wt">{i.allDay ? 'All day' : new Date(Math.max(Date.parse(i.start), d)).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>
                            <span className="wn">{i.kind === 'draft' && <span className="wkdraft">Draft · </span>}{i.title}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : <p className="wkempty">{honest.canSayFree ? 'Free' : honest.state === 'partial' ? 'Nothing I can see' : '—'}</p>}
                </section>
              );
            })}
          </div>
        </>
      )}
      <EventSheet item={open} conflicts={conflicts} fixtures={fixtures} onClose={() => setOpen(null)} />
      <NewDraftSheet open={creating} day={selected} onClose={() => setCreating(false)}
        onDone={(r, day) => {
          setCreating(false);
          if (r.ok) {
            const d = (r.data as { draft?: CalendarItem; message?: string } | undefined);
            if (d?.draft) { setSelected(day); setView('day'); setHighlight(d.draft.id); }
            setSay(d?.message ?? 'Added as a draft. Nothing is on your calendar until you confirm it.');
          } else if (r.queued) setSay('Saved. I’ll add the draft when you’re back online.');
        }} />
    </>
  );
  return desk ? <div className={`col-main calwide${view === 'week' ? ' calweek' : ''}`} style={{ margin: '0 auto' }}>{body}</div> : body;
}

/** "New event": a draft from your own input. Nothing is on the calendar until it is confirmed. */
function NewDraftSheet({ open, day, onClose, onDone }: { open: boolean; day: number; onClose: () => void; onDone: (r: ActResult, day: number) => void }) {
  const store = useStore();
  const blank = (): DraftForm => ({ title: '', date: dayKey(day), allDay: false, start: '09:00', end: '10:00', location: '' });
  const [f, setF] = useState<DraftForm>(blank);
  const [error, setError] = useState<{ text: string; field: keyof DraftForm | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setF(blank()); setError(null); setTimeout(() => first.current?.focus(), 30); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = <K extends keyof DraftForm>(k: K, v: DraftForm[K]) => setF((x) => ({ ...x, [k]: v }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const r = draftInput(f);
    if (!r.ok) { setError({ text: r.error, field: r.field }); return; }
    setBusy(true);
    const res = await store.act('draft.create', { draft: r.body }, `Add “${r.body.title}”`);
    setBusy(false);
    if (!res.ok && !res.queued) { setError({ text: res.message, field: null }); return; }
    onDone(res, fromDayKey(f.date));
  };
  const inv = (k: keyof DraftForm) => (error?.field === k ? { 'aria-invalid': true, 'aria-describedby': 'nd-err' } : {});
  return (
    <Sheet id="newevent-dlg" titleId="newevent-title" title="New event" open={open} onClose={onClose}>
      <form className="sheet-body draftform" onSubmit={(e) => void submit(e)} noValidate>
        <p className="soft">It goes in as a draft. Nothing is on your calendar until you confirm it.</p>
        <label className="fld"><span>What</span><input ref={first} type="text" value={f.title} maxLength={300} onChange={(e) => set('title', e.target.value)} {...inv('title')} /></label>
        <label className="fld"><span>Day</span><input type="date" value={f.date} onChange={(e) => set('date', e.target.value)} {...inv('date')} /></label>
        <label className="chk"><input type="checkbox" checked={f.allDay} onChange={(e) => set('allDay', e.target.checked)} /><span>All day</span></label>
        {!f.allDay && (
          <div className="fldrow">
            <label className="fld"><span>Starts</span><input type="time" value={f.start} onChange={(e) => set('start', e.target.value)} {...inv('start')} /></label>
            <label className="fld"><span>Ends</span><input type="time" value={f.end} onChange={(e) => set('end', e.target.value)} {...inv('end')} /></label>
          </div>
        )}
        <label className="fld"><span>Where <span className="soft">(optional)</span></span><input type="text" value={f.location} maxLength={300} onChange={(e) => set('location', e.target.value)} /></label>
        {error && <p className="errline" id="nd-err" role="alert">{error.text}</p>}
        <div className="acts"><button type="submit" className="vbtn vbtn-primary" disabled={busy}>{busy ? 'Adding…' : 'Add as a draft'}</button><button type="button" className="vbtn vbtn-quiet" onClick={onClose}>Cancel</button></div>
      </form>
    </Sheet>
  );
}
