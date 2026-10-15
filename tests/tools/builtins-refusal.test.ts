import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BUILTIN_TOOLS } from '../../src/tools/builtins.js';

/**
 * A refusal has to tell the model how to RECOVER (2026-10-14).
 *
 * A scheduled run asked to write a file "in the workspace" had all three of its tool calls refused,
 * then told the user "file-writing wasn't available in this run — please rerun with write access
 * enabled". It had write access the whole time, to its own folder. The old refusal named no folder
 * it could use, and its only advice — "grant its folder in settings" — means nothing to an
 * unattended run. And the first of the three "refusals" was read_file answering "does this exist
 * yet?" with an ENOENT error, which read as a failure and was counted as one.
 */
describe('file tool refusals point at the working folder', () => {
  let sandbox: string; let outside: string;
  beforeAll(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'mwa-refuse-sb-'));
    outside = mkdtempSync(join(tmpdir(), 'mwa-refuse-out-'));
  });
  afterAll(() => {
    for (const d of [sandbox, outside]) try { rmSync(d, { recursive: true, force: true }); } catch { /* */ }
  });

  const write = (path: string, interactive: boolean) =>
    BUILTIN_TOOLS.write_file.handler({ path, content: 'x' }, { sandboxDir: sandbox, interactive });

  it('names the working folder and a plain-name path that WILL work', async () => {
    const r = await write(join(outside, 'note-4.txt'), false);
    expect(r).toMatch(/^\(refused:/);              // still a refusal — the guard is unchanged
    expect(r).toContain(sandbox);                    // where it CAN write
    expect(r).toContain('"note-4.txt"');             // the exact recovery: the plain name
    expect(existsSync(join(outside, 'note-4.txt'))).toBe(false);
  });

  it('does not send an UNATTENDED run off to ask for settings', async () => {
    const r = await write(join(outside, 'a.txt'), false);
    expect(r).not.toMatch(/grant (it|its folder) in settings/i);
    expect(r).toMatch(/nobody is present/i);
  });

  it('still tells an INTERACTIVE run that a person can grant a folder', async () => {
    const r = await write(join(outside, 'b.txt'), true);
    expect(r).toMatch(/grant it in settings/i);
    expect(r).toContain(sandbox);
  });

  it('following the advice works: the plain name writes inside the working folder', async () => {
    const r = await write('note-4.txt', false);
    expect(r).toMatch(/^wrote note-4\.txt/);
    expect(readFileSync(resolve(sandbox, 'note-4.txt'), 'utf8')).toBe('x');
  });

  it('answers a not-yet-existing file as an answer, not an error', async () => {
    const r = await BUILTIN_TOOLS.read_file.handler({ path: 'not-there.txt' }, { sandboxDir: sandbox, interactive: false });
    expect(r).toMatch(/^\(no such file yet: not-there\.txt/);
    expect(r).toMatch(/write_file/);
    // The agent loop counts results matching this as REFUSALS; a not-found must not be one.
    expect(/^\((refused|could not read|could not write|unknown tool|tool .+ failed)/i.test(r)).toBe(false);
  });

  it('applies the same recovery text to list_files and read_file', async () => {
    const ctx = { sandboxDir: sandbox, interactive: false };
    const l = await BUILTIN_TOOLS.list_files.handler({ dir: outside }, ctx);
    const rd = await BUILTIN_TOOLS.read_file.handler({ path: join(outside, 'c.txt') }, ctx);
    for (const r of [l, rd]) { expect(r).toMatch(/^\(refused:/); expect(r).toContain(sandbox); }
  });
});
