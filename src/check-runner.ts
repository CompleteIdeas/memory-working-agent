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
 *   its id — no paths, no commands, no image choice. One run at a time. A request starts a run and
 *   returns its id; the result is read with a second request, so a long suite can't time out the caller.
 * - The commands are fixed here (`tsc --noEmit`, `vitest run`), never `npm run …`: MWA writes the
 *   worktree's package.json, so its scripts are MWA's to choose. The tests still run MWA's code — that is
 *   what a check is — but only inside the sandbox.
 * - The image is built from YOUR trusted checkout (Dockerfile.checks), never from the worktree, and the
 *   worktree can't bring its own `node_modules`, so MWA can't change the dependencies or the toolchain.
 * - Only the worktree's tracked files and new untracked ones are staged — never ignored ones, never a
 *   `.env`, never a `node_modules` — and only files that really live inside the worktree: a symlink, a
 *   hard link, a linked folder (a junction) or a special file stops the run. Submodules are skipped (the
 *   image has AWM). File size, file count and total size are capped.
 * - The container: no network, read-only root, a size-capped tmpfs to work in, every capability dropped,
 *   no new privileges, an unprivileged user, memory / CPU / process / open-file limits, and a wall-clock
 *   limit enforced by killing the container (which takes its whole process tree).
 * - Output is capped as it is read, and what comes back is outside content to MWA (fenced; it taints the run).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn, execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { lstatSync, mkdirSync, rmSync, readdirSync, realpathSync, readFileSync, readSync, writeFileSync, existsSync, openSync, fstatSync, closeSync, constants } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname, join, resolve, relative, sep, basename } from 'node:path';
import { tmpdir } from 'node:os';

export type CheckName = 'typecheck' | 'test';
export const CHECKS: Record<CheckName, string> = {
  typecheck: 'node_modules/.bin/tsc --noEmit',
  test: "node_modules/.bin/vitest run --exclude 'vendor/**' --no-file-parallelism",
};
const isCheck = (c: string): c is CheckName => Object.hasOwn(CHECKS, c);

export interface StageLimits { maxFileBytes: number; maxFiles: number; maxTotalBytes: number }
export const DEFAULT_LIMITS: StageLimits = { maxFileBytes: 5_000_000, maxFiles: 20_000, maxTotalBytes: 200_000_000 };

/** Never staged: the AWM submodule (the image carries the pinned build), any `node_modules` (the image's
 *  are the toolchain), git's own folder, and `.env` files (`.env.example` is documentation). */
export function skipped(path: string): boolean {
  if (path === 'vendor/agent-working-memory' || path.startsWith('vendor/agent-working-memory/')) return true;
  const segs = path.split('/');
  if (segs.some((s) => s.toLowerCase() === 'node_modules' || s.toLowerCase() === '.git')) return true;
  const base = basename(path).toLowerCase();
  return (base === '.env' || base.startsWith('.env.')) && base !== '.env.example';
}

/** At most `max + 1` bytes of an open file: a file that grows after it was inspected can't grow the copy. */
export function readCapped(fd: number, max: number): Buffer {
  const buf = Buffer.alloc(max + 1); let n = 0;
  for (;;) { const r = readSync(fd, buf, n, buf.length - n, null); if (r === 0) break; n += r; if (n === buf.length) break; }
  return buf.subarray(0, n);
}

export const unusualPath = (path: string) => path.split('/').some((seg) => seg === '..' || seg === '' || seg === '.' || /[. ]$/.test(seg) || seg.includes(':'));

const sameFold = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * Copy a worktree's tracked files and its new, not-ignored files into `dest`. Throws on anything that
 * could reach outside the tree or carry something other than plain files.
 */
