/**
 * Settings › Activity (v2 build, slice S5): the helper's recent runs, as the classic Activity log has them — what you
 * asked, in your words, when, how it ended, where (a project, a job, Telegram), the tools it used (by name), how long
 * it took and what it cost. Pasted keys and passwords are masked by the server; tool arguments never leave it.
 * Reading only: a paired phone sees the same list.
 */
import { Back } from '../../shell/icons';
import type { ScreenProps } from '../../shell/screens';
import { useNow } from '../../store/react';
import { runLine, toolWords, usd, useActivity, whenLine } from './useMemory';
import './settings.css';

export function Activity({ go }: ScreenProps) {
  const data = useActivity();
  const now = useNow(60_000);
  const v = data.view;
  return (
    <div className="col-main setpage actpage">
      <button type="button" className="backbtn keep" onClick={() => go('settings')}><Back />Settings</button>
      <header className="vh"><div className="vh-text"><p className="vh-kicker">Settings</p><h1>Activity</h1></div></header>
      <p className="plugintro">Everything I did lately: what you asked, how it went, and what it cost.</p>
      {data.loading && !v && <p className="empty">Loading…</p>}
      {data.error && !v && <div className="card"><p>{data.error}</p><div className="acts"><button type="button" className="vbtn" onClick={() => void data.reload()}>Try again</button></div></div>}
      {v && (
        <>
          {!v.runs.length && <div className="card"><p className="soft">Nothing yet. When you ask me something or a job runs, it shows here.</p></div>}
          {v.runs.length > 0 && (
            <>
              <p className="soft memcount">{v.runs.length} recent run{v.runs.length === 1 ? '' : 's'}, {usd(v.totalUsd)} together.</p>
              <ol className="card setcard runlist" aria-label="Recent runs, newest first">
                {v.runs.map((r, i) => (
                  <li className={`setrow col runrow ${r.outcome}`} key={`${r.at ?? 0}-${i}`}>
                    <span className="runtop">
                      <span className="rowtitle">{r.what}</span>
                      <span className="runwhen">{whenLine(r.at, now)}</span>
                    </span>
                    <span className={r.outcome === 'could-not' ? 's warnline' : 's'}>{runLine(r)}</span>
                    {r.tools.length > 0 && <span className="s">Used: {r.tools.map(toolWords).join(', ')}{r.toolCalls > r.tools.length ? ` (${r.toolCalls} times in all)` : ''}</span>}
                    {r.summary && <span className="s runsum">{r.summary}</span>}
                  </li>
                ))}
              </ol>
              {v.runs.length >= data.limit && data.limit < 200 && <div className="acts"><button type="button" className="vbtn" onClick={data.showMore}>Show more</button></div>}
            </>
          )}
        </>
      )}
    </div>
  );
}
