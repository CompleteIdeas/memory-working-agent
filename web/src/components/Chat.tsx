import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { chatStream, getSuggestions, getNotifications, uploadFile, sessionFolder, fileUrl, startWork, getConversation, getConversations, getWelcome, openConversation, type SpineStep, type ChatResult, type ConversationTurn, type ConversationSummary, type Welcome } from '../api';
import { Markdown, openFile } from './Markdown';
import { Approvals } from './Approvals';
import { SetupCards } from './SetupCards';
import { ActivitySpine } from './ActivitySpine';

/** What an UNATTENDED (scheduled) run did. It has no live step spine — nobody streamed it — so the
 *  card shows these facts from the notification record instead. Absent on records written before
 *  2026-10-14, which carried only the summary. */
interface SchedFacts { steps: number; toolCalls: number; costUsd: number; files: string[]; reason: string; outcome?: string; completion?: string; }
/** folder: where the turn's files live, relative to the workspace (BL-70), so its links open them. */
interface Turn { id: number; user: string; steps: SpineStep[]; live: boolean; result?: ChatResult; error?: string; topicReset?: boolean; sched?: SchedFacts; folder?: string; note?: boolean;
  /** BL-71b: what became of an offer to work in the background */
  offerState?: 'sending' | 'started' | 'declined' | 'failed'; offerReply?: string; }

const newSessionId = () => 'web-' + Math.random().toString(36).slice(2, 9);
function sessionId(): string {
  let s = localStorage.getItem('mwa-session');
  if (!s) { s = newSessionId(); localStorage.setItem('mwa-session', s); }
  return s;
}

