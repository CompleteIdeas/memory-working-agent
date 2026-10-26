/**
 * Outlook / Microsoft 365 header sync over Microsoft Graph (slice A8), through the existing signed-in call
 * (connectors/microsoft.ts graph). A messages DELTA query on the inbox, limited to the 14-day window:
 *   - the first sync pages through @odata.nextLink to an @odata.deltaLink, which is stored as the cursor;
 *   - each later sync follows the stored deltaLink: new and changed messages, and `@removed` entries;
 *   - when Graph says the delta token is no longer valid (410 Gone, syncStateNotFound / resyncRequired) the window is
 *     synced again from scratch.
 * A changed message can come back with only the properties that changed; one without receivedDateTime is applied
 * as a patch (read state, categories) to the cached header.
 * Reply drafts use Graph's createReply, which threads the draft under the original. Nothing here calls /send.
 */
import { graph, graphPath } from '../connectors/microsoft.js';
import type { HeaderIn, HeaderPatch, SyncBatch, SyncStateRow } from '../v2/mail.js';
import { MessageGoneError, type MailProvider, type RawBody, type SyncOptions } from './mail-types.js';

const SELECT = 'id,conversationId,from,subject,bodyPreview,receivedDateTime,isRead,categories,inferenceClassification,internetMessageId,unsubscribeEnabled';
const MAX_PAGES = 100;

export interface OutlookOptions {
  account?: string;
  /** the Graph call (default: the stored sign-in) */
  call?: (path: string, init?: RequestInit) => Promise<any>;
}

const isExpiredDelta = (e: unknown) => /Graph 410\b|syncStateNotFound|resyncRequired|SyncStateInvalid|syncStateInvalid/i.test((e as Error)?.message ?? '');
const isNotFound = (e: unknown) => /Graph 404\b|ErrorItemNotFound/i.test((e as Error)?.message ?? '');

export function outlookProvider(o: OutlookOptions = {}): MailProvider {
  const account = o.account ?? 'outlook';
  const call = o.call ?? graph;
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
    let path: string | null = start, cursor: string | null = null, pages = 0;
    while (path && pages++ < MAX_PAGES) {
      const r: any = await call(path, { headers: { prefer: 'odata.maxpagesize=100' } });
      for (const m of r.value ?? []) {
        if (!m?.id) continue;
        if (m['@removed']) { deletes.push(String(m.id)); continue; }
        if (m.receivedDateTime) upserts.push(toHeader(m));
        else patches.push({ providerId: String(m.id), ...(typeof m.isRead === 'boolean' ? { unread: !m.isRead } : {}), ...(Array.isArray(m.categories) ? { labels: m.categories.map(String) } : {}) });
      }
      if (r['@odata.deltaLink']) { cursor = String(r['@odata.deltaLink']); break; }
      path = r['@odata.nextLink'] ? graphPath(String(r['@odata.nextLink'])) : null;
    }
    if (!cursor) throw new Error('Outlook did not finish the change list (no deltaLink).');
    return { full, upserts, patches, deletes, cursor, windowFrom, windowTo: o2.now };
  }

  return {
    account, provider: 'outlook', label: 'Outlook',
    async sync(state: SyncStateRow | null, o2: SyncOptions): Promise<SyncBatch> {
      const windowFrom = o2.now - o2.windowDays * 86_400_000;
      const first = `/me/mailFolders/inbox/messages/delta?$select=${SELECT}&$filter=${encodeURIComponent(`receivedDateTime ge ${new Date(windowFrom).toISOString()}`)}`;
      if (state?.cursor) {
        try { return await run(graphPath(state.cursor), false, o2, windowFrom); }
        catch (e) { if (!isExpiredDelta(e)) throw e; } // the delta token expired: a full window again
      }
      return run(first, true, o2, windowFrom);
    },
    async fetchBody(id: string): Promise<RawBody> {
      let m: any;
      try { m = await call(`/me/messages/${enc(id)}?$select=body,toRecipients`); }
      catch (e) { if (isNotFound(e)) throw new MessageGoneError(); throw e; }
      const content = String(m.body?.content ?? '');
      const html = String(m.body?.contentType ?? '').toLowerCase() === 'html';
      const to = (m.toRecipients ?? []).map((r: any) => r.emailAddress?.name ? `${r.emailAddress.name} <${r.emailAddress.address}>` : r.emailAddress?.address).filter(Boolean).join(', ');
      return { html: html ? content : null, text: html ? null : content, to: to || null };
    },
    async saveReplyDraft(id: string, body: string) {
      let d: any;
      // createReply makes a DRAFT reply (threaded, addressed, quoted below). It is never followed by /send.
      try { d = await call(`/me/messages/${enc(id)}/createReply`, { method: 'POST', body: JSON.stringify({ comment: body }) }); }
      catch (e) { if (isNotFound(e)) throw new MessageGoneError(); throw e; }
      return { draftId: d?.id ? String(d.id) : null };
    },
  };
}
