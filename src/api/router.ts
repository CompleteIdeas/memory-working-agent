/**
 * /api/v1 (v2 build, 2026-10-26): the client API the v2 web app and a phone app drive. The legacy /api/* routes in
 * serve.ts are one long if-chain inside runServe, untestable over HTTP; v1 is a route table instead, mounted with one
 * line in serve.ts and testable on its own server.
 *
 * Every route declares its scope. In one place, for every route:
 *   - access: the caller must be signed in (deps.authed — a password session or a paired device token);
 *   - same-origin: a cookie-authenticated write from another site is refused (CSRF), as sameOriginOk does for /api;
 *   - idempotency: a write must carry an Idempotency-Key; a retry with the same key gets the first answer back;
 *   - client version: a client older than MIN_CLIENT gets 426 and must reload;
 *   - errors: always {error: {code, message}}.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { appDb } from '../v2/db.js';
import { logger } from '../logger.js';
import type { Caller } from './auth.js';

export type Scope = 'public' | 'read' | 'act' | 'approve' | 'admin';

export interface RouteCtx {
  req: IncomingMessage;
  url: URL;
  params: Record<string, string>;
  body: unknown;
  /** the key space for idempotency: 'session', 'local' or 'device:<id>' */
  caller: string;
  /** who is calling (null on a public route with nobody signed in) */
  who: Caller | null;
  /** W5: a route with `rawBody` gets the request body as bytes here (and `body` stays undefined) */
  raw?: Buffer;
}
export interface Reply {
  status?: number; body?: unknown; headers?: Record<string, string>;
  /** A GET that streams (server-sent events): the router writes the SSE headers and hands the response over. */
  stream?: (res: ServerResponse, req: IncomingMessage) => void;
  /** A GET whose answer is not JSON (a calendar file): sent as-is with this content type. */
  raw?: { contentType: string; body: string | Buffer };
  /** A refusal that may not hold on a retry: the Idempotency-Key reservation is released, not settled. */
  transient?: boolean;
}
export type Handler = (ctx: RouteCtx) => Promise<Reply> | Reply;
export interface Route {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; path: string; scope: Scope; handler: Handler;
  /** W5 (file upload): the body is not JSON; it is read as bytes up to `max` and handed over as ctx.raw. `tooLarge` is
   *  the refusal's plain words. Every other check (scope, same-origin, Idempotency-Key over the bytes) still applies. */
  rawBody?: { max: number; tooLarge: string };
  /** W5: admission before the body is read (a concurrency limit): throw an ApiError to refuse, or return a release
   *  function the router calls when the request is done. */
  admit?: (ctx: { req: IncomingMessage; caller: string }) => () => void;
}

export interface RouterDeps {
  /** who is calling, or null when nobody valid is (src/api/auth.ts makeAuthenticate) */
  authenticate: (req: IncomingMessage) => Caller | null;
  /** true when the request is same-origin (no Origin, or Origin/Sec-Fetch-Site agree with Host) */
  sameOrigin: (req: IncomingMessage) => boolean;
}

/** The oldest web client the server still accepts ("web/<semver>"). Raise it when the API breaks an old client. */
export const MIN_CLIENT = '1.0.0';
export const API_VERSION = 'v1';
const MAX_BODY = 1_000_000;
const IDEMPOTENCY_TTL_MS = 48 * 3_600_000;

export class ApiError extends Error {
  /** transient: a refusal that may not hold on a retry (sign in again, connect a calendar, wait a moment) — not
   *  remembered against the Idempotency-Key, so a retry with the same key runs again. */
  constructor(public status: number, public code: string, message: string, public transient = false) { super(message); }
}

/** Compare dotted versions; -1, 0, 1. Missing parts count as 0. */
export function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0), pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}

/** '/jobs/{id}/continue' → a matcher returning the params, or null. A param that does not decode, or decodes to
 *  something with a slash, backslash or NUL, is refused (400): an id must never become a path. */
