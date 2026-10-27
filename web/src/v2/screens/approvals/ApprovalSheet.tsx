/**
 * The approval sheet (v2 build, slice S4): what your helper asks your OK for, said plainly, and your answer.
 *
 * Opened (./open.ts) from Today's "Needs you" card, a job's Review and the "Needs your OK" group in the working sheet,
 * Important's Review, and a tapped "Something needs your OK" notification (#/approval/<id>). With an id it shows that
 * one; without, the list of everything waiting.
 *
 *   - what will happen (the title, to what, where), what each answer does, the job that asked and why it asks, what
 *     MWA's reviewer thinks, the text it will write and the exact action on demand
 *   - the risks, strongest first: a phishing source as an alert above everything; money, sending as you, deleting, the
 *     network, outside its folder, outside content in red; the rest quieter
 *   - Approve and Not this time, big; a high risk asks "Are you sure?" first (the focus moves to the question); a note
 *     for the helper is optional when saying no
 *   - after the answer: what happened, then Done (back where you were) or the next one waiting
 * A device without the approve scope sees it all and is told it cannot decide here. Decisions are never queued offline.
 * Words: ./words.ts. Server: src/api/routes/approvals.ts.
 */
import { useEffect, useRef, useState } from 'react';
import type { ApprovalView } from '../../api/client';
import { useApprovals, useNow, useStore } from '../../store/react';
import type { ApprovalOutcome } from '../../store/core';
import { Sheet } from '../../shell/sheets';
import { Chev, Back } from '../../shell/icons';
import { WarnIcon } from '../important/icons';
import { reviewerLine, stateLine, sureLine, waitsLine } from './words';
import './approvals.css';

type Phase = 'view' | 'confirm' | 'sending' | 'outcome';
let scopesSeen: string[] | null = null; // who this device is, read once per page

function useCanDecide(): boolean | null {
  const store = useStore();
  const [scopes, setScopes] = useState<string[] | null>(scopesSeen);
  useEffect(() => {
    if (scopesSeen) return;
    let live = true;
    store.client.getMe().then((m) => { scopesSeen = m.scopes; if (live) setScopes(m.scopes); }).catch(() => { /* the server decides anyway */ });
    return () => { live = false; };
  }, [store]);
  return scopes ? scopes.includes('approve') : null;
}

export function ApprovalSheet({ request, onClose }: { request: { id: string | null; at: number } | null; onClose: () => void }) {
  const store = useStore();
  const { all, pending, recent, loaded } = useApprovals();
  const [sel, setSel] = useState<string | null>(null);
  const [fromList, setFromList] = useState(false);
  const [missing, setMissing] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  // each open: the one asked for (read fresh), or the list
  useEffect(() => {
    if (!request) return;
    setSel(request.id); setFromList(false); setMissing(null); setLoadErr(null);
    if (request.id) {
      const id = request.id;
      void store.loadApproval(id).then((r) => { if (!r.approval) { if (r.error) setLoadErr(r.error); else setMissing(id); } });
    } else void store.loadApprovals();
  }, [request, store]);

  const open = !!request;
  const current = sel ? all[sel] ?? null : null;
  return (
    <Sheet id="approval-dlg" titleId="approval-title" title="Needs your OK" open={open} onClose={onClose}>
      <div className="sheet-body ap-body">
        {sel ? (
          current ? <ApprovalDetail key={current.id} a={current} next={pending.find((x) => x.id !== current.id) ?? null}
            back={fromList ? () => setSel(null) : null} onNext={(id) => setSel(id)} onDone={onClose} />
            : missing ? <><p className="ap-gone" role="status">This request is no longer there. It may have been decided somewhere else, or cleared after a day.</p>
              <div className="ap-acts"><button type="button" className="vbtn vbtn-primary" onClick={onClose}>Close</button></div></>
              : loadErr ? <p className="ap-gone" role="alert">{loadErr}</p>
                : <p className="empty" role="status">Getting it…</p>
        ) : (
          <ApprovalList pending={pending} recent={recent} loaded={loaded} pick={(id) => { setSel(id); setFromList(true); }} />
        )}
      </div>
    </Sheet>
  );
}

