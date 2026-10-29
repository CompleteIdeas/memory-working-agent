/**
 * The loopback listener that catches an OAuth sign-in's code (W5 security review, finding 7).
 *
 * Before: the Google and Outlook flows listened on localhost:7799 / :7798 and took the FIRST request to /oauth —
 * any page or local process could end the owner's sign-in with a junk request, or hand MWA an authorization code for
 * the attacker's own account (login CSRF: MWA would then read and draft in the attacker's mailbox). Now:
 *   - each sign-in has a random `state`; the listener accepts only a request carrying it (constant-time compare) and
 *     answers anything else with a plain 400 while it keeps waiting;
 *   - it gives up after 10 minutes;
 *   - starting a new sign-in on the same port replaces the old listener (the old attempt fails with "replaced").
 * PKCE (code_verifier / S256 code_challenge) is made here too, so both flows bind the code to this attempt.
 */
import { createServer, type Server } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const OAUTH_TIMEOUT_MS = 10 * 60_000;
const active = new Map<number, { server: Server; fail: (e: Error) => void }>();

export function newPkce(): { verifier: string; challenge: string; state: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url'), state: randomBytes(24).toString('base64url') };
}

const same = (a: string, b: string) => {
  const ha = createHash('sha256').update(a).digest(), hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
};
const page = (title: string, text: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;margin:40px;max-width:520px"><h1 style="font-size:20px">${title}</h1><p>${text}</p></body>`;

/**
 * Wait for the provider to send the browser back with `?state=…&code=…`. Resolves with the code; rejects on the
 * provider's own error (for this state), a timeout, or a newer sign-in on the same port.
 */
export function catchOAuthCode(o: { port: number; state: string; label: string; timeoutMs?: number; host?: string }): { ready: Promise<void>; code: Promise<string> } {
  const prev = active.get(o.port);
  if (prev) { prev.fail(new Error('A newer sign-in replaced this one.')); }
  let resolveCode!: (c: string) => void, rejectCode!: (e: Error) => void;
  const code = new Promise<string>((res, rej) => { resolveCode = res; rejectCode = rej; });
  code.catch(() => { /* handled by the caller; avoid an unhandled rejection when nobody awaits */ });
  let finished = false;
  const server = createServer((req, res) => {
    // No keep-alive: a one-shot listener has nothing to keep a connection for, and a kept one outlived the listener.
    // server.close() stops listening but leaves an open connection open, so the browser's next request on it (the
    // next sign-in on this port) reached the FINISHED listener, which answered 400, and the new sign-in never got its
    // code (CI on Linux, 0.10.0; the same on every OS once a client reuses the connection).
    res.setHeader('connection', 'close');
    let u: URL;
    try { u = new URL(req.url ?? '/', `http://localhost:${o.port}`); } catch { res.statusCode = 400; res.end(); return; }
    if (u.pathname !== '/oauth') { res.statusCode = 404; res.end(); return; }
    const st = u.searchParams.get('state') ?? '';
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    if (finished || !st || !same(st, o.state)) {
      res.statusCode = 400;
      res.end(page('This sign-in link doesn’t match', `This isn’t the ${o.label} sign-in your helper is waiting for. Start it again from Settings.`));
      return; // keep waiting for the real one
    }
    const c = u.searchParams.get('code');
    const err = u.searchParams.get('error_description') ?? u.searchParams.get('error');
    if (c) res.end(page(`${o.label} connected`, 'You can close this tab and go back to MWA.'));
    else { res.statusCode = 400; res.end(page(`${o.label} wasn’t connected`, 'The sign-in was cancelled or refused. You can try again from Settings.')); }
    done(c ? null : new Error(err ?? 'no code'), c ?? undefined);
  });
  const timer = setTimeout(() => done(new Error(`The ${o.label} sign-in wasn’t finished within 10 minutes.`)), o.timeoutMs ?? OAUTH_TIMEOUT_MS);
  (timer as { unref?: () => void }).unref?.();
  function done(e: Error | null, c?: string) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (active.get(o.port)?.server === server) active.delete(o.port);
    server.close();
    server.closeIdleConnections(); // and any connection between requests (a response in flight ends with its own close)
    if (e) rejectCode(e); else resolveCode(c!);
  }
  const ready = new Promise<void>((res, rej) => {
    // the old listener on this port was just closed: the port may take a moment to come free
    let tries = 0;
    const listen = () => {
      server.once('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'EADDRINUSE' && ++tries <= 20 && !finished) { setTimeout(listen, 100); return; }
        done(e); rej(e);
      });
      server.listen(o.port, o.host ?? '127.0.0.1', () => res());
    };
    listen();
  });
  ready.catch(() => { /* reported through code too */ });
  active.set(o.port, { server, fail: (e) => done(e) });
  return { ready, code };
}

/** v2 S3 (review): stop the sign-in waiting on this port (Cancel, or the account was disconnected): its listener
 *  closes and its attempt fails, so nothing is saved. True when one was waiting. */
export function cancelOAuthCatch(port: number): boolean {
  const a = active.get(port);
  if (!a) return false;
  a.fail(new Error('The sign-in was cancelled.'));
  return true;
}