function compile(path: string): (p: string) => Record<string, string> | null {
  const names: string[] = [];
  const re = new RegExp('^' + path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{(\w+)\}/g, (_m, n: string) => { names.push(n); return '([^/]+)'; }) + '/?$');
  return (p) => {
    const m = re.exec(p); if (!m) return null;
    const out: Record<string, string> = {};
    names.forEach((n, i) => {
      let v: string;
      try { v = decodeURIComponent(m[i + 1]); } catch { throw new ApiError(400, 'bad_path', 'The address has a malformed part.'); }
      if (/[/\\\0]/.test(v)) throw new ApiError(400, 'bad_path', 'The address has a malformed part.');
      out[n] = v;
    });
    return out;
  };
}

async function readRaw(req: IncomingMessage, max = MAX_BODY, tooLarge = 'The request is too large.'): Promise<Buffer> {
  // a declared length over the limit is refused before a byte is read
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > max) throw Object.assign(new ApiError(413, 'too_large', tooLarge), { declared: true });
  // listeners, not `for await`: leaving a for-await early destroys the request, and the client then sees a reset
  // instead of the 413 (W5 security review). On overflow the stream is left as it is; the caller drains it.
  return new Promise<Buffer>((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = [];
    const onData = (c: Buffer | string) => {
      const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
      size += b.length;
      if (size > max) { cleanup(); reject(new ApiError(413, 'too_large', tooLarge)); return; }
      chunks.push(b);
    };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const onError = (e: Error) => { cleanup(); reject(e); };
    const cleanup = () => { req.off('data', onData); req.off('end', onEnd); req.off('error', onError); };
    req.on('data', onData); req.on('end', onEnd); req.on('error', onError);
  });
}
function parseJson(raw: Buffer): unknown {
  if (!raw.length) return undefined;
  try { return JSON.parse(raw.toString('utf8')); } catch { throw new ApiError(400, 'bad_json', 'The request body is not valid JSON.'); }
}

