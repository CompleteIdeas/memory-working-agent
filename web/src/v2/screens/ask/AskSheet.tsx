/**
 * The Ask sheet (v2 build, slice W4), as approved (prototype-v2: N02, N04, N08, N11): "Ask, or hand over a job".
 * It replaces W1's placeholder behind the same buttons and accessible names (REPLAY-NOTES): `#ask-dlg`,
 * `textbox "Message your helper"`, `button "Send"`, `button "Add files"` (`#ask-file`), `button "Hold to talk"`,
 * `button "Close"`.
 *
 *   - While typing, where it would go: "To: Family & school · suggested" (GET /projects/suggest, debounced). Change
 *     picks a project; the person's choice wins over any suggestion and is sent as `projectId`. Without a choice the
 *     server routes by the same suggestion. Opened from a project, it goes there ("this project").
 *   - Send is POST /ask through the outbox (made offline, it waits with its key). What it became shows in place:
 *     the answer followed live, the plan card, the job ("I'll let you know · ready around …"), or the offer.
 *   - Opened about one thing (`about.kind` + `about.id`: a job from the working sheet…), it shows the chip and the
 *     server's 2–3 questions for it; the ask carries `about` and the answer shows here.
 *   - Files: the legacy upload (see ./upload.ts: works with the password sign-in, not yet on a paired phone).
 *   - The mic: real voice is P4; until then it says so and puts the cursor in the text box (N08: the mic opens Ask).
 */
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useAsk, useMeta, useProjects, useStore } from '../../store/react';
import type { AskBody } from '../../api/client';
import { Sheet } from '../../shell/sheets';
import { Close, Mic, Spark } from '../../shell/icons';
import { AskOutcomeView, Typing, Who } from './AskOutcome';
import { refusalFor, routeHow, type Refusal } from './logic';
import { MAX_FILES, MAX_UPLOAD_BYTES, uploadFile } from './upload';
import './ask.css';

/** What the sheet is opened for. W1's shape ({label, projectId}) plus, for "Ask about this", the thing's kind and id. */
export interface AskContext {
  label: string;
  projectId: string | null;
  kind?: 'item' | 'mail' | 'event' | 'draft' | 'job' | 'conflict';
  id?: string;
}

interface Exchange { n: number; text: string; files: string[]; entryId?: string; queued?: string; refusal?: Refusal; sending: boolean }
interface RouteChoice { projectId: string; name: string; confidence: string }
/** A file picked for the ask: added to the project at Send (to wherever the ask goes then). */
interface Picked { file: File; name: string; key: number }

const DEFAULT_SUGGESTIONS = ['What’s on today?', 'Add a reminder'];
const PROJECT_SUGGESTIONS = ['What’s coming up?', 'Take notes'];

