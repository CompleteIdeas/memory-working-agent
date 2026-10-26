/**
 * Mail sync, reader and reply drafts (v2 build, slice A8, 2026-10-26).
 *
 * Sync: for each connected account — Gmail over OAuth, or else Gmail over an app password (the same rule as the tool
 * registry: one Gmail path at a time), and Outlook — fetch what changed in the inbox headers and apply it to app.db
 * in one transaction per account. Every 15 minutes and when the app opens (POST /mail/refresh); no model calls.
 * A sign-in that is no longer valid (invalid_grant, 401) marks the account `needs_reconnect`; the others carry on.
 *
 * Accounts (review of A8): keyed 'provider:<address>' (src/v2/sync-state.ts). Each run works out every connected
 * account's key; an account that is no longer connected — or whose address changed, which is a different key — has
 * its headers and sync state removed, so a new address starts with a full window and an old one's mail stops showing.
 *
 * Reader: a body is fetched from the provider when it is opened, sanitised to plain text in a worker thread with a
 * time budget (mail-sanitize-run.ts) and kept ONLY in this process, in a small cache (15 minutes, 50 messages).
 * Bodies are never written to disk or app.db.
 *
 * Drafts: a reply is saved as a DRAFT through the provider's draft path, with an id derived from the request's
 * Idempotency-Key so a retry finds the draft it already made. There is no send anywhere in this module.
 */
import { googleConfigured } from '../connectors/google.js';
import { gmailImapConfigured } from '../connectors/gmail-imap.js';
import { microsoftConfigured } from '../connectors/microsoft.js';
import { logger } from '../logger.js';
import { applySync, getMail, knownIds, mailAccountsStored, purgeMailAccount, MAIL_RESOURCE, type ApplyResult, type MailRow } from '../v2/mail.js';
import { cleanLine, showAddresses, type Addr } from '../v2/mail-text.js';
import { getSyncState, listSyncStates, recordSyncError } from '../v2/sync-state.js';
import { gmailProvider } from './gmail.js';
import { imapProvider } from './imap.js';
import { outlookProvider } from './outlook-mail.js';
import { sanitizeMailSafe, type SafeSanitized } from './mail-sanitize-run.js';
import { MessageGoneError, isReadOnlyError, isReauthError, replyGoesElsewhere, replyRecipients, type MailProvider } from './mail-types.js';
import { shortError } from './errors.js';

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
let sanitizeInline = false;
/** Tests: fake providers (null restores the real ones). Also forgets the body cache and the account keys. */
export function setMailProviders(fn: (() => MailProvider[]) | null, o: { inlineSanitize?: boolean } = {}): void {
  providersFn = fn ?? defaultMailProviders; bodyCache.clear(); keys.clear(); sanitizeInline = !!o.inlineSanitize;
}
export function mailProviders(): MailProvider[] { return providersFn(); }

/** An answer the API turns into an error response. `transient`: a retry with the same Idempotency-Key runs again. */
export class MailError extends Error {
  constructor(public status: number, public code: string, message: string, public transient = false) { super(message); }
}

// ── account keys ────────────────────────────────────────────────────────────────────────────────────────────────

/** The last key each connected provider resolved to (by prefix: one account per provider). */
const keys = new Map<string, string>();

/** A provider's account key; when it cannot be worked out now, the last one known (or the bare provider). */
async function accountOf(p: MailProvider): Promise<{ key: string; error?: unknown }> {
  try {
    const key = await p.resolveAccount();
    keys.set(p.prefix, key);
    return { key };
  } catch (e) {
    const stored = listSyncStates(MAIL_RESOURCE, p.prefix);
    return { key: keys.get(p.prefix) ?? (stored.length === 1 ? stored[0].account : p.prefix), error: e };
  }
}

// ── sync ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface AccountSyncResult { account: string; ok: boolean; needsReconnect: boolean; error?: string; result?: ApplyResult; full?: boolean }
export interface MailSyncReport { at: number; accounts: AccountSyncResult[]; purged: string[] }

let inFlight: Promise<MailSyncReport> | null = null;
let lastReport: MailSyncReport | null = null;
export function mailSyncRunning(): boolean { return inFlight !== null; }
export function lastMailSync(): MailSyncReport | null { return lastReport; }

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
  const live = new Set<string>();
  for (const p of mailProviders()) {
    const now = (o.now ?? Date.now)();
    const { key: account, error: keyError } = await accountOf(p);
    live.add(account);
    try {
      if (keyError) throw keyError;
      const batch = await p.sync(getSyncState(account, MAIL_RESOURCE), { now, windowDays: MAIL_WINDOW_DAYS, known: () => knownIds(account) });
      const result = applySync(account, p.provider, batch, now);
      accounts.push({ account, ok: true, needsReconnect: false, result, full: batch.full });
    } catch (e) {
      const reconnect = isReauthError(e);
      const msg = reconnect ? `${p.label} needs to be reconnected.` : `Could not sync ${p.label}: ${shortError(e)}`;
      try { recordSyncError(account, MAIL_RESOURCE, msg, reconnect); } catch { /* the database is busy: the next run records it */ }
      logger.warn('mail', 'sync failed', { account, reconnect, error: shortError(e) });
      accounts.push({ account, ok: false, needsReconnect: reconnect, error: msg });
    }
  }
  // accounts no longer connected (or whose address changed): their mail goes
  const purged: string[] = [];
  for (const a of mailAccountsStored()) {
    if (live.has(a)) continue;
    try { purgeMailAccount(a); purged.push(a); } catch (e) { logger.warn('mail', 'purge failed', { account: a, error: shortError(e) }); }
  }
  if (purged.length) for (const k of [...bodyCache.keys()]) if (purged.some((a) => k.startsWith(`${a}\n`))) bodyCache.delete(k);
  const report = { at: (o.now ?? Date.now)(), accounts, purged };
  lastReport = report;
  return report;
}

