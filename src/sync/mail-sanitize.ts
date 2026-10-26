/**
 * The mail reader's sanitiser (v2 build, slice A8): an email body becomes PLAIN TEXT that is safe to show and to hand
 * to the agent later (fenced, as untrusted content).
 *
 *   - HTML is converted to text with a real parser (htmlparser2), never by regex on tags;
 *   - scripts, styles, head, templates, embedded frames and objects are dropped with their content;
 *   - text a mail client would not show is dropped: the `hidden` attribute, aria-hidden, inline CSS that hides
 *     (display:none, visibility:hidden, opacity:0, font-size:0/1px, zero height with overflow hidden, off-screen,
 *     transparent colour, mso-hide:all) and classes a top-level <style> rule hides (rules inside @media are ignored:
 *     responsive emails hide their desktop copy there);
 *   - no remote images: pictures are not fetched or linked; a meaningful one becomes "[picture: alt]", a tracking
 *     pixel (≤ 2 px, or no source) disappears; both are counted;
 *   - links appear as their visible text plus the host they go to — "Pay now (evil.example)" — and a raw URL in the
 *     text becomes its host, so nothing is ever an auto-linkable URL; javascript:, data: and other non-web links keep
 *     only their text;
 *   - invisible and direction-changing characters (zero-width, bidi overrides, soft hyphens) are removed;
 *   - long quoted history ("On … wrote:", "-----Original Message-----", Outlook's From:/Sent: block, "> " runs,
 *     Gmail's gmail_quote, <blockquote>) is collapsed to one line saying how much was hidden;
 *   - the result is capped at 100 KB (UTF-8), and the input is bounded before parsing.
 * Known limits: text the same colour as its background (other than transparent) and hiding through CSS selectors more
 * complex than a class are not detected. The output is still plain text, and it is marked untrusted.
 */
import { Parser } from 'htmlparser2';
import { hostOf, linksToHosts, INVISIBLE } from '../v2/mail.js';

export const BODY_MAX_BYTES = 100 * 1024;
const INPUT_MAX_CHARS = 3_000_000;
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd); // what a split UTF-8 sequence decodes to
// htmlparser2 keeps its open-element stack with unshift (O(depth) per tag): a hostile, deeply nested body costs
// depth² work. Real mail nests a few dozen levels (tables in tables); past MAX_DEPTH the rest is not shown, and the
// input is fed in chunks so the parser never runs far past the limit.
const MAX_DEPTH = 1000;
const CHUNK = 32 * 1024;
const QUOTE_KEEP_LINES = 3; // a quoted block this short stays (an inline "> question" in a reply)

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
const BLOCK = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'center', 'table', 'tbody', 'thead', 'tfoot', 'tr', 'ul', 'ol', 'dl', 'dd', 'dt', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'address', 'figure', 'figcaption', 'form', 'fieldset', 'blockquote', 'hr', 'li']);
const PARA = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'blockquote', 'ul', 'ol', 'hr']);

