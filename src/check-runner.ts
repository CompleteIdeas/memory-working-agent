/**
 * The sandboxed check runner (BL-14c; Robert chose option B in BL-14).
 *
 * Approving a check run used to mean running the code MWA wrote, as you — your files, your network,
 * and a `.env` one directory away (docs/self-build.md). This runner lets checks run without that tap,
 * because the code runs somewhere it can't reach any of it:
 *
 * - YOU start the runner (`mwa check-runner --allow <worktree>`). It is the only thing with Docker access;
 *   MWA talks to it over a token-protected API on 127.0.0.1 and never sees the Docker socket.
 * - The API does one thing: run `typecheck` and/or `test` on one of the worktrees you allowed, named by
 *   its id — no paths, no commands, no image choice. One run at a time.
 * - The commands are fixed here (`tsc --noEmit`, `vitest run`), never `npm run …`: MWA writes the
 *   worktree's package.json, so its scripts are MWA's to choose. The tests still run MWA's code — that is
 *   what a check is — but only inside the sandbox.
 * - The image is built from YOUR trusted checkout (Dockerfile.checks), never from the worktree, so MWA
 *   can't change the dependencies or the toolchain.
 * - Only the worktree's tracked files and new untracked ones are staged — never ignored ones like `.env` —
 *   with symlinks, hardlinks and special files refused, submodules skipped (the image has AWM), and caps
 *   on file size, file count and total size.
 * - The container: no network, read-only root, a size-capped tmpfs to work in, every capability dropped,
 *   no new privileges, an unprivileged user, memory / CPU / process / open-file limits, and a wall-clock
 *   limit enforced by killing the container (which takes its whole process tree).
 * - Output is capped as it is read, and what comes back is outside content to MWA (fenced; it taints the run).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, copyFileSync, rmSync, readdirSync, realpathSync, readFileSync, existsSync } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

export type CheckName = 'typecheck' | 'test';
export const CHECKS: Record<CheckName, string> = {
  typecheck: 'node_modules/.bin/tsc --noEmit',
  test: "node_modules/.bin/vitest run --exclude 'vendor/**' --no-file-parallelism",
};

export interface StageLimits { maxFileBytes: number; maxFiles: number; maxTotalBytes: number }
export const DEFAULT_LIMITS: StageLimits = { maxFileBytes: 5_000_000, maxFiles: 20_000, maxTotalBytes: 200_000_000 };
/** Never staged: the AWM submodule (the image carries the pinned build) and anything git ignores. */
const SKIP_PREFIXES = ['vendor/agent-working-memory/', '.git/'];

/**
 * Copy a worktree's tracked files and its new, not-ignored files into `dest`. Throws on anything that
 * could reach outside the tree or carry something other than plain files.
 */
