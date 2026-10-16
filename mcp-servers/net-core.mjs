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
  if (g.slice(0, 4).every((n) => n === 0) && g[4] === 0xffff && g[5] === 0) return v4Blocked(v4Of(g[6], g[7])); // SIIT ::ffff:0:a.b.c.d
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true;            // 100::/64, discard
  const top = g[0];
  return (top & 0xfe00) === 0xfc00 || (top & 0xffc0) === 0xfe80 || (top & 0xffc0) === 0xfec0 || (top & 0xff00) === 0xff00; // ULA, link-local, site-local, multicast
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
    // Headers in any form fetch accepts. Defaults keep what the global fetch used to provide: an
    // identifiable user-agent, and no compression (this client does not decompress).
    const h0 = new Headers(init.headers ?? {});
    if (!h0.has('user-agent')) h0.set('user-agent', 'Mozilla/5.0 (MWA)');
    h0.set('accept-encoding', 'identity');
    const b = init.body;
    const body = b === undefined || b === null ? null
      : typeof b === 'string' ? Buffer.from(b)
      : b instanceof URLSearchParams ? Buffer.from(b.toString())
      : ArrayBuffer.isView(b) ? Buffer.from(b.buffer, b.byteOffset, b.byteLength)
      : b instanceof ArrayBuffer ? Buffer.from(b) : Buffer.from(String(b));
    if (b instanceof URLSearchParams && !h0.has('content-type')) h0.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8');
    if (body) h0.set('content-length', String(body.length));
    const headers = Object.fromEntries(h0);
    const req = mod.request(u, { method: init.method ?? 'GET', headers, agent: false, lookup, signal: init.signal }, (res) => {
      // Anything thrown here would escape the promise and crash the process: a site must not be able to.
      try {
        const status = res.statusCode ?? 0;
        if (status < 200 || status > 599) { res.destroy(); return reject(new Error(`the site answered with status ${status}, which is not an HTTP response this tool reads`)); }
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) for (const one of Array.isArray(v) ? v : [v]) if (one !== undefined) { try { h.append(k, String(one)); } catch { /* an invalid header is dropped */ } }
        const empty = NO_BODY.has(status) || (init.method ?? 'GET').toUpperCase() === 'HEAD';
        if (empty) res.resume();
        // A status text with control characters is dropped rather than failing a readable page.
        const statusText = /^[\t\x20-\x7e\x80-\xff]*$/.test(res.statusMessage ?? '') ? res.statusMessage ?? '' : '';
        resolve(new Response(empty ? null : Readable.toWeb(res), { status, statusText, headers: h }));
      } catch (e) { res.destroy(); reject(e); }
    });
    req.on('error', reject);
    // A 101 with upgrade headers never reaches the response callback and raises no error: without
    // these, the promise would never settle (and abort wouldn't help). A reject after resolve is a no-op.
    req.on('upgrade', (_res, socket) => { socket.destroy(); reject(new Error('the site tried to switch protocols, which this tool does not follow')); });
    req.on('close', () => reject(new Error('the connection closed before the site answered')));
    init.signal?.addEventListener('abort', () => { req.destroy(); reject(init.signal.reason ?? new Error('aborted')); }, { once: true });
    if (body) req.write(body);
    req.end();
  });
}

const CREDENTIALS = ['authorization', 'cookie', 'proxy-authorization'];

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
    if ([301, 302, 303, 307, 308].includes(res.status) && loc) {
      try { await res.body?.cancel(); } catch { /* */ }
      const next = new URL(loc, u);
      // Like fetch: credentials never follow a redirect to another origin.
      if (next.origin !== u.origin && req.headers) { const h = new Headers(req.headers); for (const k of CREDENTIALS) h.delete(k); req = { ...req, headers: h }; }
      current = next.toString();
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && (req.method ?? 'GET').toUpperCase() === 'POST')) {
        const h = new Headers(req.headers ?? {}); h.delete('content-type'); h.delete('content-length');
        req = { ...req, method: 'GET', body: undefined, headers: h };
      }
      continue;
    }
    return res;
  }
  return '(refused: too many redirects)';
}
