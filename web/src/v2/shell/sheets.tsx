/**
 * The shell's sheets (v2 build, slice W1): the working sheet (opened from the status pill) and the Ask sheet (from
 * the Ask bar). Accessible names follow the prototype's contract (scratchpad/ux/prototype-v2/REPLAY-NOTES.md):
 * `#work-dlg` titled with the pill's text, groups `heading "Waiting for you · N"` …, each job an `article` named by
 * its title; `#ask-dlg` with `textbox "Message your helper"` and `button "Send"`; both close with `button "Close"`.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useJobs, useMeta, useProjectMap, useProjects, useSendMessage, useStatusPill, useThread } from '../store/react';
import { jobLine, money } from '../store/status';
import type { Job, MessageSent } from '../api/client';
import { Close, Spark } from './icons';

export function Sheet({ id, titleId, title, open, onClose, head, children }: {
  id: string; titleId: string; title: ReactNode; open: boolean; onClose: () => void; head?: ReactNode; children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="sheet" id={id} aria-labelledby={titleId}
      onClose={() => { if (open) onClose(); }}
      onClick={(e) => {
        // a click on the backdrop closes the sheet (the backdrop belongs to the dialog: check the click is outside it)
        if (e.target !== e.currentTarget) return;
        const r = e.currentTarget.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose();
      }}>
      <div className="sheet-grab" aria-hidden="true" />
      <div className="sheet-head">
        <h2 id={titleId} className="sheet-title">{title}</h2>
        {head}
        <button type="button" className="iconbtn" aria-label="Close" onClick={onClose}><Close /></button>
      </div>
      {children}
    </dialog>
  );
}

export interface AskAbout { label: string; projectId: string | null }

// ---------- the working sheet ----------

const GROUP_CLASS = { waiting: 'partial', working: 'running', finished: 'done', stopped: 'stopped', scheduled: 'scheduled' } as const;

export function WorkingSheet({ open, onClose, onAskAbout }: { open: boolean; onClose: () => void; onAskAbout: (a: AskAbout) => void }) {
  const pill = useStatusPill();
  const jobs = useJobs();
  const projects = useProjectMap();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (j: Job, f: (j: Job) => Promise<unknown>) => { setBusy(j.id); try { await f(j); } finally { setBusy(null); } };
  const primary = (j: Job) => {
    const a = j.status.primaryAction;
    if (!a) return null;
    const handler = { stop: jobs.stop, continue: jobs.continue, 'start-over': jobs.startOver, open: jobs.open, resume: jobs.resume, review: null }[a.action];
    if (!handler) return null; // approvals are reviewed in the classic app until W4
    const filled = j.status.state === 'waiting' || j.status.state === 'partly_done' || (a.action === 'open' && j.status.resultReady);
    return (
      <button type="button" className={`vbtn${filled ? ' vbtn-primary' : ''}`} disabled={busy === j.id} onClick={() => void run(j, handler)}>{a.label}</button>
    );
  };
  return (
    <Sheet id="work-dlg" titleId="work-title" title={pill.text} open={open} onClose={onClose}>
      <div className="sheet-body" id="work-body">
        <p className="monthline">{jobs.monthLine}</p>
        {!jobs.groups.length && <p className="empty">Nothing running. I’ll keep an eye on your day.</p>}
        {jobs.groups.map((g) => (
          <section key={g.key} className={`jobgroup ${GROUP_CLASS[g.key]}`} aria-labelledby={`jg-${g.key}`}>
            <h3 className="jg-h" id={`jg-${g.key}`}>{g.title} · {g.jobs.length}</h3>
            {g.jobs.map((j) => {
              const p = j.progress;
              const pct = p && p.total > 0 ? Math.round((p.done / p.total) * 100) : null;
              const live = j.status.state === 'working' || j.status.state === 'continuing';
              const projectName = j.projectId ? projects[j.projectId]?.name ?? 'General' : 'General';
              return (
                <article key={j.id} className={`job ${GROUP_CLASS[g.key]}`} aria-labelledby={`jt-${j.id}`}>
                  <span className="ptag">{projectName}</span>
                  <h4 id={`jt-${j.id}`}>{j.title}</h4>
                  <p className={`state ${g.key === 'waiting' ? 'waiting' : ''}`}>{jobLine(j)}</p>
                  {pct !== null && p && (
                    <div className="prog" role="progressbar" aria-label={`${j.title} progress`} aria-valuemin={0} aria-valuemax={p.total} aria-valuenow={p.done} aria-valuetext={`${p.done} of ${p.total} ${p.unit}`}>
                      <i style={{ width: `${pct}%` }} />
                    </div>
                  )}
                  {!live && j.status.detail && <p className={g.key === 'waiting' ? 'ask' : ''} style={g.key === 'waiting' ? undefined : { marginTop: 8 }}>{j.status.detail}</p>}
                  <p className="cost">{live ? `${money(j.costUsd)} so far` : `${money(j.costUsd)} spent`}{live && j.capUsd != null ? ` · stops at $${j.capUsd.toFixed(2)}` : ''}</p>
                  <div className="acts">
                    {primary(j)}
                    <button type="button" className="vbtn vbtn-quiet" onClick={() => onAskAbout({ label: j.title, projectId: j.projectId })}><Spark />Ask about this</button>
                  </div>
                </article>
              );
            })}
          </section>
        ))}
      </div>
    </Sheet>
  );
}

// ---------- the Ask sheet ----------

interface Sent { id: number; text: string; projectId: string; turnId?: string; note?: string; error?: boolean }

export function AskSheet({ open, about, onClose }: { open: boolean; about: AskAbout | null; onClose: () => void }) {
  const projects = useProjects();
  const { fixtures } = useMeta();
  const send = useSendMessage();
  const general = projects.find((p) => p.general) ?? null;
  const target = about?.projectId ?? general?.id ?? null;
  const targetName = projects.find((p) => p.id === target)?.name ?? null;
  const { turns } = useThread(open ? target : null);
  const [text, setText] = useState('');
  const [sent, setSent] = useState<Sent[]>([]);
  const [sending, setSending] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const n = useRef(0);
  useEffect(() => { if (open) { setSent([]); setText(''); setTimeout(() => input.current?.focus(), 30); } }, [open, about]);
  const byTurn = useMemo(() => new Map(turns.map((t) => [t.id, t])), [turns]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const words = text.trim();
    if (!words || sending) return;
    if (!target) { setSent((s) => [...s, { id: ++n.current, text: words, projectId: '', note: 'Your helper isn’t reachable yet. Try again in a moment.', error: true }]); return; }
    setSending(true);
    const full = about ? `About ${about.label}: ${words}` : words;
    const id = ++n.current;
    setSent((s) => [...s, { id, text: words, projectId: target }]);
    setText('');
    const r = await send(target, full);
    setSending(false);
    setSent((s) => s.map((x) => (x.id !== id ? x
      : r.ok ? { ...x, turnId: (r.data as MessageSent | undefined)?.turnId, note: (r.data as MessageSent | undefined)?.state === 'offer' ? (r.data as MessageSent).message : undefined }
      : { ...x, note: r.message, error: !r.queued })));
  };

  return (
    <Sheet id="ask-dlg" titleId="ask-title" title="Ask your helper" open={open} onClose={onClose}
      head={<span className="ask-ctx" id="ask-ctx">{about ? <span className="aboutchip">About: {about.label}</span> : null}</span>}>
      <div className="ask-log" id="ask-log" role="log" aria-live="polite" aria-label="Conversation with your helper">
        {sent.map((m) => {
          const t = m.turnId ? byTurn.get(m.turnId) : undefined;
          return (
            <div key={m.id} className="thread">
              <div className="msg-you">{m.text}</div>
              {m.note ? <p className="ask-note">{m.note}</p>
                : !t || t.kind === 'running' ? <span className="typing" aria-label="Your helper is answering"><i /><i /><i /></span>
                : (
                  <div className="msg-h">
                    <div className="who"><Spark size={16} />Your helper{fixtures ? <span className="simmini">simulated</span> : null}</div>
                    <div className="txt">{t.reply || t.message}</div>
                  </div>
                )}
            </div>
          );
        })}
      </div>
      <form className="ask-form" id="ask-form" autoComplete="off" noValidate onSubmit={(e) => void submit(e)}>
        {targetName && <p className="ask-note" style={{ padding: '0 4px 8px' }}>Goes to {targetName}.</p>}
        <div className="ask-row">
          <label htmlFor="ask-input" className="sr-only">Message your helper</label>
          <input ref={input} id="ask-input" className="ask-input" type="text" placeholder="Ask anything…" enterKeyHint="send" value={text} onChange={(e) => setText(e.target.value)} />
          <button type="submit" className="sendbtn" id="send-btn" aria-label="Send" disabled={sending}>
            <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </div>
      </form>
    </Sheet>
  );
}
