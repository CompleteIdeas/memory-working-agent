/**
 * Getting going's data (v2 build, slice S6): GET /setup and every change through the typed client, each with its own
 * Idempotency-Key. While the inbox scan runs, it is read again every 1.5 s (and whenever the stream says it started
 * or ended). Values typed into a setup card or a database address go to the server and are cleared from the screen.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Conflict, SignInRequired, newKey, type FolderScan, type InboxScan, type Me, type SetupState } from '../../api/client';
import { useInboxSeq, useStore } from '../../store/react';
import { isAdmin, messageOf, type ActOutcome } from '../settings/useSettings';
import { inboxRunning } from './words';

/** A refusal that asks first (409 confirm_needed): its words are the question. */
export type Asked = { ok: false; ask: string };

export function useSetupState() {
  const store = useStore();
  const client = store.client;
  const [me, setMe] = useState<Me | null>(null);
  const [state, setState] = useState<SetupState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    try {
      const [m, s] = await Promise.all([client.getMe(), client.getSetup()]);
      setMe(m); setState(s); setError(null);
    } catch (e) {
      if (e instanceof SignInRequired) { store.signedOut(); return; }
      setError(messageOf(e));
    } finally { setLoading(false); }
  }, [client, store]);
  useEffect(() => { void reload(); }, [reload]);

  // the inbox scan: read again while it runs, and when the stream says it started or ended
  const seq = useInboxSeq();
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } void reload(); }, [seq, reload]);
  const running = inboxRunning(state?.inbox);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      client.getInboxScan().then((inbox) => setState((s) => (s ? { ...s, inbox } : s))).catch(() => { /* next time */ });
    }, 1500);
    return () => clearInterval(t);
  }, [running, client]);

  const actions = useMemo(() => {
    const fail = (e: unknown): { ok: false; message: string } => {
      if (e instanceof SignInRequired) store.signedOut();
      return { ok: false, message: messageOf(e) };
    };
    return {
      warm: async (): Promise<ActOutcome> => { try { const r = await client.warmMemory({ key: newKey() }); return { ok: true, message: r.message }; } catch (e) { return fail(e); } },
      scanFolder: async (path: string): Promise<{ ok: true; scan: FolderScan } | { ok: false; message: string }> => {
        try { return { ok: true, scan: await client.scanFolder(path, { key: newKey() }) }; } catch (e) { return fail(e); }
      },
      saveNotes: async (scanId: string, keep: { id: string; name?: string; text?: string }[]): Promise<ActOutcome> => {
        try { const r = await client.saveFolderNotes(scanId, keep, { key: newKey() }); return { ok: true, message: r.message }; } catch (e) { return fail(e); }
      },
      /** Without `confirmed` the server asks first: the answer is the question, with what it may cost. */
      startInbox: async (days: number, confirmed: boolean): Promise<ActOutcome | Asked> => {
        try {
          const r = await client.startInboxScan({ key: newKey(), days, confirmed });
          setState((s) => (s ? { ...s, inbox: r.scan } : s));
          return { ok: true, message: r.message };
        } catch (e) {
          if (e instanceof Conflict && e.code === 'confirm_needed') return { ok: false, ask: e.message };
          return fail(e);
        }
      },
      stopInbox: async (): Promise<ActOutcome> => {
        try { const r = await client.stopInboxScan({ key: newKey() }); setState((s) => (s ? { ...s, inbox: r.scan } : s)); return { ok: true, message: r.message }; }
        catch (e) { void reload(); return fail(e); }
      },
      saveStorage: async (kind: 'sqlite' | 'postgres', url?: string, bringMemory?: boolean): Promise<ActOutcome> => {
        try {
          const r = await client.saveStorage({ kind, ...(url ? { url } : {}), ...(bringMemory ? { bringMemory: true } : {}), confirmed: true }, { key: newKey() });
          setState((s) => (s ? { ...s, storage: r.storage } : s));
          return { ok: true, message: r.message };
        } catch (e) { return fail(e); }
      },
    };
  }, [client, store, reload]);

  return { me, state, error, loading, admin: isAdmin(me), reload, ...actions, inbox: state?.inbox as InboxScan | undefined };
}
