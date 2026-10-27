/**
 * The legacy server's doors, made testable (v2 build, slice W5).
 *
 * 1. Which pages load with nobody signed in (MWA_ACCESS_PASSWORD set, no session). Until W5 the legacy gate answered
 *    every page with its own login form, so the v2 app could not show its sign-in screen, and a phone opening the
 *    pairing link got a password form instead of "Pair this phone". Now the app's page loads for /pair, for the v2
 *    app (?ui=v2), and for a browser holding a valid paired-device cookie; the app's own files (scripts, styles, icons,
 *    the manifest) load too — none of them holds data. The data stays behind /api, which still asks.
 *
 * 2. The legacy /api/files/* routes (BL-70). With no password they had no caller check at all (review of W4): a
 *    paired phone — or anything on the network when bound beyond localhost — could list, read, share, upload and
 *    delete. They now take the same callers as /api/v1, password or not: the password session, this machine (no
 *    password), or a paired device; reading needs `read`, changing needs `act`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import type { Caller } from './auth.js';
import type { Scope } from './router.js';
import { listFiles, insideRoot, fileHeaders, saveUpload, deleteFile, sessionFolder, MAX_UPLOAD, readShares, createShare, revokeShare } from '../files.js';
import { exportFormats } from '../doc-export.js';

/** The app's own built files a signed-out browser may load (no data in any of them). HTML pages are not on the list:
 *  a page is the app shell, and only the routes below get it. */
const APP_FILE = /^\/[\w.-]+\.(js|css|svg|png|ico|webmanifest|json|woff2?|txt)$/i;

/**
 * True when a page request may be answered with the app (index.html) although nobody is signed in: the pairing page,
 * the v2 app, or a browser that holds a paired device's cookie (`hasDevice`, checked against the database).
 */
export function signedOutPageAllowed(pathname: string, search: string, hasDevice: boolean): boolean {
  if (pathname.startsWith('/api/')) return false;
  if (pathname === '/pair' || pathname === '/pair/') return true;
  if (APP_FILE.test(pathname) && !pathname.endsWith('.html')) return true;
  const q = new URLSearchParams(search);
  if (q.get('ui') === 'v2') return true;
  if (hasDevice && (pathname === '/' || !extname(pathname))) return true;
  return false;
}

/**
 * The scope a legacy /api/* request needs (W5 security review, finding 6). Until W5, with no password, every legacy
 * route answered anyone who could reach the port — through a relay or a tailnet that meant anyone on it. Now every
 * one takes the same callers as /api/v1 (the password session, this machine, or a paired device), password or not:
 *   - public (explicit list): the liveness probe, signing in, and share links (the token is the permission);
 *   - admin: secrets, memory export and editing, logs, connections, models, setup, billing settings, step-up,
 *     routines, the inbox scan, opening the machine's browser — what Settings would gate;
 *   - approve: confirming or cancelling an approval;
 *   - act: anything that changes something, and the GETs that start work (the chat, its live stream);
 *   - read: every other GET.
 * /api/v1 and /api/files answer for themselves. Unknown paths default by method (GET read, else act).
 */
const PUBLIC_API = [/^\/api\/health$/, /^\/api\/login$/, /^\/api\/share\//];
const ADMIN_API = [
  /^\/api\/vault(\/|$)/, /^\/api\/memory\/(export|forget|correct)$/, /^\/api\/logs$/, /^\/api\/connections$/, /^\/api\/save$/,
  /^\/api\/setup(\/|$)/, /^\/api\/models$/, /^\/api\/onboard\//, /^\/api\/billing\/budget$/, /^\/api\/billing\.csv$/, /^\/api\/stepup\//,
  /^\/api\/policies\/forget$/, /^\/api\/routines\/(promote|retire)$/, /^\/api\/ingest$/, /^\/api\/open$/,
];
const APPROVE_API = [/^\/api\/approvals\/(confirm|cancel)$/];
const ACTING_GETS = [/^\/api\/chat$/]; // starts a run (an EventSource GET); /chat/live and /chat/attach only watch one
export function legacyApiScope(method: string, path: string): Scope | 'public' {
  const m = method.toUpperCase();
  if (PUBLIC_API.some((r) => r.test(path))) return 'public';
  if (ADMIN_API.some((r) => r.test(path))) return 'admin';
  if (APPROVE_API.some((r) => r.test(path))) return 'approve';
  if (m === 'POST' && path === '/api/quiet') return 'admin';
  if (m === 'GET' || m === 'HEAD') return ACTING_GETS.some((r) => r.test(path)) ? 'act' : 'read';
  return 'act';
}

/** The scope a legacy files request needs: GET/HEAD read; anything that changes something act. */
export function legacyFilesScope(method: string): Scope { return method === 'GET' || method === 'HEAD' ? 'read' : 'act'; }

export interface LegacyFilesDeps {
  root: () => string;
  authenticate: (req: IncomingMessage) => Caller | null;
  sameOrigin: (req: IncomingMessage) => boolean;
  /** BL-70: a document converted for download (serve.ts sendExport) */
  sendExport: (res: ServerResponse, abs: string, format: string) => Promise<void>;
}

async function readJson(req: AsyncIterable<Buffer | string>): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const c of req) { const b = typeof c === 'string' ? Buffer.from(c, 'utf8') : c; size += b.length; if (size > 100_000) break; chunks.push(b); }
  try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

