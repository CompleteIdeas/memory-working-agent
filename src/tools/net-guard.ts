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

/** Every http(s) URL in a tool call's arguments, at any depth (strings that contain one, too). */
export function urlsIn(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 12 || out.length > 50) return out;
  if (typeof value === 'string') { for (const m of value.matchAll(/https?:\/\/[^\s"'<>`)\]]+/gi)) out.push(m[0]); }
  else if (Array.isArray(value)) for (const v of value) urlsIn(v, out, depth + 1);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) urlsIn(v, out, depth + 1);
  return out;
}
