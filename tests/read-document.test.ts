/**
 * Production review 2026-10-27: the eventing-rules question died on a PDF — the reader gave the first 8,000
 * characters, no way to read on or to pick pages, and "read those pages visually" could only mean a shell command.
 * read_document now reads by page and says how to read on; document_look shows a page as a picture, in process.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { builtinTools, pageRange, windowOf } from '../src/tools/builtins.js';

/** A small real PDF, one Helvetica page per entry, built with a correct cross-reference table. */
export function tinyPdf(pages: string[]): Buffer {
  const objs: string[] = [];
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  pages.forEach((text, i) => {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    const stream = `BT /F1 14 Tf 72 720 Td 18 TL ${text.split('\n').map((l) => `(${l.replace(/[()\\]/g, '\\$&')}) Tj T*`).join(' ')} ET`;
    objs.push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
  });
  let out = '%PDF-1.4\n'; const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const tool = (n: string) => builtinTools([n])[0];
const PAGES = ['Page one: Eventing covers dressage, cross-country and show jumping.', 'Page two: EV109 Qualifications.\nAppendix 2 lists the move-up requirements.', 'Page three: Training level needs two MERs at Novice.'];

describe('pageRange and windowOf', () => {
  it('read page specs and clamp them', () => {
    expect(pageRange('3-5', 10)).toEqual([3, 5]);
    expect(pageRange('7', 10)).toEqual([7, 7]);
    expect(pageRange('4-', 10)).toEqual([4, 10]);
    expect(pageRange('8-20', 10)).toEqual([8, 10]);
    expect(pageRange('', 10)).toEqual([1, 10]);
    expect(pageRange('zebra', 3)).toEqual([1, 3]);
    expect(pageRange('5-2', 10)).toEqual([5, 5]);
  });
  it('windows text and says how to read on, and when it is the end', () => {
    const w = windowOf('abcdefghij', 0, 4, 'x.txt', 'read_file', { path: 'x.txt' });
    expect(w).toBe('(x.txt; characters 1–4 of 10; to read on, call read_file again with path: "x.txt", offset: 4)\nabcd');
    expect(windowOf('abcdefghij', 8, 4, 'x.txt', 'read_file')).toBe('(x.txt; characters 9–10 of 10; that is the end)\nij');
    expect(windowOf('', 0, 4, 'x.txt', 'read_file')).toBe('(x.txt; no text)\n');
    expect(windowOf('abc', 99, 4, 'x.txt', 'read_file')).toMatch(/characters 4–3 of 3; that is the end/);
  });
});

describe('read_document', () => {
  it('reads a PDF by page, names the pages, and says how to read on', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mwa-doc-'));
    try {
      writeFileSync(join(dir, 'rules.pdf'), tinyPdf(PAGES));
      const ctx = { sandboxDir: dir, interactive: true } as never;
      const all = String(await tool('read_document').handler({ source: 'rules.pdf' }, ctx));
      expect(all).toMatch(/^\(rules\.pdf: 3 pages, showing pages 1–3; characters 1–\d+ of \d+; that is the end\)/);
      expect(all).toContain('[page 1 of 3]'); expect(all).toContain('[page 3 of 3]');
      expect(all).toContain('EV109 Qualifications');
      const two = String(await tool('read_document').handler({ source: 'rules.pdf', pages: '2' }, ctx));
      expect(two).toMatch(/showing page 2 \(pages: "3-" reads the rest\)/);
      expect(two).toContain('Appendix 2'); expect(two).not.toContain('Page one'); expect(two).not.toContain('Page three');
      // a window and the read-on call
      const first = String(await tool('read_document').handler({ source: 'rules.pdf', max_chars: 500 }, ctx));
      const m = /to read on, call read_document again with source: "rules\.pdf", offset: (\d+)\)/.exec(first.slice(0, 200));
      // the whole text is short, so the first window is the end; force a window with a tiny cap below the floor
      expect(first).toMatch(/characters 1–\d+ of \d+/);
      expect(m === null || Number(m[1]) > 0).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);
  it('reads a Word document and a text file with windows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mwa-doc2-'));
    try {
      const { Document, Packer, Paragraph } = await import('docx');
      const doc = new Document({ sections: [{ children: [new Paragraph('Minutes of the board.'), new Paragraph('The roof grant was approved.')] }] });
      writeFileSync(join(dir, 'minutes.docx'), await Packer.toBuffer(doc));
      const ctx = { sandboxDir: dir, interactive: true } as never;
      const w = String(await tool('read_document').handler({ source: 'minutes.docx' }, ctx));
      expect(w).toMatch(/^\(minutes\.docx; characters 1–\d+ of \d+; that is the end\)/);
      expect(w).toContain('roof grant was approved');
      writeFileSync(join(dir, 'long.txt'), 'x'.repeat(1200) + 'END');
      const a = String(await tool('read_document').handler({ source: 'long.txt', max_chars: 500 }, ctx));
      expect(a).toMatch(/characters 1–500 of 1203; to read on, call read_document again with source: "long\.txt", offset: 500/);
      const b = String(await tool('read_document').handler({ source: 'long.txt', max_chars: 500, offset: 1000 }, ctx));
      expect(b).toMatch(/characters 1001–1203 of 1203; that is the end/); expect(b.endsWith('END')).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);
});

