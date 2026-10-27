/**
 * "Ask about this", in place (v2 build, slice W4; W3's features folded in after review): THE component any detail view
 * drops under the thing it shows.
 *
 *   <AskAbout kind="item" id="it_bookfair" label="Book fair · Sat Nov 14" item={item} form="sheet" />
 *
 * Props:
 *   kind      item | mail | event | draft | job | conflict (POST /ask's `about.kind`)
 *   id        that thing's id
 *   label     the chip's words until the server names the thing ("About: <label>"); the server's label wins
 *   item?     an Important item ({qa}): its answers arrive on the item's own stream (`item.qa`), so a change there
 *             reads the asks again
 *   form?     'inline' (default): the chip, questions and box open under the button; 'sheet': they open in a sheet (the
 *             mail reader), which closes once the helper is answering — the answer still shows here, in place
 *   sheetId?  the sheet's id when form is 'sheet' (one per screen place)
 *   open?     start with the questions shown (inline)
 *   onAsked?  (askId) after a question is sent
 *
 * It renders `button "Ask about this"`; then the chip, the server's 2–3 questions (GET /ask/suggestions) and a box
 * (`textbox "Ask about <label>"`, `button "Send"`); and under `heading "You asked"` every question about the thing
 * (GET /ask?about=kind:id, one entry per ask id) with its answer — followed live while it is written, "using what I
 * know from …" when it used another project (earlier answers too), the "Based on outside content — check before
 * acting" label when it read someone else's words, links as hosts. A second tap while one question is on its way does
 * nothing; a question asked offline waits in the outbox.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useAsk, useStore } from '../../store/react';
import type { Schemas, Turn } from '../../api/client';

type Ask = Schemas['Ask'];
import { Spark } from '../../shell/icons';
import { Sheet } from '../../shell/sheets';
import { LiveAnswer, Typing } from './AskOutcome';
import { AnswerText } from './answerText';
import { provenanceLine, refusalFor, type AboutKind } from './logic';
import './ask.css';

export interface AskAboutProps {
  kind: AboutKind; id: string; label: string;
  item?: { qa: { id: string; a: string | null }[] } | null;
  form?: 'inline' | 'sheet'; sheetId?: string;
  open?: boolean; onAsked?: (askId: string) => void;
}

interface Mine { n: number; text: string; entryId?: string; queued?: string; error?: string }
/** How many earlier answers get their provenance looked up (GET /ask/{id} each). */
export const PROVENANCE_LOOKUPS = 10;

