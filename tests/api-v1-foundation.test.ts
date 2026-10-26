// v2 build, slice A0: app.db, the /api/v1 router (over real HTTP), /meta, and connector token paths.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { appDb, resetAppDb, migrate, recordEvent, appDbPath, type Migration } from '../src/v2/db.js';
import { createV1, cmpVersion, MIN_CLIENT, type Route } from '../src/api/router.js';
import { v1Routes, secureContext } from '../src/api/v1.js';
import { connectorTokenPath } from '../src/paths.js';

describe('app.db', () => {
  beforeEach(() => resetAppDb(':memory:'));
  it('lives beside the agent DB, in memory under vitest, or where MWA_APP_DB says', () => {
    expect(appDbPath({ MWA_DB: '/x/data/agent.db' })).toBe(join('/x/data', 'app.db'));
    expect(appDbPath({ VITEST: '1' })).toBe(':memory:');
    expect(appDbPath({ MWA_APP_DB: '/y/app.db', VITEST: '1' })).toBe('/y/app.db');
  });
  it('applies each migration once, in order, and re-running changes nothing', () => {
    const d = appDb();
    const steps: Migration[] = [{ name: 't1', sql: 'CREATE TABLE t (a INTEGER)' }, { name: 't2', sql: 'ALTER TABLE t ADD COLUMN b TEXT' }];
    expect(migrate(d, steps)).toEqual(['t1', 't2']);
    expect(migrate(d, steps)).toEqual([]);
    const cols = (d.prepare('PRAGMA table_info(t)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(['a', 'b']);
  });
  it('a failing migration leaves nothing half-applied', () => {
    const d = appDb();
    expect(() => migrate(d, [{ name: 'bad', sql: 'CREATE TABLE ok1 (a INTEGER); THIS IS NOT SQL;' }])).toThrow();
    expect((d.prepare(`SELECT count(*) n FROM migrations WHERE name='bad'`).get() as { n: number }).n).toBe(0);
    expect((d.prepare(`SELECT count(*) n FROM sqlite_master WHERE name='ok1'`).get() as { n: number }).n).toBe(0);
  });
  it('events get increasing sequence numbers (the sync cursor)', () => {
    const a = recordEvent({ entity: 'job', id: 'j1' }), b = recordEvent({ entity: 'job', id: 'j1', op: 'delete' });
    expect(b).toBeGreaterThan(a);
    expect(appDb().prepare('SELECT op FROM events WHERE seq = ?').get(b)).toEqual({ op: 'delete' });
  });
});

// A router on a real port, with test routes and controllable auth.
let server: Server, base = '';
const state = { authed: true, sameOrigin: true, calls: 0 };
const testRoutes: Route[] = [
  ...v1Routes(),
  { method: 'GET', path: '/things/{id}', scope: 'read', handler: ({ params }) => ({ body: { id: params.id } }) },
  { method: 'POST', path: '/things/{id}/poke', scope: 'act', handler: ({ params, body }) => { state.calls++; return { status: 201, body: { id: params.id, n: state.calls, got: body } }; } },
  { method: 'POST', path: '/boom', scope: 'act', handler: () => { throw new Error('kaboom'); } },
];
async function start(): Promise<void> {
  const v1 = createV1(testRoutes, { authed: () => state.authed, sameOrigin: () => state.sameOrigin });
  server = createServer(async (req, res) => { if (!(await v1(req, res))) { res.writeHead(418); res.end('legacy'); } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
const j = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => null), headers: r.headers });

describe('/api/v1 router over HTTP', () => {
  beforeEach(async () => { resetAppDb(':memory:'); Object.assign(state, { authed: true, sameOrigin: true, calls: 0 }); if (!server) await start(); });
  afterAll(() => server?.close());

  it('leaves non-v1 paths to the legacy chain', async () => {
    expect((await fetch(`${base}/api/status`)).status).toBe(418);
  });
  it('/meta is public and says the API version, the oldest client accepted and whether the context is secure', async () => {
    state.authed = false;
    const r = await j(await fetch(`${base}/api/v1/meta`));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ api: 'v1', minClient: MIN_CLIENT, secure: true }); // 127.0.0.1 is a secure context
    expect(typeof r.body.server).toBe('string');
    expect(r.headers.get('cache-control')).toBe('no-store');
  });
  it('matches path params, 404s unknown paths and 405s the wrong method', async () => {
    expect((await j(await fetch(`${base}/api/v1/things/a%20b`))).body).toEqual({ id: 'a b' });
    const nf = await j(await fetch(`${base}/api/v1/nope`));
    expect(nf).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } });
    const na = await fetch(`${base}/api/v1/meta`, { method: 'POST' });
    expect(na.status).toBe(405);
    expect(na.headers.get('allow')).toBe('GET');
  });
  it('refuses a caller who is not signed in', async () => {
    state.authed = false;
    expect(await j(await fetch(`${base}/api/v1/things/1`))).toMatchObject({ status: 401, body: { error: { code: 'locked' } } });
  });
  it('refuses a cross-site write', async () => {
    state.sameOrigin = false;
    const r = await j(await fetch(`${base}/api/v1/things/1/poke`, { method: 'POST', headers: { 'idempotency-key': 'k-cross-0001' } }));
    expect(r).toMatchObject({ status: 403, body: { error: { code: 'cross_origin' } } });
    expect(state.calls).toBe(0);
  });
  it('a write needs an Idempotency-Key, and a retry with the same key gets the first answer without acting twice', async () => {
    expect((await j(await fetch(`${base}/api/v1/things/1/poke`, { method: 'POST' }))).body.error.code).toBe('idempotency_key_required');
    const send = () => fetch(`${base}/api/v1/things/1/poke`, { method: 'POST', headers: { 'idempotency-key': 'k-retry-0001', 'content-type': 'application/json' }, body: JSON.stringify({ x: 1 }) });
    const first = await j(await send()), second = await j(await send());
    expect(first).toMatchObject({ status: 201, body: { id: '1', n: 1, got: { x: 1 } } });
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers.get('idempotent-replay')).toBe('true');
    expect(state.calls).toBe(1);
  });
  it('the same key on a different request is a conflict, not a replay', async () => {
    await fetch(`${base}/api/v1/things/1/poke`, { method: 'POST', headers: { 'idempotency-key': 'k-reuse-0001' } });
    const r = await j(await fetch(`${base}/api/v1/boom`, { method: 'POST', headers: { 'idempotency-key': 'k-reuse-0001' } }));
    expect(r).toMatchObject({ status: 409, body: { error: { code: 'idempotency_key_reused' } } });
  });
  it('bad JSON is a 400; a handler crash is a plain 500 and is not remembered as the answer', async () => {
    const bad = await j(await fetch(`${base}/api/v1/things/1/poke`, { method: 'POST', headers: { 'idempotency-key': 'k-badjson-01', 'content-type': 'application/json' }, body: '{oops' }));
    expect(bad).toMatchObject({ status: 400, body: { error: { code: 'bad_json' } } });
    const boom = await j(await fetch(`${base}/api/v1/boom`, { method: 'POST', headers: { 'idempotency-key': 'k-boom-00001' } }));
    expect(boom).toMatchObject({ status: 500, body: { error: { code: 'internal', message: 'Something went wrong on the server.' } } });
    expect(JSON.stringify(boom.body)).not.toContain('kaboom');
    expect((appDb().prepare(`SELECT count(*) n FROM idempotency WHERE key='k-boom-00001'`).get() as { n: number }).n).toBe(0);
  });
  it('an older client than the minimum is told to reload (426)', async () => {
    const r = await j(await fetch(`${base}/api/v1/things/1`, { headers: { 'x-mwa-client': 'web/0.1.0' } }));
    expect(r).toMatchObject({ status: 426, body: { error: { code: 'client_too_old' } } });
    expect((await fetch(`${base}/api/v1/things/1`, { headers: { 'x-mwa-client': `web/${MIN_CLIENT}` } })).status).toBe(200);
  });
});

