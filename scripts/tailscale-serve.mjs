/**
 * Put MWA on your phone's secure address (v2 build, slice P1): `tailscale serve` in front of the local server.
 *
 *   npm run tailscale:serve                 check Tailscale, then serve https://<this-computer>.<tailnet>.ts.net → MWA
 *   npm run tailscale:serve -- --check      only check and print what it would do (changes nothing)
 *   npm run tailscale:serve -- --off        stop serving MWA over Tailscale
 *   npm run tailscale:serve -- --port 7799  another port (default: MWA_SERVE_PORT, then PORT, from the environment
 *                                           or .env, then 7788 — the same order `mwa serve` uses)
 *
 * What it does, in order:
 *   1. finds the tailscale command (PATH, or where the Windows / macOS app installs it);
 *   2. reads `tailscale status --json`: signed in and running? MagicDNS on? HTTPS certificates on? If not, it says
 *      exactly where to switch them on (the Tailscale admin page) and stops;
 *   3. refuses if Funnel (the PUBLIC internet address) is on for this machine — MWA stays inside your tailnet;
 *   4. runs `tailscale serve --bg --https=443 http://127.0.0.1:<port>` (private to your tailnet: no funnel);
 *   5. prints the phone's address and the .env lines (W5's names): MWA_PUBLIC_URL (its own address, for pairing links
 *      and the install card), MWA_ALLOWED_HOSTS (the ts.net name; other Host headers get 421), MWA_TRUSTED_PROXY=127.0.0.1
 *      (tailscale serve's X-Forwarded-For), and the reminder that MWA_ACCESS_PASSWORD is required.
 *
 * The Docker image does the same by itself when it joins a tailnet (docker-entrypoint.sh, TAILSCALE_SERVE).
 * Tailscale's older CLIs (before 1.52) used `tailscale serve https / http://127.0.0.1:<port>`; update Tailscale if
 * the command is refused.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ADMIN_DNS = 'https://login.tailscale.com/admin/dns';

/** The port `mwa serve` listens on: MWA_SERVE_PORT, then PORT (the environment first, then .env), then 7788. */
export function servePort(env = process.env, envFileText = '') {
  const file = {};
  for (const line of envFileText.split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) file[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  for (const k of ['MWA_SERVE_PORT', 'PORT']) {
    const v = env[k] ?? file[k];
    if (v && /^\d+$/.test(String(v).trim())) return Number(String(v).trim());
  }
  return 7788;
}

/**
 * What `tailscale status --json` says about serving MWA privately over HTTPS. `problems` are in plain words, each
 * with what to do; `host` is this machine's MagicDNS name.
 */
export function assess(status) {
  const problems = [];
  if (!status || typeof status !== 'object') return { ok: false, host: null, problems: ['Tailscale did not answer. Is it installed and running?'] };
  if (status.BackendState !== 'Running') {
    problems.push(status.BackendState === 'NeedsLogin'
      ? 'Tailscale is not signed in on this computer. Open Tailscale and sign in, then run this again.'
      : `Tailscale is not running (it says "${status.BackendState ?? 'unknown'}"). Open Tailscale and connect, then run this again.`);
  }
  const magic = status.CurrentTailnet?.MagicDNSEnabled === true;
  if (!magic) problems.push(`MagicDNS is off. Switch it on: ${ADMIN_DNS} → MagicDNS → Enable.`);
  const certs = Array.isArray(status.CertDomains) && status.CertDomains.length > 0;
  if (!certs) problems.push(`HTTPS certificates are off. Switch them on: ${ADMIN_DNS} → HTTPS Certificates → Enable HTTPS. (Your machine's name then appears in a public certificate log; the address still works only inside your tailnet.)`);
  const host = String(status.Self?.DNSName ?? '').replace(/\.$/, '') || null;
  if (magic && !host) problems.push('This computer has no MagicDNS name yet. Wait a minute and run this again.');
  return { ok: problems.length === 0, host, problems };
}

/** True when `tailscale serve status --json` shows Funnel (a public address) switched on for any port. */
export function funnelOn(serveStatus) {
  const f = serveStatus?.AllowFunnel;
  return !!f && Object.values(f).some(Boolean);
}

/**
 * The .env lines for serving through `tailscale serve` (W5's names): MWA's own address (pairing links, the install
 * card), the name added to the Host allowlist (other Host headers get 421), the proxy whose X-Forwarded-For is believed
 * (tailscale serve connects from 127.0.0.1), and the password (required: in relayed mode nobody is "this machine").
 */
export function envLines(host) {
  return [
    `MWA_PUBLIC_URL=https://${host}`,
    `MWA_ALLOWED_HOSTS=${host}`,
    'MWA_TRUSTED_PROXY=127.0.0.1',
    'MWA_ACCESS_PASSWORD=<choose a password>   (required; skip if already set)',
  ];
}

function findTailscale() {
  const candidates = ['tailscale'];
  if (process.platform === 'win32') candidates.push('C:\\Program Files\\Tailscale\\tailscale.exe');
  if (process.platform === 'darwin') candidates.push('/Applications/Tailscale.app/Contents/MacOS/Tailscale');
  for (const c of candidates) {
    if (c !== 'tailscale' && !existsSync(c)) continue;
    const r = spawnSync(c, ['version'], { encoding: 'utf8' });
    if (r.status === 0) return c;
  }
  return null;
}
function ts(bin, args) {
  const r = spawnSync(bin, args, { encoding: 'utf8' });
  return { code: r.status ?? 1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}
const json = (s) => { try { return JSON.parse(s); } catch { return null; } };

async function main() {
  const argv = process.argv.slice(2);
  const flag = (n) => argv.includes(`--${n}`);
  const argPort = (() => { const i = argv.indexOf('--port'); return i >= 0 ? Number(argv[i + 1]) : null; })();
  const envFile = existsSync(join(ROOT, '.env')) ? readFileSync(join(ROOT, '.env'), 'utf8') : '';
  const port = argPort || servePort(process.env, envFile);

  const bin = findTailscale();
  if (!bin) {
    console.error('Tailscale is not installed on this computer. Install it from https://tailscale.com/download, sign in, then run this again.');
    process.exit(2);
  }
  if (flag('off')) {
    const r = ts(bin, ['serve', '--https=443', 'off']);
    console.log(r.code === 0 ? 'MWA is no longer served over Tailscale.' : `Tailscale said: ${r.err || r.out}`);
    process.exit(r.code === 0 ? 0 : 1);
  }

  const st = ts(bin, ['status', '--json']);
  const a = assess(json(st.out));
  console.log(`Tailscale: ${a.host ? `this computer is ${a.host}` : 'no MagicDNS name'} · MWA on port ${port}`);
  if (!a.ok) {
    console.log('\nBefore your phone can use the secure address:');
    for (const p of a.problems) console.log(`  • ${p}`);
    process.exit(2);
  }
  const serveStatus = json(ts(bin, ['serve', 'status', '--json']).out);
  if (funnelOn(serveStatus)) {
    console.error('\nFunnel is ON for this computer: something here is on the public internet. MWA stays private, so this stops.');
    console.error('Turn it off with `tailscale funnel reset` (or `tailscale funnel --https=443 off`), then run this again.');
    process.exit(2);
  }
  let up = false;
  try { up = (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2_000) })).ok; } catch { /* not running */ }
  if (!up) console.log(`\nNote: nothing answers on http://127.0.0.1:${port} yet. Start MWA (npm run serve, or the desktop app); the address works once it runs.`);

  const cmd = ['serve', '--bg', '--https=443', `http://127.0.0.1:${port}`];
  if (flag('check')) {
    console.log(`\nAll set. This would run: tailscale ${cmd.join(' ')}`);
  } else {
    const r = ts(bin, cmd);
    if (r.code !== 0) {
      console.error(`\nTailscale refused: ${r.err || r.out}`);
      console.error('If your Tailscale is older than 1.52, update it, or run: tailscale serve https / http://127.0.0.1:' + port);
      process.exit(1);
    }
  }
  const url = `https://${a.host}`;
  console.log(`\nOn your phone (with Tailscale on): ${url}/?ui=v2`);
  console.log('It works only on devices signed in to your Tailscale. Nothing is public (Funnel is off).');
  console.log('\nAdd to MWA\'s .env (keep any MWA_ALLOWED_HOSTS names you already have, comma-separated), then restart MWA:');
  for (const l of envLines(a.host)) console.log(`  ${l}`);
  console.log('A password is required: through tailscale serve every visitor arrives from 127.0.0.1, so MWA trusts nobody as');
  console.log('"this computer" (relayed mode). Sign in on the phone once, then pair it (Settings › Put MWA on your phone).');
  console.log('MWA_PUBLIC_URL can also be set in Settings › Your helper.');
  if (!flag('check')) {
    try {
      const m = await fetch(`${url}/api/v1/meta`, { signal: AbortSignal.timeout(20_000) });
      const j = await m.json().catch(() => ({}));
      console.log(`\nChecked ${url}: ${m.status}${typeof j.secure === 'boolean' ? ` · secure: ${j.secure}` : ''}`);
    } catch (e) {
      console.log(`\nCould not open ${url} from this computer yet (${e.message}). The first visit fetches the certificate and can take a minute.`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
