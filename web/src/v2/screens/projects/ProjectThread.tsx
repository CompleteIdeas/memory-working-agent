/**
 * A project's conversation (v2 build, slice W4): its thread a page at a time ("Earlier messages" asks for the page
 * before), the answer being written live with Stop and "Add to it", "using what I know from …" under answers that
 * used another project, the chip on a question asked about one thing, the offer to work on it in the background, a
 * divider before a conversation imported from before projects, and "Move to another project" on every message.
 * The composer at the bottom asks in this project (POST /ask with its id), so a big ask gets its plan card here.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useAsk, useCalendarItem, useJobMap, useLive, useProjectActions, useProjectMap, useProjects, useThread } from '../../store/react';
import type { Project, Turn } from '../../api/client';
import { Spark } from '../../shell/icons';
import { AskOutcomeView, HelperSays, Typing, Who, useStopRun } from '../ask/AskOutcome';
import { AnswerText, answerWords } from '../ask/answerText';
import { ABOUT_NOUN, provenanceLine, refusalFor, runActionRefusal, stageLine, type Refusal } from '../ask/logic';
import { turnNotes } from './logic';
import { menuKeys, useDismiss } from './useDismiss';

interface Sent { n: number; text: string; entryId?: string; queued?: string; refusal?: Refusal & { code?: string } }

export function ProjectThread({ p }: { p: Project }) {
  const { all, loaded, hasEarlier, loadEarlier } = useThread(p.id);
  const asks = useAsk();
  const actions = useProjectActions();
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [moved, setMoved] = useState<{ text: string; turnId: string; back: string; to: string } | null>(null);
  const [sent, setSent] = useState<Sent[]>([]);
  const [text, setText] = useState('');
  const n = useRef(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const runningTurn = all.find((t) => t.kind === 'running');
  const runningNow = !!runningTurn;
  // answers arriving are said aloud to a screen reader (the thread itself is not a live region: it would read it all)
  const [heard, setHeard] = useState('');
  const lastAnswer = [...all].reverse().find((t) => t.kind !== 'running' && t.kind !== 'divider' && t.reply);
  const seenAnswer = useRef<string | null>(null);
  useEffect(() => {
    if (!lastAnswer) return;
    if (seenAnswer.current === null) { seenAnswer.current = lastAnswer.id; return; } // what was there when it opened
    if (seenAnswer.current === lastAnswer.id) return;
    seenAnswer.current = lastAnswer.id;
    setHeard(`Your helper answered: ${answerWords(lastAnswer.reply).slice(0, 200)}`);
  }, [lastAnswer]);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const words = text.trim();
    if (!words) return;
    const id = ++n.current;
    setSent((s) => [...s, { n: id, text: words }]);
    setText('');
    const r = await asks.send({ text: words, projectId: p.id }, words.slice(0, 60));
    setSent((s) => s.map((x) => (x.n !== id ? x : { ...x, entryId: r.entryId, ...(r.queued ? { queued: r.message } : {}), ...(!r.ok && !r.queued ? { refusal: { ...refusalFor(r.code, r.message), code: r.code } } : {}) })));
  };

  // what the composer sent that the thread itself does not show: a plan waiting for a choice, a refusal, a send waiting
  // for the network. An answer, a job and an offer show as turns in the thread.
  const pending = sent.filter((x) => {
    const o = asks.outcome(x.entryId);
    if (x.refusal || (x.queued && !o)) return true;
    return !!o && o.start.kind === 'plan';
  });

  return (
    <section className="projthread" aria-labelledby={`th-${p.id}`}>
      <h2 className="sr-only" id={`th-${p.id}`}>Our conversation</h2>
      <p className="sr-only" role="status" aria-live="polite">{heard}</p>
      {hasEarlier && (
        <button type="button" className="vbtn vbtn-quiet earlier" disabled={loadingEarlier}
          onClick={async () => { setLoadingEarlier(true); await loadEarlier(); setLoadingEarlier(false); }}>
          {loadingEarlier ? 'Loading…' : 'Earlier messages'}
        </button>
      )}
      {!all.length && <p className="empty" style={{ textAlign: 'left' }}>{loaded ? 'Nothing said here yet. Ask me anything about it below.' : 'Loading…'}</p>}
      <div className="thread">
        {all.map((t) => <TurnView key={t.id} t={t} p={p} onMoved={(m) => setMoved(m)} />)}
      </div>
      {moved && (
        <p className="movednote" role="status">{moved.text}
          <button type="button" className="linkish" onClick={async () => { const m = moved; setMoved(null); await actions.moveTurn(m.turnId, m.back); }}>Undo</button>
        </p>
      )}
      {pending.map((x) => {
        const o = asks.outcome(x.entryId);
        return (
          <div key={x.n} className="thread pendingask">
            <div className="msg-you"><span className="sr-only">You: </span>{x.text}</div>
            {x.refusal ? (
              <div className="refusal" role="alert"><p>{x.refusal.text}</p>
                <div className="acts">
                  {x.refusal.code === 'busy' && <button type="button" className="vbtn" onClick={async () => {
                    const r = await actions.steer(p.id, x.text, runningTurn?.runId);
                    setSent((s) => (r.ok ? s.filter((y) => y.n !== x.n) : s.map((y) => (y.n !== x.n ? y : { ...y, refusal: { text: runActionRefusal(r.code, r.message, 'steer'), again: true, code: r.code } }))));
                  }}>Add it to the answer</button>}
                  {x.refusal.again && <button type="button" className="vbtn vbtn-quiet" onClick={() => { setText(x.text); setSent((s) => s.filter((y) => y.n !== x.n)); input.current?.focus(); }}>Ask again</button>}
                </div>
              </div>
            ) : o ? <AskOutcomeView start={o.start} text={o.text} onAgain={(t) => { setText(t); input.current?.focus(); }} inThread />
              : asks.waiting(x.entryId) ? <p className="ask-note" role="status">Waiting to send. {x.queued}</p>
              : <p className="ask-note error" role="alert">That didn’t go through. Ask again.</p>}
          </div>
        );
      })}
      <form className="composer" onSubmit={(e) => void send(e)} autoComplete="off" noValidate>
        <label htmlFor={`cmp-${p.id}`} className="sr-only">Message {p.name}</label>
        <textarea ref={input} id={`cmp-${p.id}`} className="composer-in" rows={1} placeholder={runningNow ? 'Add to the answer, or ask something else…' : `Message ${p.name}…`}
          value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />
        <button type="submit" className="sendbtn" aria-label={`Send to ${p.name}`} disabled={!text.trim()}>
          <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </form>
    </section>
  );
}

function TurnView({ t, p, onMoved }: { t: Turn; p: Project; onMoved: (m: { text: string; turnId: string; back: string; to: string }) => void }) {
  const projects = useProjectMap();
  if (t.kind === 'divider') return <p className="tdivider"><span>{t.message || t.reply || 'An earlier conversation'}</span></p>;
  const notes = turnNotes(t, projects);
  return (
    <div className={`turn turn-${t.kind}`} id={`turn-${t.id}`}>
      {t.message && (
        <div className="msg-you"><span className="sr-only">You: </span>
          {t.about && <AboutChip about={t.about} />}
          {t.message}
          {notes.length > 0 && <span className="routeto">{notes.join(' · ')}</span>}
        </div>
      )}
      {t.kind === 'running' ? <RunningAnswer p={p} t={t} />
        : t.kind === 'offer' ? <OfferTurn p={p} t={t} />
        : t.reply ? (
          <HelperSays tail={<TurnFoot t={t} />} action={<MoveMenu t={t} p={p} onMoved={onMoved} />}>
            <AnswerText text={t.reply} tainted={t.tainted} lead={t.kind === 'result' ? <span className="resultlead">From work I did in the background: </span> : null} />
          </HelperSays>
        ) : <MoveMenu t={t} p={p} onMoved={onMoved} />}
    </div>
  );
}

function AboutChip({ about }: { about: NonNullable<Turn['about']> }) {
  const jobs = useJobMap();
  const cal = useCalendarItem(about.kind === 'event' || about.kind === 'draft' ? about.id : null);
  const label = about.kind === 'job' ? jobs[about.id]?.title : cal?.title;
  return <span className="aboutchip turnabout"><Spark size={14} />About {label ?? ABOUT_NOUN[about.kind] ?? 'something'}</span>;
}

function TurnFoot({ t }: { t: Turn }) {
  const prov = provenanceLine(t);
  return prov ? <p className="cross"><LinkIcon />{prov}</p> : null;
}

/** "Move to another project": a small menu of the other projects; the thread says where it went, with Undo. */
function MoveMenu({ t, p, onMoved }: { t: Turn; p: Project; onMoved: (m: { text: string; turnId: string; back: string; to: string }) => void }) {
  const projects = useProjects();
  const actions = useProjectActions();
  const [open, setOpen] = useState(false);
  const wrap = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  const trigger = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const others = projects.filter((x) => x.id !== p.id);
  if (!others.length) return null;
  const move = async (to: Project) => {
    setOpen(false); setBusy(true); setError(null);
    const r = await actions.moveTurn(t.id, to.id, true);
    setBusy(false);
    if (r.ok) onMoved({ text: `Moved to ${to.name}.`, turnId: t.id, back: p.id, to: to.id });
    else if (r.queued) onMoved({ text: `It moves to ${to.name} when you’re back online.`, turnId: t.id, back: p.id, to: to.id });
    else setError(r.code === 'running' ? 'It can move once its answer is written.' : r.message);
  };
  return (
    <div className="movewrap" ref={wrap}>
      <button ref={trigger} type="button" className="linkish quietlink movebtn" aria-haspopup="menu" aria-expanded={open} disabled={busy} onClick={() => setOpen((o) => !o)}
        aria-label={`Move to another project: ${t.message.slice(0, 60)}`}>Move…</button>
      {open && (
        <div className="menu" role="menu" aria-label="Move to" onKeyDown={menuKeys(trigger, () => setOpen(false))}>
          {others.map((x, i) => <button key={x.id} type="button" role="menuitem" autoFocus={i === 0} onClick={() => void move(x)}>{x.name}</button>)}
        </div>
      )}
      {error && <p className="ask-note error" role="alert">{error}</p>}
    </div>
  );
}

