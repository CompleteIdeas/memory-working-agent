/**
 * "All email" (v2 build, W1 frame, opened in W3): the plain mailbox one tap from Worth a look — sender, subject, one
 * line — headers only, never kept on the device. A row opens the reader.
 */
import { useMail, useMeta } from '../../store/react';
import { Back } from '../../shell/icons';
import { NEVER_SENDS } from './Reader';
import { CautionTag } from '../important/ItemRow';
import { showName } from '../../store/text';

const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const DAY = 86_400_000;
const rowTime = (ms: number, now: number) => {
  const d = new Date(ms), n = new Date(now);
  if (d.toDateString() === n.toDateString()) return clock(ms);
  if (now - ms < 6 * DAY) return d.toLocaleDateString('en-US', { weekday: 'short' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

export function AllEmail({ back, open, selected, now }: { back: () => void; open: (mailId: string) => void; selected?: string | null; now: number }) {
  const mail = useMail();
  const { updatedAt } = useMeta();
  const today = mail.headers.filter((m) => new Date(m.receivedAt).toDateString() === new Date(now).toDateString());
  const earlier = mail.headers.filter((m) => !today.includes(m));
  return (
    <>
      <button type="button" className="backbtn keep" onClick={back}><Back />Worth a look</button>
      <header className="vh"><div className="vh-text"><p className="vh-kicker">{updatedAt ? `Updated ${clock(updatedAt)}` : 'Your mail'}</p><h1>All email</h1>
        <p className="receipt">{mail.note || NEVER_SENDS}</p></div></header>
      {mail.loading && !mail.loaded && <p className="empty">Loading…</p>}
      {mail.loaded && !mail.connected && <p className="empty">No mail account is connected yet.</p>}
      {mail.error && !mail.loaded && <p className="empty">{mail.error}</p>}
      {([['Today', today], ['Earlier', earlier]] as const).map(([label, list]) => list.length > 0 && (
        <section key={label} aria-labelledby={`am-${label}`}>
          <h2 className="sh" id={`am-${label}`}>{label}</h2>
          <ul className="rows">
            {list.map((m) => (
              <li key={m.id}>
                <button type="button" className={`mailrow${m.unread ? ' unread' : ''}${selected === m.id ? ' on' : ''}`} onClick={() => open(m.id)}>
                  <span className="top"><span className="from">{showName(m.from.name) ?? m.from.addr ?? 'Unknown sender'}</span><span className="time">{rowTime(m.receivedAt, now)}</span></span>
                  {m.from.addr && showName(m.from.name) && <span className="addrline">{m.from.addr}</span>}
                  {m.caution && <CautionTag caution={m.caution} />}
                  <span className="subj" style={{ display: 'block' }}>{m.subject}</span>
                  {m.snippet && <span className="prev" style={{ display: 'block' }}>{m.snippet}</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
