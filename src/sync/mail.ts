/**
 * Mail sync, reader and reply drafts (v2 build, slice A8, 2026-10-26).
 *
 * Sync: for each connected account — Gmail over OAuth, or else Gmail over an app password (the same rule as the tool
 * registry: one Gmail path at a time), and Outlook — fetch what changed in the inbox headers and apply it to app.db
 * in one transaction per account. Every 15 minutes and when the app opens (POST /mail/refresh); no model calls.
 * A sign-in that is no longer valid (invalid_grant, 401) marks the account `needs_reconnect`; the others carry on.
 * The same email in two accounts is stored per account and shown once (src/v2/mail.ts listMail), the way
 * listUniqueMessages collapses copies by Message-ID.
 *
 * Reader: a body is fetched from the provider when it is opened, sanitised to plain text (mail-sanitize.ts) and kept
 * ONLY in this process, in a small cache (15 minutes, 50 messages). Bodies are never written to disk or app.db.
 *
 * Drafts: a reply is saved as a DRAFT through the provider's draft path. There is no send anywhere in this module.
 */
import { googleConfigured } from '../connectors/google.js';
import { gmailImapConfigured } from '../connectors/gmail-imap.js';
import { microsoftConfigured } from '../connectors/microsoft.js';
import { logger } from '../logger.js';
import { applySync, getMail, getSyncState, knownIds, markSyncError, type ApplyResult, type MailRow } from '../v2/mail.js';
import { gmailProvider } from './gmail.js';
import { imapProvider } from './imap.js';
import { outlookProvider } from './outlook-mail.js';
import { sanitizeMail, type SanitizedBody } from './mail-sanitize.js';
import { MessageGoneError, isReauthError, type MailProvider } from './mail-types.js';

export const MAIL_WINDOW_DAYS = 14;
export const MAIL_SYNC_EVERY_MS = 15 * 60_000;
export const BODY_CACHE_TTL_MS = 15 * 60_000;
export const BODY_CACHE_MAX = 50;
export const DRAFT_MAX_CHARS = 20_000;

/** The connected accounts, by the same rule as the tool registry (src/tools/build.ts). */
export function defaultMailProviders(): MailProvider[] {
  const out: MailProvider[] = [];
  if (googleConfigured()) out.push(gmailProvider());
  else if (gmailImapConfigured()) out.push(imapProvider());
  if (microsoftConfigured()) out.push(outlookProvider());
  return out;
}
let providersFn: () => MailProvider[] = defaultMailProviders;
/** Tests: fake providers (null restores the real ones). Also clears the body cache. */
export function setMailProviders(fn: (() => MailProvider[]) | null): void { providersFn = fn ?? defaultMailProviders; bodyCache.clear(); }
export function mailProviders(): MailProvider[] { return providersFn(); }
function providerFor(account: string): MailProvider | null { return mailProviders().find((p) => p.account === account) ?? null; }

/** An answer the API turns into an error response. */
export class MailError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

// ── sync ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface AccountSyncResult { account: string; ok: boolean; needsReconnect: boolean; error?: string; result?: ApplyResult; full?: boolean }
export interface MailSyncReport { at: number; accounts: AccountSyncResult[] }

let inFlight: Promise<MailSyncReport> | null = null;
let lastReport: MailSyncReport | null = null;
export function mailSyncRunning(): boolean { return inFlight !== null; }
export function lastMailSync(): MailSyncReport | null { return lastReport; }

const shortError = (e: unknown) => String((e as Error)?.message ?? e).replace(/\s+/g, ' ').slice(0, 200);

/** Sync every connected account once. A second call while one runs gets the same run (single flight). */
export function syncMail(o: { now?: () => number } = {}): Promise<MailSyncReport> {
  if (inFlight) return inFlight;
  const run = (async (): Promise<MailSyncReport> => {
    try { return await syncAll(o); }
    finally { inFlight = null; } // cleared before callers see the result, so a sync right after starts afresh
  })();
  inFlight = run;
  return run;
}

async function syncAll(o: { now?: () => number }): Promise<MailSyncReport> {
  const accounts: AccountSyncResult[] = [];
  for (const p of mailProviders()) {
    const now = (o.now ?? Date.now)();
    try {
      const batch = await p.sync(getSyncState(p.account), { now, windowDays: MAIL_WINDOW_DAYS, known: () => knownIds(p.account) });
      const result = applySync(p.account, p.provider, batch, now);
      accounts.push({ account: p.account, ok: true, needsReconnect: false, result, full: batch.full });
    } catch (e) {
      const reconnect = isReauthError(e);
      const msg = reconnect ? `${p.label} needs to be reconnected.` : `Could not sync ${p.label}: ${shortError(e)}`;
      try { markSyncError(p.account, msg, reconnect); } catch { /* the database is busy: the next run records it */ }
      logger.warn('mail', 'sync failed', { account: p.account, reconnect, error: shortError(e) });
      accounts.push({ account: p.account, ok: false, needsReconnect: reconnect, error: msg });
    }
  }
  const report = { at: (o.now ?? Date.now)(), accounts };
  lastReport = report;
  return report;
}

