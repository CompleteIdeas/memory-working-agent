/**
 * What an ask became (v2 build, slice W4), shown the same way in the Ask sheet, a project's composer and "Ask about
 * this": an answer followed live into the project's thread, a big ask's plan card (N04), a job handed to the
 * background ("I'll let you know · ready around 10:10 AM"), or the offer to work on it in the background.
 *
 *   <AskOutcomeView start={AskStart} text="what was asked" onShowWork={…} onAgain={…} />
 *
 * Following an answer: the server answers POST /ask once the run has started, with the run's id and its `running`
 * turn; progress comes as the stream's `live` events (session p-<project>), and the answer is a NEW turn with the same
 * runId (the running turn retires). The stream brings both; GET /ask/{id} is asked as well while it runs (every 6 s,
 * only while the page is visible, at most 40 times, never again once it is answered, failed or expired), and once at
 * the end when the stream's 500-character summary cut the answer short.
 *
 * Answers are plain text with links as hosts; one that read outside content says so (./answerText.tsx).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAsk, useLive, useMeta, useNow, useProjectActions, useProjects, useStore, useThread } from '../../store/react';
import type { AskStart, AskChosen, Turn } from '../../api/client';
import { Spark } from '../../shell/icons';
import { AnswerText } from './answerText';
import {
  capFor, capText, capWarning, jobNote, optionLabel, parseCap, provenanceLine, refusalFor, runActionRefusal, sizeText, stageLine,
  type AskPlan, type Refusal,
} from './logic';

/** A helper's message: "✦ Your helper" (and the simulated tag in fixture mode), the words, then `tail`. `action` sits
 *  at the end of the "Your helper" line (a thread's Move…). */
export function HelperSays({ children, tail, action }: { children: ReactNode; tail?: ReactNode; action?: ReactNode }) {
  return (
    <div className="msg-h">
      <Who action={action} />
      <div className="txt">{children}</div>
      {tail}
    </div>
  );
}

/** "✦ Your helper", with the dashed simulated tag in fixture mode (every helper message carries it, as approved). */
export function Who({ action }: { action?: ReactNode }) {
  const { fixtures } = useMeta();
  return <div className="who"><Spark size={16} />Your helper{fixtures ? <span className="simmini">simulated</span> : null}{action}</div>;
}

export function Typing({ label = 'Your helper is answering' }: { label?: string }) {
  return <span className="typing" role="img" aria-label={label}><i aria-hidden="true" /><i aria-hidden="true" /><i aria-hidden="true" /></span>;
}

/** Find an answer in a project's thread: the finished turn of a run, or the run's `running` turn while it writes. */
export function findAnswer(turns: Turn[], o: { runId?: string | null; turnId?: string | null; finalTurnId?: string | null }) {
  const done = turns.find((t) => t.kind !== 'running' && ((o.runId && t.runId === o.runId) || (o.finalTurnId && t.id === o.finalTurnId)))
    ?? (o.turnId ? turns.find((t) => t.id === o.turnId && t.kind !== 'running') : undefined);
  const running = done ? undefined : turns.find((t) => t.kind === 'running' && ((o.turnId && t.id === o.turnId) || (o.runId && t.runId === o.runId)));
  return { done, running };
}

export const POLL_EVERY_MS = 6_000;
export const POLL_MAX = 40;
const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

/** Stop for the run the person sees: never queued, refused in place offline, "It had already finished" if it had. */
export function useStopRun(projectId: string, runId: string | null | undefined) {
  const actions = useProjectActions();
  const [state, setState] = useState<{ busy: boolean; said: string | null }>({ busy: false, said: null });
  const stop = async () => {
    if (state.busy) return;
    setState({ busy: true, said: null });
    const r = await actions.stop(projectId, runId);
    setState({ busy: false, said: r.ok ? 'Stopping after this step.' : runActionRefusal(r.code, r.message, 'stop') });
  };
  return { ...state, stop };
}