function ApprovalList({ pending, recent, loaded, pick }: { pending: ApprovalView[]; recent: ApprovalView[]; loaded: boolean; pick: (id: string) => void }) {
  if (!loaded && !pending.length) return <p className="empty" role="status">Getting what is waiting…</p>;
  return (
    <>
      {pending.length ? (
        <section aria-labelledby="ap-wait-h">
          <h3 className="jg-h" id="ap-wait-h">Waiting for your OK · {pending.length}</h3>
          <ul className="ap-list">
            {pending.map((a) => {
              const top = a.risks.find((r) => r.level === 'high');
              return (
                <li key={a.id}>
                  <button type="button" className={`ap-row${a.caution === 'phishing' ? ' phish' : top ? ' high' : ''}`} onClick={() => pick(a.id)}>
                    <span className="grow">
                      <span className="t">{a.title}</span>
                      {a.caution === 'phishing' ? <span className="ap-tag phish"><WarnIcon size={14} />Looks like phishing</span>
                        : top ? <span className="ap-tag high"><WarnIcon size={14} />{top.text.split(/(?<=\.)\s/)[0]}</span> : null}
                      {a.job && <span className="s">For: {a.job.title}</span>}
                    </span>
                    <Chev />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : <p className="empty" role="status">Nothing is waiting for your OK.</p>}
      {recent.length > 0 && (
        <section aria-labelledby="ap-recent-h">
          <h3 className="jg-h" id="ap-recent-h">Decided today</h3>
          <ul className="ap-recent">
            {recent.slice(0, 5).map((a) => <li key={a.id}><span className="t">{a.title}</span> <span className="s">— {stateLine(a)}</span></li>)}
          </ul>
        </section>
      )}
    </>
  );
}

function ApprovalDetail({ a, next, back, onNext, onDone }: {
  a: ApprovalView; next: ApprovalView | null; back: (() => void) | null; onNext: (id: string) => void; onDone: () => void;
}) {
  const store = useStore();
  const now = useNow(15_000);
  const canDecide = useCanDecide();
  const [phase, setPhase] = useState<Phase>('view');
  const [doing, setDoing] = useState<'approve' | 'deny' | null>(null);
  const [out, setOut] = useState<ApprovalOutcome | null>(null);
  const [note, setNote] = useState('');
  const sureRef = useRef<HTMLHeadingElement>(null);
  const outRef = useRef<HTMLParagraphElement>(null);
  // after the tap's own focus handling (the button tapped is gone): a moment later
  useEffect(() => {
    const t = setTimeout(() => { if (phase === 'confirm') sureRef.current?.focus(); if (phase === 'outcome') outRef.current?.focus(); }, 0);
    return () => clearTimeout(t);
  }, [phase]);

  const decide = async (approve: boolean) => {
    setDoing(approve ? 'approve' : 'deny'); setPhase('sending');
    const r = await store.decideApproval(a.id, approve, approve ? undefined : note.trim() || undefined);
    setOut(r); setDoing(null); setPhase('outcome');
  };
  const pendingNow = a.state === 'pending' && phase !== 'outcome';
  const high = a.risks.filter((r) => r.level === 'high' && r.kind !== 'phishing');
  const other = a.risks.filter((r) => r.level !== 'high');
  const phish = a.risks.find((r) => r.kind === 'phishing');
  const rev = reviewerLine(a.reviewer);

  return (
    <article className="ap" aria-labelledby="ap-t" data-approval={a.id} data-state={a.state} data-caution={a.caution ?? undefined}>
      {back && <button type="button" className="backbtn ap-back" onClick={back}><Back />Everything waiting</button>}
      {phish && pendingNow && (
        <div className="ap-phish" role="alert">
          <p className="ap-phish-h"><WarnIcon size={20} />Warning: this may be a phishing trick</p>
          <p>{phish.text}</p>
        </div>
      )}
      <p className="ap-kicker">{a.job ? <>Your helper asks, for the job “{a.job.title}”</> : 'Your helper asks'}{!a.forOwner ? ' · someone else’s conversation' : ''}</p>
      <h3 className="ap-title" id="ap-t">{a.title}</h3>

      {pendingNow && high.length > 0 && (
        <ul className="ap-risks high" aria-label="Be careful">
          {high.map((r) => <li key={r.kind}><WarnIcon size={16} /><span>{r.text}</span></li>)}
        </ul>
      )}
      <dl className="ap-rows">
        {a.rows.map((r) => <div key={r.label}><dt>{r.label}</dt><dd>{r.value}</dd></div>)}
        {pendingNow && <><div><dt>If you approve</dt><dd>{a.ifApprove}</dd></div><div><dt>If you say no</dt><dd>{a.ifDecline}</dd></div></>}
      </dl>
      {pendingNow && other.length > 0 && (
        <ul className="ap-risks" aria-label="Good to know">
          {other.map((r) => <li key={r.kind} className={r.level}><span>{r.text}</span></li>)}
        </ul>
      )}
      {a.why && <p className="ap-why">{a.why}</p>}
      {rev && <p className="ap-why">{rev}</p>}
      {a.content && <details className="ap-more"><summary>What it will write</summary><pre>{a.content}</pre></details>}
      {a.exact && <details className="ap-more"><summary>The exact action</summary><pre>{a.exact}</pre></details>}

      {pendingNow && phase === 'view' && <p className="ap-exp">{waitsLine(a, now)}</p>}

      {pendingNow && canDecide === false && (
        <p className="ap-cant" role="note">This device can look but not decide. Approve it on your computer, or sign in there with the password.</p>
      )}
      {pendingNow && canDecide !== false && phase === 'view' && (
        <>
          <details className="ap-note">
            <summary>Add a note for your helper (if you say no)</summary>
            <label htmlFor={`ap-note-${a.id}`} className="ap-note-l">Why not? It reads this on its next run.</label>
            <textarea id={`ap-note-${a.id}`} maxLength={500} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </details>
          <div className="ap-acts">
            <button type="button" className="vbtn vbtn-primary ap-big" onClick={() => (a.confirm ? setPhase('confirm') : void decide(true))}>Approve</button>
            <button type="button" className="vbtn ap-big" onClick={() => void decide(false)}>Not this time</button>
          </div>
        </>
      )}
      {pendingNow && phase === 'confirm' && (
        <div className="ap-confirm" role="group" aria-labelledby="ap-sure">
          <h4 id="ap-sure" ref={sureRef} tabIndex={-1}>Are you sure?</h4>
          <p>{sureLine(a)}</p>
          <div className="ap-acts">
            <button type="button" className="vbtn ap-big ap-danger" onClick={() => void decide(true)}>Yes, approve it</button>
            <button type="button" className="vbtn ap-big" onClick={() => setPhase('view')}>Go back</button>
          </div>
        </div>
      )}
      {phase === 'sending' && (
        <div className="ap-acts" aria-live="polite">
          <button type="button" className="vbtn vbtn-primary ap-big" disabled>{doing === 'approve' ? 'Approving…' : 'Saying no…'}</button>
        </div>
      )}

      {(phase === 'outcome' || a.state !== 'pending') && (
        <div className={`ap-outcome ${out ? (out.ok ? (out.outcome === 'declined' ? 'no' : out.outcome === 'failed' ? 'err' : 'ok') : 'err') : a.state === 'done' || a.state === 'approved' ? 'ok' : a.state === 'failed' ? 'err' : 'no'}`}>
          <p ref={outRef} tabIndex={-1} role="status" className="ap-out-h">{out ? out.message : stateLine(a)}</p>
          {(out?.approval ?? a).result && <p className="ap-result">{(out?.approval ?? a).result}</p>}
          {out && !out.ok && out.approval && out.approval.state !== 'pending' && <p className="ap-result">{stateLine(out.approval)}</p>}
          <div className="ap-acts">
            {out && !out.ok && out.code === 'network' ? <button type="button" className="vbtn vbtn-primary" onClick={() => { setOut(null); setPhase('view'); }}>Try again</button>
              : next ? <button type="button" className="vbtn vbtn-primary" onClick={() => { setOut(null); setPhase('view'); onNext(next.id); }}>Next: {next.title}</button> : null}
            <button type="button" className={`vbtn${next || (out && !out.ok && out.code === 'network') ? '' : ' vbtn-primary'}`} onClick={onDone}>Done</button>
          </div>
        </div>
      )}
    </article>
  );
}
