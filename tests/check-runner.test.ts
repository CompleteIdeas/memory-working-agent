/**
 * BL-14c — the sandboxed check runner. The person runs it; it is the only thing with Docker access. It
 * stages only what it should, runs only fixed commands in a container with no network and no secrets,
 * answers only to its token, and MWA's run_checks tool exists only when it is configured.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, linkSync, readdirSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { stageWorktree, listStaged, createRunner, dockerArgs, Tail, CHECKS, supervise, overlaps, skipped } from '../src/check-runner.js';
import { checkTools } from '../src/tools/checks.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { classifyTool, outputSource, isSensitive } from '../src/tools/governance.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
let repo = ''; let out = '';
const scratch: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); scratch.push(d); return d; };
const makeRepo = () => {
  const d = tmp('mwa-cr-repo-');
  git(d, 'init', '-q'); git(d, 'config', 'user.email', 't@t'); git(d, 'config', 'user.name', 't');
  writeFileSync(join(d, '.gitignore'), '.env\n');
  writeFileSync(join(d, 'package.json'), '{"scripts":{"test":"curl evil"}}');
  mkdirSync(join(d, 'src')); writeFileSync(join(d, 'src', 'a.ts'), 'export const a = 1;');
  git(d, 'add', '.'); git(d, 'commit', '-qm', 'init');
  writeFileSync(join(d, '.env'), 'SECRET=1');                 // ignored: never staged
  writeFileSync(join(d, 'src', 'new.ts'), 'export const b = 2;'); // new, not ignored: staged
  return d;
};
beforeEach(() => { repo = makeRepo(); out = tmp('mwa-cr-out-'); });
afterEach(() => { for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('staging a worktree', () => {
  it('copies tracked and new files, never ignored ones like .env, and skips the AWM submodule', () => {
    const blob = git(repo, 'hash-object', '-w', join(repo, 'src', 'a.ts'));
    git(repo, 'update-index', '--add', '--cacheinfo', `160000,${blob},vendor/agent-working-memory`); // a submodule link
    const r = stageWorktree(repo, out);
    expect(listStaged(out)).toEqual(['.gitignore', 'package.json', 'src/a.ts', 'src/new.ts']);
    expect(r.files).toBe(4);
  });

  it('never stages a node_modules (the toolchain is the image’s) or a .env, even one the worktree un-ignores', () => {
    writeFileSync(join(repo, '.gitignore'), '!.env\n');
    mkdirSync(join(repo, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', '.bin', 'tsc'), '#!/bin/sh\nexit 0\n');
    mkdirSync(join(repo, 'web', 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(repo, 'web', 'node_modules', 'x', 'index.js'), '');
    writeFileSync(join(repo, '.env.local'), 'K=1');
    writeFileSync(join(repo, '.env.example'), 'K=');
    stageWorktree(repo, out);
    expect(listStaged(out)).toEqual(['.env.example', '.gitignore', 'package.json', 'src/a.ts', 'src/new.ts']);
    expect([skipped('a/Node_Modules/b.js'), skipped('vendor/agent-working-memory/x'), skipped('src/.ENV'), skipped('src/env.ts')]).toEqual([true, true, true, false]);
  });

  it('refuses a tracked symbolic link, a hard link, and too much', () => {
    const r2 = makeRepo();
    const blob = git(r2, 'hash-object', '-w', join(r2, 'src', 'a.ts'));
    git(r2, 'update-index', '--add', '--cacheinfo', `120000,${blob},escape`);
    expect(() => stageWorktree(r2, tmp('x-'))).toThrow(/symbolic link/);
    linkSync(join(repo, 'src', 'a.ts'), join(repo, 'src', 'hard.ts'));
    expect(() => stageWorktree(repo, out)).toThrow(/hard link/);
    rmSync(join(repo, 'src', 'hard.ts'));
    expect(() => stageWorktree(repo, tmp('y-'), { maxFileBytes: 10, maxFiles: 100, maxTotalBytes: 1e9 })).toThrow(/larger than 10 bytes/);
    expect(() => stageWorktree(repo, tmp('z-'), { maxFileBytes: 1e6, maxFiles: 2, maxTotalBytes: 1e9 })).toThrow(/more than 2 files/);
  });

  it('refuses a tracked folder replaced by a link to somewhere else (a junction on Windows)', () => {
    const outside = tmp('mwa-cr-outside-');
    writeFileSync(join(outside, 'a.ts'), 'OUTSIDE-SECRET');
    rmSync(join(repo, 'src'), { recursive: true, force: true });
    symlinkSync(outside, join(repo, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => stageWorktree(repo, out)).toThrow(/linked folder|symbolic link/);
    expect(existsSync(join(out, 'src', 'a.ts'))).toBe(false);
  });

  it('git cannot be made to run a program while listing the files', () => {
    const flag = join(tmp('mwa-cr-flag-'), 'ran');
    // git runs core.fsmonitor as a shell command (sh, on Windows too) whenever it lists the worktree.
    git(repo, 'config', 'core.fsmonitor', `touch "${flag.split('\\').join('/')}"; false`);
    stageWorktree(repo, out);
    expect(existsSync(flag)).toBe(false);
  });
});

describe('the sandbox', () => {
  it('runs only the fixed commands, never npm run, in a container with no network and no privileges', () => {
    const a = dockerArgs('mwa-checks:abc', '/tmp/staged', 'test', 'mwa-check-1').join(' ');
    for (const flag of ['--network none', '--read-only', '--cap-drop ALL', 'no-new-privileges', '--user 1001:1001', '--pids-limit 512', '--memory 3g', '/tmp/staged:/src:ro'])
      expect(a).toContain(flag);
    expect(a).toContain(CHECKS.test);
    expect(a).toMatch(/find \/w -name node_modules -prune -exec rm -rf/); // before the image's toolchain is linked in
    expect(a).not.toMatch(/npm (run|test)/);
  });
  it('keeps only a tail of the output as it is read', () => {
    const t = new Tail(10);
    for (let i = 0; i < 1000; i++) t.push('xxxxxxxxxx');
    t.push('END');
    expect(t.toString()).toBe('xxxxxxxEND');
  });
  it('a check that won’t stop is answered anyway: timed out, the process killed', async () => {
    const child = spawn(process.execPath, ['-e', 'console.log("started"); setInterval(() => {}, 1000)']);
    let asked = false;
    const r = await supervise(child, 300, () => { asked = true; /* a docker kill that does nothing */ }, 300);
    expect(asked).toBe(true);
    expect([r.timedOut, r.exitCode]).toEqual([true, null]);
    expect(r.outputTail).toMatch(/started[\s\S]*did not stop/);
    expect(child.killed).toBe(true);
  });
  it('the worktree and the trusted checkout must be separate, either way round', () => {
    const outer = tmp('mwa-cr-outer-'); mkdirSync(join(outer, 'inner'));
    expect([overlaps(join(outer, 'inner'), outer), overlaps(outer, join(outer, 'inner')), overlaps(outer, outer), overlaps(outer, repo)]).toEqual([true, true, true, false]);
  });
});

