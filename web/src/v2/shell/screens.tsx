/**
 * The four tabs and Settings as W1 frames (v2 build, slice W1). Each shows the prototype's heading and layout with
 * what the store already has (the day's calendar, the projects and their threads, the plain mailbox); the full
 * screens come in W2 (Today, Calendar), W3 (Important, mail), W4 (Projects, Ask) and W5 (Settings, first run).
 */
import { useState } from 'react';
import { useProjects, useThread } from '../store/react';
import { Important } from '../screens/important/Important';
import type { Project } from '../api/client';
import { Back, Chev, ProjectIcon, Spark } from './icons';

export { Important };
import type { AskAbout } from './sheets';

export type View = 'today' | 'calendar' | 'inbox' | 'projects' | 'settings' | 'plugins' | 'assistant' | 'connections';
export interface ScreenProps {
  desk: boolean; wide: boolean; go: (v: View) => void; ask: (a?: AskAbout) => void;
  /** W2: open the working sheet (a waiting job's card on Today) */
  openWork?: () => void;
  /** W4: what the screen has open (a project), so the Ask bar asks there; null when nothing is */
  onContext?: (c: AskAbout | null) => void;
}

// W2: Today and the Calendar are full screens now
export { Today } from '../screens/today/Today';
export { Calendar } from '../screens/calendar/Calendar';

export function Projects({ desk, ask }: ScreenProps) {
  const projects = useProjects();
  const [sel, setSel] = useState<string | null>(null);
  const p = projects.find((x) => x.id === sel) ?? null;
  const list = (
    <>
      <header className="vh"><div className="vh-text"><p className="vh-kicker">Your groupings</p><h1>Projects</h1></div></header>
      <ul className="rows">
        {projects.map((x) => (
          <li key={x.id}><button type="button" className={`rowbtn${p?.id === x.id ? ' on' : ''}`} onClick={() => setSel(x.id)}>
            <span className="projico"><ProjectIcon name={x.icon} /></span>
            <span className="grow"><span className="t" style={{ display: 'block' }}>{x.name}</span></span><Chev />
          </button></li>
        ))}
      </ul>
    </>
  );
  if (!desk) return p ? <ProjectPane p={p} back={() => setSel(null)} ask={ask} /> : list;
  return (
    <div className="cols cols-2">
      <div className="listcol">{list}</div>
      <div className="pane">{p ? <ProjectPane p={p} ask={ask} /> : <p className="empty" style={{ marginTop: 80 }}>Pick a project to see our conversation.</p>}</div>
    </div>
  );
}

function ProjectPane({ p, back, ask }: { p: Project; back?: () => void; ask: (a?: AskAbout) => void }) {
  const { turns, loaded } = useThread(p.id);
  return (
    <>
      {back && <button type="button" className="backbtn" onClick={back}><Back />Projects</button>}
      <header className="vh"><div className="vh-text"><p className="vh-kicker">Project</p><h1>{p.name}</h1></div></header>
      <button type="button" className="askbar" onClick={() => ask({ label: p.name, projectId: p.id })}><Spark />Ask about {p.name}</button>
      <section className="projthread" aria-labelledby="th-h"><h2 className="sh" id="th-h">Our conversation</h2>
        {!turns.length && <p className="empty" style={{ textAlign: 'left' }}>{loaded ? 'Nothing here yet.' : 'Loading…'}</p>}
        <div className="thread">
          {turns.map((t) => (
            <div key={t.id} className="thread">
              {t.message && <div className="msg-you">{t.message}</div>}
              {t.kind === 'running' ? <span className="typing" aria-label="Your helper is answering"><i /><i /><i /></span>
                : t.reply ? <div className="msg-h"><div className="who"><Spark size={16} />Your helper</div><div className="txt">{t.reply}</div>
                  {t.provenance.length > 0 && <p className="cross">using what I know from {t.provenance.map((x) => x.name).join(', ')}</p>}</div> : null}
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

// W5: Settings has its own screen (screens/settings)
export { Settings } from '../screens/settings/Settings';
// S1: Settings › Plug-ins, its own screen (?view=plugins)
export { Plugins } from '../screens/settings/Plugins';
// S2: Settings › Your assistant, its own screen (?view=assistant)
export { Assistant } from '../screens/settings/Assistant';
// S3: Settings › Connections, its own screen (?view=connections&at=google|outlook|telegram|tailscale)
export { Connections } from '../screens/settings/Connections';
