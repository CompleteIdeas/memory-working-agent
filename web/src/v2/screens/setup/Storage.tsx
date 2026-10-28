/**
 * Settings › Where memory is kept (v2 build, slice S6), as the classic Connections › Memory storage card has it: this
 * computer (SQLite, private, no setup) or a database server (Postgres + pgvector) for an always-on, cloud or
 * multi-device helper. The address goes into a password field, is checked by connecting, and never comes back (only
 * the server's name, on this computer). It asks first, and the change takes effect when the helper restarts. A paired
 * phone sees where memory is kept, read-only. Words: ./words.ts. Server: PUT /api/v1/setup/storage.
 */
import { useState, type FormEvent } from 'react';
import { Back } from '../../shell/icons';
import type { ScreenProps } from '../../shell/screens';
import type { StorageView } from '../../api/client';
import { Note, Section, said, type Said } from '../settings/Settings';
import { useSetupState } from './useSetup';
import { kindLabel, storageLines, urlProblem } from './words';
import '../settings/settings.css';
import './setup.css';

export function Storage({ go }: ScreenProps) {
  const data = useSetupState();
  const v = data.state?.storage;
  return (
    <div className="col-main setpage storagepage">
      <button type="button" className="backbtn keep" onClick={() => go('settings')}><Back />Settings</button>
      <header className="vh"><div className="vh-text"><p className="vh-kicker">Settings</p><h1>Where memory is kept</h1></div></header>
      {data.loading && <p className="empty">Loading…</p>}
      {data.error && <div className="card"><p>{data.error}</p><div className="acts"><button type="button" className="vbtn" onClick={() => void data.reload()}>Try again</button></div></div>}
      {!data.loading && !data.error && v && (
        <>
          {!data.admin && (
            <p className="card adminnote" role="note">This {data.me?.kind === 'device' ? 'phone' : 'device'} can see where memory is kept but not change it. Change it on your computer, or after signing in with your password.</p>
          )}
          <Section id="store-now" title="Now">
            <div className="card setcard">
              <div className="setrow col">
                <span className="rowtitle" id="store-now-line">{storageLines(v).now}</span>
                {storageLines(v).next && <span className="s warnline" id="store-next">{storageLines(v).next}</span>}
                {v.fixed && <span className="s">The server’s AWM_STORE_BACKEND setting chooses this, and it wins over a choice here. Change it there.</span>}
              </div>
            </div>
          </Section>
          {data.admin && !v.fixed && <Change v={v} data={data} />}
        </>
      )}
    </div>
  );
}

function Change({ v, data }: { v: StorageView; data: ReturnType<typeof useSetupState> }) {
  const [url, setUrl] = useState('');
  const [bring, setBring] = useState(true);
  const [ask, setAsk] = useState<'sqlite' | 'postgres' | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Said>(null);
  const nextIsLocal = v.next !== 'postgres';
  const go = async (kind: 'sqlite' | 'postgres') => {
    setBusy(true); setNote(kind === 'postgres' ? { text: bring ? 'Connecting and copying your memory…' : 'Connecting…', error: false } : null);
    const o = await data.saveStorage(kind, kind === 'postgres' ? url.trim() : undefined, kind === 'postgres' && bring);
    setBusy(false); setAsk(null);
    if (kind === 'postgres') setUrl(''); // never kept on screen once sent
    setNote(said(o));
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const p = urlProblem(url);
    if (p) { setNote({ text: p, error: true }); return; }
    setNote(null); setAsk('postgres');
  };
  return (
    <Section id="store-change" title="Change it">
      <div className="card setcard">
        <div className="setrow col">
          <span className="rowtitle">{kindLabel('sqlite', v.hosted, v.host)} <span className="s">· recommended</span></span>
          <span className="s">{v.hosted ? `A file on your ${v.host} deploy: private to it, no setup. It lasts across redeploys only on a mounted volume.` : 'Private, and nothing to set up. Most people should keep memory here.'}</span>
          {!nextIsLocal && ask !== 'sqlite' && <div className="acts"><button type="button" className="vbtn" disabled={busy} onClick={() => { setAsk('sqlite'); setNote(null); }}>Keep memory here</button></div>}
          {nextIsLocal && <span className="s okline">{v.restartNeeded ? 'Chosen for the next restart.' : 'In use.'}</span>}
        </div>
        <form className="setform" onSubmit={submit} aria-label="Use a database server">
          <span className="rowtitle">A database server <span className="s">· Postgres with pgvector</span></span>
          <span className="s">For an always-on, cloud or multi-device helper. Paste its connection address (on Railway, the Postgres service’s DATABASE_URL).</span>
          <label htmlFor="store-url">Connection address</label>
          <input id="store-url" className="setinput addrmono" type="password" autoComplete="off" spellCheck={false} value={url} placeholder="postgres://user:password@host:5432/database"
            onChange={(e) => setUrl(e.target.value)} aria-describedby="store-url-help" />
          <span className="s" id="store-url-help">It holds the database password, so it’s never shown again: I only show the server’s name.</span>
          <label className="checkrow"><input type="checkbox" checked={bring} onChange={(e) => setBring(e.target.checked)} /> Bring my memory over (copied first: if the copy fails, nothing switches)</label>
          {ask !== 'postgres' && <div className="acts"><button type="submit" className="vbtn vbtn-primary" disabled={busy}>Connect and use</button></div>}
        </form>
        {ask && (
          <div className="setrow col confirmask" role="group" aria-labelledby="store-ask">
            <span className="s" id="store-ask">{ask === 'postgres'
              ? `Keep memory on this database server from the next restart?${bring ? ' Your memory is copied there first.' : ' Your memory here isn’t copied: you’d start with what’s in the server.'}`
              : `Keep memory ${v.hosted ? `in a file on this ${v.host} deploy` : 'on this computer'} from the next restart? What’s in the database server stays there.`}</span>
            <div className="acts">
              <button type="button" className="vbtn vbtn-primary" disabled={busy} onClick={() => void go(ask)} autoFocus>{busy ? 'Working…' : 'Yes, from the next restart'}</button>
              <button type="button" className="vbtn vbtn-quiet" disabled={busy} onClick={() => setAsk(null)}>Cancel</button>
            </div>
          </div>
        )}
        <Note said={note} />
        <p className="s small">Changes take effect when your helper restarts.</p>
      </div>
    </Section>
  );
}
