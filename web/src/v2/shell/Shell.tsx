/**
 * The v2 app frame (v2 build, slice W1), as approved in the prototype:
 *   phone (< 900 px): a slim header with the status pill on every screen; the content; the "Ask, or hand over a job"
 *     bar (mic, send arrow) above four tabs — Today · Calendar · Important · Projects; Settings from the avatar on
 *     Today.
 *   desktop (≥ 900 px): a top bar — MWA · Today · Calendar · Important · Projects · status pill · Ask · avatar; Today
 *     in three columns from 1200 px.
 * The pill opens the working sheet; the Ask bar opens the Ask sheet.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useMeta, useNotices, useStatusPill } from '../store/react';
import { AskSheet, WorkingSheet, type AskAbout } from './sheets';
import { Calendar, Important, Projects, Settings, Today, type View } from './screens';
import { Arrow, Mic, Person, Spark, TabCalendar, TabImportant, TabProjects, TabToday, Close } from './icons';

const TABS: { view: View; label: string; icon: ReactNode }[] = [
  { view: 'today', label: 'Today', icon: <TabToday /> },
  { view: 'calendar', label: 'Calendar', icon: <TabCalendar /> },
  { view: 'inbox', label: 'Important', icon: <TabImportant /> },
  { view: 'projects', label: 'Projects', icon: <TabProjects /> },
];
const SCREENS = { today: Today, calendar: Calendar, inbox: Important, projects: Projects, settings: Settings };

function useMedia(q: string): boolean {
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const f = () => setM(mq.matches);
    mq.addEventListener('change', f); f();
    return () => mq.removeEventListener('change', f);
  }, [q]);
  return m;
}

function StatusPill({ onOpen }: { onOpen: () => void }) {
  const pill = useStatusPill();
  return (
    <button type="button" className={`statuspill ${pill.tone}`} id="statuspill" title={pill.text} onClick={onOpen}>
      <span className="dot" aria-hidden="true" /><span>{pill.text}</span>
    </button>
  );
}

function ConnLine() {
  const { connection, updatedAt, waitingToSend } = useMeta();
  if (connection === 'live' || connection === 'starting' || connection === 'connecting') {
    return waitingToSend ? <span className="connline" role="status">Sending {waitingToSend}…</span> : null;
  }
  const when = updatedAt ? new Date(updatedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : null;
  return (
    <span className="connline" role="status">
      {connection === 'offline' ? 'Offline' : 'Can’t reach your helper'}
      {when && <span className="when"> · updated {when}</span>}
      {waitingToSend ? <span className="when"> · {waitingToSend} to send</span> : null}
    </span>
  );
}

/** A note fades after 6 s; one with an action (Undo) stays 10 s, and none fades while it is hovered or focused. */
export const TOAST_MS = 6_000, TOAST_ACTION_MS = 10_000;
function Toasts() {
  const { notices, dismiss } = useNotices();
  const [paused, setPaused] = useState({ hover: false, focus: false });
  const held = paused.hover || paused.focus;
  // a note closed by its own button takes the focus with it (no blur follows): release the focus hold
  const close = (id: string) => { setPaused((p) => ({ ...p, focus: false })); dismiss(id); };
  // the last note gone: nothing is held any more
  useEffect(() => { if (!notices.length) setPaused({ hover: false, focus: false }); }, [notices.length]);
  useEffect(() => {
    if (!notices.length || held) return;
    const t = setTimeout(() => dismiss(notices[0].id), notices[0].action ? TOAST_ACTION_MS : TOAST_MS);
    return () => clearTimeout(t);
  }, [notices, dismiss, held]);
  return (
    <div className="toasts" id="toasts" role="status" aria-live="polite" data-paused={held ? 'true' : undefined}
      onMouseEnter={() => setPaused((p) => ({ ...p, hover: true }))} onMouseLeave={() => setPaused((p) => ({ ...p, hover: false }))}
      onFocus={() => setPaused((p) => ({ ...p, focus: true }))}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPaused((p) => ({ ...p, focus: false })); }}>
      {notices.map((n) => (
        <div key={n.id} className={`toast${n.tone === 'error' ? ' error' : ''}`}>
          <p>{n.text}</p>
          {n.action && <button type="button" className="vbtn vbtn-quiet toastact" onClick={() => { close(n.id); n.action!.run(); }}>{n.action.label}</button>}
          <button type="button" className="iconbtn" aria-label="Dismiss" onClick={() => close(n.id)}><Close size={18} /></button>
        </div>
      ))}
    </div>
  );
}