export function stageWorktree(src: string, dest: string, limits: StageLimits = DEFAULT_LIMITS): { files: number; bytes: number } {
  const git = (...a: string[]) => execFileSync('git', ['-C', src, ...a], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
  // Tracked entries WITH their modes: 160000 = a submodule link (skipped), 120000 = a symlink (refused).
  const tracked = git('ls-files', '-z', '--cached', '-s').split('\0').filter(Boolean).map((l) => {
    const tab = l.indexOf('\t');
    return { mode: l.slice(0, 6), path: l.slice(tab + 1) };
  });
  const untracked = git('ls-files', '-z', '--others', '--exclude-standard').split('\0').filter(Boolean).map((path) => ({ mode: '', path }));
  const seen = new Set<string>();
  let files = 0, bytes = 0;
  for (const { mode, path } of [...tracked, ...untracked]) {
    if (seen.has(path)) continue;
    seen.add(path);
    if (mode === '160000' || SKIP_PREFIXES.some((p) => path === p.slice(0, -1) || path.startsWith(p))) continue;
    if (mode === '120000') throw new Error(`refused: ${path} is a symbolic link`);
    if (path.split('/').some((seg) => seg === '..' || seg === '')) throw new Error(`refused: unusual path ${path}`);
    const from = join(src, path);
    let st;
    try { st = lstatSync(from); } catch { continue; } // deleted in the working tree
    if (st.isSymbolicLink()) throw new Error(`refused: ${path} is a symbolic link`);
    if (!st.isFile()) throw new Error(`refused: ${path} is not a regular file`);
    if (st.nlink > 1) throw new Error(`refused: ${path} is a hard link`);
    if (st.size > limits.maxFileBytes) throw new Error(`refused: ${path} is larger than ${limits.maxFileBytes} bytes`);
    files++; bytes += st.size;
    if (files > limits.maxFiles) throw new Error(`refused: more than ${limits.maxFiles} files`);
    if (bytes > limits.maxTotalBytes) throw new Error(`refused: more than ${limits.maxTotalBytes} bytes in all`);
    const to = join(dest, path);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
  return { files, bytes };
}

export interface CheckResult { check: CheckName; exitCode: number | null; durationMs: number; timedOut: boolean; outputTail: string }

/** A fixed-size tail of a stream, kept as it is read — output can't grow the runner's memory. */
export class Tail {
  private buf = '';
  constructor(private readonly max = 4000) {}
  push(chunk: string): void { this.buf = (this.buf + chunk).slice(-this.max); }
  toString(): string { return this.buf; }
}

export interface RunnerOptions {
  /** The worktrees checks may run on, by id (their order, from 1). */
  allow: string[];
  image: string;
  timeoutMs?: number;
  /** Where staged copies live; cleaned at start. */
  workRoot?: string;
  /** For tests: replaces `docker run`. */
  exec?: (args: { stagedDir: string; check: CheckName; timeoutMs: number }) => Promise<Omit<CheckResult, 'check'>>;
}

/** `docker run` with the sandbox's limits. The container's name lets a timeout kill exactly it. */
export function dockerArgs(image: string, stagedDir: string, check: CheckName, name: string): string[] {
  const cmd = `cp -r /src/. /w/ && ln -s /base/node_modules /w/node_modules && mkdir -p /w/vendor && rm -rf /w/vendor/agent-working-memory && ln -s /base/vendor/agent-working-memory /w/vendor/agent-working-memory && cd /w && ${CHECKS[check]}`;
  return [
    'run', '--rm', '--name', name, '--label', 'mwa-check=1',
    '--network', 'none', '--read-only',
    '--tmpfs', '/w:rw,size=1g,exec', '--tmpfs', '/tmp:rw,size=512m,exec', '--tmpfs', '/home/checker:rw,size=64m',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--user', '1001:1001',
    '--memory', '3g', '--memory-swap', '3g', '--cpus', '2', '--pids-limit', '512',
    '--ulimit', 'nofile=4096:4096', '--ulimit', 'fsize=536870912',
    '-e', 'CI=1', '-e', 'MWA_FAST_CHAT=0', '-e', 'HOME=/home/checker',
    '-v', `${stagedDir}:/src:ro`,
    image, 'sh', '-c', cmd,
  ];
}

function dockerExec(image: string): NonNullable<RunnerOptions['exec']> {
  return ({ stagedDir, check, timeoutMs }) => new Promise((done) => {
    const name = `mwa-check-${randomBytes(6).toString('hex')}`;
    const started = Date.now(); const tail = new Tail();
    const child = spawn('docker', dockerArgs(image, stagedDir, check, name), { windowsHide: true });
    child.stdout.on('data', (d) => tail.push(String(d)));
    child.stderr.on('data', (d) => tail.push(String(d)));
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { execFileSync('docker', ['kill', name], { stdio: 'ignore' }); } catch { /* */ } }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); done({ exitCode: timedOut ? null : code, durationMs: Date.now() - started, timedOut, outputTail: tail.toString() }); });
    child.on('error', (e) => { clearTimeout(timer); done({ exitCode: null, durationMs: Date.now() - started, timedOut: false, outputTail: `could not start docker: ${e.message}` }); });
  });
}

/** The runner's request handler, separate from the socket so it can be tested. */
export function createRunner(opts: RunnerOptions & { token: string }) {
  const allow = opts.allow.map((p) => realpathSync.native(resolve(p)));
  const workRoot = opts.workRoot ?? join(tmpdir(), 'mwa-check-runner');
  rmSync(workRoot, { recursive: true, force: true }); // leftovers from a crashed run
  mkdirSync(workRoot, { recursive: true });
  const exec = opts.exec ?? dockerExec(opts.image);
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  const expected = Buffer.from(opts.token);
  let busy = false;

  const authorized = (req: IncomingMessage) => {
    const got = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer /i, ''));
    return got.length === expected.length && timingSafeEqual(got, expected);
  };
  const reply = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!authorized(req)) return reply(res, 401, { error: 'unauthorized' });
    if (req.method === 'GET' && req.url === '/worktrees') return reply(res, 200, { worktrees: allow.map((p, i) => ({ id: String(i + 1), path: p })) });
    if (req.method !== 'POST' || req.url !== '/checks') return reply(res, 404, { error: 'not found' });
    let body: { worktree?: unknown; checks?: unknown } = {};
    try {
      let raw = '';
      for await (const c of req) { raw += c; if (raw.length > 10_000) return reply(res, 413, { error: 'request too large' }); }
      body = JSON.parse(raw || '{}');
    } catch { return reply(res, 400, { error: 'not JSON' }); }
    const idx = Number(body.worktree) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= allow.length) return reply(res, 400, { error: 'worktree must be one of the allowed ids', allowed: allow.map((_, i) => String(i + 1)) });
    const checks = (Array.isArray(body.checks) ? body.checks : ['typecheck', 'test']).map(String);
    if (!checks.length || checks.some((c) => !(c in CHECKS))) return reply(res, 400, { error: 'checks must be typecheck and/or test' });
    if (busy) return reply(res, 429, { error: 'a check run is already in progress — try again when it finishes' });
    busy = true;
    const staged = join(workRoot, randomBytes(8).toString('hex'));
    try {
      mkdirSync(staged, { recursive: true });
      let stagedInfo: { files: number; bytes: number };
      try { stagedInfo = stageWorktree(allow[idx], staged); }
      catch (e) { return reply(res, 422, { error: (e as Error).message }); }
      const results: CheckResult[] = [];
      for (const check of [...new Set(checks)] as CheckName[]) results.push({ check, ...(await exec({ stagedDir: staged, check, timeoutMs })) });
      return reply(res, 200, { worktree: String(idx + 1), staged: stagedInfo, results });
    } finally {
      busy = false;
      rmSync(staged, { recursive: true, force: true });
    }
  }
  return { handle, allow, workRoot };
}

