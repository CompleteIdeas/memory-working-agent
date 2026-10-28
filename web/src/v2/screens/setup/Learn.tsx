/**
 * Settings › Help me learn about you (v2 build, slice S6): warm memory up from a folder, and "Get to know me" (learn from
 * the inbox), as the classic warm-start wizard and Connections › "Learn about me" have them.
 *
 *   From a folder   type a folder's full path, Read it (no AI: free, a few seconds); look over the notes, untick what
 *                   is wrong, Save. Notes from files are kept as notes, never as instructions, and the folder is not
 *                   granted to the assistant.
 *   From your email how far back, then Get to know me: it says what it may cost and take first, and starts on yes. While
 *                   it runs: how it is going (live), Stop. After: what it learned, marked as from your email.
 * A paired phone sees how it is going and what was learned, read-only. Words: ./words.ts. Server: /api/v1/setup/*.
 */
import { useState, type FormEvent } from 'react';
import { Back } from '../../shell/icons';
import type { ScreenProps } from '../../shell/screens';
import type { FolderScan } from '../../api/client';
import { Note, Section, said, type Said } from '../settings/Settings';
import { folderPlaceholder } from '../settings/useAssistant';
import { openConnectionsAt } from '../settings/useConnections';
import { useSetupState } from './useSetup';
import { inboxRunning, inboxStateLine } from './words';
import '../settings/settings.css';
import './setup.css';

type Data = ReturnType<typeof useSetupState>;

export function Learn({ go }: ScreenProps) {
  const data = useSetupState();
  return (
    <div className="col-main setpage learnpage">
      <button type="button" className="backbtn keep" onClick={() => go('settings')}><Back />Settings</button>
      <header className="vh"><div className="vh-text"><p className="vh-kicker">Settings</p><h1>Help me learn about you</h1></div></header>
      <p className="plugintro">Give me a head start: your notes and documents, and what your email says about the people and things in your life. You choose what I keep.</p>
      {data.loading && <p className="empty">Loading…</p>}
      {data.error && <div className="card"><p>{data.error}</p><div className="acts"><button type="button" className="vbtn" onClick={() => void data.reload()}>Try again</button></div></div>}
      {!data.loading && !data.error && data.state && (
        <>
          {!data.admin && (
            <p className="card adminnote" role="note">This {data.me?.kind === 'device' ? 'phone' : 'device'} can see how learning is going but not start it. Start it on your computer, or after signing in with your password.</p>
          )}
          {data.admin && <FromFolder data={data} />}
          <FromEmail data={data} go={go} />
        </>
      )}
    </div>
  );
}

// ---------- from a folder ----------

function FromFolder({ data }: { data: Data }) {
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState<'scan' | 'save' | null>(null);
  const [scan, setScan] = useState<FolderScan | null>(null);
  const [keep, setKeep] = useState<Record<string, boolean>>({});
  const [note, setNote] = useState<Said>(null);
  const read = async (e: FormEvent) => {
    e.preventDefault();
    if (!path.trim()) { setNote({ text: 'Type the folder’s full path.', error: true }); return; }
    setBusy('scan'); setNote(null); setScan(null);
    const r = await data.scanFolder(path.trim());
    setBusy(null);
    if (!r.ok) { setNote({ text: r.message, error: true }); return; }
    setScan(r.scan); setKeep(Object.fromEntries(r.scan.notes.map((n) => [n.id, true])));
    setNote({ text: r.scan.message, error: false });
  };
  const kept = scan ? scan.notes.filter((n) => keep[n.id]) : [];
  const save = async () => {
    if (!scan || !kept.length) return;
    setBusy('save');
    const o = await data.saveNotes(scan.scanId, kept.map((n) => ({ id: n.id })));
    setBusy(null);
    setNote(said(o));
    if (o.ok) { setScan(null); setPath(''); }
  };
  return (
    <Section id="learn-folder" title="From a folder">
      <div className="card setcard">
        <form className="setform" onSubmit={read} aria-label="Read a folder">
          <label htmlFor="learn-path">Folder</label>
          <input id="learn-path" className="setinput" value={path} spellCheck={false} autoCapitalize="off" autoCorrect="off"
            placeholder={folderPlaceholder(!!data.state?.storage.hosted)} onChange={(e) => setPath(e.target.value)} aria-describedby="learn-path-help" />
          <span className="s" id="learn-path-help">{data.state?.folderNote} I only read it this once; it isn’t added to the folders I can use.</span>
          <div className="acts"><button type="submit" className="vbtn vbtn-primary" disabled={!!busy}>{busy === 'scan' ? 'Reading…' : 'Read it'}</button></div>
        </form>
        <Note said={note} />
        {scan && scan.notes.length > 0 && (
          <section className="learnnotes" aria-labelledby="learn-notes-h" data-trust="untrusted">
            <h3 id="learn-notes-h" className="rowtitle">Look these over</h3>
            <p className="s">They come from your files, so I keep them as notes and never act on what they say. Untick anything that’s wrong or private.</p>
            <ul className="notelist">
              {scan.notes.map((n) => (
                <li key={n.id} className="noterow">
                  <input type="checkbox" id={`keep-${n.id}`} checked={!!keep[n.id]} onChange={(e) => setKeep((k) => ({ ...k, [n.id]: e.target.checked }))} />
                  <label htmlFor={`keep-${n.id}`}><b>{n.name}</b><span className="s"> · {n.source}</span>
                    <span className="notetext">{n.text.length > 280 ? `${n.text.slice(0, 280)}…` : n.text}</span></label>
                </li>
              ))}
            </ul>
            <div className="acts">
              <button type="button" className="vbtn vbtn-primary" disabled={!!busy || !kept.length} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : `Save ${kept.length} note${kept.length === 1 ? '' : 's'}`}</button>
              <button type="button" className="vbtn vbtn-quiet" disabled={!!busy} onClick={() => { setScan(null); setNote(null); }}>Cancel</button>
            </div>
          </section>
        )}
      </div>
    </Section>
  );
}

