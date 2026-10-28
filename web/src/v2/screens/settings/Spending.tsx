/**
 * Settings › Spending (v2 build, slice S5): the detail behind "This month", as the classic Billing card has it — the
 * month so far with its tokens, the provider's balance where it says, the last 30 days as a chart (with the same
 * numbers as a table for screen readers and anyone who prefers one), the cost by model, the costliest conversations
 * and jobs (by name), and the calls as a CSV for an expense claim (on this computer, or signed in with the password).
 * The limits themselves stay on the Settings page.
 */
import { useState } from 'react';
import { Back } from '../../shell/icons';
import type { ScreenProps } from '../../shell/screens';
import type { SpendingDetail } from '../../api/client';
import { useNow } from '../../store/react';
import { Note, Section, said, type Said } from './Settings';
import { spendLine } from './useSettings';
import { balanceLine, barHeights, chartSummary, dayLabel, tokensLine, usd, useSpendingDetail } from './useMemory';
import './settings.css';

export function Spending({ go }: ScreenProps) {
  const data = useSpendingDetail();
  const now = useNow(60_000);
  const d = data.data?.detail;
  const m = data.data?.month;
  const [note, setNote] = useState<Said>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="col-main setpage spendpage">
      <button type="button" className="backbtn keep" onClick={() => go('settings')}><Back />Settings</button>
      <header className="vh"><div className="vh-text"><p className="vh-kicker">Settings</p><h1>Spending</h1></div></header>
      <p className="plugintro">What the AI calls cost, day by day and where it went. Change your limits on the Settings page.</p>
      {data.loading && !d && <p className="empty">Loading…</p>}
      {data.error && !d && <div className="card"><p>{data.error}</p><div className="acts"><button type="button" className="vbtn" onClick={() => void data.reload()}>Try again</button></div></div>}
      {d && (
        <>
          <Section id="sp-month" title={d.month.label}>
            <div className="card setcard">
              <p className="spendline"><b>{m ? spendLine(m) : `${usd(d.month.usd)} so far`}</b></p>
              <p className="soft">{d.month.calls} AI call{d.month.calls === 1 ? '' : 's'} · tokens: {tokensLine(d.month.tokens)}</p>
              {d.balance && <p>{balanceLine(d.balance, now)}</p>}
            </div>
          </Section>
          <Chart days={d.days} />
          {d.byModel.length > 0 && (
            <Section id="sp-models" title="By model this month">
              <div className="card setcard">
                {d.byModel.map((x) => (
                  <div className="setrow" key={x.model}>
                    <div className="grow"><span className="rowtitle addrmono">{x.model}</span><span className="s">{x.calls} call{x.calls === 1 ? '' : 's'} · {tokensLine(x.tokens)}</span></div>
                    <span className="amount">{usd(x.usd)}</span>
                  </div>
                ))}
              </div>
            </Section>
          )}
          {d.costliest.length > 0 && (
            <Section id="sp-top" title="Costliest this month">
              <div className="card setcard">
                {d.costliest.map((x, i) => (
                  <div className="setrow" key={`${x.label}-${i}`}>
                    <div className="grow"><span className="rowtitle">{x.label}</span><span className="s">{x.kind === 'job' ? 'A job' : x.kind === 'chat' ? 'A conversation' : 'Other work'} · {x.calls} call{x.calls === 1 ? '' : 's'}</span></div>
                    <span className="amount">{usd(x.usd)}</span>
                  </div>
                ))}
              </div>
            </Section>
          )}
          <Section id="sp-csv" title="For an expense claim">
            <div className="card setcard">
              {data.admin ? (
                <>
                  <p className="soft">One row per AI call for the last 30 days: when, which model, the tokens and the cost.</p>
                  <div className="acts"><button type="button" className="vbtn" disabled={busy} onClick={async () => { setBusy(true); setNote(null); setNote(said(await data.downloadCsv())); setBusy(false); }}>Download the last 30 days (CSV)</button></div>
                </>
              ) : <p className="soft">Download the calls as a spreadsheet on your computer, or after signing in with your password.</p>}
            </div>
            <Note said={note} />
          </Section>
        </>
      )}
    </div>
  );
}

/** The last 30 days as bars, one colour, the busiest day as tall as the box; the same numbers in a table below. */
function Chart({ days }: { days: SpendingDetail['days'] }) {
  const h = barHeights(days);
  const summary = chartSummary(days);
  const active = days.filter((x) => x.usd > 0);
  return (
    <Section id="sp-days" title="Last 30 days">
      <div className="card setcard">
        <figure className="spendchart">
          <div className="sbars" role="img" aria-label={`Spending by day. ${summary}`}>
            {days.map((x, i) => <span key={x.day} className={h[i] ? 'sbar' : 'sbar none'} style={{ height: `${h[i] || 2}%` }} title={`${dayLabel(x.day)}: ${usd(x.usd)}, ${x.calls} call${x.calls === 1 ? '' : 's'}`} />)}
          </div>
          <figcaption>
            <span className="axis"><span>{days.length ? dayLabel(days[0].day) : ''}</span><span>{days.length ? dayLabel(days[days.length - 1].day) : ''}</span></span>
            <span className="s">{summary}</span>
          </figcaption>
        </figure>
        {active.length > 0 && (
          <details className="daytable">
            <summary>Show the days as a table</summary>
            <table>
              <caption className="sr-only">Spending on each day with any, oldest first</caption>
              <thead><tr><th scope="col">Day</th><th scope="col">Spent</th><th scope="col">Calls</th></tr></thead>
              <tbody>{active.map((x) => <tr key={x.day}><th scope="row">{dayLabel(x.day)}</th><td>{usd(x.usd)}</td><td>{x.calls}</td></tr>)}</tbody>
            </table>
          </details>
        )}
      </div>
    </Section>
  );
}