export function stageWorktree(src: string, dest: string, limits: StageLimits = DEFAULT_LIMITS): { files: number; bytes: number } {
  const root = realpathSync.native(resolve(src));
  // git reads the worktree's config; these two settings could make `ls-files` run a program.
  const git = (...a: string[]) => execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', root, ...a],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 120_000 }).toString('utf8');
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
    if (mode === '160000' || skipped(path)) continue;
    if (mode === '120000') throw new Error(`refused: ${path} is a symbolic link`);
    // Windows drops a trailing dot or space from a name, and a colon names a hidden stream: any of them
    // could make a name look different from what it opens (`node_modules ` is `node_modules`).
    if (unusualPath(path)) throw new Error(`refused: unusual path ${path}`);
    const from = join(root, path);
    let st;
    try { st = lstatSync(from, { bigint: true }); } catch { continue; } // deleted in the working tree
    if (st.isSymbolicLink()) throw new Error(`refused: ${path} is a symbolic link`);
    if (!st.isFile()) throw new Error(`refused: ${path} is not a regular file`);
    if (st.nlink > 1n) throw new Error(`refused: ${path} is a hard link`);
    // A linked folder anywhere on the way (a junction on Windows, a symlinked directory elsewhere) makes
    // the file's real location differ from where git thinks it is.
    let real: string;
    try { real = realpathSync.native(from); } catch { continue; }
    if (!sameFold(relative(root, real).split(sep).join('/'), path)) throw new Error(`refused: ${path} is reached through a linked folder`);
    if (st.size > BigInt(limits.maxFileBytes)) throw new Error(`refused: ${path} is larger than ${limits.maxFileBytes} bytes`);
    files++;
    if (files > limits.maxFiles) throw new Error(`refused: more than ${limits.maxFiles} files`);
    // Read through a handle and check it is still the file that was inspected: a swap between the
    // check and the copy (a file replaced by a link) is caught instead of followed.
    const fd = openSync(from, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const now = fstatSync(fd, { bigint: true });
      if (!now.isFile() || now.ino !== st.ino || now.dev !== st.dev) throw new Error(`refused: ${path} changed while it was being staged`);
      const data = readCapped(fd, limits.maxFileBytes);
      if (data.length > limits.maxFileBytes) throw new Error(`refused: ${path} is larger than ${limits.maxFileBytes} bytes`);
      bytes += data.length;
      if (bytes > limits.maxTotalBytes) throw new Error(`refused: more than ${limits.maxTotalBytes} bytes in all`);
      const to = join(dest, path);
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, data);
    } finally { closeSync(fd); }
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
  /** For tests: replaces staging. */
  stage?: typeof stageWorktree;
  /** For tests: replaces `docker run`. */
  exec?: (args: { stagedDir: string; check: CheckName; timeoutMs: number }) => Promise<Omit<CheckResult, 'check'>>;
}

/** `docker run` with the sandbox's limits. The container's name lets a timeout kill exactly it. */
export function dockerArgs(image: string, stagedDir: string, check: CheckName, name: string): string[] {
  const cmd = 'cp -r /src/. /w/ && find /w -name node_modules -prune -exec rm -rf {} + ; ' +
    'ln -s /base/node_modules /w/node_modules && mkdir -p /w/vendor && rm -rf /w/vendor/agent-working-memory && ' +
    `ln -s /base/vendor/agent-working-memory /w/vendor/agent-working-memory && cd /w && ${CHECKS[check]}`;
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

/**
 * Wait for a check's process with a wall-clock limit. At the limit `onTimeout` stops it (for Docker,
 * `docker kill` on the container); if that doesn't end it within `graceMs`, the local process is killed
 * and the run is answered anyway — a hung `docker` can't hold the runner's one-run lock forever.
 */
export function supervise(child: ChildProcess, timeoutMs: number, onTimeout: () => void, graceMs = 60_000): Promise<Omit<CheckResult, 'check'>> {
  return new Promise((done) => {
    const started = Date.now(); const tail = new Tail();
    let timedOut = false; let finished = false;
    const finish = (exitCode: number | null, extra = '') => {
      if (finished) return; finished = true;
      clearTimeout(soft); clearTimeout(hard);
      done({ exitCode: timedOut ? null : exitCode, durationMs: Date.now() - started, timedOut, outputTail: tail.toString() + extra });
    };
    child.stdout?.on('data', (d) => tail.push(String(d)));
    child.stderr?.on('data', (d) => tail.push(String(d)));
    const soft = setTimeout(() => { timedOut = true; try { onTimeout(); } catch { /* */ } }, timeoutMs);
    const hard = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* */ } finish(null, '\n(the check did not stop when it was killed)'); }, timeoutMs + graceMs);
    child.on('close', (code) => finish(code));
    child.on('error', (e) => finish(null, `could not start: ${e.message}`));
  });
}

