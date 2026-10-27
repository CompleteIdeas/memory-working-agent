// v2 build, P1 (review fix 6): the Docker entrypoint's `tailscale serve` and MWA_PUBLIC_URL. Runs the real
// docker-entrypoint.sh under sh with stub `tailscale`/`tailscaled` and a stub `node` for the final `exec node … serve`
// (it prints the environment MWA would start with). /data is pointed at a temp folder.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SH = spawnSync('sh', ['-c', 'echo ok'], { encoding: 'utf8' }).stdout?.trim() === 'ok';
const ENTRY = readFileSync(new URL('../docker-entrypoint.sh', import.meta.url), 'utf8');

function run(o: { serveOk: boolean; env?: Record<string, string>; envFile?: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'mwa-entry-')).replace(/\\/g, '/');
  const data = `${dir}/data`;
  const bin = `${dir}/bin`;
  spawnSync('sh', ['-c', `mkdir -p "${data}" "${bin}"`]);
  const stub = (name: string, body: string) => { const p = join(bin, name); writeFileSync(p, `#!/bin/sh\n${body}\n`); chmodSync(p, 0o755); };
  stub('tailscaled', 'exit 0');
  stub('sleep', 'exit 0');
  stub('tailscale', [
    `echo "$@" >> "${dir}/calls"`,
    'for a in "$@"; do',
    `  if [ "$a" = serve ]; then exit ${o.serveOk ? 0 : 1}; fi`,
    '  if [ "$a" = status ]; then echo \'{"Self":{"DNSName":"mwa.tail1a2b.ts.net."}}\'; exit 0; fi',
    'done',
    'exit 0',
  ].join('\n'));
  // the final `exec node --import tsx src/cli.ts serve`: print what MWA would see; anything else is the real node
  const realNode = process.execPath.replace(/\\/g, '/');
  stub('node', `if [ "$1" = "--import" ]; then echo "PUBLIC=[$MWA_PUBLIC_URL]"; exit 0; fi\nexec "${realNode}" "$@"`);
  if (o.envFile !== undefined) writeFileSync(join(data, '.env'), o.envFile);
  const script = ENTRY.replace(/\/data/g, data);
  writeFileSync(join(dir, 'entry.sh'), script);
  const r = spawnSync('sh', [`${dir}/entry.sh`], {
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, TAILSCALE_AUTHKEY: 'tskey-auth-test', MWA_ENV_PATH: `${data}/.env`, ...(o.env ?? {}) },
  });
  const calls = existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8') : '';
  rmSync(dir, { recursive: true, force: true });
  return { out: `${r.stdout}${r.stderr}`, calls, publicUrl: /PUBLIC=\[(.*)\]/.exec(r.stdout)?.[1] };
}

describe.skipIf(!SH)('docker-entrypoint.sh: tailscale serve and MWA_PUBLIC_URL', () => {
  it('serve works: https on the tailnet to the port, and MWA learns its address', () => {
    const r = run({ serveOk: true });
    expect(r.calls).toMatch(/serve --bg --https=443 http:\/\/127\.0\.0\.1:7788/);
    expect(r.publicUrl).toBe('https://mwa.tail1a2b.ts.net');
    expect(r.out).toMatch(/WARNING: set MWA_ACCESS_PASSWORD/);
  });
  it('serve failed: no MWA_PUBLIC_URL (an address that does not work is never announced)', () => {
    const r = run({ serveOk: false });
    expect(r.publicUrl).toBe('');
    expect(r.out).toMatch(/Tailscale serve failed/);
  });
  it('a value the person saved in /data/.env is never overridden; the port and password come from it too', () => {
    const r = run({ serveOk: true, envFile: 'MWA_PUBLIC_URL=https://mine.example.ts.net\nMWA_SERVE_PORT="7999"\nMWA_ACCESS_PASSWORD=secret\n' });
    expect(r.publicUrl).toBe(''); // not exported: the server reads the person's own value from .env
    expect(r.calls).toMatch(/http:\/\/127\.0\.0\.1:7999/);
    expect(r.out).not.toMatch(/WARNING: set MWA_ACCESS_PASSWORD/);
  });
  it('the environment wins over everything, and TAILSCALE_SERVE=0 in .env turns serving off', () => {
    expect(run({ serveOk: true, env: { MWA_PUBLIC_URL: 'https://env.example' } }).publicUrl).toBe('https://env.example');
    expect(run({ serveOk: true, env: { PORT: '8080' } }).calls).toMatch(/127\.0\.0\.1:8080/);
    const off = run({ serveOk: true, envFile: 'TAILSCALE_SERVE=0\n' });
    expect(off.calls).not.toMatch(/serve/);
    expect(off.publicUrl).toBe('');
  });
  // v2 S3 review: the name saved in Settings › Connections is the one Tailscale joins with
  const upName = (calls: string) => /up .*--hostname=(\S*)/.exec(calls)?.[1];
  it('the name: the environment wins, then the one saved in /data/.env, then mwa; only letters, digits and dashes', () => {
    expect(upName(run({ serveOk: true }).calls)).toBe('mwa');
    expect(upName(run({ serveOk: true, envFile: 'TAILSCALE_HOSTNAME=barn-helper\n' }).calls)).toBe('barn-helper');
    expect(upName(run({ serveOk: true, envFile: 'TAILSCALE_HOSTNAME="Barn"\n' }).calls)).toBe('barn');
    expect(upName(run({ serveOk: true, env: { TAILSCALE_HOSTNAME: 'fromenv' }, envFile: 'TAILSCALE_HOSTNAME=barn\n' }).calls)).toBe('fromenv');
    const odd = run({ serveOk: true, envFile: 'TAILSCALE_HOSTNAME=x$(touch pwned);y --ssh\n' });
    expect(upName(odd.calls)).toBe('xtouchpwnedy--ssh');
    expect(odd.calls).not.toMatch(/ --ssh/);
    expect(run({ serveOk: true, envFile: 'TAILSCALE_HOSTNAME=barn\n' }).out).toMatch(/Tailscale up as 'barn'/);
  }, 60_000); // six runs of the script: slow when the whole suite runs at once
});
