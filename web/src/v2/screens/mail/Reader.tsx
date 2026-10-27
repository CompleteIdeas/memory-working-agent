/**
 * The mail reader (v2 build, slice W3). Opening an email shows the message as the server sanitised it (GET
 * /mail/{id}: plain text, remote pictures and trackers removed, links as their host): rendered as TEXT, never HTML,
 * with auto-linking off. The sender's address is always shown; a reply that would go somewhere other than the sender
 * says so before anything is written. "Draft a reply" saves a DRAFT in the person's account (POST /mail/{id}/draft);
 * nothing is ever sent. "Ask about this" answers under the message. The body is never stored on the device.
 */
import { useEffect, useState } from 'react';
import type { ImportantItem, MailMessage } from '../../api/client';
import { useItemActions, useMeta, useStore } from '../../store/react';
import { Back, Spark } from '../../shell/icons';
import { AskAbout } from '../ask/AskAbout';
import { shortLabel } from '../../store/important';
import { ActionPreview, CautionBox } from '../important/ItemDetail';
import { CautionTag } from '../important/ItemRow';
import { CheckIcon, WarnIcon } from '../important/icons';
import { showName } from '../../store/text';

export const NEVER_SENDS = 'Your helper reads and writes drafts. It never sends.';

/** One message, fetched when opened and kept only while it is open. */
export function useMailMessage(mailId: string | null) {
  const store = useStore();
  const [state, setState] = useState<{ msg: MailMessage | null; error: string | null; loading: boolean }>({ msg: null, error: null, loading: false });
  useEffect(() => {
    if (!mailId) { setState({ msg: null, error: null, loading: false }); return; }
    let on = true;
    setState({ msg: null, error: null, loading: true });
    store.client.readMail(mailId).then(
      (msg) => { if (on) setState({ msg, error: null, loading: false }); },
      (e: unknown) => { if (on) setState({ msg: null, error: e instanceof Error ? e.message : 'I couldn’t open that message.', loading: false }); },
    );
    return () => { on = false; };
  }, [store, mailId]);
  return state;
}

const when = (ms: number) => {
  const d = new Date(ms), now = new Date();
  return d.toDateString() === now.toDateString() ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

function BodyNotes({ m }: { m: MailMessage }) {
  const notes: string[] = [];
  if (m.imagesHidden) notes.push(`${m.imagesHidden} ${m.imagesHidden === 1 ? 'picture' : 'pictures'} not shown`);
  if (m.trackersRemoved) notes.push(`${m.trackersRemoved} ${m.trackersRemoved === 1 ? 'tracker' : 'trackers'} removed`);
  if (m.quotedLinesHidden) notes.push(`${m.quotedLinesHidden} quoted ${m.quotedLinesHidden === 1 ? 'line' : 'lines'} hidden`);
  if (m.truncated) notes.push('only the start is shown');
  if (m.tooComplex) notes.push('this message was too complex to show in full; open it in your mail app');
  if (!notes.length) return null;
  return <p className="receipt bodynotes">{notes.join(' · ')}.</p>;
}

function DraftReply({ m }: { m: MailMessage }) {
  const actions = useItemActions();
  const [mode, setMode] = useState<'idle' | 'edit' | 'saved'>('idle');
  const [text, setText] = useState('');
  const [saved, setSaved] = useState('');
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setMode('idle'); setText(''); setNote(null); }, [m.id]);
  const save = async () => {
    if (!text.trim()) { setNote({ text: 'Write the reply first.', error: true }); return; }
    setBusy(true); setNote(null);
    const r = await actions.saveDraft(m.id, text);
    setBusy(false);
    if (r.ok) { setSaved(text); setMode('saved'); setNote({ text: r.message ?? 'Saved to your drafts. Nothing was sent.', error: false }); }
    else setNote({ text: r.message, error: !r.queued });
  };
  return (
    <div className="draftreply">
      {mode === 'idle' && (
        <div className="acts dacts"><button type="button" className="vbtn" onClick={() => setMode('edit')}>Draft a reply</button></div>
      )}
      {mode === 'edit' && (
        <>
          <label className="draftbox-label" htmlFor={`draft-${m.id}`}>Draft reply</label>
          {m.replyGoesElsewhere && m.replyNote && <p className="replywarn small"><WarnIcon size={15} />{m.replyNote}</p>}
          <textarea id={`draft-${m.id}`} className="draftedit" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
          <div className="acts dacts">
            <button type="button" className="vbtn vbtn-primary" disabled={busy} onClick={() => void save()}>Save draft</button>
            <button type="button" className="vbtn vbtn-quiet" onClick={() => { setMode('idle'); setNote(null); }}>Cancel</button>
          </div>
        </>
      )}
      {mode === 'saved' && (
        <>
          <span className="draftbox-label">Your reply</span>
          <div className="draftbox">{saved}</div>
        </>
      )}
      {note && <p className={note.error ? 'refusal' : 'donebanner'} role={note.error ? 'alert' : 'status'}>{!note.error && <CheckIcon />}{note.text}</p>}
      {mode !== 'saved' && <p className="receipt">{NEVER_SENDS}</p>}
    </div>
  );
}

