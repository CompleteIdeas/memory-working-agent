import { useMemo, useState } from 'react';
import { useStore } from '../store';
import { continueWork, setWorkStatus, openConversation } from '../api';
import { StatusChip, CardView, JobCard, TaskState } from './TaskParts';
import { whenShort, STATUS_LABEL, type Task, type TaskStatus } from '../tasks';

const GROUPS: { id: string; label: string; has: (t: Task) => boolean }[] = [
  { id: 'needs-you', label: 'Waiting for you', has: (t) => t.status === 'needs-you' },
  { id: 'working', label: 'Working', has: (t) => t.status === 'working' },
  { id: 'scheduled', label: 'Scheduled & watching', has: (t) => t.status === 'scheduled' },
  { id: 'done', label: 'Done', has: (t) => t.status === 'done' },
  { id: 'ended', label: 'Stopped or failed', has: (t) => t.status === 'stopped' || t.status === 'failed' },
];

function byRecent(a: Task, b: Task) { return (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt); }

function TaskRow({ t, compact }: { t: Task; compact?: boolean }) {
  const { openSession, session } = useStore();
  return (
    <li>
      <button onClick={() => openSession(t.session, t.key)} className={`w-full text-left rounded-[3px] border px-2.5 py-2 hover:border-edge ${t.session === session && compact ? 'border-line bg-surface' : 'border-transparent'}`} data-task-row={t.key}>
        <span className="block text-[14px] font-medium leading-snug break-words">{t.title}</span>
        <span className="flex items-center gap-2 mt-0.5 min-w-0"><TaskState task={t} />{!compact && <span className="text-[12px] text-dim ml-auto shrink-0">{whenShort(t.startedAt)}</span>}</span>
      </button>
    </li>
  );
}

/** The Tasks rail beside the conversation on a wide screen (D1). */
export function TaskRail({ onAll }: { onAll: () => void }) {
  const { allTasks, looseCards, schedule } = useStore();
  const sorted = [...allTasks].sort(byRecent);
  const orphanJobs = schedule.filter((j) => !allTasks.some((t) => t.jobs.some((x) => x.id === j.id)));
  return (
    <nav aria-label="Tasks" className="text-[14px]">
      {GROUPS.map((g) => {
        const items = sorted.filter(g.has);
        const extra = g.id === 'needs-you' ? looseCards.length : g.id === 'scheduled' ? orphanJobs.length : 0;
        const shown = g.id === 'done' ? items.slice(0, 6) : items.slice(0, 8);
        if (g.id === 'ended' && !items.length) return null;
        return (
          <section key={g.id} className="mb-3">
            <h2 className="label px-1.5 mb-1">{g.label} · {items.length + extra}</h2>
            {shown.length > 0 && <ul className="space-y-0.5">{shown.map((t) => <TaskRow key={t.key} t={t} compact />)}</ul>}
            {extra > 0 && <button className="linkbtn text-[13px] px-1.5" onClick={onAll}>{g.id === 'needs-you' ? `${extra} more from elsewhere` : `${extra} job${extra > 1 ? 's' : ''} set up elsewhere`}</button>}
            {items.length > shown.length && <button className="linkbtn text-[13px] px-1.5" onClick={onAll}>all {items.length}</button>}
          </section>
        );
      })}
      {!allTasks.length && <p className="text-[13px] text-dim px-1.5">No tasks yet. What you ask, hand over or schedule appears here.</p>}
      <button className="btn small mt-1 w-full" onClick={onAll}>Find earlier work</button>
    </nav>
  );
}

