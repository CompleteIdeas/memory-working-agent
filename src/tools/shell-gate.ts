/**
 * Shell-command gate (BL-04, folded into BL-03). In Assistant mode a person is watching an
 * interactive chat, but that is not the same as approving every command the model runs: measured by
 * BL-03's isolated review, a chat could background `curl` against MWA's own approvals endpoint and
 * approve the action it had just staged. The gate splits commands in two:
 *
 *   read-only  — a small allowlist of commands that only READ, with no shell features at all and
 *                every path argument inside the folders this run may access. These run directly.
 *   everything else — staged for the person's approval, like any other write.
 *
 * Conservative on purpose: anything the parser is unsure of needs approval, which costs a click.
 * Developer mode skips the gate (the model has your shell there, and the docs say so).
 *
 * Deliberately NOT on the list: git (a repo's .git/config, which write_file can create, makes
 * `git status` and `git diff` run arbitrary commands via core.fsmonitor or a diff driver), any
 * interpreter (node, python, sh), package managers, and network tools.
 */

import { existsSync, realpathSync } from 'node:fs';
import { dirname, basename, sep, resolve, isAbsolute, join } from 'node:path';
import { execFileSync } from 'node:child_process';

export type ShellVerdict = { kind: 'read-only' } | { kind: 'needs-approval'; reason: string };

/** Shell metacharacters: banned everywhere, inside quotes too — on Windows cmd.exe single quotes
 *  are not quotes, so "quoted" text could still chain a second command. Backslash is a path
 *  separator on Windows and an escape on POSIX. Globs (* ?) only expand to file names: allowed. */
