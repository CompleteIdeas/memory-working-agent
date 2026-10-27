/**
 * "Not important" (v2 build, slice W3). For an email it is a small sheet: skip messages from this sender, from this
 * domain, or of this kind — offering only what the server can learn (not a free email domain like gmail.com; a kind
 * only when how a message is sent shows it). The server has the last word: a choice it refuses (400 freemail_domain,
 * kind_not_available) is shown in its own words, with "messages from <address>" suggested. Anything not from an email
 * just leaves the list. The receipt says what the new rule decides ("This will hide mail from 14 senders").
 */
import { useCallback, useState, type ReactNode } from 'react';
import type { ImportantItem } from '../../api/client';
import { useItemActions } from '../../store/react';
import { scopeChoice } from '../../store/important';
import type { NotImportantScope } from '../../store/core';
import { Sheet } from '../../shell/sheets';

export function useNotImportant(onDone?: (it: ImportantItem) => void): { request: (it: ImportantItem) => void; sheet: ReactNode } {
  const actions = useItemActions();
  const [target, setTarget] = useState<ImportantItem | null>(null);
  const [refusal, setRefusal] = useState<{ text: string; scope: NotImportantScope } | null>(null);
  const [busy, setBusy] = useState<NotImportantScope | 'none' | null>(null);

  const finish = useCallback(async (it: ImportantItem, scope?: NotImportantScope) => {
    setBusy(scope ?? 'none'); setRefusal(null);
    const r = await actions.notImportant(it, scope);
    setBusy(null);
    if (r.ok) {
      setTarget(null);
      if (r.message) actions.notice(r.message);
      onDone?.(it);
      return;
    }
    if (r.queued) { setTarget(null); onDone?.(it); return; } // offline: it waits in the outbox, the item is already gone
    if (scope && (r.code === 'freemail_domain' || r.code === 'kind_not_available' || r.code === 'bad_scope')) { setRefusal({ text: r.message, scope }); return; }
    setTarget(null);
    actions.notice(r.message, 'error');
  }, [actions, onDone]);

  const request = useCallback((it: ImportantItem) => {
    const c = scopeChoice(it);
    if (!c.options.length) { void finish(it); return; } // not from an email: nothing to learn, it just leaves
    setRefusal(null); setTarget(it);
  }, [finish]);

  const c = target ? scopeChoice(target) : null;
  const sheet = (
    <Sheet id="notimp-dlg" titleId="notimp-title" title="Not important" open={!!target} onClose={() => { setTarget(null); setRefusal(null); }}>
      {target && c && (
        <div className="sheet-body notimp">
          <p className="soft">Skip messages like “{target.title}” from now on. Choose what I should leave out:</p>
          {refusal && <p className="refusal" role="alert">{refusal.text}</p>}
          <div className="scopelist" role="group" aria-label="What to skip">
            {c.options.map((o) => {
              const suggested = !!refusal && o.scope === 'sender';
              const refused = refusal?.scope === o.scope;
              return (
                <button key={o.scope} type="button" className={`vbtn scopebtn${suggested ? ' vbtn-primary' : ''}`} disabled={!!busy || refused}
                  aria-describedby={suggested ? 'notimp-suggest' : undefined} onClick={() => void finish(target, o.scope)}>
                  {o.label}{busy === o.scope ? '…' : ''}
                </button>
              );
            })}
          </div>
          {refusal && <p className="soft" id="notimp-suggest">Suggested: messages from {c.address}.</p>}
          {c.note && <p className="soft scopenote">{c.note}</p>}
          <p className="receipt">It leaves your list now. You can undo a rule any time under “Your rules”.</p>
        </div>
      )}
    </Sheet>
  );
  return { request, sheet };
}
