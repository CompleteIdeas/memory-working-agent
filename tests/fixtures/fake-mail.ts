// Fake mail providers for the A8 tests (v2 build, 2026-10-26).
//   - FakeGmail: a real HTTP server speaking the slice of the Gmail REST API the sync, reader and drafts use, plus an
//     OAuth token endpoint that can refuse with invalid_grant. The real googleapis client talks to it (rootUrl).
//   - FakeGraph: a real HTTP server for the Microsoft Graph calls (messages delta with nextLink/deltaLink, a message,
//     createReply). The real connectors/microsoft.ts graph() talks to it (MWA_GRAPH_BASE + a token file).
//   - FakeImap: an in-memory stand-in for imapflow at its interface (see tests/mail-sync.test.ts for why).
// Every fake counts send attempts, so a test can assert nothing was ever sent.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

const listen = async (s: Server): Promise<number> => {
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return (s.address() as { port: number }).port;
};
const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
async function readBody(req: IncomingMessage): Promise<string> { let s = ''; for await (const c of req) s += c; return s; }

// ── Gmail ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface GmailMsg {
  id: string; threadId: string; labelIds: string[]; internalDate: number; snippet: string;
  headers: Record<string, string>; html?: string; text?: string;
}
type HistoryRec = { id: number; messagesAdded?: string[]; labelsAdded?: string[]; labelsRemoved?: string[]; messagesDeleted?: string[] };

