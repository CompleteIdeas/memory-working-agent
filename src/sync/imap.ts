/**
 * IMAP header sync (slice A8) — the Gmail app-password path (connectors/gmail-imap.ts imapClient), headers only.
 *
 * The cursor is "<UIDVALIDITY>:<highest UID seen>". Each sync opens INBOX READ-ONLY (EXAMINE: nothing it does can
 * mark a message read) and runs `UID SEARCH SINCE <window start>`:
 *   - a UIDVALIDITY different from the cursor's means every UID changed meaning: a full window resync;
 *   - otherwise new UIDs get their headers fetched, known ones only their flags (read / unread, Gmail labels), and
 *     a cached UID the search no longer returns has left the inbox.
 * Provider ids are "<UIDVALIDITY>.<UID>", so an id from before a reset can never point at a different message.
 * IMAP has no snippet without reading the body, so IMAP headers carry none (headers only, as designed).
 */
import { simpleParser } from 'mailparser';
import type { FetchMessageObject, FetchQueryObject, ImapFlow, MailboxObject } from 'imapflow';
import { appendDraft, imapClient } from '../connectors/gmail-imap.js';
import type { HeaderIn, HeaderPatch, SyncBatch, SyncStateRow } from '../v2/mail.js';
import { listIdOf } from './gmail.js';
import { buildReplyMime } from './mail-mime.js';
import { MessageGoneError, type MailProvider, type RawBody, type SyncOptions } from './mail-types.js';

/** The part of imapflow the sync uses (tests drive a fake with this shape). */
export type ImapLike = Pick<ImapFlow, 'getMailboxLock' | 'search' | 'fetch' | 'fetchOne' | 'list' | 'append' | 'logout'> & { mailbox: MailboxObject | false };

const MAX_WINDOW_MESSAGES = 2000;
const SOURCE_MAX = 5_000_000;
const HEADER_FIELDS = ['message-id', 'list-id', 'list-unsubscribe', 'references', 'reply-to'];

export interface ImapOptions {
  account?: string;
  /** a connected client (tests: a fake); default: the stored app password */
  connect?: () => Promise<ImapLike>;
  /** the signed-in address (the From of a draft) */
  user?: string;
}

/** Raw header lines → a map of lower-cased name → value (folded lines joined). */
export function parseHeaderBlock(buf: Buffer | string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!buf) return out;
  const text = buf.toString().replace(/\r\n/g, '\n').replace(/\n[ \t]+/g, ' ');
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) { const k = line.slice(0, i).trim().toLowerCase(); if (!(k in out)) out[k] = line.slice(i + 1).trim(); }
  }
  return out;
}

export const parseCursor = (c: string | null | undefined): { uidValidity: string; lastUid: number } | null => {
  const m = /^(\d+):(\d+)$/.exec(c ?? '');
  return m ? { uidValidity: m[1], lastUid: Number(m[2]) } : null;
};