/** Inline CSS that hides an element from a reader. */
export function styleHides(style: string): boolean {
  const s = style.toLowerCase().replace(/\s+/g, '').replace(/!important/g, '');
  const decl = (prop: string) => { const m = new RegExp(`(?:^|;)${prop}:([^;]*)`).exec(s); return m ? m[1] : null; };
  if (decl('display') === 'none') return true;
  if (/^(hidden|collapse)$/.test(decl('visibility') ?? '')) return true;
  const op = decl('opacity'); if (op !== null && Number.parseFloat(op) <= 0.01) return true;
  const fs = decl('font-size'); if (fs !== null && /^(0|0?\.\d+|1)(px|pt|em|rem|%)?$/.test(fs) && Number.parseFloat(fs) <= 1) return true;
  if (decl('mso-hide') === 'all') return true;
  const zero = (v: string | null) => v !== null && /^0(px|pt|em|rem|%)?$/.test(v);
  const ovh = (decl('overflow') ?? '') === 'hidden';
  if ((zero(decl('max-height')) || zero(decl('height')) || zero(decl('max-width')) || zero(decl('width'))) && ovh) return true;
  if (zero(decl('max-height')) && zero(decl('max-width'))) return true;
  for (const p of ['left', 'top', 'text-indent', 'margin-left']) { const v = decl(p); if (v && /^-\d{3,}/.test(v)) return true; }
  const color = decl('color');
  if (color && (color === 'transparent' || /^rgba\([^)]*,0(\.0+)?\)$/.test(color) || /^#[0-9a-f]{6}00$/.test(color))) return true;
  if (decl('clip') === 'rect(0,0,0,0)' || decl('clip-path') === 'inset(50%)') return true;
  return false;
}

/** Classes that top-level rules in <style> hide (".preheader{display:none}"). Rules inside @-blocks (@media,
 *  @supports…) are ignored: responsive emails hide their desktop copy inside a media query. */
export function hiddenClassesFrom(css: string, into: Set<string>): void {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let top = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '@') { top += text[i]; continue; }
    // skip an @-rule: up to its ';' (@import, @charset) or through its balanced { … } block
    let j = i;
    while (j < text.length && text[j] !== '{' && text[j] !== ';') j++;
    if (text[j] === '{') {
      let depth = 0;
      for (; j < text.length; j++) { if (text[j] === '{') depth++; else if (text[j] === '}' && --depth === 0) break; }
    }
    i = j;
  }
  for (const m of top.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!styleHides(m[2])) continue;
    for (const one of m[1].split(',')) {
      const last = one.trim().split(/[\s>+~]+/).pop() ?? '';
      for (const c of last.matchAll(/\.([A-Za-z_][\w-]*)/g)) into.add(c[1].toLowerCase());
    }
  }
}

interface Mark { line: number; col: number }
interface Frame { name: string; hidden: boolean; quote: boolean; pre: boolean; link: { href: string; mark: Mark } | null }