/** The image is named by what it was built from, so a changed lockfile or AWM pin builds a new one. */
export function imageTag(from: string): string {
  const h = createHash('sha256');
  for (const f of ['package-lock.json', 'package.json', 'Dockerfile.checks']) { const p = join(from, f); if (existsSync(p)) h.update(readFileSync(p)); }
  try { h.update(execFileSync('git', ['-C', from, 'rev-parse', 'HEAD:vendor/agent-working-memory'], { encoding: 'utf8' })); } catch { /* */ }
  return `mwa-checks:${h.digest('hex').slice(0, 12)}`;
}

/** `mwa check-runner`: build the image from the trusted checkout, then serve on loopback. */
export async function startCheckRunner(o: { allow: string[]; from: string; listen?: string; log?: (m: string) => void }): Promise<void> {
  const log = o.log ?? ((m: string) => console.log(m));
  if (!o.allow.length) throw new Error('give at least one worktree: --allow <path>[,<path>…]');
  const from = realpathSync.native(resolve(o.from));
  for (const a of o.allow) if ((realpathSync.native(resolve(a)) + sep).startsWith(from + sep) || from === realpathSync.native(resolve(a))) throw new Error('a worktree MWA edits must not be (or be inside) the trusted checkout the image is built from');
  const image = imageTag(from);
  const have = (() => { try { execFileSync('docker', ['image', 'inspect', image], { stdio: 'ignore' }); return true; } catch { return false; } })();
  if (!have) {
    log(`building the check image ${image} from ${from} (once per lockfile / AWM pin)…`);
    execFileSync('docker', ['build', '-f', join(from, 'Dockerfile.checks'), '-t', image, from], { stdio: 'inherit' });
  }
  // Containers a crashed runner left behind.
  try { const ids = execFileSync('docker', ['ps', '-aq', '--filter', 'label=mwa-check=1'], { encoding: 'utf8' }).split(/\s+/).filter(Boolean); if (ids.length) execFileSync('docker', ['rm', '-f', ...ids], { stdio: 'ignore' }); } catch { /* */ }
  const token = randomBytes(24).toString('hex');
  const runner = createRunner({ allow: o.allow, image, token });
  const [host, portStr] = (o.listen ?? '127.0.0.1:7799').split(':');
  if (host !== '127.0.0.1' && host !== 'localhost') log(`⚠ listening on ${host}: anything that can reach this address and has the token can ask for check runs.`);
  const server = createServer((req, res) => { runner.handle(req, res).catch((e) => { try { res.writeHead(500); res.end(JSON.stringify({ error: (e as Error).message })); } catch { /* */ } }); });
  await new Promise<void>((r) => server.listen(Number(portStr || 7799), host, r));
  log(`check runner on http://${host}:${portStr || 7799} — image ${image}`);
  runner.allow.forEach((p, i) => log(`  worktree ${i + 1}: ${p}`));
  log('Give MWA these two settings (a fresh token each start):');
  log(`  MWA_CHECK_RUNNER_URL=http://${host === '0.0.0.0' ? '<this host>' : host}:${portStr || 7799}`);
  log(`  MWA_CHECK_RUNNER_TOKEN=${token}`);
}

/** For tests and `mwa check-runner --list`: the stage step alone. */
export function listStaged(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel = '') => { for (const f of readdirSync(d, { withFileTypes: true })) { const r = rel ? `${rel}/${f.name}` : f.name; if (f.isDirectory()) walk(join(d, f.name), r); else out.push(r); } };
  walk(dir);
  return out.sort();
}
