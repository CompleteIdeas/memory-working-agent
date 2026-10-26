/**
 * Gmail header sync over the REST API (slice A8), through the existing signed-in client (connectors/google.ts
 * authedClient). Headers only — the `metadata` format — plus what triage needs later: List-Unsubscribe, List-Id and
 * Gmail's category labels (CATEGORY_PROMOTIONS, CATEGORY_UPDATES…), which arrive in labelIds.
 *
 * Incremental: users.history.list from the stored historyId (INBOX; messages added, labels changed, deleted). When
 * Gmail answers 404 the historyId is too old (Gmail keeps about a week): resync a 14-day metadata window instead; so
 * does a history longer than 50 pages. The new cursor of a full sync is the profile's historyId read BEFORE listing.
 *
 * The account key is 'google:<address>' — the calendar sync's key (A7) when the sign-in stored its address, else the
 * profile's address.
 *
 * Drafts (review of A8): the draft's Message-ID is derived from the request's Idempotency-Key, and Drafts is searched
 * for it (rfc822msgid:) before a new draft is created, so a retry after a lost answer does not make a second draft.
 * The compose scope COULD send; nothing here calls send.
 */
import { google } from 'googleapis';
import { simpleParser } from 'mailparser';
import { authedClient, googleAccountKey } from '../connectors/google.js';
import type { HeaderIn, SyncBatch, SyncStateRow } from '../v2/mail.js';
import { parseAddressList, parseAddress, type Addr } from '../v2/mail-text.js';
import { buildReplyMime } from './mail-mime.js';
import { MessageGoneError, mapLimit, replyRecipients, statusOf, type DraftRequest, type DraftResult, type MailProvider, type RawBody, type SyncOptions } from './mail-types.js';

const META = ['From', 'Subject', 'Date', 'Message-ID', 'List-Unsubscribe', 'List-Id'];
const MAX_WINDOW_MESSAGES = 2000;
const MAX_HISTORY_PAGES = 50;
const CONCURRENCY = 8;
const BODY_PART_MAX = 3_000_000;

export interface GmailOptions {
  /** an OAuth2 client (tests: one pointed at a fake token endpoint); default: the stored sign-in */
  auth?: unknown;
  /** the API root (tests: a fake Gmail server) */
  rootUrl?: string;
}

/** "List-Id: Stable View News <news.stableview.example>" → "news.stableview.example". */
export function listIdOf(v: string | null | undefined): string | null {
  if (!v) return null;
  const m = /<([^<>]{1,200})>/.exec(v);
  return (m ? m[1] : v).trim().slice(0, 200) || null;
}

/**
 * A body part's bytes as text, by its declared charset (Latin-1, Windows-1252, ISO-2022-JP, GB18030…). Gmail hands
 * part data over undecoded; mailparser (already used for IMAP) decodes it, so a one-part message is parsed.
 */
export async function decodeCharset(buf: Buffer, contentType: string | null | undefined): Promise<string> {
  const cs = /charset\s*=\s*"?([A-Za-z0-9._:-]{1,40})"?/i.exec(contentType ?? '')?.[1]?.toLowerCase() ?? 'utf-8';
  if (cs === 'utf-8' || cs === 'utf8' || cs === 'us-ascii') return buf.toString('utf8');
  try {
    const head = `Content-Type: text/plain; charset="${cs}"\r\nContent-Transfer-Encoding: base64\r\n\r\n`;
    const p = await simpleParser(Buffer.concat([Buffer.from(head), Buffer.from(buf.toString('base64'))]));
    return (p.text ?? '').replace(/\n$/, '');
  } catch { return buf.toString('utf8'); }
}

type Header = { name?: string | null; value?: string | null };
const header = (headers: Header[] | undefined | null, n: string) =>
  headers?.find((h) => (h.name ?? '').toLowerCase() === n.toLowerCase())?.value ?? null;

