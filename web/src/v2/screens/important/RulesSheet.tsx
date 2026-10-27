/**
 * "Your rules" (v2 build, slice W3): what the person taught by tapping Not important or This was important, each with
 * what it decides in the recent mail now, and Remove (DELETE /triage/rules/{id}: that mail is sorted as usual again).
 * Their home is Settings › Your rules (W5); this sheet stays as the quick view from the Important list, with a link there.
 */
import { useState } from 'react';
import { useItemActions, useRules } from '../../store/react';
import { ruleEffectLine, ruleLine } from '../../store/important';
import { Sheet } from '../../shell/sheets';
import { CheckIcon } from './icons';

export function RulesSheet({ open, onClose, onOpenSettings }: { open: boolean; onClose: () => void; onOpenSettings?: () => void }) {
  const rules = useRules(open);
  const actions = useItemActions();
  const [said, setSaid] = useState<{ text: string; error: boolean } | null>(null);
  const when = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return (
    <Sheet id="rules-dlg" titleId="rules-title" title="Your rules" open={open} onClose={() => { setSaid(null); onClose(); }}>
      <div className="sheet-body">
        <p className="soft">What you taught me by marking things important or not. I only make rules from your taps, never from what a message says.</p>
        {said && <p className={said.error ? 'refusal' : 'donebanner'} role={said.error ? 'alert' : 'status'}>{!said.error && <CheckIcon />}{said.text}</p>}
        {rules.loading && !rules.loaded && <p className="empty">Loading…</p>}
        {rules.error && !rules.loaded && <p className="empty">{rules.error}</p>}
        {rules.loaded && !rules.list.length && <p className="empty">No rules yet. When you mark something not important, I remember it here.</p>}
        {rules.list.length > 0 && (
          <ul className="skiplist">
            {rules.list.map((r) => (
              <li key={r.id} className="skiprow">
                <span className="grow">
                  <b className="ruleline">{ruleLine(r)}</b>
                  <span className="soft skipsub">{ruleEffectLine(r)}</span>
                  <span className="soft skipwhy">Since {when(r.createdAt)}</span>
                </span>
                <button type="button" className="vbtn vbtn-quiet" onClick={async () => {
                  setSaid(null);
                  const res = await actions.deleteRule(r);
                  if (res.ok) setSaid({ text: res.message ?? 'Removed.', error: false });
                  else if (!res.queued) setSaid({ text: res.message, error: true });
                }}>Remove</button>
              </li>
            ))}
          </ul>
        )}
        {onOpenSettings && <p><button type="button" className="linkish quietlink" onClick={onOpenSettings}>Your rules in Settings</button></p>}
      </div>
    </Sheet>
  );
}
