/**
 * Google (Gmail + Calendar) connector — read + DRAFT, never send/commit.
 * Scopes: gmail.readonly (read), gmail.compose (create DRAFTS, cannot send),
 * calendar.events (create tentative/proposed events). Matches the agreed safety
 * model: MWA reads, triages, and drafts; the human reviews + sends in Gmail/Calendar.
 *
 * OAuth: reuse a Google OAuth client (GOOGLE_CLIENT_ID/SECRET, e.g. from the
 * newsletter app or a fresh Desktop-app client). `mwa connect gmail` runs a local
 * loopback consent flow and stores the token at data/google-token.json (local only).
 */
import { google } from 'googleapis';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createServer } from 'node:http';
import type { RegisteredTool } from '../tools/registry.js';

const TOKEN_PATH = process.env.MWA_GOOGLE_TOKEN ?? resolve('data/google-token.json');
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose', // create drafts, NOT send
  'https://www.googleapis.com/auth/calendar.events',
];
const REDIRECT_PORT = Number(process.env.MWA_GOOGLE_OAUTH_PORT ?? 7799);
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth`;

function oauthClient() {
  const id = process.env.GOOGLE_CLIENT_ID, secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!id || !secret) throw new Error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, then run `mwa connect gmail`.');
  return new google.auth.OAuth2(id, secret, REDIRECT_URI);
}

function loadToken(): Record<string, unknown> | null {
  if (!existsSync(TOKEN_PATH)) return null;
  try { return JSON.parse(readFileSync(TOKEN_PATH, 'utf8')); } catch { return null; }
}

export function googleConfigured(): boolean {
  return !!process.env.GOOGLE_CLIENT_ID && existsSync(TOKEN_PATH);
}

async function authedClient() {
  const o = oauthClient();
  const t = loadToken();
  if (!t) throw new Error('Gmail not connected — run `mwa connect gmail`.');
  o.setCredentials(t);
  o.on('tokens', (nt) => { try { writeFileSync(TOKEN_PATH, JSON.stringify({ ...t, ...nt }, null, 2), { mode: 0o600 }); } catch { /* */ } });
  return o;
}

/** One-time OAuth consent (loopback). Prints the URL; catches the callback locally. */
export async function connectGmail(onLog: (m: string) => void = (m) => console.log(m)): Promise<void> {
  const o = oauthClient();
  const url = o.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' });
  const code: string = await new Promise((res, rej) => {
    const srv = createServer((req, rq) => {
      try {
        const u = new URL(req.url ?? '', REDIRECT_URI);
        if (u.pathname !== '/oauth') { rq.statusCode = 404; rq.end(); return; }
        const c = u.searchParams.get('code');
        rq.end('MWA: Gmail connected. You can close this tab and return to the terminal.');
        srv.close();
        if (c) res(c); else rej(new Error(u.searchParams.get('error') ?? 'no code'));
      } catch (e) { rej(e as Error); }
    });
    srv.listen(REDIRECT_PORT, '127.0.0.1', () => {
      onLog(`\nAuthorize MWA — open this URL in your browser (sign in as the account you want it to manage):\n\n${url}\n`);
    });
  });
  const { tokens } = await o.getToken(code);
  mkdirSync(dirname(TOKEN_PATH), { recursive: true });
  writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  o.setCredentials(tokens);
  const prof = await google.gmail({ version: 'v1', auth: o }).users.getProfile({ userId: 'me' });
  onLog(`✅ Connected as ${prof.data.emailAddress} — token saved locally (${TOKEN_PATH}). Read + draft only; never sends.`);
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

export function googleTools(): RegisteredTool[] {
  const header = (g: any, n: string) => (g.data.payload?.headers ?? []).find((h: any) => h.name === n)?.value ?? '';
  return [
    {
      def: { name: 'search_email', description: 'Search the connected Gmail inbox (READ-ONLY). Gmail query syntax (e.g. "is:unread", "from:scouts", "newer_than:7d"). Returns id | date | from | subject | snippet.', parameters: { type: 'object', properties: { query: { type: 'string' }, max: { type: 'number', description: 'max results, default 10' } }, required: ['query'] } },
      handler: async (args) => {
        const gmail = google.gmail({ version: 'v1', auth: await authedClient() });
        const list = await gmail.users.messages.list({ userId: 'me', q: String(args.query ?? ''), maxResults: Math.min(Number(args.max ?? 10), 25) });
        const out: string[] = [];
        for (const m of list.data.messages ?? []) {
          const g = await gmail.users.messages.get({ userId: 'me', id: m.id!, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] });
          out.push(`[${m.id}] ${header(g, 'Date')} | ${header(g, 'From')} | ${header(g, 'Subject')} | ${(g.data.snippet ?? '').slice(0, 80)}`);
        }
        return out.join('\n') || '(no matches)';
      },
    },
    {
      def: { name: 'read_email', description: 'Read a Gmail message by id (READ-ONLY): from/subject/date + body text.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
      handler: async (args) => {
        const gmail = google.gmail({ version: 'v1', auth: await authedClient() });
        const g = await gmail.users.messages.get({ userId: 'me', id: String(args.id), format: 'full' });
        return `From: ${header(g, 'From')}\nSubject: ${header(g, 'Subject')}\nDate: ${header(g, 'Date')}\n\n${decodeBody(g.data.payload).slice(0, 6000)}`;
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
      def: { name: 'propose_event', description: 'Create a DRAFT/proposed calendar event (title prefixed [Proposed], no invites sent — the human reviews/confirms). Times in ISO 8601.', parameters: { type: 'object', properties: { summary: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, description: { type: 'string' } }, required: ['summary', 'start', 'end'] } },
      handler: async (args) => {
        const cal = google.calendar({ version: 'v3', auth: await authedClient() });
        const e = await cal.events.insert({ calendarId: 'primary', sendUpdates: 'none', requestBody: { summary: `[Proposed] ${args.summary}`, description: String(args.description ?? ''), start: { dateTime: String(args.start) }, end: { dateTime: String(args.end) } } });
        return `📅 proposed event created (id ${e.data.id}) — review/confirm in Calendar.`;
      },
    },
  ];
}