export function gmailProvider(o: GmailOptions = {}): MailProvider {
  const api = async () => google.gmail({ version: 'v1', auth: (o.auth ?? await authedClient()) as never, ...(o.rootUrl ? { rootUrl: o.rootUrl } : {}) });
  type Gmail = Awaited<ReturnType<typeof api>>;

  async function meta(g: Gmail, id: string): Promise<{ h: HeaderIn; labels: string[] } | null> {
    try {
      const r = await g.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: META });
      const m = r.data; const hs = m.payload?.headers ?? [];
      const from = parseAddress(header(hs, 'From'));
      const labels = (m.labelIds ?? []).map(String);
      return {
        labels,
        h: {
          providerId: String(m.id ?? id), threadId: m.threadId ?? null, fromName: from.name, fromAddr: from.addr,
          subject: header(hs, 'Subject'), snippet: m.snippet ?? null,
          receivedAt: Number(m.internalDate ?? Date.parse(header(hs, 'Date') ?? '') ?? 0) || 0,
          unread: labels.includes('UNREAD'), labels, listId: listIdOf(header(hs, 'List-Id')), hasUnsub: !!header(hs, 'List-Unsubscribe'),
          messageId: header(hs, 'Message-ID'),
        },
      };
    } catch (e) {
      if (statusOf(e) === 404) return null; // deleted since it was listed
      throw e;
    }
  }

  async function full(g: Gmail, o2: SyncOptions): Promise<SyncBatch> {
    const windowFrom = o2.now - o2.windowDays * 86_400_000;
    const profile = await g.users.getProfile({ userId: 'me' });
    const cursor = profile.data.historyId ? String(profile.data.historyId) : null;
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const r = await g.users.messages.list({ userId: 'me', labelIds: ['INBOX'], q: `after:${Math.floor(windowFrom / 1000)}`, maxResults: 100, pageToken });
      for (const m of r.data.messages ?? []) if (m.id) ids.push(m.id);
      pageToken = r.data.nextPageToken ?? undefined;
    } while (pageToken && ids.length < MAX_WINDOW_MESSAGES);
    const got = await mapLimit(ids.slice(0, MAX_WINDOW_MESSAGES), CONCURRENCY, (id) => meta(g, id));
    const upserts = got.filter((x): x is NonNullable<typeof x> => !!x && x.labels.includes('INBOX')).map((x) => x.h);
    return { full: true, upserts, deletes: [], cursor, windowFrom, windowTo: o2.now };
  }

  async function incremental(g: Gmail, start: string, o2: SyncOptions): Promise<SyncBatch | null> {
    const windowFrom = o2.now - o2.windowDays * 86_400_000;
    const touched = new Set<string>(), deleted = new Set<string>();
    let cursor = start;
    let pageToken: string | undefined, pages = 0;
    try {
      do {
        if (++pages > MAX_HISTORY_PAGES) return null; // so much changed that the window is cheaper
        const r = await g.users.history.list({
          userId: 'me', startHistoryId: start, labelId: 'INBOX', maxResults: 500, pageToken,
          historyTypes: ['messageAdded', 'labelAdded', 'labelRemoved', 'messageDeleted'],
        });
        for (const h of r.data.history ?? []) {
          for (const x of h.messagesAdded ?? []) if (x.message?.id) touched.add(x.message.id);
          for (const x of [...(h.labelsAdded ?? []), ...(h.labelsRemoved ?? [])]) if (x.message?.id) touched.add(x.message.id);
          for (const x of h.messagesDeleted ?? []) if (x.message?.id) deleted.add(x.message.id);
        }
        if (r.data.historyId) cursor = String(r.data.historyId);
        pageToken = r.data.nextPageToken ?? undefined;
      } while (pageToken);
    } catch (e) {
      if (statusOf(e) === 404) return null; // the stored historyId is too old: a full resync
      throw e;
    }
    for (const id of deleted) touched.delete(id);
    const got = await mapLimit([...touched], CONCURRENCY, async (id) => ({ id, m: await meta(g, id) }));
    const upserts: HeaderIn[] = [];
    for (const { id, m } of got) {
      // gone, archived (no INBOX label any more) or older than the window: not in the cache
      if (!m || !m.labels.includes('INBOX') || m.h.receivedAt < windowFrom) deleted.add(id);
      else upserts.push(m.h);
    }
    return { full: false, upserts, deletes: [...deleted], cursor, windowFrom, windowTo: o2.now };
  }

  /** The first text/html and text/plain parts (attachments skipped), decoded by charset; large parts by attachment id. */
  async function bodyOf(g: Gmail, id: string, payload: any): Promise<{ html: string | null; text: string | null }> {
    let html: string | null = null, text: string | null = null;
    const bytes = async (p: any): Promise<Buffer> => {
      if (p.body?.data) return Buffer.from(String(p.body.data), 'base64url');
      if (p.body?.attachmentId && Number(p.body?.size ?? 0) <= BODY_PART_MAX) {
        const a = await g.users.messages.attachments.get({ userId: 'me', messageId: id, id: p.body.attachmentId });
        return Buffer.from(String(a.data.data ?? ''), 'base64url');
      }
      return Buffer.alloc(0);
    };
    const walk = async (p: any, depth = 0): Promise<void> => {
      if (!p || depth > 20) return;
      const type = String(p.mimeType ?? '').toLowerCase();
      if (!p.filename) {
        const ct = header(p.headers, 'Content-Type');
        if (type === 'text/html' && html === null) html = await decodeCharset(await bytes(p), ct);
        else if (type === 'text/plain' && text === null) text = await decodeCharset(await bytes(p), ct);
      }
      for (const c of p.parts ?? []) await walk(c, depth + 1);
    };
    await walk(payload);
    return { html, text };
  }

  async function originalOf(g: Gmail, id: string) {
    try { return (await g.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['Message-ID', 'References', 'In-Reply-To', 'Subject', 'From', 'Reply-To'] })).data; }
    catch (e) { if (statusOf(e) === 404) throw new MessageGoneError(); throw e; }
  }

  let address: string | null = null;
  return {
    prefix: 'google', provider: 'gmail', label: 'Gmail',
    async resolveAccount(): Promise<string> {
      const k = googleAccountKey();
      if (k.includes(':')) return k;
      if (!address) {
        const p = await (await api()).users.getProfile({ userId: 'me' });
        address = p.data.emailAddress ? String(p.data.emailAddress).toLowerCase() : null;
      }
      return address ? `google:${address}` : 'google';
    },
    async sync(state: SyncStateRow | null, o2: SyncOptions): Promise<SyncBatch> {
      const g = await api();
      if (state?.cursor) {
        const inc = await incremental(g, state.cursor, o2);
        if (inc) return inc;
      }
      return full(g, o2);
    },
    async fetchBody(id: string): Promise<RawBody> {
      const g = await api();
      let m;
      try { m = (await g.users.messages.get({ userId: 'me', id, format: 'full' })).data; }
      catch (e) { if (statusOf(e) === 404) throw new MessageGoneError(); throw e; }
      const b = await bodyOf(g, id, m.payload);
      const hs = m.payload?.headers ?? [];
      return { ...b, from: parseAddressList(header(hs, 'From')), replyTo: parseAddressList(header(hs, 'Reply-To')), to: parseAddressList(header(hs, 'To')) };
    },
    async saveReplyDraft(id: string, req: DraftRequest): Promise<DraftResult> {
      const g = await api();
      const m = await originalOf(g, id);
      const hs = m.payload?.headers ?? [];
      const to: Addr[] = replyRecipients(parseAddressList(header(hs, 'From')), parseAddressList(header(hs, 'Reply-To')));
      // already saved by an earlier try of this same request?
      const bare = req.draftId.replace(/^<|>$/g, '');
      const found = await g.users.messages.list({ userId: 'me', labelIds: ['DRAFT'], q: `rfc822msgid:${bare}`, maxResults: 1 });
      const existing = found.data.messages?.[0]?.id;
      if (existing) return { draftId: existing, to, already: true };
      const raw = buildReplyMime({
        to, subject: header(hs, 'Subject'), messageId: header(hs, 'Message-ID'),
        references: header(hs, 'References') ?? header(hs, 'In-Reply-To'), body: req.body, draftId: req.draftId,
      });
      // drafts.create only: nothing here ever calls send.
      const d = await g.users.drafts.create({ userId: 'me', requestBody: { message: { raw: Buffer.from(raw).toString('base64url'), threadId: m.threadId ?? undefined } } });
      return { draftId: d.data.id ?? null, to, already: false };
    },
  };
}
