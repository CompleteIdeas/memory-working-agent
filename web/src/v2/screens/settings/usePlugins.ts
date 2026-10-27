/**
 * Settings › Plug-ins' data (v2 build, slice S1): the list from GET /plugins and every change through the typed
 * client, each with its own Idempotency-Key. Keys are write-only: what is typed goes to the server and is cleared
 * from the screen; the list only ever says whether a key is saved.
 *
 * The words and the grouping are plain functions, tested without React (tests/web-v2-s1.test.ts).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { SignInRequired, newKey, type CustomPlugin, type Me, type Plugin, type PluginList, type PluginReview } from '../../api/client';
import { useStore } from '../../store/react';
import { isAdmin, messageOf, type ActOutcome } from './useSettings';

export interface PluginGroups { on: Plugin[]; available: Plugin[]; custom: CustomPlugin[] }
/** On (the library ones turned on), Available (the rest of the library), Your own (added by hand or from npm). */
export function groupPlugins(list: PluginList): PluginGroups {
  return { on: list.plugins.filter((p) => p.on), available: list.plugins.filter((p) => !p.on), custom: list.custom };
}

/** The line under a plug-in about its keys. */
export function keyLine(p: Plugin): string | null {
  if (!p.keys.length) return null;
  if (p.missing.length) {
    const labels = p.keys.filter((k) => p.missing.includes(k.name)).map((k) => k.label);
    return `Needs your ${labels.join(' and ')} before it can turn on.`;
  }
  const saved = p.keys.filter((k) => k.saved);
  if (saved.length) return `${saved.map((k) => k.label).join(' and ')} saved.`;
  return `${p.keys.map((k) => k.label).join(' and ')}: optional.`;
}

export function verdictWords(v: PluginReview['verdict']): { title: string; tone: 'ok' | 'warn' | 'bad' } {
  if (v === 'safe') return { title: 'Looks safe', tone: 'ok' };
  if (v === 'caution') return { title: 'Be careful', tone: 'warn' };
  return { title: 'Dangerous', tone: 'bad' };
}

export function scanLine(r: PluginReview): string {
  if (!r.scan.ran) return `Its code wasn’t checked${r.scan.note ? ` (${r.scan.note})` : ''}.`;
  const files = r.scan.files ? `${r.scan.files} files checked` : 'Its code was checked';
  if (r.scan.checksum === 'mismatch') return `${files}. The download didn’t match what npm lists: don’t install it.`;
  if (r.scan.checksum === 'verified') return `${files}. The download matches what npm lists.`;
  return `${files}.`;
}

/** "weather-mcp@1.4.0" → "weather-mcp"; a hand-added one shows its id. */
export function customTitle(c: CustomPlugin): string {
  if (c.package) return c.package.replace(/@[^@/]+$/, '') || c.package;
  return c.id;
}

export interface PluginsData { me: Me | null; list: PluginList | null; loading: boolean; error: string | null }

export function usePlugins() {
  const store = useStore();
  const client = store.client;
  const [data, setData] = useState<PluginsData>({ me: null, list: null, loading: true, error: null });
  const reload = useCallback(async () => {
    try {
      const [me, list] = await Promise.all([client.getMe(), client.listPlugins()]);
      setData({ me, list, loading: false, error: null });
    } catch (e) {
      if (e instanceof SignInRequired) { store.signedOut(); return; }
      setData((d) => ({ ...d, loading: false, error: messageOf(e) }));
    }
  }, [client, store]);
  useEffect(() => { void reload(); }, [reload]);

  const actions = useMemo(() => {
    const act = async <T,>(run: (key: string) => Promise<T>, ok: (r: T) => string, after?: (r: T) => void): Promise<ActOutcome> => {
      try {
        const r = await run(newKey());
        after?.(r);
        return { ok: true, message: ok(r) };
      } catch (e) {
        if (e instanceof SignInRequired) { store.signedOut(); return { ok: false, message: e.message }; }
        return { ok: false, message: messageOf(e) };
      }
    };
    const replace = (p: Plugin) => setData((d) => (d.list ? { ...d, list: { ...d.list, plugins: d.list.plugins.map((x) => (x.id === p.id ? p : x)) } } : d));
    return {
      // the plug-in moves to the other group, so the word comes as a notice (the row it was on is gone)
      turnOn: (id: string) => act((key) => client.enablePlugin(id, { key }), (r) => r.message, (r) => { replace(r.plugin); store.notice(r.message, 'info'); }),
      turnOff: (id: string) => act((key) => client.disablePlugin(id, { key }), (r) => r.message, (r) => { replace(r.plugin); store.notice(r.message, 'info'); }),
      saveKeys: (id: string, keys: Record<string, string>) => act((key) => client.savePluginKeys(id, keys, { key }), (r) => r.message, (r) => replace(r.plugin)),
      remove: (id: string) => act((key) => client.removePlugin(id, { key }), (r) => r.message,
        () => setData((d) => (d.list ? { ...d, list: { ...d.list, custom: d.list.custom.filter((c) => c.id !== id) } } : d))),
      review: async (pkg: string): Promise<{ ok: true; review: PluginReview } | { ok: false; message: string }> => {
        try { return { ok: true, review: (await client.reviewPlugin(pkg, { key: newKey() })).review }; }
        catch (e) { if (e instanceof SignInRequired) store.signedOut(); return { ok: false, message: messageOf(e) }; }
      },
      approve: (pkg: string, acceptRisk: boolean) => act((key) => client.approvePlugin(pkg, acceptRisk, { key }), (r) => r.message, () => { void reload(); }),
    };
  }, [client, store, reload]);

  return { ...data, admin: isAdmin(data.me), reload, ...actions };
}