export function imapProvider(o: ImapOptions = {}): MailProvider {
  const account = o.account ?? 'imap';
  const connect = o.connect ?? (async () => (await imapClient()) as unknown as ImapLike);
  const user = () => o.user ?? process.env.MWA_GMAIL_USER ?? '';

  /** Open INBOX read-only, run `fn`, always release and log out. */
  async function withInbox<T>(fn: (c: ImapLike, uidValidity: string) => Promise<T>, readOnly = true): Promise<T> {
    const c = await connect();
    try {
      const lock = await c.getMailboxLock('INBOX', { readOnly });
      try {
        const mb = c.mailbox;
        if (!mb) throw new Error('INBOX did not open');
        return await fn(c, String(mb.uidValidity));
      } finally { lock.release(); }
    } finally { try { await c.logout(); } catch { /* gone */ } }
  }

  const toHeader = (m: FetchMessageObject, uidValidity: string): HeaderIn => {
    const env = m.envelope ?? {};
    const hs = parseHeaderBlock(m.headers);
    const from = env.from?.[0];
    const flags = m.flags ?? new Set<string>();
    const received = m.internalDate ? new Date(m.internalDate).getTime() : env.date ? new Date(env.date).getTime() : 0;
    return {
      providerId: `${uidValidity}.${m.uid}`, threadId: m.threadId ?? null,
      fromName: from?.name || null, fromAddr: from?.address ?? null, subject: env.subject ?? null, snippet: null,
      receivedAt: received, unread: !flags.has('\\Seen'), labels: [...(m.labels ?? [])].map(String),
      listId: listIdOf(hs['list-id']), hasUnsub: !!hs['list-unsubscribe'], messageId: env.messageId ?? hs['message-id'] ?? null,
    };
  };
  const HEAD_QUERY: FetchQueryObject = { uid: true, envelope: true, flags: true, internalDate: true, labels: true, threadId: true, headers: HEADER_FIELDS };

  async function fetchAll(c: ImapLike, uids: number[], q: FetchQueryObject): Promise<FetchMessageObject[]> {
    const out: FetchMessageObject[] = [];
    if (!uids.length) return out;
    for await (const m of c.fetch(uids, q, { uid: true })) out.push(m);
    return out;
  }
  const uidOf = (providerId: string, uidValidity: string): number | null => {
    const m = /^(\d+)\.(\d+)$/.exec(providerId);
    return m && m[1] === uidValidity ? Number(m[2]) : null;
  };

  return {
    account, provider: 'imap', label: 'Gmail (app password)',
    async sync(state: SyncStateRow | null, o2: SyncOptions): Promise<SyncBatch> {
      const windowFrom = o2.now - o2.windowDays * 86_400_000;
      return withInbox(async (c, uidValidity) => {
        const prev = parseCursor(state?.cursor);
        const full = !prev || prev.uidValidity !== uidValidity;
        const found = ((await c.search({ since: new Date(windowFrom) }, { uid: true })) || []).sort((a, b) => a - b).slice(-MAX_WINDOW_MESSAGES);
        const maxUid = found.length ? found[found.length - 1] : (prev && !full ? prev.lastUid : 0);
        const cursor = `${uidValidity}:${Math.max(maxUid, prev && !full ? prev.lastUid : 0)}`;
        if (full) {
          const got = await fetchAll(c, found, HEAD_QUERY);
          return { full: true, upserts: got.map((m) => toHeader(m, uidValidity)), deletes: [], cursor, windowFrom, windowTo: o2.now };
        }
        const known = new Map<number, string>();
        for (const id of o2.known()) { const u = uidOf(id, uidValidity); if (u !== null) known.set(u, id); }
        const fresh = found.filter((u) => !known.has(u));
        const stay = found.filter((u) => known.has(u));
        const upserts = (await fetchAll(c, fresh, HEAD_QUERY)).map((m) => toHeader(m, uidValidity));
        const patches: HeaderPatch[] = (await fetchAll(c, stay, { uid: true, flags: true, labels: true })).map((m) => ({
          providerId: `${uidValidity}.${m.uid}`, unread: !(m.flags ?? new Set()).has('\\Seen'), ...(m.labels ? { labels: [...m.labels].map(String) } : {}),
        }));
        const inWindow = new Set(found);
        const deletes = [...known].filter(([u]) => !inWindow.has(u)).map(([, id]) => id);
        return { full: false, upserts, patches, deletes, cursor, windowFrom, windowTo: o2.now };
      });
    },
    async fetchBody(providerId: string): Promise<RawBody> {
      return withInbox(async (c, uidValidity) => {
        const uid = uidOf(providerId, uidValidity);
        if (uid === null) throw new MessageGoneError('The mailbox was reset since this message was listed.');
        const m = await c.fetchOne(String(uid), { uid: true, source: { maxLength: SOURCE_MAX } }, { uid: true });
        if (!m || !m.source) throw new MessageGoneError();
        const p = await simpleParser(m.source);
        return { html: typeof p.html === 'string' ? p.html : null, text: p.text ?? null, to: Array.isArray(p.to) ? p.to.map((x) => x.text).join(', ') : p.to?.text ?? null };
      });
    },
    async saveReplyDraft(providerId: string, body: string) {
      return withInbox(async (c, uidValidity) => {
        const uid = uidOf(providerId, uidValidity);
        if (uid === null) throw new MessageGoneError('The mailbox was reset since this message was listed.');
        const m = await c.fetchOne(String(uid), { uid: true, envelope: true, headers: HEADER_FIELDS }, { uid: true });
        if (!m) throw new MessageGoneError();
        const env = m.envelope ?? {};
        const hs = parseHeaderBlock(m.headers);
        const addr = (a?: { name?: string; address?: string }) => (a?.address ? (a.name ? `"${a.name}" <${a.address}>` : a.address) : '');
        const to = env.replyTo?.length ? env.replyTo.map(addr).join(', ') : addr(env.from?.[0]);
        const raw = buildReplyMime({
          from: user() || null, to, subject: env.subject ?? null, messageId: env.messageId ?? hs['message-id'] ?? null,
          references: hs.references ?? env.inReplyTo ?? null, body,
        });
        const r = await appendDraft(c, raw); // APPEND to Drafts, flagged \Draft — IMAP has no way to send
        return { draftId: r.uid !== null ? String(r.uid) : null };
      });
    },
  };
}
