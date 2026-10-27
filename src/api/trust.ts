/**
 * Who and where a request comes from (W5 security review, 2026-10-26). One place for four questions the server
 * asks on every request:
 *
 *   hostAllowed(req)      the Host is one this server answers to (DNS-rebinding defence). Allowed: localhost,
 *                         127.0.0.1, [::1], any IP literal (a rebinding page always uses a hostname), this machine's
 *                         hostname, MWA_ALLOWED_HOSTS (comma-separated; "*.example.ts.net" allows that suffix),
 *                         the host of MWA_PUBLIC_URL, Railway's own domains, and `<TAILSCALE_HOSTNAME>.<tailnet>.ts.net`
 *                         when the Docker image joined a tailnet. MWA_ALLOWED_HOSTS=* turns the check off.
 *   relayedMode()         the server can be reached through something that makes a remote client look local: it is
 *                         bound beyond 127.0.0.1 (Docker sets MWA_SERVE_HOST=0.0.0.0), MWA_RELAYED=1, the Docker image's
 *                         Tailscale (TAILSCALE_AUTHKEY: tailscaled userspace networking delivers tailnet peers from
 *                         127.0.0.1), a hosted deploy (Railway, a container), or a non-local name in MWA_ALLOWED_HOSTS /
 *                         MWA_PUBLIC_URL (something forwards that name here). In relayed mode nobody is "this machine":
 *                         the owner signs in with the password or uses a paired device.
 *   sourceOf(req)         the address a throttle counts against: the socket peer. X-Forwarded-For is believed only when
 *                         the peer is a trusted proxy (MWA_TRUSTED_PROXY, comma-separated IPs or CIDR ranges such as
 *                         10.0.0.0/8 or fd7a:115c:a1e0::/48; none by default), and then
 *                         the right-most address that is not itself a trusted proxy.
 *   cookieSecure(req)     whether a cookie may carry Secure: only over HTTPS (directly, or X-Forwarded-Proto: https).
 *                         Plain http on localhost gets no Secure flag (some browsers then drop the cookie).
 */
import type { IncomingMessage } from 'node:http';
import { hostname } from 'node:os';
import { isIP, BlockList } from 'node:net';
import { isHosted } from '../hosting.js';