/** An answer being written, followed live until it is there. */
export function LiveAnswer({ projectId, runId, turnId, askId, showStop = true }: { projectId: string; runId?: string | null; turnId?: string | null; askId?: string | null; showStop?: boolean }) {
  const { all } = useThread(projectId);
  const store = useStore();
  const asks = useAsk();
  const live = useLive(projectId);
  const record = asks.ask(askId);
  const { done, running } = useMemo(() => findAnswer(all, { runId, turnId, finalTurnId: record?.turnId }), [all, runId, turnId, record?.turnId]);
  const stopper = useStopRun(projectId, running?.runId ?? runId);
  const failed = (record?.state === 'failed' || record?.state === 'expired') && !done;
  // ask the server too while it runs (a stream can be slow to say), and once more for an answer cut to 500 characters
  const doneId = done?.id, cut = !!done?.truncated;
  const settled = !!doneId || failed || record?.state === 'answered';
  const tries = useRef(0);
  useEffect(() => {
    if (!askId) return;
    if (doneId) { if (cut) void store.loadAsk(askId); return; }
    if (settled) return;
    const tick = () => { if (tries.current < POLL_MAX && visible()) { tries.current++; void store.loadAsk(askId); } };
    const t = setInterval(tick, POLL_EVERY_MS);
    const first = setTimeout(tick, 1_500);
    return () => { clearInterval(t); clearTimeout(first); };
  }, [askId, doneId, cut, settled, store]);
  if (done) {
    const prov = provenanceLine(done);
    return (
      <HelperSays tail={prov ? <p className="cross">{prov}</p> : null}>
        <AnswerText text={done.reply || done.message} tainted={done.tainted} />
      </HelperSays>
    );
  }
  if (failed) return <p className="ask-note error" role="alert">{record?.state === 'expired' ? 'That didn’t get an answer. Ask again.' : <AnswerText text={record?.answer || 'That stopped before it finished. Try asking again.'} tainted={record?.tainted} />}</p>;
  // the stream's last word on this project's run, if it is about this run (not one before it)
  const stage = live && running && live.at >= running.ts - 5_000 ? stageLine(live.stage, live.type) : null;
  return (
    <div className="msg-h liveans" aria-busy="true">
      <Who />
      <Typing />
      {stage && <p className="stage" role="status">{stage}</p>}
      {stopper.said && <p className="ask-note" role="status">{stopper.said}</p>}
      {showStop && running && (
        <div className="acts">
          <button type="button" className="vbtn vbtn-quiet" disabled={stopper.busy} onClick={() => void stopper.stop()}>{stopper.busy ? 'Stopping…' : 'Stop'}</button>
        </div>
      )}
    </div>
  );
}

/** "I'll let you know · ready around 10:10 AM", and the way to the working sheet. */
export function JobNote({ r, onShowWork }: { r: Pick<AskStart | AskChosen, 'readyAt' | 'message' | 'capUsd'>; onShowWork?: () => void }) {
  const now = useNow();
  return (
    <HelperSays tail={(
      <>
        <p className="jobnote" role="status">{jobNote(r, now)}{r.capUsd ? ` · stops at $${r.capUsd.toFixed(2)}` : ''}</p>
        {onShowWork && <div className="acts"><button type="button" className="vbtn vbtn-quiet" onClick={onShowWork}>See what I’m working on</button></div>}
      </>
    )}>
      {r.message || 'Got it. I’ll work on this in the background.'}
    </HelperSays>
  );
}

