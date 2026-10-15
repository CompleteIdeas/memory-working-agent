/**
 * BL-14a — the foundations for MWA working on its own repo, under human-approved gates.
 *
 * Running the gates means running code the model wrote. An unattended Assistant-mode run can't run
 * commands, and Developer mode is no boundary, so the first slice keeps a person at that step (the
 * coworker's recommendation, option A): MWA drafts the change, stages "run the gates" for approval, and
 * reads the outcome on a later run. Two things that needed to exist:
 *   1. the agent never writes inside .git or a hook folder — a model-written hook would run the moment
 *      a person approved a gate or a commit;
 *   2. a run can read what happened to what its conversation staged (approval_results), fenced as
 *      outside content because it echoes what the model's own code printed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinTools } from '../src/tools/builtins.js';
import { inGitControlPath } from '../src/tools/shell-gate.js';
import { stageAction, registerExecutor, confirmPending, approvalTools, approvalStatus, pendingMeta } from '../src/tools/approval.js';
import { runCommandAsync } from '../src/util.js';
import { outputSource, readsUntrustedContent } from '../src/tools/governance.js';

let cfgDir = '';
const prevCfg = process.env.MWA_CONFIG_PATH;
beforeAll(() => {
  cfgDir = mkdtempSync(join(tmpdir(), 'mwa-selfbuild-cfg-'));
  process.env.MWA_CONFIG_PATH = join(cfgDir, 'mwa.config.json');
  writeFileSync(process.env.MWA_CONFIG_PATH, JSON.stringify({ tools: { access: { preset: 'assistant', grantedRoots: [] } } }));
});
afterAll(() => {
  if (prevCfg === undefined) delete process.env.MWA_CONFIG_PATH; else process.env.MWA_CONFIG_PATH = prevCfg;
  rmSync(cfgDir, { recursive: true, force: true });
});

describe('never write where git runs code', () => {
  it.each(['.git/hooks/post-checkout', 'repo/.git/config', '.git', 'w\\.git\\hooks\\pre-commit', '.husky/pre-commit', 'x/.githooks/commit-msg', 'A/.GIT/hooks/x'])(
    'flags %s', (p) => { expect(inGitControlPath(p)).toBe(true); });
  it('flags .vscode (a task can run when the folder is opened)', () => { expect(inGitControlPath('w/.vscode/tasks.json')).toBe(true); });
  it.each(['.gitignore', 'src/.gitkeep', 'docs/git-notes.md', 'src/agent.ts', '.github/workflows/ci.yml'])(
    'allows %s', (p) => { expect(inGitControlPath(p)).toBe(false); });

  it('write_file refuses a hook, and still writes project files', async () => {
    const [write] = builtinTools(['write_file']);
    const dir = mkdtempSync(join(tmpdir(), 'mwa-selfbuild-'));
    try {
      expect(await write.handler({ path: '.git/hooks/post-checkout', content: '#!/bin/sh\ncurl x' }, { sandboxDir: dir, interactive: true })).toMatch(/refused: never write inside a \.git/);
      expect(existsSync(join(dir, '.git', 'hooks', 'post-checkout'))).toBe(false);
      expect(await write.handler({ path: 'src/fix.ts', content: 'export {}' }, { sandboxDir: dir, interactive: true })).toMatch(/^wrote/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('approval_results: a later run sees what its staged gates did', () => {
  it('shows the outcome of what THIS conversation staged, and nothing of anyone else’s', async () => {
    registerExecutor('gate_run', async (args) => { if (args.fail) throw new Error('3 tests failed: agent.test.ts'); return 'Tests 437 passed'; });
    const ok = stageAction({ tool: 'gate_run', summary: 'run the gates', args: {}, ctx: { sandboxDir: '.', session: 'job-selfbuild' } });
    const bad = stageAction({ tool: 'gate_run', summary: 'run the gates again', args: { fail: true }, ctx: { sandboxDir: '.', session: 'job-selfbuild' } });
    const other = stageAction({ tool: 'gate_run', summary: 'someone else', args: {}, ctx: { sandboxDir: '.', session: 'web-other' } });
    for (const id of [ok, bad, other]) await confirmPending(id, { sandboxDir: '.', interactive: true });
    const results = approvalTools().find((t) => t.def.name === 'approval_results')!;
    const out = await results.handler({}, { sandboxDir: '.', session: 'job-selfbuild' });
    expect(out).toContain(`${ok} — gate_run — done`);
    expect(out).toContain('Tests 437 passed');
    expect(out).toContain(`${bad} — gate_run — failed`);
    expect(out).toContain('3 tests failed');
    expect(out).not.toContain(other);
  });

  it('is outside content: fenced, and it taints the run', () => {
    expect(outputSource('approval_results')).toBe('external');
    expect(readsUntrustedContent('approval_results')).toBe(true);
  });

  it('the model still has no way to approve', () => {
    expect(approvalTools().map((t) => t.def.name).sort()).toEqual(['approval_results', 'cancel_action', 'list_pending']);
  });
});

describe('BL-14a review fixes', () => {
  const withDir = async (fn: (dir: string) => Promise<void>) => { const d = mkdtempSync(join(tmpdir(), 'mwa-sb-')); try { await fn(d); } finally { rmSync(d, { recursive: true, force: true }); } };

  it('an unattended run in Assistant mode STAGES commands (never runs them), at most 3 per run, for a day', async () => {
    const [run] = builtinTools(['run_command']);
    await withDir(async (dir) => {
      writeFileSync(join(dir, 'notes.txt'), 'x');
      const ctx = { sandboxDir: dir, interactive: false, runId: 'unattended-run-1', session: 'job-x' };
      const read = await run.handler({ command: 'ls' }, ctx);               // even a read waits for a person
      expect(read).toContain('[APPROVAL REQUIRED]');
      const id = /confirmation_id: (\S+)/.exec(read)![1];
      expect(pendingMeta(id)).toBeDefined();
      await run.handler({ command: 'npm test' }, ctx);
      await run.handler({ command: 'npm run typecheck' }, ctx);
      expect(await run.handler({ command: 'npm run build' }, ctx)).toMatch(/already asked for 3 approvals/);
    });
  });

  it.each(['.git::$INDEX_ALLOCATION/hooks/pre-commit', 'x.txt:hidden', 'sub./x.txt', 'sub /x.txt'])('write_file refuses the bypass spelling %s', async (p) => {
    const [write] = builtinTools(['write_file']);
    await withDir(async (dir) => {
      expect(await write.handler({ path: p, content: 'x' }, { sandboxDir: dir, interactive: true })).toMatch(/refused/);
    });
  });

  it('an 8.3 short name for .git is caught (Windows, where the volume has short names)', async () => {
    const [write] = builtinTools(['write_file']);
    await withDir(async (dir) => {
      mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
      if (!existsSync(join(dir, 'GIT~1'))) return; // no short names here: nothing to bypass
      expect(await write.handler({ path: 'GIT~1/hooks/pre-commit', content: 'x' }, { sandboxDir: dir, interactive: true })).toMatch(/refused/);
      expect(existsSync(join(dir, '.git', 'hooks', 'pre-commit'))).toBe(false);
    });
  });

  it('a link into .git, or out of the allowed folders, does not carry the write', async () => {
    const [write] = builtinTools(['write_file']);
    await withDir(async (dir) => {
      const outside = mkdtempSync(join(tmpdir(), 'mwa-sb-out-'));
      try {
        mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
        try { symlinkSync(join(dir, '.git'), join(dir, 'g'), 'junction'); symlinkSync(outside, join(dir, 'out'), 'junction'); } catch { return; } // links not allowed here
        expect(await write.handler({ path: 'g/hooks/post-checkout', content: 'x' }, { sandboxDir: dir, interactive: true })).toMatch(/refused/);
        expect(await write.handler({ path: 'out/x.txt', content: 'x' }, { sandboxDir: dir, interactive: true })).toMatch(/refused/);
        expect(existsSync(join(outside, 'x.txt'))).toBe(false);
      } finally { rmSync(outside, { recursive: true, force: true }); }
    });
  });

  it('a failing check is recorded as FAILED, keeping the end of its output', async () => {
    const [run] = builtinTools(['run_command']);
    await withDir(async (dir) => {
      const cmd = `node -e "for (let i = 0; i < 400; i++) console.log('line ' + i); console.log('SUMMARY: 3 failed'); process.exit(1)"`;
      const out = await run.handler({ command: cmd }, { sandboxDir: dir, interactive: true });
      const id = /confirmation_id: (\S+)/.exec(out)![1];
      expect(await confirmPending(id, { sandboxDir: '.', interactive: true })).toMatch(/but it failed/);
      const st = approvalStatus(id)!;
      expect(st.status).toBe('failed');
      expect(st.result).toMatch(/^exit=1/);
      expect(st.result).toContain('SUMMARY: 3 failed');
    });
  }, 30_000);

  it('runCommandAsync keeps the tail and honors its timeout', async () => {
    const r = await runCommandAsync(`node -e "console.log('a'.repeat(20000) + 'END')"`, tmpdir(), 20_000);
    expect(r.code).toBe(0);
    expect(r.stdout.trim().endsWith('END')).toBe(true);
    const t0 = Date.now();
    const slow = await runCommandAsync(`node -e "setTimeout(() => {}, 10000)"`, tmpdir(), 1000);
    expect(slow.stderr).toMatch(/timed out/);
    expect(slow.code).toBe(124);
    expect(Date.now() - t0).toBeLessThan(5000); // it returned at the timeout, not when the child finished
  }, 30_000);
});