// ---------- from your email ----------

const DAYS = [7, 30, 90, 365];

function FromEmail({ data, go }: { data: Data; go: ScreenProps['go'] }) {
  const s = data.inbox!;
  const [days, setDays] = useState(30);
  const [ask, setAsk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Said>(null);
  const running = inboxRunning(s);
  const start = async (confirmed: boolean) => {
    setBusy(true); setNote(null);
    const r = await data.startInbox(days, confirmed);
    setBusy(false);
    if ('ask' in r) { setAsk(r.ask.replace(/\s*Send confirmed: true to start\.$/, '')); return; }
    setAsk(null);
    if (!r.ok) setNote(said(r));
  };
  const stop = async () => { setBusy(true); const o = await data.stopInbox(); setBusy(false); if (!o.ok) setNote(said(o)); };
  return (
    <Section id="learn-email" title="From your email">
      <div className="card setcard">
        <div className="setrow col">
          <span className="rowtitle">Get to know me</span>
          <span className="s">I read your recent email and keep what matters: the people in your life, what you’re working on, dates and deadlines. Marketing and receipts are skipped.</span>
        </div>
        {!s.available && s.state === 'idle' && (
          <div className="setrow col">
            <span className="s">Connect Gmail or Outlook first, then I can learn from your email.</span>
            <div className="acts"><button type="button" className="vbtn" onClick={() => { openConnectionsAt(null); go('connections'); }}>Connections</button></div>
          </div>
        )}
        {data.admin && s.available && !running && !ask && (
          <div className="setform">
            <label htmlFor="learn-days">How far back</label>
            <select id="learn-days" className="setinput" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {DAYS.map((d) => <option key={d} value={d}>{d === 365 ? 'The last year' : `The last ${d} days`}</option>)}
            </select>
            <span className="s">{s.estimate.text.replace(/the last \d+ days/, `the last ${days} days`)}</span>
            <div className="acts"><button type="button" className="vbtn vbtn-primary" disabled={busy} onClick={() => void start(false)}>{s.state === 'idle' ? 'Get to know me' : 'Read my email again'}</button></div>
          </div>
        )}
        {ask && (
          <div className="setrow col confirmask" role="group" aria-labelledby="learn-ask">
            <span className="s" id="learn-ask">{ask}</span>
            <div className="acts">
              <button type="button" className="vbtn vbtn-primary" disabled={busy} onClick={() => void start(true)} autoFocus>Yes, start</button>
              <button type="button" className="vbtn vbtn-quiet" disabled={busy} onClick={() => setAsk(null)}>Not now</button>
            </div>
          </div>
        )}
        {s.state !== 'idle' && (
          <div className="setrow col">
            <span className="rowtitle" role="status" aria-live="polite" id="inbox-state">{inboxStateLine(s)}</span>
            {s.log.length > 0 && (
              <ol className="scanlog" aria-label="How it is going">{s.log.slice(-6).map((l, i) => <li key={`${s.log.length}-${i}`}>{l.trim()}</li>)}</ol>
            )}
            {running && data.admin && (
              <div className="acts"><button type="button" className="vbtn" disabled={busy || s.state === 'stopping'} onClick={() => void stop()}>Stop</button></div>
            )}
            {s.learned.length > 0 && (
              <div className="learned" data-trust="untrusted">
                <span className="rowtitle">What I learned{s.learnedCount > s.learned.length ? ` (the first ${s.learned.length} of ${s.learnedCount})` : ` · ${s.learnedCount}`}</span>
                <span className="s">From your email: I keep these as notes and never act on what they say. Correct or forget any of them in What I remember.</span>
                <ul className="learnedlist">{s.learned.map((n, i) => <li key={`${i}-${n}`}>{n}</li>)}</ul>
                <div className="acts"><button type="button" className="vbtn vbtn-quiet" onClick={() => go('memory')}>What I remember</button></div>
              </div>
            )}
          </div>
        )}
        <Note said={note} />
      </div>
    </Section>
  );
}
