/**
 * The v2 web app's entry (v2 build, slice W1). App.tsx loads it lazily when the v2 UI is chosen (`?ui=v2`, or
 * `mwa-ui=v2` in localStorage); its code and styles are a separate chunk the v1 UI never loads.
 *
 * Wiring: the typed client → the store (IndexedDB cache, live stream, outbox) → the shell.
 * Fixture mode: `?fixtures=1` runs the prototype's example day in the browser (no server needed); a server whose
 * /meta says `server: "fixtures"` (the Vite middleware, MWA_FIXTURES=1) is fixture mode too. Either way the clock is
 * frozen at the prototype's Monday, November 9, 2026, 9:10 AM, and a dashed "simulated" tag shows in the header.
 */
import { useEffect, useState } from 'react';
import './shell/v2.css';
import { MwaClient } from './api/client';
import { V2Store, type StreamFactory, type StreamLike } from './store/core';
import { MemoryCache, type CacheDb } from './store/cache';
import { openIdbCache } from './store/idb';
import { StoreProvider } from './store/react';
import { Shell } from './shell/Shell';

/** The prototype's clock (fixture-data.ts FIXTURE_NOW), kept here so the main chunk does not pull the example data. */
const FIXTURE_NOW = new Date(2026, 10, 9, 9, 10).getTime();

async function makeStore(): Promise<V2Store> {
  const q = new URLSearchParams(location.search);
  const inBrowser = q.get('fixtures') === '1';
  let frozen: number | null = inBrowser ? FIXTURE_NOW : null;
  const nowParam = q.get('now');
  if (nowParam && !Number.isNaN(Date.parse(nowParam))) frozen = Date.parse(nowParam);
  const now = () => frozen ?? Date.now();

  let client: MwaClient, stream: StreamFactory;
  if (inBrowser) {
    const fx = await import('./dev/fixtures');
    const server = new fx.FixtureServer(q.get('scenario') ?? 'N00');
    client = new MwaClient({ fetch: fx.fixtureFetch(server) });
    stream = (url) => new fx.FixtureEventSource(server, url) as unknown as StreamLike;
  } else {
    client = new MwaClient();
    stream = (url) => new EventSource(url, { withCredentials: true }) as unknown as StreamLike;
  }
  // in-browser fixtures start a fresh example world on every load, so they keep nothing on the device
  const cache = inBrowser ? new MemoryCache() : await openCache('mwa-v2');
  const store = new V2Store({ client, cache, stream, now, fixtures: inBrowser });
  // a server that is itself the fixture world (the Vite middleware) freezes the clock the same way
  const off = store.subscribe(() => {
    const m = store.getState().meta;
    if (m && m.server === 'fixtures' && frozen === null) { frozen = FIXTURE_NOW; off(); }
  });
  return store;
}

async function openCache(name: string): Promise<CacheDb> {
  try {
    if (typeof indexedDB === 'undefined') return new MemoryCache();
    return await Promise.race([openIdbCache(name), new Promise<never>((_, no) => setTimeout(() => no(new Error('IndexedDB timed out')), 3_000))]);
  } catch {
    return new MemoryCache(); // a private window or a blocked database: the app still works, just not offline
  }
}

function applyTheme() {
  const q = new URLSearchParams(location.search).get('theme');
  let t = q;
  if (!t) { try { t = localStorage.getItem('mwa-v2-theme'); } catch { t = null; } }
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  document.documentElement.classList.add('mwa-v2');
  document.documentElement.classList.remove('dark'); // v1's own dark class never applies here
  document.title = 'MWA';
}

export default function V2App() {
  const [store, setStore] = useState<V2Store | null>(null);
  useEffect(() => {
    applyTheme();
    let alive = true;
    void makeStore().then((s) => { if (alive) setStore(s); });
    return () => { alive = false; };
  }, []);
  if (!store) return <div className="v2app"><p className="empty" style={{ paddingTop: 80 }}>Opening…</p></div>;
  return <StoreProvider store={store}><Shell /></StoreProvider>;
}
