/**
 * Outlook / Microsoft 365 header sync over Microsoft Graph (slice A8), through the existing signed-in call
 * (connectors/microsoft.ts graph, which follows absolute links only on Graph's own origin). A messages DELTA query on
 * the inbox, limited to the 14-day window:
 *   - the first sync pages through @odata.nextLink to an @odata.deltaLink, which is stored as the cursor;
 *   - each later sync follows the stored link: new and changed messages, and `@removed` entries;
 *   - a very long change list is saved part-way (after 100 pages the nextLink is the cursor) and continued next time;
 *   - when Graph says the delta token is no longer valid (410 Gone, syncStateNotFound / resyncRequired), or the stored
 *     link is not on Graph's host, the window is synced again from scratch.
 * A changed message can come back with only the properties that changed; one without receivedDateTime is applied
 * as a patch (read state, categories) to the cached header.
 *
 * Reply drafts use Graph's createReply, which threads and addresses the draft. The draft carries a hidden extended
 * property holding the request's draft id, and Drafts is searched for it first, so a retry does not make a second
 * draft. Nothing here calls /send.
 */
import { graph, outlookAccountKey } from '../connectors/microsoft.js';
import type { HeaderIn, HeaderPatch, SyncBatch, SyncStateRow } from '../v2/mail.js';
import { isAddrSpec, type Addr } from '../v2/mail-text.js';
import { MessageGoneError, type DraftRequest, type DraftResult, type MailProvider, type RawBody, type SyncOptions } from './mail-types.js';

const SELECT = 'id,conversationId,from,subject,bodyPreview,receivedDateTime,isRead,categories,inferenceClassification,internetMessageId,unsubscribeEnabled';
const MAX_PAGES = 100;
/** A named MAPI string property in MWA's own namespace (a GUID minted for it), holding a draft's id. */
export const DRAFT_PROP = 'String {6f0c4a8e-3b1d-4c55-9a8e-2d7b1f6e5a01} Name MwaDraftId';

export interface OutlookOptions {
  /** the Graph call (default: the stored sign-in) */
  call?: (path: string, init?: RequestInit) => Promise<any>;
  /** pages read in one sync before saving progress (tests lower it) */
  maxPages?: number;
}

const isExpiredDelta = (e: unknown) => /Graph 410\b|syncStateNotFound|resyncRequired|SyncStateInvalid|outside Microsoft Graph/i.test((e as Error)?.message ?? '');
const isNotFound = (e: unknown) => /Graph 404\b|ErrorItemNotFound/i.test((e as Error)?.message ?? '');
const graphAddrs = (list: any): Addr[] => (Array.isArray(list) ? list : list ? [list] : []).map((r: any) => {
  const a = r?.emailAddress ?? {};
  return { name: a.name ? String(a.name) : null, addr: a.address && isAddrSpec(String(a.address)) ? String(a.address).toLowerCase() : null };
});

