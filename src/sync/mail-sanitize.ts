/**
 * The mail reader's sanitiser (v2 build, slice A8): an email body becomes PLAIN TEXT that is safe to show and to hand
 * to the agent later (fenced, as untrusted content).
 *
 *   - HTML is converted to text with a real parser (htmlparser2), never by regex on tags;
 *   - scripts, styles, head, templates, frames and objects are dropped with their content;
 *   - text a mail client would not show is dropped: the `hidden` attribute, aria-hidden, hidden inputs, inline CSS
 *     that hides (display:none, visibility:hidden, opacity:0, a tiny font, zero size, scale(0), off-screen,
 *     transparent colour, mso-hide:all — after CSS comments and escapes are undone), and classes or ids that a
 *     top-level <style> rule hides, wherever in the document that <style> is (styles are collected in a first pass;
 *     rules inside @media are ignored, since responsive emails hide their desktop copy there);
 *   - no remote images: a meaningful picture becomes "[picture: alt]", a tracking pixel disappears; both counted;
 *   - links appear as their words plus the host they go to — "Pay now (evil.example)"; a raw URL in any form becomes
 *     its host (src/v2/mail-text.ts); javascript:, data: and other non-web links keep only their words;
 *   - invisible, direction-changing and "tag" characters are removed;
 *   - long quoted history (attribution lines, "Original Message", Outlook's From:/Sent:, "> " runs, <blockquote>,
 *     Gmail's gmail_quote) collapses to one line — unless nothing would be left above it;
 *   - the result is capped at 100 KB (UTF-8).
 *
 * Cost (review of A8): every step is linear in the input. The parser is fed in chunks and stops at a nesting depth
 * of 1000 (htmlparser2 keeps its stack with unshift, O(depth) per tag); only the innermost open link is tracked and
 * at most 2 KB of its words are read; CSS is scanned by hand, never with a backtracking regex. As a backstop the
 * reader runs this in a worker thread with a time budget (mail-sanitize-run.ts).
 * Known limits: text the same colour as its background (other than transparent) and CSS selectors more complex than a
 * class or id are not detected. The output is plain text and is marked untrusted either way.
 */
import { Parser } from 'htmlparser2';
import { cleanText, hostOf, linksToHosts } from '../v2/mail-text.js';

export const BODY_MAX_BYTES = 100 * 1024;
const INPUT_MAX_CHARS = 3_000_000;
const CSS_MAX_CHARS = 256 * 1024;
const STYLE_ATTR_MAX = 4096;
const LINK_TEXT_MAX = 2048;
const MAX_DEPTH = 1000;
const CHUNK = 32 * 1024;
const HISTORY_LINE_MAX = 2000; // a line longer than this is not an attribution line
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd); // what a split UTF-8 sequence decodes to
const QUOTE_KEEP_LINES = 3; // a quoted block this short stays (an inline "> question" in a reply)
export const TOO_LONG_NOTE = '[The rest of this message is too long to show here.]';

export interface SanitizedBody {
  text: string;
  truncated: boolean;
  /** lines of earlier conversation hidden */
  quotedLinesHidden: number;
  /** pictures not shown (not counting tracking pixels) */
  imagesHidden: number;
  /** 1×1 tracking pixels removed */
  trackersRemoved: number;
}

const SKIP_CONTENT = new Set(['script', 'style', 'head', 'title', 'noscript', 'template', 'svg', 'math', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'canvas', 'audio', 'video', 'select', 'textarea', 'map', 'xml']);
const BLOCK = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'center', 'table', 'tbody', 'thead', 'tfoot', 'tr', 'ul', 'ol', 'dl', 'dd', 'dt', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'address', 'figure', 'figcaption', 'form', 'fieldset', 'blockquote', 'hr', 'li', 'details', 'summary']);
const PARA = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'blockquote', 'ul', 'ol', 'hr', 'pre']);

