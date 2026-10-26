/**
 * Text hygiene for mail (v2 slice A8): what every header field and body passes through before anyone sees it.
 * No database here (the sanitiser's worker thread loads it).
 *
 *   - invisible characters go: C0/C1 controls, zero-width and direction-override characters, soft hyphens, Unicode
 *     "tag" characters (U+E0000–E007F, used to smuggle hidden instructions), Hangul and Mongolian fillers, variation
 *     selectors (an emoji keeps its own U+FE0F); full-width ASCII becomes ASCII (so "ｈｔｔｐｓ" is seen as a link);
 *   - links in text become their host, whatever form they take: http(s), hxxp(s), ftp, ws, file, "//host/…",
 *     "www.…", or a bare "host.tld/path?query" — never a clickable or auto-linkable URL. Clients must still render
 *     mail text as plain text with auto-linking off;
 *   - addresses are parsed structurally (quoted names, escapes, comments, groups) and kept only when they are a
 *     plain addr-spec; anything else is "(unreadable address)".
 * Everything here is linear in its input: URLs are handled token by token with anchored patterns.
 */

const cp = (n: number) => String.fromCodePoint(n);
// Built from code points so the source holds no invisible characters (and no escapes a tool could mangle).
const uEsc = (n: number) => '\\' + 'u{' + n.toString(16) + '}';
const INVISIBLE_RANGES: [number, number][] = [
  [0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x34f, 0x34f], [0x61c, 0x61c],
  [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f],
  [0x3164, 0x3164], [0xfe00, 0xfe0e], [0xfeff, 0xfeff], [0xffa0, 0xffa0], [0xfff9, 0xfffb],
  [0x1d173, 0x1d17a], [0xe0000, 0xe007f], [0xe0100, 0xe01ef],
];
/** Invisible and direction-changing characters (see the module comment). Global, Unicode-aware. */
export const INVISIBLE = new RegExp('[' + INVISIBLE_RANGES.map(([a, b]) => (a === b ? uEsc(a) : `${uEsc(a)}-${uEsc(b)}`)).join('') + ']', 'gu');
/** U+FE0F (emoji presentation) is kept only right after an emoji or a keycap base. */
const STRAY_VS16 = new RegExp(`(?<![\\p{Extended_Pictographic}0-9#*])${uEsc(0xfe0f)}`, 'gu');
const FULLWIDTH = new RegExp(`[${uEsc(0xff01)}-${uEsc(0xff5e)}]`, 'gu');
const LINE_SEPARATORS = new RegExp(`[${uEsc(0x85)}${uEsc(0x2028)}${uEsc(0x2029)}]`, 'gu');
const IDEOGRAPHIC_SPACE = new RegExp(uEsc(0x3000), 'gu');

/** Strip invisible characters; full-width ASCII to ASCII; NEL and line/paragraph separators become newlines. */
export function cleanText(s: string): string {
  return s
    .replace(FULLWIDTH, (c) => cp(c.codePointAt(0)! - 0xfee0))
    .replace(IDEOGRAPHIC_SPACE, ' ')
    .replace(LINE_SEPARATORS, '\n')
    .replace(INVISIBLE, '')
    .replace(STRAY_VS16, '');
}

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (m, e: string) => {
    const l = e.toLowerCase();
    const n = l.startsWith('#x') ? Number.parseInt(l.slice(2), 16) : l.startsWith('#') ? Number.parseInt(l.slice(1), 10) : NaN;
    if (!Number.isNaN(n)) return n > 0 && n < 0x110000 ? cp(n) : '';
    return ENTITY[l] ?? m;
  });
}

/** One line of plain text for a header field: entities decoded (Gmail snippets carry them), invisible characters
 *  gone, whitespace collapsed, links as hosts. */
export function cleanLine(s: string | null | undefined, max = 500): string {
  if (!s) return '';
  const t = cleanText(decodeEntities(String(s).slice(0, max * 8))).replace(/\s+/g, ' ').trim();
  return linksToHosts(t).slice(0, max).trim();
}

// ── links ───────────────────────────────────────────────────────────────────────────────────────────────────────

