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
import { dirname, basename, sep } from 'node:path';

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

/**
 * Whether the agent may write to `full` (an absolute path already inside an allowed root). Text
 * checks alone are bypassable on Windows (BL-14a review, verified): an 8.3 short name (`GIT~1`), an
 * NTFS stream (`.git::$INDEX_ALLOCATION`), a trailing dot or space, or a symlink all reach `.git`
 * without spelling it. So: refuse `:` after the drive, refuse segments ending in a dot or space, and
 * check the REAL path of the deepest part that already exists (realpath expands short names and
 * follows links). Returns a refusal reason, or null when the write may go ahead.
 */
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

export function writeRefusal(full: string): string | null {
  const rest = /^[A-Za-z]:/.test(full) ? full.slice(2) : full;
  if (rest.includes(':')) return 'that path names a file stream, not a file';
  if (full.split(/[\\/]/).some((seg) => seg.length > 0 && /[. ]$/.test(seg) && seg !== '.' && seg !== '..')) return 'a path segment ends in a dot or a space';
  if (inGitControlPath(full)) return 'never write inside a .git or git-hooks folder — files there run as code on the next git command';
  try {
    let probe = full;
    for (;;) {
      if (existsSync(probe)) { if (inGitControlPath(realpathSync.native(probe))) return 'that path leads into a .git or git-hooks folder — files there run as code on the next git command'; break; }
      const up = dirname(probe);
      if (up === probe) break;
      probe = up;
    }
  } catch { return 'that path could not be checked'; }
  return null;
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