export function AskSheet({ open, about, onClose, onShowWork }: { open: boolean; about: AskContext | null; onClose: () => void; onShowWork?: () => void }) {
  const store = useStore();
  const projects = useProjects();
  const { fixtures } = useMeta();
  const asks = useAsk();
  const aboutThing = about?.kind && about.id ? { kind: about.kind, id: about.id } : null;
  const inProject = !aboutThing && about?.projectId ? projects.find((p) => p.id === about.projectId) ?? null : null;

  const [text, setText] = useState('');
  // files are kept on the device until Send, then added to the project the ask goes to at that moment
  const [files, setFiles] = useState<Picked[]>([]);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [fileNote, setFileNote] = useState<string | null>(null);
  const [micNote, setMicNote] = useState<string | null>(null);
  const [chosen, setChosen] = useState<RouteChoice | null>(null);
  const [suggested, setSuggested] = useState<RouteChoice | null>(null);
  const [changing, setChanging] = useState(false);
  const [log, setLog] = useState<Exchange[]>([]);
  const [questions, setQuestions] = useState<string[] | null>(null);
  const [formBack, setFormBack] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const n = useRef(0);
  const fileKey = useRef(0);
  const suggestSeq = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);

  // a fresh sheet each time it opens (or opens about something else)
  useEffect(() => {
    if (!open) return;
    setText(''); setFiles([]); setFileNote(null); setMicNote(null); setChanging(false); setLog([]); setFormBack(false); setSuggested(null);
    setChosen(inProject ? { projectId: inProject.id, name: inProject.name, confidence: 'this project' } : null);
    setQuestions(null);
    const t = setTimeout(() => { if (!matchMedia('(pointer: coarse)').matches) input.current?.focus(); }, 30);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, about?.label, about?.kind, about?.id, about?.projectId]);

  // the questions specific to the thing it is about (no model call on the server)
  useEffect(() => {
    if (!open || !aboutThing) return;
    let on = true;
    store.client.askSuggestions(`${aboutThing.kind}:${aboutThing.id}`).then((r) => { if (on) setQuestions(r.suggestions); }, () => { if (on) setQuestions([]); });
    return () => { on = false; };
  }, [open, aboutThing?.kind, aboutThing?.id, store]); // eslint-disable-line react-hooks/exhaustive-deps

  // where it would go, while typing (debounced; the person's choice wins)
  useEffect(() => {
    if (!open || aboutThing || chosen) return;
    const words = text.trim();
    if (words.length < 3) { setSuggested(null); return; }
    const seq = ++suggestSeq.current;
    const t = setTimeout(() => {
      store.client.suggestProject({ text: words.slice(0, 2000) }).then((s) => {
        if (seq !== suggestSeq.current) return;
        const name = projects.find((p) => p.id === s.projectId)?.name ?? 'General';
        setSuggested({ projectId: s.projectId, name, confidence: s.confidence });
      }, () => { /* offline or refused: no suggestion, the server routes it */ });
    }, 450);
    return () => clearTimeout(t);
  }, [text, open, chosen, aboutThing, projects, store]);

  useEffect(() => { const l = logRef.current; if (l) l.scrollTop = l.scrollHeight; }, [log, asks]);

  const route = chosen ?? suggested;
  const target = route?.projectId ?? projects.find((p) => p.general)?.id ?? null;
  const last = log[log.length - 1];
  const lastOutcome = last ? asks.outcome(last.entryId) : undefined;
  const waitingChoice = !!lastOutcome && lastOutcome.start.kind === 'plan' && !asks.choice(lastOutcome.start.askId) && asks.ask(lastOutcome.start.askId)?.state !== 'expired'
    && !asks.refusedChoice(lastOutcome.start.askId);
  const hideForm = waitingChoice && !formBack;
  // plans waiting for a choice live in the store: shown again when the sheet opens, once each (not twice when this
  // sheet's own log already holds the same ask)
  const inLog = new Set(log.map((x) => asks.outcome(x.entryId)?.start.askId).filter((x): x is string => !!x));
  const waitingPlans = aboutThing ? [] : asks.waitingPlans.filter((o) => !inLog.has(o.start.askId));

  const send = async (raw: string) => {
    const words = raw.trim();
    if ((!words && !files.length) || sendingRef.current) return;
    sendingRef.current = true; setSending(true);
    try {
      const said = words || 'Here are some files.';
      // the files go to the project it goes to now (a Change after picking them moves them with it)
      const paths: string[] = [];
      if (!aboutThing && files.length) {
        setUploading(true); setFileNote(null);
        for (const f of files) {
          const r = await uploadFile(f.file, { projectId: target, fixtures });
          if (!r.ok) { setFileNote(r.message); setUploading(false); return; }
          paths.push(r.file.path);
        }
        setUploading(false);
      }
      const body: AskBody = {
        text: said,
        ...(aboutThing ? { about: aboutThing } : {}),
        ...(!aboutThing && chosen ? { projectId: chosen.projectId } : {}),
        ...(paths.length ? { files: paths } : {}),
      };
      const id = ++n.current;
      setLog((l) => [...l, { n: id, text: said, files: files.map((f) => f.name), sending: true }]);
      setText(''); setFiles([]); setFileNote(null); setMicNote(null); setFormBack(false);
      const r = await asks.send(body, said.slice(0, 60));
      setLog((l) => l.map((x) => (x.n !== id ? x : {
        ...x, sending: false, entryId: r.entryId,
        ...(r.queued ? { queued: r.message } : {}),
        ...(!r.ok && !r.queued ? { refusal: refusalFor(r.code, r.message) } : {}),
      })));
    } finally { sendingRef.current = false; setSending(false); }
  };
  const submit = (e: FormEvent) => { e.preventDefault(); void send(text); };
  const again = (t: string) => { setText(t); setFormBack(true); setTimeout(() => input.current?.focus(), 30); };

  const addFiles = (e: ChangeEvent<HTMLInputElement>) => {
    const picked = [...(e.target.files ?? [])];
    e.target.value = '';
    if (!picked.length) return;
    if (files.length + picked.length > MAX_FILES) { setFileNote(`Up to ${MAX_FILES} files at a time.`); return; }
    const big = picked.find((f) => f.size > MAX_UPLOAD_BYTES);
    if (big) { setFileNote(`${big.name} is too big to add here: the limit is 25 MB.`); return; }
    setFileNote(null);
    setFiles((x) => [...x, ...picked.map((file) => ({ file, name: file.name || 'file', key: ++fileKey.current }))]);
  };

  const ctx = aboutThing ? <span className="aboutchip"><Spark size={14} />About: {about!.label}</span>
    : inProject ? <>In {inProject.name}</> : null;
  const starters = aboutThing ? questions ?? [] : inProject ? PROJECT_SUGGESTIONS : DEFAULT_SUGGESTIONS;
  const showStarters = !log.length && !text && !files.length && starters.length > 0;

  return (
    <Sheet id="ask-dlg" titleId="ask-title" title="Ask your helper" open={open} onClose={onClose}
      head={<span className="ask-ctx" id="ask-ctx">{ctx}</span>}>
      <div ref={logRef} className="ask-log" id="ask-log" role="log" aria-live="polite" aria-label="Conversation with your helper">
        {waitingPlans.map((o) => (
          <div key={o.start.askId} className="thread">
            <div className="msg-you"><span className="sr-only">You: </span>{o.text}<span className="routeto">{o.replayed ? 'Sent when you were back online · ' : ''}waiting for your choice</span></div>
            <AskOutcomeView start={o.start} text={o.text} onShowWork={onShowWork} onAgain={again} onDismiss={() => asks.dismiss(o.start.askId)} />
          </div>
        ))}
        {log.map((x) => {
          const out = asks.outcome(x.entryId);
          return (
            <div key={x.n} className="thread">
              <div className="msg-you"><span className="sr-only">You: </span>{x.text}
                {x.files.length > 0 && <span className="routeto">{x.files.join(', ')}</span>}
                {out && !aboutThing && <span className="routeto">To: {out.start.route.name}</span>}
              </div>
              {x.refusal ? (
                <div className="refusal" role="alert"><p>{x.refusal.text}</p>
                  {x.refusal.again && <div className="acts"><button type="button" className="vbtn" onClick={() => again(x.text)}>Ask again</button></div>}
                </div>
              ) : out ? <AskOutcomeView start={out.start} text={out.text} onShowWork={onShowWork} onAgain={again} autoFocus={x === last} />
                : x.queued ? (asks.waiting(x.entryId) ? <p className="ask-note" role="status">Waiting to send. {x.queued}</p>
                  : <div className="refusal" role="alert"><p>{refusedText(asks.refused(x.entryId))}</p><div className="acts"><button type="button" className="vbtn" onClick={() => again(x.text)}>Ask again</button></div></div>)
                : <div className="msg-h"><Who /><Typing /></div>}
            </div>
          );
        })}
      </div>
      {showStarters && (
        <div className="ask-sugg" id="ask-sugg">
          {starters.map((s) => <button key={s} type="button" className="sugg" disabled={sending} onClick={() => void send(s)}>{s}</button>)}
        </div>
      )}
      {hideForm && (
        <div className="editask">
          <button type="button" className="linkish quietlink" onClick={() => { if (last) setText(last.text); setFormBack(true); setTimeout(() => input.current?.focus(), 30); }}>Edit my ask</button>
        </div>
      )}
      <form className="ask-form" id="ask-form" autoComplete="off" noValidate onSubmit={submit} hidden={hideForm}>
        {files.length > 0 && (
          <div className="ask-files" id="ask-files">
            {files.map((f, i) => (
              <span key={f.key} className="filechip"><DocIcon />{f.name}
                <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles((x) => x.filter((_, k) => k !== i))}><Close size={16} /></button>
              </span>
            ))}
          </div>
        )}
        {(fileNote || micNote || uploading) && <p className="ask-note" role="status">{uploading ? 'Adding your files…' : fileNote ?? micNote}</p>}
        <div className="ask-row">
          {!aboutThing && (
            <button type="button" className="iconbtn attach" aria-label="Add files" disabled={uploading} onClick={() => fileInput.current?.click()}>
              <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth={2} strokeLinecap="round" /></svg>
            </button>
          )}
          <input ref={fileInput} type="file" id="ask-file" className="sr-only" multiple accept=".pdf,.txt,.md,.docx,.csv,.html" tabIndex={-1} aria-label="Choose files" onChange={addFiles} />
          <label htmlFor="ask-input" className="sr-only">Message your helper</label>
          <input ref={input} id="ask-input" className="ask-input" type="text" placeholder={aboutThing ? 'Ask about this…' : 'Ask anything…'} enterKeyHint="send"
            value={text} onChange={(e) => { setText(e.target.value); setMicNote(null); }} />
          {!text.trim() && !files.length ? (
            <button type="button" className="micbtn" aria-label="Hold to talk" aria-describedby="mic-hint"
              onClick={() => { setMicNote('Talking to your helper comes in a later update. Type it for now.'); input.current?.focus(); }}><Mic size={22} /></button>
          ) : (
            <button type="submit" className="sendbtn" id="send-btn" aria-label="Send" disabled={uploading || sending}>
              <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          )}
          <span className="sr-only" id="mic-hint">Voice comes in a later update.</span>
        </div>
        {!aboutThing && (route || changing) && (
          <div className="routeline" id="ask-route">
            {changing ? (
              <>
                <label htmlFor="ask-to">To:</label>
                <select id="ask-to" className="routeselect" value={route?.projectId ?? ''} onChange={(e) => {
                  const p = projects.find((x) => x.id === e.target.value);
                  if (p) setChosen({ projectId: p.id, name: p.name, confidence: 'given' });
                  setChanging(false);
                }}>
                  {!route && <option value="">Pick a project</option>}
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </>
            ) : (
              <>
                <span>To: <b>{route!.name}</b>{routeHow(route!.confidence) ? ` · ${routeHow(route!.confidence)}` : ''}</span>
                <button type="button" className="linkish quietlink" aria-label={`Change where this goes (now ${route!.name})`} onClick={() => setChanging(true)}>Change</button>
              </>
            )}
          </div>
        )}
      </form>
    </Sheet>
  );
}

function DocIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20z" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinejoin="round" /><path d="M14 3.5V8h4" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinejoin="round" /></svg>;
}

/** Why an ask sent from the outbox was refused, in plain words. */
function refusedText(r: { code?: string; message: string } | undefined): string {
  return r ? refusalFor(r.code, r.message).text : 'That didn’t go through. Ask again.';
}
