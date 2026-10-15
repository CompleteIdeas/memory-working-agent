/**
 * BL-14c — the sandboxed check runner. The person runs it; it is the only thing with Docker access. It
 * stages only what it should, runs only fixed commands in a container with no network and no secrets,
 * answers only to its token, and MWA's run_checks tool exists only when it is configured.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, linkSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { stageWorktree, listStaged, createRunner, dockerArgs, Tail, CHECKS } from '../src/check-runner.js';
import { checkTools } from '../src/tools/checks.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { classifyTool, outputSource } from '../src/tools/governance.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
let repo = ''; let out = '';
const makeRepo = () => {
  const d = mkdtempSync(join(tmpdir(), 'mwa-cr-repo-'));
  git(d, 'init', '-q'); git(d, 'config', 'user.email', 't@t'); git(d, 'config', 'user.name', 't');
  writeFileSync(join(d, '.gitignore'), '.env\n');
  writeFileSync(join(d, 'package.json'), '{"scripts":{"test":"curl evil"}}');
  mkdirSync(join(d, 'src')); writeFileSync(join(d, 'src', 'a.ts'), 'export const a = 1;');
  git(d, 'add', '.'); git(d, 'commit', '-qm', 'init');
  writeFileSync(join(d, '.env'), 'SECRET=1');                 // ignored: never staged
  writeFileSync(join(d, 'src', 'new.ts'), 'export const b = 2;'); // new, not ignored: staged
  return d;
};
beforeEach(() => { repo = makeRepo(); out = mkdtempSync(join(tmpdir(), 'mwa-cr-out-')); });
afterEach(() => { rmSync(repo, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); });

describe('staging a worktree', () => {
  it('copies tracked and new files, never ignored ones like .env, and skips the AWM submodule', () => {
    const blob = git(repo, 'hash-object', '-w', join(repo, 'src', 'a.ts'));
    git(repo, 'update-index', '--add', '--cacheinfo', `160000,${blob},vendor/agent-working-memory`); // a submodule link
    const r = stageWorktree(repo, out);
    expect(listStaged(out)).toEqual(['.gitignore', 'package.json', 'src/a.ts', 'src/new.ts']);
    expect(r.files).toBe(4);
  });
  it('refuses a tracked symbolic link, a hard link, and too much', () => {
    const r2 = makeRepo();
    try {
      const blob = git(r2, 'hash-object', '-w', join(r2, 'src', 'a.ts'));
      git(r2, 'update-index', '--add', '--cacheinfo', `120000,${blob},escape`);
      expect(() => stageWorktree(r2, mkdtempSync(join(tmpdir(), 'x-')))).toThrow(/symbolic link/);
    } finally { rmSync(r2, { recursive: true, force: true }); }
    linkSync(join(repo, 'src', 'a.ts'), join(repo, 'src', 'hard.ts'));
    expect(() => stageWorktree(repo, out)).toThrow(/hard link/);
    rmSync(join(repo, 'src', 'hard.ts'));
    expect(() => stageWorktree(repo, mkdtempSync(join(tmpdir(), 'y-')), { maxFileBytes: 10, maxFiles: 100, maxTotalBytes: 1e9 })).toThrow(/larger than 10 bytes/);
    expect(() => stageWorktree(repo, mkdtempSync(join(tmpdir(), 'z-')), { maxFileBytes: 1e6, maxFiles: 2, maxTotalBytes: 1e9 })).toThrow(/more than 2 files/);
  });
});

describe('the sandbox', () => {
  it('runs only the fixed commands, never npm run, in a container with no network and no privileges', () => {
    const a = dockerArgs('mwa-checks:abc', '/tmp/staged', 'test', 'mwa-check-1').join(' ');
    for (const flag of ['--network none', '--read-only', '--cap-drop ALL', 'no-new-privileges', '--user 1001:1001', '--pids-limit 512', '--memory 3g', '/tmp/staged:/src:ro'])
      expect(a).toContain(flag);
    expect(a).toContain(CHECKS.test);
    expect(a).not.toMatch(/npm (run|test)/);
  });
  it('keeps only a tail of the output as it is read', () => {
    const t = new Tail(10);
    for (let i = 0; i < 1000; i++) t.push('xxxxxxxxxx');
    t.push('END');
    expect(t.toString()).toBe('xxxxxxxEND');
  });
});

describe('the runner API', () => {
  let server: Server; let url = ''; let work = '';
  const token = 'a'.repeat(48);
  let gate: (() => void) | null = null;
  beforeEach(async () => {
    work = mkdtempSync(join(tmpdir(), 'mwa-cr-work-'));
    const runner = createRunner({ allow: [repo], image: 'unused', token, workRoot: work,
      exec: async ({ check }) => { if (gate) await new Promise<void>((r) => { gate = r; }); return { exitCode: check === 'test' ? 1 : 0, durationMs: 5, timedOut: false, outputTail: `${check} output` }; } });
    server = createServer((req, res) => { void runner.handle(req, res); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(() => { server.close(); rmSync(work, { recursive: true, force: true }); gate = null; });
  const post = (body: unknown, auth = token) => fetch(`${url}/checks`, { method: 'POST', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('answers only to its token, and only for an allowed worktree id and known checks', async () => {
    expect((await post({ worktree: '1' }, 'wrong')).status).toBe(401);
    expect((await post({ worktree: repo })).status).toBe(400);          // a path is not an id
    expect((await post({ worktree: '2' })).status).toBe(400);
    expect((await post({ worktree: '1', checks: ['rm -rf /'] })).status).toBe(400);
    const ok = await post({ worktree: '1' });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.results.map((r: { check: string; exitCode: number }) => [r.check, r.exitCode])).toEqual([['typecheck', 0], ['test', 1]]);
    expect(body.staged.files).toBe(4);
    expect(readdirSync(work)).toEqual([]); // the staged copy is gone
  });

  it('one run at a time', async () => {
    gate = () => {};
    const first = post({ worktree: '1', checks: ['typecheck'] });
    await new Promise((r) => setTimeout(r, 150));
    expect((await post({ worktree: '1', checks: ['typecheck'] })).status).toBe(429);
    gate!(); expect((await first).status).toBe(200);
  });

  it('MWA’s run_checks exists only when the runner is configured, and reads its results as outside content', async () => {
    const saved = { u: process.env.MWA_CHECK_RUNNER_URL, t: process.env.MWA_CHECK_RUNNER_TOKEN };
    try {
      delete process.env.MWA_CHECK_RUNNER_URL; delete process.env.MWA_CHECK_RUNNER_TOKEN;
      expect(checkTools()).toEqual([]);
      process.env.MWA_CHECK_RUNNER_URL = url; process.env.MWA_CHECK_RUNNER_TOKEN = token;
      const reg = new ToolRegistry(); reg.registerAll(checkTools());
      const list = await reg.callDetailed('run_checks', {}, { sandboxDir: '.' });
      expect(list.text).toMatch(/1: .*mwa-cr-repo-/);
      const ran = await reg.callDetailed('run_checks', { worktree: '1' }, { sandboxDir: '.' });
      expect(ran.text).toMatch(/typecheck: PASSED[\s\S]*test: FAILED \(exit 1\)/);
      expect([classifyTool('run_checks'), outputSource('run_checks')]).toEqual(['execute', 'external']);
      process.env.MWA_CHECK_RUNNER_URL = 'http://127.0.0.1:1'; // the URL is read when the tool is built
      const gone = new ToolRegistry(); gone.registerAll(checkTools());
      expect((await gone.callDetailed('run_checks', { worktree: '1' }, { sandboxDir: '.' })).failed).toBe(true); // flagged, not text
    } finally {
      if (saved.u === undefined) delete process.env.MWA_CHECK_RUNNER_URL; else process.env.MWA_CHECK_RUNNER_URL = saved.u;
      if (saved.t === undefined) delete process.env.MWA_CHECK_RUNNER_TOKEN; else process.env.MWA_CHECK_RUNNER_TOKEN = saved.t;
    }
  }, 30_000);
});