export class FakeGmail {
  server!: Server; base = '';
  msgs = new Map<string, GmailMsg>();
  history: HistoryRec[] = [];
  historyId = 1000;
  /** a startHistoryId below this is "too old" (Gmail answers 404) */
  oldestHistory = 0;
  drafts: { id: string; raw: string; threadId?: string }[] = [];
  sendCalls = 0;
  requests: string[] = [];
  refuseToken = false;
  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res).catch((e) => json(res, 500, { error: { code: 500, message: String(e) } })));
    this.base = `http://127.0.0.1:${await listen(this.server)}/`;
    return this;
  }
  close() { this.server?.close(); }
  get tokenUrl() { return `${this.base}token`; }

  private bump(rec: Omit<HistoryRec, 'id'>) { this.historyId += 1; this.history.push({ id: this.historyId, ...rec }); }
  add(m: Partial<GmailMsg> & { id: string; from: string; subject: string; at: number }): GmailMsg {
    const { from, subject, at, ...rest } = m;
    const msg: GmailMsg = {
      threadId: `t-${m.id}`, labelIds: ['INBOX', 'UNREAD'], internalDate: at, snippet: `Snippet of ${subject}`,
      headers: { From: from, Subject: subject, Date: new Date(at).toUTCString(), 'Message-ID': `<${m.id}@mail.example>` },
      ...rest,
    } as GmailMsg;
    this.msgs.set(m.id, msg);
    this.bump({ messagesAdded: [m.id] });
    return msg;
  }
  markRead(id: string) { const m = this.msgs.get(id)!; m.labelIds = m.labelIds.filter((l) => l !== 'UNREAD'); this.bump({ labelsRemoved: [id] }); }
  archive(id: string) { const m = this.msgs.get(id)!; m.labelIds = m.labelIds.filter((l) => l !== 'INBOX'); this.bump({ labelsRemoved: [id] }); }
  remove(id: string) { this.msgs.delete(id); this.bump({ messagesDeleted: [id] }); }

  private resource(m: GmailMsg, format: string, only: string[]) {
    const headers = Object.entries(m.headers).filter(([k]) => format !== 'metadata' || !only.length || only.some((o) => o.toLowerCase() === k.toLowerCase())).map(([name, value]) => ({ name, value }));
    const base = { id: m.id, threadId: m.threadId, labelIds: m.labelIds, snippet: m.snippet, internalDate: String(m.internalDate), historyId: String(this.historyId) };
    if (format === 'minimal') return base;
    if (format === 'metadata') return { ...base, payload: { mimeType: 'multipart/alternative', headers } };
    const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
    const parts = [
      ...(m.text !== undefined ? [{ partId: '0', mimeType: 'text/plain', filename: '', headers: [], body: { size: m.text.length, data: b64(m.text) } }] : []),
      ...(m.html !== undefined ? [{ partId: '1', mimeType: 'text/html', filename: '', headers: [], body: { size: m.html.length, data: b64(m.html) } }] : []),
      { partId: '2', mimeType: 'application/pdf', filename: 'secret.pdf', headers: [], body: { size: 10, attachmentId: 'att-1' } },
    ];
    return { ...base, payload: { mimeType: 'multipart/mixed', headers, parts } };
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const u = new URL(req.url ?? '/', 'http://x');
    const p = u.pathname;
    this.requests.push(`${req.method} ${p}`);
    if (p === '/token') {
      if (this.refuseToken) return json(res, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
      return json(res, 200, { access_token: 'fresh', expires_in: 3600, token_type: 'Bearer' });
    }
    if (!/^Bearer /.test(String(req.headers.authorization ?? ''))) return json(res, 401, { error: { code: 401, message: 'Login Required.' } });
    const g = '/gmail/v1/users/me';
    if (req.method === 'POST' && (p === `${g}/messages/send` || p === `${g}/drafts/send` || p.endsWith('/send'))) { this.sendCalls++; return json(res, 200, { id: 'sent' }); }
    if (req.method === 'GET' && p === `${g}/profile`) return json(res, 200, { emailAddress: 'robert@gmail.example', historyId: String(this.historyId) });
    if (req.method === 'GET' && p === `${g}/messages`) {
      const after = Number(/after:(\d+)/.exec(u.searchParams.get('q') ?? '')?.[1] ?? 0) * 1000;
      const label = u.searchParams.getAll('labelIds');
      const all = [...this.msgs.values()].filter((m) => m.internalDate >= after && label.every((l) => m.labelIds.includes(l))).sort((a, b) => b.internalDate - a.internalDate);
      const size = Math.min(Number(u.searchParams.get('maxResults') ?? 100), 3); // small pages: paging is exercised
      const start = Number(u.searchParams.get('pageToken') ?? 0);
      const page = all.slice(start, start + size);
      return json(res, 200, { messages: page.map((m) => ({ id: m.id, threadId: m.threadId })), ...(start + size < all.length ? { nextPageToken: String(start + size) } : {}), resultSizeEstimate: all.length });
    }
    const mm = new RegExp(`^${g}/messages/([^/]+)$`).exec(p);
    if (req.method === 'GET' && mm) {
      const m = this.msgs.get(decodeURIComponent(mm[1]));
      if (!m) return json(res, 404, { error: { code: 404, message: 'Requested entity was not found.' } });
      const only = u.searchParams.getAll('metadataHeaders').flatMap((x) => x.split(','));
      return json(res, 200, this.resource(m, u.searchParams.get('format') ?? 'full', only));
    }
    if (req.method === 'GET' && p === `${g}/history`) {
      const start = Number(u.searchParams.get('startHistoryId'));
      if (start < this.oldestHistory) return json(res, 404, { error: { code: 404, message: 'Requested entity was not found.' } });
      const recs = this.history.filter((h) => h.id > start);
      const msg = (id: string) => ({ message: { id, threadId: `t-${id}`, labelIds: this.msgs.get(id)?.labelIds ?? [] } });
      return json(res, 200, {
        historyId: String(this.historyId),
        ...(recs.length ? {
          history: recs.map((h) => ({
            id: String(h.id),
            ...(h.messagesAdded ? { messagesAdded: h.messagesAdded.map(msg) } : {}),
            ...(h.labelsAdded ? { labelsAdded: h.labelsAdded.map((id) => ({ ...msg(id), labelIds: ['X'] })) } : {}),
            ...(h.labelsRemoved ? { labelsRemoved: h.labelsRemoved.map((id) => ({ ...msg(id), labelIds: ['X'] })) } : {}),
            ...(h.messagesDeleted ? { messagesDeleted: h.messagesDeleted.map(msg) } : {}),
          })),
        } : {}),
      });
    }
    if (req.method === 'POST' && p === `${g}/drafts`) {
      const b = JSON.parse(await readBody(req));
      const d = { id: `d-${this.drafts.length + 1}`, raw: Buffer.from(String(b.message?.raw ?? ''), 'base64url').toString('utf8'), threadId: b.message?.threadId };
      this.drafts.push(d);
      return json(res, 200, { id: d.id, message: { id: `dm-${d.id}`, threadId: d.threadId } });
    }
    return json(res, 404, { error: { code: 404, message: `fake gmail: no route ${req.method} ${p}` } });
  }
}

