/**
 * Google (Gmail + Calendar) connector — read + DRAFT, never send/commit.
 * Scopes: gmail.readonly (read), gmail.compose (drafts; the scope itself COULD send — MWA never calls send),
 * calendar.events (create tentative/proposed events). Matches the agreed safety
 * model: MWA reads, triages, and drafts; the human reviews + sends in Gmail/Calendar.
 *
 * OAuth: reuse a Google OAuth client (GOOGLE_CLIENT_ID/SECRET, e.g. from the
 * newsletter app or a fresh Desktop-app client). `mwa connect gmail` runs a local
 * loopback consent flow and stores the token at data/google-token.json (local only).
 */
import { google } from 'googleapis';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { catchOAuthCode, newPkce } from '../connect/oauth-catcher.js';
import type { RegisteredTool } from '../tools/registry.js';
import { connectorTokenPath } from '../paths.js';
import { proposeDraft } from '../sync/drafts.js';
import { v2DraftsOn } from '../sync/flags.js';
import { resetCalendarProvider } from '../v2/calendar.js';

const tokenPath = (): string => connectorTokenPath('google-token.json', 'MWA_GOOGLE_TOKEN');
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose', // drafts. The scope allows sending too; MWA never calls send.
  'https://www.googleapis.com/auth/calendar.events',
];
const REDIRECT_PORT = Number(process.env.MWA_GOOGLE_OAUTH_PORT ?? 7799);
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth`;

function oauthClient() {
  const id = process.env.GOOGLE_CLIENT_ID, secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!id || !secret) throw new Error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, then run `mwa connect gmail`.');
  // MWA_GOOGLE_TOKEN_URL: a fake token endpoint (tests only — the v2 A7 reconnect test refreshes against it)
  const tokenUrl = process.env.MWA_GOOGLE_TOKEN_URL;
  // gaxios's own transport, not Node's fetch: it honours HTTPS_PROXY and mTLS agents and keeps the error shapes the
  // Gmail tools expect (the review of A7 reverted a switch to Node's fetch; tests/calendar-review.test.ts checks it).
  return new google.auth.OAuth2({
    clientId: id, clientSecret: secret, redirectUri: REDIRECT_URI,
    ...(tokenUrl ? { endpoints: { oauth2TokenUrl: tokenUrl } } : {}),
  });
}

/** The OAuth client MWA signs Google calls with (exported for the transport test). */
export const googleOAuthClient = oauthClient;

function loadToken(): Record<string, unknown> | null {
  if (!existsSync(tokenPath())) return null;
  try { return JSON.parse(readFileSync(tokenPath(), 'utf8')); } catch { return null; }
}

export function googleConfigured(): boolean {
  return !!process.env.GOOGLE_CLIENT_ID && existsSync(tokenPath());
}

/** Forget the stored Gmail OAuth token (the local sign-in). Env keys are cleared separately. */
export function disconnectGoogle(): void {
  try { rmSync(tokenPath(), { force: true }); } catch { /* */ }
  forgetCalendar();
}

/** v2 (A7): what MWA cached from Google Calendar belongs to a sign-in that is gone or replaced. */
function forgetCalendar(): void {
  try { resetCalendarProvider('google'); } catch { /* app.db unavailable: the next refresh clears a foreign account */ }
}

/** The calendar cache's account key: 'google:<address>' once the signed-in address is known, else 'google'. */
export function googleAccountKey(): string {
  const a = loadToken()?.mwa_account;
  return typeof a === 'string' && a.includes('@') ? `google:${a.toLowerCase()}` : 'google';
}

/** The signed-in Google client (v2: the calendar and mail sync use it). */
export async function authedClient() {
  const o = oauthClient();
  const t = loadToken();
  if (!t) throw new Error('Gmail not connected — run `mwa connect gmail`.');
  o.setCredentials(t);
  o.on('tokens', (nt) => { try { writeFileSync(tokenPath(), JSON.stringify({ ...t, ...nt }, null, 2), { mode: 0o600 }); } catch { /* */ } });
  return o;
}

/** Calendar calls give up after a minute (a confirm holds its draft while it waits; see CONFIRM_LEASE_MS). */
export const GOOGLE_CALENDAR_TIMEOUT_MS = 60_000;

/** The Calendar API (v3) signed in as the person. MWA_GOOGLE_API_ROOT points it at a fake server (tests only). */
export async function calendarClient(auth?: Awaited<ReturnType<typeof authedClient>>) {
  const rootUrl = process.env.MWA_GOOGLE_API_ROOT ? process.env.MWA_GOOGLE_API_ROOT.replace(/\/?$/, '/') : undefined;
  return google.calendar({ version: 'v3', auth: auth ?? await authedClient(), timeout: GOOGLE_CALENDAR_TIMEOUT_MS, ...(rootUrl ? { rootUrl } : {}) });
}

/** Read-only scope set (no gmail.compose): the privacy-max option. */
const SCOPES_READONLY = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.events',
];

/** Build the consent URL + start the loopback catcher. Returns the URL immediately and a
 *  promise that resolves with the connected email once the user approves. Used by both the
 *  CLI (awaits) and the web UI (surfaces the URL to the browser, resolves in background). */
function beginConsent(readOnly = false): { url: string; done: Promise<string> } {
  const o = oauthClient();
  // W5 security review (7): a random state the loopback listener must see back, and PKCE binding the code to this
  // attempt — a stray or forged request to localhost:7799 can neither end the sign-in nor swap in another account
  const { verifier, challenge, state } = newPkce();
  const url = o.generateAuthUrl({
    access_type: 'offline', scope: readOnly ? SCOPES_READONLY : SCOPES, prompt: 'consent', state,
    code_challenge: challenge, code_challenge_method: 'S256' as never,
  });
  const caught = catchOAuthCode({ port: REDIRECT_PORT, state, label: 'Google' });
  const done = (async () => {
    const code = await caught.code;
    const { tokens } = await o.getToken({ code, codeVerifier: verifier });
    mkdirSync(dirname(tokenPath()), { recursive: true });
    writeFileSync(tokenPath(), JSON.stringify(tokens, null, 2), { mode: 0o600 });
    o.setCredentials(tokens);
    const rootUrl = process.env.MWA_GOOGLE_API_ROOT ? process.env.MWA_GOOGLE_API_ROOT.replace(/\/?$/, '/') : undefined;
    const prof = await google.gmail({ version: 'v1', auth: o, ...(rootUrl ? { rootUrl } : {}) }).users.getProfile({ userId: 'me' });
    recordGoogleSignIn(tokens as Record<string, unknown>, prof.data.emailAddress ?? null);
    return prof.data.emailAddress ?? 'your account';
  })();
  return { url, done };
}

/** Tests (W5): start a consent and hand back its URL and completion, without the console logging of startGmailConnect. */
export const beginGoogleConsentForTests = beginConsent;

/**
 * v2 (A7): a sign-in finished. Keep the address beside the token (the calendar cache is keyed by it) and start the
 * calendar afresh — the cached events and sync cursor belonged to whoever was signed in before.
 */
export function recordGoogleSignIn(tokens: Record<string, unknown>, address: string | null): void {
  mkdirSync(dirname(tokenPath()), { recursive: true });
  writeFileSync(tokenPath(), JSON.stringify({ ...tokens, ...(address ? { mwa_account: address } : {}) }, null, 2), { mode: 0o600 });
  forgetCalendar();
}

/** One-time OAuth consent (loopback) for the CLI: prints the URL, waits for approval. */
export async function connectGmail(onLog: (m: string) => void = (m) => console.log(m), readOnly = false): Promise<void> {
  const { url, done } = beginConsent(readOnly);
  onLog(`\nAuthorize MWA — open this URL in your browser (sign in as the account you want it to manage):\n\n${url}\n`);
  const email = await done;
  onLog(`✅ Connected as ${email} — token saved locally (${tokenPath()}). ${readOnly ? 'Read only.' : 'Read + draft only; never sends.'}`);
}

/** Web flow: returns the consent URL for the browser to open; finishes in the background
 *  (the UI polls /api/status to see Gmail flip to connected). */
export function startGmailConnect(readOnly = false): string {
  const { url, done } = beginConsent(readOnly);
  done.then((email) => console.log(`  ✅ Gmail connected as ${email}`)).catch((e) => console.error('  Gmail connect failed:', (e as Error).message.slice(0, 120)));
  return url;
}

function decodeBody(payload: any): string {
  if (!payload) return '';
  const fromData = (d?: string) => (d ? Buffer.from(d, 'base64url').toString('utf8') : '');
  if (payload.mimeType === 'text/plain' && payload.body?.data) return fromData(payload.body.data);
  for (const part of payload.parts ?? []) {
    if (part.mimeType === 'text/plain' && part.body?.data) return fromData(part.body.data);
  }
  // fallback: first part with data, or html stripped
  for (const part of payload.parts ?? []) {
    const sub = decodeBody(part); if (sub) return sub;
  }
  return fromData(payload.body?.data).replace(/<[^>]+>/g, ' ');
}

export interface UniqueMessage { id: string; from: string; subject: string; date: string; snippet: string; }

/**
 * Page the inbox for a query and return UNIQUE messages — duplicate copies (the same
 * email imported across accounts) are collapsed by RFC-822 Message-ID, with a
 * sender+subject+date fallback. Used by the ingestion routine for thorough, dedup'd
 * coverage instead of the agent's ad-hoc search loop.
 */
export async function listUniqueMessages(opts: { query?: string; max?: number; onProgress?: (scanned: number, unique: number) => void }): Promise<UniqueMessage[]> {
  const gmail = google.gmail({ version: 'v1', auth: await authedClient() });
  const hdr = (g: any, n: string) => (g.data.payload?.headers ?? []).find((h: any) => h.name === n)?.value ?? '';
  const seen = new Set<string>();
  const out: UniqueMessage[] = [];
  const max = opts.max ?? 400;
  let pageToken: string | undefined;
  let scanned = 0;
  do {
    const list = await gmail.users.messages.list({ userId: 'me', q: opts.query ?? '', maxResults: 100, pageToken: pageToken });
    for (const m of list.data.messages ?? []) {
      scanned++;
      const g = await gmail.users.messages.get({ userId: 'me', id: m.id!, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date', 'Message-ID'] });
      const from = hdr(g, 'From'), subject = hdr(g, 'Subject'), date = hdr(g, 'Date');
      const key = (hdr(g, 'Message-ID') || `${from}|${subject}|${date}`).trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: m.id!, from, subject, date, snippet: (g.data.snippet ?? '').slice(0, 200) });
      opts.onProgress?.(scanned, out.length);
      if (out.length >= max) return out;
    }
    pageToken = list.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

/** Drop quoted reply history so the model sees only each message's NEW text (threads
 *  otherwise repeat the same content in every "Re:", which confuses parsing). */
function stripQuoted(body: string): string {
  const out: string[] = [];
  for (const line of body.split('\n')) {
    if (/^\s*On .+ wrote:\s*$/.test(line)) break;
    if (/^\s*-----\s*Original Message\s*-----/i.test(line)) break;
    if (/^\s*From:\s.+\bSent:\s/i.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Find PDF/Word/text attachments anywhere in a message payload. */
function collectAttachments(payload: any): { filename: string; attachmentId: string }[] {
  const out: { filename: string; attachmentId: string }[] = [];
  const walk = (p: any) => {
    if (!p) return;
    if (p.filename && p.body?.attachmentId && /\.(pdf|docx|txt|csv|md)$/i.test(p.filename)) out.push({ filename: p.filename, attachmentId: p.body.attachmentId });
    for (const part of p.parts ?? []) walk(part);
  };
  walk(payload);
  return out;
}

/** Extract text from an attachment buffer (PDF via unpdf, .docx via mammoth, else utf8). */
async function extractDoc(filename: string, buf: Buffer): Promise<string> {
  const lower = filename.toLowerCase();
  try {
    if (lower.endsWith('.pdf') || buf.subarray(0, 5).toString('latin1') === '%PDF-') {
      const { getDocumentProxy, extractText } = await import('unpdf');
      const pdf = await getDocumentProxy(new Uint8Array(buf));
      const { text } = await extractText(pdf, { mergePages: true });
      return Array.isArray(text) ? text.join('\n') : String(text ?? '');
    }
    if (lower.endsWith('.docx')) {
      const m: any = await import('mammoth');
      const fn = m.extractRawText ?? m.default?.extractRawText;
      const { value } = await fn({ buffer: buf });
      return String(value ?? '');
    }
    return buf.toString('utf8');
  } catch { return ''; }
}

export function googleTools(): RegisteredTool[] {
  const header = (g: any, n: string) => (g.data.payload?.headers ?? []).find((h: any) => h.name === n)?.value ?? '';
  return [
    {
      def: { name: 'search_email', description: 'Search the connected Gmail inbox (READ-ONLY). Gmail query syntax (e.g. "is:unread", "from:scouts", "newer_than:7d"). Duplicate copies of the same email (imported across accounts) are collapsed automatically. Returns id | date | from | subject | snippet.', parameters: { type: 'object', properties: { query: { type: 'string' }, max: { type: 'number', description: 'max results, default 20' } }, required: ['query'] } },
      handler: async (args) => {
        const gmail = google.gmail({ version: 'v1', auth: await authedClient() });
        const list = await gmail.users.messages.list({ userId: 'me', q: String(args.query ?? ''), maxResults: Math.min(Number(args.max ?? 20), 50) });
        const seen = new Set<string>();
        const out: string[] = [];
        let dupes = 0;
        for (const m of list.data.messages ?? []) {
          const g = await gmail.users.messages.get({ userId: 'me', id: m.id!, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date', 'Message-ID'] });
          const from = header(g, 'From'), subj = header(g, 'Subject'), date = header(g, 'Date');
          // Collapse duplicate copies: same email imported across accounts usually keeps
          // its Message-ID; fall back to sender+subject+date when it doesn't.
          const key = (header(g, 'Message-ID') || `${from}|${subj}|${date}`).trim().toLowerCase();
          if (seen.has(key)) { dupes++; continue; }
          seen.add(key);
          out.push(`[${m.id}] ${date} | ${from} | ${subj} | ${(g.data.snippet ?? '').slice(0, 80)}`);
        }
        return (out.join('\n') || '(no matches)') + (dupes ? `\n(${dupes} duplicate copy/copies hidden)` : '');
      },
    },
    {
      def: { name: 'read_email', description: 'Read a Gmail message AND its WHOLE thread (the original message + every reply) by message id. Quoted reply history is stripped, duplicate copies collapsed, and text is extracted from PDF/Word attachments (e.g. an attached schedule). Use this to find details — times, dates, logistics — that are usually in the ORIGINAL message or an attached file, not the latest reply.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
      handler: async (args) => {
        const gmail = google.gmail({ version: 'v1', auth: await authedClient() });
        const hx = (m: any, n: string) => (m.payload?.headers ?? []).find((h: any) => h.name === n)?.value ?? '';
        let msgs: any[];
        try {
          const meta = await gmail.users.messages.get({ userId: 'me', id: String(args.id), format: 'minimal' });
          msgs = meta.data.threadId
            ? ((await gmail.users.threads.get({ userId: 'me', id: meta.data.threadId, format: 'full' })).data.messages ?? [])
            : [(await gmail.users.messages.get({ userId: 'me', id: String(args.id), format: 'full' })).data];
        } catch (e) { return `(could not read email: ${(e as Error).message.slice(0, 80)})`; }
        const seen = new Set<string>();
        const out: string[] = [];
        const subject = msgs.length ? hx(msgs[0], 'Subject') : '';
        for (const m of msgs) {
          const clean = stripQuoted(decodeBody(m.payload));
          const sig = clean.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120);
          if (sig && seen.has(sig)) continue; // collapse duplicate copies across accounts
          if (sig) seen.add(sig);
          let block = `From: ${hx(m, 'From')} | Date: ${hx(m, 'Date')}\n${clean.slice(0, 6000)}`;
          for (const a of collectAttachments(m.payload).slice(0, 3)) {
            try {
              const data = await gmail.users.messages.attachments.get({ userId: 'me', messageId: String(m.id), id: a.attachmentId });
              const text = await extractDoc(a.filename, Buffer.from(String(data.data.data ?? ''), 'base64url'));
              block += text ? `\n[attachment ${a.filename}]\n${text.slice(0, 6000)}` : `\n[attachment ${a.filename} — not text-extractable]`;
            } catch { /* skip attachment */ }
          }
          out.push(block);
        }
        return `Subject: ${subject} (${msgs.length} message(s) in thread)\n\n` + (out.join('\n\n— — —\n\n').slice(0, 24000) || '(empty)');
      },
    },
    {
      def: { name: 'draft_email', description: 'Create a DRAFT email in Gmail (does NOT send — the human reviews + sends). Use for replies/messages.', parameters: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'subject', 'body'] } },
      handler: async (args) => {
        const gmail = google.gmail({ version: 'v1', auth: await authedClient() });
        const raw = Buffer.from(`To: ${args.to}\r\nSubject: ${args.subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${args.body}`).toString('base64url');
        const d = await gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw } } });
        return `✏️ draft created (id ${d.data.id}) — review and send it in Gmail.`;
      },
    },
    {
      def: { name: 'propose_event', description: 'Propose a calendar event. It is held in MWA as a DRAFT the person confirms (nothing is added to Google Calendar and no invites are sent until they do). Times in ISO 8601; a time with no offset is the person’s local time; a bare date (YYYY-MM-DD) makes an all-day event.', parameters: { type: 'object', properties: { summary: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, location: { type: 'string' }, description: { type: 'string' } }, required: ['summary', 'start', 'end'] } },
      handler: async (args, ctx) => {
        // v2 (A7): an MWA-held draft. MWA_V2_DRAFTS=0 restores the old behaviour (a real "[Proposed]" event).
        if (v2DraftsOn()) return proposeDraft('google', args, ctx);
        const cal = await calendarClient();
        const e = await cal.events.insert({ calendarId: 'primary', sendUpdates: 'none', requestBody: { summary: `[Proposed] ${args.summary}`, description: String(args.description ?? ''), start: { dateTime: String(args.start) }, end: { dateTime: String(args.end) } } });
        return `📅 proposed event created (id ${e.data.id}) — review/confirm in Calendar.`;
      },
    },
  ];
}
