/**
 * The Today screen (v2 build, slice W2), as approved (prototype-v2 V.today; SCENARIOS N01, N05, N09; REPLAY-NOTES):
 *
 *   phone       the date and greeting; the morning check-in ("Your morning check-in", Done — show my day, Read it to
 *               me) or the evening wrap ("That's Monday", Good night); Needs you (each card opens its thing in place);
 *               Next up (three events, See your whole day); Done for you (each line opens a sheet with See it and Ask
 *               about this); Worth a look (W3's list, top 3, See all — minus what a Needs-you card shows); the week line.
 *   desktop     from 1200 px three columns: Worth a look · Today · Your day (the day's agenda with the "now" line).
 *
 * Everything comes from GET /today (store/today.ts): what the server knows, said honestly — a calendar that is not
 * connected, never synced, partly synced or needs reconnecting is said in words, never shown as a free day. Text that
 * came from outside (`trust: untrusted`) is never shown as the helper's own words: the parts the server quoted are
 * marked as quotes, it is plain text, and only the server's `spoken` (counts and times, never a title) is read aloud.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CalendarItem } from '../../api/client';
import { useCalendar, useJobs, useMeta, useNow, useStore } from '../../store/react';
import { useSpeech, useToday } from '../../store/today-react';
import { partsOf, type Part, type TodayDone, type TodayNeed, type TodayOpen } from '../../store/today';
import { addDays, dayKey, displayItems, openCalendarOn, startOfDay, type DisplayItem } from '../../store/calendar-ops';
import { useDraftActions } from '../../store/today-react';
import type { ScreenProps } from '../../shell/screens';
import { Sheet } from '../../shell/sheets';
import { Chev, Person, Spark } from '../../shell/icons';
import { ImportantBody } from '../important/Important';
import { DayAgenda, EventSheet } from '../calendar/Agenda';
import { ConflictAskAbout, useDraftNote } from '../calendar/Calendar';
import { AskAbout } from '../ask/AskAbout';
import { useNotNow } from '../calendar/notnow';
import { openConnectionsAt, providerOfAccount } from '../settings/useConnections';
import './today.css';

const Check = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" /></svg>
);
const Speaker = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" /><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" /></svg>
);
const Stop = () => <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" /></svg>;
const Clock = () => (
  <svg className="clk" width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth={2} /><path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" /></svg>
);

/**
 * Words with their trust, from the server's parts (never by parsing quotes out of the text): outside words are a
 * quote (q.outside, bidi-isolated, never translated); an untrusted line with nothing marked outside gets a "From
 * outside:" lead-in. Plain text throughout: nothing is markup, nothing is a link.
 */
export function Said({ text, parts, trust }: { text: string; parts?: Part[] | null; trust: 'trusted' | 'untrusted' }) {
  const r = partsOf(text, parts, trust);
  return (
    <>
      {r.lead && <span className="fromout">From outside: </span>}
      {r.parts.map((p, i) => (p.outside
        ? <q key={i} className="outside" translate="no"><bdi>{p.text}</bdi></q>
        : <span key={i}>{p.text}</span>))}
    </>
  );
}

/** "Read it to me" (hidden when the browser cannot speak), with a stop. Only the server's `spoken` is read. */
function ReadAloud({ spoken }: { spoken: string }) {
  const sp = useSpeech();
  if (!sp.supported) return null;
  return sp.speaking
    ? <button type="button" className="vbtn vbtn-quiet" onClick={sp.stop}><Stop />Stop reading</button>
    : <button type="button" className="vbtn vbtn-quiet" onClick={() => sp.speak(spoken)}><Speaker />Read it to me</button>;
}

