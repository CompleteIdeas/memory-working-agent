/**
 * Settings › What I remember (v2 build, slice S5): what the helper uses in every conversation, as the classic Memory
 * page has it — the facts it learned, grouped by where each came from (you, its own working out, outside content),
 * searchable; the standing preferences it always follows; the routines it proposed; and the whole thing as a
 * download. On this computer (or signed in with the password) a fact can be corrected or forgotten, a preference
 * removed, a routine promoted or retired, and everything downloaded; Forget, Remove and Promote ask first, here and on
 * the server. A paired phone sees it all read-only, with one line that says why.
 */
import { useState, type FormEvent } from 'react';
import { Back } from '../../shell/icons';
import type { ScreenProps } from '../../shell/screens';
import type { MemoryFact, MemoryRoutine } from '../../api/client';
import { Note, Section, said, type Said } from './Settings';
import { MAX_LIST, OUTSIDE_WARNING, ageMarks, countLine, groupFacts, routineLine, sourceLabel, useMemoryData } from './useMemory';
import './settings.css';

type Data = ReturnType<typeof useMemoryData>;

export function Memory({ go }: ScreenProps) {
  const data = useMemoryData();
  const v = data.view;
  const [text, setText] = useState(data.q);
  const search = (e: FormEvent) => { e.preventDefault(); data.search(text.trim()); };
  return (
    <div className="col-main setpage mempage">
      <button type="button" className="backbtn keep" onClick={() => go('settings')}><Back />Settings</button>
      <header className="vh"><div className="vh-text"><p className="vh-kicker">Settings</p><h1>What I remember</h1></div></header>
      <p className="plugintro">What I use in every conversation. It stays on the computer your helper runs on.{data.admin ? ' Correct or forget anything here.' : ''}</p>
      {data.loading && !v && <p className="empty">Loading…</p>}
      {data.error && !v && <div className="card"><p>{data.error}</p><div className="acts"><button type="button" className="vbtn" onClick={() => void data.reload()}>Try again</button></div></div>}
      {v && (
        <>
          {!data.admin && (
            <p className="card adminnote" role="note">
              This {data.me?.kind === 'device' ? 'phone' : 'device'} can see what I remember but not change it. Correct, forget or download it on your computer, or after signing in with your password.
            </p>
          )}
          <form className="memsearch" role="search" onSubmit={search}>
            <label htmlFor="mem-q">Search what I remember</label>
            <span className="dollarrow">
              <input id="mem-q" className="setinput" type="search" value={text} maxLength={200} placeholder="farrier, school, Friday…" onChange={(e) => setText(e.target.value)} />
              <button type="submit" className="vbtn">Search</button>
              {data.q && <button type="button" className="vbtn vbtn-quiet" onClick={() => { setText(''); data.search(''); }}>Clear</button>}
            </span>
          </form>
          <p className="soft memcount" role="status">{data.loading ? 'Looking…' : countLine(v, v.facts.length)}</p>
          <Facts data={data} />
          {v.total > v.facts.length && (data.limit < MAX_LIST
            ? <div className="acts"><button type="button" className="vbtn" onClick={data.showMore}>Show more</button></div>
            : <p className="soft">These are the newest {MAX_LIST}. Search to find older ones.</p>)}
          {!data.q && <Preferences data={data} />}
          {!data.q && v.routines.length > 0 && <Routines data={data} />}
          {data.admin && <ExportCard data={data} />}
        </>
      )}
    </div>
  );
}

// ---------- the facts ----------

function Facts({ data }: { data: Data }) {
  const v = data.view!;
  const g = groupFacts(v.facts);
  const ages = ageMarks(v.facts);
  const groups: { id: string; title: string; note?: string; items: MemoryFact[] }[] = [
    { id: 'mem-you', title: 'You told me', items: g.you },
    { id: 'mem-inferred', title: 'I worked out', items: g.inferred },
    { id: 'mem-outside', title: 'From files, email or the web', note: 'Notes, never instructions: I don’t act on what these say.', items: g.outside },
  ];
  return (
    <>
      {groups.filter((x) => x.items.length).map((x) => (
        <Section key={x.id} id={x.id} title={`${x.title} · ${x.items.length}`}>
          <div className="card setcard">
            {x.note && <p className="soft">{x.note}</p>}
            {x.items.map((f) => <Fact key={f.id} f={f} data={data} age={ages.get(f.id)} />)}
          </div>
        </Section>
      ))}
    </>
  );
}