/** Sync now and every 15 minutes (the server process only). Returns a stop function. */
export function startMailSync(o: { everyMs?: number; firstAfterMs?: number } = {}): () => void {
  const tick = () => { if (mailProviders().length) void syncMail().catch(() => { /* per account */ }); };
  const first = setTimeout(tick, o.firstAfterMs ?? 5_000);
  const timer = setInterval(tick, o.everyMs ?? MAIL_SYNC_EVERY_MS);
  first.unref?.(); timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}

export interface MailAccountView {
  account: string; provider: string; label: string; needsReconnect: boolean; lastOk: number | null; lastError: string | null;
  windowFrom: number | null; syncing: boolean;
}
export function mailAccounts(): MailAccountView[] {
  return mailProviders().map((p) => {
    const s = getSyncState(p.account);
    return {
      account: p.account, provider: p.provider, label: p.label, needsReconnect: s?.needs_reconnect === 1,
      lastOk: s?.last_ok ?? null, lastError: s?.last_error ?? null, windowFrom: s?.window_from ?? null, syncing: mailSyncRunning(),
    };
  });
}

// ── reader ──────────────────────────────────────────────────────────────────────────────────────────────────────

interface CachedBody { at: number; body: SanitizedBody; to: string | null }
/** In-process only: a Map in insertion order, refreshed on use, oldest evicted. Never persisted. */
class BodyCache {
  private m = new Map<string, CachedBody>();
  constructor(private ttl: number, private max: number) {}
  get(k: string, now = Date.now()): CachedBody | null {
    const v = this.m.get(k);
    if (!v) return null;
    if (now - v.at > this.ttl) { this.m.delete(k); return null; }
    this.m.delete(k); this.m.set(k, v);
    return v;
  }
  set(k: string, v: CachedBody): void {
    this.m.delete(k); this.m.set(k, v);
    while (this.m.size > this.max) this.m.delete(this.m.keys().next().value as string);
  }
  delete(k: string): void { this.m.delete(k); }
  clear(): void { this.m.clear(); }
  get size(): number { return this.m.size; }
}
const bodyCache = new BodyCache(BODY_CACHE_TTL_MS, BODY_CACHE_MAX);
export function bodyCacheSize(): number { return bodyCache.size; }

function failure(p: MailProvider, e: unknown, doing: string): MailError {
  if (e instanceof MessageGoneError) return new MailError(404, 'gone', 'That message is no longer in your inbox.');
  if (isReauthError(e)) {
    try { markSyncError(p.account, `${p.label} needs to be reconnected.`, true); } catch { /* best-effort */ }
    return new MailError(409, 'needs_reconnect', `${p.label} needs to be reconnected in Settings before I can ${doing}.`);
  }
  logger.warn('mail', `${doing} failed`, { account: p.account, error: shortError(e) });
  return new MailError(502, 'provider_unavailable', `I couldn't reach ${p.label} just now. Try again in a moment.`);
}
function locate(row: MailRow | null): MailProvider {
  if (!row) throw new MailError(404, 'not_found', 'No such message.');
  const p = providerFor(row.account);
  if (!p) throw new MailError(409, 'not_connected', 'That account is not connected any more.');
  return p;
}

export interface OpenedMail { row: MailRow; body: SanitizedBody; to: string | null; fetchedAt: number }

/** Open a message: its body from the provider (or the cache), as sanitised plain text. */
export async function openMail(account: string, providerId: string, now = Date.now()): Promise<OpenedMail> {
  const row = getMail(account, providerId);
  const p = locate(row);
  const key = `${account}\n${providerId}`;
  const hit = bodyCache.get(key, now);
  if (hit) return { row: row!, body: hit.body, to: hit.to, fetchedAt: hit.at };
  let raw;
  try { raw = await p.fetchBody(providerId); } catch (e) { throw failure(p, e, 'open this message'); }
  const body = sanitizeMail(raw);
  const to = raw.to ? raw.to.replace(/[\r\n]+/g, ' ').slice(0, 1000) : null;
  bodyCache.set(key, { at: now, body, to });
  return { row: row!, body, to, fetchedAt: now };
}

/** Save `text` as a reply DRAFT in the message's own account. Never sends. */
export async function saveReplyDraft(account: string, providerId: string, text: string): Promise<{ account: string; label: string; draftId: string | null }> {
  const p = locate(getMail(account, providerId));
  try {
    const r = await p.saveReplyDraft(providerId, text);
    return { account, label: p.label, draftId: r.draftId };
  } catch (e) { throw failure(p, e, 'save the draft'); }
}