type Env = Record<string, string | undefined>;
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const truthy = (v: string | undefined) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
const list = (v: string | undefined) => String(v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

/** "host:port" / "[::1]:port" → the host, lower case, no brackets. */
export function hostOnly(h: string): string {
  const s = h.trim().toLowerCase();
  if (s.startsWith('[')) { const e = s.indexOf(']'); return e > 0 ? s.slice(1, e) : s; }
  const c = s.lastIndexOf(':');
  return c > 0 && s.indexOf(':') === c ? s.slice(0, c) : s;
}

function publicUrlHost(env: Env): string | null {
  try { return env.MWA_PUBLIC_URL ? new URL(env.MWA_PUBLIC_URL).hostname.toLowerCase().replace(/^\[|\]$/g, '') : null; } catch { return null; }
}

/** The host names this server answers to besides loopback and IP literals. */
export function allowedHostNames(env: Env = process.env): string[] {
  const out = new Set<string>(list(env.MWA_ALLOWED_HOSTS));
  try { const h = hostname().toLowerCase(); if (h) { out.add(h); out.add(`${h}.local`); } } catch { /* no hostname */ }
  const pub = publicUrlHost(env); if (pub) out.add(pub);
  for (const k of ['RAILWAY_PUBLIC_DOMAIN', 'RAILWAY_PRIVATE_DOMAIN', 'RAILWAY_STATIC_URL']) { const v = env[k]; if (v) out.add(hostOnly(v.replace(/^https?:\/\//, ''))); }
  out.delete('');
  return [...out];
}

export function hostAllowed(req: IncomingMessage, env: Env = process.env): boolean {
  if (list(env.MWA_ALLOWED_HOSTS).includes('*')) return true;
  const raw = String(req.headers.host ?? '');
  if (!raw) return false;
  const h = hostOnly(raw);
  if (LOOPBACK_NAMES.has(h) || isIP(h)) return true;
  if (env.TAILSCALE_AUTHKEY) {
    const ts = String(env.TAILSCALE_HOSTNAME || 'mwa').toLowerCase();
    if (h === ts || new RegExp(`^${ts.replace(/[^a-z0-9-]/g, '')}\\.[a-z0-9-]+\\.ts\\.net$`).test(h)) return true;
  }
  for (const a of allowedHostNames(env)) {
    if (a.startsWith('*.') ? h.endsWith(a.slice(1)) && h.length > a.length - 1 : h === a) return true;
  }
  return false;
}

/** True when a loopback socket does not prove the client is on this machine (see the header). */
export function relayedMode(env: Env = process.env, hosted: () => boolean = () => isHosted(env as NodeJS.ProcessEnv)): boolean {
  if (truthy(env.MWA_RELAYED)) return true;
  if (/^(0|false|no|off)$/i.test(String(env.MWA_RELAYED ?? '').trim())) return false; // the owner says it is not (tests, odd setups)
  const bind = String(env.MWA_SERVE_HOST ?? '127.0.0.1').trim().toLowerCase();
  if (!LOOPBACK_NAMES.has(bind) && bind !== '127.0.0.1') return true;
  if (env.TAILSCALE_AUTHKEY) return true;
  if (list(env.MWA_ALLOWED_HOSTS).some((h) => h === '*' || (!LOOPBACK_NAMES.has(h) && !isIP(h)))) return true;
  const pub = publicUrlHost(env); if (pub && !LOOPBACK_NAMES.has(pub)) return true;
  return hosted();
}

const norm = (a: string) => a.replace(/^::ffff:/, '').replace(/^\[|\]$/g, '').toLowerCase();
/** MWA_TRUSTED_PROXY as a BlockList: exact addresses and CIDR ranges ("127.0.0.1, 10.0.0.0/8, fd7a:115c:a1e0::/48").
 *  An entry that is neither is ignored. Cached per value. */
let trustCache: { raw: string; list: BlockList } | null = null;
export function trustedProxies(env: Env = process.env): BlockList {
  const raw = String(env.MWA_TRUSTED_PROXY ?? '');
  if (trustCache?.raw === raw) return trustCache.list;
  const bl = new BlockList();
  for (const item of list(raw)) {
    const [addr, bits] = item.split('/');
    const a = norm(addr), fam = isIP(a);
    if (!fam) continue;
    const type = fam === 6 ? 'ipv6' : 'ipv4';
    if (bits === undefined) bl.addAddress(a, type);
    else { const n = Number(bits); if (Number.isInteger(n) && n >= 0 && n <= (fam === 6 ? 128 : 32)) bl.addSubnet(a, n, type); }
  }
  trustCache = { raw, list: bl };
  return bl;
}
const isTrusted = (bl: BlockList, a: string) => { const fam = isIP(a); return !!fam && bl.check(a, fam === 6 ? 'ipv6' : 'ipv4'); };
export function sourceOf(req: IncomingMessage, env: Env = process.env): string {
  const peer = norm(String(req.socket?.remoteAddress ?? 'unknown'));
  const trusted = trustedProxies(env);
  if (!isTrusted(trusted, peer)) return peer;
  const hops = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => norm(s.trim())).filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) if (!isTrusted(trusted, hops[i])) return hops[i];
  return peer;
}

export function cookieSecure(req: IncomingMessage): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted) return true;
  return String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase() === 'https';
}

/**
 * A computer install served to the tailnet with `tailscale serve` (https, or --tcp) is relayed too: tailscaled hands
 * MWA every tailnet request from 127.0.0.1. At start, ask the local Tailscale (if any) whether it forwards to this
 * port; if it does and MWA_RELAYED was not set either way, relayed mode is switched on. Best-effort: no Tailscale,
 * or no answer within 3 s, changes nothing. (Any other relay — socat, ssh -R, netsh portproxy — needs MWA_RELAYED=1.)
 */
export async function detectTailscaleServe(port: number, run: (cmd: string, args: string[]) => Promise<string> = defaultRun): Promise<boolean> {
  if (String(process.env.MWA_RELAYED ?? '').trim() !== '') return false;
  let out = '';
  try { out = await run('tailscale', ['serve', 'status', '--json']); } catch { return false; }
  const hit = tailscaleForwardsTo(out, port);
  if (hit) process.env.MWA_RELAYED = '1';
  return hit;
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whether `tailscale serve status --json` output forwards to this port on this machine (any loopback spelling). */
export function tailscaleForwardsTo(statusJson: string, port: number): boolean {
  const hosts = ['127.0.0.1', 'localhost', '[::1]', '::1', '0.0.0.0'].map(escapeRe).join('|');
  return new RegExp(`(?:^|[^0-9A-Za-z.:])(?:${hosts}):${port}(?![0-9])`).test(statusJson);
}
async function defaultRun(cmd: string, args: string[]): Promise<string> {
  const { execFile } = await import('node:child_process');
  return new Promise((res, rej) => {
    execFile(cmd, args, { timeout: 3000, windowsHide: true }, (e, stdout) => (e ? rej(e) : res(String(stdout))));
  });
}
