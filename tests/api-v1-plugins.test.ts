// v2 build, slice S1: the plug-in routes (src/api/routes/plugins.ts) over HTTP with the real caller resolver
// (src/api/auth.ts): who may change what, that no key value or env value ever comes back, that only a plug-in's own
// key names are taken, removing your own, and the npm review → approve gates. No network, no model, no real .env:
// keys go to a map and the reviewer is a stub.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createV1 } from '../src/api/router.js';
import { v1Routes } from '../src/api/v1.js';
import { makeAuthenticate, createPairCode, redeemPairCode } from '../src/api/auth.js';
import { resetAppDb } from '../src/v2/db.js';
import { setPluginRouteDeps, redactArgs } from '../src/api/routes/plugins.js';
import { addMcpServer, listMcpServers } from '../src/connectors/registry.js';
import { loadConfig } from '../src/config.js';
import type { RiskReport, Verdict } from '../src/installer/review.js';

const NET = { 'x-forwarded-for': '100.64.0.7' };
const as = (token: string) => ({ ...NET, authorization: `Bearer ${token}` });
let server: Server, base = '', cfgDir = '';
let n = 0;
const key = () => `s1-key-${Date.now()}-${++n}`;
const j = async (r: Response) => ({ status: r.status, text: '', body: await r.json().catch(() => null) as any });
const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method, headers: { 'idempotency-key': key(), 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }).then(j);
const get = (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers }).then(async (r) => ({ status: r.status, text: await r.text() }));

const env = new Map<string, string>();
const installs: Record<string, unknown>[] = [];
let now = 1_800_000_000_000;
let policy: string | undefined, reviewer = 'anthropic:claude-sonnet-5', verdict: Verdict = 'safe', analysisOk = true;
const reviewed: string[] = [];
const report = (pkg: string): RiskReport => ({
  source: pkg, verdict, summary: 'A small server that reads web pages.', capabilities: ['reads web pages'], redFlags: verdict === 'safe' ? [] : ['obfuscated code'],
  analysis: analysisOk ? { ok: true, findings: [] } : { ok: false, error: 'not found', findings: [] },
  deepScan: { ran: true, integrityOk: true, filesScanned: 12, findings: [] }, integrity: 'sha512-abc', pinnedVersion: analysisOk ? '2.0.1' : undefined, model: reviewer,
});

function device(scopes: ('read' | 'act' | 'approve' | 'admin')[]): string {
  const { code } = createPairCode('test', scopes);
  return redeemPairCode(code, 'Pixel', 'android')!.token;
}

