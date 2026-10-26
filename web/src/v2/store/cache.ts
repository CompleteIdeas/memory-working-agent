/**
 * The device cache the v2 store keeps (v2 build, slice W1): what the app shows when it opens offline, and the
 * outbox of actions made while offline. The browser uses IndexedDB (./idb.ts); tests use MemoryCache.
 *
 * Stores (one IndexedDB object store each):
 *   today     the Today composite (A10; reserved, empty until that slice lands)
 *   items     the Important list (A9; reserved, empty until /items exists)
 *   calendar  CalendarItem by id
 *   projects  Project by id
 *   threads   { projectId, turns } — the last 50 turns of each project's thread
 *   jobs      Job by id
 *   meta      key/value: cursor, updatedAt, apiVersion, server, minClient
 *   outbox    queued actions (OutboxEntry by id), replayed in order
 * Mail bodies are never stored anywhere; mail headers stay in memory.
 */
export const STORES = ['today', 'items', 'calendar', 'projects', 'threads', 'jobs', 'meta', 'outbox'] as const;
export type StoreName = (typeof STORES)[number];

export interface CacheDb {
  all<T>(store: StoreName): Promise<T[]>;
  /** key/value pairs; values are stored as given (structured clone) */
  put(store: StoreName, entries: { key: string; value: unknown }[]): Promise<void>;
  remove(store: StoreName, keys: string[]): Promise<void>;
  clear(store: StoreName): Promise<void>;
  /** replace a whole store in one transaction (a /sync snapshot) */
  replace(store: StoreName, entries: { key: string; value: unknown }[]): Promise<void>;
  getMeta<T>(key: string): Promise<T | undefined>;
  setMeta(entries: Record<string, unknown>): Promise<void>;
  close(): void;
}

/** An in-memory cache: the tests' stand-in for IndexedDB, and the fallback when IndexedDB is unavailable
 *  (a private window, an insecure origin on some browsers). Values are cloned so callers cannot alias them. */
export class MemoryCache implements CacheDb {
  readonly data = new Map<StoreName, Map<string, unknown>>(STORES.map((s) => [s, new Map()]));
  private clone<T>(v: T): T { return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T); }
  async all<T>(store: StoreName): Promise<T[]> { return [...this.data.get(store)!.values()].map((v) => this.clone(v) as T); }
  async put(store: StoreName, entries: { key: string; value: unknown }[]) { const m = this.data.get(store)!; for (const e of entries) m.set(e.key, this.clone(e.value)); }
  async remove(store: StoreName, keys: string[]) { const m = this.data.get(store)!; for (const k of keys) m.delete(k); }
  async clear(store: StoreName) { this.data.get(store)!.clear(); }
  async replace(store: StoreName, entries: { key: string; value: unknown }[]) { await this.clear(store); await this.put(store, entries); }
  async getMeta<T>(key: string) { return this.clone(this.data.get('meta')!.get(key)) as T | undefined; }
  async setMeta(entries: Record<string, unknown>) { await this.put('meta', Object.entries(entries).map(([key, value]) => ({ key, value }))); }
  close() { /* nothing to release */ }
}
