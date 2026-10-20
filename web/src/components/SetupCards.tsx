import { useEffect, useState } from 'react';
import { getSetupCards, submitSetupCard, type SetupCard } from '../api';

/**
 * Setup cards (BL-62). When the person asks the agent to connect an account, the agent opens one of these; the
 * person types what the service needs here — a password, key or token never goes into the chat or to the model.
 * The server checks the values against the service before saving them, and never sends them back.
 */
export function SetupCards({ refresh }: { refresh: number }) {
  const [cards, setCards] = useState<SetupCard[]>([]);
  const [values, setValues] = useState<Record<string, Record<string, string>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<Record<string, { ok: boolean; message: string }>>({});

  useEffect(() => {
    let alive = true;
    const load = () => getSetupCards().then((c) => { if (alive) setCards(c); });
    load();
    const iv = setInterval(load, 5000);
    return () => { alive = false; clearInterval(iv); };
  }, [refresh]);

  async function send(card: SetupCard, cancel = false) {
    setBusy(card.id);
    const r = await submitSetupCard(card.id, cancel ? null : (values[card.id] ?? {}));
    setNote((n) => ({ ...n, [card.id]: r }));
    if (r.ok || cancel) setValues((v) => ({ ...v, [card.id]: {} })); // drop typed secrets from memory once used
    setBusy(null);
    setCards(await getSetupCards());
  }

  const waiting = cards.filter((c) => c.status === 'waiting');
  const finished = cards.filter((c) => c.status !== 'waiting' && note[c.id]);
  if (!waiting.length && !finished.length) return null;
  return (
    <div className="max-w-3xl mx-auto mb-3 space-y-2 max-h-[55vh] overflow-y-auto" aria-live="polite">
      {waiting.map((c) => (
        <form
          key={c.id}
          onSubmit={(e) => { e.preventDefault(); send(c); }}
          className="rounded-[3px] border border-signal bg-surface px-3.5 py-3"
          autoComplete="off"
        >
          <div className="mono text-[11px] text-signal uppercase tracking-[0.14em] mb-1">connect · {c.name}</div>
          <p className="text-[13.5px] leading-snug whitespace-pre-wrap break-words text-dim mb-2">{c.howTo}</p>
          <div className="space-y-2">
            {c.fields.map((f) => (
              <label key={f.env} className="block">
                <span className="text-[13px]">{f.label}{f.optional ? ' (optional)' : ''}</span>
                <input
                  type={f.secret ? 'password' : 'text'}
                  autoComplete={f.secret ? 'new-password' : 'off'}
                  spellCheck={false}
                  value={values[c.id]?.[f.env] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [c.id]: { ...(v[c.id] ?? {}), [f.env]: e.target.value } }))}
                  className="mt-0.5 w-full rounded-[3px] border border-line bg-bone px-2.5 py-1.5 text-[14px] mono"
                />
                {f.help && <span className="text-[12px] text-dim">{f.help}</span>}
              </label>
            ))}
          </div>
          <p className="text-[12px] text-dim mt-2">Goes straight to this app's own settings, not into the chat: the assistant never sees it.</p>
          {note[c.id] && !note[c.id].ok && <p className="text-[13px] text-signal mt-1.5 break-words">{note[c.id].message}</p>}
          <div className="flex flex-wrap items-center gap-2 mt-2.5">
            <button type="submit" disabled={busy === c.id} className="rounded-[3px] bg-signal text-white px-4 py-1.5 text-sm font-medium hover:opacity-90 disabled:opacity-50">
              {busy === c.id ? 'Checking…' : 'Connect'}
            </button>
            <button type="button" disabled={busy === c.id} onClick={() => send(c, true)} className="rounded-[3px] border border-line px-4 py-1.5 text-sm hover:border-signal disabled:opacity-50">
              Not now
            </button>
          </div>
        </form>
      ))}
      {finished.map((c) => (
        <div key={c.id} className={`text-[13.5px] break-words rounded-[3px] border px-3.5 py-2 ${c.status === 'done' ? 'border-line' : 'border-signal text-signal'}`}>
          <span className="mono text-[11px] uppercase tracking-[0.14em] mr-2">{c.name}</span>{c.message}
        </div>
      ))}
    </div>
  );
}
