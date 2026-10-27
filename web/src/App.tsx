import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { getStatus, getStats } from './api';
import { StoreProvider, useStore } from './store';
import { Chat } from './components/Chat';
import { Onboarding } from './components/Onboarding';
import { Memory } from './components/Memory';
import { OnboardWizard } from './components/OnboardWizard';
import { Files } from './components/Files';
import { FileModal } from './components/FileViewer';
import { TaskRail, TasksPage } from './components/Tasks';
import { Settings } from './components/Settings';
import { StatusChip } from './components/TaskParts';
import { stateLine, STATUS_LABEL, type TaskStatus } from './tasks';
import { chooseUi } from './v2/choose';

// D5 (usability review 2026-10-24): Chat · Tasks · Files · Memory · Settings. Connect, Log and Warm-start moved into
// Settings; Work became Tasks. Phones get a bottom tab bar instead of a nav row that was cut off at 390 px.
type View = 'chat' | 'tasks' | 'files' | 'memory' | 'settings';
const VIEWS: { id: View; label: string }[] = [
  { id: 'chat', label: 'Chat' }, { id: 'tasks', label: 'Tasks' }, { id: 'files', label: 'Files' }, { id: 'memory', label: 'Memory' }, { id: 'settings', label: 'Settings' },
];

function MemoryMeter({ n }: { n: number }) {
  const cells = 5;
  const fill = Math.max(n > 0 ? 1 : 0, Math.min(cells, Math.round((Math.log10(n + 1) / 4) * cells)));
  return (
    <div className="hidden sm:flex items-center gap-2 mono text-[12px] text-dim" title={`${n} memories`} aria-label={`${n} memories`}>
      <span className="flex gap-[2px]" aria-hidden="true">
        {Array.from({ length: cells }).map((_, i) => <span key={i} className={`w-[6px] h-3 ${i < fill ? 'bg-accent' : 'bg-line'}`} />)}
      </span>
      <span className="text-graphite tabular-nums">{n.toLocaleString()}</span>
    </div>
  );
}

function NeedsYou({ onOpen }: { onOpen: () => void }) {
  const { allTasks, looseCards } = useStore();
  const n = allTasks.filter((t) => t.status === 'needs-you').length + looseCards.length;
  return (
    <button onClick={onOpen} className={`btn small !gap-2 ${n ? '!border-signal' : ''}`} aria-label={`Needs you: ${n}`} data-needs-you={n}>
      <span>Needs you</span>
      <span className={`mono text-[12px] rounded-full px-1.5 min-w-[20px] text-center ${n ? 'bg-signal text-onsignal' : 'bg-line text-graphite'}`}>{n}</span>
    </button>
  );
}

/** Phones: one line for the task that is working, from any conversation, with a way to it. */
function ActiveStrip() {
  const { allTasks, openSession } = useStore();
  const t = allTasks.find((x) => x.status === 'working');
  if (!t) return null;
  return (
    <div className="lg:hidden border-b border-line bg-surface px-4 py-2 flex items-center gap-2 min-w-0" role="status">
      <StatusChip status="working" />
      <span className="text-[13.5px] truncate flex-1 min-w-0">{t.title} · {stateLine(t)}</span>
      <button className="btn small shrink-0" onClick={() => openSession(t.session, t.key)}>View</button>
    </div>
  );
}