/** HTML → plain text lines; quoted parts prefixed with "> ". */
function htmlToText(html: string, counts: { images: number; pixels: number }): { text: string; cut: boolean } {
  let tooDeep = false;
  const hiddenClasses = new Set<string>();
  const stack: Frame[] = [];
  const lines: { text: string; depth: number }[] = [];
  let cur = '', curDepth = 0;
  let styleBuf: string | null = null;
  let quoteDepth = 0, preDepth = 0; // kept as counters: a hostile, deeply nested body must not cost depth² work
  const depthNow = () => quoteDepth;
  const hiddenNow = () => stack.length > 0 && stack[stack.length - 1].hidden;
  const preNow = () => preDepth > 0;
  const newline = () => { lines.push({ text: cur, depth: curDepth }); cur = ''; curDepth = depthNow(); };
  const ensureBreak = (blank: boolean) => {
    if (cur.trim()) newline();
    else cur = '';
    if (blank && lines.length && lines[lines.length - 1].text.trim() !== '') lines.push({ text: '', depth: depthNow() });
    curDepth = depthNow();
  };
  const emit = (t: string) => {
    if (!t) return;
    if (!cur.trim()) curDepth = depthNow();
    cur += t;
  };
  const markNow = (): Mark => ({ line: lines.length, col: cur.length });
  /** The text written since a mark (a link's visible words): only the lines after it are read. */
  const textSince = (m: Mark) => {
    if (m.line >= lines.length) return cur.slice(m.col);
    return [lines[m.line].text.slice(m.col), ...lines.slice(m.line + 1).map((l) => l.text), cur].join(' ');
  };

  const parser = new Parser({
    onopentag(name, attrs) {
      if (stack.length >= MAX_DEPTH) tooDeep = true;
      const parent = stack[stack.length - 1];
      const cls = (attrs.class ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const selfHidden = SKIP_CONTENT.has(name) || 'hidden' in attrs || attrs['aria-hidden'] === 'true'
        || (attrs.style ? styleHides(attrs.style) : false) || cls.some((c) => hiddenClasses.has(c))
        || (name === 'input' && (attrs.type ?? '').toLowerCase() === 'hidden');
      const hidden = (parent?.hidden ?? false) || selfHidden;
      const quote = name === 'blockquote' || cls.includes('gmail_quote') || attrs.id === 'divRplyFwdMsg' || attrs.id === 'appendonsend' || cls.includes('yahoo_quoted') || attrs.type === 'cite';
      if (name === 'style') styleBuf = '';
      let link: Frame['link'] = null;
      if (!hidden) {
        if (name === 'br') { newline(); }
        else if (BLOCK.has(name)) ensureBreak(PARA.has(name));
        if (name === 'li') emit('• ');
        if (name === 'td' || name === 'th') { if (cur.trim()) emit('  '); }
        if (name === 'img') {
          const w = Number.parseInt(attrs.width ?? '', 10), h = Number.parseInt(attrs.height ?? '', 10);
          const st = (attrs.style ?? '').toLowerCase().replace(/\s+/g, '');
          const sw = /(?:^|;)width:(\d+)px/.exec(st)?.[1], sh = /(?:^|;)height:(\d+)px/.exec(st)?.[1];
          const tiny = (n: number) => Number.isFinite(n) && n <= 2;
          const pixel = !attrs.src || tiny(w) || tiny(h) || tiny(Number(sw)) || tiny(Number(sh));
          if (pixel) counts.pixels++;
          else {
            counts.images++;
            const alt = (attrs.alt ?? '').replace(/\s+/g, ' ').trim();
            if (alt.length > 1) emit(`${cur.trim() && !cur.endsWith(' ') ? ' ' : ''}[picture: ${alt.slice(0, 100)}] `);
          }
        }
        if (name === 'a' && attrs.href) link = { href: attrs.href, mark: markNow() };
      }
      stack.push({ name, hidden, quote, pre: name === 'pre', link });
      if (quote && !hidden) { ensureBreak(false); curDepth = depthNow(); }
    },
    ontext(text) {
      if (styleBuf !== null && stack[stack.length - 1]?.name === 'style') { styleBuf += text; return; }
      if (hiddenNow()) return;
      if (preNow()) {
        const parts = text.split('\n');
        parts.forEach((p, i) => { if (i > 0) newline(); emit(p); });
        return;
      }
      emit(text.replace(/\s+/g, ' ').replace(/^ /, cur.endsWith(' ') || !cur ? '' : ' '));
    },
    onclosetag(name) {
      let idx = -1;
      for (let i = stack.length - 1; i >= 0; i--) if (stack[i].name === name) { idx = i; break; }
      if (idx < 0) return;
      while (stack.length > idx) {
        const f = stack.pop()!;
        if (f.name === 'style' && styleBuf !== null) { hiddenClassesFrom(styleBuf, hiddenClasses); styleBuf = null; }
        if (f.hidden) continue;
        if (f.link) {
          const visible = textSince(f.link.mark).replace(/\s+/g, ' ').trim();
          const href = f.link.href.trim();
          const host = hostOf(href);
          if (host) {
            const shown = linksToHosts(visible).toLowerCase();
            if (!shown.includes(host)) emit(visible ? ` (${host})` : host);
          } else if (/^mailto:/i.test(href)) {
            const addr = decodeURIComponent(href.slice(7).split('?')[0] ?? '').slice(0, 200);
            if (addr && !visible.toLowerCase().includes(addr.toLowerCase())) emit(visible ? ` (${addr})` : addr);
          } // javascript:, data:, vbscript:, file:, relative — the text only
        }
        if (f.quote) { ensureBreak(false); }
        if (BLOCK.has(f.name)) ensureBreak(PARA.has(f.name));
      }
      curDepth = cur.trim() ? curDepth : depthNow();
    },
  }, { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true, recognizeSelfClosing: true });
  for (let i = 0; i < html.length && !tooDeep; i += CHUNK) parser.write(html.slice(i, i + CHUNK));
  parser.end();
  if (cur.trim()) newline();
  return { text: lines.map((l) => (l.depth > 0 && l.text.trim() ? '> '.repeat(l.depth) : '') + l.text).join('\n'), cut: tooDeep };
}


/** Where quoted history starts: an attribution line, an "Original Message" rule, or Outlook's From:/Sent: block. */
function historyStart(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].replace(/^(>\s?)+/, '');
    if (/^\s*On\b.{4,200}\bwrote:\s*$/i.test(l)) return i;
    if (/^\s*On\b.{4,200}$/i.test(l) && /^\s*.{0,200}\bwrote:\s*$/i.test(lines[i + 1] ?? '')) return i;
    if (/^\s*-{2,}\s*(Original|Forwarded) Message\s*-{2,}/i.test(l)) return i;
    if (/^\s*_{20,}\s*$/.test(l) && /^\s*From:/i.test(lines[i + 1] ?? '')) return i;
    if (/^\s*From:\s.+\bSent:\s/i.test(l)) return i;
    if (/^\s*From:\s.+/i.test(l) && /^\s*(Sent|Date):\s.+/i.test(lines[i + 1] ?? '') && /^\s*(To|Subject):/i.test(lines[i + 2] ?? '')) return i;
  }
  return -1;
}

