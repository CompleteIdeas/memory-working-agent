import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { STATUS_LABEL, plainCard, stateLine, clock, minsLeft, secs, shortenPaths, type Card, type Task, type TaskStatus } from '../tasks';
import type { ScheduleRow } from '../api';
import { TOOL_LABELS, stopRun } from '../api';

const CHIP: Record<TaskStatus, string> = { 'needs-you': 'you', working: 'run', scheduled: '', done: 'done', stopped: '', failed: 'fail' };
export function StatusChip({ status }: { status: TaskStatus }) {
  return <span className={`chip ${CHIP[status]}`} data-status={status}>{STATUS_LABEL[status]}</span>;
}

/** Ticks once a second while mounted. */
function useNow(on = true): number {
  const [n, setN] = useState(Date.now());
  useEffect(() => { if (!on) return; const iv = setInterval(() => setN(Date.now()), 1000); return () => clearInterval(iv); }, [on]);
  return n;
}

/** While a task runs (F06): the real stage, what it touches, the time so far, Stop, and "Add a note" (F08). */
export function LiveStatus({ task }: { task: Task }) {
  const { stop, steer } = useStore();
  const now = useNow(true);
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState('');
  const [sending, setSending] = useState(false);
  const live = task.live!;
  const el = secs(now - live.startedAt);
  const s = live.stage;
  const background = task.offer?.answered === 'background' && !task.live?.runId;
  return (
    <div className="mt-2 rounded-[3px] border border-line bg-surface px-3 py-2.5" data-live={task.key}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <StatusChip status="working" />
        <span className="text-[14.5px] font-medium min-w-0" data-stage>
          {live.stopping ? 'Stopping: the step that is running finishes, nothing new starts.'
            : s ? <>{`Step ${s.n}`}: {s.label}{s.detail && <span className="mono text-[13px] font-normal"> · {s.detail}</span>}</>
            : background ? 'Working on it in the background. You can leave; the result comes back here.'
            : 'Getting started'}
        </span>
        <span className="mono text-[12px] text-dim tabular-nums" aria-label={`running for ${el}`}>{el}</span>
        {!background && (
          <span className="flex gap-2 ml-auto">
            <button className="btn small" disabled={live.stopping} onClick={async () => setMsg(await stop(task.session))} aria-label={`Stop: ${task.title}`}>{live.stopping ? 'Stopping…' : 'Stop'}</button>
            <button className="btn small" aria-expanded={noting} onClick={() => setNoting(!noting)}>Add a note</button>
          </span>
        )}
      </div>
      {live.notes.length > 0 && (
        <ul className="mt-1.5 text-[13.5px] space-y-0.5">{live.notes.map((n, i) => <li key={i}><span className="label mr-1.5">you added</span>{n}</li>)}</ul>
      )}
      {noting && (
        <form className="flex flex-wrap gap-2 mt-2" onSubmit={async (e) => {
          e.preventDefault(); if (!note.trim()) return; setSending(true);
          const r = await steer(task.session, note.trim()); setSending(false); setMsg(r.message); if (r.ok) { setNote(''); setNoting(false); }
        }}>
          <label className="sr-only" htmlFor={`note-${task.key}`}>A note for this task</label>
          <input id={`note-${task.key}`} autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. keep it informal, and mention the regatta" className="flex-1 min-w-[200px] rounded-[3px] border border-edge bg-bone px-3 py-2 text-[14px]" />
          <button className="btn small primary" disabled={sending || !note.trim()}>Add to this task</button>
        </form>
      )}
      {msg && <p className="text-[13px] text-dim mt-1.5" role="status">{msg}</p>}
    </div>
  );
}

