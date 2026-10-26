/**
 * /api/v1/mail (v2 slice A8): the plain mailbox ("All email"), the reader, and saving a drafted reply.
 *
 *   GET  /mail?before=&limit=   headers, newest first, one row per message across accounts; cursor pagination
 *   GET  /mail/accounts         the connected accounts and whether one needs reconnecting
 *   GET  /mail/{id}             one message, its body as sanitised plain text, marked untrusted
 *   POST /mail/{id}/draft       save {body} as a reply DRAFT in that account ("Saved to your drafts. Nothing was sent.")
 *   POST /mail/refresh          sync now (the app calls it when it opens)
 *
 * The helper reads and writes drafts. It never sends: there is no send route, and the providers have no send.
 * A retried draft (the phone's offline queue) is answered from the router's Idempotency-Key record, not saved twice.
 */
import { ApiError, type Route } from '../router.js';
import { apiMailHeader, listMail, parseMailId, type MailPageCursor } from '../../v2/mail.js';
import { DRAFT_MAX_CHARS, MailError, mailAccounts, mailProviders, openMail, saveReplyDraft, syncMail } from '../../sync/mail.js';

export const SAVED_MESSAGE = 'Saved to your drafts. Nothing was sent.';
export const MAILBOX_NOTE = 'Your helper reads and writes drafts. It never sends.';
const REFRESH_WAIT_MS = 20_000;

const asApi = (e: unknown): never => {
  if (e instanceof MailError) throw new ApiError(e.status, e.code, e.message);
  throw e;
};
function idParam(id: string): { account: string; providerId: string } {
  const p = parseMailId(id);
  if (!p) throw new ApiError(404, 'not_found', 'No such message.');
  return p;
}

/** The page cursor: "<receivedAt>.<message id>" of the last message on the previous page. */
function encodeBefore(receivedAt: number, id: string): string { return `${receivedAt}.${id}`; }
function decodeBefore(v: string | null): MailPageCursor | null {
  if (v === null || v === '') return null;
  const m = /^(\d{1,15})\.(m_[A-Za-z0-9_-]+)$/.exec(v);
  const id = m ? parseMailId(m[2]) : null;
  if (!m || !id) throw new ApiError(400, 'bad_cursor', 'The before cursor must be one the server gave you.');
  return { receivedAt: Number(m[1]), account: id.account, providerId: id.providerId };
}

export const mailRoutes: Route[] = [
  {
    method: 'GET', path: '/mail', scope: 'read',
    handler: ({ url }) => {
      const before = decodeBefore(url.searchParams.get('before'));
      const rawLimit = url.searchParams.get('limit');
      const limit = rawLimit === null ? 50 : Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ApiError(400, 'bad_limit', 'limit must be a whole number from 1 to 200.');
      const rows = listMail({ before, limit: limit + 1 });
      const page = rows.slice(0, limit).map(apiMailHeader);
      const last = page[page.length - 1];
      return {
        body: {
          mail: page, nextBefore: rows.length > limit && last ? encodeBefore(last.receivedAt, last.id) : null,
          note: MAILBOX_NOTE, connected: mailProviders().length > 0,
        },
      };
    },
  },
  {
    method: 'GET', path: '/mail/accounts', scope: 'read',
    handler: () => ({ body: { accounts: mailAccounts(), note: MAILBOX_NOTE } }),
  },
  {
    method: 'POST', path: '/mail/refresh', scope: 'act',
    handler: async () => {
      if (!mailProviders().length) throw new ApiError(409, 'not_connected', 'No email account is connected. Connect Gmail or Outlook in Settings.');
      const run = syncMail();
      const done = await Promise.race([run.then(() => true), new Promise<false>((r) => setTimeout(() => r(false), REFRESH_WAIT_MS).unref?.())]);
      const report = done ? await run : null;
      return {
        status: done ? 200 : 202,
        body: {
          done, accounts: mailAccounts(),
          message: !done ? 'Still checking your mail. New messages will appear as they arrive.'
            : report!.accounts.some((a) => a.needsReconnect) ? 'Some accounts need to be reconnected in Settings.'
            : report!.accounts.some((a) => !a.ok) ? 'I could not check every account just now.' : 'Up to date.',
        },
      };
    },
  },
  {
    method: 'GET', path: '/mail/{id}', scope: 'read',
    handler: async ({ params }) => {
      const { account, providerId } = idParam(params.id);
      const m = await openMail(account, providerId).catch(asApi);
      return {
        body: {
          ...apiMailHeader(m.row), to: m.to, bodyText: m.body.text, truncated: m.body.truncated,
          quotedLinesHidden: m.body.quotedLinesHidden, imagesHidden: m.body.imagesHidden, trackersRemoved: m.body.trackersRemoved,
          trust: 'untrusted' as const, fetchedAt: m.fetchedAt,
        },
      };
    },
  },
  {
    method: 'POST', path: '/mail/{id}/draft', scope: 'act',
    handler: async ({ params, body }) => {
      const { account, providerId } = idParam(params.id);
      const text = (body as { body?: unknown } | undefined)?.body;
      if (typeof text !== 'string' || !text.trim()) throw new ApiError(400, 'bad_body', 'Send the reply as {"body": "…"}.');
      if (text.length > DRAFT_MAX_CHARS) throw new ApiError(400, 'too_long', `A reply can be up to ${DRAFT_MAX_CHARS} characters.`);
      const r = await saveReplyDraft(account, providerId, text.replace(/\r\n?/g, '\n')).catch(asApi);
      return { status: 201, body: { saved: true, sent: false, account: r.account, draftId: r.draftId, message: SAVED_MESSAGE } };
    },
  },
];
