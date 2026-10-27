/**
 * The Projects tab (v2 build, slice W4), as approved (prototype-v2 N07, N10/N11): the person's groupings, each with one
 * continuous conversation, its work and its files.
 *
 *   list   each project with its icon, what it is doing ("Working: gathering this week’s AI news", "Waiting for you: …")
 *          or its last activity, and a badge while something runs or waits; New project; archived ones under
 *          "Archived · N" with Restore.
 *   pane   "Project" · its name · Project options (Rename, Archive — General can't be archived) · "Ask about <name>"
 *          (the Ask sheet, sent to this project) · tabs Conversation · Work · Files.
 * Phone: the list, then the project full screen with a "Projects" back button. Desktop: list and pane side by side.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent } from 'react';
import { useJobMap, useNow, useProjectActions, useProjectMap, useProjects, useStore } from '../../store/react';
import type { Job, Project, Turn } from '../../api/client';
import { Back, Chev, ProjectIcon, Spark } from '../../shell/icons';
import type { ScreenProps } from '../../shell/screens';
import { ProjectThread } from './ProjectThread';
import { ProjectFiles, ProjectWork } from './ProjectWork';
import { activityText, projectStatus } from './logic';
import { useDismiss } from './useDismiss';
import './projects.css';

const ICONS = ['horse', 'home', 'spark', 'leaf', 'heart'] as const;

export function Projects({ desk, ask }: ScreenProps) {
  const projects = useProjects();
  const all = useProjectMap();
  const [sel, setSel] = useState<string | null>(() => (typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('project')));
  const p = sel ? all[sel] ?? null : null;
  // an archived project leaves the list; its pane closes (Restore brings it back)
  useEffect(() => { if (p?.archived) setSel(null); }, [p?.archived]);

  const list = <ProjectList projects={projects} selected={p?.id ?? null} onOpen={setSel} />;
  if (!desk) return p && !p.archived ? <ProjectPane key={p.id} p={p} back={() => setSel(null)} ask={ask} /> : list;
  return (
    <div className="cols cols-2">
      <div className="listcol">{list}</div>
      <div className="pane">
        {p && !p.archived ? <ProjectPane key={p.id} p={p} ask={ask} /> : <p className="empty" style={{ marginTop: 80 }}>Pick a project to see our conversation, its work and its files.</p>}
      </div>
    </div>
  );
}

function ProjectList({ projects, selected, onOpen }: { projects: Project[]; selected: string | null; onOpen: (id: string) => void }) {
  const jobs = useJobMap();
  const all = useProjectMap();
  const actions = useProjectActions();
  const now = useNow();
  const [adding, setAdding] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const archived = useMemo(() => Object.values(all).filter((x) => x.archived).sort((a, b) => a.name.localeCompare(b.name)), [all]);
  return (
    <>
      <header className="vh"><div className="vh-text"><p className="vh-kicker">Your groupings</p><h1>Projects</h1></div></header>
      <ul className="rows projrows">
        {projects.map((x) => <ProjectRow key={x.id} p={x} jobs={jobs} now={now} on={selected === x.id} onOpen={() => onOpen(x.id)} />)}
      </ul>
      {adding ? <NewProject onDone={(id) => { setAdding(false); if (id) onOpen(id); }} />
        : <button type="button" className="vbtn vbtn-quiet newproj" onClick={() => setAdding(true)}><Plus />New project</button>}
      {archived.length > 0 && (
        <section className="archived" aria-label="Archived projects">
          <button type="button" className="handledtoggle" aria-expanded={showArchived} onClick={() => setShowArchived((v) => !v)}>
            <span>Archived · {archived.length}</span><Chev />
          </button>
          {showArchived && (
            <ul className="skiplist">
              {archived.map((x) => (
                <li key={x.id} className="skiprow">
                  <span className="grow">{x.name}</span>
                  <button type="button" className="vbtn" onClick={() => void actions.restore(x)} aria-label={`Restore ${x.name}`}>Restore</button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}

function ProjectRow({ p, jobs, on, now, onOpen }: { p: Project; jobs: Record<string, Job>; on: boolean; now: number; onOpen: () => void }) {
  const latest = useLatestTurn(p.id);
  const status = projectStatus(p, Object.values(jobs), latest);
  const sub = status.line ?? activityText(latest?.ts ?? null, now);
  return (
    <li>
      <button type="button" className={`rowbtn${on ? ' on' : ''}`} aria-current={on ? 'true' : undefined} onClick={onOpen}>
        <span className="projico"><ProjectIcon name={p.icon} /></span>
        <span className="grow">
          <span className="t" style={{ display: 'block' }}>{p.name}</span>
          <span className="s" style={{ display: 'block' }}>{sub}</span>
        </span>
        {status.badge && <span className={`pbadge ${status.badge.tone}`}>{status.badge.text}</span>}
        <Chev />
      </button>
    </li>
  );
}

/** The latest turn the store holds for a project: the list only peeks at what sync brought (it loads no thread). */
function useLatestTurn(projectId: string): Turn | null {
  const store = useStore();
  const get = () => store.getState().threads[projectId];
  const turns = useSyncExternalStore(store.subscribe, get, get);
  return turns && turns.length ? turns[turns.length - 1] : null;
}

