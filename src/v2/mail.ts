/**
 * Mail headers (v2 build, slice A8, 2026-10-26): what is in the person's inbox, as headers only — who, subject, a
 * one-line snippet, when, read or not, labels, list headers. Enough for "All email" and for triage (A9).
 *
 * Mail BODIES are never stored here, nor on the phone: the reader fetches a body from the provider on demand and keeps
 * it only in an in-process cache (src/sync/mail.ts). Every change to a header records an event in the same
 * transaction, which drives /api/v1/stream and /sync (collection `mail`).
 *
 * Accounts are keyed 'provider:<address>' ('google:me@gmail.com', 'imap:me@gmail.com', 'outlook:me@outlook.com'),
 * the scheme the calendar sync (A7) uses; sync state lives in the shared sync_state table (src/v2/sync-state.ts).
 *
 * Dedupe (review of A8): the same email reaching two accounts is shown once. A Message-ID alone is not trusted —
 * anyone can copy one — so two rows are copies only when they are in DIFFERENT accounts, share the Message-ID, the
 * sender address and the subject, and arrived within five minutes of each other. Two rows in one account are never
 * collapsed.
 */
import { appDb, recordEvent, registerMigrations, type AppDb } from './db.js';
import { cleanLine, displayName, isAddrSpec, UNREADABLE_ADDRESS } from './mail-text.js';
import { phishingSignal } from './mail-trust.js';
import { recordSyncOk, deleteSyncState } from './sync-state.js';