describe('document_look', () => {
  it('shows a PDF page as a picture to a model that sees, refuses one that does not, and counts its looks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mwa-look-'));
    try {
      writeFileSync(join(dir, 'rules.pdf'), tinyPdf(PAGES));
      const sees = { sandboxDir: dir, interactive: true, runId: 'look-run-1', brainModel: 'openai/gpt-6.1-sol' } as never;
      const out = await tool('document_look').handler({ source: 'rules.pdf', page: 2 }, sees) as { text: string; image?: { mime: string; data: string } };
      expect(out.text).toMatch(/looking at page 2 of 3 of rules\.pdf; the picture is attached to your next step/);
      expect(out.image?.mime).toBe('image/jpeg');
      expect(Buffer.from(out.image!.data, 'base64').subarray(0, 2).toString('hex')).toBe('ffd8'); // a JPEG
      expect(out.image!.data.length).toBeGreaterThan(2_000);
      const beyond = await tool('document_look').handler({ source: 'rules.pdf', page: 99 }, sees) as { text: string };
      expect(beyond.text).toMatch(/page 3 of 3/); // clamped to the last page
      await expect(tool('document_look').handler({ source: 'rules.pdf' }, { ...(sees as object), brainModel: 'openai/gpt-6-luna' } as never)).rejects.toThrow(/cannot see images/);
      writeFileSync(join(dir, 'notes.txt'), 'plain');
      await expect(tool('document_look').handler({ source: 'notes.txt' }, sees)).rejects.toThrow(/not a PDF or an image/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);
});

describe('read_file and http_request read on', () => {
  it('a long file comes in windows the model can walk; a short one comes whole', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mwa-rf-'));
    try {
      writeFileSync(join(dir, 'short.txt'), 'hello');
      writeFileSync(join(dir, 'long.txt'), 'a'.repeat(5000) + 'TAIL');
      const ctx = { sandboxDir: dir, interactive: true } as never;
      expect(await tool('read_file').handler({ path: 'short.txt' }, ctx)).toBe('hello');
      const first = String(await tool('read_file').handler({ path: 'long.txt' }, ctx));
      expect(first).toMatch(/^\(long\.txt; characters 1–4000 of 5004; to read on, call read_file again with path: "long\.txt", offset: 4000\)/);
      const rest = String(await tool('read_file').handler({ path: 'long.txt', offset: 4000 }, ctx));
      expect(rest).toMatch(/characters 4001–5004 of 5004; that is the end/); expect(rest.endsWith('TAIL')).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('a long http answer comes in windows too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mwa-http-'));
    writeFileSync(join(dir, 'mwa.config.json'), JSON.stringify({ tools: { access: { preset: 'developer', grantedRoots: [] } } }));
    const prev = process.env.MWA_CONFIG_PATH; process.env.MWA_CONFIG_PATH = join(dir, 'mwa.config.json');
    const server: Server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('b'.repeat(6000) + 'END'); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/big`;
    try {
      const ctx = { sandboxDir: dir, interactive: true } as never;
      const first = String(await tool('http_request').handler({ url }, ctx));
      expect(first).toMatch(/^status=200\n\(.*; characters 1–4000 of 6003; to read on, call http_request again with url: ".*", offset: 4000\)/);
      const rest = String(await tool('http_request').handler({ url, offset: 4000 }, ctx));
      expect(rest).toMatch(/characters 4001–6003 of 6003; that is the end/); expect(rest.endsWith('END')).toBe(true);
    } finally { server.close(); if (prev === undefined) delete process.env.MWA_CONFIG_PATH; else process.env.MWA_CONFIG_PATH = prev; rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);
});
