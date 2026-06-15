import { useEffect, useState } from 'react';
import { getStatus, getStats } from './api';
import { Chat } from './components/Chat';
import { Onboarding } from './components/Onboarding';
import { Connections } from './components/Connections';
import { Memory } from './components/Memory';
import { Log } from './components/Log';

type View = 'chat' | 'connections' | 'memory' | 'log';

// The signature instrument readout: a real count of what the agent remembers, with a
// 5-cell bar on a log scale (≈10k memories fills it). Honest — wired to /api/stats.
function MemoryMeter({ n }: { n: number }) {
  const cells = 5;
  const fill = Math.max(n > 0 ? 1 : 0, Math.min(cells, Math.round((Math.log10(n + 1) / 4) * cells)));
  return (
    <div className="flex items-center gap-2 mono text-[11px] text-dim" title={`${n} memories`}>
      <span className="uppercase tracking-[0.2em] hidden sm:inline">memory</span>
      <span className="flex gap-[2px]">
        {Array.from({ length: cells }).map((_, i) => (
          <span key={i} className={`w-[6px] h-3 ${i < fill ? 'bg-signal' : 'bg-line'}`} />
        ))}
      </span>
      <span className="text-graphite tabular-nums">{n.toLocaleString()}</span>
    </div>
  );
}

function Header({ dark, setDark, memN, view, setView, showNav }: { dark: boolean; setDark: (v: boolean) => void; memN: number; view: View; setView: (v: View) => void; showNav: boolean }) {
  const tab = (v: View, label: string) => (
    <button
      onClick={() => setView(v)}
      className={`mono text-[12px] uppercase tracking-[0.12em] px-1 py-0.5 border-b-2 transition-colors ${view === v ? 'border-signal text-graphite' : 'border-transparent text-dim hover:text-graphite'}`}
    >
      {label}
    </button>
  );
  return (
    <header className="border-b border-line">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 h-[60px] flex items-center justify-between gap-4">
        <div className="flex items-baseline gap-2.5 shrink-0">
          <span className="text-[22px] font-bold tracking-tight">MWA</span>
          {showNav && (
            <nav className="flex items-center gap-3 ml-2">
              {tab('chat', 'chat')}
              {tab('connections', 'connect')}
              {tab('memory', 'memory')}
              {tab('log', 'log')}
            </nav>
          )}
        </div>
        <div className="flex items-center gap-4">
          <MemoryMeter n={memN} />
          <button
            onClick={() => setDark(!dark)}
            aria-label="Toggle theme"
            className="rounded-[3px] border border-line w-8 h-8 grid place-items-center text-sm hover:border-signal hover:text-signal transition-colors"
          >
            {dark ? '☀' : '☾'}
          </button>
        </div>
      </div>
    </header>
  );
}

export default function App() {
  const [ready, setReady] = useState<boolean | null>(null);
  const [memN, setMemN] = useState(0);
  const [view, setView] = useState<View>('chat');
  const [dark, setDark] = useState(() => localStorage.getItem('mwa-dark') === '1');

  const refreshStats = () => getStats().then((d) => setMemN(d.memories)).catch(() => {});

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('mwa-dark', dark ? '1' : '0');
  }, [dark]);

  useEffect(() => {
    getStatus().then((s) => setReady(s.ready)).catch(() => setReady(false));
    refreshStats();
  }, []);

  return (
    <div className="min-h-full flex flex-col">
      <Header dark={dark} setDark={setDark} memN={memN} view={view} setView={setView} showNav={ready === true} />
      <main className="flex-1 w-full max-w-3xl mx-auto px-4 sm:px-6">
        {ready === null ? (
          <div className="py-20 text-center mono text-dim text-sm">connecting…</div>
        ) : !ready ? (
          <Onboarding onReady={() => { setReady(true); refreshStats(); }} />
        ) : (
          <>
            {/* Chat stays mounted (hidden) so the conversation survives tab switches. */}
            <div className={view === 'chat' ? '' : 'hidden'}>
              <Chat onActivity={refreshStats} />
            </div>
            {view === 'connections' && <Connections />}
            {view === 'memory' && <Memory />}
            {view === 'log' && <Log />}
          </>
        )}
      </main>
    </div>
  );
}
