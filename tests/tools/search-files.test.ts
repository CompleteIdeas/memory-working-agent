import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_TOOLS } from '../../src/tools/builtins.js';
import { outputSource, classifyTool } from '../../src/tools/governance.js';

/**
 * BL-75: a search over the text of files, without the shell. In the experience pilot (2026-10-23) a model with its
 * documents in a granted folder listed the folder 369 times and read a file 14 times: its `grep … | head` was staged
 * for approval (a pipe), and 17 of its 54 answers said "I couldn't verify".
 */
describe('search_files', () => {
  let sandbox: string; let outside: string;
  beforeAll(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'mwa-search-sb-'));
    outside = mkdtempSync(join(tmpdir(), 'mwa-search-out-'));
    mkdirSync(join(sandbox, 'docs'));
    writeFileSync(join(sandbox, 'docs', 'brief.md'), 'Rules for the summary\n\nIt must begin with the code word KESTREL-7.\nIt must never name the client.\n');
    writeFileSync(join(sandbox, 'docs', 'other.md'), 'Nothing to see.\nA second line about budgets ($3,250).\n');
    writeFileSync(join(sandbox, 'notes.txt'), 'kestrel sightings: two\n');
    writeFileSync(join(sandbox, 'image.png'), 'KESTREL-7 inside a binary');
    mkdirSync(join(sandbox, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(sandbox, 'node_modules', 'x', 'index.js'), 'KESTREL-7');
    writeFileSync(join(outside, 'secret.md'), 'KESTREL-7');
  });
  afterAll(() => { for (const d of [sandbox, outside]) try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } });

  const search = (args: Record<string, unknown>) => BUILTIN_TOOLS.search_files.handler(args, { sandboxDir: sandbox, interactive: false });

  it('finds the lines, case-insensitively, with file and line number, skipping binaries and node_modules', async () => {
    const r = await search({ query: 'kestrel' });
    expect(r).toContain('docs/brief.md:3: It must begin with the code word KESTREL-7.');
    expect(r).toContain('notes.txt:1: kestrel sightings: two');
    expect(r).toMatch(/^2 files match/);
    expect(r).not.toContain('image.png');
    expect(r).not.toContain('node_modules');
  });
  it('a phrase is literal unless regex is asked for', async () => {
    expect(await search({ query: '$3,250' })).toContain('docs/other.md:2');
    expect(await search({ query: 'never name the (client|customer)', regex: true })).toContain('docs/brief.md:4');
    expect(await search({ query: '(', regex: true })).toMatch(/^\(bad regular expression/);
  });
  it('searches a subfolder, and says so when nothing matches', async () => {
    expect(await search({ query: 'kestrel', dir: 'docs' })).not.toContain('notes.txt');
    expect(await search({ query: 'zebra' })).toMatch(/^\(nothing in 3 files matches "zebra"/);
    expect(await search({ query: '  ' })).toBe('(no query given)');
  });
  it('refuses a folder this run may not read, like the other file tools', async () => {
    const r = await search({ query: 'kestrel', dir: outside });
    expect(r).toMatch(/^\(refused:/);
    expect(r).not.toContain('secret.md');
  });
  it('is a read of local content for governance, like read_file', () => {
    expect(classifyTool('search_files')).toBe('read');
    expect(outputSource('search_files')).toBe('local');
  });
});
