/**
 * BL-70 — download a document MWA wrote in the form the person needs: a web page, a Word file or a
 * PDF, from the markdown it was written in. One small parser feeds all three, so they agree. It
 * covers what replies and reports use: headings, paragraphs, lists, code, bold, italic and links.
 */
import { basename, extname } from 'node:path';

type Inl = { t: 'text'; s: string } | { t: 'code'; s: string } | { t: 'b'; c: Inl[] } | { t: 'i'; c: Inl[] } | { t: 'link'; c: Inl[]; href: string };
type Block = { t: 'h'; level: number; c: Inl[] } | { t: 'p'; lines: Inl[][] } | { t: 'ul' | 'ol'; items: Inl[][] } | { t: 'code'; s: string } | { t: 'hr' };

const LIST = /^\s*([-*•]|\d+[.)])\s+/;
const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|https?:\/\/[^\s)<>]+|\*[^*\s][^*]*\*|(?<!\w)_[^_\s][^_]*_(?!\w))/g;

export function parseInline(text: string): Inl[] {
  const out: Inl[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const tok = m[0], at = m.index ?? 0;
    if (at > last) out.push({ t: 'text', s: text.slice(last, at) });
    last = at + tok.length;
    if (tok.startsWith('**')) out.push({ t: 'b', c: parseInline(tok.slice(2, -2)) });
    else if (tok.startsWith('`')) out.push({ t: 'code', s: tok.slice(1, -1) });
    else if (tok.startsWith('[')) { const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)!; out.push({ t: 'link', c: parseInline(lm[1]), href: lm[2] }); }
    else if (/^https?:/i.test(tok)) out.push({ t: 'link', c: [{ t: 'text', s: tok }], href: tok });
    else out.push({ t: 'i', c: parseInline(tok.slice(1, -1)) });
  }
  if (last < text.length) out.push({ t: 'text', s: text.slice(last) });
  return out;
}

export function parseMarkdown(text: string): Block[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const body: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) body.push(lines[i]);
      i++; out.push({ t: 'code', s: body.join('\n') }); continue;
    }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { out.push({ t: 'hr' }); i++; continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { out.push({ t: 'h', level: h[1].length, c: parseInline(h[2]) }); i++; continue; }
    if (LIST.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: Inl[][] = [];
      while (i < lines.length && LIST.test(lines[i])) {
        let item = lines[i].replace(LIST, '');
        for (i++; i < lines.length && /^\s{2,}\S/.test(lines[i]) && !LIST.test(lines[i]); i++) item += ' ' + lines[i].trim();
        items.push(parseInline(item));
      }
      out.push({ t: ordered ? 'ol' : 'ul', items }); continue;
    }
    if (!line.trim()) { i++; continue; }
    const para: Inl[][] = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,6}\s|\s*(---+|\*\*\*+)\s*$)/.test(lines[i]) && !LIST.test(lines[i])) para.push(parseInline(lines[i++]));
    out.push({ t: 'p', lines: para });
  }
  return out;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Only web and mail links survive into an exported file; a link to a sibling file has no meaning there. */
const outward = (href: string) => /^(https?:|mailto:)/i.test(href);

function inlHtml(c: Inl[]): string {
  return c.map((n) => {
    if (n.t === 'text') return esc(n.s);
    if (n.t === 'code') return `<code>${esc(n.s)}</code>`;
    if (n.t === 'b') return `<strong>${inlHtml(n.c)}</strong>`;
    if (n.t === 'i') return `<em>${inlHtml(n.c)}</em>`;
    return outward(n.href) ? `<a href="${esc(n.href)}">${inlHtml(n.c)}</a>` : inlHtml(n.c);
  }).join('');
}

