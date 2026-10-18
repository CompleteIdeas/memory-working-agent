import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorker } from '../src/worker.js';
import { insideReal } from '../src/tools/shell-gate.js';
import type { Provider, ChatResult } from '../src/provider.js';

/**
 * BL-29 — the coding worker keeps the files it writes inside its sandbox by REAL path, with a separator
 * after the root: a sibling folder sharing the name's prefix, and a link inside the sandbox, both used to
 * pass `target.startsWith(resolve(sandboxDir))`.
 */
const writes = (files: Array<{ path: string; content: string }>): Provider => ({
  id: 'stub', model: 'stub', price: [0, 0],
  chat: async (): Promise<ChatResult> => ({ text: JSON.stringify({ files }), usage: { input: 1, output: 1 } }),
});

describe('the coding worker stays in its sandbox (BL-29)', () => {
  it('insideReal needs a separator after the root, and compares real paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'mwa-bl29-'));
    try {
      const box = join(root, 'sandbox'); mkdirSync(box);
      expect(insideReal(box, join(box, 'a.txt'))).toBe(true);
      expect(insideReal(box, box)).toBe(true);
      expect(insideReal(box, join(root, 'sandbox-x', 'a.txt'))).toBe(false);
      expect(insideReal(box, join(box, '..', 'a.txt'))).toBe(false);
      if (process.platform === 'win32') expect(insideReal(box.toUpperCase(), join(box, 'a.txt'))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a sibling folder and a link out of the sandbox are skipped; an ordinary file is written', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mwa-bl29w-'));
    try {
      const box = join(root, 'sandbox'); mkdirSync(box);
      const outside = join(root, 'outside'); mkdirSync(outside);
      symlinkSync(outside, join(box, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
      const r = await runWorker(writes([
        { path: '../sandbox-x/escape.txt', content: 'x' },
        { path: 'link/escape.txt', content: 'x' },
        { path: 'src/ok.mjs', content: 'export {}' },
      ]), { instruction: 'write files', testCmd: 'node -e "0"' }, box);
      expect(existsSync(join(root, 'sandbox-x', 'escape.txt'))).toBe(false);
      expect(existsSync(join(outside, 'escape.txt'))).toBe(false);
      expect(existsSync(join(box, 'src', 'ok.mjs'))).toBe(true);
      expect(r.filesWritten).toEqual(['src/ok.mjs']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  it('the grader is never overwritten, however its path is spelled', async () => {
    const box = mkdtempSync(join(tmpdir(), 'mwa-bl29g-'));
    try {
      writeFileSync(join(box, 'test.mjs'), 'GRADER');
      const spellings = ['test.mjs', './test.mjs', 'src/../test.mjs', ...(process.platform === 'win32' ? ['TEST.MJS'] : [])];
      const r = await runWorker(writes(spellings.map((path) => ({ path, content: 'process.exit(0)' }))), { instruction: 'x', testCmd: 'node -e "0"' }, box);
      expect(readFileSync(join(box, 'test.mjs'), 'utf8')).toBe('GRADER');
      expect(r.filesWritten).toEqual([]);
    } finally { rmSync(box, { recursive: true, force: true }); }
  }, 30_000);

  it('a link to a file not made yet outside the sandbox carries no write — worker or write_file (BL-29 review)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mwa-bl29d-'));
    try {
      const box = join(root, 'sandbox'); mkdirSync(box);
      const outside = join(root, 'outside'); mkdirSync(outside);
      // Windows file links need Developer Mode or admin; a dangling junction needs neither.
      try { symlinkSync(join(outside, 'planted.txt'), join(box, 'fl'), 'file'); } catch { /* not allowed here */ }
      symlinkSync(join(outside, 'later'), join(box, 'dj'), process.platform === 'win32' ? 'junction' : 'dir');
      const r = await runWorker(writes([
        { path: 'fl', content: 'x' }, { path: 'dj/escape.txt', content: 'x' },
        { path: 'src/ok.mjs', content: 'export {}' }, { path: '.', content: 'x' }, { path: 'src', content: 'x' },
      ]), { instruction: 'write files', testCmd: 'node -e "0"' }, box);
      expect(r.filesWritten).toEqual(['src/ok.mjs']); // and nothing above threw
      expect(existsSync(join(outside, 'planted.txt'))).toBe(false);
      expect(existsSync(join(outside, 'later'))).toBe(false);
      const { builtinTools } = await import('../src/tools/builtins.js');
      const [write] = builtinTools(['write_file']);
      for (const path of ['fl', 'dj/escape.txt']) await write.handler({ path, content: 'x' }, { sandboxDir: box, interactive: true });
      expect(existsSync(join(outside, 'planted.txt'))).toBe(false);
      expect(existsSync(join(outside, 'later'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30_000);
});
