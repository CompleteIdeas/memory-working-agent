/**
 * Links in text as their host only, on the client (review of W3): the same rule as the server's sanitiser
 * (src/v2/mail-text.ts `linksToHosts`, kept identical: tests/web-v2-items.test.ts checks them against each other), for
 * text the server did not sanitise — a helper's answer that read someone else's words. "https://evil.example/login"
 * becomes "evil.example"; http(s), hxxp(s), ftp, ws, file, "//host/…", "www.…" and bare "host.tld/path" alike.
 */
const WEB_SCHEME = /^(h(?:tt|xx|\*\*)ps?|ftps?|sftp|wss?|file):[/\\]/i;
const EMBEDDED_SCHEME = /(?:h(?:tt|xx|\*\*)ps?|ftps?|sftp|wss?|file):[/\\]/i;
const BARE_HOST_PATH = /^((?:[a-z0-9-]+\.)+[a-z]{2,63})(?::\d{1,5})?[/?#]/i;

export function hostOf(href: string): string | null {
  let h = href.trim().replace(/\\/g, '/');
  if (!h) return null;
  if (WEB_SCHEME.test(h)) h = h.replace(/^[a-z*]+:\/*/i, 'http://');
  else if (/^\/\//.test(h)) h = `http:${h}`;
  else if (/^www\./i.test(h) || BARE_HOST_PATH.test(h)) h = `http://${h}`;
  else return null;
  try { return new URL(h).hostname.replace(/^www\./i, '').toLowerCase() || null; } catch { return null; }
}

function linkToken(tok: string): string {
  if (tok.length < 4) return tok;
  const lead = /^[<(["']*/.exec(tok)![0];
  let core = tok.slice(lead.length);
  const trail = /[>)\]"'.,;:!?]*$/.exec(core)![0];
  core = core.slice(0, core.length - trail.length);
  if (!core) return tok;
  let pre = '';
  let isLink = WEB_SCHEME.test(core) || /^\/\/[a-z0-9-]+\./i.test(core) || /^www\./i.test(core) || BARE_HOST_PATH.test(core);
  if (!isLink) {
    const m = EMBEDDED_SCHEME.exec(core);
    if (!m) return tok;
    pre = core.slice(0, m.index); core = core.slice(m.index); isLink = true;
  }
  const host = hostOf(core) ?? '';
  if (lead === '<' && trail.startsWith('>')) return host ? `(${host})${trail.slice(1)}` : trail.slice(1);
  return `${lead}${pre}${host}${trail}`;
}

/** Raw URLs in text become their host. Linear: one anchored pass per whitespace-free token. */
export function linksToHosts(text: string): string {
  return text.replace(/[^\s]+/g, linkToken);
}

/**
 * A display name for showing, client side as well (defence in depth; the server already does it — src/v2/mail-text.ts
 * `displayName`): nothing with an "@" in it, no empty brackets left behind, at most 60 characters.
 */
export function showName(s: string | null | undefined): string | null {
  if (!s) return null;
  let t = s
    .replace(/<[^<>]*@[^<>]*>/g, ' ')
    .replace(/[^\s]*@[^\s]*/g, ' ')
    .replace(/\(\s*\)|\[\s*\]|<\s*>|"\s*"|'\s*'/g, ' ')
    .replace(/\s+/g, ' ').trim()
    .replace(/^[\s·•|,;:\-–—]+|[\s·•|,;:\-–—]+$/g, '').trim();
  if (!t) return null;
  if (t.length > 60) t = `${t.slice(0, 59).trimEnd()}…`;
  return t;
}
