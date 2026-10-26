/**
 * Mail headers (v2 build, slice A8, 2026-10-26): what is in the person's inbox, as headers only — who, subject, a
 * one-line snippet, when, read or not, labels, list headers. Enough for "All email" and for triage (A9).
 *
 * Mail BODIES are never stored here, nor on the phone: the reader fetches a body from the provider on demand and keeps
 * it only in an in-process cache (src/sync/mail.ts). Every change to a header records an event in the same
 * transaction, which drives /api/v1/stream and /sync (collection `mail`).
 *
 * `sync_state` is shared with the calendar sync (slice A7, built in parallel): the same CREATE TABLE IF NOT EXISTS
 * with identical columns, so whichever migration runs first creates it and the other is a no-op.
 */
import { appDb, recordEvent, registerMigrations, type AppDb } from './db.js';

export type MailProviderKind = 'gmail' | 'imap' | 'outlook';

registerMigrations([{
  name: '005-mail',
  sql: `
    CREATE TABLE IF NOT EXISTS mail_headers (
      account TEXT NOT NULL, provider TEXT NOT NULL CHECK (provider IN ('gmail','imap','outlook')), provider_id TEXT NOT NULL,
      thread_id TEXT, from_name TEXT, from_addr TEXT, subject TEXT, snippet TEXT, received_at INTEGER NOT NULL,
      unread INTEGER NOT NULL DEFAULT 0, labels TEXT NOT NULL DEFAULT '[]', list_id TEXT, has_unsub INTEGER NOT NULL DEFAULT 0,
      msg_key TEXT NOT NULL, updated_seq INTEGER,
      PRIMARY KEY (account, provider_id));
    CREATE INDEX IF NOT EXISTS mail_headers_received ON mail_headers(received_at);
    CREATE INDEX IF NOT EXISTS mail_headers_key ON mail_headers(msg_key);
    CREATE TABLE IF NOT EXISTS sync_state (
      account TEXT NOT NULL, resource TEXT NOT NULL, cursor TEXT, window_from INTEGER, window_to INTEGER,
      last_ok INTEGER, last_error TEXT, needs_reconnect INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (account, resource));`,
}]);

export const SNIPPET_MAX = 200;
const RESOURCE = 'mail';

/** One message's header as a provider reports it. */
export interface HeaderIn {
  providerId: string;
  threadId: string | null;
  fromName: string | null;
  fromAddr: string | null;
  subject: string | null;
  snippet: string | null;
  receivedAt: number;
  unread: boolean;
  labels: string[];
  listId: string | null;
  hasUnsub: boolean;
  /** RFC 822 Message-ID (dedupe across accounts) */
  messageId: string | null;
}
/** A change to a header already cached (IMAP flags, a Graph delta that only carries isRead/categories). */
export interface HeaderPatch { providerId: string; unread?: boolean; labels?: string[] }

export interface SyncBatch {
  /** true: this is the whole window — anything cached for the account and not in `upserts` is gone */
  full: boolean;
  upserts: HeaderIn[];
  patches?: HeaderPatch[];
  deletes: string[];
  cursor: string | null;
  windowFrom: number;
  windowTo: number;
}

export interface MailRow {
  account: string; provider: MailProviderKind; provider_id: string; thread_id: string | null;
  from_name: string | null; from_addr: string | null; subject: string | null; snippet: string | null;
  received_at: number; unread: number; labels: string; list_id: string | null; has_unsub: number; msg_key: string;
  updated_seq: number | null;
}
export interface SyncStateRow {
  account: string; resource: string; cursor: string | null; window_from: number | null; window_to: number | null;
  last_ok: number | null; last_error: string | null; needs_reconnect: number;
}

// ── ids ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The API's id for a message: opaque, reversible, path-safe (a provider id may contain '/', '+' or '='). */
export function mailId(account: string, providerId: string): string {
  return 'm_' + Buffer.from(`${account}\n${providerId}`, 'utf8').toString('base64url');
}
export function parseMailId(id: string): { account: string; providerId: string } | null {
  if (!/^m_[A-Za-z0-9_-]{4,800}$/.test(id)) return null;
  const s = Buffer.from(id.slice(2), 'base64url').toString('utf8');
  const i = s.indexOf('\n');
  if (i <= 0 || i === s.length - 1) return null;
  const out = { account: s.slice(0, i), providerId: s.slice(i + 1) };
  return mailId(out.account, out.providerId) === id ? out : null; // canonical form only
}

