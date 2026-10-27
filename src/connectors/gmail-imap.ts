/**
 * Gmail via App Password (IMAP) — the EASY connect path (no Google Cloud Console).
 *
 * The user turns on 2-Step Verification, creates a 16-char App Password at
 * myaccount.google.com/apppasswords, and pastes their address + that password. MWA
 * reads over IMAP and saves replies as DRAFTS (IMAP APPEND to the Drafts folder) — it
 * never sends. Credentials live locally in MWA_GMAIL_USER / MWA_GMAIL_APP_PASSWORD
 * (written to the local .env, mode 600) and never leave the machine.
 *
 * These tools register under the SAME names as the OAuth connector (search_email /
 * read_email / draft_email) so the agent uses them identically — only one Gmail path is
 * ever active at a time (see buildRegistry). Calendar is NOT covered here (it needs OAuth);
 * that's the tradeoff for skipping the Cloud Console setup.
 */
import { ImapFlow } from 'imapflow';
import { docxText } from '../tools/safe-zip.js';
import { simpleParser } from 'mailparser';
import type { RegisteredTool } from '../tools/registry.js';

const HOST = process.env.MWA_GMAIL_IMAP_HOST ?? 'imap.gmail.com';
const PORT = Number(process.env.MWA_GMAIL_IMAP_PORT ?? 993);

export function gmailImapConfigured(): boolean {
  return !!process.env.MWA_GMAIL_USER && !!process.env.MWA_GMAIL_APP_PASSWORD;
}

/** A connected IMAP client. Caller MUST `logout()` when done. (v2: the mail sync uses it.) */
export async function imapClient(user?: string, pass?: string): Promise<ImapFlow> {
  const u = user ?? process.env.MWA_GMAIL_USER;
  const p = pass ?? process.env.MWA_GMAIL_APP_PASSWORD;
  if (!u || !p) throw new Error('Gmail not connected — add your address + app password first.');
  const client = new ImapFlow({ host: HOST, port: PORT, secure: true, auth: { user: u, pass: p }, logger: false });
  await client.connect();
  return client;
}

/** Validate an address + app password by opening a real IMAP session. Used by the connect UI. */
export async function verifyGmailImap(user: string, pass: string): Promise<{ ok: boolean; message: string }> {
  const u = (user ?? '').trim();
  const p = (pass ?? '').replace(/\s+/g, ''); // Google shows the app password in 4-char groups
  if (!u || !/@/.test(u)) return { ok: false, message: "That doesn't look like an email address." };
  if (p.length < 16) return { ok: false, message: 'The app password is 16 letters (Google may show it as 4 groups of 4).' };
  let client: ImapFlow | null = null;
  try {
    client = await imapClient(u, p);
    await client.logout();
    return { ok: true, message: `Connected ${u} — read + draft only, never sends.` };
  } catch (e) {
    const msg = (e as Error).message || '';
    // imapflow reports a refused login as "Command failed", with the reason on the error (2026-10-23 settings test).
    const why = `${msg} ${(e as { responseText?: string }).responseText ?? ''} ${(e as { authenticationFailed?: boolean }).authenticationFailed ? 'AUTHENTICATIONFAILED' : ''}`;
    if (/AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed|Application-specific password required/i.test(why))
      return { ok: false, message: 'Sign-in failed — check the address and app password (and that 2-Step Verification is on).' };
    return { ok: false, message: `Couldn't reach Gmail: ${msg.slice(0, 120)}` };
  } finally {
    try { client?.close(); } catch { /* */ }
  }
}

export interface ScannedMessage { id: string; from: string; subject: string; date: string; snippet: string; }

/**
 * Page the INBOX over the last `days` and return UNIQUE messages (duplicates collapsed by
 * Message-ID), newest first — the IMAP equivalent of google.ts listUniqueMessages, used by
 * the "learn about me from my email" scan. Envelope-only (no body fetch) so it stays fast
 * over hundreds of messages; from+subject+date carry the durable facts (people, topics, dates).
 */
