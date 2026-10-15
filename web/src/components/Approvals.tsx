import { useEffect, useState } from 'react';
import { getApprovals, decideApproval, type PendingApproval } from '../api';

function timeLeft(s: number): string {
  if (s >= 3600) return `${Math.round(s / 3600)}h`;
  if (s >= 60) return `${Math.round(s / 60)}m`;
  return `${s}s`;
}

/**
 * Approvals waiting for the person (BL-03). The model can stage an action but never approve it:
 * this panel and Telegram's Approve button are the only ways a staged action runs. The preview is
 * rendered as text, never markup, so a preview can't restyle itself into something it isn't.
 */
export function Approvals({ refresh }: { refresh: number }) {
  const [items, setItems] = useState<PendingApproval[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    let alive = true;
    const load = () => getApprovals().then((a) => { if (alive) setItems(a); });
    load();
    const iv = setInterval(load, 15000);
    return () => { alive = false; clearInterval(iv); };
  }, [refresh]);

  async function decide(id: string, approve: boolean) {
    setBusy(id);
    const r = await decideApproval(id, approve);
    setMsg(r.message.slice(0, 300));
    setBusy(null);
    setItems(await getApprovals());
  }

  if (!items.length && !msg) return null;
  return (
    // Capped so several waiting items can't cover the conversation on a phone; the list scrolls.
    <div className="max-w-3xl mx-auto mb-3 space-y-2 max-h-[45vh] overflow-y-auto" aria-live="polite">
      {items.map((a) => (
        <div key={a.id} className="rounded-[3px] border border-signal bg-surface px-3.5 py-3">
          <div className="mono text-[11px] text-signal uppercase tracking-[0.14em] mb-1">
            needs your approval · {a.kind === 'captured-policy' ? 'standing preference' : a.tool}
          </div>
          <p className="text-[14.5px] leading-snug whitespace-pre-wrap break-words max-h-40 overflow-y-auto">{a.summary}</p>
          {a.tainted && (
            <p className="text-[13px] text-signal mt-1.5">
              Proposed by a run that read outside content (an email, a web page or a file). Make sure it is what you want.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2 mt-2.5">
            <button
              disabled={busy === a.id}
              onClick={() => decide(a.id, true)}
              className="rounded-[3px] bg-signal text-white px-4 py-1.5 text-sm font-medium hover:opacity-90 disabled:opacity-50"
            >
              Approve
            </button>
            <button
              disabled={busy === a.id}
              onClick={() => decide(a.id, false)}
              className="rounded-[3px] border border-line px-4 py-1.5 text-sm hover:border-signal disabled:opacity-50"
            >
              Decline
            </button>
            <span className="mono text-[11px] text-dim">expires in {timeLeft(a.expiresInSec)}</span>
          </div>
        </div>
      ))}
      {msg && (
        <div className="mono text-[12px] text-dim flex items-baseline gap-2">
          <span className="break-words min-w-0">{msg}</span>
          <button onClick={() => setMsg('')} className="underline hover:text-signal shrink-0">ok</button>
        </div>
      )}
    </div>
  );
}
