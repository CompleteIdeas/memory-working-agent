/**
 * The network guard's core (BL-16c), in plain JavaScript so both MWA (src/tools/net-guard.ts) and the
 * bundled fetch MCP server (mcp-servers/fetch.mjs) use the same code. MWA serves its own control API on
 * this machine, so a fetch that can reach loopback is a way for the model to act on its own approvals;
 * the private network and cloud metadata addresses are refused for the same reason.
 *
 * Pinned: a request resolves its host ONCE, inside the connection's own `lookup`, and refuses the whole
 * request if any address it got is blocked. The socket connects to an address from that same answer, so
 * a name that resolves to something else a moment later (DNS rebinding) changes nothing. Every request
 * opens a fresh connection (no shared agent), and every redirect hop is checked again.
 */
import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

function v4Blocked(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0 && ip.split('.')[2] === '0')
    || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

/** Expand an IPv6 address to its eight 16-bit groups, or null. */
function v6Groups(x) {
  let s = x;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const [p, q, r, t] = tail[1].split('.').map(Number);
    s = s.slice(0, -tail[1].length) + `${((p << 8) | q).toString(16)}:${((r << 8) | t).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
  const all = [...left, ...Array(Math.max(0, fill)).fill('0'), ...right];
  if (all.length !== 8) return null;
  const g = all.map((h) => parseInt(h, 16));
  return g.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff) ? null : g;
}
const v4Of = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/** True for an address the model's fetches must not reach. Anything that isn't an address is refused. */
export function isBlockedAddress(ip) {
  const v = isIP(ip);
  if (v === 4) return v4Blocked(ip);
  if (v !== 6) return true;
  const g = v6Groups(ip.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, ''));
  if (!g) return true;
  if (g.every((n) => n === 0)) return true;                                            // ::
  if (g.slice(0, 7).every((n) => n === 0) && g[7] === 1) return true;                  // ::1
  // IPv4 inside IPv6: mapped ::ffff:a.b.c.d, compatible ::a.b.c.d, NAT64 64:ff9b::a.b.c.d.
  if (g.slice(0, 5).every((n) => n === 0) && (g[5] === 0xffff || g[5] === 0)) return v4Blocked(v4Of(g[6], g[7]));
  if (g[0] === 0x64 && g[1] === 0xff9b) return v4Blocked(v4Of(g[6], g[7]));
  if (g[0] === 0x2002) return v4Blocked(v4Of(g[1], g[2]));                              // 6to4
  if (g[0] === 0x2001 && g[1] === 0) return true;                                       // Teredo: hides an address
  const top = g[0];
  return (top & 0xfe00) === 0xfc00 || (top & 0xffc0) === 0xfe80 || (top & 0xff00) === 0xff00; // ULA, link-local, multicast
}

/** Why a parsed URL's host may not be fetched before resolving it, or null. */
export function hostRefusal(u, blocked = isBlockedAddress) {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'only http(s) URLs';
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  // Names that mean "this machine" whatever DNS says. Others that resolve to a blocked address
  // (metadata.google.internal, 127.0.0.1.nip.io) are refused when the connection resolves them.
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'host.docker.internal' || host === 'gateway.docker.internal')
    return `${host} is on this machine or a private network, which this assistant may not reach (MWA's own controls live there)`;
  if (isIP(host) && blocked(host)) return `${host} is on this machine or a private network, which this assistant may not reach (MWA's own controls live there)`;
  return null;
}

export class BlockedAddressError extends Error {
  constructor(host) { super(`${host} is on this machine or a private network, which this assistant may not reach (MWA's own controls live there)`); this.code = 'EMWABLOCKED'; }
}

/**
 * A `lookup` for net/http: resolve every address once, refuse if any is blocked, answer from that same
 * resolution in whichever form the caller asked for (one address, or all of them for Happy Eyeballs).
 */
export function lookupGuardedBy(blocked) {
  return (hostname, options, callback) => {
    const opts = typeof options === 'number' ? { family: options } : (options ?? {});
    dnsLookup(hostname, { ...opts, all: true }, (err, addrs) => {
      if (err) return callback(err);
      if (!addrs.length || addrs.some((a) => blocked(a.address))) return callback(new BlockedAddressError(hostname));
      if (opts.all) return callback(null, addrs);
      return callback(null, addrs[0].address, addrs[0].family);
    });
  };
}
export const guardedLookup = lookupGuardedBy(isBlockedAddress);

const NO_BODY = new Set([101, 204, 205, 304]);

/** One request to one URL through the guarded lookup, on a fresh connection, as a WHATWG Response. */
function requestOnce(u, init, lookup) {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http;
    const headers = {};
    if (init.headers) for (const [k, v] of Object.entries(init.headers instanceof Headers ? Object.fromEntries(init.headers) : init.headers)) headers[k] = String(v);
    const req = mod.request(u, { method: init.method ?? 'GET', headers, agent: false, lookup, signal: init.signal }, (res) => {
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) for (const one of Array.isArray(v) ? v : [v]) if (one !== undefined) h.append(k, String(one));
      const status = res.statusCode ?? 0;
      const empty = NO_BODY.has(status) || (init.method ?? 'GET').toUpperCase() === 'HEAD';
      if (empty) res.resume();
      resolve(new Response(empty ? null : Readable.toWeb(res), { status, statusText: res.statusMessage ?? '', headers: h }));
    });
    req.on('error', reject);
    if (init.body !== undefined && init.body !== null) req.write(typeof init.body === 'string' ? init.body : Buffer.from(init.body));
    req.end();
  });
}

/**
 * fetch with the guard pinned to every connection and every redirect hop. Returns the Response, or a
 * refusal string `(refused: …)` when a hop's host is refused (before or at connect time). `blocked` is
 * for tests only: it lets a local server stand in for a public one.
 */
export async function pinnedFetch(url, init = {}, maxRedirects = 5, blocked = isBlockedAddress) {
  const lookup = blocked === isBlockedAddress ? guardedLookup : lookupGuardedBy(blocked);
  let current = url;
  let req = { ...init };
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let u;
    try { u = new URL(current); } catch { return '(refused: that is not a valid URL)'; }
    const why = hostRefusal(u, blocked);
    if (why) return `(refused: ${why})`;
    let res;
    try { res = await requestOnce(u, req, lookup); }
    catch (e) { if (e && e.code === 'EMWABLOCKED') return `(refused: ${e.message})`; throw e; }
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      try { await res.body?.cancel(); } catch { /* */ }
      current = new URL(loc, u).toString();
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && (req.method ?? 'GET').toUpperCase() === 'POST')) req = { ...req, method: 'GET', body: undefined };
      continue;
    }
    return res;
  }
  return '(refused: too many redirects)';
}
