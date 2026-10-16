/**
 * Network guard for the model's fetch tools (http_request, read_document). MWA serves its own
 * control API on this machine — including /api/approvals/confirm — so a fetch tool that can reach
 * loopback is a way for the model to approve its own actions (BL-03 isolated review). The guard
 * refuses loopback, private, link-local, CGNAT, multicast and unspecified addresses, including private
 * IPv4 hidden inside IPv6 (mapped, NAT64, 6to4, Teredo). Developer mode skips it, as it skips the
 * shell gate.
 *
 * Since BL-16c the check is pinned to the connection: the host is resolved once, inside the socket's
 * own lookup, so a name that resolves differently a moment later (DNS rebinding) can't slip through.
 * The core lives in mcp-servers/net-core.mjs so the bundled fetch MCP server uses the same code.
 * `urlRefusal` stays as a pre-check: a refusal BEFORE anything is sent is MWA refusing (BL-16), and
 * the tools flag it.
 */
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { accessPolicy } from './access.js';
import { isBlockedAddress, hostRefusal, pinnedFetch } from '../../mcp-servers/net-core.mjs';

export { isBlockedAddress };

/** Why `url` may not be fetched, or null when it may. A pre-check; the fetch itself is pinned. */
export async function urlRefusal(url: string): Promise<string | null> {
  if (accessPolicy().preset === 'developer') return null;
  let u: URL;
  try { u = new URL(url); } catch { return 'that is not a valid URL'; }
  const early = hostRefusal(u);
  if (early) return early;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return null;
  let addrs: string[];
  try { addrs = (await lookup(host, { all: true })).map((a) => a.address); } catch { return `could not resolve ${host}`; }
  if (!addrs.length || addrs.some(isBlockedAddress)) {
    return `${host} is on this machine or a private network, which this assistant may not reach (MWA's own controls live there)`;
  }
  return null;
}

/** fetch with the guard pinned to every connection and redirect hop. Returns the response, or a
 *  refusal string. Developer mode fetches directly. */
export async function guardedFetch(url: string, init: RequestInit = {}, maxRedirects = 5): Promise<Response | string> {
  if (accessPolicy().preset === 'developer') return fetch(url, init);
  return pinnedFetch(url, init, maxRedirects);
}

const MAX_URLS = 50;
const MAX_DEPTH = 12;

/** Trailing punctuation that ends a sentence, not a URL; a `]` only when it closes nothing in the URL. */
function trimUrl(raw: string): string {
  let x = raw;
  for (;;) {
    const last = x.slice(-1);
    if ('.,;:!?)}\'"'.includes(last) || (last === ']' && (x.match(/\[/g)?.length ?? 0) < (x.match(/\]/g)?.length ?? 0))) x = x.slice(0, -1);
    else return x;
  }
}

const LINK = /(?:https?|wss?|ftp):[\\/]+[^\s"'<>`]+/gi;

/**
 * Every link in a tool call's arguments — http(s), ws(s), ftp — at any depth, in keys and values,
 * including inside text. Slashes may be odd (`http:\host`, `http:/host`), and the URL parser drops tabs
 * and newlines, so each string is also read with them removed. Repeats count once. `truncated` when
 * there were more than can be checked, or nesting deeper than is read — the caller must then refuse.
 */
export function urlsIn(value: unknown): { urls: string[]; truncated: boolean } {
  const seen = new Set<string>(); let truncated = false;
  const scan = (str: string) => {
    for (const text of /[\t\r\n]/.test(str) ? [str, str.replace(/[\t\r\n]/g, '')] : [str])
      for (const m of text.matchAll(LINK)) { const u = trimUrl(m[0]); if (!seen.has(u)) { if (seen.size >= MAX_URLS) { truncated = true; return; } seen.add(u); } }
  };
  const walk = (v: unknown, depth: number): void => {
    if (truncated) return;
    if (depth > MAX_DEPTH) { truncated = true; return; }
    if (typeof v === 'string') scan(v);
    else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { scan(k); walk(x, depth + 1); }
  };
  walk(value, 0);
  return { urls: [...seen], truncated };
}

const LOOKUP_MS = 3000;
const LOOKUP_AT_ONCE = 8;

/** The addresses a name resolves to, or null when it doesn't resolve in time. */
async function addressesOf(host: string): Promise<string[] | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      lookup(host, { all: true }).then((a) => a.map((x) => x.address)),
      new Promise<null>((r) => { timer = setTimeout(() => r(null), LOOKUP_MS); }),
    ]);
  } catch { return null; } finally { clearTimeout(timer); }
}

/**
 * Why an MCP call may not go ahead (BL-16c): it carries a link to this machine, the private network or
 * cloud metadata. Best effort — a server that fetches does so with its own code, and a host given
 * without a scheme, or as separate host and port, isn't seen. A link that doesn't parse or whose name
 * doesn't resolve (in 3 s) is the server's problem, not a refusal: an email full of links must still send.
 */
export async function mcpUrlRefusal(args: unknown): Promise<string | null> {
  if (accessPolicy().preset === 'developer') return null;
  const { urls, truncated } = urlsIn(args);
  if (truncated) return `this call carries more than ${MAX_URLS} links, or nests deeper than ${MAX_DEPTH} levels, so its links can't all be checked`;
  const names = new Set<string>();
  for (const raw of urls) {
    let u: URL;
    // Read ws(s)/ftp links as http, so the same host rules apply.
    try { u = new URL(raw.replace(/^(?:wss?|ftp):/i, 'http:')); } catch { continue; }
    const early = hostRefusal(u);
    if (early) return early;
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!isIP(host)) names.add(host);
  }
  const queue = [...names];
  let refusal: string | null = null;
  await Promise.all(Array.from({ length: Math.min(LOOKUP_AT_ONCE, queue.length) }, async () => {
    for (let host = queue.shift(); host !== undefined && !refusal; host = queue.shift()) {
      const addrs = await addressesOf(host);
      if (addrs?.some(isBlockedAddress)) refusal = `${host} is on this machine or a private network, which this assistant may not reach (MWA's own controls live there)`;
    }
  }));
  return refusal;
}