export async function listUniqueMessagesImap(opts: { days?: number; max?: number; onProgress?: (scanned: number, unique: number) => void } = {}): Promise<ScannedMessage[]> {
  const days = opts.days ?? 30;
  const max = opts.max ?? 400;
  const since = new Date(Date.now() - days * 86_400_000);
  const client = await imapClient();
  const seen = new Set<string>();
  const out: ScannedMessage[] = [];
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      let uids: number[] = [];
      try { uids = (await client.search({ since }, { uid: true })) || []; }
      catch { uids = (await client.search({ all: true }, { uid: true })) || []; }
      const pick = uids.slice(-Math.min(max * 2, 1500)).reverse(); // newest first; headroom for dedupe
      let scanned = 0;
      if (pick.length) {
        for await (const m of client.fetch(pick, { uid: true, envelope: true }, { uid: true })) {
          scanned++;
          const env: any = m.envelope ?? {};
          const from = fromAddr(env);
          const subject = env.subject ?? '(no subject)';
          const date = env.date ? new Date(env.date).toISOString().slice(0, 16).replace('T', ' ') : '';
          const key = (env.messageId || `${from}|${subject}|${date}`).trim().toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ id: String(m.uid), from, subject, date, snippet: '' });
          opts.onProgress?.(scanned, out.length);
          if (out.length >= max) break;
        }
      }
    } finally { lock.release(); }
  } finally { try { await client.logout(); } catch { /* */ } }
  return out;
}

/** Drop quoted reply history so only each message's NEW text shows (mirrors google.ts). */
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

/** Extract text from an attachment buffer (PDF via unpdf, .docx via mammoth, else utf8). */
async function extractDoc(filename: string, buf: Buffer): Promise<string> {
  const lower = (filename ?? '').toLowerCase();
  try {
    if (lower.endsWith('.pdf') || buf.subarray(0, 5).toString('latin1') === '%PDF-') {
      const { getDocumentProxy, extractText } = await import('unpdf');
      const pdf = await getDocumentProxy(new Uint8Array(buf));
      const { text } = await extractText(pdf, { mergePages: true });
      return Array.isArray(text) ? text.join('\n') : String(text ?? '');
    }
    if (lower.endsWith('.docx')) return docxText(buf); // bounded inflate (W5 re-review): a lying zip can't blow up memory
    return buf.toString('utf8');
  } catch { return ''; }
}

export function fromAddr(env: any): string {
  const a = env?.from?.[0];
  return a ? (a.name ? `${a.name} <${a.address}>` : a.address) : '(unknown)';
}

/**
 * Save a message as a DRAFT: IMAP APPEND to the Drafts mailbox (found by its special-use flag, locale-independent,
 * else Gmail's default), flagged \Draft. Never sends — IMAP cannot. Shared by draft_email and the v2 reply draft.
 */
export async function appendDraft(client: Pick<ImapFlow, 'list' | 'append'>, raw: string | Buffer): Promise<{ mailbox: string; uid: number | null }> {
  let drafts = '[Gmail]/Drafts';
  try {
    const boxes = await client.list();
    const d = boxes.find((b: any) => b.specialUse === '\\Drafts');
    if (d?.path) drafts = d.path;
  } catch { /* use default */ }
  const r = await client.append(drafts, Buffer.isBuffer(raw) ? raw : Buffer.from(raw), ['\\Draft']);
  return { mailbox: drafts, uid: r && typeof r === 'object' && r.uid ? r.uid : null };
}

