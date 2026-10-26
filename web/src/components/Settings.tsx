import { useEffect, useState } from 'react';
import { getVault, forgetVault, getQuiet, setQuiet, getBilling, setBudget, type VaultRow, type QuietState, type BillingSummary } from '../api';
import { Connections } from './Connections';
import { Log } from './Log';

const usd = (n: number) => (n >= 10 ? `$${n.toFixed(2)}` : n >= 0.01 ? `$${n.toFixed(3)}` : n > 0 ? `$${n.toFixed(4)}` : '$0');
const k = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n));

/** Billing and token tracking (2026-10-27): what the model calls cost, where it went, and a monthly budget. */
function Billing() {
  const [b, setB] = useState<BillingSummary | null>(null);
  const [budgetText, setBudgetText] = useState('');
  const [msg, setMsg] = useState('');
  const load = () => getBilling().then((s) => { setB(s); if (s?.budget.monthlyUsd) setBudgetText(String(s.budget.monthlyUsd)); });
  useEffect(() => { void load(); }, []);
  if (!b) return null;
  const { month, budget, balance } = b;
  const max = Math.max(...b.days.map((d) => d.cost), 0.0001);
  const state = budget.state === 'over' ? 'text-signal' : budget.state === 'warn' ? 'text-signal' : 'text-ok';
  return (
    <section aria-labelledby="s-billing">
      <h2 id="s-billing" className="label mb-2">Billing and tokens</h2>
      <div className="rounded-[4px] border border-line bg-surface px-4 py-3 space-y-3">
        <p className="text-[15px]"><strong>{usd(month.cost)}</strong> so far in {month.label} · {month.calls} model call{month.calls === 1 ? '' : 's'} · {k(month.tokens.in)} in ({k(month.tokens.cached)} cached), {k(month.tokens.out)} out{month.tokens.reasoning ? `, ${k(month.tokens.reasoning)} reasoning` : ''}</p>
        {budget.monthlyUsd ? (
          <div>
            <div className="h-2 rounded bg-line overflow-hidden" role="progressbar" aria-valuenow={Math.min(100, budget.pct ?? 0)} aria-valuemin={0} aria-valuemax={100} aria-label="Share of the monthly budget used">
              <div className={`h-2 ${budget.state === 'ok' ? 'bg-ok' : 'bg-signal'}`} style={{ width: `${Math.min(100, budget.pct ?? 0)}%` }} />
            </div>
            <p className={`text-[13.5px] mt-1 ${state}`}>{budget.pct}% of the ${budget.monthlyUsd} monthly budget{budget.state === 'over' ? ' — reached: scheduled jobs wait until next month or a higher budget; chats still run' : budget.state === 'warn' ? ' — close to it' : ''}.</p>
          </div>
        ) : <p className="text-[13.5px] text-dim">No monthly budget set.</p>}
        {budget.fixed ? <p className="text-[13px] text-dim">The budget is set by this deployment (MWA_MONTHLY_BUDGET_USD).</p> : (
          <form className="flex flex-wrap items-end gap-2" onSubmit={async (e) => { e.preventDefault(); const r = await setBudget(budgetText ? budgetText : 'off'); setMsg(r.message); void load(); }}>
            <label className="text-[13px]">Monthly budget $<input type="number" min={1} step={1} value={budgetText} onChange={(e) => setBudgetText(e.target.value)} className="rounded-[3px] border border-edge bg-bone px-2 py-1.5 text-[14px] w-24" aria-label="Monthly budget in dollars" /></label>
            <button className="btn small primary">Save</button>
            {budget.monthlyUsd && <button type="button" className="btn small" onClick={async () => { const r = await setBudget('off'); setMsg(r.message); setBudgetText(''); void load(); }}>Turn off</button>}
          </form>
        )}
        {msg && <p className="text-[13px] text-dim" role="status">{msg}</p>}
        {balance && <p className="text-[13.5px]">{balance.provider === 'openrouter' ? 'OpenRouter' : balance.provider} balance: <strong>{usd(balance.remainingUsd)}</strong> left (checked {new Date(balance.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}).</p>}
        <div>
          <p className="text-[13px] text-dim mb-1">Last 30 days, by day</p>
          <div className="flex items-end gap-[2px] h-12" aria-label="Spend by day for the last 30 days">
            {b.days.map((d) => <div key={d.day} title={`${d.day}: ${usd(d.cost)} · ${d.calls} calls`} className="flex-1 bg-ink/70 rounded-t-[2px] min-w-[3px]" style={{ height: `${Math.max(d.cost > 0 ? 6 : 1, Math.round((d.cost / max) * 100))}%` }} />)}
          </div>
          <p className="text-[12px] text-dim mt-0.5">{b.days[0].day} to {b.days[b.days.length - 1].day}</p>
        </div>
        {b.byModel.length > 0 && (
          <dl className="kv">
            <dt>By model</dt><dd>{b.byModel.slice(0, 6).map((m) => `${m.model} ${usd(m.cost)} (${m.calls})`).join(' · ')}</dd>
            {b.bySession.length > 0 && <><dt>Costliest</dt><dd>{b.bySession.slice(0, 5).map((s) => `${s.kind === 'job' ? 'job' : 'chat'} ${s.session.replace(/^job_/, '').slice(0, 14)} ${usd(s.cost)}`).join(' · ')}</dd></>}
          </dl>
        )}
        <p className="text-[13px]"><a className="linkbtn" href="/api/billing.csv?days=30" download>Download the last 30 days as CSV</a> <span className="text-dim">· one row per model call, for an expense claim</span></p>
      </div>
    </section>
  );
}

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
        <Billing />
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
