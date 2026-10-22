/**
 * BL-70 — the person's files. A chat reply linked "ai-newsletter-research.md" and nothing served it.
 * Files are listed, opened, added, shared and downloaded (as written, or as Word / PDF / web page),
 * and only from under the workspace.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { insideRoot, listFiles, saveUpload, deleteFile, fileHeaders, createShare, readShares, revokeShare, shareFor, sessionFolder, uploadsIn, cleanName } from '../src/files.js';
import { exportDoc, exportFormats, parseMarkdown, toHtml } from '../src/doc-export.js';

let root: string, outside: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mwa-files-'));
  outside = mkdtempSync(join(tmpdir(), 'mwa-outside-'));
  mkdirSync(join(root, 'serve', 'web-abc'), { recursive: true });
  writeFileSync(join(root, 'serve', 'web-abc', 'notes.md'), '# Notes\n\nHello **there**.');
  writeFileSync(join(outside, 'secret.txt'), 'no');
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });

describe('which files can be reached', () => {
  it('a path inside the workspace resolves; one that climbs out does not', () => {
    expect(insideRoot(root, 'serve/web-abc/notes.md')).toBe(join(root, 'serve', 'web-abc', 'notes.md'));
    expect(insideRoot(root, '../' + outside.split(/[\\/]/).pop() + '/secret.txt')).toBeNull();
    expect(insideRoot(root, 'serve/../../x')).toBeNull();
    expect(insideRoot(root, '/etc/passwd')).toBe(join(root, 'etc', 'passwd')); // rooted, never absolute
    expect(insideRoot(root, '')).toBeNull();
  });
  it('dot-files are MWA’s own, not the person’s: the share list cannot be read through the files API', () => {
    expect(insideRoot(root, '.shares.json')).toBeNull();
    expect(insideRoot(root, 'serve/.hidden/x.md')).toBeNull();
  });
  it('a link inside the workspace that points out of it is refused', () => {
    try { symlinkSync(join(outside, 'secret.txt'), join(root, 'serve', 'web-abc', 'link.txt')); } catch { return; } // no symlink rights (Windows)
    expect(insideRoot(root, 'serve/web-abc/link.txt')).toBeNull();
  });
  it('the list is every file, newest first, without dot-files', () => {
    writeFileSync(join(root, '.shares.json'), '[]');
    const rows = listFiles(root);
    expect(rows.map((r) => r.path)).toEqual(['serve/web-abc/notes.md']);
  });
});

describe('adding and deleting', () => {
  it('an upload lands in the chat’s uploads folder, never over another file, and the chat is told', () => {
    const folder = `${sessionFolder('web-abc')}/uploads`;
    expect(saveUpload(root, folder, 'brief.pdf', Buffer.from('a'))).toBe('serve/web-abc/uploads/brief.pdf');
    expect(saveUpload(root, folder, 'brief.pdf', Buffer.from('b'))).toBe('serve/web-abc/uploads/brief (2).pdf');
    expect(saveUpload(root, folder, '../../evil.sh', Buffer.from('c'))).toBe('serve/web-abc/uploads/evil.sh');
    expect(uploadsIn(root, sessionFolder('web-abc'))).toEqual(expect.arrayContaining(['uploads/brief.pdf', 'uploads/brief (2).pdf']));
    expect(cleanName('.env')).toBe('env');
  });
  it('delete removes one file and nothing outside', () => {
    expect(deleteFile(root, 'serve/web-abc/notes.md')).toBe(true);
    expect(deleteFile(root, '../' + outside.split(/[\\/]/).pop() + '/secret.txt')).toBe(false);
    expect(existsSync(join(outside, 'secret.txt'))).toBe(true);
  });
});

describe('serving', () => {
  it('HTML and SVG go out as text, and every file is sandboxed', () => {
    expect(fileHeaders('page.html', 1, false)['content-type']).toMatch(/^text\/plain/);
    expect(fileHeaders('x.svg', 1, false)['content-type']).toMatch(/^text\/plain/);
    expect(fileHeaders('notes.md', 1, false)['content-security-policy']).toMatch(/^sandbox/);
    expect(fileHeaders('a.png', 1, false)['content-type']).toBe('image/png');
    expect(fileHeaders('a.bin', 1, true)['content-disposition']).toMatch(/^attachment/);
    expect(fileHeaders('a"\r\nb.md', 1, true)['content-disposition']).not.toMatch(/[\r\n]/);
  });
});

describe('share links', () => {
  it('a link opens its one file until it expires or is turned off', () => {
    const now = Date.now();
    const s = createShare(root, 'serve/web-abc/notes.md', 7, now)!;
    expect(s.token.length).toBeGreaterThanOrEqual(24);
    expect(shareFor(root, s.token, now + 1)?.abs).toBe(join(root, 'serve', 'web-abc', 'notes.md'));
    expect(shareFor(root, s.token, now + 8 * 86_400_000)).toBeNull();
    expect(shareFor(root, 'nope', now)).toBeNull();
    expect(revokeShare(root, s.token)).toBe(true);
    expect(shareFor(root, s.token, now + 1)).toBeNull();
  });
  it('no link for a file that is not there or not inside', () => {
    expect(createShare(root, 'serve/web-abc/none.md', 7)).toBeNull();
    expect(createShare(root, '.shares.json', 7)).toBeNull();
    expect(readShares(root)).toEqual([]);
  });
  it('a deleted file closes its link', () => {
    const s = createShare(root, 'serve/web-abc/notes.md', 7)!;
    deleteFile(root, 'serve/web-abc/notes.md');
    expect(shareFor(root, s.token)).toBeNull();
  });
});

describe('downloads as Word, PDF or a web page', () => {
  const md = '# AI worth your time\n\nThe **news** that _matters_, with [a source](https://example.com) and [a sibling](other.md).\n\n- one\n- two\n\n1. first\n2. second\n\n```\ncode <b>\n```';
  it('documents offer the conversions; other files only the original', () => {
    expect(exportFormats('r.md')).toEqual(['html', 'docx', 'pdf']);
    expect(exportFormats('r.csv')).toEqual([]);
  });
  it('the web page is escaped, titled by the first heading, and keeps only outward links', async () => {
    const out = await exportDoc('r.md', md + '\n\n<script>alert(1)</script>', 'html');
    const html = out.body.toString();
    expect(out.filename).toBe('r.html');
    expect(html).toContain('<title>AI worth your time</title>');
    expect(html).toContain('<strong>news</strong>');
    expect(html).toContain('<a href="https://example.com">a source</a>');
    expect(html).not.toContain('other.md');
    expect(html).not.toContain('<script>');
    expect(html).toContain('code &lt;b&gt;');
  });
  it('the Word file is a real .docx', async () => {
    const out = await exportDoc('r.md', md, 'docx');
    expect(out.filename).toBe('r.docx');
    expect(out.body.subarray(0, 2).toString()).toBe('PK');
    expect(out.body.length).toBeGreaterThan(2000);
  });
  it('a conversion the file does not offer is refused', async () => {
    await expect(exportDoc('r.csv', 'a,b', 'docx')).rejects.toThrow();
  });
  it('the parser reads what reports use', () => {
    const b = parseMarkdown(md);
    expect(b.map((x) => x.t)).toEqual(['h', 'p', 'ul', 'ol', 'code']);
    expect(toHtml('t', b)).toContain('<ol><li>first</li><li>second</li></ol>');
  });
});
