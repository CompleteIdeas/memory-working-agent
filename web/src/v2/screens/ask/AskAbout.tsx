/**
 * "Ask about this", in place (v2 build, slice W4): a reusable piece any detail view drops under the thing it shows.
 *
 *   <AskAbout kind="item" id="i-bookfair" label="Book fair · Sat Nov 14" />
 *
 * Props: `kind` (item | mail | event | draft | job | conflict, as POST /ask's `about`), `id` (that thing's id), `label`
 * (the chip's words: "About: <label>"). Optional `open` starts it expanded; `onAsked(askId)` is called after a question
 * is sent.
 *
 * It renders:
 *   - `button "Ask about this"`; pressed, the chip "About: <label>", the server's 2–3 questions for the thing
 *     (GET /ask/suggestions, templates, no model call) as buttons, and a box for a question of one's own
 *     (`textbox "Ask about <label>"`, `button "Send"`);
 *   - under `heading "You asked"`, the earlier questions and their answers (GET /ask?about=kind:id), and a new
 *     question's answer followed live (`.qa`), with "using what I know from …" when it used another project.
 * The answer is also kept in the thing's project thread (the server does that). A question asked offline waits in the
 * outbox and is sent when back online.
 *
 * W3 has its own for now; the two are unified later (keep this API: kind, id, label).
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useAsk, useStore } from '../../store/react';
import type { AsksAbout } from '../../api/client';
import { Spark } from '../../shell/icons';
import { LiveAnswer, Typing } from './AskOutcome';
import { refusalFor, type AboutKind } from './logic';
import './ask.css';

export interface AskAboutProps { kind: AboutKind; id: string; label: string; open?: boolean; onAsked?: (askId: string) => void }

interface Mine { n: number; text: string; entryId?: string; queued?: string; error?: string }

export function AskAbout({ kind, id, label, open: startOpen = false, onAsked }: AskAboutProps) {
  const store = useStore();
  const asks = useAsk();
  const key = `${kind}:${id}`;
  const [open, setOpen] = useState(startOpen);
  const [questions, setQuestions] = useState<string[]>([]);
  const [earlier, setEarlier] = useState<AsksAbout['asks']>([]);
  const [mine, setMine] = useState<Mine[]>([]);
  const [text, setText] = useState('');
  const [n, setN] = useState(0);

  const reload = useCallback(() => {
    store.client.listAsksAbout(key).then((r) => setEarlier(r.asks), () => { /* offline: what is shown stays */ });
  }, [store, key]);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    if (!open) return;
    let on = true;
    store.client.askSuggestions(key).then((r) => { if (on) setQuestions(r.suggestions); }, () => { if (on) setQuestions([]); });
    return () => { on = false; };
  }, [open, key, store]);

  // an ask about this thing changed on the server (answered): read the list again
  const changed = Object.values(asks.records).filter((a) => a.about?.kind === kind && a.about?.id === id && a.state === 'answered').length;
  useEffect(() => { if (changed) reload(); }, [changed, reload]);

  const send = async (q: string) => {
    const words = q.trim();
    if (!words) return;
    const me = n + 1;
    setN(me);
    setMine((m) => [...m, { n: me, text: words }]);
    setText('');
    const r = await asks.send({ text: words, about: { kind, id } }, words.slice(0, 60));
    const out = r.entryId ? store.getState().askOutcomes[r.entryId] : undefined;
    if (out) onAsked?.(out.start.askId);
    setMine((m) => m.map((x) => (x.n !== me ? x : { ...x, entryId: r.entryId, ...(r.queued ? { queued: r.message } : {}), ...(!r.ok && !r.queued ? { error: refusalFor(r.code, r.message).text } : {}) })));
  };
  const submit = (e: FormEvent) => { e.preventDefault(); void send(text); };

  // the questions just asked here that the earlier list does not hold yet
  const shownIds = new Set(earlier.map((a) => a.id));
  const fresh = mine.filter((m) => { const o = asks.outcome(m.entryId); return !o || !shownIds.has(o.start.askId); });
  const safe = key.replace(/[^a-z0-9]/gi, '-');

  return (
    <div className="askabout">
      {!open ? (
        <button type="button" className="vbtn vbtn-helper" onClick={() => setOpen(true)}><Spark />Ask about this</button>
      ) : (
        <div className="askabout-box">
          <span className="aboutchip"><Spark size={14} />About: {label}</span>
          {questions.length > 0 && (
            <div className="ask-sugg">
              {questions.map((q) => <button key={q} type="button" className="sugg" onClick={() => void send(q)}>{q}</button>)}
            </div>
          )}
          <form className="askabout-form" onSubmit={submit} autoComplete="off" noValidate>
            <label htmlFor={`aa-${safe}`} className="sr-only">Ask about {label}</label>
            <input id={`aa-${safe}`} className="ask-input" type="text" placeholder="Ask about this…" value={text} onChange={(e) => setText(e.target.value)} enterKeyHint="send" />
            <button type="submit" className="sendbtn" aria-label="Send" disabled={!text.trim()}>
              <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          </form>
        </div>
      )}
      {(earlier.length > 0 || fresh.length > 0) && (
        <section className="qa" aria-labelledby={`qa-${safe}`}>
          <h3 className="qa-h" id={`qa-${safe}`}>You asked</h3>
          {earlier.map((a) => (
            <div key={a.id}>
              <p className="qa-q">{a.text}</p>
              {a.answer ? (
                <div className="qa-a"><div className="who"><Spark size={14} />Your helper</div><p>{a.answer}</p></div>
              ) : a.state === 'failed' || a.state === 'expired' ? (
                <p className="ask-note">That didn’t get an answer. Ask again.</p>
              ) : <LiveAnswer projectId={a.projectId} runId={a.runId} turnId={a.turnId} askId={a.id} showStop={false} />}
            </div>
          ))}
          {fresh.map((m) => {
            const o = asks.outcome(m.entryId);
            return (
              <div key={`m${m.n}`}>
                <p className="qa-q">{m.text}</p>
                {m.error ? <p className="ask-note error" role="alert">{m.error}</p>
                  : m.queued ? (asks.waiting(m.entryId) ? <p className="ask-note" role="status">Waiting to send. {m.queued}</p> : <p className="ask-note error" role="alert">That didn’t go through. Ask again.</p>)
                  : o ? <AboutAnswer projectId={o.start.projectId} runId={o.start.runId} turnId={o.start.turnId} askId={o.start.askId} />
                  : <Typing />}
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}

/** An answer about one thing, as the `.qa` block shows it (the provenance line under it). */
function AboutAnswer(p: { projectId: string; runId?: string; turnId?: string; askId: string }) {
  return <div className="qa-a qa-live"><LiveAnswer projectId={p.projectId} runId={p.runId} turnId={p.turnId} askId={p.askId} showStop={false} /></div>;
}
