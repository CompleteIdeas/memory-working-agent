import { useEffect, useState } from 'react';
import { getVault, forgetVault, getQuiet, setQuiet, type VaultRow, type QuietState } from '../api';
import { Connections } from './Connections';
import { Log } from './Log';

function Quiet() {
  const [q, setQ] = useState<QuietState | null>(null);
  const [from, setFrom] = useState('21:00');
  const [to, setTo] = useState('07:00');
  const [msg, setMsg] = useState('');
  const load = () => getQuiet().then((s) => { setQ(s); const m = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(s?.window ?? ''); if (m) { setFrom(m[1]); setTo(m[2]); } });
  useEffect(() => { void load(); }, []);
  if (!q) return null;
  return (
    <section aria-labelledby="s-quiet">
      <h2 id="s-quiet" className="label mb-2">Quiet hours</h2>
      <div className="rounded-[4px] border border-line bg-surface px-4 py-3">
        <p className="text-[14px]">{q.window ? <>Messages wait between <strong>{q.window.replace('-', ' and ')}</strong> ({q.timeZone}). Jobs still run on time.</> : 'Off: results and decisions can reach you at any time.'}</p>
        {q.fixed ? <p className="text-[13px] text-dim mt-1">Set by this deployment; it can't be changed here.</p> : (
          <form className="flex flex-wrap items-end gap-2 mt-2" onSubmit={async (e) => { e.preventDefault(); const r = await setQuiet(`${from}-${to}`); setMsg(r.message); void load(); }}>
            <label className="text-[13px]">From <input type="time" value={from} onChange={(e) => setFrom(e.target.value)} className="rounded-[3px] border border-edge bg-bone px-2 py-1.5 text-[14px]" /></label>
            <label className="text-[13px]">to <input type="time" value={to} onChange={(e) => setTo(e.target.value)} className="rounded-[3px] border border-edge bg-bone px-2 py-1.5 text-[14px]" /></label>
            <button className="btn small primary">Save</button>
            {q.window && <button type="button" className="btn small" onClick={async () => { const r = await setQuiet('off'); setMsg(r.message); void load(); }}>Turn off</button>}
          </form>
        )}
        {msg && <p className="text-[13px] text-dim mt-1.5" role="status">{msg}</p>}
      </div>
    </section>
  );
}

function Vault() {
  const [rows, setRows] = useState<VaultRow[] | null>(null);
  const [msg, setMsg] = useState('');
  const load = () => getVault().then(setRows);
  useEffect(() => { void load(); }, []);
  return (
    <section aria-labelledby="s-vault">
      <h2 id="s-vault" className="label mb-2">Saved logins and keys</h2>
      <div className="rounded-[4px] border border-line bg-surface px-4 py-3">
        <p className="text-[13.5px] text-dim">Stored encrypted on this machine. MWA uses one only on its own site and never sees the value. To save one, ask in the chat (“remember my club portal login”); a card opens where you type it.</p>
        {rows === null ? null : !rows.length ? <p className="text-[14px] mt-2">Nothing saved.</p> : (
          <ul className="divide-y divide-line mt-2">
            {rows.map((v) => (
              <li key={v.name} className="flex flex-wrap items-center gap-2 py-2">
                <span className="flex-1 min-w-[180px] text-[14.5px]"><strong>{v.name}</strong>{v.site ? ` · ${v.site}` : ''} <span className="text-[13px] text-dim">({v.fields.join(', ')}{v.savedAt ? `, saved ${new Date(v.savedAt).toLocaleDateString()}` : ''})</span></span>
                <button className="btn small" onClick={async () => { if (!window.confirm(`Forget the saved login "${v.name}"? Jobs that use it will ask again.`)) return; const r = await forgetVault(v.name); setMsg(r.message); void load(); }}>Forget</button>
              </li>
            ))}
          </ul>
        )}
        {msg && <p className="text-[13px] text-dim mt-1.5" role="status">{msg}</p>}
      </div>
    </section>
  );
}

/** One place for settings (D5): what MWA can read and do, the model, connections, quiet hours, saved logins, the
 *  warm-start and the activity log. */
export function Settings({ onWizard }: { onWizard: () => void }) {
  return (
    <div className="py-6 space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-dim text-[14px]">What MWA can read and do, the model it uses, how it reaches you, and its activity log.</p>
      </div>
      <Connections />
      <div className="max-w-xl space-y-6">
        <Quiet />
        <Vault />
        <section aria-labelledby="s-warm">
          <h2 id="s-warm" className="label mb-2">Warm up memory</h2>
          <div className="rounded-[4px] border border-line bg-surface px-4 py-3">
            <p className="text-[14px]">Point MWA at a folder of your documents so it starts out knowing your work. You review every note before it is kept.</p>
            <button className="btn small mt-2" onClick={onWizard}>Start the warm-up</button>
          </div>
        </section>
      </div>
      <details className="max-w-3xl">
        <summary className="label cursor-pointer py-2">Activity log (every run, its outcome and cost)</summary>
        <div className="mt-2"><Log /></div>
      </details>
    </div>
  );
}
