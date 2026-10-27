/**
 * A project's Work and Files tabs (v2 build, slice W4).
 *
 *   Work   the jobs working for it (GET /projects/{id}/work; General also lists jobs no project claims), each with its
 *          state, progress and cost, its one action (Stop, Continue, Open…), and "Ask about this" in place (AskAbout).
 *          They join the store's jobs, so the stream keeps them current.
 *   Files  its thread's folder and the folders of older conversations its turns came from (GET /projects/{id}/files),
 *          newest first; each opens with the legacy /api/files/raw (the password sign-in, as the v1 app).
 */
import { useEffect, useMemo, useState } from 'react';
import { useJobMap, useJobs, useMeta, useProjectActions } from '../../store/react';
import { jobLine, money } from '../../store/status';
import type { Job, Project, ProjectFiles as Files } from '../../api/client';
import { AskAbout } from '../ask/AskAbout';
import { baseName, jobOf, sizeText } from './logic';

const ORDER: Record<string, number> = { waiting: 0, partly_done: 1, working: 2, continuing: 3, done: 4, stopped_by_you: 5, stopped: 6, scheduled: 7 };

export function ProjectWork({ p }: { p: Project }) {
  const actions = useProjectActions();
  const all = useJobMap();
  const jobsApi = useJobs();
  const [ids, setIds] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { let on = true; void actions.loadWork(p.id).then((r) => { if (on) setIds(r ?? []); }); return () => { on = false; }; }, [actions, p.id]);
  const jobs = useMemo(() => {
    const listed = new Set(ids ?? []);
    return Object.values(all).filter((j) => listed.has(j.id) || (!j.archived && jobOf(p, j)))
      .sort((a, b) => (ORDER[a.status.state] ?? 9) - (ORDER[b.status.state] ?? 9) || b.updatedSeq - a.updatedSeq);
  }, [all, ids, p]);
  const run = async (j: Job, f: (j: Job) => Promise<unknown>) => { setBusy(j.id); try { await f(j); } finally { setBusy(null); } };
  if (ids === null && !jobs.length) return <p className="empty" style={{ textAlign: 'left' }}>Loading…</p>;
  if (!jobs.length) return <p className="empty" style={{ textAlign: 'left' }}>Nothing is working for {p.name} right now. Hand me a job with Ask.</p>;
  return (
    <div className="workpanel">
      {jobs.map((j) => {
        const a = j.status.primaryAction;
        const handler = a ? { stop: jobsApi.stop, continue: jobsApi.continue, 'start-over': jobsApi.startOver, open: jobsApi.open, resume: jobsApi.resume, review: null }[a.action] : null;
        const live = j.status.state === 'working' || j.status.state === 'continuing';
        const pr = j.progress;
        const filled = j.status.state === 'waiting' || j.status.state === 'partly_done' || (a?.action === 'open' && j.status.resultReady);
        return (
          <article key={j.id} className="job projjob" aria-labelledby={`pj-${j.id}`}>
            <h3 id={`pj-${j.id}`}>{j.title}</h3>
            <p className="state"><b>{j.status.label}</b>{jobLine(j) !== j.status.label ? ` · ${jobLine(j)}` : ''}</p>
            {pr && pr.total > 0 && (
              <div className="prog" role="progressbar" aria-label={`${j.title} progress`} aria-valuemin={0} aria-valuemax={pr.total} aria-valuenow={pr.done} aria-valuetext={`${pr.done} of ${pr.total} ${pr.unit}`}>
                <i style={{ width: `${Math.round((pr.done / pr.total) * 100)}%` }} />
              </div>
            )}
            {!live && j.status.detail && <p className="detail">{j.status.detail}</p>}
            <p className="cost">{live ? `${money(j.costUsd)} so far` : `${money(j.costUsd)} spent`}{live && j.capUsd != null ? ` · stops at $${j.capUsd.toFixed(2)}` : ''}</p>
            <div className="acts">
              {a && handler && <button type="button" className={`vbtn${filled ? ' vbtn-primary' : ''}`} disabled={busy === j.id} onClick={() => void run(j, handler)}>{a.label}</button>}
            </div>
            <AskAbout kind="job" id={j.id} label={j.title} />
          </article>
        );
      })}
    </div>
  );
}

export function ProjectFiles({ p }: { p: Project }) {
  const actions = useProjectActions();
  const { fixtures } = useMeta();
  const [files, setFiles] = useState<Files | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let on = true;
    actions.loadFiles(p.id).then((r) => { if (on) setFiles(r); }, (e: unknown) => { if (on) setError(e instanceof Error ? e.message : 'Couldn’t load the files.'); });
    return () => { on = false; };
  }, [actions, p.id]);
  if (error) return <p className="empty" style={{ textAlign: 'left' }}>{error}</p>;
  if (!files) return <p className="empty" style={{ textAlign: 'left' }}>Loading…</p>;
  if (!files.files.length) return <p className="empty" style={{ textAlign: 'left' }}>No files yet. Files you add when you ask here are kept here.</p>;
  return (
    <ul className="rows card filelist">
      {files.files.map((f) => (
        <li key={f.path}>
          <a className="rowbtn filerow" href={`/api/files/raw?path=${encodeURIComponent(f.path)}`} target="_blank" rel="noopener noreferrer"
            onClick={(e) => { if (fixtures) e.preventDefault(); }} aria-label={`${baseName(f.path)}, ${sizeText(f.size)}, opens in a new tab`}>
            <span className="projico"><svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20z" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinejoin="round" /><path d="M14 3.5V8h4" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinejoin="round" /></svg></span>
            <span className="grow">
              <span className="t" style={{ display: 'block' }}>{baseName(f.path)}</span>
              <span className="s" style={{ display: 'block' }}>{sizeText(f.size)} · {new Date(f.mtime).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}{f.path.startsWith(files.folder) ? '' : ' · from an earlier conversation'}</span>
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}