/** Everything in one list (D1, F05, F10, F04): find earlier work, see what waits for you, control schedules. */
export function TasksPage({ initial }: { initial?: string }) {
  const { allTasks, looseCards, schedule, goals, cancelled, status, refresh } = useStore();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<string>(initial ?? 'all');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Record<string, string>>({});
  const telegram = !!status?.telegram;
  const ql = q.trim().toLowerCase();
  const match = (t: Task) => !ql || `${t.title} ${t.words} ${t.reply ?? ''}`.toLowerCase().includes(ql);
  const tasks = useMemo(() => [...allTasks].filter(match).sort(byRecent), [allTasks, ql]); // eslint-disable-line react-hooks/exhaustive-deps
  const count = (id: string) => id === 'all' ? tasks.length : tasks.filter(GROUPS.find((g) => g.id === id)!.has).length + (id === 'needs-you' ? looseCards.length : 0);
  const groups = GROUPS.filter((g) => filter === 'all' || filter === g.id);
  const jobsAll = [...schedule, ...Object.values(cancelled).filter((c) => !schedule.some((j) => j.id === c.row.id)).map((c) => c.row)].filter((j) => !ql || j.request.toLowerCase().includes(ql));
  const openGoals = goals.filter((g) => g.status !== 'done' && (!ql || g.title.toLowerCase().includes(ql)));

  async function goalAct(id: string, what: 'continue' | 'done') {
    setBusy(id);
    const r = what === 'continue' ? await continueWork(id) : await setWorkStatus(id, 'done');
    setMsg((m) => ({ ...m, [id]: r.message })); setBusy(null); refresh();
  }

  return (
    <div className="py-6">
      <h1 className="text-2xl font-semibold tracking-tight">Tasks</h1>
      <p className="text-dim text-[14px] mb-4">Everything you asked, handed over or scheduled, and where each stands.</p>
      <label htmlFor="task-q" className="sr-only">Find a task</label>
      <input id="task-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a task by its words…" className="w-full rounded-[3px] border border-edge bg-surface px-3 py-2.5 text-[15px] mb-3" />
      <div className="flex flex-wrap gap-1.5 mb-5" role="group" aria-label="Show">
        {[{ id: 'all', label: 'All' }, ...GROUPS].map((g) => (
          <button key={g.id} className={`btn small ${filter === g.id ? '!border-graphite !bg-graphite !text-bone' : ''}`} aria-pressed={filter === g.id} onClick={() => setFilter(g.id)}>
            {g.label} · {g.id === 'scheduled' ? jobsAll.filter((j) => !cancelled[j.id]).length : count(g.id)}
          </button>
        ))}
      </div>

      {groups.map((g) => {
        const items = tasks.filter(g.has);
        if (g.id === 'scheduled') {
          return (
            <section key={g.id} className="mb-7" aria-labelledby={`g-${g.id}`}>
              <h2 id={`g-${g.id}`} className="label mb-1">{g.label} · {jobsAll.filter((j) => !cancelled[j.id]).length}</h2>
              {!jobsAll.length ? <p className="text-[14px] text-dim">Nothing scheduled. Ask “remind me…” or “every weekday at 8…” and it shows up here with its controls.</p>
                : jobsAll.map((j) => {
                  const owner = allTasks.find((t) => t.jobs.some((x) => x.id === j.id));
                  return (
                    <div key={j.id}>
                      <JobCard row={j} cancelledAt={cancelled[j.id]?.at} />
                      {owner && <button className="linkbtn text-[13px]" onClick={() => openConversation(owner.session)}>From “{owner.title}”</button>}
                    </div>
                  );
                })}
            </section>
          );
        }
        if (g.id === 'needs-you') {
          const total = items.length + looseCards.length;
          if (filter === 'all' && !total) return null;
          return (
            <section key={g.id} className="mb-7" aria-labelledby={`g-${g.id}`}>
              <h2 id={`g-${g.id}`} className="label mb-1">{g.label} · {total}</h2>
              {!total && <p className="text-[14px] text-dim">Nothing is waiting for you.</p>}
              {items.map((t) => (
                <div key={t.key} className="mb-4">
                  <ul><TaskRow t={t} /></ul>
                  {t.cards.filter((c) => c.state === 'pending').map((c) => <CardView key={c.id} card={c} telegram={telegram} />)}
                </div>
              ))}
              {looseCards.map((p) => <CardView key={p.id} telegram={telegram} card={{ id: p.id, tool: p.tool, summary: p.summary, kind: p.kind, state: 'pending', expiresAt: p.expiresAt ?? Date.now() + p.expiresInSec * 1000, session: p.session, tainted: p.tainted, readLocal: p.readLocal, dupes: [] }} />)}
            </section>
          );
        }
        if (filter === 'all' && !items.length) return null;
        return (
          <section key={g.id} className="mb-7" aria-labelledby={`g-${g.id}`}>
            <h2 id={`g-${g.id}`} className="label mb-1">{g.label} · {items.length}</h2>
            {!items.length ? <p className="text-[14px] text-dim">None.</p> : <ul className="divide-y divide-line border-y border-line">{items.map((t) => <TaskRow key={t.key} t={t} />)}</ul>}
          </section>
        );
      })}

      {(filter === 'all' || filter === 'working') && openGoals.length > 0 && (
        <section className="mb-7" aria-labelledby="g-bg">
          <h2 id="g-bg" className="label mb-1">Background work · {openGoals.length}</h2>
          <ul className="divide-y divide-line border-y border-line">
            {openGoals.map((g) => (
              <li key={g.id} className="py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[15px] font-medium flex-1 min-w-[180px]">{g.title}</span>
                  <StatusChip status={(g.status === 'in_progress' ? 'working' : g.status === 'blocked' ? 'stopped' : 'needs-you') as TaskStatus} />
                </div>
                {g.thought && <p className="text-[14px] mt-1"><span className="label mr-1.5">{g.thought.kind === 'ask' ? 'question for you' : 'next step'}</span>{g.thought.text}</p>}
                <div className="flex flex-wrap gap-2 mt-2">
                  {g.status !== 'in_progress' && <button className="btn small primary" disabled={busy === g.id} onClick={() => void goalAct(g.id, 'continue')}>Continue</button>}
                  {g.record?.conv && <button className="btn small" onClick={() => openConversation(g.record!.conv!)}>Open its conversation</button>}
                  <button className="btn small" disabled={busy === g.id} onClick={() => void goalAct(g.id, 'done')}>Mark done</button>
                </div>
                {msg[g.id] && <p className="text-[13px] text-dim mt-1" role="status">{msg[g.id]}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="text-[12px] text-dim">Statuses: {Object.values(STATUS_LABEL).join(' · ')}.</p>
    </div>
  );
}