// ── Microsoft Graph ─────────────────────────────────────────────────────────────────────────────────────────────

export interface GraphMsg {
  id: string; conversationId: string; from: { emailAddress: { name: string; address: string } }; subject: string; bodyPreview: string;
  receivedDateTime: string; isRead: boolean; categories: string[]; internetMessageId: string; unsubscribeEnabled: boolean;
  body: { contentType: 'html' | 'text'; content: string };
}
export class FakeGraph {
  server!: Server; base = '';
  msgs = new Map<string, GraphMsg>();
  changes: { seq: number; id: string; removed?: boolean; partial?: boolean }[] = [];
  seq = 0;
  /** a delta token below this has expired (410) */
  expiredBefore = 0;
  revoked = false;
  drafts: { id: string; replyTo: string; comment: string }[] = [];
  sendCalls = 0;
  requests: string[] = [];
  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res).catch((e) => json(res, 500, { error: { code: 'x', message: String(e) } })));
    this.base = `http://127.0.0.1:${await listen(this.server)}/v1.0`;
    return this;
  }
  close() { this.server?.close(); }
  add(m: { id: string; from: string; addr: string; subject: string; at: number; messageId?: string; html?: string; preview?: string }): GraphMsg {
    const g: GraphMsg = {
      id: m.id, conversationId: `c-${m.id}`, from: { emailAddress: { name: m.from, address: m.addr } }, subject: m.subject,
      bodyPreview: m.preview ?? `Preview of ${m.subject}`, receivedDateTime: new Date(m.at).toISOString(), isRead: false, categories: [],
      internetMessageId: m.messageId ?? `<${m.id}@outlook.example>`, unsubscribeEnabled: false,
      body: { contentType: 'html', content: m.html ?? `<p>${m.subject}</p>` },
    };
    this.msgs.set(m.id, g);
    this.changes.push({ seq: ++this.seq, id: m.id });
    return g;
  }
  markRead(id: string) { this.msgs.get(id)!.isRead = true; this.changes.push({ seq: ++this.seq, id, partial: true }); }
  remove(id: string) { this.msgs.delete(id); this.changes.push({ seq: ++this.seq, id, removed: true }); }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const u = new URL(req.url ?? '/', 'http://x');
    const raw = u.pathname.replace(/^\/v1\.0/, ''); // ids are matched encoded: a Graph id may contain '/'
    const p = decodeURIComponent(raw);
    this.requests.push(`${req.method} ${p}`);
    if (this.revoked || req.headers.authorization !== 'Bearer fake-graph-token') return json(res, 401, { error: { code: 'InvalidAuthenticationToken', message: 'Access token has expired or is not yet valid.' } });
    if (req.method === 'POST' && (/\/send$/.test(p) || p === '/me/sendMail' || /\/(reply|replyAll|forward)$/.test(p))) { this.sendCalls++; return json(res, 202, {}); }
    if (req.method === 'GET' && p === '/me/mailFolders/inbox/messages/delta') {
      const token = u.searchParams.get('$deltatoken'), skip = u.searchParams.get('$skiptoken');
      const deltaLink = `${this.base}/me/mailFolders/inbox/messages/delta?$deltatoken=${this.seq}`;
      if (token !== null) {
        if (Number(token) < this.expiredBefore) return json(res, 410, { error: { code: 'SyncStateNotFound', message: 'The sync state generation is not found.' } });
        const latest = new Map<string, (typeof this.changes)[number]>();
        for (const c of this.changes.filter((x) => x.seq > Number(token))) latest.set(c.id, c);
        const value = [...latest.values()].map((c) => {
          const m = this.msgs.get(c.id);
          if (c.removed || !m) return { id: c.id, '@removed': { reason: 'deleted' } };
          return c.partial ? { id: m.id, isRead: m.isRead } : m;
        });
        return json(res, 200, { value, '@odata.deltaLink': deltaLink });
      }
      const from = Date.parse(/receivedDateTime ge (\S+)/.exec(u.searchParams.get('$filter') ?? '')?.[1] ?? '1970-01-01T00:00:00Z');
      const all = [...this.msgs.values()].filter((m) => Date.parse(m.receivedDateTime) >= from);
      const start = Number(skip ?? 0), size = 2; // small pages: nextLink is exercised
      const page = all.slice(start, start + size);
      return json(res, 200, { value: page, ...(start + size < all.length ? { '@odata.nextLink': `${this.base}/me/mailFolders/inbox/messages/delta?$skiptoken=${start + size}` } : { '@odata.deltaLink': deltaLink }) });
    }
    const one = /^\/me\/messages\/([^/]+)$/.exec(raw);
    if (req.method === 'GET' && one) {
      const m = this.msgs.get(decodeURIComponent(one[1]));
      if (!m) return json(res, 404, { error: { code: 'ErrorItemNotFound', message: 'The specified object was not found in the store.' } });
      return json(res, 200, { id: m.id, body: m.body, toRecipients: [{ emailAddress: { name: 'Robert', address: 'robert@outlook.example' } }] });
    }
    const reply = /^\/me\/messages\/([^/]+)\/createReply$/.exec(raw);
    if (req.method === 'POST' && reply) {
      const rid = decodeURIComponent(reply[1]);
      if (!this.msgs.get(rid)) return json(res, 404, { error: { code: 'ErrorItemNotFound', message: 'Not found.' } });
      const b = JSON.parse(await readBody(req) || '{}');
      const d = { id: `od-${this.drafts.length + 1}`, replyTo: rid, comment: String(b.comment ?? '') };
      this.drafts.push(d);
      return json(res, 201, { id: d.id, isDraft: true });
    }
    return json(res, 404, { error: { code: 'NotFound', message: `fake graph: no route ${req.method} ${p}` } });
  }
}

