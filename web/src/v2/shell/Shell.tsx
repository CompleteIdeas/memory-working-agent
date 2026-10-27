/**
 * The v2 app frame (v2 build, slice W1), as approved in the prototype:
 *   phone (< 900 px): a slim header with the status pill on every screen; the content; the "Ask, or hand over a job"
 *     bar (mic, send arrow) above four tabs — Today · Calendar · Important · Projects; Settings from the avatar on
 *     Today.
 *   desktop (≥ 900 px): a top bar — MWA · Today · Calendar · Important · Projects · status pill · Ask · avatar; Today
 *     in three columns from 1200 px.
 * The pill opens the working sheet; the Ask bar opens the Ask sheet.
 */
import { useNotificationRoutes } from './notifyRoute';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useMeta, useNotices, useNow, useStatusPill, useStore } from '../store/react';
import { useUpdate } from '../../pwa/react';
import { applyUpdate, serverTooOld } from '../../pwa/register';
import { updateWords } from '../../pwa/update';
import { offlineWords } from '../../pwa/offline';
import { WorkingSheet, type AskAbout } from './sheets';
import { Assistant, Calendar, Connections, Important, Plugins, Settings, Today, type View } from './screens';
import { AskSheet } from '../screens/ask/AskSheet';
import { Projects } from '../screens/projects/Projects';
import { Arrow, Person, Spark, TabCalendar, TabImportant, TabProjects, TabToday, Close } from './icons';
import { useStartGate } from '../screens/start/Start';
import { MicButton } from '../screens/ask/voice/Mic';
import { useDictation } from '../screens/ask/voice/useDictation';

const TABS: { view: View; label: string; icon: ReactNode }[] = [
  { view: 'today', label: 'Today', icon: <TabToday /> },
  { view: 'calendar', label: 'Calendar', icon: <TabCalendar /> },
  { view: 'inbox', label: 'Important', icon: <TabImportant /> },
  { view: 'projects', label: 'Projects', icon: <TabProjects /> },
];
const SCREENS = { today: Today, calendar: Calendar, inbox: Important, projects: Projects, settings: Settings, plugins: Plugins, assistant: Assistant, connections: Connections };

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

/**
 * P2: "A new version is ready · Reload". Two sources, one banner: a new build's service worker waiting (src/pwa/), or the
 * API's 426 (the store's updateReady), which also makes the page look for that worker first. Reload waits up to 15 s
 * for actions on their way to land; anything still in flight then is put in the outbox with its key (parkInflight) and
 * the outbox is saved, so it is sent again after the reload and never lost (the server answers a repeated key with its
 * first answer). Then the new worker takes over and the page reloads once. If no new build arrives within ~20 s the
 * banner says "Couldn’t get the update — try again" and the button works again (src/pwa/update.ts).
 */
export const RELOAD_WAIT_MS = 15_000;
export function UpdateBar() {
  const store = useStore();
  const { updateReady } = useMeta();
  const update = useUpdate();
  const [preparing, setPreparing] = useState(false);
  useEffect(() => { if (updateReady) serverTooOld(); }, [updateReady]);
  const words = updateWords(update) ?? (updateReady ? { text: 'A new version is ready', button: 'Reload' } : null);
  if (!words) return null;
  const busy = preparing || update.phase === 'applying' || update.phase === 'reloading';
  const reload = async () => {
    if (busy) return;
    setPreparing(true);
    try {
      const t0 = Date.now();
      while (store.getState().inflight.length && Date.now() - t0 < RELOAD_WAIT_MS) await new Promise((r) => setTimeout(r, 100));
      await store.parkInflight();
      await Promise.race([store.idle(), new Promise((r) => setTimeout(r, 2_000))]);
    } finally { setPreparing(false); }
    applyUpdate();
  };
  return (
    <div className="updatebar" role="alert">
      <p>{busy ? 'Updating…' : words.text}</p>
      <button type="button" className="vbtn" disabled={busy} onClick={() => void reload()}>{words.button}</button>
    </div>
  );
}

/** P2: the quiet offline banner: what the screen shows is the saved copy, and what waits to be sent. */
export function OfflineBar() {
  const { connection, updatedAt, waitingToSend, updateReady, auth } = useMeta();
  const now = useNow();
  const w = offlineWords({ connection, updatedAt, waiting: waitingToSend, now, blocked: updateReady || auth === 'signin' });
  if (!w) return null;
  return (
    <div className="offlinebar" role="status" id="offlinebar">
      <p>{w.head}</p>
      {w.waiting && <p className="offlinewait">{w.waiting}</p>}
    </div>
  );
}

export function Shell() {
  const { fixtures } = useMeta();
  const start = useStartGate();
  const desk = useMedia('(min-width: 900px)');
  const wide = useMedia('(min-width: 1200px)');
  const [view, setView] = useState<View>(() => {
    const v = new URLSearchParams(location.search).get('view');
    return v && v in SCREENS ? (v as View) : 'today';
  });
  const [workOpen, setWorkOpen] = useState(false);
  // P1: the home-screen shortcut "Ask" opens with the Ask sheet (?ask=1)
  const [askOpen, setAskOpen] = useState(() => new URLSearchParams(location.search).get('ask') === '1');
  const [about, setAbout] = useState<AskAbout | null>(null);
  // W4: what the screen has open (a project): the Ask bar and the mic ask there
  const [context, setContext] = useState<AskAbout | null>(null);
  const contextRef = useRef<AskAbout | null>(null);
  contextRef.current = context;
  const main = useRef<HTMLElement>(null);
  const first = useRef(true);
  const go = useCallback((v: View) => { setView(v); window.scrollTo(0, 0); }, []);
  useEffect(() => { if (first.current) { first.current = false; return; } main.current?.focus({ preventScroll: true }); }, [view]);
  // P4: one voice controller; the dock's mic opens the Ask sheet already listening
  const voice = useDictation();
  const ask = useCallback((a?: AskAbout) => { setWorkOpen(false); setAbout(a ?? contextRef.current); setAskOpen(true); }, []);
  // P3: a tapped notification opens its place (#/today, #/approval/<id>, #/job/<id>, #/settings/notifications)
  const openWork = useCallback(() => { setAskOpen(false); setWorkOpen(true); }, []);
  useNotificationRoutes({ go, openWork, ready: !start });

  // W5: sign in, pair this phone, or first run on the computer, before the app itself (screens/start)
  // P2 (review): the toasts show there too ("Signed out — this phone’s copy was cleared")
  if (start) return <div className="v2app">{start}<Toasts /><UpdateBar /></div>;
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

      <OfflineBar />
      <main id="main" ref={main} className="main" tabIndex={-1}>
        <Screen desk={desk} wide={wide} go={go} ask={ask} onContext={setContext} openWork={() => setWorkOpen(true)} />
      </main>

      <div className="askdock" id="askdock"><div className="askcap">
        <button type="button" className="askfield" onClick={() => ask()}><span>Ask, or hand over a job</span></button>
        {/* P4: tap or hold the mic: the Ask sheet opens listening (hidden where voice is off or not in this browser) */}
        {voice.available && <MicButton d={voice} className="dockmic" id="dock-mic" describedBy="mic-hint" before={() => ask()} />}
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
      <AskSheet open={askOpen} about={about} dictation={voice} onClose={() => setAskOpen(false)} onShowWork={() => { setAskOpen(false); setWorkOpen(true); }} />
    </div>
  );
}
