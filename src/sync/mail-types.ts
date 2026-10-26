/**
 * What every mail provider (Gmail REST, IMAP, Microsoft Graph) offers the mail sync and the reader (slice A8).
 * Read and DRAFT only: there is deliberately no send in this interface.
 */
import type { MailProviderKind, SyncBatch, SyncStateRow } from '../v2/mail.js';
import type { Addr } from '../v2/mail-text.js';
import { errorStatus, reconnectNeeded } from './errors.js';

export interface RawBody {
  html: string | null;
  text: string | null;
  /** parsed structurally (untrusted: names are cleaned before they are shown) */
  from: Addr[];
  replyTo: Addr[];
  to: Addr[];
}

export interface SyncOptions {
  now: number;
  windowDays: number;
  /** provider ids already cached for this account (IMAP diffs against them) */
  known: () => string[];
}

export interface DraftRequest {
  body: string;
  /** this draft's own Message-ID, derived from the request's Idempotency-Key (mail-mime.ts draftMessageId) */
  draftId: string;
}
export interface DraftResult {
  draftId: string | null;
  /** who the reply is addressed to (the original's Reply-To, else its From) */
  to: Addr[];
  /** true: a draft with this draftId was already in Drafts, so none was added */
  already: boolean;
}

export interface MailProvider {
  /** the account key's provider part: 'google', 'imap', 'outlook' */
  prefix: string;
  provider: MailProviderKind;
  /** for a person: "Gmail", "Gmail (app password)", "Outlook" */
  label: string;
  /** The account key, 'prefix:<address>' (asks the provider for the signed-in address when it must). */
  resolveAccount(): Promise<string>;
  /** Headers changed since `state.cursor` — or the whole window when there is no usable cursor. */
  sync(state: SyncStateRow | null, o: SyncOptions): Promise<SyncBatch>;
  /** One message's body, fetched now (never stored). Throws MessageGoneError when it no longer exists. */
  fetchBody(providerId: string): Promise<RawBody>;
  /** Save a reply DRAFT to the message, with proper reply headers — unless that draft is already there. Never sends. */
  saveReplyDraft(providerId: string, req: DraftRequest): Promise<DraftResult>;
}

/** The message is not in the mailbox any more (deleted, moved, or the IMAP mailbox was reset). */
export class MessageGoneError extends Error {
  constructor(message = 'That message is no longer in the mailbox.') { super(message); this.name = 'MessageGoneError'; }
}
/** The provider's sign-in is no longer valid: the person must reconnect the account. */
export class ReconnectError extends Error {
  constructor(message: string) { super(message); this.name = 'ReconnectError'; }
}

const errText = (e: unknown) => {
  const x = e as { message?: string; responseText?: string; response?: { data?: unknown } };
  let data = '';
  try { data = x?.response?.data ? JSON.stringify(x.response.data).slice(0, 500) : ''; } catch { data = ''; }
  return `${x?.message ?? ''} ${x?.responseText ?? ''} ${data}`;
};

/**
 * True when an error means the sign-in itself is no longer valid (so retrying will not help). One test for the
 * calendar and mail syncs: src/sync/errors.ts reconnectNeeded (invalid_grant, 401, a permission the sign-in lacks,
 * an IMAP login refused, Microsoft's token refresh refused).
 */
export function isReauthError(e: unknown): boolean {
  return e instanceof ReconnectError || reconnectNeeded(e);
}

/** True when the sign-in works but does not allow drafting (Gmail without gmail.compose, Outlook with Mail.Read).
 *  Checked BEFORE isReauthError on a draft: both are 403s, and this one needs a different reconnect. */
export function isReadOnlyError(e: unknown): boolean {
  return statusOf(e) === 403 && /insufficient|scope|ACCESS_TOKEN_SCOPE|AccessDenied|Access is denied/i.test(errText(e)) && !/rate ?limit|quota/i.test(errText(e));
}

/** The HTTP status an API error carries, or 0 (src/sync/errors.ts errorStatus). */
export function statusOf(e: unknown): number {
  return errorStatus(e) ?? 0;
}

/** Run `fn` over items, at most `n` at once, keeping order. */
export async function mapLimit<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

/** Recipients of a reply: the Reply-To when there is one, else the From. */
export function replyRecipients(from: Addr[], replyTo: Addr[]): Addr[] {
  const r = replyTo.filter((a) => a.addr);
  return r.length ? r : from.filter((a) => a.addr);
}
/** True when a reply would go somewhere other than the sender (Reply-To names other addresses). */
export function replyGoesElsewhere(from: Addr[], to: Addr[]): boolean {
  const senders = new Set(from.map((a) => a.addr).filter(Boolean));
  return to.some((a) => a.addr && !senders.has(a.addr));
}