function dockerExec(image: string): NonNullable<RunnerOptions['exec']> {
  return ({ stagedDir, check, timeoutMs }) => {
    const name = `mwa-check-${randomBytes(6).toString('hex')}`;
    const child = spawn('docker', dockerArgs(image, stagedDir, check, name), { windowsHide: true });
    // Asynchronous, so the runner keeps answering while Docker is slow.
    const docker = (...a: string[]) => new Promise<void>((r) => { execFile('docker', a, { timeout: 30_000, windowsHide: true }, () => r()); });
    return supervise(child, timeoutMs, () => { void docker('kill', name); })
      .finally(() => docker('rm', '-f', name));
  };
}

export interface RunRecord {
  id: string; worktree: string; status: 'running' | 'done' | 'refused';
  startedAt: number; staged?: { files: number; bytes: number }; results?: CheckResult[]; error?: string;
}
const KEEP_RUNS = 20;

/** The runner's request handler, separate from the socket so it can be tested. */
export function createRunner(opts: RunnerOptions & { token: string }) {
  const allow = opts.allow.map((p) => realpathSync.native(resolve(p)));
  const workRoot = opts.workRoot ?? join(tmpdir(), 'mwa-check-runner');
  rmSync(workRoot, { recursive: true, force: true }); // leftovers from a crashed run
  mkdirSync(workRoot, { recursive: true });
  const exec = opts.exec ?? dockerExec(opts.image);
  const stage = opts.stage ?? stageWorktree;
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  const expected = Buffer.from(opts.token);
  const runs = new Map<string, RunRecord>();
  let busy = false;

  const authorized = (req: IncomingMessage) => {
    const got = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer /i, ''));
    return got.length === expected.length && timingSafeEqual(got, expected);
  };
  const reply = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

  async function perform(run: RunRecord, src: string, checks: CheckName[]): Promise<void> {
    const staged = join(workRoot, run.id);
    try {
      mkdirSync(staged, { recursive: true });
      try { run.staged = stage(src, staged); }
      catch (e) { run.status = 'refused'; run.error = (e as Error).message; return; }
      run.results = [];
      for (const check of checks) run.results.push({ check, ...(await exec({ stagedDir: staged, check, timeoutMs })) });
      run.status = 'done';
    } catch (e) {
      run.status = 'refused'; run.error = `the run failed: ${(e as Error).message}`;
    } finally {
      busy = false;
      try { rmSync(staged, { recursive: true, force: true }); } catch { /* the next start cleans the work folder */ }
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!authorized(req)) return reply(res, 401, { error: 'unauthorized' });
    if (req.method === 'GET' && req.url === '/worktrees') return reply(res, 200, { worktrees: allow.map((p, i) => ({ id: String(i + 1), path: p })) });
    const m = req.method === 'GET' ? /^\/runs\/([0-9a-f]{16})$/.exec(req.url ?? '') : null;
    if (m) { const r = runs.get(m[1]); return r ? reply(res, 200, r) : reply(res, 404, { error: 'no such run (the runner keeps the last 20, and forgets them when it restarts)' }); }
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
    if (!checks.length || !checks.every(isCheck)) return reply(res, 400, { error: 'checks must be typecheck and/or test' });
    if (busy) return reply(res, 429, { error: 'a check run is already in progress — try again when it finishes' });
    busy = true;
    const run: RunRecord = { id: randomBytes(8).toString('hex'), worktree: String(idx + 1), status: 'running', startedAt: Date.now() };
    runs.set(run.id, run);
    for (const k of [...runs.keys()].slice(0, Math.max(0, runs.size - KEEP_RUNS))) runs.delete(k);
    // Answer first: staging a big worktree takes seconds and blocks this process while it runs, and a
    // caller that times out before it has the run id can't read the result.
    reply(res, 202, { run: run.id });
    setImmediate(() => { perform(run, allow[idx], [...new Set(checks)] as CheckName[]).catch(() => { busy = false; }); });
  }
  return { handle, allow, workRoot, runs };
}

/** A worktree MWA edits and the checkout the image is built from must not contain one another. */
export function overlaps(a: string, b: string): boolean {
  const norm = (p: string) => { const r = realpathSync.native(resolve(p)); return process.platform === 'win32' ? r.toLowerCase() : r; };
  const x = norm(a), y = norm(b);
  return x === y || x.startsWith(y + sep) || y.startsWith(x + sep);
}

/**
 * The image is named by what it was built from, so a changed lockfile, manifest, Dockerfile, model
 * prewarm or AWM pin builds a new one. Refuses a checkout whose AWM is not the committed pin: the
 * image would quietly test a different AWM from the one MWA ships with.
 */