function NewProject({ onDone }: { onDone: (id: string | null) => void }) {
  const actions = useProjectActions();
  const [name, setName] = useState('');
  const [icon, setIcon] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) { setError('Give it a name.'); return; }
    if (n.length > 60) { setError('Keep the name under 60 letters.'); return; }
    setBusy(true);
    const r = await actions.create(n, icon);
    setBusy(false);
    if (r.ok) onDone((r.data as { project?: Project } | undefined)?.project?.id ?? null);
    else if (r.queued) onDone(null);
    else setError(r.message);
  };
  return (
    <form className="card projform" onSubmit={(e) => void submit(e)} noValidate>
      <label htmlFor="np-name" className="fl">New project</label>
      <input ref={input} id="np-name" className="textin" value={name} maxLength={60} placeholder="Eventing, Family & school…" onChange={(e) => { setName(e.target.value); setError(null); }} aria-invalid={!!error} aria-describedby={error ? 'np-err' : undefined} />
      <fieldset className="iconpick">
        <legend className="fl">Icon</legend>
        {[null, ...ICONS].map((i) => (
          <label key={i ?? 'none'} className={`iconopt${icon === i ? ' on' : ''}`}>
            <input type="radio" name="np-icon" className="sr-only" checked={icon === i} onChange={() => setIcon(i)} />
            <span className="projico" aria-hidden="true"><ProjectIcon name={i} /></span>
            <span className="sr-only">{i ?? 'A plain page'}</span>
          </label>
        ))}
      </fieldset>
      {error && <p className="ask-note error" id="np-err" role="alert">{error}</p>}
      <div className="acts">
        <button type="submit" className="vbtn vbtn-primary" disabled={busy}>Create</button>
        <button type="button" className="vbtn vbtn-quiet" onClick={() => onDone(null)}>Cancel</button>
      </div>
    </form>
  );
}

type Tab = 'conversation' | 'work' | 'files';