/** /api/files/*. Answers every path under it (404 for an unknown one). */
export async function handleLegacyFiles(req: IncomingMessage, res: ServerResponse, url: URL, deps: LegacyFilesDeps): Promise<void> {
  const p = url.pathname;
  const json = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  const method = (req.method ?? 'GET').toUpperCase();
  const who = deps.authenticate(req);
  if (!who) { json(401, { error: 'locked', message: 'Sign in to continue.' }); return; }
  const need = legacyFilesScope(method);
  if (!who.scopes.has(need)) { json(403, { error: 'forbidden', message: 'This device is not allowed to do that. Use the app on your computer, or sign in with the password.' }); return; }
  const root = deps.root();
  if (p === '/api/files' && method === 'GET') { json(200, { files: listFiles(root).map((f) => ({ ...f, formats: exportFormats(f.path) })) }); return; }
  if (p === '/api/files/raw' && (method === 'GET' || method === 'HEAD')) {
    const abs = insideRoot(root, url.searchParams.get('path') ?? '');
    if (!abs || !existsSync(abs) || !statSync(abs).isFile()) { json(404, { error: 'not found' }); return; }
    res.writeHead(200, fileHeaders(abs, statSync(abs).size, url.searchParams.get('download') === '1'));
    if (method === 'HEAD') { res.end(); return; }
    createReadStream(abs).pipe(res);
    return;
  }
  if (p === '/api/files/export' && method === 'GET') {
    const abs = insideRoot(root, url.searchParams.get('path') ?? '');
    if (!abs || !existsSync(abs) || !statSync(abs).isFile()) { json(404, { error: 'not found' }); return; }
    await deps.sendExport(res, abs, url.searchParams.get('format') ?? '');
    return;
  }
  if (p === '/api/files/shares' && method === 'GET') {
    const path = url.searchParams.get('path');
    json(200, { shares: readShares(root).filter((x) => !path || x.path === path) });
    return;
  }
  // a cookie (the session, a device) and "this machine" ride along on another site's request: same-origin only. A
  // bearer token cannot be sent by another site's page.
  if (method === 'POST' && !(who.kind === 'device' && !who.viaCookie) && !deps.sameOrigin(req)) { json(403, { ok: false, error: 'cross-origin request blocked' }); return; }
  if (p === '/api/files/share' && method === 'POST') {
    const b = await readJson(req);
    const share = createShare(root, String(b.path ?? ''), Number(b.days ?? 7));
    json(share ? 200 : 404, share ? { ok: true, share } : { ok: false, message: 'No such file.' });
    return;
  }
  if (p === '/api/files/unshare' && method === 'POST') {
    const b = await readJson(req);
    json(200, { ok: revokeShare(root, String(b.token ?? '')) });
    return;
  }
  if (p === '/api/files/upload' && method === 'POST') {
    // The body is the file itself; name and chat come in the query. Capped while reading.
    const folder = `${sessionFolder(url.searchParams.get('session') || 'default')}/uploads`;
    const chunks: Buffer[] = []; let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_UPLOAD) { json(413, { ok: false, message: `Too big: the limit is ${Math.round(MAX_UPLOAD / 1048576)} MB.` }); req.destroy(); return; }
      chunks.push(c as Buffer);
    }
    try { json(200, { ok: true, path: saveUpload(root, folder, url.searchParams.get('name') ?? 'upload', Buffer.concat(chunks)) }); }
    catch (e) { json(400, { ok: false, message: (e as Error).message }); }
    return;
  }
  if (p === '/api/files/delete' && method === 'POST') {
    const b = await readJson(req);
    json(200, { ok: deleteFile(root, String(b.path ?? '')) });
    return;
  }
  json(404, { error: 'not found' });
}