// ── CSS ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** CSS as a browser would read it, for matching: comments removed, escapes decoded, lower case, no whitespace. */
export function normalizeCss(css: string, max = STYLE_ATTR_MAX): string {
  const s = css.length > max ? css.slice(0, max) : css;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '/' && s[i + 1] === '*') { const end = s.indexOf('*/', i + 2); if (end < 0) break; i = end + 1; continue; }
    if (c === '\\') {
      let j = i + 1, hex = '';
      while (j < s.length && hex.length < 6 && /[0-9a-fA-F]/.test(s[j])) hex += s[j++];
      if (hex) {
        const n = Number.parseInt(hex, 16);
        out += n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
        if (j < s.length && /\s/.test(s[j])) j++; // one whitespace ends a hex escape
        i = j - 1;
      } else if (j < s.length) { out += s[j]; i = j; }
      continue;
    }
    out += c;
  }
  return out.toLowerCase().replace(/\s+/g, '').replace(/!important/g, '');
}

/** Normalised declarations ("display:none;color:red") that hide an element from a reader. */
function declsHide(s: string): boolean {
  const decl = (prop: string): string | null => {
    let found: string | null = null;
    for (const part of s.split(';')) { const i = part.indexOf(':'); if (i > 0 && part.slice(0, i) === prop) found = part.slice(i + 1); }
    return found; // the last declaration wins, as in CSS
  };
  if (decl('display') === 'none') return true;
  if (/^(hidden|collapse)$/.test(decl('visibility') ?? '')) return true;
  const op = decl('opacity'); if (op !== null && Number.parseFloat(op) <= 0.01) return true;
  const fs = decl('font-size');
  if (fs !== null) {
    const m = /^(\d*\.?\d+)(px|pt|em|rem|%|vw|vh)?$/.exec(fs);
    if (m) {
      const n = Number.parseFloat(m[1]), u = m[2] ?? '';
      if (n === 0 || ((u === 'px' || u === 'pt') && n <= 1) || ((u === 'em' || u === 'rem') && n <= 0.1) || (u === '%' && n <= 10)) return true;
    }
  }
  if (decl('mso-hide') === 'all') return true;
  const zero = (v: string | null) => v !== null && /^0(\.0+)?(px|pt|em|rem|%)?$/.test(v);
  const ovh = /^(hidden|clip)/.test(decl('overflow') ?? '') || /^(hidden|clip)/.test(decl('overflow-y') ?? '');
  if ((zero(decl('max-height')) || zero(decl('height'))) && ovh) return true;
  if ((zero(decl('max-width')) || zero(decl('width'))) && ovh) return true;
  if ((zero(decl('width')) || zero(decl('max-width'))) && (zero(decl('height')) || zero(decl('max-height')))) return true;
  if (zero(decl('line-height')) && zero(decl('font-size'))) return true;
  const tf = decl('transform');
  if (tf && /(^|\))scale[xy3d]*\(0(\.0+)?[,)]|matrix\(0(\.0+)?,0(\.0+)?,0(\.0+)?,0(\.0+)?,/.test(tf)) return true;
  for (const p of ['left', 'top', 'right', 'text-indent', 'margin-left', 'margin-top']) { const v = decl(p); if (v && /^-\d{3,}/.test(v)) return true; }
  const color = decl('color');
  if (color && (color === 'transparent' || /^rgba\([^)]*,0(\.0+)?\)$/.test(color) || /^hsla\([^)]*,0(\.0+)?\)$/.test(color) || /^#[0-9a-f]{6}00$/.test(color) || /^#[0-9a-f]{3}0$/.test(color))) return true;
  if (decl('clip') === 'rect(0,0,0,0)' || decl('clip') === 'rect(0px,0px,0px,0px)' || decl('clip-path') === 'inset(50%)' || decl('clip-path') === 'inset(100%)') return true;
  return false;
}
/** Inline CSS (a style attribute) that hides an element. */
export function styleHides(style: string): boolean { return declsHide(normalizeCss(style)); }

