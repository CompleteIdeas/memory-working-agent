import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { getSuggestions, uploadFile, getWelcome, getSources, getLive, type Sources } from '../api';
import { useStore } from '../store';
import { SetupCards } from './SetupCards';
import { TaskBlock } from './TaskBlock';
import { CardView } from './TaskParts';
import { titleOf, whenShort, shortName, type Task } from '../tasks';

/** "Since you were last here" (F10): Needs you / Finished / Problem / Coming up, each with one action. */
function Digest({ since, onClose }: { since: number; onClose: () => void }) {
  const { allTasks, schedule, openSession } = useStore();
  const needs = allTasks.filter((t) => t.status === 'needs-you');
  const recent = (t: Task) => (t.endedAt ?? t.startedAt);
  const finished = allTasks.filter((t) => t.status === 'done' && ((t.endedAt ?? 0) > since || t.results.some((r) => r.ts > since))).sort((a, b) => recent(b) - recent(a));
  const problems = allTasks.filter((t) => (t.status === 'failed' || t.status === 'stopped') && (t.endedAt ?? 0) > since);
  const coming = schedule.filter((j) => !j.paused && j.due < Date.now() + 24 * 3_600_000).slice(0, 4);
  if (!needs.length && !finished.length && !problems.length && !coming.length) return null;
  const away = Math.round((Date.now() - since) / 3_600_000);
  const go = (t: Task) => { openSession(t.session, t.key); };
  return (
    <section className="mb-6 rounded-[3px] border border-edge bg-surface px-4 py-3" aria-labelledby="digest-h">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="digest-h" className="text-[16px] font-semibold">Since you were last here{away >= 1 ? ` · ${away} h` : ''}</h2>
        <button className="btn small" onClick={onClose}>Mark all seen</button>
      </div>
      <ul className="mt-2 space-y-1.5 text-[14.5px]">
        {needs.slice(0, 3).map((t) => <li key={t.key}><strong>Needs you:</strong> {t.title} <button className="linkbtn" onClick={() => go(t)}>Review</button></li>)}
        {finished.slice(0, 3).map((t) => <li key={t.key}><strong>Finished:</strong> {t.title} <button className="linkbtn" onClick={() => go(t)}>Open</button></li>)}
        {problems.slice(0, 3).map((t) => <li key={t.key}><strong>Problem:</strong> {t.title} ({t.status === 'stopped' ? 'stopped' : 'could not finish'}) <button className="linkbtn" onClick={() => go(t)}>See why</button></li>)}
        {(needs.length > 3 || finished.length > 3 || problems.length > 3) && <li className="text-dim">and {Math.max(0, needs.length - 3) + Math.max(0, finished.length - 3) + Math.max(0, problems.length - 3)} more <button className="linkbtn" onClick={() => window.dispatchEvent(new CustomEvent('mwa-show', { detail: 'tasks' }))}>in Tasks</button></li>}
        {coming.slice(0, 3).map((j) => <li key={j.id}><strong>Coming up:</strong> {j.request.slice(0, 90)} · {new Date(j.due).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</li>)}
      </ul>
    </section>
  );
}

/** The redirect chooser (F08): a message sent while a task in this conversation runs goes where the person says. */
function BusyChooser() {
  const { busy, setBusy, steer, stop, send, newConversation, tasksFor } = useStore();
  const first = useRef<HTMLButtonElement>(null);
  const [msg, setMsg] = useState('');
  useEffect(() => { if (busy) first.current?.focus(); }, [busy]);
  if (!busy) return null;
  const running = tasksFor(busy.session).find((t) => t.status === 'working');
  const title = running?.title ?? (busy.info?.message ? titleOf(busy.info.message) : 'The current task');
  return (
    <div className="max-w-3xl mx-auto mb-3 rounded-[3px] border border-signal bg-surface px-3.5 py-3" role="group" aria-label="Where should this message go?">
      <p className="text-[14.5px]"><strong>“{busy.message.slice(0, 120)}”</strong></p>
      <p className="text-[14px] text-dim mt-0.5">“{title}” is still working. What should this message do?</p>
      <div className="flex flex-wrap gap-2 mt-2.5">
        <button ref={first} className="btn primary" onClick={async () => { const r = await steer(busy.session, busy.message); if (r.ok) setBusy(null); else setMsg(r.message); }}>Add to the running task</button>
        <button className="btn" onClick={() => { const m = busy.message; setBusy(null); newConversation(); setTimeout(() => send(m), 50); }}>Send separately</button>
        <button className="btn" onClick={async () => {
          const m = busy.message, s = busy.session; setMsg('Stopping the running task, then sending this…');
          await stop(s);
          // wait for the run to end, then send
          const t0 = Date.now();
          const wait = async () => { while (Date.now() - t0 < 120_000) { if (!(await getLive(s))) return; await new Promise((r) => setTimeout(r, 800)); } };
          await wait(); setBusy(null); setMsg(''); setTimeout(() => send(m, { session: s, ...(busy.opts ?? {}) }), 400); // a resume stays a resume
        }}>Stop it and send this</button>
        <button className="btn" onClick={() => setBusy(null)}>Cancel</button>
      </div>
      {msg && <p className="text-[13px] text-dim mt-1.5" role="status">{msg}</p>}
    </div>
  );
}

/** "I can read" (F07): the granted folders and the files added to this chat, above the input. */
function ReadLine({ session, tick }: { session: string; tick: number }) {
  const [src, setSrc] = useState<Sources | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { void getSources(session).then(setSrc); }, [session, tick]);
  if (!src) return null;
  const folders = src.folders.filter((f) => f.readable);
  return (
    <div className="max-w-3xl mx-auto mb-2 text-[13px] text-dim">
      <div className="flex items-center gap-x-2 gap-y-1 min-w-0 overflow-hidden whitespace-nowrap">
        <span>I can read:</span>
        {folders.length ? folders.map((f) => <span key={f.path} className="mono text-[12px] border border-line rounded-[3px] px-1.5 py-0.5 text-graphite">{shortName(f.path)} · {f.files}{f.capped ? '+' : ''} files</span>)
          : <span>{src.preset === 'locked-down' ? 'only this chat\'s files (locked down)' : 'no folders granted yet'}</span>}
        <span className={`mono text-[12px] border border-line rounded-[3px] px-1.5 py-0.5 text-graphite ${src.added.length ? '' : 'hidden sm:inline'}`}>{src.added.length ? `${src.added.length} file${src.added.length > 1 ? 's' : ''} you added here` : 'files you add here'}</span>
        <button className="linkbtn text-[13px]" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'less' : 'details'}</button>
      </div>
      {open && (
        <p className="mt-1">
          {folders.map((f) => <span key={f.path}>{shortName(f.path)} is a folder you granted: I read it freely; any change to it needs your approval. </span>)}
          {src.added.length > 0 && <>Added here: {src.added.map(shortName).join(', ')}. </>}
          Change folders in <button className="linkbtn" onClick={() => window.dispatchEvent(new CustomEvent('mwa-show', { detail: 'settings' }))}>Settings</button>.
        </p>
      )}
    </div>
  );
}