export function toHtml(title: string, blocks: Block[]): string {
  const body = blocks.map((b) => {
    if (b.t === 'h') return `<h${b.level}>${inlHtml(b.c)}</h${b.level}>`;
    if (b.t === 'p') return `<p>${b.lines.map(inlHtml).join('<br>')}</p>`;
    if (b.t === 'code') return `<pre><code>${esc(b.s)}</code></pre>`;
    if (b.t === 'hr') return '<hr>';
    return `<${b.t}>${b.items.map((it) => `<li>${inlHtml(it)}</li>`).join('')}</${b.t}>`;
  }).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.6 Georgia,'Times New Roman',serif;color:#1d1d1b;background:#fff;max-width:720px;margin:40px auto;padding:0 20px}h1,h2,h3,h4{font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.25;margin:1.4em 0 .5em}h1{font-size:28px}h2{font-size:22px}h3{font-size:18px}a{color:#b4441c}code{font:13px ui-monospace,Consolas,monospace;background:#f3f1ec;padding:1px 4px;border-radius:2px}pre{background:#f3f1ec;padding:12px;overflow-x:auto}pre code{background:none;padding:0}hr{border:0;border-top:1px solid #ddd;margin:2em 0}li{margin:.25em 0}@media print{body{margin:0;max-width:none}}</style>
</head><body>
${body}
</body></html>`;
}

export async function toDocx(blocks: Block[]): Promise<Buffer> {
  const d = await import('docx');
  const runs = (c: Inl[], fmt: { bold?: boolean; italics?: boolean } = {}): any[] => c.flatMap((n): any[] => {
    if (n.t === 'text') return [new d.TextRun({ text: n.s, ...fmt })];
    if (n.t === 'code') return [new d.TextRun({ text: n.s, font: 'Consolas', ...fmt })];
    if (n.t === 'b') return runs(n.c, { ...fmt, bold: true });
    if (n.t === 'i') return runs(n.c, { ...fmt, italics: true });
    return outward(n.href) ? [new d.ExternalHyperlink({ link: n.href, children: runs(n.c, fmt).map((r) => r) })] : runs(n.c, fmt);
  });
  const HEAD = [d.HeadingLevel.HEADING_1, d.HeadingLevel.HEADING_2, d.HeadingLevel.HEADING_3, d.HeadingLevel.HEADING_4, d.HeadingLevel.HEADING_5, d.HeadingLevel.HEADING_6];
  const paras: any[] = [];
  for (const b of blocks) {
    if (b.t === 'h') paras.push(new d.Paragraph({ heading: HEAD[b.level - 1], children: runs(b.c) }));
    else if (b.t === 'p') paras.push(new d.Paragraph({ children: b.lines.flatMap((l, j) => j ? [new d.TextRun({ break: 1 }), ...runs(l)] : runs(l)) }));
    else if (b.t === 'code') paras.push(...b.s.split('\n').map((l) => new d.Paragraph({ children: [new d.TextRun({ text: l || ' ', font: 'Consolas', size: 20 })] })));
    else if (b.t === 'hr') paras.push(new d.Paragraph({ border: { bottom: { style: d.BorderStyle.SINGLE, size: 6, color: 'CCCCCC', space: 1 } }, children: [] }));
    else b.items.forEach((it, j) => paras.push(new d.Paragraph({ children: b.t === 'ol' ? [new d.TextRun(`${j + 1}. `), ...runs(it)] : runs(it), ...(b.t === 'ul' ? { bullet: { level: 0 } } : { indent: { left: 360 } }) })));
  }
  const doc = new d.Document({ styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } }, sections: [{ children: paras }] });
  return d.Packer.toBuffer(doc);
}

/** A PDF of the page, printed by the agent's own Chromium with scripts off and the network shut. */
export async function toPdf(html: string): Promise<Buffer> {
  let pw: { chromium: { launch(o: object): Promise<any> } };
  try { pw = await import('playwright-core' as string) as never; }
  catch { throw new Error('PDF needs the browser, which is not installed here'); }
  const browser = await pw.chromium.launch({ headless: true, executablePath: process.env.MWA_CHROMIUM_PATH || undefined, args: ['--disable-dev-shm-usage'] });
  try {
    const ctx = await browser.newContext({ javaScriptEnabled: false });
    await ctx.route('**/*', (r: any) => r.abort());
    const page = await ctx.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    return Buffer.from(await page.pdf({ format: 'Letter', margin: { top: '0.8in', bottom: '0.8in', left: '0.9in', right: '0.9in' }, printBackground: true }));
  } finally { await browser.close(); }
}

/** Which conversions a file offers. Only text written as prose converts; anything else is original only. */
export function exportFormats(name: string): string[] {
  return ['.md', '.markdown', '.txt'].includes(extname(name).toLowerCase()) ? ['html', 'docx', 'pdf'] : [];
}

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
};

/** Convert one document. Returns the bytes, their type, and the download name. */
export async function exportDoc(name: string, text: string, format: string): Promise<{ body: Buffer; type: string; filename: string }> {
  if (!exportFormats(name).includes(format)) throw new Error(`can't make ${format} from this file`);
  const stem = basename(name, extname(name));
  const blocks = parseMarkdown(text);
  const firstHeading = blocks.find((b) => b.t === 'h') as { c: Inl[] } | undefined;
  const title = firstHeading ? firstHeading.c.map(function flat(n: Inl): string { return 'c' in n ? n.c.map(flat).join('') : n.s; }).join('') : stem;
  const html = toHtml(title, blocks);
  const body = format === 'html' ? Buffer.from(html) : format === 'docx' ? await toDocx(blocks) : await toPdf(html);
  return { body, type: TYPES[format], filename: `${stem}.${format}` };
}