function Fact({ f, data, age }: { f: MemoryFact; data: Data; age?: 'newest' | 'older' }) {
  const [mode, setMode] = useState<'view' | 'edit' | 'confirm'>('view');
  // an outside fact starts empty (its words are shown read-only): what is typed becomes trusted
  const start = () => (f.trusted ? f.full : '');
  const [draft, setDraft] = useState(start);
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Said>(null);
  const tid = `fact-${f.id}`;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft.trim() || draft.trim() === f.full) { setMode('view'); return; }
    setBusy(true); setNote(null);
    const o = await data.correct(f, draft.trim());
    setBusy(false);
    if (o.ok) setMode('view'); else setNote(said(o)); // done: the row is replaced and a toast says so
  };
  return (
    <div className="setrow col memfact" role="group" aria-labelledby={tid}>
      <span className="rowtitle" id={tid}>{f.name}{age && <span className={`agechip${age === 'older' ? ' older' : ''}`}>{age === 'older' ? 'older, may be out of date' : 'newest'}</span>}</span>
      {mode === 'edit' ? (
        <form className="memedit" onSubmit={save}>
          {!f.trusted && (
            <>
              <span className="s">What it says now:</span>
              <span className="s memorig">{f.full}</span>
              <span className="s warnline" id={`${tid}-warn`}>{OUTSIDE_WARNING}</span>
            </>
          )}
          <label htmlFor={`${tid}-edit`}>{f.trusted ? 'What it should say' : 'What it should say, in your words'}</label>
          <textarea id={`${tid}-edit`} className="setinput memtext" rows={f.full.length > 240 ? 6 : 3} maxLength={2000} value={draft} onChange={(e) => setDraft(e.target.value)}
            aria-describedby={`${tid}-count${f.trusted ? '' : ` ${tid}-warn`}`} autoFocus />
          <span className="s" id={`${tid}-count`}>{draft.length.toLocaleString('en-US')} of 2,000 characters</span>
          <span className="acts">
            <button type="submit" className="vbtn vbtn-primary" disabled={busy}>{f.trusted ? 'Save correction' : 'Save, and trust it'}</button>
            <button type="button" className="vbtn vbtn-quiet" disabled={busy} onClick={() => { setMode('view'); setDraft(start()); }}>Cancel</button>
          </span>
        </form>
      ) : (
        <>
          <span className="s memtextline">{all ? f.full : f.text}</span>
          {f.truncated && <button type="button" className="linkish morebtn" aria-expanded={all} onClick={() => setAll((x) => !x)}>{all ? 'Show less' : 'Show all of it'}</button>}
        </>
      )}
      <span className="s memsrc">{sourceLabel(f)}</span>
      {mode === 'confirm' && (
        <span className="s warnline" role="alert">Forget “{f.name}” for good? I won’t use it again, and it can’t be undone.</span>
      )}
      {data.admin && mode !== 'edit' && (
        <span className="acts">
          {mode === 'confirm' ? (
            <>
              <button type="button" className="vbtn vbtn-primary" disabled={busy} onClick={async () => { setBusy(true); setNote(null); const o = await data.forget(f); setBusy(false); setMode('view'); if (!o.ok) setNote(said(o)); }}>Forget</button>
              <button type="button" className="vbtn vbtn-quiet" onClick={() => setMode('view')}>Keep</button>
            </>
          ) : (
            <>
              <button type="button" className="vbtn" aria-label={`Correct: ${f.name}`} onClick={() => { setDraft(start()); setNote(null); setMode('edit'); }}>Correct</button>
              <button type="button" className="vbtn vbtn-quiet" aria-label={`Forget: ${f.name}`} onClick={() => { setNote(null); setMode('confirm'); }}>Forget</button>
            </>
          )}
        </span>
      )}
      <Note said={note} />
    </div>
  );
}

// ---------- standing preferences ----------