const SAVED_ENV = process.env.MWA_CONFIG_PATH;
beforeAll(async () => {
  const authenticate = makeAuthenticate({ passwordSet: false, sessionValid: () => false });
  const sameOrigin = (req: { headers: Record<string, unknown> }) => !req.headers.origin;
  const v1 = createV1(v1Routes(), { authenticate, sameOrigin: sameOrigin as never });
  server = createServer(async (req, res) => { if (!(await v1(req, res))) { res.writeHead(404); res.end(); } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
});
beforeEach(() => {
  resetAppDb(':memory:');
  cfgDir = mkdtempSync(join(tmpdir(), 'mwa-s1-cfg-'));
  process.env.MWA_CONFIG_PATH = join(cfgDir, 'mwa.config.json');
  writeFileSync(process.env.MWA_CONFIG_PATH, '{}\n');
  env.clear(); installs.length = 0; reviewed.length = 0;
  policy = undefined; reviewer = 'anthropic:claude-sonnet-5'; verdict = 'safe'; analysisOk = true; now = 1_800_000_000_000;
  setPluginRouteDeps({
    saveEnv: (kv) => { for (const [k, v] of Object.entries(kv)) env.set(k, v); },
    hasEnv: (name) => env.has(name),
    config: () => { const c = loadConfig(); return { ...c, models: { ...c.models, installer: reviewer }, tools: { ...c.tools, installPolicy: policy as never } }; },
    review: async (pkg) => { reviewed.push(pkg); return report(pkg); },
    logInstall: (line) => { installs.push(line); },
    now: () => now,
  });
});
afterAll(() => {
  server?.close(); setPluginRouteDeps(null);
  if (SAVED_ENV === undefined) delete process.env.MWA_CONFIG_PATH; else process.env.MWA_CONFIG_PATH = SAVED_ENV;
});

describe('who may see and change plug-ins', () => {
  it('a paired phone reads the list but every change is 403; this machine (admin) may change', async () => {
    const phone = device(['read', 'act', 'approve']);
    const list = await get('/plugins', as(phone));
    expect(list.status).toBe(200);
    expect(JSON.parse(list.text).plugins.length).toBe(9);
    const changes: [string, string, unknown?][] = [
      ['POST', '/plugins/fetch/enable'], ['POST', '/plugins/search/disable'], ['PUT', '/plugins/tavily/keys', { keys: { TAVILY_API_KEY: 'tvly-x' } }],
      ['DELETE', '/plugins/my-tool'], ['POST', '/plugins/review', { package: 'example-mcp' }], ['POST', '/plugins/approve', { package: 'example-mcp' }],
    ];
    for (const [m, p, b] of changes) {
      const r = await send(m, p, b, as(phone));
      expect(r.status, `${m} ${p}`).toBe(403);
      expect(r.body.error.code).toBe('forbidden');
    }
    expect(env.size).toBe(0);
    expect(reviewed).toEqual([]);
    expect((await send('POST', '/plugins/fetch/enable')).status).toBe(200);
    expect((await send('POST', '/plugins/fetch/enable', undefined, as(device(['read', 'act', 'approve', 'admin'])))).status).toBe(200);
  });
  it('a stranger from the network gets 401 even for the list', async () => {
    expect((await get('/plugins', NET)).status).toBe(401);
  });
  it('a change from another site is refused (cross-origin)', async () => {
    const r = await send('POST', '/plugins/fetch/enable', undefined, { origin: 'http://evil.example' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('cross_origin');
    expect(Object.keys(listMcpServers())).not.toContain('fetch');
  });
});

describe('the list', () => {
  it('library plug-ins with what they can touch, on/off, and key names only; web search is on by default', async () => {
    const r = JSON.parse((await get('/plugins')).text);
    const search = r.plugins.find((p: any) => p.id === 'search');
    expect(search).toMatchObject({ on: true, access: 'Sends search queries to the web. No account, no files.', tier: 'curated', missing: [] });
    expect(search.keys).toEqual([expect.objectContaining({ name: 'BRAVE_API_KEY', optional: true, saved: false })]);
    expect(r.plugins.find((p: any) => p.id === 'github')).toMatchObject({ on: false, missing: ['GITHUB_PERSONAL_ACCESS_TOKEN'] });
    expect(r.applies).toMatch(/next message/);
    expect(r.addFromNpm).toMatchObject({ available: true, reviewer: 'anthropic:claude-sonnet-5' });
  });
  it('never sends a saved key, an env value, or a secret-looking argument', async () => {
    await send('PUT', '/plugins/github/keys', { keys: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_SUPERSECRETVALUE123' } });
    addMcpServer('my-tool', { command: 'node', args: ['tool.mjs', '--token', 'plainsecretword', '--api-key=k-123', 'sk-abcdefghijklmnop'], env: { MY_TOOL_TOKEN: 'env-secret-value' } });
    const text = (await get('/plugins')).text;
    for (const secret of ['ghp_SUPERSECRETVALUE123', 'plainsecretword', 'k-123', 'sk-abcdefghijklmnop', 'env-secret-value']) expect(text).not.toContain(secret);
    const r = JSON.parse(text);
    expect(r.plugins.find((p: any) => p.id === 'github').keys[0]).toMatchObject({ name: 'GITHUB_PERSONAL_ACCESS_TOKEN', saved: true });
    expect(r.custom).toEqual([{ id: 'my-tool', command: 'node tool.mjs --token ••• --api-key=••• •••', package: null, envNames: ['MY_TOOL_TOKEN'] }]);
  });
  it('redacts the usual shapes of a secret in arguments, and leaves plain ones', () => {
    expect(redactArgs(['-y', '@scope/server@1.0.0', '--port', '3000'])).toEqual(['-y', '@scope/server@1.0.0', '--port', '3000']);
    expect(redactArgs(['--password', 'hunter2', 'API_KEY=abc', 'ghp_abcdefghijk1234'])).toEqual(['--password', '•••', 'API_KEY=•••', '•••']);
    expect(redactArgs(['abcdefghijklmnopqrstuvwxyz0123456789'])).toEqual(['•••']);
  });
});

describe('turning on and off, keys', () => {
  it('a plug-in that needs a key is refused until the key is saved, then turns on; off again', async () => {
    const r1 = await send('POST', '/plugins/github/enable');
    expect(r1.status).toBe(409);
    expect(r1.body.error).toMatchObject({ code: 'needs_keys', message: expect.stringContaining('GitHub personal access token') });
    const saved = await send('PUT', '/plugins/github/keys', { keys: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_x' } });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(saved.body)).not.toContain('ghp_x');
    expect(saved.body.message).toBe('Saved. You can turn it on now.');
    process.env.GITHUB_PERSONAL_ACCESS_TOKEN = 'ghp_x'; // what upsertEnv does in a real server
    try {
      const on = await send('POST', '/plugins/github/enable');
      expect(on.status).toBe(200);
      expect(on.body.message).toMatch(/next message/);
      expect(listMcpServers().github.env).toEqual({ GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_PERSONAL_ACCESS_TOKEN}' }); // a reference, never the value
      expect(readFileSync(process.env.MWA_CONFIG_PATH!, 'utf8')).not.toContain('ghp_x');
    } finally { delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN; }
    const off = await send('POST', '/plugins/github/disable');
    expect(off.status).toBe(200);
    expect(off.body.plugin.on).toBe(false);
    expect(listMcpServers().github).toBeUndefined();
    expect(listMcpServers().search).toBeTruthy(); // the default web search stays
  });
  it('only the key names the plug-in declares; empty, multi-line and unknown are refused and nothing is saved', async () => {
    for (const keys of [{ PATH: '/tmp' }, { MWA_ACCESS_PASSWORD: 'x' }, { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp', TAVILY_API_KEY: 'tvly' }]) {
      const r = await send('PUT', '/plugins/github/keys', { keys });
      expect(r.status, JSON.stringify(keys)).toBe(400);
      expect(r.body.error.code).toBe('unknown_key');
    }
    expect((await send('PUT', '/plugins/github/keys', { keys: { GITHUB_PERSONAL_ACCESS_TOKEN: '' } })).body.error.code).toBe('bad_value');
    expect((await send('PUT', '/plugins/github/keys', { keys: { GITHUB_PERSONAL_ACCESS_TOKEN: 'a\nEVIL=1' } })).body.error.code).toBe('bad_value');
    expect((await send('PUT', '/plugins/github/keys', { keys: {} })).status).toBe(400);
    expect((await send('PUT', '/plugins/fetch/keys', { keys: { BRAVE_API_KEY: 'x' } })).body.error.code).toBe('unknown_key'); // another plug-in's key
    expect((await send('PUT', '/plugins/nope/keys', { keys: { X: 'y' } })).status).toBe(404);
    expect(env.size).toBe(0);
  });
  it('an unknown plug-in is 404', async () => {
    expect((await send('POST', '/plugins/nope/enable')).status).toBe(404);
    expect((await send('POST', '/plugins/nope/disable')).status).toBe(404);
  });
});

describe('your own plug-ins', () => {
  it('removes one of your own; a library one is turned off instead; an unknown one is 404', async () => {
    addMcpServer('my-tool', { command: 'node', args: ['tool.mjs'] });
    const r = await send('DELETE', '/plugins/my-tool');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ removed: 'my-tool', message: expect.stringContaining('next message') });
    expect(listMcpServers()['my-tool']).toBeUndefined();
    expect((await send('DELETE', '/plugins/my-tool')).status).toBe(404);
    const lib = await send('DELETE', '/plugins/search');
    expect(lib.status).toBe(400);
    expect(lib.body.error.code).toBe('library_plugin');
    expect(listMcpServers().search).toBeTruthy();
  });
});

describe('add from npm: review, then approve', () => {
  it('off by policy or with a weak reviewing model: 409 with the reason, and no review runs', async () => {
    policy = 'off';
    let r = await send('POST', '/plugins/review', { package: 'example-mcp' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'npm_unavailable', message: expect.stringContaining('turned off') });
    expect(JSON.parse((await get('/plugins')).text).addFromNpm).toMatchObject({ available: false, reason: expect.stringContaining('turned off') });
    policy = 'curated-only';
    expect((await send('POST', '/plugins/review', { package: 'example-mcp' })).body.error.code).toBe('npm_unavailable');
    policy = undefined; reviewer = 'openrouter:openai/gpt-6-luna';
    r = await send('POST', '/plugins/review', { package: 'example-mcp' });
    expect(r.body.error).toMatchObject({ code: 'npm_unavailable', message: expect.stringContaining('stronger reviewing model') });
    expect(reviewed).toEqual([]);
  });
  it('refuses something that is not a package name (a version, a path, a URL)', async () => {
    for (const p of ['', 'example-mcp@1.0.0', '../etc', 'https://evil.example/x.tgz', 'a b']) {
      expect((await send('POST', '/plugins/review', { package: p })).status, p).toBe(400);
    }
    expect(reviewed).toEqual([]);
  });
  it('approve needs this server\'s own review, installs the reviewed version pinned, and logs it', async () => {
    const early = await send('POST', '/plugins/approve', { package: 'example-mcp', version: '6.6.6' });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('review_first');
    const rv = await send('POST', '/plugins/review', { package: 'example-mcp' });
    expect(rv.status).toBe(200);
    expect(rv.body.review).toMatchObject({ package: 'example-mcp', version: '2.0.1', verdict: 'safe', scan: { ran: true, files: 12, checksum: 'verified' } });
    expect(listMcpServers()['example-mcp']).toBeUndefined(); // a review installs nothing
    const ok = await send('POST', '/plugins/approve', { package: 'example-mcp', version: '6.6.6' }); // the client's version is ignored
    expect(ok.status).toBe(200);
    expect(ok.body.message).toBe('Installed example-mcp@2.0.1. Its tools are available on your next message.');
    expect(listMcpServers()['example-mcp']).toEqual({ command: 'npx', args: ['-y', 'example-mcp@2.0.1'] });
    expect(installs).toEqual([expect.objectContaining({ id: 'example-mcp', name: 'example-mcp', tier: 'approved-external', version: '2.0.1', verdict: 'safe', integrity: 'sha512-abc' })]);
    expect(JSON.parse((await get('/plugins')).text).custom).toEqual([{ id: 'example-mcp', command: 'npx -y example-mcp@2.0.1', package: 'example-mcp@2.0.1', envNames: [] }]);
    // a review is spent by its install
    expect((await send('POST', '/plugins/approve', { package: 'example-mcp' })).body.error.code).toBe('review_first');
  });
  it('a review lasts 30 minutes', async () => {
    await send('POST', '/plugins/review', { package: 'example-mcp' });
    now += 31 * 60_000;
    expect((await send('POST', '/plugins/approve', { package: 'example-mcp' })).body.error.code).toBe('review_first');
  });
  it('a dangerous verdict needs acceptRisk; a package that could not be checked is never installed', async () => {
    verdict = 'dangerous';
    await send('POST', '/plugins/review', { package: 'shady-mcp' });
    const r = await send('POST', '/plugins/approve', { package: 'shady-mcp' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('risky');
    expect((await send('POST', '/plugins/approve', { package: 'shady-mcp', acceptRisk: true })).status).toBe(200);
    expect(installs[0]).toMatchObject({ verdict: 'dangerous' });
    analysisOk = false; verdict = 'dangerous';
    await send('POST', '/plugins/review', { package: 'missing-mcp' });
    expect((await send('POST', '/plugins/approve', { package: 'missing-mcp', acceptRisk: true })).body.error.code).toBe('not_installable');
    expect(listMcpServers()['missing-mcp']).toBeUndefined();
  });
  it('turning add-from-npm off between review and approve stops the install', async () => {
    await send('POST', '/plugins/review', { package: 'example-mcp' });
    policy = 'off';
    expect((await send('POST', '/plugins/approve', { package: 'example-mcp' })).body.error.code).toBe('npm_unavailable');
    expect(installs).toEqual([]);
  });
  it('a package can\'t take a library plug-in\'s name', async () => {
    await send('POST', '/plugins/review', { package: 'github' });
    const r = await send('POST', '/plugins/approve', { package: 'github' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('name_taken');
  });
});
