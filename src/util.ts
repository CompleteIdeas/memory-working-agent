import { spawnSync, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

/**
 * Extract a JSON object/array from model text that may include prose or
 * ```json fences. Returns the parsed value or throws.
 */
export function parseJsonLoose<T = any>(text: string): T {
  const s = text.trim();
  // 1) direct parse FIRST — clean JSON may legitimately contain ```fences```
  //    inside string values (e.g. a dispatch instruction with example code).
  //    Stripping fences before parsing corrupts that. Try the raw object first.
  try {
    return JSON.parse(s) as T;
  } catch {
    /* not bare JSON */
  }
  // 2) whole response wrapped in a fenced block
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim()) as T;
    } catch {
      /* fall through */
    }
  }
  // 3) grab the widest {...} or [...]
  const firstObj = s.indexOf('{');
  const firstArr = s.indexOf('[');
  let start = -1;
  let open = '{';
  let close = '}';
  if (firstObj === -1 && firstArr === -1) throw new Error('no JSON found in text');
  if (firstArr !== -1 && (firstObj === -1 || firstArr < firstObj)) {
    start = firstArr;
    open = '[';
    close = ']';
  } else {
    start = firstObj;
  }
  const end = s.lastIndexOf(close);
  if (end <= start) throw new Error('unbalanced JSON in text');
  return JSON.parse(s.slice(start, end + 1)) as T;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Like runCommand, but without blocking the process: an approved test run can take minutes, and
 *  spawnSync would freeze the web app (and Telegram's polling) for all of it (BL-14a review). Keeps the
 *  TAIL of long output — a test runner's failure summary comes last. */
export function runCommandAsync(cmd: string, cwd: string, timeoutMs = 60_000, env?: NodeJS.ProcessEnv): Promise<CommandResult> {
  try { mkdirSync(cwd, { recursive: true }); } catch { /* */ }
  return new Promise((resolveP) => {
    let out = '', err = '', done = false;
    const cap = (s: string) => s.slice(-64_000);
    let child: ReturnType<typeof spawn>;
    // Its own process group on POSIX, so a timeout can kill everything it started.
    try { child = spawn(cmd, { cwd, shell: true, detached: process.platform !== 'win32', ...(env ? { env } : {}) }); }
    catch (e) { resolveP({ code: 1, stdout: '', stderr: `command failed to start: ${(e as Error).message}` }); return; }
    // On timeout kill the WHOLE tree and return at once (BL-14a review: killing only the shell left the
    // real process holding the pipe open, so a hung test never returned). Exit code 124, like `timeout`.
    const killTree = () => {
      try {
        if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
        else if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch { try { child.kill('SIGKILL'); } catch { /* */ } }
    };
    const timer = setTimeout(() => { if (!done) { err += `\n[timed out after ${Math.round(timeoutMs / 1000)}s]`; killTree(); finish(124); } }, timeoutMs);
    child.stdout?.on('data', (d) => { out = cap(out + String(d)); });
    child.stderr?.on('data', (d) => { err = cap(err + String(d)); });
    const finish = (code: number) => { if (done) return; done = true; clearTimeout(timer); resolveP({ code, stdout: out.slice(-8000), stderr: err.slice(-8000) }); };
    child.on('error', (e) => { err += String(e.message); finish(1); });
    child.on('close', (code) => finish(typeof code === 'number' ? code : 1));
  });
}

/** Run a shell command in cwd with a timeout; capture output. Cross-platform. */
export function runCommand(cmd: string, cwd: string, timeoutMs = 60_000, env?: NodeJS.ProcessEnv): CommandResult {
  // Windows spawnSync throws ENOENT (naming the shell, e.g. cmd.exe) when cwd doesn't
  // exist — and the agent's working dir is created lazily. Ensure it exists first.
  try { mkdirSync(cwd, { recursive: true }); } catch { /* */ }
  let r;
  try {
    r = spawnSync(cmd, { cwd, shell: true, timeout: timeoutMs, encoding: 'utf8', ...(env ? { env } : {}) });
  } catch (e) {
    return { code: 1, stdout: '', stderr: `command failed to start: ${(e as Error).message}`.slice(-8000) };
  }
  return {
    code: typeof r.status === 'number' ? r.status : 1,
    stdout: (r.stdout ?? '').slice(-8000),
    stderr: (r.stderr ?? (r.error ? String(r.error.message) : '')).slice(-8000),
  };
}