/** The older offer: "Work on it in the background?" — Accept, or do it here now. */
export function OfferCard({ projectId, message, text, onShowWork }: { projectId: string; message: string; text: string; onShowWork?: () => void }) {
  const actions = useProjectActions();
  const asks = useAsk();
  const [state, setState] = useState<{ busy?: boolean; accepted?: string; here?: string | null; error?: string }>({});
  const here = asks.outcome(state.here ?? undefined);
  if (here) return <AskOutcomeView start={here.start} text={text} onShowWork={onShowWork} />;
  return (
    <HelperSays tail={state.accepted ? (
      <>
        <p className="jobnote" role="status">{state.accepted}</p>
        {onShowWork && <div className="acts"><button type="button" className="vbtn vbtn-quiet" onClick={onShowWork}>See what I’m working on</button></div>}
      </>
    ) : (
      <>
        {state.error && <p className="ask-note error">{state.error}</p>}
        <div className="acts">
          <button type="button" className="vbtn vbtn-primary" disabled={state.busy} onClick={async () => {
            if (state.busy) return;
            setState({ busy: true });
            const r = await actions.acceptOffer(projectId, text);
            setState(r.ok ? { accepted: r.message ?? 'Started in the background. I’ll post the result here.' } : r.queued ? { accepted: r.message } : { error: r.message });
          }}>Work on it in the background</button>
          <button type="button" className="vbtn vbtn-quiet" disabled={state.busy} onClick={async () => {
            if (state.busy) return;
            setState({ busy: true });
            const r = await asks.send({ text, projectId, mode: 'now' }, text.slice(0, 60));
            setState(r.ok || r.queued ? { here: r.entryId ?? null } : { error: r.message });
          }}>Do it here now</button>
        </div>
      </>
    )}>
      {message}
    </HelperSays>
  );
}

type PlanMode = null | 'narrow' | 'details';
type Shown = Refusal & { code?: string; detail?: string };

/**
 * A big ask's plan (N04): its two choices with their prices and times, each with its own spending limit (the server's
 * capDefault for that option, sent explicitly with the choice: "stops at $0.50"), "Or narrow it…", and Details where
 * each limit can be changed (at most $20; a limit below the option's estimate is warned about).
 * `autoFocus`: focus moves to the plan's message when it appears (the Ask sheet). `onDismiss`: "Not now".
 */