// ── IMAP (at imapflow's interface) ──────────────────────────────────────────────────────────────────────────────

export interface ImapMsg {
  uid: number; flags: Set<string>; internalDate: Date; labels?: Set<string>; threadId?: string;
  envelope: { date: Date; subject: string; messageId: string; from: { name?: string; address: string }[]; replyTo?: { name?: string; address: string }[]; inReplyTo?: string };
  headers: string; source: string;
}
export class FakeImap {
  uidValidity = 7n;
  nextUid = 1;
  msgs: ImapMsg[] = [];
  appended: { path: string; content: string; flags: string[] }[] = [];
  opens: { path: string; readOnly: boolean }[] = [];
  logouts = 0;
  connections = 0;
  failLogin = false;
  add(m: { from: string; addr: string; subject: string; at: number; messageId?: string; listId?: string; unsub?: boolean; html?: string; seen?: boolean }): ImapMsg {
    const uid = this.nextUid++;
    const messageId = m.messageId ?? `<imap-${uid}@mail.example>`;
    const headers = [`Message-ID: ${messageId}`, ...(m.listId ? [`List-Id: ${m.listId}`] : []), ...(m.unsub ? ['List-Unsubscribe: <mailto:unsub@list.example>'] : [])].join('\r\n') + '\r\n\r\n';
    const html = m.html ?? `<p>Body of ${m.subject}</p>`;
    const source = [`From: "${m.from}" <${m.addr}>`, 'To: robert@gmail.example', `Subject: ${m.subject}`, `Message-ID: ${messageId}`, `Date: ${new Date(m.at).toUTCString()}`, 'MIME-Version: 1.0', 'Content-Type: text/html; charset=utf-8', '', html].join('\r\n');
    const msg: ImapMsg = {
      uid, flags: new Set(m.seen ? ['\\Seen'] : []), internalDate: new Date(m.at), labels: new Set(['\\Inbox']), threadId: `thr-${uid}`,
      envelope: { date: new Date(m.at), subject: m.subject, messageId, from: [{ name: m.from, address: m.addr }] }, headers, source,
    };
    this.msgs.push(msg);
    return msg;
  }
  /** The server renumbered the mailbox: a new UIDVALIDITY and new UIDs for the same messages. */
  resetUidValidity() { this.uidValidity += 1n; for (const m of this.msgs) m.uid = this.nextUid++; }