/** Says out loud (and shows) when a task changes state, and offers a way to one that finished elsewhere. */
function Announcer() {
  const { allTasks, session, toast, openSession, toasts, dismissToast } = useStore();
  const prev = useRef<Map<string, TaskStatus> | null>(null);
  const [said, setSaid] = useState('');
  useEffect(() => {
    const now = new Map(allTasks.map((t) => [t.key, t.status] as const));
    if (prev.current) {
      for (const t of allTasks) {
        const was = prev.current.get(t.key);
        if (!was || was === t.status) continue;
        const msg = `${t.title}: ${STATUS_LABEL[t.status]}`;
        setSaid(msg);
        if (t.session !== session && (t.status === 'done' || t.status === 'needs-you' || t.status === 'failed')) toast(t.status === 'done' ? `${t.title} is ready` : msg, { label: 'Open', run: () => openSession(t.session, t.key) });
      }
    }
    prev.current = now;
  }, [allTasks]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <div className="sr-only" role="status" aria-live="polite">{said}</div>
      <div className="fixed right-3 top-[64px] z-40 flex flex-col gap-2 max-w-[calc(100vw-24px)] w-[360px]" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="rounded-[3px] bg-graphite text-bone px-3.5 py-2.5 text-[14px] shadow-lg flex items-center gap-3">
            <span className="flex-1 min-w-0">{t.text}</span>
            {t.action && <button className="underline font-semibold shrink-0 min-h-[32px]" onClick={() => { t.action!.run(); dismissToast(t.id); }}>{t.action.label}</button>}
            <button className="underline shrink-0 min-h-[32px]" onClick={() => dismissToast(t.id)} aria-label="Dismiss">✕</button>
          </div>
        ))}
      </div>
    </>
  );
}

function Shell({ dark, setDark, memN, onWizard }: { dark: boolean; setDark: (v: boolean) => void; memN: number; onWizard: () => void }) {
  const store = useStore();
  const [view, setView] = useState<View>('chat');
  const [tasksFilter, setTasksFilter] = useState<{ f: string; n: number }>({ f: 'all', n: 0 });
  useEffect(() => {
    const show = (e: Event) => setView(String((e as CustomEvent).detail) as View);
    window.addEventListener('mwa-show', show); return () => window.removeEventListener('mwa-show', show);
  }, []);
  const go = (v: View) => { setView(v); window.scrollTo({ top: 0 }); };
  const openNeeds = () => { setTasksFilter({ f: 'needs-you', n: Date.now() }); go('tasks'); };
  const tab = (v: View, label: string) => (
    <button key={v} onClick={() => { if (v === 'tasks') setTasksFilter({ f: 'all', n: Date.now() }); go(v); }} aria-current={view === v ? 'page' : undefined}
      className={`mono text-[12px] uppercase tracking-[0.12em] px-2 py-2 border-b-2 whitespace-nowrap ${view === v ? 'border-accent text-graphite' : 'border-transparent text-dim hover:text-graphite'}`}>{label}</button>
  );
  return (
    <div className="min-h-full flex flex-col">
      <header className="sticky top-0 z-30 bg-bone border-b border-line">
        <div className="h-14 px-4 lg:px-5 flex items-center gap-4">
          <span className="text-[22px] font-bold tracking-tight shrink-0">MWA</span>
          <nav aria-label="Main" className="hidden lg:flex items-center gap-1">{VIEWS.map((v) => tab(v.id, v.label))}</nav>
          <div className="ml-auto flex items-center gap-3">
            <MemoryMeter n={memN} />
            <NeedsYou onOpen={openNeeds} />
            <button onClick={() => setDark(!dark)} aria-label={dark ? 'Use light theme' : 'Use dark theme'} className="btn small !w-9 !px-0">{dark ? '☀' : '☾'}</button>
          </div>
        </div>
        <ActiveStrip />
      </header>
      <div className="flex-1 lg:grid lg:grid-cols-[272px_minmax(0,1fr)]">
        <aside className="hidden lg:block border-r border-line px-3 py-4 sticky top-14 self-start max-h-[calc(100dvh-56px)] overflow-y-auto">
          <TaskRail onAll={() => { setTasksFilter({ f: 'all', n: Date.now() }); go('tasks'); }} />
        </aside>
        <main className="w-full max-w-3xl mx-auto px-4 sm:px-6 pb-20 lg:pb-0 min-w-0">
          <div className={view === 'chat' ? '' : 'hidden'}><Chat /></div>
          {view === 'tasks' && <TasksPage key={tasksFilter.n} initial={tasksFilter.f} />}
          {view === 'files' && <Files />}
          {view === 'memory' && <Memory />}
          {view === 'settings' && <Settings onWizard={onWizard} />}
        </main>
      </div>
      <nav aria-label="Main" className="lg:hidden fixed bottom-0 inset-x-0 z-30 bg-bone border-t border-line grid grid-cols-5 h-16">
        {VIEWS.map((v) => (
          <button key={v.id} onClick={() => { if (v.id === 'tasks') setTasksFilter({ f: 'all', n: Date.now() }); go(v.id); }} aria-current={view === v.id ? 'page' : undefined}
            className={`mono text-[11.5px] uppercase tracking-[0.08em] border-t-2 ${view === v.id ? 'border-accent text-graphite font-semibold' : 'border-transparent text-dim'}`}>{v.label}</button>
        ))}
      </nav>
      <Announcer />
    </div>
  );
}

