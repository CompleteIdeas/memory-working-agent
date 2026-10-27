/**
 * "Not now" on a Needs-you card or a double-booking (v2 build, slice W2): put away on THIS device for the rest of the
 * person's day ("OK, I'll bring it up again tomorrow."), as in the prototype. The server has no "not now"; this is a
 * per-device convenience in localStorage, one key per date (`mwa-v2-notnow:<YYYY-MM-DD>`, older dates pruned), so it
 * comes back tomorrow on its own and never hides anything for good.
 *
 * One id scheme on both screens (W2 review): a double-booking is `conflict:<conflict id>` whether it is put away from
 * Today's card or the Calendar's; any other card is its Needs-you id. The date is the person's (the Today's zone).
 */
import { useCallback, useState } from 'react';
import { useStore } from '../../store/react';

export const NOT_NOW_PREFIX = 'mwa-v2-notnow:';
/** The one id for a card: a double-booking by its conflict id, anything else by its Needs-you id. */
export const notNowId = (needOrConflictId: string): string => {
  const m = /^(?:need:)?conflict:(.+)$/.exec(needOrConflictId);
  return m ? `conflict:${m[1]}` : needOrConflictId;
};

export function readNotNow(date: string, ls: Pick<Storage, 'getItem'> | null = storage()): Set<string> {
  try { const v = JSON.parse(ls?.getItem(NOT_NOW_PREFIX + date) ?? 'null') as string[] | null; return new Set(Array.isArray(v) ? v : []); } catch { return new Set(); }
}
export function writeNotNow(date: string, id: string, ls: Storage | null = storage()): Set<string> {
  const next = readNotNow(date, ls); next.add(id);
  try {
    if (ls) {
      // keep only this day's key: yesterday's "not now" is over
      for (let i = ls.length - 1; i >= 0; i--) { const k = ls.key(i); if (k && k.startsWith(NOT_NOW_PREFIX) && k !== NOT_NOW_PREFIX + date) ls.removeItem(k); }
      ls.setItem(NOT_NOW_PREFIX + date, JSON.stringify([...next]));
    }
  } catch { /* private mode: for this visit only */ }
  return next;
}
function storage(): Storage | null { try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; } }

export function useNotNow(date: string) {
  const store = useStore();
  const [state, setState] = useState(() => ({ date, hidden: readNotNow(date) }));
  const hidden = state.date === date ? state.hidden : readNotNow(date);
  const isHidden = useCallback((id: string) => hidden.has(notNowId(id)), [hidden]);
  const hide = useCallback((id: string, say?: string) => {
    setState({ date, hidden: writeNotNow(date, notNowId(id)) });
    if (say) store.notice(say);
  }, [date, store]);
  return { hidden, isHidden, hide };
}
