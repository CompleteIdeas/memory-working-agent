// v2 build, slice S2: the assistant's own settings (src/api/routes/assistant.ts over src/assistant-settings.ts) over
// HTTP with the real caller resolver: who may see and change them, that no key ever comes back (not even quoted in a
// provider's error), the checks on provider, model, key and folders, the "add from npm" consequence of the brain, and
// that the classic page's /api/save and the v1 routes leave the same settings behind. No network, no model, no real
// .env: the live check and the model list are stubs, keys go to a map.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, parse } from 'node:path';
import { createV1 } from '../src/api/router.js';
import { v1Routes } from '../src/api/v1.js';
import { makeAuthenticate, createPairCode, redeemPairCode } from '../src/api/auth.js';
import { resetAppDb } from '../src/v2/db.js';
import { setAssistantDeps, legacySave, folderProblem } from '../src/assistant-settings.js';

const NET = { 'x-forwarded-for': '100.64.0.7' };
const as = (token: string) => ({ ...NET, authorization: `Bearer ${token}` });
let server: Server, base = '', cfgDir = '';
let n = 0;
const key = () => `s2-key-${Date.now()}-${++n}`;
const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method, headers: { 'idempotency-key': key(), 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
    .then(async (r) => { const text = await r.text(); return { status: r.status, text, body: (() => { try { return JSON.parse(text); } catch { return null; } })() as any }; });
const get = (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers }).then(async (r) => ({ status: r.status, text: await r.text() }));
const cfg = () => JSON.parse(readFileSync(process.env.MWA_CONFIG_PATH!, 'utf8'));

const env = new Map<string, string>();
const checks: { provider: string; model: string; key?: string }[] = [];
const SECRET = 'sk-or-v1-SUPERSECRETKEY0123456789';
function device(scopes: ('read' | 'act' | 'approve' | 'admin')[]): string {
  const { code } = createPairCode('test', scopes);
  return redeemPairCode(code, 'Pixel', 'android')!.token;
}

