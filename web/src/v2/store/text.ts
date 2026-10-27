/**
 * Links in text as their host only, on the client (review of W3): the same rule as the server's sanitiser
 * (src/v2/mail-text.ts `linksToHosts`, kept identical: tests/web-v2-items.test.ts checks them against each other), for
 * text the server did not sanitise — a helper's answer that read someone else's words. "https://evil.example/login"
 * becomes "evil.example"; http(s), hxxp(s), ftp, ws, file, "//host/…", "www.…" and bare "host.tld/path" alike.
 */
const WEB_SCHEME = /^(h(?:tt|xx|\*\*)ps?|ftps?|sftp|wss?|file):[/\\]/i;
const EMBEDDED_SCHEME = /(?:h(?:tt|xx|\*\*)ps?|ftps?|sftp|wss?|file):[/\\]/i;
const BARE_HOST_PATH = /^((?:[a-z0-9-]+\.)+[a-z]{2,63})(?::\d{1,5})?[/?#]/i;

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

/** Raw URLs in text become their host. Linear: one anchored pass per whitespace-free token. */
export function linksToHosts(text: string): string {
  return text.replace(/[^\s]+/g, linkToken);
}

/**
 * A display name for showing, client side as well (defence in depth; the server already does it — src/v2/mail-text.ts
 * `displayName`): nothing with an "@" in it, no empty brackets left behind, at most 60 characters.
 */
export function showName(s: string | null | undefined): string | null {
  if (!s) return null;
  let t = s
    .replace(/<[^<>]*@[^<>]*>/g, ' ')
    .replace(/[^\s]*@[^\s]*/g, ' ')
    .replace(/\(\s*\)|\[\s*\]|<\s*>|"\s*"|'\s*'/g, ' ')
    .replace(/\s+/g, ' ').trim()
    .replace(/^[\s·•|,;:\-–—]+|[\s·•|,;:\-–—]+$/g, '').trim();
  if (!t) return null;
  if (t.length > 60) t = `${t.slice(0, 59).trimEnd()}…`;
  return t;
}

// ---------- invisible characters (W4: answers; the same set as src/v2/mail-text.ts cleanText) ----------
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

/** Invisible and direction-changing characters gone; full-width ASCII to ASCII (so "ｈｔｔｐｓ" is seen as a link).
 *  Kept identical to the server's cleanText (tests/web-v2-w4-review.test.ts checks them against each other). */
export function cleanText(s: string): string {
  return s.replace(FULLWIDTH, (c) => cp(c.codePointAt(0)! - 0xfee0)).replace(IDEOGRAPHIC_SPACE, ' ')
    .replace(LINE_SEPARATORS, '\n').replace(INVISIBLE, '').replace(STRAY_VS16, '');
}

