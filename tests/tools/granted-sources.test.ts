/**
 * F07 (usability review 2026-10-24): the file tools allowed the person's granted folders all along, but a run was never
 * told they existed — the instruction named only the chat's folder and `list_files` with no `dir` listed only it — so
 * "In my files, what is the dock repair quote?" got "I couldn't find any files" with the files one folder away.
 * Now the run's prompt names the granted folders, and list_files / search_files with no `dir` cover them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { BUILTIN_TOOLS } from '../../src/tools/builtins.js';
import { grantedFolders, sourcesLine } from '../../src/tools/access.js';

describe('granted folders reach the run', () => {
  let sandbox: string; let granted: string; let cfgDir: string; const prevCfg = process.env.MWA_CONFIG_PATH;
  const setConfig = (preset: string, roots: string[]) => writeFileSync(process.env.MWA_CONFIG_PATH!, JSON.stringify({ tools: { access: { preset, grantedRoots: roots } } }));
  beforeAll(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'mwa-granted-sb-'));
    granted = mkdtempSync(join(tmpdir(), 'mwa-granted-docs-'));
    cfgDir = mkdtempSync(join(tmpdir(), 'mwa-granted-cfg-'));
    process.env.MWA_CONFIG_PATH = join(cfgDir, 'mwa.config.json');
    mkdirSync(join(sandbox, 'docs'));
    writeFileSync(join(sandbox, 'docs', 'brief.md'), 'the chat\'s own brief\n');
    writeFileSync(join(granted, 'meeting-notes-oct.txt'), 'Harbour Works dock repair quote: $4,200. Decide by 1 November 2026.\n');
    writeFileSync(join(granted, 'budget-2026.csv'), 'category,spent,budget\nfacilities,7420,8000\n');
    mkdirSync(join(granted, '.hidden')); writeFileSync(join(granted, '.hidden', 'x.txt'), 'dock');
    setConfig('assistant', [granted]);
  });
  afterAll(() => {
    if (prevCfg === undefined) delete process.env.MWA_CONFIG_PATH; else process.env.MWA_CONFIG_PATH = prevCfg;
    for (const d of [sandbox, granted, cfgDir]) try { rmSync(d, { recursive: true, force: true }); } catch { /* */ }
  });
  const ctx = () => ({ sandboxDir: sandbox, interactive: true });

  it('grantedFolders resolves the roots with a file count; locked-down grants nothing; the sandbox itself is left out', () => {
    const roots = grantedFolders(sandbox);
    expect(roots).toEqual([{ path: resolve(granted), files: 2, capped: false, readable: true }]);
    setConfig('assistant', [granted, sandbox, join(sandbox, 'docs')]);
    expect(grantedFolders(sandbox).map((r) => r.path)).toEqual([resolve(granted)]);
    setConfig('locked-down', [granted]);
    expect(grantedFolders(sandbox)).toEqual([]);
    setConfig('assistant', [granted]);
  });

  it('the prompt line names each granted folder and the tools that cover them; it is empty with none granted', () => {
    const line = sourcesLine(sandbox);
    expect(line).toContain(`${resolve(granted)} (2 files)`);
    expect(line).toMatch(/list_files and search_files cover all of them/);
    setConfig('assistant', []);
    expect(sourcesLine(sandbox)).toBe('');
    setConfig('assistant', [granted]);
  });

  it('list_files with no dir lists the working folder and the granted folder under their own headings', async () => {
    const r = await BUILTIN_TOOLS.list_files.handler({}, ctx());
    expect(r).toContain(`== your working folder (${sandbox}) ==\ndocs/brief.md`);
    expect(r).toContain(`== the person's folder ${resolve(granted)}`);
    expect(r).toContain('meeting-notes-oct.txt');
    expect(r).toContain('budget-2026.csv');
    expect(r).not.toContain('.hidden');
  });

  it('list_files with a dir lists that folder only, as before', async () => {
    expect(await BUILTIN_TOOLS.list_files.handler({ dir: 'docs' }, ctx())).toBe('brief.md');
    expect(await BUILTIN_TOOLS.list_files.handler({ dir: granted }, ctx())).toBe('budget-2026.csv\nmeeting-notes-oct.txt');
  });

  it('search_files with no dir finds a line in the granted folder, printed with a full path that read_file opens', async () => {
    const r = await BUILTIN_TOOLS.search_files.handler({ query: 'dock repair quote' }, ctx());
    expect(r).toMatch(/^1 file match;/);
    const hit = `${resolve(granted)}${sep}meeting-notes-oct.txt:1:`;
    expect(r).toContain(hit);
    const text = await BUILTIN_TOOLS.read_file.handler({ path: `${resolve(granted)}${sep}meeting-notes-oct.txt` }, ctx());
    expect(text).toContain('$4,200');
    // the working folder is searched too, with relative paths as before
    expect(await BUILTIN_TOOLS.search_files.handler({ query: 'own brief' }, ctx())).toContain('docs/brief.md:1:');
  });

  it('search_files with a dir searches that folder only', async () => {
    expect(await BUILTIN_TOOLS.search_files.handler({ query: 'dock', dir: 'docs' }, ctx())).toMatch(/^\(nothing in 1 files matches/);
  });

  it('locked-down: the working folder only, and no prompt line', async () => {
    setConfig('locked-down', [granted]);
    expect(await BUILTIN_TOOLS.list_files.handler({}, ctx())).toBe('docs/brief.md');
    expect(await BUILTIN_TOOLS.search_files.handler({ query: 'dock' }, ctx())).toMatch(/^\(nothing in 1 files/);
    expect(sourcesLine(sandbox)).toBe('');
    setConfig('assistant', [granted]);
  });
});
