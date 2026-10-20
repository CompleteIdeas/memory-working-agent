import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { chatStream, getSuggestions, getNotifications, type SpineStep, type ChatResult } from '../api';
import { Approvals } from './Approvals';
import { SetupCards } from './SetupCards';
import { ActivitySpine } from './ActivitySpine';

/** What an UNATTENDED (scheduled) run did. It has no live step spine — nobody streamed it — so the
 *  card shows these facts from the notification record instead. Absent on records written before
 *  2026-10-14, which carried only the summary. */
interface SchedFacts { steps: number; toolCalls: number; costUsd: number; files: string[]; reason: string; outcome?: string; completion?: string; }
interface Turn { id: number; user: string; steps: SpineStep[]; live: boolean; result?: ChatResult; error?: string; topicReset?: boolean; sched?: SchedFacts; }

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
  // Re-read pending approvals whenever a turn or a scheduled result lands (BL-03).
  const [approvalTick, setApprovalTick] = useState(0);
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
        result: {
          reason: n.reason ?? 'done', summary: n.summary, steps: n.steps ?? 0,
          dispatches: 0, toolCalls: n.toolCalls ?? 0, costUsd: n.costUsd ?? 0,
        } as ChatResult,
        // The card used to read `what I did · ${steps.length} steps` off a spine that a scheduled
        // run never has, so every autonomous run said "0 steps" — even one that did 7 steps and
        // wrote a file. Carry the record's facts so the card can show them.
        sched: n.steps === undefined ? undefined : {
          steps: n.steps, toolCalls: n.toolCalls ?? 0, costUsd: n.costUsd ?? 0,
          files: n.files ?? [], reason: n.reason ?? 'done', outcome: n.outcome, completion: n.completion,
        },
      }))]);
      seen = Math.max(seen, ...notes.map((n) => n.ts));
      setApprovalTick((x) => x + 1);
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
      onResult: (r) => { patch((tn) => ({ ...tn, live: false, result: r })); setApprovalTick((x) => x + 1); onActivity?.(); },
      onError: (m) => patch((tn) => ({ ...tn, live: false, error: m })),
      // Show a "new topic" marker only when we actually set aside an earlier conversation
      // (not on the first message of a session) — so the user understands the reset.
      onTopic: (tp) => { if (tp.relation === 'fresh' && tp.hadContext) patch((tn) => ({ ...tn, topicReset: true })); },
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
                {/* New-topic marker: MWA set aside the earlier conversation and started fresh.
                    Tells a non-technical user why it isn't carrying the previous thread. */}
                {tn.topicReset && (
                  <div className="flex items-center gap-2.5 mono text-[10.5px] text-dim mb-4 uppercase tracking-[0.16em]" title="This looked like a new request, so I started fresh. If it's about the earlier chat, just say so and I'll pick it back up.">
                    <span className="h-px flex-1 bg-line" />
                    <span className="whitespace-nowrap">↻ new topic · earlier chat set aside</span>
                    <span className="h-px flex-1 bg-line" />
                  </div>
                )}
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
                    {tn.sched ? (
                      // Unattended run: no spine to expand, so state the facts outright.
                      <div className="mono text-[11px] text-dim mt-2 break-words">
                        ran unattended · {tn.sched.steps} step{tn.sched.steps === 1 ? '' : 's'} · {tn.sched.toolCalls} tool call{tn.sched.toolCalls === 1 ? '' : 's'} · ${tn.sched.costUsd.toFixed(3)}
                        {tn.sched.reason !== 'done' && <span className="text-signal"> · stopped: {tn.sched.reason}</span>}
                        {tn.sched.outcome === 'could-not' && <span className="text-signal"> · couldn't finish</span>}
                        {tn.sched.outcome === 'no-change' && <span> · nothing new</span>}
                        {tn.sched.completion === 'candidate' && <span> · looks finished — confirming</span>}
                        {tn.sched.completion === 'stopped' && <span> · finished, job stopped</span>}
                        {tn.sched.outcome === 'blocked' && tn.sched.reason === 'done' && <span className="text-signal"> · needs you</span>}
                        {tn.sched.outcome === 'complete' && !tn.sched.completion && <span> · finished</span>}
                        {tn.sched.files.length
                          ? <span> · wrote {tn.sched.files.join(', ')}</span>
                          : <span> · no files</span>}
                      </div>
                    ) : (
                      <button onClick={() => toggleExpand(tn.id)} className="mono text-[11px] text-dim mt-2 underline hover:text-signal">
                        {expanded.has(tn.id) ? 'hide steps' : `what I did · ${tn.steps.length} steps`}
                      </button>
                    )}
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
        <SetupCards refresh={approvalTick} />
        <Approvals refresh={approvalTick} />
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