const META_POSIX = /[;&|<>`$(){}!#%^\\\r\n]/;
const META_WIN = /[;&|<>`$(){}!#%^\r\n]/;

/** command → flags that make it write, execute, or reach outside (exact or `--flag=` prefix). */
const READ_ONLY: Record<string, { deny?: string[]; noArgs?: boolean; textArgs?: boolean }> = {
  ls: {}, dir: {}, cat: {}, type: {}, head: {}, tail: {}, wc: {}, pwd: {}, whoami: {}, uname: {},
  which: {}, where: {}, stat: {}, du: {}, df: {}, cut: {}, diff: {},
  echo: { textArgs: true },
  date: { noArgs: true },
  grep: {},
  rg: { deny: ['--pre', '--pre-glob'] },
  find: { deny: ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'] },
  sort: { deny: ['-o', '--output', '--compress-program', '-T', '--temporary-directory'] },
  tree: { deny: ['-o'] },
};

/** Split into tokens; quotes only group words. Returns null when the text isn't simple. */
function tokenize(cmd: string): string[] | null {
  const out: string[] = [];
  const re = /\s*(?:'([^']*)'|"([^"]*)"|([^\s'"]+))/y;
  let i = 0;
  while (i < cmd.length) {
    if (/^\s+$/.test(cmd.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(cmd);
    if (!m || m[0].length === 0) return null;
    out.push(m[1] ?? m[2] ?? m[3]);
    i = re.lastIndex;
  }
  return out;
}

/** True when an argument names a file or folder rather than plain text (a bare name like
 *  `notes.txt` resolves inside the working folder, which is always allowed). */
function looksLikePath(a: string): boolean {
  return /[\\/:]/.test(a) || a.startsWith('.') || a.startsWith('~');
}

export function classifyCommand(cmd: string, pathAllowed: (p: string) => boolean, platform: NodeJS.Platform = process.platform): ShellVerdict {
  const text = cmd.trim();
  if (!text) return { kind: 'needs-approval', reason: 'empty command' };
  const meta = platform === 'win32' ? META_WIN : META_POSIX;
  if (meta.test(text)) return { kind: 'needs-approval', reason: 'it uses shell features (chaining, pipes, redirection, substitution or variables)' };
  const toks = tokenize(text);
  if (!toks || !toks.length) return { kind: 'needs-approval', reason: 'it could not be read as a simple command' };
  const name = toks[0].toLowerCase().replace(/\.exe$/, '');
  const rule = READ_ONLY[name];
  if (!rule || /[\\/]/.test(toks[0])) return { kind: 'needs-approval', reason: `"${toks[0]}" is not on the read-only list` };
  const args = toks.slice(1);
  if (rule.noArgs && args.length) return { kind: 'needs-approval', reason: `"${name}" with arguments can change things` };
  for (const a of args) {
    const denied = (rule.deny ?? []).some((d) => {
      if (d.startsWith('--')) return a === d || a.startsWith(`${d}=`);
      // a one-letter flag also hides in a cluster (`sort -ro out`) or with its value attached (`-oout`)
      if (d.length === 2) return /^-[A-Za-z0-9]+$/.test(a) ? a.slice(1).includes(d[1]) : a.startsWith(d) && !a.startsWith('--');
      return a === d;
    });
    if (denied) return { kind: 'needs-approval', reason: `"${name} ${a.split('=')[0]}" can write or run something` };
    if (rule.textArgs) continue;
    const value = a.startsWith('-') ? (a.includes('=') ? a.slice(a.indexOf('=') + 1) : '') : a;
    if (value && looksLikePath(value) && !pathAllowed(value)) {
      return { kind: 'needs-approval', reason: `it reads outside the folders this assistant may access (${value.slice(0, 60)})` };
    }
  }
  return { kind: 'read-only' };
}

/** True when a path lands inside a git folder or a hook folder. Anything written there runs as code on
 *  the person's next git command — a hook — so the agent never writes there (BL-14a: working on a real
 *  repo, a model-written `.git/hooks/post-checkout` would run the moment a person approves a gate). */
export function inGitControlPath(p: string): boolean {
  // .vscode too: a task set to run on folder open runs when the person opens the folder (BL-14a review).
  return /(^|[\\/])(\.git|\.husky|\.githooks|\.vscode)([\\/]|$)/i.test(p);
}

/** Why a path would run as the person later, outside MWA, or null (BL-28): a login Startup folder, a
 *  shell profile or a file one loads, or Windows Terminal's settings (which name the command a new tab
 *  starts). Shell profiles are refused by name at any depth, the way `.git` is: the home folder isn't
 *  always the one a shell reads (Git Bash, WSL, a redirected Documents), and a project rarely holds a
 *  real `.bashrc`. A PowerShell profile only inside a PowerShell folder, since `profile.ps1` is also a
 *  plausible profiling script. Case-insensitive, as on Windows the file system is. */
export function runsLaterReason(p: string): string | null {
  const name = basename(p);
  if (/(^|[\\/])start menu[\\/]programs[\\/]startup([\\/]|$)/i.test(p) || /(^|[\\/])\.config[\\/]autostart([\\/]|$)/i.test(p)
    || /^\.(xprofile|xsessionrc|xinitrc)$/i.test(name)) {
    return 'that runs at login — anything written there runs as you the next time you sign in';
  }
  if (/^\.(bashrc|bash_profile|bash_login|bash_logout|bash_aliases|profile|zshrc|zshenv|zprofile|zlogin|zlogout|kshrc|cshrc|tcshrc|login|logout)$/i.test(name)
    || /(^|[\\/])(\.bashrc\.d|\.zshrc\.d|\.oh-my-zsh[\\/]custom)[\\/]/i.test(p)
    || (/^(microsoft\.[\w.]+_)?profile\.ps1$/i.test(name) && /(^|[\\/])(windows)?powershell[\\/]/i.test(p))
    || /(^|[\\/])fish[\\/](config\.fish$|conf\.d[\\/]|functions[\\/])/i.test(p)
    || /(^|[\\/])nushell[\\/](config|env|login)\.nu$/i.test(p)) {
    return 'that is a shell profile, or a file one loads — it runs as you the next time you open a terminal';
  }
  if (/(^|[\\/])(microsoft\.windowsterminal[^\\/]*[\\/]localstate|microsoft[\\/]windows terminal)[\\/]settings\.json$/i.test(p)) {
    return 'that is Windows Terminal\'s settings file — it names the command each new terminal runs';
  }
  return null;
}

/** The real path of the deepest part of `full` that already exists (short names expanded, links
 *  followed), with the not-yet-existing remainder appended. */
export function realPathOf(full: string): string {
  let probe = full; const rest: string[] = [];
  for (;;) {
    if (existsSync(probe)) return [realpathSync.native(probe), ...rest.reverse()].join(sep);
    const up = dirname(probe);
    if (up === probe) return full;
    rest.push(basename(probe)); probe = up;
  }
}

/**
 * Whether the agent may write to `full` (an absolute path already inside an allowed root). Text
 * checks alone are bypassable on Windows (BL-14a review, verified): an 8.3 short name (`GIT~1`), an
 * NTFS stream (`.git::$INDEX_ALLOCATION`), a trailing dot or space, or a symlink all reach `.git`
 * without spelling it. So: refuse `:` after the drive, refuse segments ending in a dot or space, and
 * check the REAL path too (realpath expands short names and follows links). Returns a refusal
 * reason, or null when the write may go ahead.
 */
export function writeRefusal(full: string): string | null {
  const rest = /^[A-Za-z]:/.test(full) ? full.slice(2) : full;
  if (rest.includes(':')) return 'that path names a file stream, not a file';
  if (full.split(/[\\/]/).some((seg) => seg.length > 0 && /[. ]$/.test(seg) && seg !== '.' && seg !== '..')) return 'a path segment ends in a dot or a space';
  let real: string;
  try { real = realPathOf(full); } catch { return 'that path could not be checked'; }
  for (const p of [full, real]) {
    if (inGitControlPath(p)) return 'never write inside a .git or git-hooks folder — files there run as code on the next git command';
    const later = runsLaterReason(p);
    if (later) return later;
  }
  if (onPath(dirname(full))) return 'that folder is on your PATH — a file written there would run in place of a program of the same name, in your own terminals too';
  return null;
}

/**
 * Whether a folder is one the person's own PATH lists (BL-27). Programs are looked up directly in those
 * folders, so a `pnpm.cmd` written into `AppData\Roaming\npm` or `~/.local/bin` would replace the real
 * one everywhere — for MWA's commands and in the person's terminals.
 *
 * Both sides are compared as real paths, resolving the part of the path that exists: a PATH folder that
 * doesn't exist yet can otherwise be reached through a short name (`CARGO~1\bin`) or a junction above it
 * (BL-27 review: two write_file calls planted `.cargo\bin\cargo.cmd`, a missing folder on this
 * machine's PATH). Case-insensitive on Windows.
 */
export function onPath(dir: string, env?: NodeJS.ProcessEnv): boolean {
  const win = process.platform === 'win32';
  const norm = (p: string) => {
    // One odd entry (an unreadable share, a bad name) compares as written rather than failing the write.
    let r: string;
    try { r = realPathOf(resolve(p)); } catch { r = resolve(p); }
    r = r.replace(/[\\/]+$/, '');
    return win ? r.toLowerCase() : r;
  };
  const target = norm(dir);
  return pathEntries(env).some((e) => norm(e) === target);
}

/** The absolute folders on PATH: this process's, and on Windows also the person's live user and machine
 *  PATH from the registry (MWA's own copy is from when it started, and a service gets the machine one). */
function pathEntries(env?: NodeJS.ProcessEnv): string[] {
  const win = process.platform === 'win32';
  const e = env ?? process.env;
  const raw = [String(e.PATH ?? e.Path ?? '')];
  if (win && !env) raw.push(...registryPaths());
  const expand = (s: string) => (win ? s.replace(/%([^%]+)%/g, (m, k: string) => {
    const hit = Object.keys(e).find((x) => x.toLowerCase() === k.toLowerCase());
    return hit ? String(e[hit]) : m;
  }) : s);
  return raw.join(win ? ';' : ':').split(win ? ';' : ':').map((x) => expand(x.trim().replace(/^"(.*)"$/, '$1'))).filter((x) => isAbsolute(x) && !/%/.test(x));
}

let regCache: { at: number; paths: string[] } | null = null;
function registryPaths(): string[] {
  if (regCache && Date.now() - regCache.at < 60_000) return regCache.paths;
  const paths: string[] = [];
  for (const key of ['HKCU\\Environment', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment']) {
    try {
      // By full path: a bare `reg` is searched for, and Node on Windows looks in the current folder first.
      const out = execFileSync(join(String(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows'), 'System32', 'reg.exe'), ['query', key, '/v', 'Path'], { encoding: 'utf8', timeout: 5_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const m = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im.exec(out);
      if (m) paths.push(m[1].trim());
    } catch { /* not set, or no reg: the process PATH still applies */ }
  }
  regCache = { at: Date.now(), paths };
  return paths;
}

/** The environment a model-run command gets: enough to find programs and a temp folder, none of
 *  MWA's secrets (API keys, the access password, the Telegram bot token). */
const ENV_KEEP = [
  'PATH', 'Path', 'PATHEXT', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USER', 'USERNAME', 'LOGNAME',
  'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'ComSpec', 'COMSPEC', 'SystemDrive', 'TEMP', 'TMP', 'TMPDIR',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'SHELL', 'TZ', 'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramData',
  'ProgramFiles(x86)', 'CommonProgramFiles', 'NUMBER_OF_PROCESSORS', 'OS', 'PROCESSOR_ARCHITECTURE',
];
export function scrubbedEnv(src: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of ENV_KEEP) if (src[k] !== undefined) out[k] = src[k];
  // A program a command names is found on PATH, never in the folder it runs in: the model writes
  // there, so a planted npm.cmd or git.bat would run instead of the real one when a person approves
  // `npm test` (BL-26, found by BL-24's review). cmd.exe searches the current folder first unless told
  // not to; a POSIX shell does only through a `.` or empty PATH entry. A script named with its folder
  // (`.\build.bat`, `./build.sh`) still runs.
  if (platform === 'win32') out.NoDefaultCurrentDirectoryInExePath = '1';
  const sep = platform === 'win32' ? ';' : ':';
  for (const k of ['PATH', 'Path']) {
    if (out[k] === undefined) continue;
    // Only absolute entries: a relative one (`.`, empty, `bin`) is looked up from the current folder.
    out[k] = String(out[k]).split(sep).filter((d) => {
      const e = d.trim().replace(/^"(.*)"$/, '$1');
      return platform === 'win32' ? /^([A-Za-z]:[\\/]|[\\/]{2})/.test(e) : e.startsWith('/');
    }).join(sep);
  }
  return out;
}