/** BL-71d: a kept turn, shown again when the conversation is reopened (here or on another device). */
function restoredTurn(t: ConversationTurn): Turn {
  return {
    id: t.ts, user: t.kind === 'result' ? `⏰ ${t.message}` : t.message, steps: [], live: false, folder: sessionFolder(t.session), note: t.kind !== 'chat',
    result: { reason: t.reason ?? 'done', summary: t.reply, steps: 0, dispatches: 0, toolCalls: 0, costUsd: 0 },
  };
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

  // BL-71d: conversations kept on the server — reopen this one on load, list the rest, start a new one.
  const [convs, setConvs] = useState<ConversationSummary[]>([]);
  const [showConvs, setShowConvs] = useState(false);
  const [elsewhere, setElsewhere] = useState<{ session: string; title: string }[]>([]);
  const loadedThrough = useRef(0);
  // BL-71e: back after a while — what moved meanwhile. Shown once per return, dismissable.
  const [welcome, setWelcome] = useState<Welcome | null>(null);
  useEffect(() => {
    // Away = the page was hidden or closed, not just idle in a background tab (BL-71e review).
    const read = () => { try { return Number(localStorage.getItem('mwa-last-seen') ?? 0); } catch { return 0; } };
    const mark = () => { try { localStorage.setItem('mwa-last-seen', String(Date.now())); } catch { /* */ } };
    const check = () => {
      const last = read();
      if (last && Date.now() - last > 2 * 3_600_000) void getWelcome(last).then((w) => { if (w && (w.results.length || w.goals.length || w.thoughts.length || w.approvals)) setWelcome(w); });
      mark();
    };
    check();
    const onVis = () => { if (document.visibilityState === 'visible') check(); else mark(); };
    document.addEventListener('visibilitychange', onVis); window.addEventListener('pagehide', mark);
    return () => { document.removeEventListener('visibilitychange', onVis); window.removeEventListener('pagehide', mark); };
  }, []);
  const opened = useRef<Promise<void>>(Promise.resolve());
  async function openSession(s: string) {
    session.current = s;
    localStorage.setItem('mwa-session', s);
    setShowConvs(false);
    setElsewhere((e) => e.filter((x) => x.session !== s));
    const kept = await getConversation(s);
    loadedThrough.current = Math.max(loadedThrough.current, ...kept.map((t) => t.ts), 0);
    setTurns(kept.map(restoredTurn));
  }
  function newConversation() { session.current = newSessionId(); localStorage.setItem('mwa-session', session.current); setTurns([]); setShowConvs(false); }
  useEffect(() => {
    opened.current = openSession(session.current);
    const open = (e: Event) => void openSession(String((e as CustomEvent).detail));
    window.addEventListener('mwa-open-conversation', open); return () => window.removeEventListener('mwa-open-conversation', open);
  }, []);
  useEffect(() => { if (showConvs) void getConversations().then(setConvs); }, [showConvs]);

  // Proactive delivery: surface fired scheduled-task results in the chat (on open + every 20s). A result for
  // another conversation (BL-71) is announced here and kept in that one, not mixed into this one.
  useEffect(() => {
    let seen = Number(localStorage.getItem('mwa-notify-seen') ?? 0);
    const check = async () => {
      await opened.current; // the reopened conversation first, so its results aren't shown twice
      const all = await getNotifications(seen);
      if (!all.length) return;
      seen = Math.max(seen, ...all.map((n) => n.ts));
      localStorage.setItem('mwa-notify-seen', String(seen));
      const others = all.filter((n) => n.session && n.session !== session.current && !n.session.startsWith('tg-'));
      if (others.length) setElsewhere((e) => [...e.filter((x) => !others.some((n) => n.session === x.session)), ...others.map((n) => ({ session: n.session!, title: n.title ?? n.instruction.slice(0, 80) }))]);
      // already shown when this conversation was reopened from the server
      const notes = all.filter((n) => !(n.session && n.session !== session.current) && !(n.session && n.ts <= loadedThrough.current));
      if (!notes.length) { setApprovalTick((x) => x + 1); return; }
      setTurns((prev) => [...prev, ...notes.map((n) => ({
        id: n.ts, user: `⏰ ${n.title ? n.title : `Scheduled · ${n.instruction}`}`, steps: [] as SpineStep[], live: false, folder: n.folder,
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
      setApprovalTick((x) => x + 1);
    };
    check();
    const iv = setInterval(check, 20000);
    return () => clearInterval(iv);
  }, []);
  useEffect(() => { feedEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [turns]);

  function send(text: string, opts: { stay?: boolean } = {}) {
    const t = text.trim();
    if (!t) return;
    setInput('');
    const id = Date.now();
    setTurns((prev) => [...prev, { id, user: t, steps: [], live: true, folder: sessionFolder(session.current) }]);
    let stepId = 0;
    const patch = (fn: (turn: Turn) => Turn) => setTurns((prev) => prev.map((tn) => (tn.id === id ? fn(tn) : tn)));
    chatStream(t, session.current, {
      onStep: (s) => patch((tn) => ({ ...tn, steps: [...tn.steps, { ...s, id: stepId++ }] })),
      onResult: (r) => { patch((tn) => ({ ...tn, live: false, result: r })); setApprovalTick((x) => x + 1); onActivity?.(); },
      onError: (m) => patch((tn) => ({ ...tn, live: false, error: m })),
      // Show a "new topic" marker only when we actually set aside an earlier conversation
      // (not on the first message of a session) — so the user understands the reset.
      onTopic: (tp) => { if (tp.relation === 'fresh' && tp.hadContext) patch((tn) => ({ ...tn, topicReset: true })); },
    }, opts);
  }

  // BL-71b: answer an offer to work in the background.
  async function answerOffer(tn: Turn, work: boolean) {
    const message = tn.result?.offer?.message ?? tn.user;
    const set = (fn: (x: Turn) => Turn) => setTurns((prev) => prev.map((x) => (x.id === tn.id ? fn(x) : x)));
    if (!work) { set((x) => ({ ...x, offerState: 'declined' })); send(message, { stay: true }); return; }
    set((x) => ({ ...x, offerState: 'sending' }));
    const r = await startWork(message, session.current);
    set((x) => ({ ...x, offerState: r.ok ? 'started' : 'failed', offerReply: r.message }));
    onActivity?.();
  }

  // BL-70: add a file to this chat. It is saved in the chat's folder (uploads/), and the next
  // request is told it is there.
  const picker = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  async function attach(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    for (const f of Array.from(files)) {
      const r = await uploadFile(f, session.current);
      const id = Date.now() + Math.random();
      setTurns((prev) => [...prev, r.ok && r.path
        ? { id, user: `📎 Added ${f.name}`, steps: [], live: false, note: true, result: { reason: 'done', summary: `Saved as [${r.path.split('/').pop()}](${r.path}). Ask me to use it.`, steps: 0, dispatches: 0, toolCalls: 0, costUsd: 0 } as ChatResult, folder: sessionFolder(session.current) }
        : { id, user: `📎 ${f.name}`, steps: [], live: false, note: true, error: r.message ?? 'Could not add that file.' }]);
    }
    setUploading(false);
    if (picker.current) picker.current.value = '';
  }

  const empty = turns.length === 0;

  return (
    <div className="flex flex-col min-h-[calc(100vh-61px)]">
      <div className="flex-1 py-8">
        {/* BL-71d: go back to an earlier conversation (from any device), or start a new one. */}
        <div className="flex items-center gap-3 mb-6 mono text-[11px] uppercase tracking-[0.12em]">
          <button onClick={() => setShowConvs(!showConvs)} className="text-dim hover:text-signal">{showConvs ? 'hide conversations' : 'conversations ▾'}</button>
          <button onClick={newConversation} className="text-dim hover:text-signal">+ new</button>
        </div>
        {showConvs && (
          <ul className="mb-6 divide-y divide-line border-y border-line">
            {!convs.length && <li className="py-2.5 text-[14px] text-dim">No earlier conversations kept yet.</li>}
            {convs.map((c) => (
              <li key={c.session}>
                <button onClick={() => void openSession(c.session)} className={`w-full text-left py-2.5 group ${c.session === session.current ? 'text-signal' : ''}`}>
                  <div className="truncate text-[15px] group-hover:text-signal">{c.title}</div>
                  <div className="mono text-[11px] text-dim truncate">{new Date(c.last).toLocaleString()} · {c.turns} turn{c.turns === 1 ? '' : 's'}{c.turns > 1 ? ` · last: ${c.lastMessage}` : ''}</div>
                </button>
              </li>
            ))}
          </ul>
        )}
        {welcome && (
          <div className="mb-6 rounded-[3px] border border-signal px-3.5 py-3 text-[14px]">
            <div className="flex items-baseline justify-between gap-3 mb-1.5">
              <span className="mono text-[11px] uppercase tracking-[0.14em] text-signal">welcome back · since {new Date(welcome.since).toLocaleString()}</span>
              <button onClick={() => setWelcome(null)} className="mono text-[11px] text-dim hover:text-signal">close</button>
            </div>
            <ul className="space-y-1.5">
              {welcome.goals.map((g) => (
                <li key={g.id}><strong>{g.title}</strong>: {g.state}{g.conv && <> · <button onClick={() => { openConversation(g.conv!); setWelcome(null); }} className="underline hover:text-signal">open</button></>}</li>
              ))}
              {welcome.results.length > 0 && <li>{welcome.results.length} result{welcome.results.length > 1 ? 's' : ''} came in: {welcome.results.map((r) => r.title).slice(0, 3).join('; ')}</li>}
              {welcome.thoughts.filter((t) => t.kind === 'ask').map((t, i) => <li key={i}>Question on <strong>{t.title}</strong>: {t.text}</li>)}
              {welcome.approvals > 0 && <li>{welcome.approvals} action{welcome.approvals > 1 ? 's' : ''} waiting for your approval, below.</li>}
            </ul>
          </div>
        )}
        {elsewhere.map((e) => (
          <div key={e.session} className="mb-4 flex flex-wrap items-center gap-2 rounded-[3px] border border-signal px-3 py-2 text-[14px]">
            <span className="flex-1 min-w-[180px]">⏰ Done in another conversation: {e.title}</span>
            <button onClick={() => void openSession(e.session)} className="mono text-[11px] uppercase tracking-wide underline hover:text-signal">open it</button>
          </div>
        ))}
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
                    <Markdown text={tn.result.summary} folder={tn.folder} />
                    {tn.result.offer && (
                      // BL-71b: the person decides where the work happens.
                      !tn.offerState || tn.offerState === 'sending' ? (
                        <div className="flex flex-wrap gap-2 mt-3">
                          <button disabled={tn.offerState === 'sending'} onClick={() => void answerOffer(tn, true)} className="rounded-[3px] bg-signal text-white px-3.5 py-2 text-[14px] font-medium hover:opacity-90 disabled:opacity-50">{tn.offerState === 'sending' ? 'Starting…' : 'Work on it, get back to me'}</button>
                          <button disabled={tn.offerState === 'sending'} onClick={() => void answerOffer(tn, false)} className="rounded-[3px] border border-line bg-surface px-3.5 py-2 text-[14px] hover:border-signal hover:text-signal disabled:opacity-50">Do it now, I'll wait</button>
                        </div>
                      ) : (
                        <div className={`mono text-[12px] mt-2 ${tn.offerState === 'failed' ? 'text-signal' : 'text-dim'}`}>
                          {tn.offerState === 'declined' ? 'Doing it now, below.' : tn.offerReply}
                        </div>
                      )
                    )}
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
                          ? <span> · wrote {tn.sched.files.map((f, j) => <span key={f}>{j > 0 && ', '}{tn.folder ? <a href={fileUrl(`${tn.folder}/${f}`)} target="_blank" rel="noreferrer" onClick={(e) => { e.preventDefault(); openFile(`${tn.folder}/${f}`); }} className="underline hover:text-signal">{f}</a> : f}</span>)}</span>
                          : <span> · no files</span>}
                      </div>
                    ) : tn.note || tn.result.offer ? null : (
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
          <input ref={picker} type="file" multiple className="hidden" onChange={(e) => void attach(e.target.files)} />
          <button onClick={() => picker.current?.click()} disabled={uploading} aria-label="Add a file" title="Add a file to this chat" className="rounded-[3px] border border-line bg-surface px-3 text-[17px] text-dim hover:border-signal hover:text-signal transition-colors disabled:opacity-50">{uploading ? '…' : '📎'}</button>
          <button onClick={() => send(input)} aria-label="Send" className="rounded-[3px] bg-signal text-white px-5 text-lg font-medium hover:opacity-90 transition-opacity">→</button>
        </div>
      </div>
    </div>
  );
}