/** Every answer is JSON (an empty body is `null`), serialised BEFORE the headers go out. HEAD gets the headers only. */
function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}, head = false): void {
  const text = JSON.stringify(body === undefined ? null : body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(head ? undefined : text);
}
const errBody = (e: ApiError) => ({ error: { code: e.code, message: e.message } });

/**
 * Idempotency (after the review of A0, 2026-10-26). The key is RESERVED before the handler runs, in an IMMEDIATE
 * transaction, so two identical requests arriving together cannot both act: the second gets 409 `in_progress` (try
 * again shortly) or, once the first has finished, the first answer. A key is bound to the exact request — method,
 * path with its ids, query and body (a hash) — so reusing it for another item is a 409, never a false success.
 *
 * Policy: whatever the HANDLER concluded is remembered and replayed for 48 h — a success, or a 4xx it returned or
 * threw (a retry of a refused action is refused the same way; send a new key to try again) — except a refusal marked
 * `transient: true` (on the Reply or the ApiError: "sign in again", "connect a calendar", "busy"), which releases the key so
 * a retry with it runs again (review of A7; A8 uses the same flag). Checks made before the
 * handler — sign-in, cross-site, a missing key, bad JSON — are not remembered. A 5xx or a crash releases the key, so
 * a retry runs again. A reservation older than 10 minutes with no answer (the process died mid-request) counts as
 * abandoned and may run again: the one window in which an action can repeat, which is why a handler that changes
 * something outside MWA must also check its own state.
 */
const PENDING_STALE_MS = 10 * 60_000;
type Reservation = { go: true } | { replay: { status: number; response: string; headers: string | null } };
function reserve(key: string, caller: string, fingerprint: string, route: string): Reservation {
  const d = appDb();
  return d.transaction((): Reservation => {
    const now = Date.now();
    d.prepare('DELETE FROM idempotency WHERE created_at < ?').run(now - IDEMPOTENCY_TTL_MS);
    const row = d.prepare('SELECT fingerprint, state, status, response, headers, created_at FROM idempotency WHERE key = ? AND device = ?').get(key, caller) as
      { fingerprint: string; state: string; status: number; response: string; headers: string | null; created_at: number } | undefined;
    if (!row) {
      d.prepare(`INSERT INTO idempotency (key, device, route, fingerprint, state, status, response, created_at) VALUES (?, ?, ?, ?, 'pending', 0, 'null', ?)`).run(key, caller, route, fingerprint, now);
      return { go: true };
    }
    if (row.fingerprint !== fingerprint) throw new ApiError(409, 'idempotency_key_reused', 'That Idempotency-Key was already used for a different request.');
    if (row.state === 'done') return { replay: { status: row.status, response: row.response, headers: row.headers } };
    if (now - row.created_at < PENDING_STALE_MS) throw new ApiError(409, 'in_progress', 'That request is still being handled. Try again in a moment.');
    d.prepare('UPDATE idempotency SET created_at = ? WHERE key = ? AND device = ?').run(now, key, caller); // abandoned: run it again
    return { go: true };
  }).immediate();
}
function settle(key: string, caller: string, status: number, response: string, headers?: Record<string, string>): void {
  appDb().prepare(`UPDATE idempotency SET state = 'done', status = ?, response = ?, headers = ? WHERE key = ? AND device = ?`)
    .run(status, response, headers && Object.keys(headers).length ? JSON.stringify(headers) : null, key, caller);
}
function release(key: string, caller: string): void {
  try { appDb().prepare(`DELETE FROM idempotency WHERE key = ? AND device = ? AND state = 'pending'`).run(key, caller); } catch { /* best-effort */ }
}

/**
 * Build the /api/v1 handler. It returns true when it answered the request (any /api/v1 path, including 404s),
 * false when the path is not under /api/v1 (the legacy chain carries on).
 */
export function createV1(routes: Route[], deps: RouterDeps): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const table = routes.map((r) => ({ ...r, match: compile(r.path) }));
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/v1/') && url.pathname !== '/api/v1') return false;
    const sub = url.pathname.slice('/api/v1'.length) || '/';
    const method = (req.method ?? 'GET').toUpperCase();
    const head = method === 'HEAD';
    let reserved: { key: string; caller: string } | null = null;
    let admitted: (() => void) | null = null;
    try {
      const hits = table.map((r) => ({ r, params: r.match(sub) })).filter((h) => h.params);
      // nobody signed in: only a public route answers anything but 401 (no route map for strangers — review of A2)
      if (!hits.some((h) => h.r.scope === 'public') && !deps.authenticate(req)) throw new ApiError(401, 'locked', 'Sign in to continue.');
      if (!hits.length) throw new ApiError(404, 'not_found', 'No such endpoint.');
      const hit = hits.find((h) => h.r.method === (head ? 'GET' : method));
      if (!hit) {
        const allow = hits.map((h) => h.r.method).join(', ');
        send(res, 405, errBody(new ApiError(405, 'method_not_allowed', `Use ${hits.map((h) => h.r.method).join(' or ')}.`)), { allow }, head);
        return true;
      }
      const { r, params } = hit as { r: (typeof table)[number]; params: Record<string, string> };

      // client version: "web/1.4.0" (or "android/0.1.0-beta"); an older client than MIN_CLIENT must reload
      const cv = /^[a-z]+\/(\d+(?:\.\d+){0,2})(?:[-+][\w.-]*)?$/i.exec(String(req.headers['x-mwa-client'] ?? ''))?.[1];
      if (cv && cmpVersion(cv, MIN_CLIENT) < 0) throw new ApiError(426, 'client_too_old', 'A newer version of the app is needed. Reload to update.');

      const who = deps.authenticate(req);
      if (r.scope !== 'public') {
        if (!who) throw new ApiError(401, 'locked', 'Sign in to continue.');
        if (!who.scopes.has(r.scope)) throw new ApiError(403, 'forbidden', 'This device is not allowed to do that. Use the app on your computer, or sign in with the password.');
      }
      const write = r.method !== 'GET';
      // CSRF: only a bearer token cannot be sent by another site's page. A cookie rides along, and so does the trust
      // given to "this machine" (any page open in the owner's browser reaches 127.0.0.1) — review of A2.
      const bearerCall = who?.kind === 'device' && !who.viaCookie;
      if (write && !bearerCall && !deps.sameOrigin(req)) throw new ApiError(403, 'cross_origin', 'Cross-site requests are blocked.');

      const caller = who ? (who.kind === 'device' ? `device:${who.id}` : who.id) : 'anonymous'; // each device: its own key space
      if (r.admit) admitted = r.admit({ req, caller });
      const raw = write ? await readRaw(req, r.rawBody?.max, r.rawBody?.tooLarge) : Buffer.alloc(0);
      const body = write && !r.rawBody ? parseJson(raw) : undefined;
      if (write && r.scope !== 'public') {
        const key = String(req.headers['idempotency-key'] ?? '');
        if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new ApiError(400, 'idempotency_key_required', 'Send an Idempotency-Key header (8–128 letters, digits, . _ : -).');
        const fingerprint = createHash('sha256').update(`${method} ${url.pathname}${url.search}\n`).update(raw).digest('hex');
        const got = reserve(key, caller, fingerprint, `${method} ${r.path}`);
        if ('replay' in got) {
          send(res, got.replay.status, JSON.parse(got.replay.response), { ...(got.replay.headers ? JSON.parse(got.replay.headers) : {}), 'idempotent-replay': 'true' });
          return true;
        }
        reserved = { key, caller };
      }

      let status: number, out: Reply;
      try {
        out = await r.handler({ req, url, params, body, caller, who, ...(r.rawBody ? { raw } : {}) });
        status = out.status ?? 200;
      } catch (e) {
        if (!(e instanceof ApiError) || e.status >= 500) throw e;
        out = { status: e.status, body: errBody(e), transient: e.transient }; status = e.status; // a refusal the handler concluded: remembered (unless transient)
      }
      if (out.stream && !write) {
        res.writeHead(status, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no', connection: 'keep-alive', ...out.headers });
        if (head) { res.end(); return true; }
        out.stream(res, req);
        return true;
      }
      if (out.raw && !write) {
        res.writeHead(status, { 'content-type': out.raw.contentType, 'cache-control': 'no-store', ...out.headers });
        res.end(head ? undefined : out.raw.body);
        return true;
      }
      const text = JSON.stringify(out.body === undefined ? null : out.body); // throws before anything is sent
      if (reserved) {
        if (status < 500 && !out.transient) settle(reserved.key, reserved.caller, status, text, out.headers); else release(reserved.key, reserved.caller);
        reserved = null;
      }
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...out.headers });
      res.end(head ? undefined : text);
    } catch (e) {
      if (reserved) release(reserved.key, reserved.caller);
      if (res.headersSent) { res.destroy(); return true; }
      if (e instanceof ApiError && e.status === 413 && !req.complete) {
        // W5 security review: a body over the limit (chunked, or a declared length) gets a clean 413. The rest of the
        // body is read and dropped so the client sees the answer instead of a reset — but at most 64 MB or 30 s more,
        // then the connection is cut.
        if ((e as { declared?: boolean }).declared) {
          // a declared length over the limit: read and drop what comes (64 MB at most), answer once it has all come or
          // nothing has for 3 s, and close the connection (a client that declared more than it sent must not reuse it)
          let dropped = 0, answered = false;
          const answer = () => {
            if (answered) return; answered = true; clearTimeout(idle);
            res.writeHead(413, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', connection: 'close' });
            res.end(JSON.stringify(errBody(e)));
          };
          let idle = setTimeout(answer, 3_000);
          req.on('data', (c: Buffer) => {
            dropped += c.length;
            clearTimeout(idle); idle = setTimeout(answer, 3_000);
            if (dropped > 64 * 1024 * 1024) { answer(); setTimeout(() => req.destroy(), 1000).unref?.(); }
          });
          req.on('end', answer);
          req.on('close', () => clearTimeout(idle));
          req.resume();
          return true;
        }
        res.writeHead(413, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(errBody(e)));
        let dropped = 0;
        const cut = setTimeout(() => req.destroy(), 30_000); cut.unref?.();
        req.on('data', (c: Buffer) => { dropped += c.length; if (dropped > 64 * 1024 * 1024) req.destroy(); });
        req.on('end', () => clearTimeout(cut)); req.on('close', () => clearTimeout(cut));
        req.resume();
      } else if (e instanceof ApiError) send(res, e.status, errBody(e), {}, head);
      else {
        logger.error('api', 'v1 handler failed', { path: url.pathname, error: (e as Error).message.slice(0, 200) });
        send(res, 500, errBody(new ApiError(500, 'internal', 'Something went wrong on the server.')), {}, head);
      }
    } finally {
      if (admitted) admitted();
    }
    return true;
  };
}