export { cleanLine, linksToHosts, hostOf, parseAddress, parseAddressList, INVISIBLE } from './mail-text.js';
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
    CREATE INDEX IF NOT EXISTS mail_headers_key ON mail_headers(msg_key);`,
}, {
  // A9 review: the receiving server's authentication verdict for the From address ('pass' / 'fail' / NULL unknown),
  // read from Authentication-Results at sync time (src/v2/mail-trust.ts authResult). Triage trusts a known contact
  // only with it.
  name: '009-mail-auth',
  sql: `ALTER TABLE mail_headers ADD COLUMN auth TEXT CHECK (auth IS NULL OR auth IN ('pass','fail'));`,
}]);

export const SNIPPET_MAX = 200;
export const MAIL_RESOURCE = 'mail';
/** Copies in two accounts arrive at slightly different times; further apart than this they are two messages. */
export const COPY_WINDOW_MS = 5 * 60_000;

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
  /** RFC 822 Message-ID (dedupe across accounts, with the sender, subject and time) */
  messageId: string | null;
  /** the receiving server's authentication verdict for the From address (Authentication-Results), when it gives one */
  auth?: 'pass' | 'fail' | null;
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
  updated_seq: number | null; auth?: 'pass' | 'fail' | null;
}
export type { SyncStateRow } from './sync-state.js';

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

/** A sender address as stored: a plain addr-spec, lower-cased, or null. */
export function cleanAddr(a: string | null | undefined): string | null {
  const v = String(a ?? '').trim();
  return v && isAddrSpec(v) ? v.toLowerCase() : null;
}

/**
 * The dedupe key: Message-ID + sender address + subject (ASCII-lower-cased, so SQLite and JS agree). A message
 * with no readable sender gets a key of its own and is never collapsed with anything.
 */
export function messageKey(account: string, h: Pick<HeaderIn, 'providerId' | 'messageId' | 'fromAddr' | 'subject'>): string {
  const from = cleanAddr(h.fromAddr);
  if (!from) return `u:${account}\n${h.providerId}`;
  const id = (h.messageId ?? '').trim().replace(/^<|>$/g, '').toLowerCase();
  const subj = cleanLine(h.subject, 500).replace(/[A-Z]/g, (c) => c.toLowerCase());
  return `${id ? `id:${id}` : 'h:'}\n${from}\n${subj}`;
}

// ── writes ──────────────────────────────────────────────────────────────────────────────────────────────────────

function rowFrom(account: string, provider: MailProviderKind, h: HeaderIn): Omit<MailRow, 'updated_seq'> {
  const addr = cleanAddr(h.fromAddr);
  const name = cleanLine(h.fromName, 200) || (addr || !h.fromAddr ? null : UNREADABLE_ADDRESS);
  return {
    account, provider, provider_id: h.providerId, thread_id: h.threadId ? cleanLine(h.threadId, 200) || null : null,
    from_name: name, from_addr: addr,
    subject: cleanLine(h.subject, 500) || null, snippet: cleanLine(h.snippet, SNIPPET_MAX) || null,
    received_at: Math.round(h.receivedAt), unread: h.unread ? 1 : 0,
    labels: JSON.stringify([...new Set(h.labels.map((l) => cleanLine(String(l), 100)).filter(Boolean))].slice(0, 50)),
    list_id: h.listId ? cleanLine(h.listId, 200) || null : null, has_unsub: h.hasUnsub ? 1 : 0, msg_key: messageKey(account, h),
    auth: h.auth === 'pass' || h.auth === 'fail' ? h.auth : null,
  };
}
const SAME_FIELDS = ['provider', 'thread_id', 'from_name', 'from_addr', 'subject', 'snippet', 'received_at', 'unread', 'labels', 'list_id', 'has_unsub', 'msg_key', 'auth'] as const;
const same = (a: Omit<MailRow, 'updated_seq'>, b: MailRow) => SAME_FIELDS.every((k) => a[k] === b[k]);

function getRow(d: AppDb, account: string, providerId: string): MailRow | undefined {
  return d.prepare('SELECT * FROM mail_headers WHERE account = ? AND provider_id = ?').get(account, providerId) as MailRow | undefined;
}
function put(d: AppDb, r: Omit<MailRow, 'updated_seq'>, prevKey?: string): void {
  const seq = recordEvent({ entity: 'mail', id: mailId(r.account, r.provider_id), payload: { key: r.msg_key, ...(prevKey && prevKey !== r.msg_key ? { prevKey } : {}) } }, d);
  d.prepare(`INSERT INTO mail_headers (account, provider, provider_id, thread_id, from_name, from_addr, subject, snippet, received_at, unread, labels, list_id, has_unsub, msg_key, auth, updated_seq)
             VALUES (@account, @provider, @provider_id, @thread_id, @from_name, @from_addr, @subject, @snippet, @received_at, @unread, @labels, @list_id, @has_unsub, @msg_key, @auth, @seq)
             ON CONFLICT (account, provider_id) DO UPDATE SET provider = excluded.provider, thread_id = excluded.thread_id, from_name = excluded.from_name,
               from_addr = excluded.from_addr, subject = excluded.subject, snippet = excluded.snippet, received_at = excluded.received_at,
               unread = excluded.unread, labels = excluded.labels, list_id = excluded.list_id, has_unsub = excluded.has_unsub,
               msg_key = excluded.msg_key, auth = excluded.auth, updated_seq = excluded.updated_seq`).run({ ...r, auth: r.auth ?? null, seq });
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
      put(d, next, prev?.msg_key);
      if (prev) out.changed++; else out.added++;
    }
    for (const p of b.patches ?? []) {
      const prev = getRow(d, account, p.providerId);
      if (!prev) continue;
      seen.add(p.providerId);
      const next = { ...prev, ...(p.unread !== undefined ? { unread: p.unread ? 1 : 0 } : {}), ...(p.labels ? { labels: JSON.stringify([...new Set(p.labels.map((l) => cleanLine(String(l), 100)).filter(Boolean))].slice(0, 50)) } : {}) };
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
    recordSyncOk(account, MAIL_RESOURCE, { cursor: b.cursor, windowFrom: b.windowFrom, windowTo: b.windowTo }, now, d);
    return out;
  }).immediate();
}

export function knownIds(account: string): string[] {
  return (appDb().prepare('SELECT provider_id FROM mail_headers WHERE account = ?').all(account) as { provider_id: string }[]).map((r) => r.provider_id);
}

/** Every account with cached mail or mail sync state. */
export function mailAccountsStored(): string[] {
  return (appDb().prepare(`SELECT account FROM mail_headers UNION SELECT account FROM sync_state WHERE resource = ? ORDER BY account`).all(MAIL_RESOURCE) as { account: string }[]).map((r) => r.account);
}

/**
 * Forget an account that is no longer connected (or whose address changed): its headers (each recorded as a
 * deletion, so phones drop them) and its mail sync state. Returns how many headers went.
 */
export function purgeMailAccount(account: string): number {
  const d = appDb();
  return d.transaction((): number => {
    const rows = d.prepare('SELECT * FROM mail_headers WHERE account = ?').all(account) as MailRow[];
    for (const r of rows) drop(d, r);
    deleteSyncState(account, MAIL_RESOURCE, d);
    return rows.length;
  }).immediate();
}

// ── reads ───────────────────────────────────────────────────────────────────────────────────────────────────────

export function getMail(account: string, providerId: string): MailRow | null {
  return getRow(appDb(), account, providerId) ?? null;
}

/** `o` hides `h`: a copy of the same email in ANOTHER account, close in time, and the one preferred (newest, then
 *  by account and id — deterministic, so paging is stable). */
const HIDDEN_BY = (o: string, h: string) => `${o}.msg_key = ${h}.msg_key AND ${o}.account <> ${h}.account
  AND abs(${o}.received_at - ${h}.received_at) <= ${COPY_WINDOW_MS}
  AND (${o}.received_at, ${o}.account, ${o}.provider_id) > (${h}.received_at, ${h}.account, ${h}.provider_id)`;
const VISIBLE = `NOT EXISTS (SELECT 1 FROM mail_headers o WHERE ${HIDDEN_BY('o', 'h')})`;

function cmpTuple(a: MailRow, b: MailRow): number {
  if (a.received_at !== b.received_at) return a.received_at < b.received_at ? -1 : 1;
  if (a.account !== b.account) return a.account < b.account ? -1 : 1;
  return a.provider_id === b.provider_id ? 0 : a.provider_id < b.provider_id ? -1 : 1;
}
const isCopy = (a: MailRow, b: MailRow) => a.msg_key === b.msg_key && a.account !== b.account && Math.abs(a.received_at - b.received_at) <= COPY_WINDOW_MS;
const hides = (o: MailRow, h: MailRow) => isCopy(o, h) && cmpTuple(o, h) > 0;

export interface MailPageCursor { receivedAt: number; account: string; providerId: string }
export function listMail(o: { before?: MailPageCursor | null; limit: number }): MailRow[] {
  const where = [VISIBLE];
  const args: unknown[] = [];
  if (o.before) { where.push('(h.received_at, h.account, h.provider_id) < (?, ?, ?)'); args.push(o.before.receivedAt, o.before.account, o.before.providerId); }
  return appDb().prepare(`SELECT h.* FROM mail_headers h WHERE ${where.join(' AND ')} ORDER BY h.received_at DESC, h.account DESC, h.provider_id DESC LIMIT ?`)
    .all(...args, o.limit) as MailRow[];
}

function rowsWithKey(key: string): MailRow[] {
  return appDb().prepare('SELECT * FROM mail_headers WHERE msg_key = ?').all(key) as MailRow[];
}
/** For a dedupe key: the rows shown and the rows hidden as copies. */
export function splitByKey(key: string): { visible: MailRow[]; hidden: MailRow[] } {
  const rows = rowsWithKey(key);
  const visible: MailRow[] = [], hidden: MailRow[] = [];
  for (const r of rows) (rows.some((o) => hides(o, r)) ? hidden : visible).push(r);
  return { visible, hidden };
}

export type MailCaution = 'phishing' | 'unverified' | null;
/**
 * The caution on a message wherever it is shown (review of W3: the reader opened from All email lost it). It is what
 * A9's triage decided — its verdict's flags: `phishing:<reason>` from the deterministic header signal, `low-trust` for
 * urgent language from a bulk or no-reply sender — and, for a message not sorted yet, the same phishing signal on its
 * headers now (without the known-contact context triage adds, so it can only flag, never clear).
 */
export function mailCaution(r: MailRow, d: AppDb = appDb()): MailCaution {
  let v: { flags: string | null } | undefined;
  try { v = d.prepare('SELECT flags FROM triage_verdicts WHERE mail_id = ?').get(mailId(r.account, r.provider_id)) as { flags: string | null } | undefined; } catch { v = undefined; }
  if (v?.flags?.startsWith('phishing:')) return 'phishing';
  if (v?.flags === 'low-trust') return 'unverified';
  if (v) return null;
  return phishingSignal(r, { trustedDomains: new Set(), firstSeen: () => false }) ? 'phishing' : null;
}

/** The API shape (api/openapi.yaml MailHeader). The display name never carries an address (`displayName`). */
export function apiMailHeader(r: MailRow) {
  let labels: string[] = [];
  try { labels = JSON.parse(r.labels); } catch { labels = []; }
  const copies = r.msg_key.startsWith('u:') ? [] : rowsWithKey(r.msg_key).filter((o) => isCopy(o, r));
  return {
    id: mailId(r.account, r.provider_id), account: r.account, provider: r.provider, threadId: r.thread_id,
    from: { name: displayName(r.from_name), addr: r.from_addr }, subject: r.subject ?? '', snippet: r.snippet ?? '',
    receivedAt: r.received_at, unread: r.unread === 1, labels, listId: r.list_id, hasUnsub: r.has_unsub === 1, caution: mailCaution(r),
    alsoIn: [...new Set(copies.map((c) => c.account))].sort(),
    updatedSeq: r.updated_seq ?? 0,
  };
}
export type ApiMailHeader = ReturnType<typeof apiMailHeader>;

// ── /sync ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Every message shown (copies across accounts once), for /sync's full snapshot. Bounded by the 14-day window. */
export function mailSnapshot(): ApiMailHeader[] {
  const out: ApiMailHeader[] = [];
  let before: MailPageCursor | null = null;
  for (;;) {
    const rows = listMail({ before, limit: 500 });
    out.push(...rows.map(apiMailHeader));
    if (rows.length < 500) return out;
    const l = rows[rows.length - 1];
    before = { receivedAt: l.received_at, account: l.account, providerId: l.provider_id };
  }
}

/**
 * Mail changes in a span of events, as current objects. For each dedupe key touched (and a key a row moved away
 * from), every row shown now is upserted and every hidden copy's id deleted; a row deleted from the cache is deleted
 * unless it is still shown. A row is never sent as deleted while it is listed (review of A8: a forged copy must not
 * make a phone drop the real message).
 */
export function mailDelta(rows: { entity: string; entity_id: string; op: string; payload: string | null }[]): { upserts: ApiMailHeader[]; deletes: string[] } {
  const keys = new Set<string>(), dels = new Set<string>();
  for (const e of rows) {
    if (e.entity !== 'mail') continue;
    let p: { key?: string; prevKey?: string } = {};
    try { p = JSON.parse(e.payload ?? '{}'); } catch { p = {}; }
    if (p.key) keys.add(p.key);
    if (p.prevKey) keys.add(p.prevKey);
    if (e.op === 'delete') dels.add(e.entity_id);
  }
  const ups = new Map<string, ApiMailHeader>();
  for (const k of keys) {
    const { visible, hidden } = splitByKey(k);
    for (const r of visible) { const v = apiMailHeader(r); ups.set(v.id, v); }
    for (const r of hidden) dels.add(mailId(r.account, r.provider_id));
  }
  for (const id of ups.keys()) dels.delete(id);
  return { upserts: [...ups.values()], deletes: [...dels] };
}
