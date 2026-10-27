/**
 * "Not now" on a Needs-you card or a double-booking (v2 build, slice W2): put away on THIS device for the rest of the
 * day ("OK, I'll bring it up again tomorrow."), as in the prototype. The server has no "not now"; this is a per-device
 * convenience kept in localStorage by date, so it comes back tomorrow on its own and never hides anything for good.
 */
import { useCallback, useState } from 'react';
import { useStore } from '../../store/react';

const KEY = 'mwa-v2-notnow';
function read(date: string): Set<string> {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { date?: string; ids?: string[] } | null; return new Set(v?.date === date ? v.ids ?? [] : []); } catch { return new Set(); }
}

export function useNotNow(date: string) {
  const store = useStore();
  const [state, setState] = useState(() => ({ date, hidden: read(date) }));
  const hidden = state.date === date ? state.hidden : read(date);
  const hide = useCallback((id: string, say?: string) => {
    const next = new Set(read(date)); next.add(id);
    try { localStorage.setItem(KEY, JSON.stringify({ date, ids: [...next] })); } catch { /* private mode: for this visit only */ }
    setState({ date, hidden: next });
    if (say) store.notice(say);
  }, [date, store]);
  return { hidden, hide };
}
