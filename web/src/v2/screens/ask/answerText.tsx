/**
 * How a helper's answer is shown (v2 build, W4 review): plain text only, links as their host, and — when the answer
 * read someone else's words (`tainted`: an email, a web page, a file) — a label that says so. Shared by the Ask flow,
 * a project's thread and "Ask about this"; W3's screens use it too.
 *
 *   <AnswerText text={turn.reply} tainted={turn.tainted} />
 *
 * The link rule is the mail sanitiser's (src/v2/mail-text.ts: cleanText + linksToHosts), ported here because the web
 * bundle does not import server code; tests/web-v2-w4-review.test.ts checks the two agree on a corpus of tricky links.
 * React escapes the text, nothing is auto-linked, and `[label](javascript:…)` stays inert words.
 */
import type { ReactNode } from 'react';

export const TAINTED_NOTE = 'Based on outside content — check before acting';

const cp = (n: number) => String.fromCodePoint(n);
const uEsc = (n: number) => '\\' + 'u{' + n.toString(16) + '}';
const INVISIBLE_RANGES: [number, number][] = [
  [0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x34f, 0x34f], [0x61c, 0x61c],
  [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f],
  [0x3164, 0x3164], [0xfe00, 0xfe0e], [0xfeff, 0xfeff], [0xffa0, 0xffa0], [0xfff9, 0xfffb],
  [0x1d173, 0x1d17a], [0xe0000, 0xe007f], [0xe0100, 0xe01ef],
];
const INVISIBLE = new RegExp('[' + INVISIBLE_RANGES.map(([a, b]) => (a === b ? uEsc(a) : `${uEsc(a)}-${uEsc(b)}`)).join('') + ']', 'gu');
const STRAY_VS16 = new RegExp(`(?<![\\p{Extended_Pictographic}0-9#*])${uEsc(0xfe0f)}`, 'gu');
const FULLWIDTH = new RegExp(`[${uEsc(0xff01)}-${uEsc(0xff5e)}]`, 'gu');
const LINE_SEPARATORS = new RegExp(`[${uEsc(0x85)}${uEsc(0x2028)}${uEsc(0x2029)}]`, 'gu');
const IDEOGRAPHIC_SPACE = new RegExp(uEsc(0x3000), 'gu');

/** Invisible and direction-changing characters gone; full-width ASCII to ASCII (so "ｈｔｔｐｓ" is seen as a link). */
export function cleanText(s: string): string {
  return s.replace(FULLWIDTH, (c) => cp(c.codePointAt(0)! - 0xfee0)).replace(IDEOGRAPHIC_SPACE, ' ')
    .replace(LINE_SEPARATORS, '\n').replace(INVISIBLE, '').replace(STRAY_VS16, '');
}

const WEB_SCHEME = /^(h(?:tt|xx|\*\*)ps?|ftps?|sftp|wss?|file):[/\\]/i;
const EMBEDDED_SCHEME = /(?:h(?:tt|xx|\*\*)ps?|ftps?|sftp|wss?|file):[/\\]/i;
const BARE_HOST_PATH = /^((?:[a-z0-9-]+\.)+[a-z]{2,63})(?::\d{1,5})?[/?#]/i;

/** The host a link points at, without "www." — or null when it has none. */
export function hostOf(href: string): string | null {
  let h = href.trim().replace(/\\/g, '/');
  if (!h) return null;
  if (WEB_SCHEME.test(h)) h = h.replace(/^[a-z*]+:\/*/i, 'http://');
  else if (/^\/\//.test(h)) h = `http:${h}`;
  else if (/^www\./i.test(h) || BARE_HOST_PATH.test(h)) h = `http://${h}`;
  else return null;
  try { return new URL(h).hostname.replace(/^www\./i, '').toLowerCase() || null; } catch { return null; }
}
function linkToken(tok: string): string {
  if (tok.length < 4) return tok;
  const lead = /^[<(["']*/.exec(tok)![0];
  let core = tok.slice(lead.length);
  const trail = /[>)\]"'.,;:!?]*$/.exec(core)![0];
  core = core.slice(0, core.length - trail.length);
  if (!core) return tok;
  let pre = '';
  let isLink = WEB_SCHEME.test(core) || /^\/\/[a-z0-9-]+\./i.test(core) || /^www\./i.test(core) || BARE_HOST_PATH.test(core);
  if (!isLink) {
    const m = EMBEDDED_SCHEME.exec(core);
    if (!m) return tok;
    pre = core.slice(0, m.index); core = core.slice(m.index); isLink = true;
  }
  const host = hostOf(core) ?? '';
  if (lead === '<' && trail.startsWith('>')) return host ? `(${host})${trail.slice(1)}` : trail.slice(1);
  return `${lead}${pre}${host}${trail}`;
}
/** Raw URLs in text become their host ("https://evil.example/track?id=1" → "evil.example"). */
export function linksToHosts(text: string): string {
  return text.replace(/[^\s]+/g, linkToken);
}

/** An answer's words as they are shown: cleaned, links as hosts. */
export function answerWords(text: string | null | undefined): string {
  return linksToHosts(cleanText(String(text ?? '')));
}

/** The tainted label, on its own (for places that lay the answer out themselves). */
export function TaintedNote() {
  return (
    <p className="taintnote" role="note">
      <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l9 16H3z" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinejoin="round" /><path d="M12 10v4M12 17v.5" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" /></svg>
      {TAINTED_NOTE}
    </p>
  );
}

/** An answer: the tainted label first (when it read outside content), then its words, links as hosts. */
export function AnswerText({ text, tainted, lead }: { text: string | null | undefined; tainted?: boolean | null; lead?: ReactNode }) {
  return (
    <>
      {tainted ? <TaintedNote /> : null}
      <span className="answertext">{lead}{answerWords(text)}</span>
    </>
  );
}