/**
 * Selectors (".class", "#id") that top-level rules hide. Rules inside @-blocks (@media, @supports…) are ignored.
 * A hand-written scan: linear, whatever the input (no braces, unbalanced braces, megabytes).
 */
export function hiddenSelectorsFrom(css: string, into: Set<string>): void {
  const s = css.length > CSS_MAX_CHARS ? css.slice(0, CSS_MAX_CHARS) : css;
  let i = 0, sel = '';
  while (i < s.length) {
    const c = s[i];
    if (c === '/' && s[i + 1] === '*') { const end = s.indexOf('*/', i + 2); if (end < 0) return; i = end + 2; continue; }
    if (c === '{') {
      const isAt = sel.trimStart().startsWith('@');
      let depth = 1, j = i + 1;
      if (isAt) { for (; j < s.length && depth; j++) { if (s[j] === '{') depth++; else if (s[j] === '}') depth--; } }
      else {
        const end = s.indexOf('}', j);
        const body = s.slice(j, end < 0 ? s.length : end);
        j = end < 0 ? s.length : end + 1;
        if (!body.includes('{') && declsHide(normalizeCss(body))) {
          for (const one of sel.split(',')) {
            const last = one.trim().split(/[\s>+~]+/).pop() ?? '';
            for (const m of last.matchAll(/([.#])(-?[A-Za-z_][\w-]*)/g)) into.add(`${m[1]}${m[2].toLowerCase()}`);
          }
        }
      }
      sel = ''; i = j; continue;
    }
    if (c === '}') { sel = ''; i++; continue; }
    if (c === ';' && sel.trimStart().startsWith('@')) { sel = ''; i++; continue; } // @import, @charset
    if (sel.length < 2000) sel += c;
    i++;
  }
}

/** Every <style> element's text, found with a plain scan of the source (first pass), at most CSS_MAX_CHARS. */
function collectStyles(html: string): string {
  const lower = html.toLowerCase();
  let out = '', from = 0;
  while (out.length < CSS_MAX_CHARS) {
    const open = lower.indexOf('<style', from);
    if (open < 0) break;
    const gt = lower.indexOf('>', open);
    if (gt < 0) break;
    const close = lower.indexOf('</style', gt);
    out += html.slice(gt + 1, close < 0 ? html.length : close) + '\n';
    if (close < 0) break;
    from = close + 7;
  }
  return out.slice(0, CSS_MAX_CHARS);
}

// ── HTML → text ─────────────────────────────────────────────────────────────────────────────────────────────────

interface Mark { line: number; col: number }
interface Frame { name: string; hidden: boolean; quote: boolean; pre: boolean; link: boolean }

function safeDecode(s: string): string { try { return decodeURIComponent(s); } catch { return s; } }

/** HTML → plain text lines; quoted parts prefixed with "> ". */
function htmlToText(html: string, counts: { images: number; pixels: number }): { text: string; cut: boolean } {
  const hiddenSel = new Set<string>();
  hiddenSelectorsFrom(collectStyles(html), hiddenSel);
  let tooDeep = false;
  const stack: Frame[] = [];
  const lines: { text: string; depth: number }[] = [];
  // the line being built; `curText` says whether it holds anything but spaces (kept as a flag: a body of many tiny
  // text events, such as 400 000 entities in a row, must not re-scan the line each time)
  // (and `curSpace` whether it ends in a space: endsWith on a long concatenated string flattens it every time)
  let cur = '', curDepth = 0, curText = false, curSpace = false;
  let quoteDepth = 0, preDepth = 0; // counters: a deeply nested body must not cost depth² work
  let openLink: { href: string; mark: Mark } | null = null;
  const depthNow = () => quoteDepth;
  const hiddenNow = () => stack.length > 0 && stack[stack.length - 1].hidden;
  const newline = () => { lines.push({ text: cur, depth: curDepth }); cur = ''; curText = false; curSpace = false; curDepth = depthNow(); };
  const ensureBreak = (blank: boolean) => {
    if (curText) newline();
    else { cur = ''; curSpace = false; }
    if (blank && lines.length && lines[lines.length - 1].text.trim() !== '') lines.push({ text: '', depth: depthNow() });
    curDepth = depthNow();
  };
  const emit = (t: string) => {
    if (!t) return;
    if (!curText) curDepth = depthNow();
    cur += t;
    curSpace = t.charCodeAt(t.length - 1) === 32;
    if (!curText && /[^ ]/.test(t)) curText = true;
  };
  const markNow = (): Mark => ({ line: lines.length, col: cur.length });
  /** At most LINK_TEXT_MAX characters written since a mark (a link's visible words). */
  const textSince = (m: Mark): string => {
    if (m.line >= lines.length) return cur.slice(m.col, m.col + LINK_TEXT_MAX);
    let out = lines[m.line].text.slice(m.col, m.col + LINK_TEXT_MAX);
    for (let i = m.line + 1; i < lines.length && out.length < LINK_TEXT_MAX; i++) out += ' ' + lines[i].text.slice(0, LINK_TEXT_MAX);
    if (out.length < LINK_TEXT_MAX) out += ' ' + cur.slice(0, LINK_TEXT_MAX);
    return out.slice(0, LINK_TEXT_MAX);
  };
  const finishLink = () => {
    const l = openLink; openLink = null;
    if (!l) return;
    const visible = textSince(l.mark).replace(/\s+/g, ' ').trim();
    const href = l.href.trim();
    const host = hostOf(href);
    if (host) {
      // the host is "already shown" only when a word of the visible text IS that host (not merely contains it)
      const words = linksToHosts(visible).toLowerCase().split(/[^a-z0-9.-]+/).map((w) => w.replace(/^\.+|\.+$/g, '').replace(/^www\./, ''));
      if (!words.includes(host)) emit(visible ? ` (${host})` : host);
    } else if (/^mailto:/i.test(href)) {
      const addr = safeDecode(href.slice(7).split('?')[0] ?? '').replace(/[\s<>"]/g, '').slice(0, 200);
      if (addr && !visible.toLowerCase().includes(addr.toLowerCase())) emit(visible ? ` (${addr})` : addr);
    } else if (visible && /^[a-z][a-z0-9+.-]*:/i.test(href)) {
      // javascript:, data:, vbscript:, a file: with no host… — the words, then "(link removed)": words that themselves
      // say "(paypal.com)" can no longer pass for the "(host)" this sanitiser adds (review of W3)
      emit(' (link removed)');
    } // relative links and in-page anchors: the words only
  };

  const parser = new Parser({
    onopentag(name, attrs) {
      if (stack.length >= MAX_DEPTH) tooDeep = true;
      const parent = stack[stack.length - 1];
      const cls = (attrs.class ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 50);
      const id = (attrs.id ?? '').toLowerCase();
      const selfHidden = SKIP_CONTENT.has(name) || 'hidden' in attrs || attrs['aria-hidden'] === 'true'
        || (attrs.style ? styleHides(attrs.style) : false)
        || (hiddenSel.size > 0 && (cls.some((c) => hiddenSel.has(`.${c}`)) || (!!id && hiddenSel.has(`#${id}`))))
        || (name === 'input' && (attrs.type ?? '').toLowerCase() === 'hidden');
      const hidden = (parent?.hidden ?? false) || selfHidden;
      const quote = !hidden && (name === 'blockquote' || cls.includes('gmail_quote') || attrs.id === 'divRplyFwdMsg' || attrs.id === 'appendonsend' || cls.includes('yahoo_quoted'));
      const pre = !hidden && (name === 'pre' || name === 'plaintext' || name === 'xmp');
      let link = false;
      if (!hidden) {
        if (name === 'br') { newline(); }
        else if (BLOCK.has(name)) ensureBreak(PARA.has(name));
        if (name === 'li') emit('• ');
        if ((name === 'td' || name === 'th') && curText) emit('  ');
        if (name === 'img') {
          const w = Number.parseInt(attrs.width ?? '', 10), h = Number.parseInt(attrs.height ?? '', 10);
          const st = normalizeCss(attrs.style ?? '');
          const sw = /(?:^|;)(?:max-)?width:(\d+)px/.exec(st)?.[1], sh = /(?:^|;)(?:max-)?height:(\d+)px/.exec(st)?.[1];
          const tiny = (n: number) => Number.isFinite(n) && n <= 2;
          const pixel = !attrs.src || tiny(w) || tiny(h) || tiny(Number(sw)) || tiny(Number(sh)) || declsHide(st);
          if (pixel) counts.pixels++;
          else {
            counts.images++;
            const alt = (attrs.alt ?? '').replace(/\s+/g, ' ').trim();
            if (alt.length > 1) emit(`${curText && !curSpace ? ' ' : ''}[picture: ${alt.slice(0, 100)}] `);
          }
        }
        if (name === 'a') {
          if (openLink) finishLink(); // links do not nest: a new one closes the open one
          if (attrs.href) { openLink = { href: attrs.href.slice(0, 4096), mark: markNow() }; link = true; }
        }
      }
      stack.push({ name, hidden, quote, pre, link });
      if (quote) quoteDepth++;
      if (pre) preDepth++;
      if (quote) { ensureBreak(false); curDepth = depthNow(); }
    },
    ontext(text) {
      if (hiddenNow()) return;
      if (preDepth > 0) {
        const parts = text.split('\n');
        parts.forEach((p, i) => { if (i > 0) newline(); emit(p); });
        return;
      }
      emit(text.replace(/\s+/g, ' ').replace(/^ /, curSpace || !cur ? '' : ' '));
    },
    onclosetag(name) {
      let idx = -1;
      for (let i = stack.length - 1; i >= 0 && i >= stack.length - 64; i--) if (stack[i].name === name) { idx = i; break; } // a stray close tag looks back a little, not the whole stack
      if (idx < 0) return;
      while (stack.length > idx) {
        const f = stack.pop()!;
        if (f.quote) quoteDepth--;
        if (f.pre) preDepth--;
        if (f.hidden) continue;
        if (f.link && openLink) finishLink();
        if (f.quote) ensureBreak(false);
        if (BLOCK.has(f.name)) ensureBreak(PARA.has(f.name));
      }
      curDepth = curText ? curDepth : depthNow();
    },
  }, { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true, recognizeSelfClosing: true });
  for (let i = 0; i < html.length && !tooDeep; i += CHUNK) parser.write(html.slice(i, i + CHUNK));
  parser.end();
  if (openLink) finishLink();
  if (curText) newline();
  return { text: lines.map((l) => (l.depth > 0 && l.text.trim() ? '> '.repeat(Math.min(l.depth, 5)) : '') + l.text).join('\n'), cut: tooDeep };
}

// ── quoted history ──────────────────────────────────────────────────────────────────────────────────────────────

/** Where quoted history starts: an attribution line, an "Original Message" rule, or Outlook's From:/Sent: block. */
function historyStart(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length > HISTORY_LINE_MAX) continue;
    const l = lines[i].replace(/^(>\s?)+/, '');
    const next = (lines[i + 1] ?? '').slice(0, HISTORY_LINE_MAX);
    if (/^\s*On\b.{4,200}\bwrote:\s*$/i.test(l)) return i;
    if (/^\s*On\b.{4,200}$/i.test(l) && /^\s*.{0,200}\bwrote:\s*$/i.test(next)) return i;
    if (/^\s*-{2,}\s*(Original|Forwarded) Message\s*-{2,}/i.test(l)) return i;
    if (/^\s*_{20,}\s*$/.test(l) && /^\s*From:/i.test(next)) return i;
    if (/^\s*From:\s.{1,300}\bSent:\s/i.test(l)) return i;
    if (/^\s*From:\s.+/i.test(l) && /^\s*(Sent|Date):\s.+/i.test(next) && /^\s*(To|Subject):/i.test((lines[i + 2] ?? '').slice(0, HISTORY_LINE_MAX))) return i;
  }
  return -1;
}

/** Collapse long quoted history into one line; keep short inline quotes. Never hides the whole message: history
 *  with nothing above it (or a message that is all quote) stays visible. */
export function collapseQuotes(text: string): { text: string; hidden: number } {
  let lines = text.split('\n');
  let hidden = 0;
  const note = (n: number) => `[Earlier messages in this conversation are hidden (${n} line${n === 1 ? '' : 's'}).]`;
  const isQuoted = (l: string) => /^\s*>/.test(l);
  const h = historyStart(lines);
  if (h > 0 && lines.slice(0, h).some((l) => l.trim() && !isQuoted(l))) {
    const rest = lines.slice(h).filter((l) => l.trim()).length;
    if (rest > QUOTE_KEEP_LINES) { hidden += rest; lines = [...lines.slice(0, h), note(rest)]; }
  }
  if (!lines.some((l) => l.trim() && !isQuoted(l) && !l.startsWith('[Earlier messages'))) return { text: lines.join('\n'), hidden };
  const out: string[] = [];
  for (let i = 0; i < lines.length;) {
    if (isQuoted(lines[i])) {
      let j = i; while (j < lines.length && (isQuoted(lines[j]) || (!lines[j].trim() && isQuoted(lines[j + 1] ?? '')))) j++;
      const n = lines.slice(i, j).filter((l) => l.replace(/^[\s>]+/, '').trim()).length;
      if (n > QUOTE_KEEP_LINES) { out.push(note(n)); hidden += n; } else out.push(...lines.slice(i, j));
      i = j;
    } else out.push(lines[i++]);
  }
  return { text: out.join('\n'), hidden };
}

/** Cap a string at `max` UTF-8 bytes without splitting a character. */
function capBytes(s: string, max: number): { text: string; cut: boolean } {
  if (s.length <= max / 4 || Buffer.byteLength(s, 'utf8') <= max) return { text: s, cut: false };
  let t = Buffer.from(s.slice(0, max), 'utf8').subarray(0, max).toString('utf8');
  while (t.endsWith(REPLACEMENT_CHAR)) t = t.slice(0, -1);
  return { text: t, cut: true };
}

/** An email body (HTML and/or plain text) → safe plain text. HTML is preferred: it is what mail clients show. */
export function sanitizeMail(input: { html?: string | null; text?: string | null }, o: { maxBytes?: number } = {}): SanitizedBody {
  const max = o.maxBytes ?? BODY_MAX_BYTES;
  const counts = { images: 0, pixels: 0 };
  let truncated = false;
  let raw: string;
  const html = input.html && input.html.trim() ? input.html : null;
  if (html) {
    const src = html.length > INPUT_MAX_CHARS ? (truncated = true, html.slice(0, INPUT_MAX_CHARS)) : html;
    const h = htmlToText(src, counts);
    raw = h.text;
    if (h.cut) truncated = true;
  } else {
    const t = input.text ?? '';
    raw = t.length > INPUT_MAX_CHARS ? (truncated = true, t.slice(0, INPUT_MAX_CHARS)) : t;
  }
  let text = cleanText(raw.replace(/\r\n?/g, '\n')).replace(/\xA0/g, ' ');
  text = text.split('\n').map((l) => linksToHosts(l).replace(/[ \t]+/g, ' ').replace(/ +$/, '')).join('\n');
  const q = collapseQuotes(text);
  text = q.text.replace(/\n{3,}/g, '\n\n').trim();
  const capped = capBytes(text, max - 200);
  if (capped.cut) { truncated = true; text = capped.text.trimEnd() + '\n\n' + TOO_LONG_NOTE; }
  else if (truncated) text += '\n\n' + TOO_LONG_NOTE;
  return { text, truncated, quotedLinesHidden: q.hidden, imagesHidden: counts.images, trackersRemoved: counts.pixels };
}
