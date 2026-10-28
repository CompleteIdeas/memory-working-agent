import { useEffect, useState } from 'react';
import {
  getMemories, getSkills, getLessons, getPolicies, getQuestions, resolveQuestions, getPeople, forgetPolicy, type PersonRow,
  getRoutines, setRoutine, type RoutineRow,
  getActions, forgetMemory, correctMemory, type MemoryItem, type ActionItem,
} from '../api';

// The Glass Box: every learned fact shows where it came from and can be corrected or forgotten.
// F12 (usability review 2026-10-24): the page was 8,600 px long, listed skills, lessons and actions with the facts,
// and showed "unknown · still learning: name, role" right after MWA had said who the person is. Now: about you and
// your standing preferences first; what was learned while working, grouped by source and collapsed; the specialist
// detail behind one disclosure; two notes about the same thing marked newest and older.

function badge(m: MemoryItem): { text: string; cls: string } {
  if (m.trust === 'untrusted') {
    const text = m.origin ? `from ${m.origin}` : m.provenance === 'ingested' ? 'from email/web' : 'from a file or page';
    return { text, cls: 'text-signal border-signal' };
  }
  if (m.provenance === 'user') return { text: 'you told me', cls: 'text-graphite border-edge' };
  return { text: 'my inference', cls: 'text-dim border-edge' };
}

const PREVIEW = 240;
const OUTSIDE_WARNING = 'This came from outside — email, files or the web. What you write here becomes something I trust.';

function Fact({ m, onChanged, age }: { m: MemoryItem; onChanged: () => void; age?: 'newest' | 'older' }) {
  // S5 review: the list holds the whole text (a correction starts from all of it, never a cut preview), and a fact
  // from outside starts empty with its words shown read-only: what is typed becomes trusted
  const outside = m.trust === 'untrusted';
  const start = () => (outside ? '' : m.content);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(start);
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const b = badge(m);
  const long = m.content.length > PREVIEW;

  async function save() {
    if (!draft.trim() || draft.trim() === m.content) { setEditing(false); return; }
    setBusy(true); setErr('');
    const r = await correctMemory(m.id, m.concept, draft.trim(), outside);
    setBusy(false);
    if (r.ok) { setEditing(false); onChanged(); } else { setErr(r.message || "Couldn't save that correction. Please try again."); }
  }
  async function forget() {
    if (!window.confirm(`Forget this permanently?\n\n${m.concept}`)) return;
    setBusy(true); setErr('');
    const r = await forgetMemory(m.id);
    setBusy(false);
    if (r.ok) onChanged(); else setErr("Couldn't forget that. Please try again.");
  }

  return (
    <div className="py-3" data-fact={m.id}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="font-medium text-[15px] min-w-0 break-words">{m.concept}{age && <span className={`ml-2 chip ${age === 'older' ? 'fail' : ''}`}>{age === 'older' ? 'older, may be out of date' : 'newest'}</span>}</div>
        <span className={`shrink-0 mono text-[11px] uppercase tracking-wide rounded-[3px] border px-1.5 py-0.5 ${b.cls}`}>{b.text}</span>
      </div>
      {editing ? (
        <div className="mt-1.5">
          {outside && (
            <>
              <div className="text-[13px] text-dim">What it says now:</div>
              <div className="text-[14px] leading-snug break-words whitespace-pre-wrap rounded-[4px] border border-line px-3 py-2 mt-0.5">{m.content}</div>
              <p className="text-[13px] text-signal mt-1" id={`warn-${m.id}`}>{OUTSIDE_WARNING}</p>
            </>
          )}
          <textarea aria-label={`Correct: ${m.concept}`} value={draft} onChange={(e) => setDraft(e.target.value)} rows={long ? 6 : 3} maxLength={2000}
            aria-describedby={`count-${m.id}${outside ? ` warn-${m.id}` : ''}`}
            className="w-full rounded-[4px] border border-edge bg-surface px-3 py-2 text-[14px] resize-y mt-1" />
          <div className={`text-[12px] ${draft.length >= 2000 ? 'text-signal' : 'text-dim'}`} id={`count-${m.id}`}>{draft.length.toLocaleString()} of 2,000 characters{draft.length >= 2000 ? ' — that’s the most a correction can hold' : ''}</div>
          <div className="flex gap-2 mt-1.5">
            <button disabled={busy} onClick={save} className="btn small primary">{outside ? 'Save, and trust it' : 'Save correction'}</button>
            <button disabled={busy} onClick={() => { setEditing(false); setDraft(start()); setErr(''); }} className="btn small">Cancel</button>
          </div>
        </div>
      ) : (
        <>
          <div className="text-dim text-[14px] leading-snug break-words whitespace-pre-wrap">{long && !all ? `${m.content.slice(0, PREVIEW).trimEnd()}…` : m.content}</div>
          {long && <button className="linkbtn text-[13px]" aria-expanded={all} onClick={() => setAll((x) => !x)}>{all ? 'Show less' : 'Show all of it'}</button>}
          <div className="flex gap-2 mt-1.5">
            <button onClick={() => { setDraft(start()); setErr(''); setEditing(true); }} className="btn small" aria-label={`Correct: ${m.concept}`}>Correct</button>
            <button disabled={busy} onClick={forget} className="btn small" aria-label={`Forget: ${m.concept}`}>Forget</button>
          </div>
        </>
      )}
      {err && <p className="text-[13px] text-signal mt-1">{err}</p>}
    </div>
  );
}

