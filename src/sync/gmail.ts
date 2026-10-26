/**
 * Gmail header sync over the REST API (slice A8), through the existing signed-in client (connectors/google.ts
 * authedClient). Headers only — the `metadata` format — plus what triage needs later: List-Unsubscribe, List-Id and
 * Gmail's category labels (CATEGORY_PROMOTIONS, CATEGORY_UPDATES…), which arrive in labelIds.
 *
 * Incremental: users.history.list from the stored historyId (INBOX; messages added, labels changed, deleted). When
 * Gmail answers 404 the historyId is too old (Gmail keeps about a week): resync a 14-day metadata window instead.
 * The new cursor of a full sync is the profile's historyId read BEFORE listing, so nothing that changes during the
 * listing is missed (it is replayed next time; replays are harmless).
 */
import { google } from 'googleapis';
import { authedClient } from '../connectors/google.js';
import { parseAddress, type HeaderIn, type SyncBatch, type SyncStateRow } from '../v2/mail.js';
import { buildReplyMime } from './mail-mime.js';
import { MessageGoneError, mapLimit, statusOf, type MailProvider, type RawBody, type SyncOptions } from './mail-types.js';

const META = ['From', 'Subject', 'Date', 'Message-ID', 'List-Unsubscribe', 'List-Id'];
const MAX_WINDOW_MESSAGES = 2000;
const CONCURRENCY = 8;
const BODY_PART_MAX = 3_000_000;

export interface GmailOptions {
  account?: string;
  /** an OAuth2 client (tests: one pointed at a fake token endpoint); default: the stored sign-in */
  auth?: unknown;
  /** the API root (tests: a fake Gmail server) */
  rootUrl?: string;
}

/** "List-Id: Stable View News <news.stableview.example>" → "news.stableview.example". */
export function listIdOf(v: string | null | undefined): string | null {
  if (!v) return null;
  const m = /<([^>]+)>/.exec(v);
  return (m ? m[1] : v).trim().slice(0, 200) || null;
}

export function gmailProvider(o: GmailOptions = {}): MailProvider {
  const account = o.account ?? 'gmail';
  const api = async () => google.gmail({ version: 'v1', auth: (o.auth ?? await authedClient()) as never, ...(o.rootUrl ? { rootUrl: o.rootUrl } : {}) });
  type Gmail = Awaited<ReturnType<typeof api>>;

  const header = (headers: { name?: string | null; value?: string | null }[] | undefined, n: string) =>
    headers?.find((h) => (h.name ?? '').toLowerCase() === n.toLowerCase())?.value ?? null;

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
    let pageToken: string | undefined;
    try {
      do {
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

  /** The first text/html and text/plain parts (attachments skipped); a large part is fetched by attachment id. */
  async function bodyOf(g: Gmail, id: string, payload: any): Promise<{ html: string | null; text: string | null }> {
    let html: string | null = null, text: string | null = null;
    const decode = async (p: any): Promise<string> => {
      if (p.body?.data) return Buffer.from(String(p.body.data), 'base64url').toString('utf8');
      if (p.body?.attachmentId && Number(p.body?.size ?? 0) <= BODY_PART_MAX) {
        const a = await g.users.messages.attachments.get({ userId: 'me', messageId: id, id: p.body.attachmentId });
        return Buffer.from(String(a.data.data ?? ''), 'base64url').toString('utf8');
      }
      return '';
    };
    const walk = async (p: any): Promise<void> => {
      if (!p) return;
      const type = String(p.mimeType ?? '').toLowerCase();
      if (!p.filename) {
        if (type === 'text/html' && html === null) html = await decode(p);
        else if (type === 'text/plain' && text === null) text = await decode(p);
      }
      for (const c of p.parts ?? []) await walk(c);
    };
    await walk(payload);
    return { html, text };
  }

  return {
    account, provider: 'gmail', label: 'Gmail',
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
      return { ...b, to: header(m.payload?.headers ?? [], 'To') };
    },
    async saveReplyDraft(id: string, body: string) {
      const g = await api();
      let m;
      try { m = (await g.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['Message-ID', 'References', 'In-Reply-To', 'Subject', 'From', 'Reply-To'] })).data; }
      catch (e) { if (statusOf(e) === 404) throw new MessageGoneError(); throw e; }
      const hs = m.payload?.headers ?? [];
      const raw = buildReplyMime({
        to: header(hs, 'Reply-To') ?? header(hs, 'From') ?? '', subject: header(hs, 'Subject'),
        messageId: header(hs, 'Message-ID'), references: header(hs, 'References') ?? header(hs, 'In-Reply-To'), body,
      });
      // drafts.create only: the compose scope can send, but nothing here ever calls send.
      const d = await g.users.drafts.create({ userId: 'me', requestBody: { message: { raw: Buffer.from(raw).toString('base64url'), threadId: m.threadId ?? undefined } } });
      return { draftId: d.data.id ?? null };
    },
  };
}