// ── text hygiene for header fields (they are shown as-is) ───────────────────────────────────────────────────────

/** Control, zero-width, direction-override and soft-hyphen characters (built from code points, so the source holds none). */
export const INVISIBLE = invisibleChars();
function invisibleChars(): RegExp {
  const esc = (n: number) => `\\u${n.toString(16).padStart(4, '0')}`;
  const ranges: [number, number][] = [[0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x7f], [0xad, 0xad], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff, 0xfeff]];
  return new RegExp('[' + ranges.map(([a, b]) => (a === b ? esc(a) : `${esc(a)}-${esc(b)}`)).join('') + ']', 'g');
}
const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
/** One line of plain text: entities decoded (Gmail snippets carry them), invisible characters gone, links as hosts. */
export function cleanLine(s: string | null | undefined, max = 500): string {
  if (!s) return '';
  const t = String(s)
    .replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (m, e: string) => {
      const l = e.toLowerCase();
      if (l.startsWith('#x')) { const n = Number.parseInt(l.slice(2), 16); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
      if (l.startsWith('#')) { const n = Number.parseInt(l.slice(1), 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
      return ENTITY[l] ?? m;
    })
    .replace(INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .trim();
  return linksToHosts(t).slice(0, max);
}

/** The host a URL points at, without "www." — or null when it is not an http(s) link. */
export function hostOf(href: string): string | null {
  const h = href.trim();
  const withScheme = /^www\./i.test(h) ? `http://${h}` : h;
  if (!/^https?:\/\//i.test(withScheme)) return null;
  try { return new URL(withScheme).hostname.replace(/^www\./i, '').toLowerCase() || null; } catch { return null; }
}
/** Raw URLs in text become their host ("https://evil.example/track?id=1" → "evil.example"): never a clickable URL. */
export function linksToHosts(text: string): string {
  return text
    .replace(/<\s*((?:https?:\/\/|www\.)[^\s<>]+)\s*>/gi, (_m, u: string) => { const h = hostOf(u); return h ? `(${h})` : ''; })
    .replace(/\b(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi, (u) => {
      const tail = /[.,;:!?]+$/.exec(u)?.[0] ?? ''; // sentence punctuation after a link stays
      return (hostOf(u.slice(0, u.length - tail.length)) ?? '') + tail;
    });
}

/** "Name <a@b>" / "a@b" / "\"Name\" <a@b>" → its parts. */
export function parseAddress(s: string | null | undefined): { name: string | null; addr: string | null } {
  const v = String(s ?? '').trim();
  if (!v) return { name: null, addr: null };
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(v);
  if (m) return { name: m[1].trim() || null, addr: m[2].trim().toLowerCase() };
  const a = /[^\s<>"]+@[^\s<>"]+/.exec(v);
  return { name: a ? null : v, addr: a ? a[0].toLowerCase() : null };
}

/** The dedupe key: the Message-ID, else sender|subject|minute — as listUniqueMessages does. */
export function messageKey(h: Pick<HeaderIn, 'messageId' | 'fromAddr' | 'subject' | 'receivedAt'>): string {
  const id = (h.messageId ?? '').trim().replace(/^<|>$/g, '').toLowerCase();
  if (id) return `id:${id}`;
  return `h:${(h.fromAddr ?? '').toLowerCase()}|${(h.subject ?? '').trim().toLowerCase()}|${Math.floor(h.receivedAt / 60_000)}`;
}

// ── writes ──────────────────────────────────────────────────────────────────────────────────────────────────────

function rowFrom(account: string, provider: MailProviderKind, h: HeaderIn): Omit<MailRow, 'updated_seq'> {
  return {
    account, provider, provider_id: h.providerId, thread_id: h.threadId ?? null,
    from_name: cleanLine(h.fromName, 200) || null, from_addr: (h.fromAddr ?? '').trim().toLowerCase().slice(0, 320) || null,
    subject: cleanLine(h.subject, 500) || null, snippet: cleanLine(h.snippet, SNIPPET_MAX) || null,
    received_at: Math.round(h.receivedAt), unread: h.unread ? 1 : 0,
    labels: JSON.stringify([...new Set(h.labels.map(String))].slice(0, 50)),
    list_id: h.listId ? cleanLine(h.listId, 200) || null : null, has_unsub: h.hasUnsub ? 1 : 0, msg_key: messageKey(h),
  };
}
const SAME_FIELDS = ['provider', 'thread_id', 'from_name', 'from_addr', 'subject', 'snippet', 'received_at', 'unread', 'labels', 'list_id', 'has_unsub', 'msg_key'] as const;
const same = (a: Omit<MailRow, 'updated_seq'>, b: MailRow) => SAME_FIELDS.every((k) => a[k] === b[k]);

function getRow(d: AppDb, account: string, providerId: string): MailRow | undefined {
  return d.prepare('SELECT * FROM mail_headers WHERE account = ? AND provider_id = ?').get(account, providerId) as MailRow | undefined;
}
function put(d: AppDb, r: Omit<MailRow, 'updated_seq'>): void {
  const seq = recordEvent({ entity: 'mail', id: mailId(r.account, r.provider_id), payload: { key: r.msg_key } }, d);
  d.prepare(`INSERT INTO mail_headers (account, provider, provider_id, thread_id, from_name, from_addr, subject, snippet, received_at, unread, labels, list_id, has_unsub, msg_key, updated_seq)
             VALUES (@account, @provider, @provider_id, @thread_id, @from_name, @from_addr, @subject, @snippet, @received_at, @unread, @labels, @list_id, @has_unsub, @msg_key, @seq)
             ON CONFLICT (account, provider_id) DO UPDATE SET provider = excluded.provider, thread_id = excluded.thread_id, from_name = excluded.from_name,
               from_addr = excluded.from_addr, subject = excluded.subject, snippet = excluded.snippet, received_at = excluded.received_at,
               unread = excluded.unread, labels = excluded.labels, list_id = excluded.list_id, has_unsub = excluded.has_unsub,
               msg_key = excluded.msg_key, updated_seq = excluded.updated_seq`).run({ ...r, seq });
}
function drop(d: AppDb, row: MailRow): void {
  recordEvent({ entity: 'mail', id: mailId(row.account, row.provider_id), op: 'delete', payload: { key: row.msg_key } }, d);
  d.prepare('DELETE FROM mail_headers WHERE account = ? AND provider_id = ?').run(row.account, row.provider_id);
}

export interface ApplyResult { added: number; changed: number; removed: number }

/**
 * Apply one sync batch for an account in ONE transaction: headers, deletions, the window, and the account's sync
 * state. A header that did not change records no event (a sync every 15 minutes must not flood the stream).
 */
export function applySync(account: string, provider: MailProviderKind, b: SyncBatch, now = Date.now()): ApplyResult {
  const d = appDb();
  return d.transaction((): ApplyResult => {
    const out: ApplyResult = { added: 0, changed: 0, removed: 0 };
    const seen = new Set<string>();
    for (const h of b.upserts) {
      if (!h.providerId || !Number.isFinite(h.receivedAt)) continue;
      seen.add(h.providerId);
      if (h.receivedAt < b.windowFrom) continue; // outside the window: pruned below if cached
      const next = rowFrom(account, provider, h);
      const prev = getRow(d, account, h.providerId);
      if (prev && same(next, prev)) continue;
      put(d, next);
      if (prev) out.changed++; else out.added++;
    }
    for (const p of b.patches ?? []) {
      const prev = getRow(d, account, p.providerId);
      if (!prev) continue;
      seen.add(p.providerId);
      const next = { ...prev, ...(p.unread !== undefined ? { unread: p.unread ? 1 : 0 } : {}), ...(p.labels ? { labels: JSON.stringify([...new Set(p.labels.map(String))].slice(0, 50)) } : {}) };
      if (same(next, prev)) continue;
      const { updated_seq: _s, ...rest } = next;
      put(d, rest);
      out.changed++;
    }
    const gone = new Set(b.deletes);
    const cached = d.prepare('SELECT * FROM mail_headers WHERE account = ?').all(account) as MailRow[];
    for (const r of cached) {
      if (gone.has(r.provider_id) || (b.full && !seen.has(r.provider_id)) || r.received_at < b.windowFrom) { drop(d, r); out.removed++; }
    }
    d.prepare(`INSERT INTO sync_state (account, resource, cursor, window_from, window_to, last_ok, last_error, needs_reconnect)
               VALUES (?, ?, ?, ?, ?, ?, NULL, 0)
               ON CONFLICT (account, resource) DO UPDATE SET cursor = excluded.cursor, window_from = excluded.window_from,
                 window_to = excluded.window_to, last_ok = excluded.last_ok, last_error = NULL, needs_reconnect = 0`)
      .run(account, RESOURCE, b.cursor, b.windowFrom, b.windowTo, now);
    return out;
  }).immediate();
}

/** A sync failed. `reconnect`: the sign-in is no longer valid (invalid_grant, 401) — the person must reconnect. */
export function markSyncError(account: string, message: string, reconnect: boolean): void {
  appDb().prepare(`INSERT INTO sync_state (account, resource, last_error, needs_reconnect) VALUES (?, ?, ?, ?)
                   ON CONFLICT (account, resource) DO UPDATE SET last_error = excluded.last_error, needs_reconnect = excluded.needs_reconnect`)
    .run(account, RESOURCE, message.slice(0, 300), reconnect ? 1 : 0);
}
/** An account's mail sync state: its cursor, window, last success and whether it needs reconnecting. */
export function getSyncState(account: string): SyncStateRow | null {
  return (appDb().prepare('SELECT * FROM sync_state WHERE account = ? AND resource = ?').get(account, RESOURCE) as SyncStateRow | undefined) ?? null;
}
export function knownIds(account: string): string[] {
  return (appDb().prepare('SELECT provider_id FROM mail_headers WHERE account = ?').all(account) as { provider_id: string }[]).map((r) => r.provider_id);
}

// ── reads ───────────────────────────────────────────────────────────────────────────────────────────────────────

export function getMail(account: string, providerId: string): MailRow | null {
  return getRow(appDb(), account, providerId) ?? null;
}

/**
 * One row per message across accounts (the same email in Gmail and Outlook shows once): of the copies sharing a
 * dedupe key, the newest wins, ties broken by account then provider id — deterministic, so paging is stable.
 */
const CANONICAL = `NOT EXISTS (SELECT 1 FROM mail_headers o WHERE o.msg_key = h.msg_key AND (o.received_at, o.account, o.provider_id) > (h.received_at, h.account, h.provider_id))`;

export interface MailPageCursor { receivedAt: number; account: string; providerId: string }
export function listMail(o: { before?: MailPageCursor | null; limit: number }): MailRow[] {
  const where = [CANONICAL];
  const args: unknown[] = [];
  if (o.before) { where.push('(h.received_at, h.account, h.provider_id) < (?, ?, ?)'); args.push(o.before.receivedAt, o.before.account, o.before.providerId); }
  return appDb().prepare(`SELECT h.* FROM mail_headers h WHERE ${where.join(' AND ')} ORDER BY h.received_at DESC, h.account DESC, h.provider_id DESC LIMIT ?`)
    .all(...args, o.limit) as MailRow[];
}
/** The copy shown for a dedupe key (null when no copy is left). */
export function canonicalFor(key: string): MailRow | null {
  return (appDb().prepare(`SELECT h.* FROM mail_headers h WHERE h.msg_key = ? AND ${CANONICAL}`).get(key) as MailRow | undefined) ?? null;
}
/** The accounts a message is in (for "also in Outlook"). */
export function copiesOf(key: string): { account: string; provider_id: string }[] {
  return appDb().prepare('SELECT account, provider_id FROM mail_headers WHERE msg_key = ? ORDER BY account').all(key) as { account: string; provider_id: string }[];
}

/** The API shape (api/openapi.yaml MailHeader). */
export function apiMailHeader(r: MailRow) {
  let labels: string[] = [];
  try { labels = JSON.parse(r.labels); } catch { labels = []; }
  const copies = copiesOf(r.msg_key);
  return {
    id: mailId(r.account, r.provider_id), account: r.account, provider: r.provider, threadId: r.thread_id,
    from: { name: r.from_name, addr: r.from_addr }, subject: r.subject ?? '', snippet: r.snippet ?? '',
    receivedAt: r.received_at, unread: r.unread === 1, labels, listId: r.list_id, hasUnsub: r.has_unsub === 1,
    alsoIn: copies.filter((c) => c.account !== r.account).map((c) => c.account),
    updatedSeq: r.updated_seq ?? 0,
  };
}
export type ApiMailHeader = ReturnType<typeof apiMailHeader>;