  connect = async () => {
    if (this.failLogin) { const e = new Error('Command failed') as Error & { authenticationFailed: boolean }; e.authenticationFailed = true; throw e; }
    this.connections++;
    const fake = this;
    let opened = false;
    const pick = (m: ImapMsg, q: Record<string, unknown>) => ({
      seq: m.uid, uid: m.uid,
      ...(q.flags ? { flags: new Set(m.flags) } : {}),
      ...(q.envelope ? { envelope: m.envelope } : {}),
      ...(q.internalDate ? { internalDate: m.internalDate } : {}),
      ...(q.labels ? { labels: m.labels } : {}),
      ...(q.threadId ? { threadId: m.threadId } : {}),
      ...(q.headers ? { headers: Buffer.from(m.headers) } : {}),
      ...(q.source ? { source: Buffer.from(m.source) } : {}),
    });
    return {
      get mailbox() { return opened ? { path: 'INBOX', uidValidity: fake.uidValidity, uidNext: fake.nextUid, exists: fake.msgs.length, delimiter: '/', flags: new Set<string>() } : false; },
      async getMailboxLock(path: string, o: { readOnly?: boolean } = {}) { fake.opens.push({ path, readOnly: !!o.readOnly }); opened = true; return { path, release() {} }; },
      async search(q: { since?: Date }) {
        const day = q.since ? Date.UTC(q.since.getUTCFullYear(), q.since.getUTCMonth(), q.since.getUTCDate()) : 0; // SINCE ignores the time of day
        return fake.msgs.filter((m) => m.internalDate.getTime() >= day).map((m) => m.uid);
      },
      async *fetch(range: number[], q: Record<string, unknown>) { for (const m of fake.msgs) if (range.includes(m.uid)) yield pick(m, q); },
      async fetchOne(uid: string, q: Record<string, unknown>) { const m = fake.msgs.find((x) => x.uid === Number(uid)); return m ? pick(m, q) : false; },
      async list() { return [{ path: 'INBOX', specialUse: '\\Inbox' }, { path: '[Gmail]/Drafts', specialUse: '\\Drafts' }, { path: '[Gmail]/Sent Mail', specialUse: '\\Sent' }]; },
      async append(path: string, content: Buffer | string, flags: string[] = []) { fake.appended.push({ path, content: content.toString(), flags }); return { destination: path, uid: 900 + fake.appended.length }; },
      async logout() { fake.logouts++; },
    };
  };
}

/** A Google OAuth client pointed at a fake token endpoint (invalid_grant then comes through the real library path).
 *  Native fetch: the shared node_modules this worktree runs on lacks fetch-blob/streams.cjs, which gaxios's default
 *  (node-fetch v3) needs; fetchImplementation is gaxios's documented switch. */
export async function googleTestAuth(tokenUrl: string, o: { expired?: boolean } = {}) {
  const { google } = await import('googleapis');
  const a = new google.auth.OAuth2({ clientId: 'cid', clientSecret: 'sec', endpoints: { oauth2TokenUrl: tokenUrl }, transporterOptions: { fetchImplementation: fetch } } as never);
  a.setCredentials({ access_token: 'fake-gmail-token', refresh_token: 'refresh-1', expiry_date: o.expired ? Date.now() - 60_000 : Date.now() + 3_600_000 });
  return a;
}