/** The answer being written now: its progress from the stream, Stop, and "Add to it" (steer). */
function RunningAnswer({ p, t }: { p: Project; t: Turn }) {
  const live = useLive(p.id);
  const actions = useProjectActions();
  const stopper = useStopRun(p.id, t.runId);
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState('');
  const [said, setSaid] = useState<string | null>(null);
  const stage = live && live.at >= t.ts - 5_000 ? stageLine(live.stage, live.type) : null;
  return (
    <div className="msg-h liveans" aria-busy="true">
      <Who />
      <Typing />
      {stage && <p className="stage" role="status">{stage}</p>}
      {(stopper.said || said) && <p className="ask-note" role="status">{stopper.said ?? said}</p>}
      {adding ? (
        <form className="steerform" onSubmit={async (e) => {
          e.preventDefault();
          const words = note.trim();
          if (!words) return;
          const r = await actions.steer(p.id, words, t.runId);
          setAdding(false);
          if (r.ok) setNote('');
          setSaid(r.ok ? 'Added. It’s taken into account from the next step.' : runActionRefusal(r.code, r.message, 'steer'));
        }}>
          <label htmlFor={`steer-${t.id}`} className="sr-only">Add to the answer</label>
          <input id={`steer-${t.id}`} className="textin" autoFocus value={note} placeholder="Also check…" onChange={(e) => setNote(e.target.value)} />
          <button type="submit" className="vbtn vbtn-primary">Add</button>
          <button type="button" className="vbtn vbtn-quiet" onClick={() => setAdding(false)}>Cancel</button>
        </form>
      ) : (
        <div className="acts">
          <button type="button" className="vbtn" disabled={stopper.busy} onClick={() => void stopper.stop()}>{stopper.busy ? 'Stopping…' : 'Stop'}</button>
          <button type="button" className="vbtn vbtn-quiet" onClick={() => setAdding(true)}>Add to it</button>
        </div>
      )}
    </div>
  );
}

