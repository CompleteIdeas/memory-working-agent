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

/**
 * Every http(s) URL in a tool call's arguments, at any depth, including inside text. Slashes may be
 * odd (`http:\host`, `http:/host`): the URL parser reads those as `http://host`. `truncated` when there
 * were more than can be checked, or nesting deeper than is read — the caller must then refuse.
 */
export function urlsIn(value: unknown): { urls: string[]; truncated: boolean } {
  const urls: string[] = []; let truncated = false;
  const walk = (v: unknown, depth: number): void => {
    if (truncated) return;
    if (depth > MAX_DEPTH) { truncated = true; return; }
    if (typeof v === 'string') {
      for (const m of v.matchAll(/https?:[\\/]+[^\s"'<>`]+/gi)) { if (urls.length >= MAX_URLS) { truncated = true; return; } urls.push(trimUrl(m[0])); }
    } else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(value, 0);
  return { urls, truncated };
}

/**
 * Why an MCP call may not go ahead (BL-16c): it carries a link to this machine, the private network or
 * cloud metadata. Best effort — a server that fetches does so with its own code, and a host given
 * without a scheme, or as separate host and port, isn't seen. A link that doesn't parse or whose name
 * doesn't resolve is the server's problem, not a refusal: an email body full of links must still send.
 */
export async function mcpUrlRefusal(args: unknown): Promise<string | null> {
  if (accessPolicy().preset === 'developer') return null;
  const { urls, truncated } = urlsIn(args);
  if (truncated) return `this call carries more than ${MAX_URLS} links, or nests deeper than ${MAX_DEPTH} levels, so its links can't all be checked`;
  const verdicts = await Promise.all([...new Set(urls)].map(async (raw): Promise<string | null> => {
    let u: URL;
    try { u = new URL(raw); } catch { return null; }
    const early = hostRefusal(u);
    if (early) return early;
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host)) return null;
    try {
      const addrs = (await lookup(host, { all: true })).map((a) => a.address);
      return addrs.some(isBlockedAddress) ? `${host} is on this machine or a private network, which this assistant may not reach (MWA's own controls live there)` : null;
    } catch { return null; }
  }));
  return verdicts.find((v) => v !== null) ?? null;
}