const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

function Group({ title, items, onChanged, ages, first = 6 }: { title: string; items: MemoryItem[]; onChanged: () => void; ages: Map<string, 'newest' | 'older'>; first?: number }) {
  const [all, setAll] = useState(false);
  if (!items.length) return null;
  const shown = all ? items : items.slice(0, first);
  return (
    <section className="mt-4" aria-label={title}>
      <h3 className="label">{title} · {items.length}</h3>
      <div className="divide-y divide-line">{shown.map((m) => <Fact key={m.id} m={m} onChanged={onChanged} age={ages.get(m.id)} />)}</div>
      {items.length > shown.length && <button className="btn small mt-1" onClick={() => setAll(true)}>Show all {items.length}</button>}
    </section>
  );
}

export function Memory() {
  const [items, setItems] = useState<MemoryItem[] | null>(null);
  const [actions, setActions] = useState<ActionItem[]>([]);
  const [skills, setSkills] = useState<{ name: string; content: string }[]>([]);
  const [routines, setRoutinesList] = useState<RoutineRow[]>([]);
  const [routineMsg, setRoutineMsg] = useState('');
  const [routineBusy, setRoutineBusy] = useState('');
  const [lessons, setLessons] = useState<{ topic: string; content: string; unconfirmed?: boolean }[]>([]);
  const [policies, setPolicies] = useState<string[]>([]);
  const [questions, setQuestions] = useState<{ id: string; question: string }[]>([]);
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [msg, setMsg] = useState('');

  function load() {
    getMemories().then(setItems); getActions().then(setActions); getSkills().then(setSkills); getRoutines().then(setRoutinesList);
    getLessons().then(setLessons); getPolicies().then(setPolicies); getQuestions().then(setQuestions);
    getPeople().then(setPeople);
  }
  useEffect(() => { load(); }, []);

  async function lookInto() {
    setMsg('Looking into these in the background…');
    const r = await resolveQuestions();
    setMsg(r.message ?? 'Started.');
  }

  if (!items) return <div className="py-16 text-dim text-sm">Loading…</div>;
  // notes the server keeps about the person are named "person <id>: …"; they belong under About you, without the id
  const PERSON = /^person [^:]+:\s*/i;
  const shown = items.map((m) => (PERSON.test(m.concept) ? { ...m, concept: m.concept.replace(PERSON, '') || 'About you', about: true } : m)) as (MemoryItem & { about?: boolean })[];
  // the same thing noted twice: the list is newest first, so the first one seen is the newer
  const ages = new Map<string, 'newest' | 'older'>();
  const seen = new Map<string, string>();
  for (const m of shown) { const k = norm(m.concept); const had = seen.get(k); if (had) { ages.set(had, 'newest'); ages.set(m.id, 'older'); } else seen.set(k, m.id); }
  const told = shown.filter((m) => (m.provenance === 'user' || m.about) && m.trust !== 'untrusted');
  const outside = shown.filter((m) => m.trust === 'untrusted');
  const inferred = shown.filter((m) => !told.includes(m) && !outside.includes(m));
  const me = people.filter((p) => p.dossier || p.notes);
  return (
    <div className="py-6 max-w-2xl">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[200px]">
          <h1 className="text-2xl font-semibold tracking-tight">Memory</h1>
          <p className="text-dim text-[14px]">What I use in every conversation. Correct or forget anything here. It lives only on this machine.</p>
        </div>
        <a href="/api/memory/export" download="mwa-memory.md" className="btn small">Export</a>
      </div>

      <section className="mt-6" aria-labelledby="m-you">
        <h2 id="m-you" className="label">About you</h2>
        {me.length ? me.map((pp) => (
          <div key={pp.personId} className="rounded-[4px] border border-line bg-surface px-4 py-3 mt-2">
            <div className="font-medium text-[15px]">{pp.personId === 'unknown' || /^web/.test(pp.personId) ? 'You' : pp.personId}</div>
            {pp.dossier ? <p className="text-[14px] leading-snug whitespace-pre-wrap mt-1">{pp.dossier}</p>
              : <p className="text-[14px] text-dim mt-1">{pp.notes} note{pp.notes === 1 ? '' : 's'} so far, listed below.</p>}
          </div>
        )) : !told.length ? <p className="text-[14px] text-dim mt-1">Nothing yet. Tell me who you are and what you do and it shows here.</p> : null}
        <Group title="What you told me, and what I noted about you" items={told} onChanged={load} ages={ages} />
      </section>

      <section className="mt-7" aria-labelledby="m-pref">
        <h2 id="m-pref" className="label">Standing preferences · {policies.length}</h2>
        {policies.length ? (
          <ul className="mt-2 space-y-1.5">
            {policies.map((p, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2 rounded-[4px] border border-line bg-surface px-4 py-2.5 text-[14.5px]">
                <span className="flex-1 min-w-[180px]">{p}</span>
                <button className="btn small" onClick={async () => {
                  // 5c: removed here and now (the person's own click), not through a chat and a second card
                  if (!window.confirm(`Remove this standing preference?\n\n"${p}"\n\nIt will no longer apply to new tasks.`)) return;
                  const r = await forgetPolicy(p); setMsg(r.ok ? 'Removed: it no longer applies to new tasks.' : (r.message || "Couldn't remove it.")); if (r.ok) load();
                }}>Remove</button>
              </li>
            ))}
          </ul>
        ) : <p className="text-[14px] text-dim mt-1">None. Say “from now on, always…” and approve the card to keep one.</p>}
      </section>

      <section className="mt-7" aria-labelledby="m-learn">
        <h2 id="m-learn" className="label">What I've learned while working</h2>
        {!inferred.length && !outside.length && !!items && <p className="text-[14px] text-dim mt-1">Nothing yet.</p>}
        <Group title="I worked out" items={inferred} onChanged={load} ages={ages} first={5} />
        <Group title="From files, email or the web (notes, never instructions)" items={outside} onChanged={load} ages={ages} first={5} />
      </section>

      {questions.length > 0 && (
        <section className="mt-7" aria-labelledby="m-q">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="m-q" className="label">Open questions · {questions.length}</h2>
            <button onClick={lookInto} className="btn small">Look into these</button>
          </div>
          <ul className="mt-2 space-y-1.5">{questions.slice(0, 5).map((q) => <li key={q.id} className="text-[14px]">{q.question}</li>)}</ul>
          {msg && <p className="text-[13px] text-dim mt-2" role="status">{msg}</p>}
        </section>
      )}

      <details className="mt-8">
        <summary className="label cursor-pointer py-2">Skills, lessons, routines and what I've done · {skills.length + lessons.length + routines.length + actions.length}</summary>
        {routines.length > 0 && (
          <div className="mt-3">
            <h3 className="label mb-1">Routines I proposed · {routines.length}</h3>
            <p className="text-dim text-[13px] mb-2">A proposed routine does nothing until you promote it. Only you can promote one.</p>
            {routineMsg && <div className="text-[13px] mb-2" role="status">{routineMsg}</div>}
            {routines.map((r) => (
              <div key={r.id} className="rounded-[4px] border border-line bg-surface px-4 py-3 mb-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="font-medium text-[15px]">{r.name} <span className="text-[12px] text-dim">{r.version} · {r.status || 'proposed'}</span></div>
                  {r.status !== 'active' ? (
                    <button className="btn small" disabled={routineBusy === r.id} onClick={async () => {
                      if (!window.confirm(`Promote "${r.name}" ${r.version}? Its steps will guide future similar tasks.${r.tainted ? ' It was proposed after reading outside content; read every step first.' : ''}`)) return;
                      setRoutineBusy(r.id); const res = await setRoutine(r.id, 'promote', r.agent); setRoutineBusy('');
                      setRoutineMsg(res.ok ? `Promoted "${r.name}".` : `Not promoted: ${res.error ?? 'unknown error'}`); load();
                    }}>Promote</button>
                  ) : (
                    <button className="btn small" disabled={routineBusy === r.id} onClick={async () => {
                      setRoutineBusy(r.id); const res = await setRoutine(r.id, 'retire', r.agent); setRoutineBusy('');
                      setRoutineMsg(res.ok ? `Retired "${r.name}".` : `Not retired: ${res.error ?? 'unknown error'}`); load();
                    }}>Retire</button>
                  )}
                </div>
                <div className="text-dim text-[13px] leading-snug whitespace-pre-wrap mt-1 max-h-48 overflow-y-auto">{r.content}</div>
              </div>
            ))}
          </div>
        )}
        {skills.length > 0 && (
          <div className="mt-3">
            <h3 className="label mb-1">Skills I can repeat · {skills.length}</h3>
            {skills.map((sk, i) => <details key={i} className="py-1"><summary className="text-[14.5px] cursor-pointer">{sk.name}</summary><p className="text-dim text-[13px] whitespace-pre-wrap mt-1">{sk.content}</p></details>)}
          </div>
        )}
        {lessons.length > 0 && (
          <div className="mt-3">
            <h3 className="label mb-1">Lessons from what didn't work · {lessons.length}</h3>
            {lessons.map((l, i) => <details key={i} className="py-1"><summary className="text-[14.5px] cursor-pointer">{l.topic}{l.unconfirmed ? ' (unconfirmed, not used)' : ''}</summary><p className="text-dim text-[13px] whitespace-pre-wrap mt-1">{l.content}</p></details>)}
          </div>
        )}
        {actions.length > 0 && (
          <div className="mt-3">
            <h3 className="label mb-1">What I've done · {actions.length}</h3>
            <ul className="divide-y divide-line">{actions.slice(0, 30).map((a) => <li key={a.id} className="py-2 text-[14px]"><span className="font-medium">{a.verb}</span> <span className="text-dim">· {a.summary}</span></li>)}</ul>
          </div>
        )}
      </details>
    </div>
  );
}