const SAVED = { cfg: process.env.MWA_CONFIG_PATH, model: process.env.MWA_MODEL, image: process.env.MWA_MODEL_IMAGE, anthropic: process.env.ANTHROPIC_API_KEY, data: process.env.MWA_DATA_DIR };
beforeAll(async () => {
  const authenticate = makeAuthenticate({ passwordSet: false, sessionValid: () => false });
  const sameOrigin = (req: { headers: Record<string, unknown> }) => !req.headers.origin;
  const v1 = createV1(v1Routes(), { authenticate, sameOrigin: sameOrigin as never });
  server = createServer(async (req, res) => { if (!(await v1(req, res))) { res.writeHead(404); res.end(); } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
});
function freshConfig(content = '{}\n') {
  cfgDir = mkdtempSync(join(tmpdir(), 'mwa-s2-cfg-'));
  process.env.MWA_CONFIG_PATH = join(cfgDir, 'mwa.config.json');
  writeFileSync(process.env.MWA_CONFIG_PATH, content);
}
beforeEach(() => {
  resetAppDb(':memory:');
  freshConfig();
  for (const k of ['MWA_MODEL', 'MWA_MODEL_IMAGE', 'ANTHROPIC_API_KEY', 'MWA_DATA_DIR']) delete process.env[k];
  env.clear(); checks.length = 0;
  setAssistantDeps({
    // the live check fails for a key containing "bad", quoting the key the way some providers do
    testProvider: async (provider, model, k) => { checks.push({ provider, model, key: k }); return k && k.includes('bad') ? { ok: false, message: `failed: 401 Incorrect API key provided: ${k}` } : { ok: true, message: `${model} works ✓` }; },
    listModels: async (provider, o) => (o.kind === 'image' ? [{ id: 'black-forest-labs/flux-2', name: 'FLUX 2' }] : [{ id: 'openai/gpt-6.1-sol', name: 'GPT-6.1 Sol' }, { id: 'openai/gpt-6-luna', name: 'GPT-6 Luna' }]),
    saveEnv: (kv) => { for (const [k, v] of Object.entries(kv)) env.set(k, v); },
    hasEnv: (name) => env.has(name),
  });
});
afterAll(() => {
  server?.close(); setAssistantDeps(null);
  for (const [k, v] of Object.entries({ MWA_CONFIG_PATH: SAVED.cfg, MWA_MODEL: SAVED.model, MWA_MODEL_IMAGE: SAVED.image, ANTHROPIC_API_KEY: SAVED.anthropic, MWA_DATA_DIR: SAVED.data })) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

describe('who may see and change the assistant', () => {
  it('a paired phone reads the settings but every change is 403; this machine (admin) may change', async () => {
    const phone = device(['read', 'act', 'approve']);
    const r = await get('/assistant', as(phone));
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toMatchObject({ style: 'guided', access: { preset: 'assistant' } });
    const tmp = mkdtempSync(join(tmpdir(), 'mwa-s2-f-'));
    const changes: [string, string, unknown?][] = [
      ['POST', '/assistant/models', { provider: 'openrouter' }], ['PUT', '/assistant/brain', { provider: 'openrouter', model: 'openai/gpt-6.1-sol', key: SECRET }],
      ['PUT', '/assistant/image', { provider: 'openrouter', model: 'x/y' }], ['DELETE', '/assistant/image'], ['PUT', '/assistant/access', { preset: 'developer' }],
      ['POST', '/assistant/folders', { path: tmp }], ['POST', '/assistant/folders/remove', { path: tmp }], ['PUT', '/assistant/style', { style: 'direct' }],
    ];
    for (const [m, p, b] of changes) {
      const x = await send(m, p, b, as(phone));
      expect(x.status, `${m} ${p}`).toBe(403);
      expect(x.body.error.code).toBe('forbidden');
    }
    expect(cfg()).toEqual({});
    expect(env.size).toBe(0);
    expect(checks).toEqual([]);
    expect((await send('PUT', '/assistant/style', { style: 'direct' })).status).toBe(200);
    expect((await send('PUT', '/assistant/style', { style: 'guided' }, as(device(['read', 'act', 'approve', 'admin'])))).status).toBe(200);
  });
  it('a stranger from the network gets 401 even for reading', async () => {
    expect((await get('/assistant', NET)).status).toBe(401);
  });
  it('a change from another site is refused (cross-origin) and nothing is saved', async () => {
    const r = await send('PUT', '/assistant/access', { preset: 'developer' }, { origin: 'http://evil.example' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('cross_origin');
    expect(cfg()).toEqual({});
  });
});

describe('the brain', () => {
  it('checks the model live, saves the key write-only, and the key never comes back', async () => {
    const r = await send('PUT', '/assistant/brain', { provider: 'openrouter', model: 'openai/gpt-6.1-sol', key: SECRET });
    expect(r.status).toBe(200);
    expect(r.body.message).toMatch(/works/);
    expect(r.body.message).toMatch(/next message/);
    expect(checks).toEqual([{ provider: 'openrouter', model: 'openai/gpt-6.1-sol', key: SECRET }]);
    expect(env.get('OPENROUTER_API_KEY')).toBe(SECRET);
    expect(cfg().models).toEqual({ fetch: 'openrouter:openai/gpt-6.1-sol', reason: 'openrouter:openai/gpt-6.1-sol' });
    expect(r.text).not.toContain(SECRET);
    const view = await get('/assistant');
    expect(view.text).not.toContain(SECRET);
    const v = JSON.parse(view.text);
    expect(v.brain).toMatchObject({ provider: 'openrouter', model: 'openai/gpt-6.1-sol', fixed: false });
    expect(v.providers.find((p: any) => p.id === 'openrouter').keySaved).toBe(true);
    expect(v.providers.find((p: any) => p.id === 'openai').keySaved).toBe(false);
    expect(v.providers.find((p: any) => p.id === 'ollama').keySaved).toBeNull();
  });
  it('a failed check saves nothing and never quotes the key', async () => {
    const bad = 'sk-or-v1-bad-0123456789abcdef';
    const r = await send('PUT', '/assistant/brain', { provider: 'openrouter', model: 'openai/gpt-6.1-sol', key: bad });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('check_failed');
    expect(r.body.error.message).toMatch(/Incorrect API key/);
    expect(r.text).not.toContain(bad);
    expect(r.text).not.toContain('0123456789abcdef');
    expect(env.size).toBe(0);
    expect(cfg()).toEqual({});
  });
  it('refuses an unknown provider, a bad model name, a key or address that isn\'t one line, before any check', async () => {
    const cases: [unknown, string][] = [
      [{ provider: 'evilcorp', model: 'm' }, 'bad_provider'],
      [{ provider: 'openrouter', model: '' }, 'bad_model'],
      [{ provider: 'openrouter', model: 'a\nb' }, 'bad_model'],
      [{ provider: 'openrouter', model: 'openai/gpt-6.1-sol', key: 'sk-x\nEVIL=1' }, 'bad_key'],
      [{ provider: 'openrouter', model: 'openai/gpt-6.1-sol', baseUrl: 'http://evil.example' }, 'bad_base_url'],
      [{ provider: 'ollama', model: 'llama3', baseUrl: 'file:///etc/passwd' }, 'bad_base_url'],
    ];
    for (const [b, code] of cases) {
      const r = await send('PUT', '/assistant/brain', b);
      expect(r.status, JSON.stringify(b)).toBe(400);
      expect(r.body.error.code).toBe(code);
    }
    expect(checks).toEqual([]);
    expect(env.size).toBe(0);
    expect(cfg()).toEqual({});
  });
  it('MWA_MODEL wins: the brain says fixed and a change is refused', async () => {
    process.env.MWA_MODEL = 'openrouter:openai/gpt-6.1-sol';
    expect(JSON.parse((await get('/assistant')).text).brain.fixed).toBe(true);
    const r = await send('PUT', '/assistant/brain', { provider: 'openai', model: 'gpt-6.1', key: 'sk-x-0000000' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('fixed');
    expect(checks).toEqual([]);
  });
  it('the brain decides whether plug-ins can come from npm, and the change says so', async () => {
    // default brain: gpt-6.1-sol reviews → available
    expect(JSON.parse((await get('/assistant')).text).addFromNpm.available).toBe(true);
    const weak = await send('PUT', '/assistant/brain', { provider: 'openrouter', model: 'openai/gpt-6-luna', key: SECRET });
    expect(weak.body.message).toMatch(/Adding plug-ins from npm is off now/);
    expect(weak.body.assistant.addFromNpm.available).toBe(false);
    const strong = await send('PUT', '/assistant/brain', { provider: 'openrouter', model: 'openai/gpt-6.1-sol' });
    expect(strong.body.message).toMatch(/Adding plug-ins from npm is available now/);
    const same = await send('PUT', '/assistant/brain', { provider: 'openrouter', model: 'openai/gpt-6.1-sol' });
    expect(same.body.message).not.toMatch(/npm/);
  });
  it('with an Anthropic key the strong tier stays Sonnet, so a weak brain keeps npm available', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-real';
    const r = await send('PUT', '/assistant/brain', { provider: 'openrouter', model: 'openai/gpt-6-luna' });
    expect(cfg().models).toEqual({ fetch: 'openrouter:openai/gpt-6-luna', reason: 'anthropic:claude-sonnet-4-6' });
    expect(r.body.assistant.addFromNpm.available).toBe(true);
  });
});

describe('the model list', () => {
  it('lists chat models with the npm consequence of each; a typed key is used, not saved', async () => {
    const r = await send('POST', '/assistant/models', { provider: 'openrouter', key: SECRET });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ provider: 'openrouter', kind: 'chat', models: [
      { id: 'openai/gpt-6.1-sol', name: 'GPT-6.1 Sol', npmAfter: true }, { id: 'openai/gpt-6-luna', name: 'GPT-6 Luna', npmAfter: false }] });
    expect(env.size).toBe(0);
    const img = await send('POST', '/assistant/models', { provider: 'openrouter', kind: 'image' });
    expect(img.body.models).toEqual([{ id: 'black-forest-labs/flux-2', name: 'FLUX 2', npmAfter: null }]);
    expect((await send('POST', '/assistant/models', { provider: 'evilcorp' })).body.error.code).toBe('bad_provider');
  });
});

describe('making images', () => {
  it('sets, refuses Anthropic, and turns off', async () => {
    const r = await send('PUT', '/assistant/image', { provider: 'openrouter', model: 'black-forest-labs/flux-2', key: SECRET });
    expect(r.status).toBe(200);
    expect(r.text).not.toContain(SECRET);
    expect(cfg().models.image).toBe('openrouter:black-forest-labs/flux-2');
    expect(r.body.assistant.image).toEqual({ provider: 'openrouter', model: 'black-forest-labs/flux-2', on: true, fixed: false });
    expect((await send('PUT', '/assistant/image', { provider: 'anthropic', model: 'claude' })).body.error.code).toBe('bad_provider');
    expect((await send('PUT', '/assistant/image', { provider: 'openrouter', model: '' })).body.error.code).toBe('bad_model');
    const off = await send('DELETE', '/assistant/image');
    expect(off.body.message).toBe('Image generation turned off.');
    expect(cfg().models.image).toBeUndefined();
    expect(off.body.assistant.image.on).toBe(false);
  });
});

describe('what it can touch', () => {
  it('the level: only one of the three', async () => {
    expect((await send('PUT', '/assistant/access', { preset: 'developer' })).body.assistant.access.preset).toBe('developer');
    expect(cfg().tools.access.preset).toBe('developer');
    const r = await send('PUT', '/assistant/access', { preset: 'root' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('bad_preset');
    expect(cfg().tools.access.preset).toBe('developer');
  });
  it('grants a real folder by its full path, and removes it', async () => {
    const f = mkdtempSync(join(tmpdir(), 'mwa-s2-docs-'));
    const r = await send('POST', '/assistant/folders', { path: f });
    expect(r.status).toBe(200);
    expect(r.body.assistant.access.folders).toEqual([{ path: resolve(f), found: true }]);
    expect(cfg().tools.access.grantedRoots).toEqual([resolve(f)]);
    expect((await send('POST', '/assistant/folders', { path: f })).body.message).toMatch(/already granted/);
    const gone = await send('POST', '/assistant/folders/remove', { path: resolve(f) });
    expect(gone.status).toBe(200);
    expect(cfg().tools.access.grantedRoots).toEqual([]);
    expect((await send('POST', '/assistant/folders/remove', { path: resolve(f) })).status).toBe(404);
  });
  it('refuses a folder that isn\'t there, a relative path, a whole drive, a network share, and one holding the helper\'s keys', async () => {
    const data = mkdtempSync(join(tmpdir(), 'mwa-s2-home-'));
    mkdirSync(join(data, 'data'));
    process.env.MWA_DATA_DIR = join(data, 'data');
    const cases: [string, string][] = [
      [join(tmpdir(), 'mwa-s2-no-such-folder-x9'), 'not_found'],
      ['Documents', 'bad_folder'],
      [parse(resolve('.')).root, 'refused'],
      ['\\\\fileserver\\share', 'refused'],
      ['//fileserver/share', 'refused'],
      [resolve('.'), 'refused'], // the .env sits here
      [resolve('..'), 'refused'], // …and anything that contains it
      [data, 'refused'], // contains the data folder (the vault, sign-in tokens)
      [cfgDir, 'refused'], // holds mwa.config.json
      ['', 'bad_folder'],
    ];
    for (const [path, code] of cases) {
      const r = await send('POST', '/assistant/folders', { path });
      expect(r.status, path).toBe(400);
      expect(r.body.error.code, path).toBe(code);
    }
    expect(cfg().tools?.access?.grantedRoots ?? []).toEqual([]);
    mkdirSync(join(data, 'data', 'files'));
    expect(folderProblem(join(data, 'data', 'files'))).toBeNull(); // a folder inside the data folder is fine
  });
  it('a folder granted before the stricter rule is kept when the level changes', async () => {
    freshConfig(JSON.stringify({ tools: { access: { preset: 'assistant', grantedRoots: [resolve('.')] } } }));
    await send('PUT', '/assistant/access', { preset: 'locked-down' });
    expect(cfg().tools.access).toEqual({ preset: 'locked-down', grantedRoots: [resolve('.')] });
  });
});

describe('how I work with you', () => {
  it('Guided or Direct, nothing else', async () => {
    expect((await send('PUT', '/assistant/style', { style: 'direct' })).body.message).toMatch(/Direct/);
    expect(cfg().style).toBe('direct');
    expect((await send('PUT', '/assistant/style', { style: 'chatty' })).body.error.code).toBe('bad_style');
    expect(cfg().style).toBe('direct');
  });
});

describe('the classic page and the new app leave the same settings behind', () => {
  /** run the same change through /api/save's function and through the v1 route, each on a fresh config */
  async function both(legacy: Record<string, unknown>, method: string, path: string, body: unknown) {
    freshConfig(); env.clear();
    const a = await legacySave(legacy);
    const aCfg = cfg(), aEnv = Object.fromEntries(env);
    freshConfig(); env.clear();
    const b = await send(method, path, body);
    return { a, aCfg, aEnv, b, bCfg: cfg(), bEnv: Object.fromEntries(env) };
  }
  it('the brain, the image model, the level with folders, and the style', async () => {
    const f = mkdtempSync(join(tmpdir(), 'mwa-s2-same-'));
    const runs = [
      await both({ which: 'provider', provider: 'openrouter', model: 'openai/gpt-6.1-sol', key: SECRET }, 'PUT', '/assistant/brain', { provider: 'openrouter', model: 'openai/gpt-6.1-sol', key: SECRET }),
      await both({ which: 'image-model', provider: 'openrouter', model: 'black-forest-labs/flux-2', key: SECRET }, 'PUT', '/assistant/image', { provider: 'openrouter', model: 'black-forest-labs/flux-2', key: SECRET }),
      await both({ which: 'image-model', provider: 'openrouter', model: '' }, 'DELETE', '/assistant/image', undefined),
      await both({ which: 'access', preset: 'developer' }, 'PUT', '/assistant/access', { preset: 'developer' }),
      await both({ which: 'style', style: 'direct' }, 'PUT', '/assistant/style', { style: 'direct' }),
    ];
    for (const r of runs) {
      expect(r.a.ok).toBe(true);
      expect(r.b.status).toBe(200);
      expect(r.bCfg).toEqual(r.aCfg);
      expect(r.bEnv).toEqual(r.aEnv);
      expect(r.b.body.message.startsWith(r.a.message)).toBe(true);
    }
    // a folder: the classic page saves the list, the new app adds one; both end with it granted
    const g = await both({ which: 'access', preset: 'assistant', grantedRoots: [f] }, 'POST', '/assistant/folders', { path: f });
    expect(g.bCfg).toEqual(g.aCfg);
    expect(g.aCfg.tools.access.grantedRoots).toEqual([resolve(f)]);
  });
  it('the same refusals: a bad key, a bad level, a bad style, a refused folder', async () => {
    const bad = await both({ which: 'provider', provider: 'openrouter', model: 'openai/gpt-6.1-sol', key: 'sk-or-bad-0123456789' }, 'PUT', '/assistant/brain', { provider: 'openrouter', model: 'openai/gpt-6.1-sol', key: 'sk-or-bad-0123456789' });
    expect(bad.a.ok).toBe(false);
    expect(bad.b.body.error.message).toBe(bad.a.message);
    expect(bad.a.message).not.toContain('sk-or-bad-0123456789');
    expect(bad.aCfg).toEqual({});
    expect(bad.bCfg).toEqual({});
    for (const [legacy, method, path, body] of [
      [{ which: 'access', preset: 'root' }, 'PUT', '/assistant/access', { preset: 'root' }],
      [{ which: 'style', style: 'chatty' }, 'PUT', '/assistant/style', { style: 'chatty' }],
      [{ which: 'provider', provider: 'evilcorp', model: 'm' }, 'PUT', '/assistant/brain', { provider: 'evilcorp', model: 'm' }],
    ] as const) {
      const r = await both(legacy, method, path, body);
      expect(r.a.ok).toBe(false);
      expect(r.b.status).toBe(400);
      expect(r.b.body.error.message).toBe(r.a.message);
      expect(r.aCfg).toEqual({});
      expect(r.bCfg).toEqual({});
    }
    // the classic page saves the rest and names the refused folder; the new app refuses it outright
    const drive = parse(resolve('.')).root;
    const r = await both({ which: 'access', preset: 'assistant', grantedRoots: [drive] }, 'POST', '/assistant/folders', { path: drive });
    expect(r.a.message).toMatch(/Not granted/);
    expect(r.aCfg.tools.access.grantedRoots).toEqual([]);
    expect(r.b.body.error.code).toBe('refused');
    expect(r.bCfg).toEqual({});
  });
});
