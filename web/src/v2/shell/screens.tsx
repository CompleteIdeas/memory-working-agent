/**
 * The four tabs and Settings as W1 frames (v2 build, slice W1). Each shows the prototype's heading and layout with
 * what the store already has (the day's calendar, the projects and their threads, the plain mailbox); the full
 * screens come in W2 (Today, Calendar), W3 (Important, mail), W4 (Projects, Ask) and W5 (Settings, first run).
 */
import { useMemo, useState } from 'react';
import { useCalendar, useMeta, useNow, useProjects, useStore, useThread } from '../store/react';
import { Important, ImportantBody } from '../screens/important/Important';
import type { CalendarItem, Project } from '../api/client';
import { Back, Chev, Person, ProjectIcon, Spark } from './icons';

export { Important };
import type { AskAbout } from './sheets';

export type View = 'today' | 'calendar' | 'inbox' | 'projects' | 'settings';
export interface ScreenProps {
  desk: boolean; wide: boolean; go: (v: View) => void; ask: (a?: AskAbout) => void;
  /** W4: what the screen has open (a project), so the Ask bar asks there; null when nothing is */
  onContext?: (c: AskAbout | null) => void;
}

const DAY = 86_400_000;
const startOfDay = (ms: number) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
const longDate = (ms: number) => new Date(ms).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const dayName = (ms: number) => new Date(ms).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const short = (ms: number) => { const d = new Date(ms); const h = d.getHours() % 12 || 12, m = d.getMinutes(); return `${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`; };
const ap = (ms: number) => (new Date(ms).getHours() >= 12 ? 'pm' : 'am');
/** "8:15–8:45am", "12:30–1:30pm", "11am–2pm" — the prototype's way of saying a time span */
const range = (a: number, b: number) => `${short(a)}${ap(a) !== ap(b) ? ap(a) : ''}–${short(b)}${ap(b)}`;
function greeting(now: number) { const h = new Date(now).getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; }

/** One day's events and drafts, in the prototype's agenda look (categories come with W2). */
function Agenda({ day }: { day: number }) {
  const store = useStore();
  const rangeQ = useMemo(() => ({ from: new Date(day), to: new Date(day + DAY) }), [day]);
  const { items } = useCalendar(rangeQ);
  const act = (kind: 'draft.confirm' | 'draft.remove', i: CalendarItem) => store.act(kind, { id: i.id }, `${kind === 'draft.confirm' ? 'Confirm' : 'Remove'} “${i.title}”`);
  if (!items.length) return <ul className="agenda" aria-label={dayName(day)}><li className="empty"><span className="big" aria-hidden="true">☀︎</span>Nothing planned. A free day!</li></ul>;
  return (
    <ul className="agenda" aria-label={dayName(day)}>
      {items.map((i) => {
        const s = i.allDay ? day : Date.parse(i.start), e = i.allDay ? day + DAY : Date.parse(i.end);
        const when = i.allDay ? 'All day' : clock(s);
        if (i.kind === 'draft') {
          return (
            <li key={i.id}><span className="when">{when}</span>
              <div className="evcard draft" role="group" aria-label={`Draft: ${i.title}`}>
                <span className="t">{i.title}</span><span className="s">{i.allDay ? 'All day' : range(s, e)}{i.location ? ` · ${i.location}` : ''}</span>
                <span className="draftline"><Spark size={16} />Draft from your helper</span>
                <span className="acts">
                  <button type="button" className="vbtn vbtn-primary" onClick={() => void act('draft.confirm', i)}>Confirm</button>
                  <button type="button" className="vbtn vbtn-quiet" onClick={() => void act('draft.remove', i)}>Remove</button>
                </span>
              </div>
            </li>
          );
        }
        return (
          <li key={i.id}><span className="when">{when}</span>
            <div className="evcard plain"><span className="t">{i.title}</span><span className="s">{i.allDay ? 'All day' : range(s, e)}{i.location ? ` · ${i.location}` : ''}</span></div>
          </li>
        );
      })}
    </ul>
  );
}

function SoonCard({ children }: { children: string }) {
  return <div className="card"><p className="placeholder">{children}</p></div>;
}

