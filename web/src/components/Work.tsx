import { useEffect, useState } from 'react';
import { getWork, continueWork, setWorkStatus, openConversation, type WorkGoal } from '../api';
import { openFile } from './Markdown';

/** BL-71d: everything MWA is working on for you — where each piece stands, what it waits on, its files —
 *  with Continue to pick it up and a way back to the conversation it came from. Robert, 2026-10-22: "if I say
 *  hey report back what you were working on I should be able to jump right to it." */
const STATUS: Record<WorkGoal['status'], string> = { in_progress: 'working on it', open: 'not started', blocked: 'paused', done: 'done' };

function since(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return new Date(ts).toLocaleDateString();
}

/** The record's lines, without the parts shown elsewhere on the card. */
function recordLines(text: string): string[] {
  return text.split('\n').filter((l) => !/^(Files: |From conversation |Updated )/.test(l))
    .map((l) => l.replace(/^Where we are on "[^"]*" \(goal [^)]*\): /, ''));
}

export function Work({ refresh }: { refresh?: number }) {
  const [goals, setGoals] = useState<WorkGoal[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [showDone, setShowDone] = useState(false);
  const load = () => getWork().then(setGoals);
  useEffect(() => { void load(); }, [refresh]);

  async function act(g: WorkGoal, what: 'continue' | WorkGoal['status']) {
    setBusy(g.id);
    const r = what === 'continue' ? await continueWork(g.id) : await setWorkStatus(g.id, what);
    setMsg((m) => ({ ...m, [g.id]: r.message }));
    setBusy(null);
    void load();
  }

  const active = (goals ?? []).filter((g) => g.status !== 'done');
  const done = (goals ?? []).filter((g) => g.status === 'done');
  const card = (g: WorkGoal) => (
    <li key={g.id} className="py-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-[16px] font-semibold leading-snug flex-1 min-w-[200px]">{g.title}</h3>
        <span className={`mono text-[11px] uppercase tracking-wide ${g.status === 'in_progress' ? 'text-signal' : 'text-dim'}`}>{STATUS[g.status]}</span>
      </div>
      {g.record ? (
        <div className="mt-2 text-[14px] leading-relaxed">
          {g.record.untrusted && <div className="mono text-[11px] text-dim mb-1">noted after reading outside content</div>}
          {recordLines(g.record.text).map((l, i) => <p key={i} className={i ? 'text-dim' : ''}>{l}</p>)}
          {g.record.files.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
              {g.record.files.map((f) => (
                <button key={f} onClick={() => openFile(f)} className="mono text-[12px] underline hover:text-signal break-all text-left">{f.split('/').pop()}</button>
              ))}
            </div>
          )}
          <div className="mono text-[11px] text-dim mt-1.5">updated {since(g.record.at)}{g.jobs ? ` · ${g.jobs} job${g.jobs > 1 ? 's' : ''} waiting to run` : ''}</div>
        </div>
      ) : (
        <p className="mt-2 text-[14px] text-dim">No note on where this stands yet.{g.jobs ? ` ${g.jobs} job${g.jobs > 1 ? 's' : ''} waiting to run.` : ''}</p>
      )}
      {g.thought && g.status !== 'done' && (
        // BL-71e: what MWA proposes, from thinking time. A proposal only: Continue acts on it.
        <p className="mt-2 text-[14px] border-l-2 border-line pl-2.5">
          <span className="mono text-[11px] text-dim uppercase tracking-wide mr-1.5">{g.thought.kind === 'ask' ? 'question for you' : g.thought.kind === 'next' ? 'next step' : g.thought.kind === 'done' ? 'looks finished' : 'waiting on'}</span>
          {g.thought.text}
          {g.thought.untrusted && <span className="mono text-[11px] text-dim"> · from a note written after reading outside content</span>}
        </p>
      )}
      <div className="flex flex-wrap gap-2 mt-3">
        {g.status !== 'done' && (
          <button disabled={busy === g.id} onClick={() => void act(g, 'continue')} className="rounded-[3px] bg-signal text-white px-3 py-1.5 text-[13px] font-medium hover:opacity-90 disabled:opacity-50">Continue</button>
        )}
        {g.record?.conv && (
          <button onClick={() => openConversation(g.record!.conv!)} className="rounded-[3px] border border-line bg-surface px-3 py-1.5 text-[13px] hover:border-signal hover:text-signal">Open its conversation</button>
        )}
        {g.status !== 'done' && <button disabled={busy === g.id} onClick={() => void act(g, 'done')} className="mono text-[11px] uppercase tracking-wide text-dim hover:text-signal px-1">mark done</button>}
        {g.status === 'done' && <button disabled={busy === g.id} onClick={() => void act(g, 'open')} className="mono text-[11px] uppercase tracking-wide text-dim hover:text-signal px-1">reopen</button>}
        {g.status === 'in_progress' && <button disabled={busy === g.id} onClick={() => void act(g, 'blocked')} className="mono text-[11px] uppercase tracking-wide text-dim hover:text-signal px-1">pause</button>}
      </div>
      {msg[g.id] && <p className="mono text-[12px] text-dim mt-2">{msg[g.id]}</p>}
    </li>
  );

  return (
    <div className="py-8">
      <h2 className="text-2xl font-semibold tracking-tight">Work</h2>
      <p className="text-dim text-[14px] mb-5">What I'm working on for you, and where each piece stands. Continue picks one up where it left off.</p>
      {goals === null ? <p className="mono text-[13px] text-dim">loading…</p>
        : !active.length && !done.length ? <p className="text-dim">Nothing yet. When you ask me to work on something in the background, it shows up here.</p>
        : (
          <>
            {active.length ? <ul className="divide-y divide-line border-y border-line">{active.map(card)}</ul> : <p className="text-dim">Nothing in progress.</p>}
            {done.length > 0 && (
              <div className="mt-6">
                <button onClick={() => setShowDone(!showDone)} className="mono text-[11px] uppercase tracking-wide text-dim hover:text-signal">{showDone ? 'hide' : 'show'} finished ({done.length})</button>
                {showDone && <ul className="divide-y divide-line border-y border-line mt-2">{done.map(card)}</ul>}
              </div>
            )}
          </>
        )}
    </div>
  );
}