/** An offer turn: before it is answered, "Work on it in the background"; after, what was chosen. */
function OfferTurn({ p, t }: { p: Project; t: Turn }) {
  const actions = useProjectActions();
  const asks = useAsk();
  const [state, setState] = useState<{ busy?: boolean; said?: string; error?: string }>({});
  const answered = t.offer?.answered;
  return (
    <HelperSays tail={answered ? (
      <p className="jobnote">{answered === 'background' ? 'Working on it in the background. I’ll post the result here.' : 'You chose to do it here.'}</p>
    ) : state.said ? <p className="jobnote" role="status">{state.said}</p> : (
      <>
        {state.error && <p className="ask-note error" role="alert">{state.error}</p>}
        <div className="acts">
          <button type="button" className="vbtn vbtn-primary" disabled={state.busy} onClick={async () => {
            if (state.busy) return;
            setState({ busy: true });
            const r = await actions.acceptOffer(p.id, t.message || undefined);
            setState(r.ok || r.queued ? { said: r.message ?? 'Started in the background.' } : { error: r.message });
          }}>Work on it in the background</button>
          <button type="button" className="vbtn vbtn-quiet" disabled={state.busy} onClick={async () => {
            setState({ busy: true });
            const r = await asks.send({ text: t.message, projectId: p.id, mode: 'now' }, t.message.slice(0, 60));
            setState(r.ok || r.queued ? { said: 'Doing it here now.' } : { error: r.message });
          }}>Do it here now</button>
        </div>
      </>
    )}>
      {t.reply || 'This could take a while. Want me to work on it in the background and tell you when it’s done?'}
    </HelperSays>
  );
}

function LinkIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" /></svg>;
}