/** Collapse long quoted history into one line; keep short inline quotes. */
export function collapseQuotes(text: string): { text: string; hidden: number } {
  let lines = text.split('\n');
  let hidden = 0;
  const note = (n: number) => `[Earlier messages in this conversation are hidden (${n} line${n === 1 ? '' : 's'}).]`;
  const h = historyStart(lines);
  if (h >= 0) {
    const rest = lines.slice(h).filter((l) => l.trim()).length;
    if (rest > QUOTE_KEEP_LINES) { hidden += rest; lines = [...lines.slice(0, h), note(rest)]; }
  }
  const out: string[] = [];
  for (let i = 0; i < lines.length;) {
    if (/^\s*>/.test(lines[i])) {
      let j = i; while (j < lines.length && (/^\s*>/.test(lines[j]) || (!lines[j].trim() && /^\s*>/.test(lines[j + 1] ?? '')))) j++;
      const n = lines.slice(i, j).filter((l) => l.replace(/^[\s>]+/, '').trim()).length;
      if (n > QUOTE_KEEP_LINES) { out.push(note(n)); hidden += n; } else out.push(...lines.slice(i, j));
      i = j;
    } else out.push(lines[i++]);
  }
  return { text: out.join('\n'), hidden };
}

/** Cap a string at `max` UTF-8 bytes without splitting a character. */
function capBytes(s: string, max: number): { text: string; cut: boolean } {
  if (Buffer.byteLength(s, 'utf8') <= max) return { text: s, cut: false };
  let t = Buffer.from(s, 'utf8').subarray(0, max).toString('utf8');
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
  let text = raw.replace(/\r\n?/g, '\n').replace(INVISIBLE, '').replace(/\xA0/g, ' ');
  text = linksToHosts(text);
  text = text.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').replace(/ +$/, '')).join('\n');
  const q = collapseQuotes(text);
  text = q.text.replace(/\n{3,}/g, '\n\n').trim();
  const capped = capBytes(text, max - 200);
  if (capped.cut) { truncated = true; text = capped.text.trimEnd() + '\n\n[The rest of this message is too long to show here.]'; }
  else if (truncated) text += '\n\n[The rest of this message is too long to show here.]';
  return { text, truncated, quotedLinesHidden: q.hidden, imagesHidden: counts.images, trackersRemoved: counts.pixels };
}