export function outlookProvider(o: OutlookOptions = {}): MailProvider {
  const call = o.call ?? graph;
  const maxPages = o.maxPages ?? MAX_PAGES;
  const enc = (id: string) => encodeURIComponent(id);

  const toHeader = (m: any): HeaderIn => {
    const a = m.from?.emailAddress;
    const labels = [...(Array.isArray(m.categories) ? m.categories.map(String) : []), ...(m.inferenceClassification ? [`inference:${m.inferenceClassification}`] : [])];
    return {
      providerId: String(m.id), threadId: m.conversationId ?? null, fromName: a?.name ?? null, fromAddr: a?.address ?? null,
      subject: m.subject ?? null, snippet: m.bodyPreview ?? null, receivedAt: Date.parse(m.receivedDateTime) || 0,
      unread: m.isRead === false, labels, listId: null, hasUnsub: m.unsubscribeEnabled === true, messageId: m.internetMessageId ?? null,
    };
  };

  async function run(start: string, full: boolean, o2: SyncOptions, windowFrom: number): Promise<SyncBatch> {
    const upserts: HeaderIn[] = [], patches: HeaderPatch[] = [], deletes: string[] = [];
    let path: string | null = start, cursor: string | null = null, pages = 0, cutShort = false;
    while (path) {
      if (pages++ >= maxPages) { cursor = path; cutShort = true; break; } // keep what was read; carry on from here next time
      const r: any = await call(path, { headers: { prefer: 'odata.maxpagesize=100' } });
      for (const m of r.value ?? []) {
        if (!m?.id) continue;
        if (m['@removed']) { deletes.push(String(m.id)); continue; }
        if (m.receivedDateTime) upserts.push(toHeader(m));
        else patches.push({ providerId: String(m.id), ...(typeof m.isRead === 'boolean' ? { unread: !m.isRead } : {}), ...(Array.isArray(m.categories) ? { labels: m.categories.map(String) } : {}) });
      }
      if (r['@odata.deltaLink']) { cursor = String(r['@odata.deltaLink']); path = null; break; }
      path = r['@odata.nextLink'] ? String(r['@odata.nextLink']) : null;
    }
    if (!cursor) throw new Error('Outlook did not finish the change list (no deltaLink).');
    // a full sync cut short is not the whole window: nothing may be deleted for being unseen
    return { full: full && !cutShort, upserts, patches, deletes, cursor, windowFrom, windowTo: o2.now };
  }

  let address: string | null = null;
  return {
    prefix: 'outlook', provider: 'outlook', label: 'Outlook',
    async resolveAccount(): Promise<string> {
      const k = outlookAccountKey();
      if (k.includes(':')) return k;
      if (!address) {
        const me = await call('/me?$select=mail,userPrincipalName');
        const a = String(me?.mail || me?.userPrincipalName || '').toLowerCase();
        address = isAddrSpec(a) ? a : null;
      }
      return address ? `outlook:${address}` : 'outlook';
    },
    async sync(state: SyncStateRow | null, o2: SyncOptions): Promise<SyncBatch> {
      const windowFrom = o2.now - o2.windowDays * 86_400_000;
      const first = `/me/mailFolders/inbox/messages/delta?$select=${SELECT}&$filter=${encodeURIComponent(`receivedDateTime ge ${new Date(windowFrom).toISOString()}`)}`;
      if (state?.cursor) {
        try { return await run(state.cursor, false, o2, windowFrom); }
        catch (e) { if (!isExpiredDelta(e)) throw e; } // the delta token expired (or the link is foreign): a full window again
      }
      return run(first, true, o2, windowFrom);
    },
    async fetchBody(id: string): Promise<RawBody> {
      let m: any;
      try { m = await call(`/me/messages/${enc(id)}?$select=body,toRecipients,from,replyTo`); }
      catch (e) { if (isNotFound(e)) throw new MessageGoneError(); throw e; }
      const content = String(m.body?.content ?? '');
      const html = String(m.body?.contentType ?? '').toLowerCase() === 'html';
      return { html: html ? content : null, text: html ? null : content, from: graphAddrs(m.from), replyTo: graphAddrs(m.replyTo), to: graphAddrs(m.toRecipients) };
    },
    async saveReplyDraft(id: string, req: DraftRequest): Promise<DraftResult> {
      const key = req.draftId.replace(/'/g, "''");
      const filter = encodeURIComponent(`singleValueExtendedProperties/Any(ep: ep/id eq '${DRAFT_PROP}' and ep/value eq '${key}')`);
      const found = await call(`/me/mailFolders/drafts/messages?$filter=${filter}&$select=id,toRecipients&$top=1`).catch(() => null);
      const prior = found?.value?.[0];
      if (prior?.id) return { draftId: String(prior.id), to: graphAddrs(prior.toRecipients), already: true };
      let d: any;
      // createReply makes a DRAFT reply (threaded, addressed, quoted below). It is never followed by /send.
      try {
        d = await call(`/me/messages/${enc(id)}/createReply`, { method: 'POST', body: JSON.stringify({
          comment: req.body, message: { singleValueExtendedProperties: [{ id: DRAFT_PROP, value: req.draftId }] },
        }) });
      } catch (e) { if (isNotFound(e)) throw new MessageGoneError(); throw e; }
      return { draftId: d?.id ? String(d.id) : null, to: graphAddrs(d?.toRecipients), already: false };
    },
  };
}
