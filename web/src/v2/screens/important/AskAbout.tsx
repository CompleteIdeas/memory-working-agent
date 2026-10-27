/**
 * "Ask about this" (v2 build, slice W3) for an Important item or an email: the Ask sheet already tied to the thing (a
 * chip "About: Book fair · Sat Nov 14" and 2–3 questions from GET /ask/suggestions), and the answers shown IN PLACE,
 * under the thing, under "You asked" — not in a separate thread (SCENARIOS N11).
 *
 *   ask({text, about: {kind, id}})  → 202 answer; the run is answering in the thing's project
 *   GET /ask?about=<kind>:<id>      → what was asked before, by id (for an item, again whenever the stream changes its
 *                                     `qa`, which is how its answers arrive)
 *   GET /ask/{id}                   → each ask made here, followed until answered (it also names the other project
 *                                     whose knowledge the answer used: "using what I know from Eventing")
 * Asks are matched by their id, never by their words (review of W3). An answer that read someone else's words
 * (`tainted`) says so — "Based on what the email says — check before acting" — and any link in it shows as its host.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { newKey, type Ask, type ImportantItem } from '../../api/client';
import { useMeta, useStore } from '../../store/react';
import { Sheet } from '../../shell/sheets';
import { Spark } from '../../shell/icons';
import { LinkIcon, WarnIcon } from './icons';
import { shortLabel } from '../../store/important';
import { linksToHosts } from '../../store/text';

export type AboutKind = 'item' | 'mail' | 'conflict';
export interface AboutRef { kind: AboutKind; id: string; label?: string }

export interface PendingAsk { askId: string; q: string; ts: number; a: string | null; state: 'waiting' | 'answered' | 'failed'; cross: string[]; tainted: boolean }
export interface QaView { key: string; q: string; a: string | null; state: 'waiting' | 'answered' | 'failed'; cross: string[]; tainted: boolean }
export interface AskResult { ok: boolean; message?: string; closed?: boolean }
export const TAINTED_NOTE = 'Based on what the email says — check before acting';

const POLL_MS = 1_500, POLL_MAX = 120;
const stateOf = (a: Pick<Ask, 'state' | 'answer'>): QaView['state'] => (a.answer != null && a.state !== 'running' ? 'answered' : a.state === 'failed' || a.state === 'expired' ? 'failed' : 'waiting');

/** The asks about one thing, and how to ask another. `item` (when the thing is an item) tells when its answers move. */
export function useAskAbout(about: AboutRef | null, item?: ImportantItem | null) {
  const store = useStore();
  const client = store.client;
  const key = about ? `${about.kind}:${about.id}` : null;
  const [history, setHistory] = useState<Ask[]>([]);
  const [pending, setPending] = useState<PendingAsk[]>([]);
  const [label, setLabel] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setHistory([]); setPending([]); setLabel(null); setSuggestions([]); }, [key]);

  // what was asked before; for an item, again each time the stream changes its answers
  const qaSig = (item?.qa ?? []).map((x) => `${x.id}:${x.a == null ? 0 : 1}`).join('|');
  useEffect(() => {
    if (!key) return;
    let on = true;
    client.listAsksAbout(key).then((r) => { if (on) { setHistory(r.asks); setLabel(r.about.label); } }, () => { /* offline: what is held stays */ });
    return () => { on = false; };
  }, [client, key, qaSig]);

  const loadSuggestions = useCallback(async () => {
    if (!key) return;
    try {
      const r = await client.askSuggestions(key);
      if (!alive.current) return;
      setSuggestions(r.suggestions); setLabel(r.about.label);
    } catch { if (alive.current) setSuggestions([]); }
  }, [client, key]);

  // follow each ask made here until it is answered (or fails), whatever the stream does meanwhile
  const follow = useCallback((askId: string) => {
    let n = 0;
    const tick = async () => {
      if (!alive.current) return;
      n++;
      try {
        const r = await client.getAsk(askId);
        const st = stateOf(r.ask);
        if (st !== 'waiting') {
          setPending((ps) => ps.map((p) => (p.askId !== askId ? p : {
            ...p, a: r.ask.answer ?? null, state: st, tainted: !!r.ask.tainted, cross: (r.turn?.provenance ?? []).map((x) => x.name),
          })));
          return;
        }
      } catch { /* offline for a moment: try again */ }
      if (n < POLL_MAX && alive.current) setTimeout(() => { void tick(); }, POLL_MS);
    };
    setTimeout(() => { void tick(); }, POLL_MS / 2);
  }, [client]);

  const send = useCallback(async (text: string): Promise<AskResult> => {
    if (!about) return { ok: false };
    const words = text.trim();
    if (!words) return { ok: false, message: 'Write a question first.' };
    try {
      const r = await client.ask({ text: words, about: { kind: about.kind, id: about.id } }, { key: newKey(store.now()) });
      if (r.kind === 'answer') {
        setPending((ps) => [...ps, { askId: r.askId, q: words, ts: store.now(), a: null, state: 'waiting', cross: [], tainted: !!r.tainted }]);
        follow(r.askId);
        return { ok: true, closed: true };
      }
      // a plan or a background job: rare for a question about one thing; say what happened, in the sheet
      return { ok: true, message: r.message ?? r.plan?.message ?? 'I handed it to the background. I’ll tell you when it’s done.' };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : 'That didn’t go through. Try again.' };
    }
  }, [about, client, follow, store]);

  const qa = useMemo<QaView[]>(() => mergeAsks(history, pending), [history, pending]);
  const chip = label ?? about?.label ?? (item ? shortLabel(item.title) : null);
  return { qa, send, suggestions, loadSuggestions, chip };
}

