/**
 * "Show them" (v2 build, slice W3): the mail left out of a group, plainly — who, the subject, why it was skipped — each
 * with "This was important" (POST /mail/{id}/important), which shows that sender from now on. The receipt is the
 * server's own ("Thanks — I'll show messages like this from The Batch.").
 */
import { useState } from 'react';
import type { ImportantGroup } from '../../api/client';
import { useItemActions, useSkipped } from '../../store/react';
import { GROUP_WHEN } from '../../store/important';
import { Sheet } from '../../shell/sheets';
import { CheckIcon } from './icons';
import { CautionTag } from './ItemRow';
import { showName } from '../../store/text';

export function SkippedSheet({ group, onClose }: { group: ImportantGroup | null; onClose: () => void }) {
  const sk = useSkipped(group);
  const actions = useItemActions();
  const [said, setSaid] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const shown = group ?? 'today';
  const title = `Skipped ${GROUP_WHEN[shown]} · ${sk.count}`;
  return (
    <Sheet id="skip-dlg" titleId="skip-title" title={title} open={!!group} onClose={() => { setSaid(null); onClose(); }}>
      <div className="sheet-body">
        <p className="soft">Newsletters, receipts and promotions I left out of your list. If one mattered, say so and I’ll show ones like it.</p>
        {said && <p className={said.error ? 'refusal' : 'donebanner'} role={said.error ? 'alert' : 'status'}>{!said.error && <CheckIcon />}{said.text}</p>}
        {sk.loading && !sk.loaded && <p className="empty">Loading…</p>}
        {sk.error && !sk.loaded && <p className="empty">{sk.error}</p>}
        {sk.loaded && !sk.rows.length && <p className="empty">Nothing else was left out.</p>}
        {sk.rows.length > 0 && (
          <ul className="skiplist">
            {sk.rows.map((r) => (
              <li key={r.mail.id} className="skiprow">
                <span className="grow">
                  <b>{showName(r.mail.from.name) ?? r.mail.from.addr ?? 'Unknown sender'}</b>
                  {r.mail.from.addr && showName(r.mail.from.name) && <span className="addrline">{r.mail.from.addr}</span>}
                  {r.mail.caution && <CautionTag caution={r.mail.caution} />}
                  <span className="soft skipsub">{r.mail.subject}</span>
                  <span className="soft skipwhy">{r.reason}</span>
                </span>
                <button type="button" className="vbtn vbtn-quiet" disabled={busy === r.mail.id}
                  onClick={async () => {
                    if (!group) return;
                    setBusy(r.mail.id); setSaid(null);
                    const res = await actions.markImportant(r, group);
                    setBusy(null);
                    setSaid(res.ok ? { text: res.message ?? 'Thanks — it’s on your list.', error: false } : { text: res.message, error: !res.queued });
                  }}>This was important</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Sheet>
  );
}
