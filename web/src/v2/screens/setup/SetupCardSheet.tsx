/**
 * Setup cards (v2 build, slice S6): your helper asked for a password or a key mid-task (to connect Gmail, Telegram, a
 * plug-in, or to keep a login in the vault). The classic page's SetupCards, in a sheet like the approval sheet.
 *
 * Opened (openSetupCard) from Today's "Needs you", the working sheet's "Needs a password or key" group, or Settings.
 * Each card says who asked and why, the steps, and has one field per value: secrets in password fields. What is typed
 * goes to the server once, is cleared from the screen at once, and never comes back. Filling one needs this computer
 * (admin); a paired phone sees the card and can close it. Words: ./words.ts. Server: /api/v1/setup/cards.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { newKey, type SetupCard } from '../../api/client';
import { useSetupCards, useStore } from '../../store/react';
import { Sheet } from '../../shell/sheets';
import { messageOf } from '../settings/useSettings';
import { cardAsk, cardStateLine } from './words';
import './setup.css';

const EVENT = 'mwa-open-setup-card';
export function openSetupCard(id: string | null): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { id } }));
}
export function useSetupCardOpener(onOpen: (id: string | null) => void): void {
  useEffect(() => {
    const h = (e: Event) => { const id = (e as CustomEvent<{ id?: unknown }>).detail?.id; onOpen(typeof id === 'string' && id ? id : null); };
    window.addEventListener(EVENT, h);
    return () => window.removeEventListener(EVENT, h);
  }, [onOpen]);
}

export function SetupCardSheet({ request, onClose }: { request: { id: string | null; at: number } | null; onClose: () => void }) {
  const { cards, waiting, canSubmit, reload } = useSetupCards();
  const [sel, setSel] = useState<string | null>(null);
  useEffect(() => { if (request) { setSel(request.id ?? (waiting.length === 1 ? waiting[0].id : null)); void reload(); } }, [request]);
  const card = sel ? cards.find((c) => c.id === sel) ?? null : null;
  return (
    <Sheet id="setup-dlg" titleId="setup-title" title="Your helper needs something" open={!!request} onClose={onClose}>
      <div className="sheet-body sc-body">
        {card ? <CardForm key={card.id} c={card} canSubmit={canSubmit} onBack={waiting.length > 1 ? () => setSel(null) : null} onDone={onClose} />
          : sel ? <p className="empty" role="status">This card is no longer there. Ask your helper to connect it again.</p>
            : waiting.length ? (
              <ul className="sclist">
                {waiting.map((c) => (
                  <li key={c.id}><button type="button" className="rowbtn" onClick={() => setSel(c.id)}>
                    <span className="grow"><span className="t">{c.name}</span><span className="s">{c.where} · {cardStateLine(c)}</span></span>
                  </button></li>
                ))}
              </ul>
            ) : <p className="empty" role="status">Nothing is waiting for a password or key.</p>}
      </div>
    </Sheet>
  );
}

function CardForm({ c, canSubmit, onBack, onDone }: { c: SetupCard; canSubmit: boolean; onBack: (() => void) | null; onDone: () => void }) {
  const store = useStore();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(c.state !== 'waiting' && c.message ? { text: c.message, error: c.state === 'failed' } : null);
  const waiting = c.state === 'waiting';
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const missing = c.fields.find((f) => !f.optional && !(values[f.name] ?? '').trim());
    if (missing) { setMsg({ text: `${missing.label} is needed.`, error: true }); return; }
    setBusy(true); setMsg(null);
    const sent = values;
    // what was typed leaves the screen now: secrets at once, the rest once it worked
    setValues(Object.fromEntries(c.fields.filter((f) => !f.secret).map((f) => [f.name, sent[f.name] ?? ''])));
    try {
      const r = await store.client.submitSetupCard(c.id, Object.fromEntries(Object.entries(sent).filter(([, v]) => v.trim())), { key: newKey() });
      setValues({});
      setMsg({ text: r.message, error: false });
      void store.loadSetupCards();
    } catch (err) {
      setMsg({ text: messageOf(err), error: true });
      void store.loadSetupCards();
    } finally { setBusy(false); }
  };
  const close = async () => {
    setBusy(true);
    try { const r = await store.client.cancelSetupCard(c.id, { key: newKey() }); setMsg({ text: r.message, error: false }); }
    catch (err) { setMsg({ text: messageOf(err), error: true }); }
    finally { setBusy(false); void store.loadSetupCards(); }
  };
  const done = !waiting;
  return (
    <article className="sccard" aria-labelledby={`sc-${c.id}`}>
      {onBack && <button type="button" className="backbtn" onClick={onBack}>All cards</button>}
      <h3 id={`sc-${c.id}`}>{c.name}</h3>
      <p className="s">Asked in {c.where} · {cardStateLine(c)}</p>
      {waiting && <p className="scask">{cardAsk(c)}</p>}
      {waiting && <div className="schow">{c.howTo.split('\n').map((l, i) => <p key={i}>{l}</p>)}</div>}
      {waiting && canSubmit && (
        <form className="setform" onSubmit={submit} aria-label={`Fill in ${c.name}`} autoComplete="off">
          {c.fields.map((f) => (
            <div key={f.name} className="scfield">
              <label htmlFor={`scf-${c.id}-${f.name}`}>{f.label}{f.optional ? ' (optional)' : ''}</label>
              <input id={`scf-${c.id}-${f.name}`} className="setinput" type={f.secret ? 'password' : 'text'} autoComplete={f.secret ? 'new-password' : 'off'}
                spellCheck={false} autoCapitalize="off" value={values[f.name] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                aria-describedby={f.help ? `scf-${c.id}-${f.name}-help` : undefined} />
              {f.help && <span className="s" id={`scf-${c.id}-${f.name}-help`}>{f.help}</span>}
            </div>
          ))}
          <p className="s">Checked first, then kept on the computer your helper runs on. It’s never shown again, and your helper never sees it.</p>
          <div className="acts">
            <button type="submit" className="vbtn vbtn-primary" disabled={busy}>{busy ? 'Checking…' : 'Save'}</button>
            <button type="button" className="vbtn vbtn-quiet" disabled={busy} onClick={() => void close()}>Not now</button>
          </div>
        </form>
      )}
      {waiting && !canSubmit && (
        <>
          <p className="adminnote">Passwords and keys are typed on your computer, or after signing in with your password, not on this phone.</p>
          <div className="acts"><button type="button" className="vbtn" disabled={busy} onClick={() => void close()}>Close the card</button></div>
        </>
      )}
      {msg && <p className={msg.error ? 'setnote error' : 'setnote'} role={msg.error ? 'alert' : 'status'}>{msg.text}</p>}
      {done && <div className="acts"><button type="button" className="vbtn vbtn-primary" onClick={onDone}>Done</button></div>}
    </article>
  );
}