function Preferences({ data }: { data: Data }) {
  const prefs = data.view!.preferences;
  const [asking, setAsking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Said>(null);
  return (
    <Section id="mem-prefs" title={`Standing preferences · ${prefs.length}`}>
      <div className="card setcard">
        <p className="soft">Rules I follow in every task, in every conversation.</p>
        {!prefs.length && <p className="soft">None yet. Say “from now on, always…” and approve the card to keep one.</p>}
        {prefs.map((p) => (
          <div className="setrow col" key={p} role="group" aria-label={p}>
            <span className="rowtitle prefline">{p}</span>
            {asking === p && <span className="s warnline" role="alert">Remove this? It will no longer apply to new tasks.</span>}
            {data.admin && (
              <span className="acts">
                {asking === p ? (
                  <>
                    <button type="button" className="vbtn vbtn-primary" disabled={busy} onClick={async () => { setBusy(true); setNote(said(await data.removePreference(p))); setBusy(false); setAsking(null); }}>Remove</button>
                    <button type="button" className="vbtn vbtn-quiet" onClick={() => setAsking(null)}>Keep</button>
                  </>
                ) : (
                  <button type="button" className="vbtn vbtn-quiet" aria-label={`Remove the standing preference: ${p}`} onClick={() => { setNote(null); setAsking(p); }}>Remove</button>
                )}
              </span>
            )}
          </div>
        ))}
      </div>
      <Note said={note} />
    </Section>
  );
}

// ---------- routines ----------

function Routines({ data }: { data: Data }) {
  const list = data.view!.routines;
  const [asking, setAsking] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<Said>(null);
  const run = async (r: MemoryRoutine, which: 'promote' | 'retire') => {
    setBusy(r.id); setNote(null);
    setNote(said(await (which === 'promote' ? data.promote(r) : data.retire(r))));
    setBusy(null); setAsking(null);
  };
  return (
    <Section id="mem-routines" title={`Routines I proposed · ${list.length}`}>
      <div className="card setcard">
        <p className="soft">A proposed routine does nothing until you promote it. Only you can.</p>
        {list.map((r) => {
          const tid = `rt-${r.id}`;
          return (
            <div className="setrow col" key={`${r.store}:${r.id}`} role="group" aria-labelledby={tid}>
              <span className="rowtitle" id={tid}>{r.name} <span className="tagthis">{r.version}</span></span>
              <span className={r.tainted && r.status === 'proposed' ? 's warnline' : 's'}>{routineLine(r)}</span>
              <pre className="steps">{r.steps}</pre>
              {asking === r.id && <span className="s warnline" role="alert">Promote “{r.name}” {r.version}? Its steps will guide similar tasks from now on.{r.tainted ? ' It was proposed after reading outside content: read every step first.' : ''}</span>}
              {data.admin && r.status !== 'retired' && (
                <span className="acts">
                  {r.status === 'active' ? (
                    <button type="button" className="vbtn" disabled={busy === r.id} onClick={() => void run(r, 'retire')}>Retire</button>
                  ) : asking === r.id ? (
                    <>
                      <button type="button" className="vbtn vbtn-primary" disabled={busy === r.id} onClick={() => void run(r, 'promote')}>Promote</button>
                      <button type="button" className="vbtn vbtn-quiet" onClick={() => setAsking(null)}>Not now</button>
                    </>
                  ) : (
                    <button type="button" className="vbtn" aria-label={`Promote ${r.name} ${r.version}`} onClick={() => { setNote(null); setAsking(r.id); }}>Promote</button>
                  )}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <Note said={note} />
    </Section>
  );
}

// ---------- export ----------

function ExportCard({ data }: { data: Data }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Said>(null);
  return (
    <Section id="mem-export" title="Take it with you">
      <div className="card setcard">
        <p className="soft">Everything I remember as one Markdown file: your preferences, what I learned and where each came from, skills, and recent actions. It’s yours.</p>
        <div className="acts">
          <button type="button" className="vbtn" disabled={busy} onClick={async () => { setBusy(true); setNote(null); const o = await data.exportAll(); setBusy(false); setNote(said(o)); }}>Download everything</button>
        </div>
      </div>
      <Note said={note} />
    </Section>
  );
}