export function imageTag(from: string): string {
  const pin = execFileSync('git', ['-C', from, 'rev-parse', 'HEAD:vendor/agent-working-memory'], { encoding: 'utf8' }).trim();
  const awm = join(from, 'vendor', 'agent-working-memory');
  const head = execFileSync('git', ['-C', awm, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['-C', awm, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
  if (head !== pin || dirty) throw new Error(`the trusted checkout's AWM is ${head !== pin ? `at ${head.slice(0, 7)}, not the pinned ${pin.slice(0, 7)}` : 'changed from its pin'} — run \`git submodule update --init\` there, or use a clean checkout for --from`);
  const h = createHash('sha256').update(pin);
  for (const f of ['package-lock.json', 'package.json', 'web/package.json', 'Dockerfile.checks', 'scripts/prewarm.ts']) { const p = join(from, f); if (existsSync(p)) h.update(f).update(readFileSync(p)); }
  return `mwa-checks:${h.digest('hex').slice(0, 12)}`;
}

/** `mwa check-runner`: build the image from the trusted checkout, then serve on loopback. */
export async function startCheckRunner(o: { allow: string[]; from: string; listen?: string; log?: (m: string) => void }): Promise<void> {
  const log = o.log ?? ((m: string) => console.log(m));
  if (!o.allow.length) throw new Error('give at least one worktree: --allow <path>[,<path>…]');
  for (const a of o.allow) if (overlaps(a, o.from)) throw new Error(`${a} and --from ${o.from} overlap: a worktree MWA edits must be separate from the trusted checkout the image is built from`);
  const from = realpathSync.native(resolve(o.from));
  const image = imageTag(from);
  const have = (() => { try { execFileSync('docker', ['image', 'inspect', image], { stdio: 'ignore' }); return true; } catch { return false; } })();
  if (!have) {
    log(`building the check image ${image} from ${from} (once per lockfile / AWM pin)…`);
    execFileSync('docker', ['build', '-f', join(from, 'Dockerfile.checks'), '-t', image, from], { stdio: 'inherit' });
  }
  // Take the port FIRST: a second runner started by mistake stops here, before it can wipe the work
  // folder or remove the containers of the runner already serving.
  const [host, portStr] = (o.listen ?? '127.0.0.1:7799').split(':');
  if (host !== '127.0.0.1' && host !== 'localhost') log(`⚠ listening on ${host}: anything that can reach this address and has the token can ask for check runs.`);
  let runner: ReturnType<typeof createRunner> | null = null;
  const server = createServer((req, res) => {
    if (!runner) { res.writeHead(503); res.end(JSON.stringify({ error: 'starting' })); return; }
    runner.handle(req, res).catch((e) => { try { res.writeHead(500); res.end(JSON.stringify({ error: (e as Error).message })); } catch { /* */ } });
  });
  await new Promise<void>((ok, fail) => {
    server.once('error', (e: NodeJS.ErrnoException) => fail(e.code === 'EADDRINUSE' ? new Error(`port ${portStr || 7799} on ${host} is in use — is a check runner already running? Stop it first, or pass --listen with another port.`) : e));
    server.listen(Number(portStr || 7799), host, () => ok());
  });
  // Containers a crashed runner left behind.
  try { const ids = execFileSync('docker', ['ps', '-aq', '--filter', 'label=mwa-check=1'], { encoding: 'utf8' }).split(/\s+/).filter(Boolean); if (ids.length) execFileSync('docker', ['rm', '-f', ...ids], { stdio: 'ignore' }); } catch { /* */ }
  const token = randomBytes(24).toString('hex');
  runner = createRunner({ allow: o.allow, image, token });
  log(`check runner on http://${host}:${portStr || 7799} — image ${image}`);
  runner.allow.forEach((p, i) => log(`  worktree ${i + 1}: ${p}`));
  log('Give MWA these two settings (a fresh token each start):');
  log(`  MWA_CHECK_RUNNER_URL=http://${host === '0.0.0.0' ? '<this host>' : host}:${portStr || 7799}`);
  log(`  MWA_CHECK_RUNNER_TOKEN=${token}`);
}

/** For tests: the files a stage step produced. */
export function listStaged(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel = '') => { for (const f of readdirSync(d, { withFileTypes: true })) { const r = rel ? `${rel}/${f.name}` : f.name; if (f.isDirectory()) walk(join(d, f.name), r); else out.push(r); } };
  walk(dir);
  return out.sort();
}
