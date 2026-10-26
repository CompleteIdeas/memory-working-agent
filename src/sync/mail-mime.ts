/**
 * A plain-text reply as an RFC 5322 message (slice A8): what Gmail drafts.create and an IMAP APPEND to Drafts take.
 *
 * Review of A8: recipients are STRUCTURED ({name, addr} from a parsed header or an IMAP envelope) — never a string
 * split on commas — so a display name such as `Chase", fraud-desk@attacker.example, "x` stays a name. Names are
 * written as an escaped quoted-string (or an RFC 2047 encoded word); an address that is not a plain addr-spec is
 * dropped. Every header value loses line breaks, NEL, line/paragraph separators and invisible characters (no header
 * injection). The body is base64, so any text survives.
 */
import { createHash, randomBytes } from 'node:crypto';
import { cleanText, isAddrSpec, type Addr } from '../v2/mail-text.js';

const oneLine = (s: string | null | undefined) => cleanText(String(s ?? '')).replace(/[\r\n\0]+/g, ' ').replace(/\s+/g, ' ').trim();
const ascii = (s: string) => /^[\x20-\x7e]*$/.test(s);

/** RFC 2047 "B" encoding, split into words of at most 45 bytes of UTF-8 (never splitting a character). */
export function encodeWord(s: string): string {
  if (ascii(s)) return s;
  const words: string[] = [];
  let chunk = '';
  for (const ch of s) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > 45) { words.push(chunk); chunk = ''; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join(' ');
}

/** One mailbox for a header: the name as an escaped quoted-string (or encoded word), the address bare. */
export function formatAddress(a: Addr): string {
  const addr = a.addr && isAddrSpec(a.addr) ? a.addr : null;
  if (!addr) return '';
  const name = oneLine(a.name).slice(0, 200);
  if (!name) return addr;
  return `${ascii(name) ? `"${name.replace(/(["\\])/g, '\\$1')}"` : encodeWord(name)} <${addr}>`;
}

export function replySubject(subject: string | null | undefined): string {
  const s = oneLine(subject).slice(0, 900);
  return /^(re|aw|sv):/i.test(s) ? s : `Re: ${s}`.trim();
}

/** Message-IDs as "<a@b>" tokens; the last 20 (a long thread's References can grow without bound). */
function ids(s: string | null | undefined): string[] {
  return (oneLine(s).match(/<[^<>\s@]{1,200}@[^<>\s]{1,200}>/g) ?? []).slice(-20);
}

/** A draft's Message-ID derived from the request's Idempotency-Key: the same key always makes the same id, so a
 *  provider can be asked "is this draft already saved?" before saving it again. */
export function draftMessageId(caller: string, key: string, from?: string | null): string {
  const domain = /@([A-Za-z0-9.-]+)$/.exec(from ?? '')?.[1] ?? 'mwa.invalid';
  return `<mwa-draft-${createHash('sha256').update(`${caller}\n${key}`).digest('hex').slice(0, 32)}@${domain}>`;
}

export interface ReplyInput {
  from?: Addr | null;
  /** who the reply goes to: the original's Reply-To, else its From */
  to: Addr[];
  subject: string | null;
  /** the original's Message-ID */
  messageId: string | null;
  /** the original's References (or In-Reply-To when it has none) */
  references: string | null;
  body: string;
  date?: Date;
  /** this draft's own Message-ID (draftMessageId); random when absent */
  draftId?: string | null;
}

export function buildReplyMime(r: ReplyInput): string {
  const to = r.to.map(formatAddress).filter(Boolean).join(', ');
  const parent = ids(r.messageId)[0] ?? null;
  const refs = [...new Set([...ids(r.references), ...(parent ? [parent] : [])])].slice(-20);
  const from = r.from ? formatAddress(r.from) : '';
  const domain = /@([A-Za-z0-9.-]+)$/.exec(r.from?.addr ?? '')?.[1] ?? 'mwa.invalid';
  const own = ids(r.draftId)[0] ?? `<${randomBytes(12).toString('hex')}@${domain}>`;
  const headers = [
    ...(from ? [`From: ${from}`] : []),
    `To: ${to}`,
    `Subject: ${encodeWord(replySubject(r.subject))}`,
    `Date: ${(r.date ?? new Date()).toUTCString()}`,
    `Message-ID: ${own}`,
    ...(parent ? [`In-Reply-To: ${parent}`] : []),
    ...(refs.length ? [`References: ${refs.join(' ')}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  ];
  const body = Buffer.from(r.body.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n');
  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}
