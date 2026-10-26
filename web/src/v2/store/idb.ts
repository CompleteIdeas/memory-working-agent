/**
 * The IndexedDB cache (v2 build, slice W1), through the `idb` package. One database per origin, `mwa-v2`, with the
 * stores listed in ./cache.ts. In-browser fixture mode (`?fixtures=1`) keeps nothing on the device (MemoryCache);
 * a cache filled by a fixture server is replaced by a snapshot when a real server answers (core.ts connect).
 */
import { openDB, type IDBPDatabase } from 'idb';
import { STORES, type CacheDb, type StoreName } from './cache';

export const DB_VERSION = 1;

export async function openIdbCache(name = 'mwa-v2'): Promise<CacheDb> {
  const db = await openDB(name, DB_VERSION, {
    upgrade(d) {
      for (const s of STORES) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
    },
    blocked() { /* an older tab holds the database open; it closes on its own reload */ },
  });
  return new IdbCache(db);
}

class IdbCache implements CacheDb {
  constructor(private db: IDBPDatabase) {}
  async all<T>(store: StoreName): Promise<T[]> { return (await this.db.getAll(store)) as T[]; }
  async put(store: StoreName, entries: { key: string; value: unknown }[]) {
    if (!entries.length) return;
    const tx = this.db.transaction(store, 'readwrite');
    for (const e of entries) void tx.store.put(e.value, e.key);
    await tx.done;
  }
  async remove(store: StoreName, keys: string[]) {
    if (!keys.length) return;
    const tx = this.db.transaction(store, 'readwrite');
    for (const k of keys) void tx.store.delete(k);
    await tx.done;
  }
  async clear(store: StoreName) { await this.db.clear(store); }
  async replace(store: StoreName, entries: { key: string; value: unknown }[]) {
    const tx = this.db.transaction(store, 'readwrite');
    void tx.store.clear();
    for (const e of entries) void tx.store.put(e.value, e.key);
    await tx.done;
  }
  async getMeta<T>(key: string) { return (await this.db.get('meta', key)) as T | undefined; }
  async setMeta(entries: Record<string, unknown>) { await this.put('meta', Object.entries(entries).map(([key, value]) => ({ key, value }))); }
  close() { this.db.close(); }
}