function Conversations({ onPick }: { onPick: () => void }) {
  const { convs, turns, openSession, session } = useStore();
  const [q, setQ] = useState('');
  const rows = convs.map((c) => {
    const first = (turns[c.session] ?? []).find((t) => t.kind !== 'result');
    return { ...c, title: first ? titleOf(first.message) : c.title };
  }).filter((c) => !q || `${c.title} ${c.lastMessage}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="mb-6 border-y border-line py-2">
      <label className="sr-only" htmlFor="conv-q">Find a conversation</label>
      <input id="conv-q" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a conversation…" className="w-full rounded-[3px] border border-edge bg-surface px-3 py-2 text-[14px] mb-1" />
      <ul className="divide-y divide-line max-h-[50vh] overflow-y-auto">
        {!rows.length && <li className="py-2.5 text-[14px] text-dim">{convs.length ? 'Nothing matches.' : 'No earlier conversations yet.'}</li>}
        {rows.map((c) => (
          <li key={c.session}>
            <button onClick={() => { openSession(c.session); onPick(); }} aria-current={c.session === session} className="w-full text-left py-2.5 px-1 group">
              <span className={`block truncate text-[15px] group-hover:text-signal ${c.session === session ? 'font-semibold' : ''}`}>{c.title}</span>
              <span className="block text-[12px] text-dim truncate">{whenShort(c.last)} · {c.turns} message{c.turns === 1 ? '' : 's'}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Chat() {
  const store = useStore();
  const { session, tasksFor, send, newConversation, focus, looseCards, status } = store;
  const tasks = tasksFor(session);
  const [input, setInput] = useState('');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showConvs, setShowConvs] = useState(false);
  const [uploadTick, setUploadTick] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [welcomeSince, setWelcomeSince] = useState<number | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const feedEnd = useRef<HTMLDivElement>(null);
  useEffect(() => { void getSuggestions().then((s) => setSuggestions(s.filter((x) => !/inbox|email|gmail|outlook/i.test(x)).slice(0, 3))); }, []);

  // back after a while (hidden or closed for 2 h+): the digest, once per return
  useEffect(() => {
    const read = () => { try { return Number(localStorage.getItem('mwa-last-seen') ?? 0); } catch { return 0; } };
    const mark = () => { try { localStorage.setItem('mwa-last-seen', String(Date.now())); } catch { /* */ } };
    const check = () => { const last = read(); if (last && Date.now() - last > 2 * 3_600_000) { void getWelcome(last); setWelcomeSince(last); } mark(); };
    check();
    const onVis = () => { if (document.visibilityState === 'visible') check(); else mark(); };
    document.addEventListener('visibilitychange', onVis); window.addEventListener('pagehide', mark);
    return () => { document.removeEventListener('visibilitychange', onVis); window.removeEventListener('pagehide', mark); };
  }, []);

  // a task picked in the rail or the digest: scroll to it
  const [lit, setLit] = useState<string | null>(null);
  useEffect(() => {
    if (!focus) return;
    const t = setTimeout(() => { const el = document.getElementById(`task-${focus.key}`); if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); setLit(focus.key); setTimeout(() => setLit(null), 2500); } }, 250);
    return () => clearTimeout(t);
  }, [focus]);
  const n = tasks.length + tasks.reduce((a, t) => a + t.revisions.length, 0);
  const lastLive = tasks.some((t) => t.status === 'working');
  useEffect(() => { if (!focus || Date.now() - focus.n > 3000) feedEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [n, session, lastLive]); // eslint-disable-line react-hooks/exhaustive-deps

  function submit() {
    const t = input.trim(); if (!t) return;
    if (send(t) === 'sent') setInput(''); else setInput('');
  }
  async function attach(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    for (const f of Array.from(files)) {
      const r = await uploadFile(f, session);
      store.toast(r.ok ? `Added ${f.name} to this conversation. Ask me to use it.` : (r.message ?? `Could not add ${f.name}.`));
    }
    setUploading(false); setUploadTick((x) => x + 1);
    if (picker.current) picker.current.value = '';
  }
  const title = tasks[0]?.title ?? 'New conversation';
  const empty = tasks.length === 0;
  const telegram = !!status?.telegram;

  return (
    <div className="flex flex-col min-h-[calc(100dvh-57px)] lg:min-h-[calc(100dvh-57px)]">
      <div className="flex-1 pt-5 pb-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-4">
          <h1 className="text-[14px] text-dim min-w-0 truncate flex-1"><span className="sr-only">Conversation: </span>{empty ? 'New conversation' : title}</h1>
          <button className="btn small" aria-expanded={showConvs} onClick={() => setShowConvs(!showConvs)}>Conversations</button>
          <button className="btn small" onClick={() => { newConversation(); setTimeout(() => inputRef.current?.focus(), 50); }}>+ New</button>
        </div>
        {showConvs && <Conversations onPick={() => setShowConvs(false)} />}
        {welcomeSince && <Digest since={welcomeSince} onClose={() => setWelcomeSince(null)} />}
        {empty ? (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }} className="pt-6">
            <h2 className="text-3xl sm:text-[34px] font-semibold tracking-tight leading-[1.08] mb-2">What should I work on?</h2>
            <p className="text-dim mb-6 max-w-lg">Ask in plain words. A quick question gets its answer here; a longer job can run in the background and shows up under Tasks.</p>
            {suggestions.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {suggestions.map((s) => <button key={s} className="btn" onClick={() => send(s)}>{s}</button>)}
              </div>
            )}
          </motion.div>
        ) : (
          <div className="divide-y divide-line">
            {tasks.map((t) => <TaskBlock key={t.key} task={t} highlight={lit === t.key} />)}
          </div>
        )}
        {looseCards.length > 0 && (
          <section className="mt-6" aria-label="Decisions from elsewhere">
            <h2 className="label">waiting for you, from a scheduled run or another channel</h2>
            {looseCards.map((p) => <CardView key={p.id} telegram={telegram} card={{ id: p.id, tool: p.tool, summary: p.summary, kind: p.kind, state: 'pending', expiresAt: p.expiresAt ?? Date.now() + p.expiresInSec * 1000, session: p.session, tainted: p.tainted, readLocal: p.readLocal, dupes: [] }} />)}
          </section>
        )}
        <div ref={feedEnd} />
      </div>

      <div className="sticky bottom-[64px] lg:bottom-0 bg-bone/95 backdrop-blur pt-3 pb-3 -mx-4 px-4 sm:-mx-6 sm:px-6 border-t border-line z-10">
        <SetupCards refresh={uploadTick} />
        <BusyChooser />
        <ReadLine session={session} tick={uploadTick} />
        <form className="flex gap-2 max-w-3xl mx-auto" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <label htmlFor="msg" className="sr-only">Message MWA</label>
          <textarea
            id="msg" ref={inputRef} rows={1} value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
            placeholder="Ask, or give MWA a job…"
            className="flex-1 min-w-0 resize-none rounded-[3px] border border-edge bg-surface px-4 py-3 text-[15px] outline-none focus:border-signal leading-snug max-h-40"
          />
          <input ref={picker} type="file" multiple className="hidden" onChange={(e) => void attach(e.target.files)} aria-hidden="true" tabIndex={-1} />
          <button type="button" onClick={() => picker.current?.click()} disabled={uploading} aria-label="Add a file to this conversation" title="Add a file" className="btn shrink-0 !min-h-[48px] !px-3 text-[17px]">{uploading ? '…' : '📎'}</button>
          <button type="submit" aria-label="Send" className="btn primary shrink-0 !min-h-[48px] !px-5 text-lg">→</button>
        </form>
      </div>
    </div>
  );
}