export function Today({ desk, wide, go }: ScreenProps) {
  const now = useNow();
  const today = startOfDay(now);
  const head = (
    <header className="vh"><div className="vh-text">
      <div className="kickrow"><p className="vh-kicker">{longDate(now)}</p>
        {!desk && <button type="button" className="avatar" aria-label="Settings" onClick={() => go('settings')}><Person /></button>}
      </div>
      <h1>{greeting(now)}</h1>
    </div></header>
  );
  const center = (
    <>
      {head}
      <section aria-labelledby="sh-today" style={{ marginTop: 20 }}><h2 className="sr-only" id="sh-today">Coming next</h2>
        <SoonCard>Coming next here: what needs you, what’s next and what I did for you.</SoonCard>
      </section>
      {!desk && (
        <section aria-labelledby="sh-next"><h2 className="sh" id="sh-next">On your calendar</h2><Agenda day={today} /></section>
      )}
      {!wide && (
        <section aria-labelledby="sh-worth"><h2 className="sh" id="sh-worth">Worth a look</h2><ImportantBody go={go} limit={desk ? undefined : 3} /></section>
      )}
    </>
  );
  if (!desk) return <div>{center}</div>;
  return (
    <div className="cols cols-today">
      <aside className="col-side inboxcol" aria-labelledby="ib-h">
        <h2 className="coltitle" id="ib-h">Worth a look <button type="button" className="linkish quietlink" onClick={() => go('inbox')}>All email</button></h2>
        {wide && <ImportantBody go={go} />}
      </aside>
      <div className="col-main">{center}</div>
      <aside className="col-side" aria-labelledby="cd-h">
        <h2 className="coltitle" id="cd-h">Your day <span className="soft">{new Date(now).toLocaleDateString('en-US', { weekday: 'short' })} {new Date(now).getDate()}</span></h2>
        <Agenda day={today} />
      </aside>
    </div>
  );
}

export function Calendar({ desk }: ScreenProps) {
  const now = useNow();
  const today = startOfDay(now);
  const end = today + 6 * DAY;
  const kicker = `${new Date(today).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}–${new Date(end).getMonth() === new Date(today).getMonth() ? new Date(end).getDate() : new Date(end).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}`;
  const body = (
    <>
      <header className="vh"><div className="vh-text"><p className="vh-kicker">{kicker}</p><h1>Calendar</h1></div></header>
      <div className="dayhead"><h2>{dayName(today)}</h2><span className="soft">Today</span></div>
      <Agenda day={today} />
    </>
  );
  return desk ? <div className="col-main calwide" style={{ margin: '0 auto' }}>{body}</div> : body;
}

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

export function Settings({ go }: ScreenProps) {
  const { meta, updatedAt, connection } = useMeta();
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('mwa-v2-theme') ?? 'auto'; } catch { return 'auto'; } });
  const pick = (t: string) => {
    setTheme(t);
    try { localStorage.setItem('mwa-v2-theme', t); } catch { /* private mode */ }
    if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
  };
  const classic = () => { try { localStorage.setItem('mwa-ui', 'v1'); } catch { /* */ } location.href = location.pathname; };
  return (
    <>
      <button type="button" className="backbtn" onClick={() => go('today')}><Back />Today</button>
      <header className="vh"><div className="vh-text"><p className="vh-kicker">This device</p><h1>Settings</h1></div></header>
      <h2 className="sh" id="th-h">Look</h2>
      <div className="seg" role="radiogroup" aria-labelledby="th-h">
        {['light', 'dark', 'auto'].map((t) => (
          <button key={t} type="button" role="radio" aria-checked={theme === t} onClick={() => pick(t)}>{t[0].toUpperCase() + t.slice(1)}</button>
        ))}
      </div>
      <h2 className="sh">The app</h2>
      <div className="card">
        <div className="setrow"><span className="grow">Your helper<span className="s" style={{ display: 'block' }}>{meta ? `Version ${meta.server} · API ${meta.api}` : 'Not reached yet'}</span></span></div>
        <div className="setrow"><span className="grow">Last updated<span className="s" style={{ display: 'block' }}>{updatedAt ? `${new Date(updatedAt).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}${connection === 'live' ? ' · live' : ''}` : 'Not yet'}</span></span></div>
        <div className="setrow"><span className="grow">The new app is a preview<span className="s" style={{ display: 'block' }}>Switch back to the app you know at any time.</span></span>
          <button type="button" className="vbtn" onClick={classic}>Use the current app</button></div>
      </div>
      <p className="weekly">Devices, connections and first-run setup come next.</p>
    </>
  );
}
