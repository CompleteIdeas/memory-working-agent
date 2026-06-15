import { useEffect, useState } from 'react';
import { getConnections, toggleTool, connectGmail, type Connections as Conn } from '../api';

// Turn tools & accounts on without editing files. (One-click email = a future managed
// option; today the Gmail button runs the local sign-in flow.)
export function Connections() {
  const [c, setC] = useState<Conn | null>(null);
  const [msg, setMsg] = useState('');
  const load = () => getConnections().then(setC);
  useEffect(() => { load(); }, []);

  async function flip(id: string, on: boolean) {
    setC((prev) => prev ? { ...prev, tools: prev.tools.map((t) => (t.id === id ? { ...t, on } : t)) } : prev);
    await toggleTool(id, on);
  }
  async function gmail() {
    setMsg('Opening sign-in…');
    const r = await connectGmail();
    setMsg(r.message ?? (r.ok ? 'Started.' : 'Could not start — is Google set up?'));
  }

  if (!c) return <div className="py-16 mono text-dim text-sm">loading…</div>;
  const row = 'flex items-center justify-between gap-3 rounded-[4px] border border-line bg-surface px-4 py-3';

  return (
    <div className="py-8 max-w-xl space-y-6">
      <div>
        <div className="mono text-[11px] text-dim uppercase tracking-[0.2em] mb-2">accounts</div>
        <div className="space-y-2">
          <div className={row}>
            <div><div className="font-medium">Email & Calendar</div><div className="text-dim text-sm">Read & draft (never sends)</div></div>
            {c.gmail
              ? <span className="mono text-[12px] text-signal">connected ✓</span>
              : <button onClick={gmail} className="rounded-[3px] bg-signal text-white px-4 py-2 text-sm font-medium">Connect</button>}
          </div>
          <div className={row}>
            <div><div className="font-medium">Telegram</div><div className="text-dim text-sm">Chat with it from your phone</div></div>
            <span className={`mono text-[12px] ${c.telegram ? 'text-signal' : 'text-dim'}`}>{c.telegram ? 'connected ✓' : 'not set up'}</span>
          </div>
        </div>
        {msg && <p className="mono text-[12px] text-dim mt-2">{msg}</p>}
      </div>

      <div>
        <div className="mono text-[11px] text-dim uppercase tracking-[0.2em] mb-2">tools</div>
        <div className="space-y-2">
          {c.tools.map((t) => (
            <label key={t.id} className={row + ' cursor-pointer'}>
              <div><div className="font-medium">{t.label}</div><div className="text-dim text-sm">{t.desc}</div></div>
              <input type="checkbox" checked={t.on} onChange={(e) => flip(t.id, e.target.checked)} className="w-5 h-5 accent-[var(--color-signal)]" />
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