export function AskAbout({ kind, id, label, item, form = 'inline', sheetId, open: startOpen = false, onAsked }: AskAboutProps) {
  const store = useStore();
  const asks = useAsk();
  const key = `${kind}:${id}`;
  const [open, setOpen] = useState(startOpen);
  const [questions, setQuestions] = useState<string[]>([]);
  const [earlier, setEarlier] = useState<Ask[]>([]);
  const [serverLabel, setServerLabel] = useState<string | null>(null);
  const [prov, setProv] = useState<Record<string, Pick<Turn, 'provenance' | 'projectId'>>>({});
  const [mine, setMine] = useState<Mine[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const n = useRef(0);
  const looked = useRef(new Set<string>());

  const reload = useCallback(() => {
    store.client.listAsksAbout(key).then((r) => { setEarlier(r.asks); setServerLabel(r.about.label); }, () => { /* offline: what is shown stays */ });
  }, [store, key]);
  // the asks again: on opening, whenever one about this thing is answered (the stream's `ask`), and whenever the item's
  // own answers (`item.qa`) change on the stream
  const answered = Object.values(asks.records).filter((a) => a.about?.kind === kind && a.about?.id === id && a.state === 'answered').length;
  const qaSig = (item?.qa ?? []).map((x) => `${x.id}:${x.a == null ? 0 : 1}`).join('|');
  useEffect(() => { reload(); }, [reload, answered, qaSig]);
  useEffect(() => {
    if (!open) return;
    let on = true;
    store.client.askSuggestions(key).then((r) => { if (on) { setQuestions(r.suggestions); setServerLabel(r.about.label); } }, () => { if (on) setQuestions([]); });
    return () => { on = false; };
  }, [open, key, store]);
  // "using what I know from …" for earlier answers too: their turns carry it
  useEffect(() => {
    const want = earlier.filter((a) => a.answer && a.turnId && !looked.current.has(a.id)).slice(0, Math.max(0, PROVENANCE_LOOKUPS - looked.current.size));
    for (const a of want) {
      looked.current.add(a.id);
      store.client.getAsk(a.id).then((r) => { if (r.turn) setProv((p) => ({ ...p, [a.id]: { provenance: r.turn!.provenance, projectId: r.turn!.projectId } })); }, () => { /* without it */ });
    }
  }, [earlier, store]);

  const chip = serverLabel ?? label;
  const send = async (q: string): Promise<boolean> => {
    const words = q.trim();
    if (!words || sendingRef.current) return false;
    sendingRef.current = true; setSending(true);
    const me = ++n.current;
    setMine((m) => [...m, { n: me, text: words }]);
    setText('');
    try {
      const r = await asks.send({ text: words, about: { kind, id } }, words.slice(0, 60));
      const out = r.entryId ? store.getState().askOutcomes[r.entryId] : undefined;
      if (out) onAsked?.(out.start.askId);
      setMine((m) => m.map((x) => (x.n !== me ? x : { ...x, entryId: r.entryId, ...(r.queued ? { queued: r.message } : {}), ...(!r.ok && !r.queued ? { error: refusalFor(r.code, r.message).text } : {}) })));
      return r.ok || r.queued;
    } finally { sendingRef.current = false; setSending(false); }
  };
  const submit = async (e: FormEvent) => { e.preventDefault(); const ok = await send(text); if (ok && form === 'sheet') setOpen(false); };

  // the questions asked here that the earlier list does not hold yet (one entry per ask id)
  const shownIds = new Set(earlier.map((a) => a.id));
  const fresh = mine.filter((m) => { const o = asks.outcome(m.entryId); return !o || !shownIds.has(o.start.askId); });
  const safe = key.replace(/[^a-z0-9]/gi, '-');

  const box = (
    <div className="askabout-box">
      <span className="aboutchip"><Spark size={14} />About: {chip}</span>
      {questions.length > 0 && (
        <div className="ask-sugg" role="group" aria-label="Suggested questions">
          {questions.map((q) => <button key={q} type="button" className="sugg" disabled={sending} onClick={async () => { const ok = await send(q); if (ok && form === 'sheet') setOpen(false); }}>{q}</button>)}
        </div>
      )}
      <form className="askabout-form" onSubmit={(e) => void submit(e)} autoComplete="off" noValidate>
        <label htmlFor={`aa-${safe}`} className="sr-only">Ask about {chip}</label>
        <input id={`aa-${safe}`} className="ask-input" type="text" placeholder="Ask about this…" value={text} onChange={(e) => setText(e.target.value)} enterKeyHint="send" />
        <button type="submit" className="sendbtn" aria-label="Send" disabled={!text.trim() || sending}>
          <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </form>
    </div>
  );
  const button = <button type="button" className="vbtn vbtn-helper" onClick={() => setOpen(true)}><Spark />Ask about this</button>;

  return (
    <div className="askabout">
      {form === 'sheet' ? (
        <>
          {button}
          <Sheet id={sheetId ?? `about-${safe}`} titleId={`${sheetId ?? `about-${safe}`}-title`} title="Ask about this" open={open} onClose={() => setOpen(false)}>
            <div className="sheet-body">{box}</div>
          </Sheet>
        </>
      ) : open ? box : button}
      {(earlier.length > 0 || fresh.length > 0) && (
        <section className="qa" aria-labelledby={`qa-${safe}`} aria-live="polite">
          <h3 className="qa-h" id={`qa-${safe}`}>You asked</h3>
          {earlier.map((a) => {
            const line = prov[a.id] ? provenanceLine(prov[a.id]) : null;
            return (
              <div key={a.id} className="qa-pair">
                <p className="qa-q"><span className="sr-only">You asked: </span>{a.text}</p>
                {a.answer && a.state !== 'running' ? (
                  <div className={`qa-a${a.tainted ? ' tainted' : ''}`}>
                    <div className="who"><Spark size={14} />Your helper</div>
                    <p><AnswerText text={a.answer} tainted={a.tainted} /></p>
                    {line && <p className="cross">{line}</p>}
                  </div>
                ) : a.state === 'failed' || a.state === 'expired' ? (
                  <p className="ask-note" role="alert">That didn’t get an answer. Ask again.</p>
                ) : <div className="qa-a qa-live"><LiveAnswer projectId={a.projectId} runId={a.runId} turnId={a.turnId} askId={a.id} showStop={false} /></div>}
              </div>
            );
          })}
          {fresh.map((m) => {
            const o = asks.outcome(m.entryId);
            const refused = asks.refused(m.entryId);
            return (
              <div key={`m${m.n}`} className="qa-pair">
                <p className="qa-q"><span className="sr-only">You asked: </span>{m.text}</p>
                {m.error ? <p className="ask-note error" role="alert">{m.error}</p>
                  : m.queued && !o ? (asks.waiting(m.entryId) ? <p className="ask-note" role="status">Waiting to send. {m.queued}</p>
                    : <p className="ask-note error" role="alert">{refused ? refusalFor(refused.code, refused.message).text : 'That didn’t go through. Ask again.'}</p>)
                  : o ? <div className="qa-a qa-live"><LiveAnswer projectId={o.start.projectId} runId={o.start.runId} turnId={o.start.turnId} askId={o.start.askId} showStop={false} /></div>
                  : <Typing />}
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}