describe('helpers', () => {
  it('compares versions', () => {
    expect(cmpVersion('1.2.0', '1.10.0')).toBe(-1);
    expect(cmpVersion('2', '1.9.9')).toBe(1);
    expect(cmpVersion('1.0', '1.0.0')).toBe(0);
  });
  it('a secure context is https (direct or forwarded) or this machine; a Tailscale IP over http is not', () => {
    const req = (host: string, proto?: string) => ({ headers: { host, ...(proto ? { 'x-forwarded-proto': proto } : {}) }, socket: {} }) as never;
    expect(secureContext(req('localhost:7788'))).toBe(true);
    expect(secureContext(req('box.tail1234.ts.net', 'https'))).toBe(true);
    expect(secureContext(req('100.101.102.103:7788'))).toBe(false);
  });
  it('a connector token is read from the data folder, but an old token in ./data keeps working', () => {
    const d = mkdtempSync(join(tmpdir(), 'mwa-tok-'));
    expect(connectorTokenPath('google-token.json', 'MWA_GOOGLE_TOKEN', { MWA_DATA_DIR: d })).toBe(join(d, 'google-token.json'));
    expect(connectorTokenPath('google-token.json', 'MWA_GOOGLE_TOKEN', { MWA_DATA_DIR: d, MWA_GOOGLE_TOKEN: '/t/g.json' })).toBe(resolve('/t/g.json'));
    mkdirSync(join(d, 'sub'), { recursive: true });
    writeFileSync(join(d, 'google-token.json'), '{}');
    expect(connectorTokenPath('google-token.json', 'MWA_GOOGLE_TOKEN', { MWA_DATA_DIR: d })).toBe(join(d, 'google-token.json'));
  });
});