export interface ReaderProps {
  mailId: string;
  /** the Important item it came from, if any: its why, Mark handled / Not important, and Ask about the item */
  item?: ImportantItem | null;
  back?: { label: string; onClick: () => void };
  /** h1 on the screen, h2 in a sheet */
  heading?: 'h1' | 'h2';
  idp: string;
  onHandled?: (it: ImportantItem) => void;
  onNotImportant?: (it: ImportantItem) => void;
  /** the item's one action (Add to calendar, Remind me…), shown in the helper's note as in the prototype */
  onRun?: (it: ImportantItem) => void;
  busy?: (it: ImportantItem) => boolean;
}

export function MailReader({ mailId, item, back, heading = 'h1', idp, onHandled, onNotImportant, onRun, busy }: ReaderProps) {
  const { msg, error, loading } = useMailMessage(mailId);
  const { fixtures } = useMeta();
  // the message's own caution (review of W3: opened from All email it had none), else the item's
  const caution = (msg ? msg.caution ?? item?.caution : item?.caution) ?? null;
  const phishing = caution === 'phishing';
  const H = heading;
  return (
    <>
      {back && <button type="button" className="backbtn keep" onClick={back.onClick}><Back />{back.label}</button>}
      <article className="reader" aria-labelledby={`rd-subj-${idp}`}>
        {loading && <><H className="subject" id={`rd-subj-${idp}`}>{item?.title ?? 'Opening…'}</H><p className="empty">Opening the message…</p></>}
        {error && <><H className="subject" id={`rd-subj-${idp}`}>{item?.title ?? 'This message'}</H><p className="refusal" role="alert">{error}</p></>}
        {msg && (
          <>
            <H className="subject" id={`rd-subj-${idp}`}>{msg.subject || '(no subject)'}</H>
            <div className="meta sender">
              {showName(msg.from.name) && <b className="sendername">{showName(msg.from.name)}</b>}
              {/* the real address, on its own line, never cut short, at least as prominent as the name */}
              {msg.from.addr ? <span className="addrline big">{msg.from.addr}</span> : !showName(msg.from.name) && <b>Unknown sender</b>}
              <span className="when">{when(msg.receivedAt)}</span>
            </div>
            {caution === 'unverified' && <p style={{ marginTop: 8 }}><CautionTag caution={caution} /></p>}
            <CautionBox caution={caution} why={item?.caution === 'phishing' ? item.why : null} />
            {msg.replyGoesElsewhere && msg.replyNote && (
              <p className="replywarn" role="note"><WarnIcon />{msg.replyNote}</p>
            )}
            <div className="body mailbody">{msg.bodyText}</div>
            <BodyNotes m={msg} />
            <section className="helperbox" aria-labelledby={`hb-${idp}`}>
              <h2 className="sr-only" id={`hb-${idp}`}>Your helper’s note</h2>
              <p className="who"><Spark />Your helper{fixtures ? <span className="simmini">simulated</span> : null}</p>
              {item?.why && !phishing && <p style={{ marginTop: 6 }}>{item.why}</p>}
              {item && !phishing && item.state === 'open' && item.action && item.action.kind !== 'review-reply' && onRun && (
                <>
                  <ActionPreview it={item} />
                  <div className="acts dacts">
                    <button type="button" className={`vbtn${item.action.kind === 'add-to-calendar' || item.action.kind === 'draft-note' ? ' vbtn-primary' : ''}`} disabled={busy?.(item)} onClick={() => onRun(item)}>{item.action.label}</button>
                  </div>
                </>
              )}
              {phishing ? <p style={{ marginTop: 6 }}>I won’t draft a reply to this one. If it might be real, contact the company through its own app or website.</p>
                : <DraftReply m={msg} />}
            </section>
          </>
        )}
        {msg && !phishing && (
          <>
            <div className="askrow">
              <AskAbout key={item ? item.id : mailId} kind={item ? 'item' : 'mail'} id={item ? item.id : mailId} label={shortLabel(item ? item.title : msg.subject || '(no subject)')}
                item={item ?? null} form="sheet" sheetId={`about-mail-${idp}`} taintNote={'Based on what the email says — check before acting'} />
            </div>
          </>
        )}
        {item && item.state === 'open' && (onHandled || onNotImportant) && (
          <div className="itemfoot">
            {!phishing && onHandled && <button type="button" className="vbtn vbtn-quiet" onClick={() => onHandled(item)}><CheckIcon />Mark handled</button>}
            {onNotImportant && <button type="button" className="vbtn vbtn-quiet" onClick={() => onNotImportant(item)}>Not important</button>}
          </div>
        )}
      </article>
    </>
  );
}