export function PlanCard({ askId, plan, projectId, text, onShowWork, onAgain, inThread, autoFocus, onDismiss }: {
  askId: string; plan: AskPlan; projectId: string; text: string; onShowWork?: () => void; onAgain?: (text: string) => void; inThread?: boolean;
  autoFocus?: boolean; onDismiss?: () => void;
}) {
  const asks = useAsk();
  const actions = useProjectActions();
  const projects = useProjects();
  const now = useNow();
  const chosen = asks.choice(askId);
  const record = asks.ask(askId);
  const [mode, setMode] = useState<PlanMode>(null);
  const [caps, setCaps] = useState({ now: capText(plan.now.capDefault), background: capText(plan.background.capDefault ?? plan.capDefault) });
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Shown | null>(null);
  const [queued, setQueued] = useState<{ entryId?: string; message: string } | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const msgRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (autoFocus) msgRef.current?.focus({ preventScroll: false }); }, [autoFocus]);
  const expired = record?.state === 'expired' && !chosen;
  // a choice sent from the outbox and refused there: say why, here, with Ask again
  const refusedLater = queued ? asks.refused(queued.entryId) : asks.refusedChoice(askId);
  useEffect(() => {
    if (!refusedLater || chosen) return;
    setQueued(null); setPicked(null);
    setRefusal(shownFor(refusedLater.code, refusedLater.message));
  }, [refusedLater, chosen]);

  const capOf = (m: 'now' | 'background') => capFor(caps[m]);
  const choose = async (body: { mode?: 'now' | 'background'; narrowIndex?: number }, label: string) => {
    if (busy) return;
    const m = body.mode ?? 'now';
    const capUsd = capOf(m);
    if (capUsd === null) { setMode('details'); return; }
    setBusy(true); setRefusal(null); setPicked(label);
    const r = await asks.choose(askId, { ...body, capUsd });
    setBusy(false);
    if (r.ok) return;
    if (r.queued) { setQueued({ entryId: r.entryId, message: r.message }); return; }
    setPicked(null);
    setRefusal(shownFor(r.code, r.message));
    if (r.code === 'already_chosen') void asks.load(askId);
  };

  const message = <div ref={msgRef} tabIndex={-1} className="planmsg"><HelperSays>{plan.message}</HelperSays></div>;
  if (chosen) {
    const narrowLabel = chosen.chosen === 'narrow' ? picked ?? 'A narrower ask' : null;
    return (
      <div className="plancard" role="group" aria-label="Plan">
        {message}
        <p className="youchose">You chose: {narrowLabel ?? (chosen.chosen === 'now' ? optionLabel(plan.now, now) : optionLabel(plan.background, now))}</p>
        <ChosenView chosen={chosen} projectId={projectId} text={text} onShowWork={onShowWork} onAgain={onAgain} inThread={inThread} />
      </div>
    );
  }
  const project = projects.find((p) => p.id === projectId);
  const shownRefusal: Shown | null = refusal ?? (expired ? { ...refusalFor('expired', ''), code: 'expired' } : null);
  const size = sizeText(plan);
  const limitLine = (m: 'now' | 'background') => { const c = capOf(m); return c === null ? null : `stops at $${capText(c)}`; };
  const limitField = (m: 'now' | 'background', name: string, estimate: number) => {
    const raw = caps[m], check = parseCap(raw), warn = capWarning(check.ok ? check.usd : null, estimate);
    const id = `limit-${m}-${askId}`;
    return (
      <div className="limitfield">
        <p className="limitrow">
          <label htmlFor={id}>{name}: stop if it costs more than $</label>
          <input id={id} className="limitin" type="number" inputMode="decimal" min={0.01} max={20} step={0.05} value={raw}
            aria-invalid={!check.ok} aria-describedby={!check.ok || warn ? `${id}-note` : undefined}
            onChange={(e) => setCaps((c) => ({ ...c, [m]: e.target.value }))} />
        </p>
        {!check.ok ? <p className="ask-note error" id={`${id}-note`}>{check.message}</p>
          : warn ? <p className="ask-note warn" id={`${id}-note`}>{warn}</p> : null}
      </div>
    );
  };
  return (
    <div className="plancard" role="group" aria-label="Plan">
      {message}
      {shownRefusal ? (
        <div className="refusal" role="alert">
          <p>{shownRefusal.text}</p>
          {shownRefusal.detail && <p className="soft">{shownRefusal.detail}</p>}
          <div className="acts">
            {shownRefusal.restore && project?.archived && <button type="button" className="vbtn" onClick={async () => { const r = await actions.restore(project); if (r.ok) setRefusal(null); }}>Restore {project.name}</button>}
            {shownRefusal.again && onAgain && <button type="button" className="vbtn vbtn-primary" onClick={() => onAgain(text)}>Ask again</button>}
          </div>
          {shownRefusal.code === 'already_chosen' && record && (record.jobId || record.turnId) && (
            record.jobId ? <JobNote r={{ readyAt: undefined, message: 'It’s working in the background.', capUsd: record.capUsd ?? undefined }} onShowWork={onShowWork} />
              : <LiveAnswer projectId={projectId} runId={record.runId} turnId={record.turnId} askId={askId} />
          )}
        </div>
      ) : queued ? (
        <p className="ask-note" role="status">{queued.message}{picked ? ` (${picked})` : ''}</p>
      ) : mode === 'narrow' ? (
        <>
          <p className="soft narrowlead">Smaller asks, built from yours:</p>
          <div className="acts acts-col">
            {plan.narrow.map((n, i) => (
              <button key={i} type="button" className="vbtn" disabled={busy} onClick={() => void choose({ narrowIndex: i }, n.label)}>{n.label}</button>
            ))}
          </div>
          <button type="button" className="linkish quietlink" onClick={() => setMode(null)}>Back to the full read</button>
        </>
      ) : (
        <>
          <div className="acts">
            <button type="button" className="vbtn" disabled={busy} onClick={() => void choose({ mode: 'now' }, optionLabel(plan.now, now))}>{optionLabel(plan.now, now)}</button>
            <button type="button" className="vbtn vbtn-primary" disabled={busy} onClick={() => void choose({ mode: 'background' }, optionLabel(plan.background, now))}>{optionLabel(plan.background, now)}</button>
          </div>
          <p className="caplines soft">Do it now {limitLine('now') ?? '· set a limit in Details'} · In the background {limitLine('background') ?? '· set a limit in Details'}</p>
          {mode === 'details' ? (
            <div className="plandetails">
              {size && <p className="soft">Size: {size}{plan.basis === 'default' ? ' · prices are a first guess' : ''}</p>}
              {plan.now.note && <p className="soft">{plan.now.note}</p>}
              {plan.background.note && <p className="soft">{plan.background.note}</p>}
              {limitField('now', 'Do it now', plan.now.usd)}
              {limitField('background', 'In the background', plan.background.usd)}
              <button type="button" className="linkish quietlink" onClick={() => setMode(null)}>Hide details</button>
            </div>
          ) : (
            <p className="planlinks">
              {plan.narrow.length > 0 && <button type="button" className="linkish quietlink" onClick={() => setMode('narrow')}>Or narrow it…</button>}
              <button type="button" className="linkish quietlink" onClick={() => setMode('details')}>Details</button>
              {onDismiss && <button type="button" className="linkish quietlink" onClick={onDismiss}>Not now</button>}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** A refusal for the card: the plain words, and the server's own message when it says more. */
function shownFor(code: string | undefined, message: string): Shown {
  const r = refusalFor(code, message);
  return { ...r, code, ...(message && message !== r.text && code !== 'expired' ? { detail: message } : {}) };
}

function ChosenView({ chosen, projectId, text, onShowWork, onAgain, inThread }: { chosen: AskChosen; projectId: string; text: string; onShowWork?: () => void; onAgain?: (text: string) => void; inThread?: boolean }) {
  const now = useNow();
  if (chosen.narrowed) return <AskOutcomeView start={chosen.narrowed} text={text} onShowWork={onShowWork} onAgain={onAgain} inThread={inThread} />;
  // inside the project's own thread the answer, the job's line and the offer are turns of the thread already
  if (inThread) return chosen.kind === 'job' ? <p className="jobnote" role="status">{jobNote(chosen, now)}</p> : null;
  if (chosen.kind === 'job') return <JobNote r={chosen} onShowWork={onShowWork} />;
  if (chosen.state === 'offer') return <OfferCard projectId={projectId} message={chosen.message ?? ''} text={text} onShowWork={onShowWork} />;
  return <LiveAnswer projectId={projectId} runId={chosen.runId} turnId={chosen.turnId} askId={chosen.askId} />;
}

/**
 * Any AskStart, as the person should see it. `inThread`: shown inside the project's own thread, where the answer, a
 * job's line and an offer arrive as turns — only a plan (and what was chosen) shows here then.
 */
export function AskOutcomeView({ start, text, onShowWork, onAgain, inThread, autoFocus, onDismiss }: {
  start: AskStart; text: string; onShowWork?: () => void; onAgain?: (text: string) => void; inThread?: boolean; autoFocus?: boolean; onDismiss?: () => void;
}) {
  if (start.kind === 'plan' && start.plan) return <PlanCard askId={start.askId} plan={start.plan} projectId={start.projectId} text={text} onShowWork={onShowWork} onAgain={onAgain} inThread={inThread} autoFocus={autoFocus} onDismiss={onDismiss} />;
  if (inThread) return null;
  if (start.kind === 'job') return <JobNote r={start} onShowWork={onShowWork} />;
  if (start.state === 'offer') return <OfferCard projectId={start.projectId} message={start.message ?? ''} text={text} onShowWork={onShowWork} />;
  return <LiveAnswer projectId={start.projectId} runId={start.runId} turnId={start.turnId} askId={start.askId} />;
}