// Review of A0 (2026-10-26): each finding, pinned.
describe('review findings', () => {
  let srv: Server, b = '';
  const st = { calls: 0, gate: null as null | Promise<void>, open: () => {} };
  const routes: Route[] = [
    ...v1Routes(),
    { method: 'POST', path: '/slow/{id}', scope: 'act', handler: async ({ params }) => { st.calls++; await st.gate; return { status: 201, body: { id: params.id, n: st.calls } }; } },
    { method: 'POST', path: '/refuse', scope: 'act', handler: () => { st.calls++; return { status: 409, body: { error: { code: 'busy', message: 'Busy.' } } }; } },
    { method: 'POST', path: '/empty', scope: 'act', handler: () => { st.calls++; return { status: 201, headers: { location: '/api/v1/things/9' } }; } },
    { method: 'GET', path: '/g/{id}', scope: 'read', handler: ({ params }) => ({ body: { id: params.id } }) },
  ];
  beforeEach(async () => {
    resetAppDb(':memory:'); st.calls = 0; st.gate = null;
    if (!srv) {
      const v1 = createV1(routes, { authed: () => true, sameOrigin: () => true });
      srv = createServer(async (req, res) => { if (!(await v1(req, res))) { res.writeHead(418); res.end(); } });
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
      b = `http://127.0.0.1:${(srv.address() as { port: number }).port}/api/v1`;
    }
  });
  afterAll(() => srv?.close());
  const post = (path: string, key: string, body?: unknown) => fetch(b + path, { method: 'POST', headers: { 'idempotency-key': key, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

  it('two identical requests at once act ONCE: the second is told it is in progress, a later retry gets the answer', async () => {
    st.gate = new Promise<void>((r) => { st.open = r; });
    const first = post('/slow/1', 'k-concurrent-1');
    await new Promise((r) => setTimeout(r, 50));
    const second = await j(await post('/slow/1', 'k-concurrent-1'));
    expect(second).toMatchObject({ status: 409, body: { error: { code: 'in_progress' } } });
    st.open();
    expect((await j(await first)).status).toBe(201);
    const third = await j(await post('/slow/1', 'k-concurrent-1'));
    expect(third.status).toBe(201);
    expect(third.headers.get('idempotent-replay')).toBe('true');
    expect(st.calls).toBe(1);
  });
  it('a key is bound to the exact request: another item or another body is a 409, never a false success', async () => {
    await post('/slow/1', 'k-bound-0001');
    expect((await j(await post('/slow/2', 'k-bound-0001'))).body.error.code).toBe('idempotency_key_reused');
    expect((await j(await post('/slow/1', 'k-bound-0001', { other: 1 }))).body.error.code).toBe('idempotency_key_reused');
    expect(st.calls).toBe(1);
  });
  it('a refusal the handler concluded is replayed, not re-run', async () => {
    const a1 = await j(await post('/refuse', 'k-refuse-001')), a2 = await j(await post('/refuse', 'k-refuse-001'));
    expect([a1.status, a2.status, a2.headers.get('idempotent-replay')]).toEqual([409, 409, 'true']);
    expect(st.calls).toBe(1);
  });
  it('an empty answer is JSON null every time, and its headers come back on a replay', async () => {
    const r1 = await post('/empty', 'k-empty-0001'), r2 = await post('/empty', 'k-empty-0001');
    expect(await r1.text()).toBe('null');
    expect(await r2.text()).toBe('null');
    expect(r1.headers.get('location')).toBe('/api/v1/things/9');
    expect(r2.headers.get('location')).toBe('/api/v1/things/9');
  });
  it('an expired answer is not replayed', async () => {
    await post('/empty', 'k-expire-001');
    appDb().prepare(`UPDATE idempotency SET created_at = ? WHERE key = 'k-expire-001'`).run(Date.now() - 49 * 3_600_000);
    expect((await post('/empty', 'k-expire-001')).headers.get('idempotent-replay')).toBeNull();
    expect(st.calls).toBe(2);
  });
  it('a reservation abandoned for 10+ minutes may run again', async () => {
    const fp = createHash('sha256').update('POST /api/v1/empty\n').digest('hex');
    appDb().prepare(`INSERT INTO idempotency (key, device, route, fingerprint, state, status, response, created_at) VALUES ('k-stale-0001','session','x', ?, 'pending', 0, 'null', ?)`).run(fp, Date.now() - 11 * 60_000);
    expect((await post('/empty', 'k-stale-0001')).status).toBe(201);
    expect(st.calls).toBe(1);
  });
  it('a malformed or slash-bearing id is a 400, not a 500', async () => {
    expect((await j(await fetch(`${b}/g/%E0%A4%A`))).body.error.code).toBe('bad_path');
    expect((await j(await fetch(`${b}/g/a%2F..%2Fb`))).body.error.code).toBe('bad_path');
  });
  it('HEAD works where GET does; /api/v1 itself is answered by the API; a prerelease client version is understood', async () => {
    const h = await fetch(`${b}/meta`, { method: 'HEAD' });
    expect(h.status).toBe(200);
    expect(await h.text()).toBe('');
    expect((await j(await fetch(b))).body.error.code).toBe('not_found');
    expect((await fetch(`${b}/g/1`, { headers: { 'x-mwa-client': 'android/0.0.9-beta' } })).status).toBe(426);
    expect((await fetch(`${b}/g/1`, { headers: { 'x-mwa-client': 'android/1.0.0-beta' } })).status).toBe(200);
  });
  it('a migration that rebuilds a parent table keeps its children (foreign keys are off while migrating)', () => {
    const d = appDb();
    migrate(d, [{ name: 'p1', sql: 'CREATE TABLE parent (id INTEGER PRIMARY KEY, a TEXT); CREATE TABLE child (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES parent(id) ON DELETE CASCADE); INSERT INTO parent VALUES (1, 1); INSERT INTO child VALUES (1, 1);' }]);
    migrate(d, [{ name: 'p2', sql: 'CREATE TABLE parent_new (id INTEGER PRIMARY KEY, a TEXT, b TEXT); INSERT INTO parent_new (id, a) SELECT id, a FROM parent; DROP TABLE parent; ALTER TABLE parent_new RENAME TO parent;' }]);
    expect((d.prepare('SELECT count(*) n FROM child').get() as { n: number }).n).toBe(1);
    expect(d.pragma('foreign_keys', { simple: true })).toBe(1);
  });
  it('a migration that breaks a reference is refused and rolled back', () => {
    const d = appDb();
    migrate(d, [{ name: 'r1', sql: 'CREATE TABLE p (id INTEGER PRIMARY KEY); CREATE TABLE c (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES p(id)); INSERT INTO p VALUES (1); INSERT INTO c VALUES (1, 1);' }]);
    expect(() => migrate(d, [{ name: 'r2', sql: 'DELETE FROM p' }])).toThrow(/broken reference/);
    expect((d.prepare('SELECT count(*) n FROM p').get() as { n: number }).n).toBe(1);
  });
});