export function gmailImapTools(): RegisteredTool[] {
  return [
    {
      def: { name: 'search_email', description: 'Search the connected Gmail inbox (READ-ONLY). Uses Gmail search syntax (e.g. "is:unread", "from:scouts", "newer_than:7d", "subject:invoice"). Returns id | date | from | subject. Use read_email with the id to read the full message.', parameters: { type: 'object', properties: { query: { type: 'string' }, max: { type: 'number', description: 'max results, default 20' } }, required: ['query'] } },
      handler: async (args) => {
        const max = Math.min(Number(args.max ?? 20), 50);
        const q = String(args.query ?? '').trim();
        const client = await imapClient();
        try {
          const lock = await client.getMailboxLock('INBOX');
          try {
            // Gmail's own search via X-GM-RAW; fall back to "recent" if the query is rejected.
            let uids: number[];
            try { uids = (await client.search({ gmailraw: q || 'in:inbox' }, { uid: true })) || []; }
            catch { uids = (await client.search({ all: true }, { uid: true })) || []; }
            const pick = uids.slice(-max).reverse(); // newest first
            const out: string[] = [];
            if (pick.length) {
              for await (const m of client.fetch(pick, { uid: true, envelope: true }, { uid: true })) {
                const env = m.envelope ?? {};
                const date = env.date ? new Date(env.date).toISOString().slice(0, 16).replace('T', ' ') : '';
                out.push(`[${m.uid}] ${date} | ${fromAddr(env)} | ${env.subject ?? '(no subject)'}`);
              }
            }
            return out.join('\n') || '(no matches)';
          } finally { lock.release(); }
        } finally { try { await client.logout(); } catch { /* */ } }
      },
    },
    {
      def: { name: 'read_email', description: 'Read a Gmail message by id (from search_email). Quoted reply history is stripped, and text is extracted from PDF/Word attachments (e.g. an attached schedule). Returns the sender, date, subject, body, and any attachment text.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
      handler: async (args) => {
        const uid = Number(String(args.id).replace(/[^0-9]/g, ''));
        if (!uid) return '(could not read email: missing id)';
        const client = await imapClient();
        try {
          const lock = await client.getMailboxLock('INBOX');
          try {
            const msg = await client.fetchOne(String(uid), { uid: true, source: true, envelope: true }, { uid: true });
            if (!msg || !msg.source) return '(could not read email: not found)';
            const parsed = await simpleParser(msg.source as Buffer);
            const subject = parsed.subject ?? (msg.envelope?.subject ?? '');
            const from = parsed.from?.text ?? fromAddr(msg.envelope);
            const date = parsed.date ? parsed.date.toISOString() : (msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : '');
            const bodyText = parsed.text ?? (parsed.html ? String(parsed.html).replace(/<[^>]+>/g, ' ') : '');
            let block = `Subject: ${subject}\nFrom: ${from} | Date: ${date}\n\n${stripQuoted(bodyText).slice(0, 12000)}`;
            for (const a of (parsed.attachments ?? []).slice(0, 3)) {
              if (/\.(pdf|docx|txt|csv|md)$/i.test(a.filename ?? '') && a.content) {
                const text = await extractDoc(a.filename ?? '', a.content as Buffer);
                block += text ? `\n\n[attachment ${a.filename}]\n${text.slice(0, 6000)}` : `\n\n[attachment ${a.filename} — not text-extractable]`;
              }
            }
            return block.slice(0, 24000);
          } finally { lock.release(); }
        } catch (e) { return `(could not read email: ${(e as Error).message.slice(0, 80)})`; }
        finally { try { await client.logout(); } catch { /* */ } }
      },
    },
    {
      def: { name: 'draft_email', description: 'Create a DRAFT email in Gmail (does NOT send — the human reviews + sends from Gmail). The draft appears in the Drafts folder.', parameters: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'subject', 'body'] } },
      handler: async (args) => {
        const me = process.env.MWA_GMAIL_USER ?? '';
        const raw =
          `From: ${me}\r\n` +
          `To: ${args.to}\r\n` +
          `Subject: ${args.subject}\r\n` +
          `Date: ${new Date().toUTCString()}\r\n` +
          `Content-Type: text/plain; charset=utf-8\r\n\r\n` +
          `${args.body}`;
        const client = await imapClient();
        try {
          await appendDraft(client, raw);
          return '✏️ draft created in Gmail — review and send it from your Drafts folder.';
        } catch (e) { return `(could not create draft: ${(e as Error).message.slice(0, 100)})`; }
        finally { try { await client.logout(); } catch { /* */ } }
      },
    },
  ];
}
