/**
 * Microsoft (Outlook.com / Microsoft 365) connector — read + DRAFT, never send.
 * Mirrors the Gmail connector but over Microsoft Graph. Works for PERSONAL Outlook.com
 * accounts AND work/school 365 via the /common endpoint (one app registration covers both).
 *
 * Auth: a PUBLIC client (Authorization Code + PKCE, NO client secret to manage — the user
 * registers a "Mobile & desktop" app and pastes only the Application (client) ID). Tokens
 * are stored locally at data/microsoft-token.json and never leave the machine. Scopes:
 * Mail.ReadWrite (read + create drafts, cannot send) or Mail.Read (read-only), plus
 * Calendars.ReadWrite for proposing events and offline_access for refresh.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import type { RegisteredTool } from '../tools/registry.js';

const TOKEN_PATH = process.env.MWA_MS_TOKEN ?? resolve('data/microsoft-token.json');
const TENANT = process.env.MICROSOFT_TENANT ?? 'common'; // common = personal + work/school
const REDIRECT_PORT = Number(process.env.MWA_MS_OAUTH_PORT ?? 7798);
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth`;
const AUTH_BASE = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0`;
const GRAPH = 'https://graph.microsoft.com/v1.0';

const SCOPES_RW = ['offline_access', 'User.Read', 'Mail.ReadWrite', 'Calendars.ReadWrite'];
const SCOPES_RO = ['offline_access', 'User.Read', 'Mail.Read'];

interface StoredToken { access_token: string; refresh_token?: string; expires_at: number; scope: string }

function clientId(): string {
  const id = process.env.MICROSOFT_CLIENT_ID;
  if (!id) throw new Error('Set MICROSOFT_CLIENT_ID, then connect your Outlook account.');
  return id;
}
function loadToken(): StoredToken | null {
  if (!existsSync(TOKEN_PATH)) return null;
  try { return JSON.parse(readFileSync(TOKEN_PATH, 'utf8')); } catch { return null; }
}
function saveToken(t: StoredToken): void {
  mkdirSync(dirname(TOKEN_PATH), { recursive: true });
  writeFileSync(TOKEN_PATH, JSON.stringify(t, null, 2), { mode: 0o600 });
}

export function microsoftConfigured(): boolean {
  return !!process.env.MICROSOFT_CLIENT_ID && existsSync(TOKEN_PATH);
}

/** Valid access token, refreshing with the stored refresh_token when near expiry. */
async function accessToken(): Promise<string> {
  const t = loadToken();
  if (!t) throw new Error('Outlook not connected — connect your account first.');
  if (t.expires_at > Date.now() + 60_000) return t.access_token;
  if (!t.refresh_token) return t.access_token; // best effort; will 401 → user reconnects
  const body = new URLSearchParams({ client_id: clientId(), grant_type: 'refresh_token', refresh_token: t.refresh_token, redirect_uri: REDIRECT_URI, scope: t.scope });
  const res = await fetch(`${AUTH_BASE}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  if (!res.ok) throw new Error(`token refresh failed: ${res.status}`);
  const j: any = await res.json();
  const next: StoredToken = { access_token: j.access_token, refresh_token: j.refresh_token ?? t.refresh_token, expires_at: Date.now() + (Number(j.expires_in ?? 3600) * 1000), scope: t.scope };
  saveToken(next);
  return next.access_token;
}

async function graph(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${GRAPH}${path}`, { ...init, headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  if (!res.ok) throw new Error(`Graph ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return res.status === 204 ? {} : res.json();
}

/** Build the consent URL (PKCE) + start the loopback catcher. Returns the URL now and a
 *  promise resolving with the connected email once approved. */
function beginConsent(readOnly = false): { url: string; done: Promise<string> } {
  const id = clientId();
  const scope = (readOnly ? SCOPES_RO : SCOPES_RW).join(' ');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const url = `${AUTH_BASE}/authorize?` + new URLSearchParams({
    client_id: id, response_type: 'code', redirect_uri: REDIRECT_URI, response_mode: 'query',
    scope, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'consent',
  }).toString();
  const done = (async () => {
    const code: string = await new Promise((res, rej) => {
      const srv = createServer((req, rq) => {
        try {
          const u = new URL(req.url ?? '', REDIRECT_URI);
          if (u.pathname !== '/oauth') { rq.statusCode = 404; rq.end(); return; }
          const c = u.searchParams.get('code');
          rq.end('MWA: Outlook connected. You can close this tab and return to MWA.');
          srv.close();
          if (c) res(c); else rej(new Error(u.searchParams.get('error_description') ?? u.searchParams.get('error') ?? 'no code'));
        } catch (e) { rej(e as Error); }
      });
      srv.on('error', rej);
      srv.listen(REDIRECT_PORT, '127.0.0.1');
    });
    const body = new URLSearchParams({ client_id: id, grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: verifier, scope });
    const res = await fetch(`${AUTH_BASE}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${(await res.text()).slice(0, 160)}`);
    const j: any = await res.json();
    saveToken({ access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (Number(j.expires_in ?? 3600) * 1000), scope });
    const me = await graph('/me');
    return me.userPrincipalName || me.mail || 'your account';
  })();
  return { url, done };
}

/** CLI: print the URL, wait for approval. */
export async function connectMicrosoft(onLog: (m: string) => void = (m) => console.log(m), readOnly = false): Promise<void> {
  const { url, done } = beginConsent(readOnly);
  onLog(`\nAuthorize MWA — open this URL and sign in to the Outlook/Microsoft account you want it to manage:\n\n${url}\n`);
  const email = await done;
  onLog(`✅ Connected as ${email} — token saved locally (${TOKEN_PATH}). ${readOnly ? 'Read only.' : 'Read + draft only; never sends.'}`);
}

/** Web: return the consent URL for the browser; finishes in the background (UI polls status). */
export function startMicrosoftConnect(readOnly = false): string {
  const { url, done } = beginConsent(readOnly);
  done.then((email) => console.log(`  ✅ Outlook connected as ${email}`)).catch((e) => console.error('  Outlook connect failed:', (e as Error).message.slice(0, 140)));
  return url;
}

// --- shared text helpers (mirrors the Gmail connector; kept local to avoid churn there) ---
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
function htmlToText(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/(p|div|br|tr|li|h[1-6])>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
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

export function microsoftTools(): RegisteredTool[] {
  return [
    {
      def: { name: 'search_outlook', description: 'Search the connected Outlook/Microsoft inbox (READ-ONLY). Free-text keywords (sender, subject, words in the body). Returns id | date | from | subject | preview.', parameters: { type: 'object', properties: { query: { type: 'string' }, max: { type: 'number', description: 'max results, default 20' } }, required: ['query'] } },
      handler: async (args) => {
        const q = String(args.query ?? '').trim();
        const top = Math.min(Number(args.max ?? 20), 50);
        const select = '$select=id,subject,from,receivedDateTime,bodyPreview,internetMessageId';
        // $search and $orderby can't be combined on Graph: search when there's a query, else recent.
        const path = q ? `/me/messages?$search="${encodeURIComponent(q)}"&${select}&$top=${top}` : `/me/messages?$orderby=receivedDateTime desc&${select}&$top=${top}`;
        const r = await graph(path);
        const seen = new Set<string>(); const out: string[] = []; let dupes = 0;
        for (const m of r.value ?? []) {
          const from = m.from?.emailAddress?.address ?? '(unknown)';
          const key = (m.internetMessageId || `${from}|${m.subject}|${m.receivedDateTime}`).toLowerCase();
          if (seen.has(key)) { dupes++; continue; }
          seen.add(key);
          out.push(`[${m.id}] ${m.receivedDateTime} | ${from} | ${m.subject ?? '(no subject)'} | ${(m.bodyPreview ?? '').slice(0, 80)}`);
        }
        return (out.join('\n') || '(no matches)') + (dupes ? `\n(${dupes} duplicate copy/copies hidden)` : '');
      },
    },
    {
      def: { name: 'read_outlook', description: 'Read an Outlook message AND its whole conversation (original + every reply) by id. Quoted history is stripped, duplicates collapsed, and text is extracted from PDF/Word attachments. Use this to find details — times, dates, logistics — usually in the ORIGINAL message or an attached file.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
      handler: async (args) => {
        let head: any;
        try { head = await graph(`/me/messages/${args.id}?$select=conversationId,subject`); }
        catch (e) { return `(could not read email: ${(e as Error).message.slice(0, 80)})`; }
        const sel = '$select=id,from,receivedDateTime,subject,body,hasAttachments';
        let msgs: any[];
        if (head.conversationId) {
          const r = await graph(`/me/messages?$filter=conversationId eq '${head.conversationId}'&${sel}&$top=25`);
          msgs = (r.value ?? []).sort((a: any, b: any) => String(a.receivedDateTime).localeCompare(String(b.receivedDateTime)));
        } else {
          msgs = [await graph(`/me/messages/${args.id}?${sel}`)];
        }
        const seen = new Set<string>(); const out: string[] = [];
        const subject = msgs.length ? (msgs[0].subject ?? '') : '';
        for (const m of msgs) {
          const rawBody = m.body?.contentType === 'html' ? htmlToText(m.body?.content ?? '') : (m.body?.content ?? '');
          const clean = stripQuoted(rawBody);
          const sig = clean.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120);
          if (sig && seen.has(sig)) continue;
          if (sig) seen.add(sig);
          let block = `From: ${m.from?.emailAddress?.address ?? '(unknown)'} | Date: ${m.receivedDateTime}\n${clean.slice(0, 6000)}`;
          if (m.hasAttachments) {
            try {
              const at = await graph(`/me/messages/${m.id}/attachments`);
              for (const a of (at.value ?? []).slice(0, 3)) {
                if (a['@odata.type']?.includes('fileAttachment') && /\.(pdf|docx|txt|csv|md)$/i.test(a.name ?? '') && a.contentBytes) {
                  const text = await extractDoc(a.name, Buffer.from(a.contentBytes, 'base64'));
                  block += text ? `\n[attachment ${a.name}]\n${text.slice(0, 6000)}` : `\n[attachment ${a.name} — not text-extractable]`;
                }
              }
            } catch { /* skip attachments */ }
          }
          out.push(block);
        }
        return `Subject: ${subject} (${msgs.length} message(s) in thread)\n\n` + (out.join('\n\n— — —\n\n').slice(0, 24000) || '(empty)');
      },
    },
    {
      def: { name: 'draft_outlook', description: 'Create a DRAFT email in Outlook (does NOT send — the human reviews + sends). Use for replies/messages.', parameters: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'subject', 'body'] } },
      handler: async (args) => {
        const d = await graph('/me/messages', { method: 'POST', body: JSON.stringify({
          subject: String(args.subject ?? ''),
          body: { contentType: 'Text', content: String(args.body ?? '') },
          toRecipients: String(args.to ?? '').split(/[,;]\s*/).filter(Boolean).map((address) => ({ emailAddress: { address } })),
        }) });
        return `✏️ draft created (id ${d.id}) — review and send it in Outlook.`;
      },
    },
    {
      def: { name: 'propose_outlook_event', description: 'Create a DRAFT/proposed Outlook calendar event (subject prefixed [Proposed], no invites sent — the human reviews/confirms). Times in ISO 8601 (UTC).', parameters: { type: 'object', properties: { summary: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, description: { type: 'string' } }, required: ['summary', 'start', 'end'] } },
      handler: async (args) => {
        const e = await graph('/me/events', { method: 'POST', body: JSON.stringify({
          subject: `[Proposed] ${args.summary}`,
          body: { contentType: 'Text', content: String(args.description ?? '') },
          start: { dateTime: String(args.start), timeZone: 'UTC' },
          end: { dateTime: String(args.end), timeZone: 'UTC' },
        }) });
        return `📅 proposed event created (id ${e.id}) — review/confirm in Outlook Calendar.`;
      },
    },
  ];
}