function ProjectPane({ p, back, ask }: { p: Project; back?: () => void; ask: ScreenProps['ask'] }) {
  const jobs = useJobMap();
  const [tab, setTab] = useState<Tab>('conversation');
  const [menu, setMenu] = useState(false);
  const menuRef = useDismiss<HTMLDivElement>(menu, () => setMenu(false));
  const [renaming, setRenaming] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const actions = useProjectActions();
  const working = useMemo(() => Object.values(jobs).filter((j) => !j.archived && j.projectId === p.id && ['working', 'continuing', 'waiting', 'partly_done'].includes(j.status.state)), [jobs, p.id]);
  const tabs: { id: Tab; label: string }[] = [{ id: 'conversation', label: 'Conversation' }, { id: 'work', label: 'Work' }, { id: 'files', label: 'Files' }];
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const onKey = (e: KeyboardEvent, i: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length].id;
    setTab(next); tabRefs.current[next]?.focus();
  };
  return (
    <div className="projpane">
      {back && <button type="button" className="backbtn" onClick={back}><Back />Projects</button>}
      <header className="vh projhead">
        <div className="vh-text"><p className="vh-kicker">Project</p>
          {renaming ? <Rename p={p} onDone={() => setRenaming(false)} /> : <h1>{p.name}</h1>}
        </div>
        <div className="menuwrap" ref={menuRef}>
          <button type="button" className="iconbtn" aria-label="Project options" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}><More /></button>
          {menu && (
            <div className="menu" role="menu" aria-label="Project options" onKeyDown={(e) => { if (e.key === 'Escape') setMenu(false); }}>
              <button type="button" role="menuitem" autoFocus onClick={() => { setMenu(false); setRenaming(true); }}>Rename</button>
              {!p.general && <button type="button" role="menuitem" onClick={() => { setMenu(false); setConfirmArchive(true); }}>Archive</button>}
            </div>
          )}
        </div>
      </header>
      {confirmArchive && (
        <div className="card confirm" role="alertdialog" aria-labelledby="arch-q">
          <p id="arch-q">Archive {p.name}? Its conversation and files are kept, and you can restore it from the list.</p>
          <div className="acts">
            <button type="button" className="vbtn vbtn-primary" onClick={async () => { setConfirmArchive(false); await actions.archive(p); }}>Archive</button>
            <button type="button" className="vbtn vbtn-quiet" onClick={() => setConfirmArchive(false)}>Keep it</button>
          </div>
        </div>
      )}
      <button type="button" className="askbar" onClick={() => ask({ label: p.name, projectId: p.id })}><Spark /><span>Ask about {p.name}</span></button>
      {working.length > 0 && (
        <>
          <h2 className="sh">Working on</h2>
          {working.map((j) => (
            <button key={j.id} type="button" className="workline" onClick={() => setTab('work')}>
              <span className={`dot${j.status.state === 'working' || j.status.state === 'continuing' ? '' : ' idle'}`} aria-hidden="true" />
              <span>{j.title} — {j.status.label}</span><Chev />
            </button>
          ))}
        </>
      )}
      <div className="projtabs" role="tablist" aria-label={`${p.name}`}>
        {tabs.map((t, i) => (
          <button key={t.id} ref={(el) => { tabRefs.current[t.id] = el; }} type="button" role="tab" id={`pt-${t.id}`} aria-selected={tab === t.id} aria-controls={`pp-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1} onClick={() => setTab(t.id)} onKeyDown={(e) => onKey(e, i)}>{t.label}</button>
        ))}
      </div>
      <div role="tabpanel" id={`pp-${tab}`} aria-labelledby={`pt-${tab}`} className="projpanel">
        {tab === 'conversation' && <ProjectThread p={p} />}
        {tab === 'work' && <ProjectWork p={p} />}
        {tab === 'files' && <ProjectFiles p={p} />}
      </div>
    </div>
  );
}

function Rename({ p, onDone }: { p: Project; onDone: () => void }) {
  const actions = useProjectActions();
  const [name, setName] = useState(p.name);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) { setError('Give it a name.'); return; }
    if (n === p.name) { onDone(); return; }
    const r = await actions.rename(p, n);
    if (r.ok || r.queued) onDone(); else setError(r.message);
  };
  return (
    <form className="renameform" onSubmit={(e) => void submit(e)} noValidate>
      <label htmlFor="rn-name" className="sr-only">New name for {p.name}</label>
      <input id="rn-name" className="textin big" value={name} maxLength={60} autoFocus onChange={(e) => { setName(e.target.value); setError(null); }}
        onKeyDown={(e) => { if (e.key === 'Escape') onDone(); }} aria-invalid={!!error} aria-describedby={error ? 'rn-err' : undefined} />
      <div className="acts">
        <button type="submit" className="vbtn vbtn-primary">Save</button>
        <button type="button" className="vbtn vbtn-quiet" onClick={onDone}>Cancel</button>
      </div>
      {error && <p className="ask-note error" id="rn-err" role="alert">{error}</p>}
    </form>
  );
}

export const Plus = () => <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth={2} strokeLinecap="round" /></svg>;
export const More = () => <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.8" fill="currentColor" /><circle cx="12" cy="12" r="1.8" fill="currentColor" /><circle cx="19" cy="12" r="1.8" fill="currentColor" /></svg>;
