import { useState } from 'react';
import { useStore } from '../store';
import { Markdown } from './Markdown';
import { ActivitySpine } from './ActivitySpine';
import { LiveStatus, CardView, JobCard, StatusChip } from './TaskParts';
import { revisionMessage, plainReply, whenShort, secs, stateLine, type Task } from '../tasks';
import { sessionFolder } from '../api';

/** One task in the conversation (D1): the person's words, where it stands, its cards, steps and result. */
export function TaskBlock({ task, highlight }: { task: Task; highlight?: boolean }) {
  const { status, send, answerOffer, cancelled } = useStore();
  const telegram = !!status?.telegram;
  const [showSteps, setShowSteps] = useState(false);
  const [revising, setRevising] = useState(false);
  const [change, setChange] = useState('');
  const folder = sessionFolder(task.session);
  const cardsPending = task.cards.filter((c) => c.state === 'pending');
  const cardsDone = task.cards.filter((c) => c.state !== 'pending');
  const canRevise = !!task.reply && task.status !== 'working' && !task.offer;
  const jobsShown = [...task.jobs, ...Object.values(cancelled).filter((c) => c.row.session === task.session && task.words.toLowerCase().includes((c.row.request || '').toLowerCase().slice(0, 40)) && !task.jobs.some((j) => j.id === c.row.id)).map((c) => c.row)];

  return (
    <article id={`task-${task.key}`} data-task={task.key} data-task-status={task.status} aria-label={`Task: ${task.title}`}
      className={`py-5 scroll-mt-24 ${highlight ? 'outline outline-2 outline-accent outline-offset-4 rounded-[2px]' : ''}`}>
      <header className="flex flex-wrap items-center gap-x-2.5 gap-y-1 mb-2">
        <StatusChip status={task.status} />
        {task.status !== 'working' && <span className="text-[13px] text-dim">{stateLine(task)}</span>}
        <span className="text-[12px] text-dim ml-auto mono">{whenShort(task.startedAt)}</span>
      </header>
      <div className="flex gap-2 items-baseline mb-2">
        <span className="mono text-[11px] text-signal mt-0.5 shrink-0">YOU</span>
        <p className="text-[15.5px] leading-snug whitespace-pre-wrap break-words">{task.revises ? <><span className="label mr-1">revise</span>{task.revises.change}</> : task.words.replace(/^⏰\s*/, '')}</p>
      </div>

      {task.status === 'working' && task.live && <LiveStatus task={task} />}

      {task.offer && (
        <div className="mt-3 rounded-[3px] border border-line bg-surface px-3.5 py-3">
          <div className="label">how should I do this?</div>
          {!task.offer.answered ? (
            <>
              <p className="text-[14.5px] mt-1">This takes several steps. I can work on it in the background (it keeps going if you close the page; the result comes back here and under Tasks) or do it now while you wait. Nothing has started yet.</p>
              <div className="flex flex-wrap gap-2 mt-2.5">
                <button className="btn primary" onClick={() => void answerOffer(task, true)}>Work on it, get back to me</button>
                <button className="btn" onClick={() => void answerOffer(task, false)}>Do it now, I'll wait</button>
              </div>
            </>
          ) : (
            <p className={`text-[14px] mt-1 ${task.offer.answered === 'failed' ? 'text-signal' : ''}`}>
              {task.offer.answered === 'now' ? 'Doing it now, below.' : task.offer.answered === 'failed' ? (task.offer.note || 'Could not start it.') : task.results.length ? (task.status === 'failed' || (task.results[task.results.length - 1].reason && task.results[task.results.length - 1].reason !== 'done') ? 'The background work ended with a problem; what it said is below.' : 'Done in the background. The result is below.') : (task.offer.note || 'Working on it in the background. You can close this page.')}
            </p>
          )}
          {task.offer.answered === 'background' && !task.results.length && task.status === 'working' && <p className="text-[13px] text-dim mt-1 mono">handed over {whenShort(task.startedAt)} · {secs(Date.now() - task.startedAt)} ago</p>}
          {task.offer.answered === 'background' && task.goal?.record && !task.results.length && (
            <p className="text-[13.5px] text-dim mt-1.5" data-goal-note><span className="label mr-1.5">where it stands</span>{task.goal.record.text.split(/\n/)[0].replace(/^Where we are on "[^"]*" \(goal [^)]*\):\s*/, '').slice(0, 260)} · {new Date(task.goal.record.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</p>
          )}
        </div>
      )}

      {cardsPending.map((c) => <CardView key={c.id} card={c} telegram={telegram} />)}

      {task.reply && !task.offer && (
        <div className="mt-2 border-l-2 border-accent pl-3">
          <div className="mono text-[11px] text-dim mb-1">MWA{task.elapsedMs ? ` · ${secs(task.elapsedMs)}` : ''}</div>
          <Markdown text={plainReply(task.reply, telegram)} folder={folder} />
        </div>
      )}
      {task.status !== 'working' && task.added && task.added.length > 0 && <p className="mt-2 text-[13.5px] text-dim"><span className="label mr-1.5">you added while it ran</span>{task.added.join(' · ')}</p>}
      {task.error && <p className="mt-2 text-[14px] text-signal" role="alert">{task.error}</p>}

      {task.results.map((r) => (
        <div key={r.ts} className="mt-3 border-l-2 border-accent pl-3" data-result>
          <div className="mono text-[11px] text-dim mb-1">MWA · result · {whenShort(r.ts)}</div>
          <Markdown text={plainReply(r.reply, telegram)} folder={folder} />
        </div>
      ))}

      {cardsDone.map((c) => <CardView key={c.id} card={c} telegram={telegram} />)}
      {jobsShown.map((j) => <JobCard key={j.id} row={j} cancelledAt={cancelled[j.id]?.at} />)}

      {(task.steps.length > 0 || canRevise || task.status === 'stopped' || task.status === 'failed') && (
        <div className="flex flex-wrap items-center gap-3 mt-2.5">
          {task.steps.length > 0 && task.status !== 'working' && (
            <button className="linkbtn text-[13px]" aria-expanded={showSteps} onClick={() => setShowSteps(!showSteps)}>{showSteps ? 'Hide what I did' : `What I did · ${task.steps.length} step${task.steps.length === 1 ? '' : 's'}`}</button>
          )}
          {canRevise && !revising && <button className="btn small" onClick={() => setRevising(true)}>Revise</button>}
          {/* 3b: the server resumes the stopped run from its own words (resume=1); these words are what the person sees */}
          {task.status === 'stopped' && !task.offer && <button className="btn small" onClick={() => send(`Continue from where it stopped: "${task.title.replace(/"/g, "'")}". Keep what is already done.`, { session: task.session, resume: true })}>Continue from where it stopped</button>}
          {task.status === 'failed' && <button className="btn small" onClick={() => send(task.words.replace(/^⏰\s*/, ''), { session: task.session, stay: true })}>Try again</button>}
        </div>
      )}
      {showSteps && <div className="mt-2 pl-1 border-l border-line"><ActivitySpine steps={task.steps} live={false} /></div>}
      {revising && (
        <form className="mt-2.5 flex flex-wrap gap-2" onSubmit={(e) => {
          e.preventDefault(); if (!change.trim()) return;
          if (send(revisionMessage({ ...task, reply: task.revisions[task.revisions.length - 1]?.reply ?? task.reply }, change), { session: task.session }) === 'sent') { setChange(''); setRevising(false); }
        }}>
          <label className="sr-only" htmlFor={`rev-${task.key}`}>What should change in this answer?</label>
          <input id={`rev-${task.key}`} autoFocus value={change} onChange={(e) => setChange(e.target.value)} placeholder="What should change? e.g. shorter, under 80 words" className="flex-1 min-w-[200px] rounded-[3px] border border-edge bg-bone px-3 py-2 text-[14px]" />
          <button className="btn small primary" disabled={!change.trim()}>Send revision</button>
          <button type="button" className="btn small" onClick={() => setRevising(false)}>Cancel</button>
        </form>
      )}

      {task.revisions.map((r, i) => (
        <section key={r.key} className="mt-4 ml-2 pl-3 border-l border-line" aria-label={`Revision ${i + 2}`} data-revision={r.key}>
          <div className="flex flex-wrap items-center gap-2 mb-1.5"><span className="label">version {i + 2} · you asked: {r.revises?.change}</span><StatusChip status={r.status} /></div>
          {r.status === 'working' && r.live && <LiveStatus task={r} />}
          {r.cards.filter((c) => c.state === 'pending').map((c) => <CardView key={c.id} card={c} telegram={telegram} />)}
          {r.reply && <div className="border-l-2 border-accent pl-3"><Markdown text={plainReply(r.reply, telegram)} folder={folder} /></div>}
          {r.error && <p className="text-[14px] text-signal">{r.error}</p>}
        </section>
      ))}
      {task.revisions.length > 0 && task.status !== 'working' && !revising && (
        <button className="btn small mt-2.5" onClick={() => setRevising(true)}>Revise again</button>
      )}
    </article>
  );
}
