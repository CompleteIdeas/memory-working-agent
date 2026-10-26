/**
 * A plain-text reply as an RFC 5322 message (slice A8): what Gmail drafts.create and an IMAP APPEND to Drafts take.
 * Reply headers (In-Reply-To, References) thread it under the original; header values are stripped of line breaks
 * (no header injection from a subject or address someone else wrote); non-ASCII headers are RFC 2047 encoded and the
 * body is base64, so any text survives.
 */
import { randomBytes } from 'node:crypto';
import { parseAddress } from '../v2/mail.js';

const oneLine = (s: string | null | undefined) => String(s ?? '').replace(/[\r\n\0]+/g, ' ').trim();
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

/** One address for a header: the display name quoted or encoded, the address bare. */
export function formatAddress(raw: string): string {
  const { name, addr } = parseAddress(oneLine(raw));
  if (!addr) return '';
  if (!name) return addr;
  const n = name.replace(/["\\]/g, '');
  return `${ascii(n) ? `"${n}"` : encodeWord(n)} <${addr}>`;
}

export function replySubject(subject: string | null | undefined): string {
  const s = oneLine(subject);
  return /^(re|aw|sv):/i.test(s) ? s : `Re: ${s}`.trim();
}

/** Message-IDs as "<a@b>" tokens; the last 20 (a long thread's References can grow without bound). */
function ids(s: string | null | undefined): string[] {
  return (oneLine(s).match(/<[^<>\s]+>/g) ?? []).slice(-20);
}

export interface ReplyInput {
  from?: string | null;
  /** who the reply goes to: the original's Reply-To, else its From */
  to: string;
  subject: string | null;
  /** the original's Message-ID */
  messageId: string | null;
  /** the original's References (or In-Reply-To when it has none) */
  references: string | null;
  body: string;
  date?: Date;
}

export function buildReplyMime(r: ReplyInput): string {
  const to = oneLine(r.to).split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(formatAddress).filter(Boolean).join(', ');
  const parent = ids(r.messageId)[0] ?? null;
  const refs = [...new Set([...ids(r.references), ...(parent ? [parent] : [])])].slice(-20);
  const domain = /@([\w.-]+)/.exec(parseAddress(r.from ?? '').addr ?? '')?.[1] ?? 'mwa.invalid';
  const headers = [
    ...(r.from ? [`From: ${formatAddress(r.from)}`] : []),
    `To: ${to}`,
    `Subject: ${encodeWord(replySubject(r.subject))}`,
    `Date: ${(r.date ?? new Date()).toUTCString()}`,
    `Message-ID: <${randomBytes(12).toString('hex')}@${domain}>`,
    ...(parent ? [`In-Reply-To: ${parent}`] : []),
    ...(refs.length ? [`References: ${refs.join(' ')}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  ];
  const body = Buffer.from(r.body.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n');
  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}
