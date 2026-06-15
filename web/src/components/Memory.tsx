import { useEffect, useState } from 'react';
import { getMemories, getSkills, getQuestions, resolveQuestions } from '../api';

// Makes the substrate tangible: open questions it wants answered (the self-learning loop),
// reusable routines (skills), and the facts it has learned.
export function Memory() {
  const [items, setItems] = useState<{ id: string; concept: string; content: string }[] | null>(null);
  const [skills, setSkills] = useState<{ name: string; content: string }[]>([]);
  const [questions, setQuestions] = useState<{ id: string; question: string }[]>([]);
  const [msg, setMsg] = useState('');

  function load() { getMemories().then(setItems); getSkills().then(setSkills); getQuestions().then(setQuestions); }
  useEffect(() => { load(); }, []);

  async function lookInto() {
    setMsg('Looking into these in the background…');
    const r = await resolveQuestions();
    setMsg(r.message ?? 'Started.');
  }

  if (!items) return <div className="py-16 mono text-dim text-sm">loading…</div>;
  return (
    <div className="py-8 max-w-2xl space-y-8">
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

      <div>
        <div className="mono text-[11px] text-dim uppercase tracking-[0.2em] mb-3">what I've learned · {items.length} recent</div>
        {items.length === 0 ? (
          <p className="text-dim">Nothing yet. Ask me to look at your email or scan your inbox, and what I learn shows up here.</p>
        ) : (
          <div className="divide-y divide-line">
            {items.map((m) => (
              <div key={m.id} className="py-3">
                <div className="font-medium text-[15px]">{m.concept}</div>
                <div className="text-dim text-[14px] leading-snug">{m.content}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