/** A decision inside its task (D2, F01–F03, F19): what happens, to what, where, the expiry, Approve / Don't. */
export function CardView({ card, telegram }: { card: Card; telegram: boolean }) {
  const { decide, deciding, send, session } = useStore();
  const [msg, setMsg] = useState('');
  const [exact, setExact] = useState(false);
  const p = plainCard(card);
  const busy = deciding.has(card.id);
  const pending = card.state === 'pending';
  const outcome: Record<Card['state'], string> = {
    pending: '', approved: 'Approved. Waiting for the other app to run it.', done: 'Approved and done.', failed: 'Approved, but it failed.',
    declined: "You said don't. Nothing was changed.", expired: `Expired${card.expiresAt || card.at ? ` at ${clock((card.expiresAt ?? card.at)!)}` : ''}. Nothing was changed.`,
  };
  return (
    <div className={`mt-3 rounded-[3px] border px-3.5 py-3 ${pending ? 'border-signal bg-surface' : 'border-line'}`} role="group" aria-label={`Decision: ${p.title}`} data-card={card.id} data-card-state={card.state}>
      <div className="label">{pending ? 'needs your decision' : `decision · ${card.state === 'declined' ? "you said don't" : card.state}`}{card.dupes.length > 0 && pending ? ` · asked ${card.dupes.length + 1} ways, one decision` : ''}</div>
      <h3 className="text-[16px] font-semibold mt-0.5 break-words">{p.title}</h3>
      <dl className="kv">
        {p.rows.map(([k, v]) => <div key={k} className="contents"><dt>{k}</dt><dd>{v}</dd></div>)}
        {pending && <><dt>If you approve</dt><dd>{p.ifApprove}</dd><dt>If you don't</dt><dd>{p.ifDecline}</dd></>}
        {pending && card.tainted && !card.readLocal && <><dt>Note</dt><dd>It was proposed after reading outside content (a web page or an email). Check it is what you want.</dd></>}
      </dl>
      {p.exact && (
        <div className="mt-1.5">
          <button className="linkbtn text-[13px]" aria-expanded={exact} onClick={() => setExact(!exact)}>{exact ? 'Hide the exact action' : 'Show the exact action'}</button>
          {exact && <pre className="mono text-[12px] whitespace-pre-wrap break-all bg-bone border border-line rounded-[3px] p-2 mt-1">{p.exact}</pre>}
        </div>
      )}
      {pending ? (
        <div className="flex flex-wrap items-center gap-2 mt-2.5">
          <button className="btn primary" disabled={busy} onClick={async () => { const r = await decide(card.id, true, card.dupes); setMsg(shortenPaths(r.message).slice(0, 240)); }}>{busy ? 'Working…' : 'Approve'}</button>
          <button className="btn" disabled={busy} onClick={async () => { const r = await decide(card.id, false, card.dupes); setMsg(r.ok ? '' : shortenPaths(r.message).slice(0, 240)); }}>Don't</button>
          {card.expiresAt && <span className="text-[13px] text-dim">Expires {clock(card.expiresAt)} ({minsLeft(card.expiresAt)})</span>}
          {!telegram && null}
        </div>
      ) : (
        <p className={`text-[14px] mt-2 ${card.state === 'done' ? 'text-ok' : card.state === 'failed' || card.state === 'expired' ? 'text-signal' : ''}`}>
          {outcome[card.state]}{card.result && card.state !== 'declined' && card.state !== 'expired' ? ` ${shortenPaths(card.result).slice(0, 200).replace(/^(.)/, (m) => m.toUpperCase()).replace(/([^.!?])$/, '$1.')}` : ''}
          {card.kind === 'captured-policy' && card.state === 'done' && <> You can remove it under Memory.</>}
          {card.state === 'expired' && <> <button className="linkbtn" onClick={() => send(`Please ask me again: ${p.title}`, { session: card.session ?? session })}>Ask again</button></>}
        </p>
      )}
      {msg && <p className="text-[13px] text-dim mt-1.5 break-words" role="status">{msg}</p>}
    </div>
  );
}

/** The person's words, without the copies a later change appends ("… [later] …"). */
export function words(request: string): string { return [...new Set(request.split(/\s*\[later\]\s*/).map((x) => x.trim()).filter(Boolean))].join(' Then: '); }

const KIND: Record<ScheduleRow['kind'], string> = { reminder: 'reminder', watch: 'watch', task: 'recurring job' };
function hhmm(row: ScheduleRow): string {
  const m = /daily:(\d{2}:\d{2})/.exec(row.recur ?? '');
  if (m) return m[1];
  const d = new Date(row.due); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function ymd(ms: number): string { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

/** A scheduled job with its controls (D4, F04): Pause / Resume, Change time, Cancel with a ten-minute Undo. */
export function JobCard({ row, cancelledAt }: { row: ScheduleRow; cancelledAt?: number }) {
  const { jobAction, schedule } = useStore();
  // one request made several jobs (backend B3 catches exact twins only): say so, so the extras can go
  const twins = schedule.filter((j) => j.id !== row.id && words(j.request) === words(row.request)
    && (j.when === row.when || (!j.recur && !row.recur && Math.abs(j.due - row.due) < 30 * 60_000)));
  const [twinMsg, setTwinMsg] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [time, setTime] = useState(hhmm(row));
  const [every, setEvery] = useState(() => Number(/every:(\d+)/.exec(row.recur ?? '')?.[1] ?? 0));
  const now = useNow(!!cancelledAt);
  const act = async (a: Parameters<typeof jobAction>[0], body: Record<string, unknown> = {}) => {
    setBusy(true); const r = await jobAction(a, { id: row.id, ...body }); setBusy(false); setMsg(r.message); if (r.ok) setEditing(false);
  };
  const off = !!cancelledAt;
  const undoLeft = cancelledAt ? 10 * 60_000 - (now - cancelledAt) : 0;
  const daily = /^daily:/.test(row.recur ?? '');
  const interval = /^every:/.test(row.recur ?? '');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);
  return (
    <div className={`mt-3 rounded-[3px] border px-3.5 py-3 ${off ? 'border-line' : 'border-edge bg-surface'}`} data-job={row.id} role="group" aria-label={`Scheduled: ${row.request}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="label">{KIND[row.kind]}</span>
        {row.paused && !off && <span className="chip">paused</span>}
        {off && <span className="chip">cancelled</span>}
      </div>
      <p className="text-[15px] mt-1 break-words">{shortenPaths(words(row.request))}</p>
      {!off && twins.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <p className="text-[13.5px] text-signal">{twins.length === 1 ? 'Another job' : `${twins.length} other jobs`} with the same words run at about the same time: probably duplicates of this one.</p>
          <button className="btn small" disabled={busy} onClick={async () => { setBusy(true); let n = 0; for (const t of twins) { const r = await jobAction('cancel', { id: t.id }); if (r.ok) n++; } setBusy(false); setTwinMsg(`Cancelled ${n} duplicate${n === 1 ? '' : 's'}; this one stays. Each can be undone for ten minutes.`); }}>Keep this one, cancel the {twins.length === 1 ? 'other' : `other ${twins.length}`}</button>
        </div>
      )}
      {twinMsg && <p className="text-[13px] text-dim mt-1" role="status">{twinMsg}</p>}
      <dl className="kv">
        <dt>{off ? 'Was' : 'Runs'}</dt><dd>{row.when}</dd>
        {row.live && <><dt>Running now</dt><dd aria-live="polite">{row.live.stage?.tool ? `${TOOL_LABELS[row.live.stage.tool] ?? String(row.live.stage.tool).replace(/_/g, ' ')}${row.live.stage.detail ? ` · ${shortenPaths(String(row.live.stage.detail))}` : ''}` : 'Starting'} · {Math.round(row.live.elapsedMs / 1000)}s{row.live.stopping ? ' · stopping' : ''}{!row.live.stopping && <> <button type="button" className="btn small" onClick={() => { void stopRun(`job_${row.id}`); }}>Stop</button></>}</dd></>}
        {!off && !row.paused && <><dt>Next</dt><dd>{new Date(row.due).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</dd></>}
        {row.lastRun && <><dt>Last result</dt><dd>{shortenPaths(row.lastRun.summary).slice(0, 220)}{row.lastRun.value ? ` (${row.lastRun.value})` : ''} · {new Date(row.lastRun.at).toLocaleString([], { hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short' })}</dd></>}
        {row.fails ? <><dt>Problems</dt><dd className="text-signal">{row.fails} run{row.fails > 1 ? 's' : ''} could not finish</dd></> : null}
        {row.allow && (row.allow.vault?.length || row.allow.click?.length) ? <><dt>Allowed to</dt><dd>{[...(row.allow.vault ?? []).map((v) => `sign in with your saved login "${v}"`), ...(row.allow.click ?? []).map((c) => `click "${c.label}" on ${c.host}`)].join('; ')}</dd></> : null}
      </dl>
      {off ? (
        <div className="flex flex-wrap items-center gap-2 mt-2.5">
          {undoLeft > 0 ? <><button className="btn small" disabled={busy} onClick={() => act('uncancel')}>Undo cancel</button><span className="text-[13px] text-dim">Undo possible for {secs(undoLeft)}</span></>
            : <span className="text-[13px] text-dim">Cancelled. It will not run.</span>}
        </div>
      ) : editing ? (
        <form className="flex flex-wrap items-end gap-2 mt-2.5" onSubmit={(e) => {
          e.preventDefault();
          if (interval) void act('update', { every_minutes: every });
          else if (daily) void act('update', { daily_at: time });
          else { const d = new Date(row.due); const [h, m] = time.split(':').map(Number); d.setHours(h, m, 0, 0); if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1); void act('update', { at: `${ymd(d.getTime())} ${time}` }); }
        }}>
          {interval ? (
            <label className="text-[13px]">Every <input ref={ref} type="number" min={5} max={1440} value={every} onChange={(e) => setEvery(Number(e.target.value))} className="w-20 rounded-[3px] border border-edge bg-bone px-2 py-1.5 text-[14px]" /> minutes</label>
          ) : (
            <label className="text-[13px]">{daily ? 'Time each day' : 'New time'} <input ref={ref} type="time" value={time} onChange={(e) => setTime(e.target.value)} className="rounded-[3px] border border-edge bg-bone px-2 py-1.5 text-[14px]" /></label>
          )}
          <button className="btn small primary" disabled={busy}>Save</button>
          <button type="button" className="btn small" onClick={() => setEditing(false)}>Cancel</button>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2 mt-2.5">
          <button className="btn small" disabled={busy} onClick={() => setEditing(true)}>Change time</button>
          {row.paused ? <button className="btn small" disabled={busy} onClick={() => act('resume')}>Resume</button>
            : <button className="btn small" disabled={busy} onClick={() => act('pause')}>Pause</button>}
          <button className="btn small" disabled={busy} onClick={() => act('cancel')}>{row.kind === 'watch' ? 'Stop watching' : row.kind === 'reminder' ? 'Cancel reminder' : 'Cancel job'}</button>
        </div>
      )}
      {msg && <p className="text-[13px] text-dim mt-1.5" role="status">{msg}</p>}
    </div>
  );
}

/** The one line where a task stands, with its chip: the same in the rail, the list and the conversation. */
export function TaskState({ task }: { task: Task }) {
  return <span className="flex items-center gap-1.5 min-w-0"><StatusChip status={task.status} /><span className="text-[13px] text-dim truncate">{stateLine(task)}</span></span>;
}
