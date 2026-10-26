/**
 * What every mail provider (Gmail REST, IMAP, Microsoft Graph) offers the mail sync and the reader (slice A8).
 * Read and DRAFT only: there is deliberately no send in this interface.
 */
import type { MailProviderKind, SyncBatch, SyncStateRow } from '../v2/mail.js';

export interface RawBody {
  html: string | null;
  text: string | null;
  /** the recipients line, as the provider reports it (shown in the reader; untrusted) */
  to: string | null;
}

export interface SyncOptions {
  now: number;
  windowDays: number;
  /** provider ids already cached for this account (IMAP diffs against them) */
  known: () => string[];
}

export interface MailProvider {
  /** a stable key for the connected account: 'gmail', 'imap', 'outlook' */
  account: string;
  provider: MailProviderKind;
  /** for a person: "Gmail", "Gmail (app password)", "Outlook" */
  label: string;
  /** Headers changed since `state.cursor` — or the whole window when there is no usable cursor. */
  sync(state: SyncStateRow | null, o: SyncOptions): Promise<SyncBatch>;
  /** One message's body, fetched now (never stored). Throws MessageGoneError when it no longer exists. */
  fetchBody(providerId: string): Promise<RawBody>;
  /** Save `body` as a reply DRAFT to the message, with proper reply headers. Never sends. */
  saveReplyDraft(providerId: string, body: string): Promise<{ draftId: string | null }>;
}

/** The message is not in the mailbox any more (deleted, moved, or the IMAP mailbox was reset). */
export class MessageGoneError extends Error {
  constructor(message = 'That message is no longer in the mailbox.') { super(message); this.name = 'MessageGoneError'; }
}
/** The provider's sign-in is no longer valid: the person must reconnect the account. */
export class ReconnectError extends Error {
  constructor(message: string) { super(message); this.name = 'ReconnectError'; }
}

/**
 * True when an error means the sign-in itself is no longer valid (so retrying will not help): Google's
 * `invalid_grant` (a revoked or expired refresh token — Google Cloud projects in "Testing" expire them after 7
 * days), an HTTP 401 from Gmail or Graph, a Microsoft token refresh refused, an IMAP login refused.
 */
export function isReauthError(e: unknown): boolean {
  if (e instanceof ReconnectError) return true;
  const x = e as { message?: string; status?: number; code?: unknown; response?: { status?: number; data?: { error?: unknown } }; authenticationFailed?: boolean; responseText?: string };
  if (!x || typeof x !== 'object') return false;
  if (x.authenticationFailed) return true;
  if (x.response?.data?.error === 'invalid_grant' || x.response?.data?.error === 'unauthorized_client') return true;
  if (x.response?.status === 401 || x.status === 401 || x.code === 401 || x.code === '401') return true;
  const msg = `${x.message ?? ''} ${x.responseText ?? ''}`;
  return /invalid_grant|AUTHENTICATIONFAILED|Graph 401\b|token refresh failed: 40[01]\b|not connected/i.test(msg);
}

/** The HTTP status an API error carries (gaxios puts it in a few places), or 0. */
export function statusOf(e: unknown): number {
  const x = e as { status?: number; code?: unknown; response?: { status?: number } };
  const n = Number(x?.response?.status ?? x?.status ?? x?.code);
  return Number.isFinite(n) ? n : 0;
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