/** What was asked before and what was asked here, one entry per ask id (whichever knows the answer wins). */
export function mergeAsks(history: Ask[], pending: PendingAsk[]): QaView[] {
  const out: QaView[] = history.map((a) => ({ key: a.id, q: a.text, a: a.answer, state: stateOf(a), cross: [], tainted: !!a.tainted }));
  for (const p of pending) {
    const i = out.findIndex((x) => x.key === p.askId);
    if (i < 0) { out.push({ key: p.askId, q: p.q, a: p.a, state: p.state, cross: p.cross, tainted: p.tainted }); continue; }
    const h = out[i];
    out[i] = h.state === 'waiting' && p.state !== 'waiting'
      ? { ...h, a: p.a, state: p.state, tainted: p.tainted || h.tainted, cross: p.cross }
      : { ...h, cross: p.cross.length ? p.cross : h.cross, tainted: h.tainted || p.tainted };
  }
  return out;
}

export function AskAboutButton({ onClick }: { onClick: () => void }) {
  return <button type="button" className="vbtn vbtn-helper" onClick={onClick}><Spark />Ask about this</button>;
}

/** The answers under the thing: "You asked" — each question, then the helper's answer (or that it is answering). */
export function QaBlock({ qa, idp }: { qa: QaView[]; idp: string }) {
  const { fixtures } = useMeta();
  if (!qa.length) return null;
  return (
    <section className="qa" aria-labelledby={`qa-${idp}`}>
      <h3 className="qa-h" id={`qa-${idp}`}>You asked</h3>
      {qa.map((x) => (
        <div key={x.key} className="qa-pair">
          <div className="qa-q"><span className="sr-only">You asked: </span>{x.q}</div>
          {x.state === 'waiting'
            ? <div className="qa-a"><span className="typing" aria-label="Your helper is answering"><i /><i /><i /></span></div>
            : (
              <div className={`qa-a${x.tainted ? ' tainted' : ''}`} role={x.state === 'failed' ? 'alert' : undefined}>
                <p className="who"><Spark size={16} />Your helper{fixtures ? <span className="simmini">simulated</span> : null}</p>
                {x.tainted && x.state === 'answered' && <p className="taintnote"><WarnIcon size={15} />{TAINTED_NOTE}</p>}
                <p className="qa-text">{x.state === 'failed' ? 'That didn’t get an answer. Try asking again.' : linksToHosts(x.a ?? '')}</p>
                {x.cross.length > 0 && <p className="cross"><LinkIcon />using what I know from {x.cross.join(', ')}</p>}
              </div>
            )}
        </div>
      ))}
    </section>
  );
}

/**
 * The Ask sheet tied to one thing. A question goes with the thing (never pasted into the question); once the helper
 * is answering, the sheet closes and the answer appears under the thing.
 */
export function AskAboutSheet({ id, open, onClose, ask, prefill }: {
  /** one per screen place (the item sheet, the reader): ids stay unique */
  id: string; open: boolean; onClose: () => void; ask: ReturnType<typeof useAskAbout>; prefill?: string;
}) {
  const [text, setText] = useState('');
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const [sending, setSending] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const { loadSuggestions } = ask;
  useEffect(() => {
    if (!open) return;
    setText(prefill ?? ''); setNote(null);
    void loadSuggestions();
    const t = setTimeout(() => input.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [open, prefill, loadSuggestions]);
  const go = async (words: string) => {
    if (sending) return;
    setSending(true); setNote(null);
    const r = await ask.send(words);
    setSending(false);
    if (r.ok && r.closed) { setText(''); onClose(); return; }
    if (r.message) setNote({ text: r.message, error: !r.ok });
  };
  const submit = (e: FormEvent) => { e.preventDefault(); void go(text); };
  return (
    <Sheet id={id} titleId={`${id}-title`} title="Ask about this" open={open} onClose={onClose}
      head={ask.chip ? <span className="ask-ctx"><span className="aboutchip"><Spark size={14} />About: {ask.chip}</span></span> : null}>
      <div className="sheet-body">
        <div className="ask-sugg" role="group" aria-label="Suggested questions">
          {ask.suggestions.map((s) => <button key={s} type="button" className="sugg" disabled={sending} onClick={() => void go(s)}>{s}</button>)}
        </div>
        {note && <p className={`ask-note${note.error ? ' errline' : ''}`} role={note.error ? 'alert' : 'status'}>{note.text}</p>}
      </div>
      <form className="ask-form" autoComplete="off" noValidate onSubmit={submit}>
        <div className="ask-row">
          <label htmlFor={`${id}-input`} className="sr-only">Message your helper</label>
          <input ref={input} id={`${id}-input`} className="ask-input" type="text" placeholder="Ask about this…" enterKeyHint="send" value={text} onChange={(e) => setText(e.target.value)} />
          <button type="submit" className="sendbtn" aria-label="Send" disabled={sending}>
            <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </div>
      </form>
    </Sheet>
  );
}
