/**
 * Fixture mode as Vite middleware (v2 build, slice W1). With `MWA_FIXTURES=1`, `vite` (dev) and `vite preview`
 * answer /api/v1/* from the FixtureServer instead of proxying to `mwa serve` — the real client, the real EventSource
 * and the real IndexedDB cache run against the prototype's example day. The legacy /api/* still proxies (dev).
 *
 *   MWA_FIXTURES=1 npm run dev:ui            → http://localhost:5179/?ui=v2
 *   MWA_FIXTURES=1 MWA_FIXTURE_SCENARIO=N06 npm run dev:ui
 *   npm run build:ui && MWA_FIXTURES=1 npx vite preview --config web/vite.config.ts
 *
 * The scenario belongs to the server (one world shared by every tab, like a real server): restart with
 * MWA_FIXTURE_SCENARIO to change it, or POST /__fixtures/reset?scenario=N06 (the Playwright smoke run does).
 */
import type { Plugin, Connect } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { FixtureServer } from './fixtures';

export function mwaFixtures(opts: { enabled: boolean; scenario?: string }): Plugin {
  let server = new FixtureServer(opts.scenario ?? 'N00');
  const handler: Connect.NextHandleFunction = (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/__fixtures/reset' && req.method === 'POST') {
      server = new FixtureServer(url.searchParams.get('scenario') ?? opts.scenario ?? 'N00');
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ scenario: server.scenario }));
      return;
    }
    if (!url.pathname.startsWith('/api/v1/')) { next(); return; }
    void serve(server, url, req, res);
  };
  return {
    name: 'mwa-v2-fixtures',
    apply: () => opts.enabled,
    configureServer(s) { s.middlewares.use(handler); },
    configurePreviewServer(s) { s.middlewares.use(handler); },
  };
}

async function serve(fx: FixtureServer, url: URL, req: IncomingMessage, res: ServerResponse) {
  const path = url.pathname.slice('/api/v1'.length);
  const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v]));
  if (path === '/stream' && req.method === 'GET') {
    const cursor = Number(headers['last-event-id'] ?? url.searchParams.get('cursor') ?? 0) || 0;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    const off = fx.openStream(cursor, (m) => { res.write(`${m.id !== undefined ? `id: ${m.id}\n` : ''}event: ${m.event}\ndata: ${JSON.stringify(m.data)}\n\n`); });
    const keep = setInterval(() => res.write(': keepalive\n\n'), 15_000);
    req.on('close', () => { clearInterval(keep); off(); });
    return;
  }
  let body: unknown;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    const raw = Buffer.concat(chunks).toString('utf8');
    if (raw) { try { body = JSON.parse(raw); } catch { send(res, 400, { error: { code: 'bad_json', message: 'The request body is not valid JSON.' } }); return; } }
  }
  const r = fx.handle({ method: req.method ?? 'GET', path, query: url.searchParams, headers, body });
  // S5: a file (the memory export, the spending CSV) goes as it is, with its own content type
  if (r.text !== undefined) { res.writeHead(r.status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...(r.headers ?? {}) }); res.end(r.text); return; }
  send(res, r.status, r.body, r.headers);
}
function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}
