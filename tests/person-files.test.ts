/**
 * BL-71c: a run can READ the person's files from any chat or job, not only its own folder. Measured
 * 2026-10-22: a new chat knew the newsletter notes were in serve/web-l1fs27p and could not open them.
 * Writes stay in the run's own folder; dot-files and links out of the workspace stay closed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinTools } from '../src/tools/builtins.js';

let ws = '', outside = '';
const prev = { ws: process.env.MWA_WORKSPACE, cfg: process.env.MWA_CONFIG_PATH };
const [listFiles, readFile, writeFile, readDocument] = builtinTools(['list_files', 'read_file', 'write_file', 'read_document']);
const ctx = () => ({ sandboxDir: join(ws, 'serve', 'web-new'), interactive: true });

beforeAll(() => {
  ws = mkdtempSync(join(tmpdir(), 'mwa-71c-'));
  outside = mkdtempSync(join(tmpdir(), 'mwa-71c-out-'));
  process.env.MWA_WORKSPACE = ws;
  process.env.MWA_CONFIG_PATH = join(ws, 'none.json');
  mkdirSync(join(ws, 'serve', 'web-old'), { recursive: true });
  mkdirSync(join(ws, 'serve', 'web-new'), { recursive: true });
  mkdirSync(join(ws, 'scheduled', 'job-1'), { recursive: true });
  writeFileSync(join(ws, 'serve', 'web-old', 'ai-newsletter-research.md'), '# Research\nfive practical takeaways');
  writeFileSync(join(ws, 'scheduled', 'job-1', 'brief.md'), 'morning brief');
  writeFileSync(join(ws, '.shares.json'), '[{"token":"secret"}]');
  writeFileSync(join(outside, 'secret.txt'), 'not yours');
});
afterAll(() => {
  if (prev.ws === undefined) delete process.env.MWA_WORKSPACE; else process.env.MWA_WORKSPACE = prev.ws;
  if (prev.cfg === undefined) delete process.env.MWA_CONFIG_PATH; else process.env.MWA_CONFIG_PATH = prev.cfg;
  rmSync(ws, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true });
});

describe('BL-71c: the person\'s files from any chat', () => {
  it('reads another chat\'s file by its full path or its workspace path', async () => {
    const abs = join(ws, 'serve', 'web-old', 'ai-newsletter-research.md');
    expect(await readFile.handler({ path: abs }, ctx())).toContain('five practical takeaways');
    expect(await readFile.handler({ path: 'serve/web-old/ai-newsletter-research.md' }, ctx())).toContain('five practical takeaways');
    expect(await readDocument.handler({ source: abs }, ctx())).toContain('five practical takeaways');
  });

  it('finds files by name across every chat and job', async () => {
    const out = String(await listFiles.handler({ search: 'newsletter' }, ctx()));
    expect(out).toContain(join(ws, 'serve', 'web-old', 'ai-newsletter-research.md'));
    expect(out).not.toContain('brief.md');
    expect(String(await listFiles.handler({ search: '*' }, ctx()))).toContain('brief.md');
    expect(String(await listFiles.handler({ search: 'nothing-like-this' }, ctx()))).toMatch(/no files match/);
    expect(String(await listFiles.handler({ search: 'shares' }, ctx()))).toMatch(/no files match/); // dot-files stay hidden
  });

  it('lists another chat\'s folder', async () => {
    expect(String(await listFiles.handler({ dir: join(ws, 'serve', 'web-old') }, ctx()))).toContain('ai-newsletter-research.md');
  });

  it('never writes outside its own folder', async () => {
    const abs = join(ws, 'serve', 'web-old', 'ai-newsletter-research.md');
    expect(String(await writeFile.handler({ path: abs, content: 'overwritten' }, ctx()))).toMatch(/refused/);
    expect(await readFile.handler({ path: abs }, ctx())).toContain('five practical takeaways');
  });

  it('keeps MWA\'s own bookkeeping and anything outside the workspace closed', async () => {
    expect(String(await readFile.handler({ path: join(ws, '.shares.json') }, ctx()))).toMatch(/refused/);
    expect(String(await readFile.handler({ path: join(outside, 'secret.txt') }, ctx()))).toMatch(/refused/);
    expect(String(await readFile.handler({ path: '../../../' + 'x' }, ctx()))).not.toContain('not yours');
  });

  it('marks another chat\'s file as outside content, and not the run\'s own', async () => {
    writeFileSync(join(ws, 'serve', 'web-new', 'mine.md'), 'my own');
    expect(await readFile.handler({ path: join(ws, 'serve', 'web-old', 'ai-newsletter-research.md') }, ctx())).toMatch(/^\[from another chat or job of yours/);
    expect(await readFile.handler({ path: 'mine.md' }, ctx())).toBe('my own');
    expect(String(await listFiles.handler({ dir: join(ws, 'serve', 'web-old') }, ctx()))).toMatch(/^\[from another chat/);
  });

  it('keeps the inbox, outbox, the root and Telegram\'s chats out of reach (BL-71c review)', async () => {
    mkdirSync(join(ws, 'inbox'), { recursive: true }); writeFileSync(join(ws, 'inbox', 'task.md'), 'someone\'s task');
    mkdirSync(join(ws, 'outputs', 'tg-42'), { recursive: true }); writeFileSync(join(ws, 'outputs', 'tg-42', 'theirs.md'), 'another person');
    writeFileSync(join(ws, 'connector.log'), 'msg from 42: hello');
    for (const p of ['inbox/task.md', 'outputs/tg-42/theirs.md', 'connector.log']) {
      expect(String(await readFile.handler({ path: join(ws, p) }, ctx())), p).toMatch(/refused/);
    }
    expect(String(await listFiles.handler({ search: '*' }, ctx()))).not.toMatch(/task\.md|theirs\.md|connector\.log/);
    // a Telegram chat's run can't reach the web owner's files either
    const tg = { sandboxDir: join(ws, 'outputs', 'tg-42'), interactive: true };
    expect(String(await readFile.handler({ path: join(ws, 'serve', 'web-old', 'ai-newsletter-research.md') }, tg))).toMatch(/refused/);
    expect(String(await listFiles.handler({ search: 'newsletter' }, tg))).toMatch(/only for the owner/);
  });

  it('does not follow a link out of the workspace', async () => {
    const link = join(ws, 'serve', 'web-old', 'link.txt');
    try { symlinkSync(join(outside, 'secret.txt'), link); } catch { return; } // no symlink rights (Windows)
    expect(existsSync(link)).toBe(true);
    expect(String(await readFile.handler({ path: link }, ctx()))).not.toContain('not yours');
  });
});