export function Today({ desk, wide, go, ask, openWork }: ScreenProps) {
  const store = useStore();
  const t = useToday();
  const now = useNow();
  const { connection, fixtures } = useMeta();
  const jobs = useJobs();
  const view = t.view;
  const [doneLine, setDoneLine] = useState<TodayDone | null>(null);
  const [event, setEvent] = useState<DisplayItem | null>(null);
  const needsH = useRef<HTMLHeadingElement>(null);
  // "Not now" is for the person's day (the Today's date), with the Calendar's ids for a double-booking
  const notNow = useNotNow(view?.doc.date ?? dayKey(now));
  const note = useDraftNote();
  const [askFor, setAskFor] = useState<string | null>(null);

  // Today on screen: after 2 s it counts as seen (store/today.ts); leaving lets "Done for you" move on
  useEffect(() => { store.today.viewing(true); return () => store.today.viewing(false); }, [store]);

  const say = (text: string) => store.notice(text);
  const toCalendar = (date: string | undefined, id: string | null = null) => { openCalendarOn(date ?? dayKey(now), id); go('calendar'); };
  /** Where a card or a line opens, in place. */
  const CLASSIC = `${location.pathname}?ui=v1`;
  const open = (o: TodayOpen) => {
    switch (o.kind) {
      case 'job': case 'jobs': if (openWork) openWork(); else say('Open the pill at the top to see the job.'); return;
      case 'calendar': toCalendar(o.date, o.id); return;
      case 'item': if (o.date) toCalendar(o.date); else go('inbox'); return;
      case 'mail': go('inbox'); return; // TODO(W3 follow-up): open this message in the reader directly
      // S3: reconnecting (or connecting a calendar) is Settings › Connections, at that account
      case 'reconnect': openConnectionsAt(providerOfAccount(o.id)); go('connections'); return;
      // W6: what the new app can't do yet opens the classic app for this visit only (`?ui=v1` is not remembered)
      case 'approval': case 'approvals': say('Approvals open in the classic app for now…'); location.assign(CLASSIC); return;
      default: say('That is in your helper’s activity list in the classic app.');
    }
  };
  const runNeed = async (n: TodayNeed) => {
    const a = n.action;
    if (!a) { open(n.open); return; }
    if (a.kind === 'draft-note' && n.itemId) { setAskFor(n.id); await note.run(n.itemId, n.title); return; }
    if (n.kind === 'job') {
      const j = jobs.jobs.find((x) => x.id === n.open.id);
      const f = j ? ({ continue: jobs.continue, 'start-over': jobs.startOver, stop: jobs.stop, open: jobs.open, resume: jobs.resume } as Record<string, ((x: typeof j) => Promise<unknown>) | undefined>)[a.kind] : undefined;
      if (j && f) { await f(j); return; }
      open(n.open); return;
    }
    open(n.open);
  };

  const head = (
    <header className="vh"><div className="vh-text">
      <div className="kickrow"><p className="vh-kicker">{view ? `${view.doc.dateLabel}, ${view.doc.date.slice(0, 4)}` : new Date(now).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</p>
        {!desk && <button type="button" className="avatar" aria-label="Settings" onClick={() => go('settings')}><Person /></button>}
      </div>
      <h1>{view?.doc.greeting ?? (new Date(now).getHours() < 12 ? 'Good morning' : new Date(now).getHours() < 17 ? 'Good afternoon' : 'Good evening')}</h1>
    </div></header>
  );

  if (!view) {
    const st = t.state;
    const away = connection === 'offline' || connection === 'unreachable';
    const msg = st.unsupported ? 'Today arrives with the next update of your helper.'
      : st.error ? `I couldn’t get your day: ${st.error}`
        : away ? 'I can’t reach your helper right now. Your day will show when you’re back online.' : 'Getting your day…';
    return <div>{head}<p className="empty" role="status" style={{ textAlign: 'left' }}>{msg}</p>
      {st.error && <button type="button" className="vbtn" onClick={() => void t.reload()}>Try again</button>}</div>;
  }
  const doc = view.doc;
  const cal = view.calendar;
  const needs = doc.needsYou.filter((n) => !notNow.isHidden(n.id));
  const exclude = new Set(doc.needsYou.map((n) => n.itemId).filter((x): x is string => !!x));

  const checkin = view.checkin && (
    <section className="card checkin" aria-labelledby="ci-h" style={{ marginTop: 12 }}>
      <h2 id="ci-h" className="cardh">{view.checkin.title}</h2>
      <p style={{ marginTop: 6 }} data-trust={view.checkin.trust}><Said text={view.checkin.text} trust={view.checkin.trust} /></p>
      <div className="acts">
        <button type="button" className="vbtn" onClick={() => { void t.finishCheckin(); setTimeout(() => needsH.current?.focus(), 0); }}>Done — show my day</button>
        <ReadAloud spoken={view.checkin.spoken} />
      </div>
    </section>
  );
  const wrap = view.wrap && (
    <section className="card checkin" aria-labelledby="wr-h" style={{ marginTop: 12 }} data-trust={view.wrap.trust}>
      <h2 id="wr-h" className="cardh">{view.wrap.title}</h2>
      <div className="lines" style={{ marginTop: 8 }}>{view.wrap.lines.map((l, i) => <p key={i}><Said text={l} parts={view.wrap!.lineParts?.[i]} trust={view.wrap!.trust} /></p>)}</div>
      <div className="acts">
        <button type="button" className="vbtn vbtn-primary" onClick={() => void t.finishWrap()}>Good night</button>
        <ReadAloud spoken={view.wrap.spoken} />
      </div>
    </section>
  );
  const banner = (text: string | null) => text && <p className="donebanner" role="status" style={{ marginTop: 8 }}><Check />{text}</p>;

  const needsSection = needs.length > 0 && (
    <section aria-labelledby="sh-needs">
      <h2 className="sh" id="sh-needs" tabIndex={-1} ref={needsH}>Needs you</h2>
      {needs.map((n) => (
        <div key={n.id} className="card needcard" data-trust={n.trust}>
          <h3><button type="button" className="needtitle" onClick={() => open(n.open)}><Said text={n.title} parts={n.titleParts} trust={n.trust} /></button></h3>
          <p><Said text={n.text} parts={n.textParts} trust={n.trust} /></p>
          <div className="acts">
            <button type="button" className="vbtn vbtn-primary" onClick={() => void runNeed(n)}>{n.action?.label ?? (n.kind === 'conflict' ? 'See the day' : 'Open')}</button>
            {n.kind === 'job' && n.action && <button type="button" className="vbtn" onClick={() => open(n.open)}>Open</button>}
            <button type="button" className="vbtn vbtn-quiet" onClick={() => notNow.hide(n.id, 'OK, I’ll bring it up again tomorrow.')}>Not now</button>
          </div>
          {n.kind === 'conflict' && askFor === n.id && (
            <ConflictAskAbout conflictId={n.id.replace(/^need:conflict:/, '')} itemId={n.itemId} label={n.title} asking={note.asking} sheetId={`about-need-${n.id.replace(/[^a-z0-9]/gi, '-')}`} />
          )}
        </div>
      ))}
    </section>
  );

  const freshNote = cal.note && (
    <div className={`freshnote ${cal.state}`} role="note">
      <p>{cal.note}</p>
      {cal.offer === 'connect' && <button type="button" className="vbtn" onClick={() => open({ kind: 'reconnect', id: null })}>Connect your calendar</button>}
    </div>
  );
  const nextUp = !desk && (
    <section aria-labelledby="sh-next"><h2 className="sh" id="sh-next">Next up</h2>
      {freshNote}
      {cal.showEvents && (doc.nextUp.length ? (
        <button type="button" className="card nextup" onClick={() => toCalendar(doc.date)}>
          {doc.nextUp.map((e) => (
            <span key={e.id} className="nurow"><span className="bar nubar" aria-hidden="true" />
              <span className="when time">{e.startLabel}</span>
              <span className="grow"><span className="t">{e.title}</span>
                <span className="s">{e.soon ? <><span className="soon"><Clock />{e.soon}</span> · </> : null}{e.location}</span></span>
            </span>
          ))}
          <span className="nu-open">See your whole day{doc.nextUpMore ? ` (${doc.nextUpMore} more)` : ''} <Chev /></span>
        </button>
      ) : (
        <p className="empty" style={{ textAlign: 'left' }}>
          {cal.canSayFree ? (doc.part === 'evening' || doc.part === 'night' ? 'Nothing else today. Enjoy the evening.' : 'Nothing else on your calendar today.') : 'Nothing else on the calendars I can see.'}
          {' '}<button type="button" className="linkish quietlink" onClick={() => toCalendar(doc.date)}>See your whole day</button>
        </p>
      ))}
    </section>
  );

  const doneSection = (
    <section aria-labelledby="sh-done"><h2 className="sh" id="sh-done">Done for you</h2>
      {view.done.length ? (
        <ul className="donelist card" style={{ padding: '4px 8px' }}>
          {view.done.map((d) => (
            <li key={d.id}><button type="button" className="donebtn" data-trust={d.trust} aria-haspopup="dialog" onClick={() => setDoneLine(d)}>
              <span className="ck"><Check /></span><span className="grow"><Said text={d.text} parts={d.parts} trust={d.trust} /></span><Chev />
            </button></li>
          ))}
        </ul>
      ) : <p className="empty" style={{ textAlign: 'left' }}>Nothing new since you last looked. When I do something for you, I’ll list it here.</p>}
      {view.doneMore > 0 && <p className="soft" style={{ fontSize: 14.5, margin: '6px 4px 0' }}>and {view.doneMore} more earlier</p>}
    </section>
  );

  const worth = (
    <section aria-labelledby="sh-worth"><h2 className="sh" id="sh-worth">Worth a look</h2>
      {view.mailNote && <p className="freshnote" role="note">{view.mailNote}</p>}
      <ImportantBody go={go} limit={3} exclude={exclude} />
    </section>
  );

  const center = (
    <>
      {head}
      {view.staleDay && <p className="freshnote" role="note">This is from {doc.dateLabel}. I’ll show today once I can reach your helper.</p>}
      {checkin}{banner(view.checkinBanner)}
      {wrap}{banner(view.wrapBanner)}
      {needsSection}
      {nextUp}
      {doneSection}
      {!wide && worth}
      <p className="weekly">{doc.weekLine.text}</p>
    </>
  );
  const sheets = (
    <>
      <Sheet id="done-dlg" titleId="done-title" title="Done for you" open={!!doneLine} onClose={() => setDoneLine(null)}>
        {doneLine && (
          <div className="sheet-body">
            <p className="donebanner" data-trust={doneLine.trust}><Check /><span><Said text={doneLine.text} parts={doneLine.parts} trust={doneLine.trust} /></span></p>
            <p className="soft" style={{ fontSize: 14.5 }}>{new Date(doneLine.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</p>
            <div className="acts dacts">
              <button type="button" className="vbtn" onClick={() => { const o = doneLine.open; setDoneLine(null); open(o); }}>See it</button>
              {!aboutOfDone(doneLine) && (
                <button type="button" className="vbtn vbtn-helper" onClick={() => { const l = doneLine; setDoneLine(null); ask({ label: l.text.length > 60 ? `${l.text.slice(0, 59)}…` : l.text, projectId: null }); }}><Spark />Ask about this</button>
              )}
            </div>
            {/* Ask about this (W4's one component) on the thing the line is about: the answer shows here */}
            {aboutOfDone(doneLine) && <AskAbout key={doneLine.id} {...aboutOfDone(doneLine)!} label={doneLine.text.length > 40 ? `${doneLine.text.slice(0, 39)}…` : doneLine.text} />}
          </div>
        )}
      </Sheet>
    </>
  );
  if (!desk) return <div>{center}{sheets}</div>;
  return (
    <div className="cols cols-today">
      <aside className="col-side inboxcol" aria-labelledby="ib-h">
        <h2 className="coltitle" id="ib-h">Worth a look <button type="button" className="linkish quietlink" onClick={() => go('inbox')}>All email</button></h2>
        {wide && <ImportantBody go={go} exclude={exclude} />}
      </aside>
      <div className="col-main">{center}</div>
      <aside className="col-side" aria-labelledby="cd-h">
        <h2 className="coltitle" id="cd-h">Your day <span className="soft">{new Date(now).toLocaleDateString('en-US', { weekday: 'short' })} {new Date(now).getDate()}</span></h2>
        <YourDay now={now} note={cal.showEvents ? (cal.state === 'ok' ? null : cal.note) : cal.note} known={cal.showEvents} free={cal.canSayFree} onOpen={setEvent} />
      </aside>
      {sheets}
      <EventSheet item={event} conflicts={[]} fixtures={fixtures} onClose={() => setEvent(null)} />
    </div>
  );
}

/** What a Done line is about, for W4's AskAbout (an action in the activity log has no thing to ask about: null). */
function aboutOfDone(d: TodayDone): { kind: 'event' | 'draft' | 'job' | 'mail' | 'item'; id: string } | null {
  const o = d.open;
  if (!o.id) return null;
  if (o.kind === 'calendar') return { kind: o.id.startsWith('cd_') ? 'draft' : 'event', id: o.id };
  if (o.kind === 'job') return { kind: 'job', id: o.id };
  if (o.kind === 'mail') return { kind: 'mail', id: o.id };
  if (o.kind === 'item') return { kind: 'item', id: o.id };
  return null;
}

/** The desktop's right-hand column: the whole day (events and drafts), live from the store, with the "now" line. */
function YourDay({ now, note, known, free, onOpen }: { now: number; note: string | null; known: boolean; free: boolean; onOpen: (i: CalendarItem) => void }) {
  const day = startOfDay(now);
  const range = useMemo(() => ({ from: new Date(day), to: new Date(addDays(day, 1)) }), [day]);
  const cal = useCalendar(range);
  const drafts = useDraftActions();
  const { fixtures } = useMeta();
  const items = useMemo(() => displayItems(cal.items, drafts.ops), [cal.items, drafts.ops]);
  const empty: ReactNode = !known ? note : free ? <><span className="big" aria-hidden="true">☀︎</span>Nothing planned. A free day!</> : 'Nothing on the calendars I can see.';
  return (
    <>
      {known && note && <p className="freshnote" role="note">{note}</p>}
      <DayAgenda day={day} items={known ? items : []} conflicts={cal.conflicts} now={now} isToday empty={empty} onOpen={onOpen} fixtures={fixtures} label="Your day" />
    </>
  );
}