describe('the runner API', () => {
  let server: Server; let url = ''; let work = '';
  const token = 'a'.repeat(48);
  let release: (() => void) | null = null; let hold = false;
  beforeEach(async () => {
    work = tmp('mwa-cr-work-');
    const runner = createRunner({ allow: [repo], image: 'unused', token, workRoot: work,
      exec: async ({ check }) => {
        if (hold) await new Promise<void>((r) => { release = r; });
        return { exitCode: check === 'test' ? 1 : 0, durationMs: 5, timedOut: false, outputTail: `${check} output` };
      } });
    server = createServer((req, res) => { void runner.handle(req, res); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(() => { server.close(); hold = false; release = null; });
  const auth = (t = token) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });
  const post = (body: unknown, t = token) => fetch(`${url}/checks`, { method: 'POST', headers: auth(t), body: JSON.stringify(body) });
  const result = async (id: string) => {
    for (let i = 0; i < 100; i++) {
      const r = await (await fetch(`${url}/runs/${id}`, { headers: auth() })).json();
      if (r.status !== 'running') return r;
      await new Promise((s) => setTimeout(s, 20));
    }
    throw new Error('never finished');
  };

  it('answers only to its token, and only for an allowed worktree id and known checks', async () => {
    expect((await post({ worktree: '1' }, 'wrong')).status).toBe(401);
    expect((await fetch(`${url}/runs/0123456789abcdef`, { headers: auth('wrong') })).status).toBe(401);
    expect((await post({ worktree: repo })).status).toBe(400);          // a path is not an id
    expect((await post({ worktree: '2' })).status).toBe(400);
    for (const bad of [['rm -rf /'], ['constructor'], ['__proto__'], ['toString'], []])
      expect([bad, (await post({ worktree: '1', checks: bad })).status]).toEqual([bad, 400]);
    const started = await post({ worktree: '1' });
    expect(started.status).toBe(202);
    const body = await result((await started.json()).run);
    expect(body.status).toBe('done');
    expect(body.results.map((r: { check: string; exitCode: number }) => [r.check, r.exitCode])).toEqual([['typecheck', 0], ['test', 1]]);
    expect(body.staged.files).toBe(4);
    expect(readdirSync(work)).toEqual([]); // the staged copy is gone
    expect((await fetch(`${url}/runs/ffffffffffffffff`, { headers: auth() })).status).toBe(404);
  });

  it('one run at a time, and the lock is freed when a run ends or is refused', async () => {
    hold = true;
    const first = await (await post({ worktree: '1', checks: ['typecheck'] })).json();
    expect((await post({ worktree: '1', checks: ['typecheck'] })).status).toBe(429);
    while (!release) await new Promise((s) => setTimeout(s, 10));
    release!(); hold = false;
    expect((await result(first.run)).status).toBe('done');
    linkSync(join(repo, 'src', 'a.ts'), join(repo, 'src', 'hard.ts'));
    const refused = await result((await (await post({ worktree: '1' })).json()).run);
    expect([refused.status, refused.error]).toEqual(['refused', expect.stringMatching(/hard link/)]);
    expect((await post({ worktree: '1', checks: ['typecheck'] })).status).toBe(202); // not stuck
  });

  it('MWA’s run_checks exists only when the runner is configured, waits for the result, and reads it as outside content', async () => {
    const saved = { u: process.env.MWA_CHECK_RUNNER_URL, t: process.env.MWA_CHECK_RUNNER_TOKEN, p: process.env.MWA_CHECK_RUNNER_POLL_MS };
    try {
      delete process.env.MWA_CHECK_RUNNER_URL; delete process.env.MWA_CHECK_RUNNER_TOKEN;
      expect(checkTools()).toEqual([]);
      process.env.MWA_CHECK_RUNNER_URL = url; process.env.MWA_CHECK_RUNNER_TOKEN = token;
      const reg = new ToolRegistry(); reg.registerAll(checkTools());
      const list = await reg.callDetailed('run_checks', {}, { sandboxDir: '.' });
      expect(list.text).toMatch(/1: .*mwa-cr-repo-/);
      const ran = await reg.callDetailed('run_checks', { worktree: '1' }, { sandboxDir: '.' });
      expect(ran.text).toMatch(/typecheck: PASSED[\s\S]*test: FAILED \(exit 1\)/);
      // Not an action on this machine (no tripwire, no "changed something"), but its output taints the run.
      expect([classifyTool('run_checks'), isSensitive('run_checks'), outputSource('run_checks')]).toEqual(['read', false, 'external']);
      expect((await reg.callDetailed('run_checks', { run: 'nope' }, { sandboxDir: '.' })).failed).toBe(true);
      process.env.MWA_CHECK_RUNNER_URL = 'http://127.0.0.1:1'; // the URL is read when the tool is built
      const gone = new ToolRegistry(); gone.registerAll(checkTools());
      expect((await gone.callDetailed('run_checks', { worktree: '1' }, { sandboxDir: '.' })).failed).toBe(true); // flagged, not text
    } finally {
      for (const [k, v] of [['MWA_CHECK_RUNNER_URL', saved.u], ['MWA_CHECK_RUNNER_TOKEN', saved.t], ['MWA_CHECK_RUNNER_POLL_MS', saved.p]] as const)
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }, 60_000);
});
