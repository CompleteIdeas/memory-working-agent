import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { chatStream, getSuggestions, getNotifications, type SpineStep, type ChatResult } from '../api';
import { ActivitySpine } from './ActivitySpine';

interface Turn { id: number; user: string; steps: SpineStep[]; live: boolean; result?: ChatResult; error?: string; }

function sessionId(): string {
  let s = localStorage.getItem('mwa-session');
  if (!s) { s = 'web-' + Math.random().toString(36).slice(2, 9); localStorage.setItem('mwa-session', s); }
  return s;
}

export function Chat({ onActivity }: { onActivity?: () => void }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggleExpand = (id: number) => setExpanded((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const session = useRef(sessionId());
  const feedEnd = useRef<HTMLDivElement>(null);

  useEffect(() => { getSuggestions().then(setSuggestions); }, []);

  // Proactive delivery: surface fired scheduled-task results in the chat (on open + every 20s).
  useEffect(() => {
    let seen = Number(localStorage.getItem('mwa-notify-seen') ?? 0);
    const check = async () => {
      const notes = await getNotifications(seen);
      if (!notes.length) return;
      setTurns((prev) => [...prev, ...notes.map((n) => ({
        id: n.ts, user: `⏰ Scheduled · ${n.instruction}`, steps: [] as SpineStep[], live: false,
        result: { reason: 'done', summary: n.summary, steps: 0, dispatches: 0, toolCalls: 0, costUsd: 0 } as ChatResult,
      }))]);
      seen = Math.max(seen, ...notes.map((n) => n.ts));
      localStorage.setItem('mwa-notify-seen', String(seen));
    };
    check();
    const iv = setInterval(check, 20000);
    return () => clearInterval(iv);
  }, []);
  useEffect(() => { feedEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [turns]);

  function send(text: string) {
    const t = text.trim();
    if (!t) return;
    setInput('');
    const id = Date.now();
    setTurns((prev) => [...prev, { id, user: t, steps: [], live: true }]);
    let stepId = 0;
    const patch = (fn: (turn: Turn) => Turn) => setTurns((prev) => prev.map((tn) => (tn.id === id ? fn(tn) : tn)));
    chatStream(t, session.current, {
      onStep: (s) => patch((tn) => ({ ...tn, steps: [...tn.steps, { ...s, id: stepId++ }] })),
      onResult: (r) => { patch((tn) => ({ ...tn, live: false, result: r })); onActivity?.(); },
      onError: (m) => patch((tn) => ({ ...tn, live: false, error: m })),
    });
  }

  const empty = turns.length === 0;

  return (
    <div className="flex flex-col min-h-[calc(100vh-61px)]">
      <div className="flex-1 py-8">
        {empty ? (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }}>
            <div className="mono text-[11px] text-dim uppercase tracking-[0.2em] mb-3">ready</div>
            <h2 className="text-3xl sm:text-[34px] font-semibold tracking-tight leading-[1.08] mb-2">What can I help you with?</h2>
            <p className="text-dim mb-7 max-w-lg">Ask in plain words. You'll watch me remember, look things up, and do the work.</p>
            <div className="flex flex-wrap gap-2">
              {suggestions.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="rounded-[3px] border border-line bg-surface px-3.5 py-2 text-[14px] hover:border-signal hover:text-signal transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          </motion.div>
        ) : (
          <div className="divide-y divide-line">
            {turns.map((tn) => (
              <div key={tn.id} className="py-5 first:pt-0">
                <div className="flex gap-2 items-baseline mb-3">
                  <span className="mono text-[11px] text-signal mt-0.5">YOU</span>
                  <span className="text-[15.5px] leading-snug">{tn.user}</span>
                </div>
                {/* While working: a compact one-line indicator, not the full step list. */}
                {tn.live && (
                  <div className="flex items-center gap-2 mono text-[13px] text-dim">
                    <motion.span className="inline-block w-[7px] h-[14px] bg-signal translate-y-[2px]" animate={{ opacity: [1, 0.2, 1] }} transition={{ repeat: Infinity, duration: 1 }} />
                    <span>{tn.steps.length ? tn.steps[tn.steps.length - 1].label : 'Working'}…</span>
                    <button onClick={() => toggleExpand(tn.id)} className="underline hover:text-signal ml-1">{expanded.has(tn.id) ? 'hide' : 'details'}</button>
                  </div>
                )}
                {tn.result && (
                  <motion.div
                    initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}
                    className="mt-1 border-l-2 border-signal pl-3"
                  >
                    <div className="mono text-[11px] text-dim mb-1">MWA</div>
                    <p className="text-[15.5px] leading-relaxed whitespace-pre-wrap">{tn.result.summary}</p>
                    <button onClick={() => toggleExpand(tn.id)} className="mono text-[11px] text-dim mt-2 underline hover:text-signal">
                      {expanded.has(tn.id) ? 'hide steps' : `what I did · ${tn.steps.length} steps`}
                    </button>
                  </motion.div>
                )}
                {/* Collapsible full timeline (hidden by default in this interactive view). */}
                {expanded.has(tn.id) && (
                  <div className="mt-2 pl-1 border-l border-line">
                    <ActivitySpine steps={tn.steps} live={false} />
                  </div>
                )}
                {tn.error && <div className="mt-3 mono text-[13px] text-signal">! {tn.error}</div>}
              </div>
            ))}
          </div>
        )}
        <div ref={feedEnd} />
      </div>

      <div className="sticky bottom-0 bg-bone/95 backdrop-blur py-4 -mx-4 px-4 sm:-mx-6 sm:px-6 border-t border-line">
        <div className="flex gap-2 max-w-3xl mx-auto">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); send(input); } }}
            placeholder="Type a request…"
            className="flex-1 rounded-[3px] border border-line bg-surface px-4 py-3 text-[15px] outline-none focus:border-signal transition-colors"
          />
          <button onClick={() => send(input)} aria-label="Send" className="rounded-[3px] bg-signal text-white px-5 text-lg font-medium hover:opacity-90 transition-opacity">→</button>
        </div>
      </div>
    </div>
  );
}