/** Sync now and every 15 minutes (the server process only). Returns a stop function. */
export function startMailSync(o: { everyMs?: number; firstAfterMs?: number } = {}): () => void {
  const tick = () => { void syncMail().catch(() => { /* per account */ }); };
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
    const account = keys.get(p.prefix) ?? (() => { const s = listSyncStates(MAIL_RESOURCE, p.prefix); return s.length === 1 ? s[0].account : p.prefix; })();
    const s = getSyncState(account, MAIL_RESOURCE);
    return {
      account, provider: p.provider, label: p.label, needsReconnect: s?.needs_reconnect === 1,
      lastOk: s?.last_ok ?? null, lastError: s?.last_error ?? null, windowFrom: s?.window_from ?? null, syncing: mailSyncRunning(),
    };
  });
}

// ── reader ──────────────────────────────────────────────────────────────────────────────────────────────────────

interface CachedBody { at: number; body: SafeSanitized; to: Addr[]; from: Addr[]; replyTo: Addr[] }
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
  keys(): IterableIterator<string> { return this.m.keys(); }
  delete(k: string): void { this.m.delete(k); }
  clear(): void { this.m.clear(); }
  get size(): number { return this.m.size; }
}
const bodyCache = new BodyCache(BODY_CACHE_TTL_MS, BODY_CACHE_MAX);
export function bodyCacheSize(): number { return bodyCache.size; }

function failure(p: MailProvider, account: string, e: unknown, doing: string): MailError {
  if (e instanceof MessageGoneError) return new MailError(404, 'gone', 'That message is no longer in your inbox.');
  if (isReadOnlyError(e)) return new MailError(409, 'read_only', `${p.label} was connected read-only. Reconnect it in Settings with drafting allowed.`, true);
  if (isReauthError(e)) {
    try { recordSyncError(account, MAIL_RESOURCE, `${p.label} needs to be reconnected.`, true); } catch { /* best-effort */ }
    return new MailError(409, 'needs_reconnect', `${p.label} needs to be reconnected in Settings before I can ${doing}.`, true);
  }
  logger.warn('mail', `${doing} failed`, { account, error: shortError(e) });
  return new MailError(502, 'provider_unavailable', `I couldn't reach ${p.label} just now. Try again in a moment.`, true);
}

/** The connected provider a cached row belongs to — only when it is still the same account (address and all). */
async function locate(row: MailRow | null): Promise<MailProvider> {
  if (!row) throw new MailError(404, 'not_found', 'No such message.');
  const prefix = row.account.split(':')[0];
  const p = mailProviders().find((x) => x.prefix === prefix);
  if (!p) throw new MailError(409, 'not_connected', 'That account is not connected any more.');
  const { key } = keys.has(p.prefix) ? { key: keys.get(p.prefix)! } : await accountOf(p);
  if (key !== row.account) throw new MailError(409, 'not_connected', 'That account is not connected any more.');
  return p;
}

const cleanAddrs = (list: Addr[]): Addr[] => list.slice(0, 50).map((a) => ({ name: cleanLine(a.name, 200) || null, addr: a.addr }));

export interface OpenedMail {
  row: MailRow; body: SafeSanitized; fetchedAt: number;
  /** the recipients line, cleaned ("(unreadable address)" for anything that is not a plain address) */
  to: string;
  /** where a reply goes (Reply-To, else From) and whether that is somewhere other than the sender */
  replyTo: Addr[]; replyGoesElsewhere: boolean;
}

/** Open a message: its body from the provider (or the cache), as sanitised plain text. */
export async function openMail(account: string, providerId: string, now = Date.now()): Promise<OpenedMail> {
  const row = getMail(account, providerId);
  const p = await locate(row);
  const key = `${account}\n${providerId}`;
  let hit = bodyCache.get(key, now);
  if (!hit) {
    let raw;
    try { raw = await p.fetchBody(providerId); } catch (e) { throw failure(p, account, e, 'open this message'); }
    const body = await sanitizeMailSafe({ html: raw.html, text: raw.text }, { label: p.label, inline: sanitizeInline });
    hit = { at: now, body, to: cleanAddrs(raw.to), from: cleanAddrs(raw.from), replyTo: cleanAddrs(raw.replyTo) };
    bodyCache.set(key, hit);
  }
  const replyTo = replyRecipients(hit.from, hit.replyTo);
  return { row: row!, body: hit.body, fetchedAt: hit.at, to: showAddresses(hit.to).slice(0, 2000), replyTo, replyGoesElsewhere: replyGoesElsewhere(hit.from, replyTo) };
}

export interface SavedDraft { account: string; label: string; draftId: string | null; to: Addr[]; replyGoesElsewhere: boolean; already: boolean }

/** Save `text` as a reply DRAFT in the message's own account (unless the draft `draftId` is already there). Never sends. */
export async function saveReplyDraft(account: string, providerId: string, text: string, draftId: string): Promise<SavedDraft> {
  const p = await locate(getMail(account, providerId));
  try {
    const r = await p.saveReplyDraft(providerId, { body: text, draftId });
    const to = cleanAddrs(r.to);
    const cached = bodyCache.get(`${account}\n${providerId}`);
    const from = cached?.from ?? [];
    const row = getMail(account, providerId);
    const senders = from.length ? from : row?.from_addr ? [{ name: row.from_name, addr: row.from_addr }] : [];
    return { account, label: p.label, draftId: r.draftId, to, replyGoesElsewhere: replyGoesElsewhere(senders, to), already: r.already };
  } catch (e) { throw failure(p, account, e, 'save the draft'); }
}