function V1App() {
  const [ready, setReady] = useState<boolean | null>(null);
  const [memN, setMemN] = useState(0);
  const [wizard, setWizard] = useState(false);
  const [dark, setDark] = useState(() => { try { return localStorage.getItem('mwa-dark') === '1'; } catch { return false; } });
  const [viewing, setViewing] = useState<string | null>(null);
  useEffect(() => {
    const open = (e: Event) => setViewing(String((e as CustomEvent).detail));
    window.addEventListener('mwa-open-file', open); return () => window.removeEventListener('mwa-open-file', open);
  }, []);
  const refreshStats = () => getStats().then((d) => setMemN(d.memories)).catch(() => {});
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    try { localStorage.setItem('mwa-dark', dark ? '1' : '0'); } catch { /* */ }
  }, [dark]);
  useEffect(() => {
    getStatus().then((s) => setReady(s.ready)).catch(() => setReady(false));
    refreshStats();
  }, []);

  if (ready === null) return <div className="py-20 text-center mono text-dim text-sm">connecting…</div>;
  if (!ready) {
    return (
      <main className="w-full max-w-3xl mx-auto px-4 sm:px-6">
        <Onboarding onReady={() => { setReady(true); getStats().then((d) => { setMemN(d.memories); if (d.memories === 0) setWizard(true); }).catch(() => {}); }} />
      </main>
    );
  }
  if (wizard) {
    return (
      <main className="w-full max-w-3xl mx-auto px-4 sm:px-6">
        <OnboardWizard onDone={() => { setWizard(false); refreshStats(); }} onSkip={() => setWizard(false)} onConnectService={() => { setWizard(false); setTimeout(() => window.dispatchEvent(new CustomEvent('mwa-show', { detail: 'settings' })), 100); }} />
      </main>
    );
  }
  return (
    <StoreProvider onActivity={refreshStats}>
      <Shell dark={dark} setDark={setDark} memN={memN} onWizard={() => setWizard(true)} />
      {viewing && <FileModal path={viewing} onClose={() => setViewing(null)} />}
    </StoreProvider>
  );
}

// v2 build, slice W1: the v2 app (web/src/v2) is chosen by `?ui=v2` (remembered in localStorage `mwa-ui`) or by
// fixture mode (`?fixtures=1`); `?ui=v1` goes back. v1 stays the default until W6, and nothing in it changes: v2 is a
// lazy chunk with its own styles that v1 never loads.
const V2App = lazy(() => import('./v2'));
export default function App() {
  const [ui] = useState(() => {
    let stored: string | null = null;
    try { stored = localStorage.getItem('mwa-ui'); } catch { /* private mode */ }
    const pick = chooseUi(location.search, stored, location.pathname);
    const asked = new URLSearchParams(location.search).get('ui');
    if (asked === 'v1' || asked === 'v2') { try { localStorage.setItem('mwa-ui', asked); } catch { /* */ } }
    return pick;
  });
  if (ui === 'v2') return <Suspense fallback={null}><V2App /></Suspense>;
  return <V1App />;
}