function UpdateBar() {
  const { updateReady } = useMeta();
  if (!updateReady) return null;
  return (
    <div className="updatebar" role="alert">
      <p>A newer version is ready</p>
      <button type="button" className="vbtn" onClick={() => location.reload()}>Reload</button>
    </div>
  );
}

function SignIn() {
  return (
    <main id="main" className="main" tabIndex={-1}>
      <div className="card signin-card">
        <h1 style={{ fontSize: 26 }}>Sign in to continue</h1>
        <p style={{ marginTop: 10 }}>This device isn’t signed in to your helper any more. Sign in with your password, or pair this phone again from the app on your computer.</p>
        <div className="acts"><button type="button" className="vbtn vbtn-primary" onClick={() => { location.href = '/'; }}>Sign in</button></div>
      </div>
    </main>
  );
}

export function Shell() {
  const { auth, fixtures } = useMeta();
  const desk = useMedia('(min-width: 900px)');
  const wide = useMedia('(min-width: 1200px)');
  const [view, setView] = useState<View>(() => {
    const v = new URLSearchParams(location.search).get('view');
    return v && v in SCREENS ? (v as View) : 'today';
  });
  const [workOpen, setWorkOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [about, setAbout] = useState<AskAbout | null>(null);
  const main = useRef<HTMLElement>(null);
  const first = useRef(true);
  const go = useCallback((v: View) => { setView(v); window.scrollTo(0, 0); }, []);
  useEffect(() => { if (first.current) { first.current = false; return; } main.current?.focus({ preventScroll: true }); }, [view]);
  const ask = useCallback((a?: AskAbout) => { setWorkOpen(false); setAbout(a ?? null); setAskOpen(true); }, []);

  if (auth === 'signin') return <div className="v2app"><SignIn /><UpdateBar /></div>;
  const Screen = SCREENS[view];
  return (
    <div className="v2app">
      <a className="skip" href="#main">Skip to content</a>
      <header className="topbar" id="topbar">
        <span className="brand" aria-hidden="true">MWA</span>
        {fixtures && <span className="simtag" title="Fixture mode: example data, no real calendar, email or AI">simulated</span>}
        <nav className="topnav" aria-label="Main">
          {TABS.map((t) => (
            <button key={t.view} type="button" className="topnav-btn" aria-current={view === t.view ? 'page' : undefined} onClick={() => go(t.view)}>{t.label}</button>
          ))}
        </nav>
        <span className="grow" />
        <ConnLine />
        <StatusPill onOpen={() => setWorkOpen(true)} />
        <button type="button" className="askpill" aria-label="Ask, or hand over a job" onClick={() => ask()}><Spark /><span>Ask</span></button>
        <button type="button" className="avatar avatar-top" aria-label="Settings" onClick={() => go('settings')}><Person /></button>
      </header>

      <main id="main" ref={main} className="main" tabIndex={-1}>
        <Screen desk={desk} wide={wide} go={go} ask={ask} openWork={() => setWorkOpen(true)} />
      </main>

      <div className="askdock" id="askdock"><div className="askcap">
        <button type="button" className="askfield" onClick={() => ask()}><span>Ask, or hand over a job</span></button>
        {/* voice arrives with P4; until then holding the mic opens the Ask sheet to type */}
        <button type="button" className="dockmic" id="dock-mic" aria-label="Hold to talk" onClick={() => ask()}><Mic /></button>
        <span className="docksend" aria-hidden="true" onClick={() => ask()}><Arrow /></span>
      </div></div>

      <nav className="tabbar" id="tabbar" aria-label="Main">
        {TABS.map((t) => (
          <button key={t.view} type="button" className="tab" aria-current={view === t.view ? 'page' : undefined} onClick={() => go(t.view)}>
            {t.icon}<span>{t.label}</span>
          </button>
        ))}
      </nav>

      <Toasts />
      <UpdateBar />
      <WorkingSheet open={workOpen} onClose={() => setWorkOpen(false)} onAskAbout={ask} />
      <AskSheet open={askOpen} about={about} onClose={() => setAskOpen(false)} />
    </div>
  );
}
