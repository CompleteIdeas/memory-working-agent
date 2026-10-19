import { useEffect, useState } from 'react';
import {
  getMemories, getSkills, getLessons, getPolicies, getQuestions, resolveQuestions, getPeople, type PersonRow,
  getRoutines, setRoutine, type RoutineRow,
  getActions, forgetMemory, correctMemory, type MemoryItem, type ActionItem,
} from '../api';

// The Glass Box: makes the substrate tangible AND controllable — every learned fact shows
// where it came from + how much it's trusted, and you can correct it, forget it, or export
// everything. Plus the self-learning loop (open questions), reusable routines (skills), and
// what MWA has actually done (the action history).

// Provenance/trust badge — the heart of "consider the source".
function badge(m: MemoryItem): { text: string; cls: string } {
  if (m.trust === 'untrusted') {
    const text = m.origin ? `⚠ from ${m.origin}` : m.provenance === 'ingested' ? '⚠ from email/web' : '⚠ unverified source';
    return { text, cls: 'text-signal border-signal/40' };
  }
  if (m.provenance === 'user') return { text: 'you told me', cls: 'text-ink border-line' };
  return { text: 'my inference', cls: 'text-dim border-line' };
}

function Fact({ m, onChanged }: { m: MemoryItem; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.content);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const b = badge(m);

  async function save() {
    if (!draft.trim() || draft.trim() === m.content) { setEditing(false); return; }
    setBusy(true); setErr('');
    const r = await correctMemory(m.id, m.concept, draft.trim());
    setBusy(false);
    if (r.ok) { setEditing(false); onChanged(); } else { setErr("Couldn't save that correction — please try again."); }
  }
  async function forget() {
    if (!window.confirm(`Forget this permanently?\n\n${m.concept}`)) return;
    setBusy(true); setErr('');
    const r = await forgetMemory(m.id);
    setBusy(false);
    if (r.ok) onChanged(); else setErr("Couldn't forget that — please try again.");
  }

  // Reveal the correct/forget controls on hover, keyboard focus, AND on touch devices (which have
  // no hover) — otherwise these core actions are invisible/untappable for non-mouse users.
  const controls = 'flex gap-3 mt-1.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity';
  const ctlBtn = 'mono text-[11px] uppercase tracking-wide text-dim hover:text-signal rounded-[3px] px-2 py-1.5 -mx-1';

  return (
    <div className="py-3 group">
      <div className="flex items-start justify-between gap-3">
        <div className="font-medium text-[15px]">{m.concept}</div>
        <span className={`shrink-0 mono text-[9.5px] uppercase tracking-wide rounded-[3px] border px-1.5 py-0.5 ${b.cls}`}>{b.text}</span>
      </div>
      {editing ? (
        <div className="mt-1.5">
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3}
            className="w-full rounded-[4px] border border-line bg-surface px-3 py-2 text-[14px] resize-y" />
          <div className="flex gap-2 mt-1.5">
            <button disabled={busy} onClick={save} className="mono text-[11px] uppercase tracking-wide rounded-[3px] border border-line px-3 py-1.5 hover:border-signal hover:text-signal transition-colors">save correction</button>
            <button disabled={busy} onClick={() => { setEditing(false); setDraft(m.content); setErr(''); }} className="mono text-[11px] uppercase tracking-wide text-dim px-3 py-1.5 hover:text-ink">cancel</button>
          </div>
        </div>
      ) : (
        <>
          <div className="text-dim text-[14px] leading-snug">{m.content}</div>
          <div className={controls}>
            <button onClick={() => { setDraft(m.content); setErr(''); setEditing(true); }} className={ctlBtn}>correct</button>
            <button disabled={busy} onClick={forget} className={ctlBtn}>forget</button>
          </div>
        </>
      )}
      {err && <p className="mono text-[11px] text-signal mt-1">{err}</p>}
    </div>
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

  if (!items) return <div className="py-16 mono text-dim text-sm">loading…</div>;
  return (
    <div className="py-8 max-w-2xl space-y-8">
      {policies.length > 0 && (
        <div>
          <div className="mono text-[11px] text-dim uppercase tracking-[0.2em] mb-3">preferences I'll always follow · {policies.length}</div>
          <div className="space-y-1.5">
            {policies.map((p, i) => (
              <div key={i} className="rounded-[4px] border border-line bg-surface px-4 py-2.5 text-[14px]">{p}</div>
            ))}
          </div>
        </div>
      )}

      {questions.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <div className="mono text-[11px] text-dim uppercase tracking-[0.2em]">open questions · {questions.length}</div>
            <button onClick={lookInto} className="mono text-[11px] uppercase tracking-wide rounded-[3px] border border-line px-3 py-1.5 hover:border-signal hover:text-signal transition-colors">look into these</button>
          </div>
          <div className="space-y-1.5">
            {questions.map((q) => (
              <div key={q.id} className="rounded-[4px] border border-line bg-surface px-4 py-2.5 text-[14px]">{q.question}</div>
            ))}
          </div>
          {msg && <p className="mono text-[12px] text-dim mt-2">{msg}</p>}
        </div>
      )}

      {people.length > 0 && (
        <div>
          <div className="mono text-[11px] text-dim uppercase tracking-[0.2em] mb-3">people I know · {people.length}</div>
          <div className="space-y-2">
            {people.map((pp) => (
              <div key={pp.personId} className="rounded-[4px] border border-line bg-surface px-4 py-3">
                <div className="flex items-center justify-between">
                  <div className="font-medium text-[15px]">{pp.personId}</div>
                  <div className="mono text-[11px] text-dim">{pp.notes} note{pp.notes === 1 ? '' : 's'}</div>
                </div>
                {pp.dossier && <div className="text-dim text-[13px] leading-snug whitespace-pre-wrap mt-1.5">{pp.dossier}</div>}
                <div className="mono text-[11px] text-dim mt-2">
                  {pp.fields.length > 0 && <span>known: {pp.fields.join(', ')}</span>}
                  {pp.missing.length > 0 && <span className="text-dim/70">{pp.fields.length ? '  ·  ' : ''}still learning: {pp.missing.join(', ')}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {routines.length > 0 && (
        <div>
          <div className="mono text-[11px] text-dim uppercase tracking-[0.2em] mb-1">routines I proposed · {routines.length}</div>
          <p className="text-dim text-[13px] mb-3">
            A proposed routine does nothing until you promote it. Promoted, its steps become a skill I use on similar tasks.
            Only you can promote one; I can't.
          </p>
          {routineMsg && <div className="text-[13px] mb-2" role="status">{routineMsg}</div>}
          <div className="space-y-2">
            {routines.map((r) => (
              <div key={r.id} className="rounded-[4px] border border-line bg-surface px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="font-medium text-[15px]">{r.name} <span className="mono text-[11px] text-dim">{r.version} · {r.status || 'proposed'}{r.agent && r.agent !== 'mwa-serve' ? ' · from Telegram' : ''}</span></div>
                  <div className="flex gap-2">
                    {r.status !== 'active' && (
                      <button className="mono text-[12px] underline disabled:opacity-50" disabled={routineBusy === r.id} onClick={async () => {
                        const warn = r.tainted ? '\n\nThis was proposed by a run that had read outside content (an email, a web page or a document). Read every step before you promote it.' : '';
                        if (!window.confirm(`Promote "${r.name}" ${r.version}? Its steps will guide future similar tasks.${warn}`)) return;
                        setRoutineBusy(r.id);
                        const res = await setRoutine(r.id, 'promote', r.agent);
                        setRoutineBusy('');
                        setRoutineMsg(res.ok ? `Promoted "${r.name}" ${r.version}.` : `Not promoted: ${res.error ?? 'unknown error'}`);
                        getRoutines().then(setRoutinesList); getSkills().then(setSkills);
                      }}>promote</button>
                    )}
                    {r.status === 'active' && (
                      <button className="mono text-[12px] underline disabled:opacity-50" disabled={routineBusy === r.id} onClick={async () => {
                        setRoutineBusy(r.id);
                        const res = await setRoutine(r.id, 'retire', r.agent);
                        setRoutineBusy('');
                        setRoutineMsg(res.ok ? `Retired "${r.name}" ${r.version}.` : `Not retired: ${res.error ?? 'unknown error'}`);
                        getRoutines().then(setRoutinesList); getSkills().then(setSkills);
                      }}>retire</button>
                    )}
                  </div>
                </div>
                {r.tainted && <div className="text-[12px] mt-1" role="note">⚠ Proposed by a run that had read outside content — read every step before promoting.</div>}
                <div className="text-dim text-[13px] leading-snug whitespace-pre-wrap mt-1 max-h-64 overflow-y-auto">{r.content}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {skills.length > 0 && (
        <div>
          <div className="mono text-[11px] text-dim uppercase tracking-[0.2em] mb-3">skills I can repeat · {skills.length}</div>
          <div className="space-y-2">
            {skills.map((s, i) => (
              <div key={i} className="rounded-[4px] border border-line bg-surface px-4 py-3">
                <div className="font-medium text-[15px]">{s.name}</div>
                <div className="text-dim text-[13px] leading-snug whitespace-pre-wrap">{s.content}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {lessons.length > 0 && (
        <div>
          <div className="mono text-[11px] text-dim uppercase tracking-[0.2em] mb-3">lessons from what didn't work · {lessons.length}</div>
          <div className="space-y-2">
            {lessons.map((l, i) => (
              <div key={i} className="rounded-[4px] border border-line bg-surface px-4 py-3">
                <div className="font-medium text-[15px]">{l.topic}{l.unconfirmed && <span className="mono text-[11px] text-dim ml-2" title="Kept, but not used in runs: it was written after a safety check refused something, or the lesson check could not clear it.">unconfirmed — not used</span>}</div>
                <div className="text-dim text-[13px] leading-snug whitespace-pre-wrap">{l.content}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {actions.length > 0 && (
        <div>
          <div className="mono text-[11px] text-dim uppercase tracking-[0.2em] mb-3">what I've done · {actions.length}</div>
          <div className="divide-y divide-line">
            {actions.map((a) => (
              <div key={a.id} className="py-2.5 flex items-start justify-between gap-3">
                <div>
                  <div className="text-[14px]"><span className="font-medium">{a.verb}</span> <span className="text-dim">— {a.summary}</span></div>
                </div>
                <span className="shrink-0 mono text-[9.5px] uppercase tracking-wide text-dim border border-line rounded-[3px] px-1.5 py-0.5">{a.effect}{a.tool ? ` · ${a.tool}` : ''}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="flex items-center justify-between mb-3">
          <div className="mono text-[11px] text-dim uppercase tracking-[0.2em]">what I've learned · {items.length} recent</div>
          <a href="/api/memory/export" download="mwa-memory.md" className="mono text-[11px] uppercase tracking-wide rounded-[3px] border border-line px-3 py-1.5 hover:border-signal hover:text-signal transition-colors">export ↓</a>
        </div>
        {items.length === 0 ? (
          <p className="text-dim">Nothing yet. Ask me to look at your email or scan your inbox, and what I learn shows up here.</p>
        ) : (
          <div className="divide-y divide-line">
            {items.map((m) => <Fact key={m.id} m={m} onChanged={load} />)}
          </div>
        )}
        <p className="mono text-[11px] text-dim mt-4 leading-relaxed">Everything here lives only on your machine. <span className="text-signal">⚠ from email/web</span> means I saw it in your inbox or online — I treat those as notes to consider, never as instructions to act on.</p>
      </div>
    </div>
  );
}