const WEB_SCHEME = /^(h(?:tt|xx|\*\*)ps?|ftps?|sftp|wss?|file):[/\\]/i;
const EMBEDDED_SCHEME = /(?:h(?:tt|xx|\*\*)ps?|ftps?|sftp|wss?|file):[/\\]/i;
const BARE_HOST_PATH = /^((?:[a-z0-9-]+\.)+[a-z]{2,63})(?::\d{1,5})?[/?#]/i;

/** The host a link points at, without "www." — or null when it has none. Accepts the defanged and odd forms. */
export function hostOf(href: string): string | null {
  let h = href.trim().replace(/\\/g, '/');
  if (!h) return null;
  if (WEB_SCHEME.test(h)) h = h.replace(/^[a-z*]+:\/*/i, 'http://');
  else if (/^\/\//.test(h)) h = `http:${h}`;
  else if (/^www\./i.test(h) || BARE_HOST_PATH.test(h)) h = `http://${h}`;
  else return null;
  try { return new URL(h).hostname.replace(/^www\./i, '').toLowerCase() || null; } catch { return null; }
}

/** One whitespace-free token: any link in it becomes its host. Anchored patterns only (linear). */
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
    const m = EMBEDDED_SCHEME.exec(core); // "url=https://…", "see:hxxps://…"
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

// ── addresses ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface Addr { name: string | null; addr: string | null }
export const UNREADABLE_ADDRESS = '(unreadable address)';

const ADDR_SPEC = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
/** A plain addr-spec (dot-atom local part, a real domain), at most 254 characters. */
export function isAddrSpec(s: string): boolean { return s.length <= 254 && ADDR_SPEC.test(s); }

/**
 * An address list ("Name" <a@b>, c@d (comment), Group: e@f;) → its addresses, parsed structurally: quoted strings
 * with backslash escapes, nested comments, angle addresses and groups. A comma inside quotes or a comment never
 * splits. An address that is not a plain addr-spec comes back with addr null.
 */
export function parseAddressList(input: string | null | undefined, maxLen = 4000): Addr[] {
  const s = String(input ?? '').slice(0, maxLen);
  const parts: { text: string; angle: string | null }[] = [];
  let text = '', angle: string | null = null, inAngle = false, quote = false, comment = 0;
  const flush = () => { if (text.trim() || angle !== null) parts.push({ text, angle }); text = ''; angle = null; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\' && i + 1 < s.length) { text += s[++i]; continue; }
      if (c === '"') { quote = false; continue; }
      text += c; continue;
    }
    if (comment) {
      if (c === '\\') { i++; continue; }
      if (c === '(') comment++;
      else if (c === ')') comment--;
      continue;
    }
    if (inAngle) {
      if (c === '>') { inAngle = false; continue; }
      angle = (angle ?? '') + c; continue;
    }
    if (c === '"') { quote = true; continue; }
    if (c === '(') { comment = 1; continue; }
    if (c === '<') { inAngle = true; angle = ''; continue; }
    if (c === ',' || c === ';') { flush(); continue; }
    if (c === ':' && angle === null && !text.includes('@')) { text = ''; continue; } // "Group:" — the group's name is dropped
    text += c;
  }
  flush();
  return parts.map(({ text: t, angle: a }) => {
    const name = cleanLine(a !== null ? t : null, 200) || null;
    const raw = (a !== null ? a : t).replace(/\s+/g, '').trim();
    const addr = raw && isAddrSpec(raw) ? raw.toLowerCase() : null;
    return { name: name ?? (addr ? null : raw ? UNREADABLE_ADDRESS : null), addr };
  }).filter((x) => x.addr || x.name);
}

/** The first address of a header ("Name <a@b>" → its parts). */
export function parseAddress(s: string | null | undefined): Addr {
  return parseAddressList(s)[0] ?? { name: null, addr: null };
}

/** Addresses for showing: "Name <addr>", invalid ones as "(unreadable address)". */
export function showAddresses(list: Addr[]): string {
  return list.map((a) => (a.addr ? (a.name && a.name !== UNREADABLE_ADDRESS ? `${a.name} <${a.addr}>` : a.addr) : UNREADABLE_ADDRESS)).join(', ');
}
