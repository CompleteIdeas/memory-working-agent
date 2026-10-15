/**
 * Network guard for the model's fetch tools (http_request, read_document). MWA serves its own
 * control API on this machine — including /api/approvals/confirm — so a fetch tool that can reach
 * loopback is a way for the model to approve its own actions (BL-03 isolated review). The guard
 * refuses loopback, private, link-local and unspecified addresses, resolving names first and
 * re-checking every redirect hop. Developer mode skips it, as it skips the shell gate.
 *
 * Residual, accepted: a name that resolves differently between the check and the fetch (DNS
 * rebinding) is not caught; closing that needs a pinned-address agent.
 */
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { accessPolicy } from './access.js';

function v4Blocked(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/** True for an address the model's fetch tools must not reach. */
export function isBlockedAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return v4Blocked(ip);
  if (v === 6) {
    const x = ip.toLowerCase().replace(/^\[|\]$/g, '');
    const mapped = /^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x) ?? /^::(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return v4Blocked(mapped[1]);
    // new URL() rewrites [::ffff:127.0.0.1] to the hex form [::ffff:7f00:1]
    const hex = /^(?:0*:)*:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(x);
    if (hex) {
      const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
      return v4Blocked(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    if (x === '::' || x === '::1') return true;
    return /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x);
  }
  return true; // not an address at all — refuse rather than guess
}

/** Why `url` may not be fetched, or null when it may. */
export async function urlRefusal(url: string): Promise<string | null> {
  if (accessPolicy().preset === 'developer') return null;
  let u: URL;
  try { u = new URL(url); } catch { return 'that is not a valid URL'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'only http(s) URLs';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let addrs: string[];
  if (isIP(host)) addrs = [host];
  else {
    try { addrs = (await lookup(host, { all: true })).map((a) => a.address); } catch { return `could not resolve ${host}`; }
  }
  if (!addrs.length || addrs.some(isBlockedAddress)) {
    return `${host} is on this machine or a private network, which this assistant may not reach (MWA's own controls live there)`;
  }
  return null;
}

/** fetch with the guard applied to the first URL and every redirect. Returns the response, or a
 *  refusal string. */
export async function guardedFetch(url: string, init: RequestInit = {}, maxRedirects = 5): Promise<Response | string> {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const why = await urlRefusal(current);
    if (why) return `(refused: ${why})`;
    const res = await fetch(current, { ...init, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location')!, current).toString();
      if (res.status === 303) init = { ...init, method: 'GET', body: undefined };
      continue;
    }
    return res;
  }
  return '(refused: too many redirects)';
}
