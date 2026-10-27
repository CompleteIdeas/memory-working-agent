// v2 build, slice S2: Settings › Your assistant in fixture mode (web/src/v2/dev/fixtures-assistant.ts) answers with
// the contract's shapes and the server's rules (who may change what, keys never sent back, the folder checks, the
// brain deciding "add from npm"), its providers are the server's, and the page's words (screens/settings/
// useAssistant.ts). The page itself runs in the browser: scripts/v2-s2-smoke.mjs.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { FixtureServer } from '../web/src/v2/dev/fixtures';
import { FIXTURE_PROVIDERS } from '../web/src/v2/dev/fixtures-assistant';
import { PROVIDER_CHOICES } from '../src/assistant-settings';
import {
  PRESETS, STYLES, folderPlaceholder, imageLine, keyHint, noModelsLine, npmAfterLine, npmLine, providerLabel, specOf,
} from '../web/src/v2/screens/settings/useAssistant';
import type { AssistantSettings } from '../web/src/v2/api/client';

const spec = parse(readFileSync(new URL('../api/openapi.yaml', import.meta.url), 'utf8'));
const ajv = new (Ajv2020 as unknown as typeof Ajv2020.default)({ strict: false, allErrors: true });
(addFormats as unknown as typeof addFormats.default)(ajv);
ajv.addSchema({ $id: 'spec', components: spec.components });
function valid(path: string, method: string, res: { status: number; body: unknown }) {
  const op = spec.paths[path][method];
  const r = op.responses[String(res.status)] ?? op.responses.default;
  const resolved = r.$ref ? spec.components.responses[r.$ref.split('/').pop()] : r;
  const fn = ajv.compile(JSON.parse(JSON.stringify(resolved.content['application/json'].schema).replace(/"#\/components\//g, '"spec#/components/')));
  expect(fn(res.body) ? null : `${method.toUpperCase()} ${path} ${res.status}: ${ajv.errorsText(fn.errors)}`).toBeNull();
  return res as { status: number; body: any };
}
const H = { 'x-mwa-client': 'web/1.0.0' };
let k = 0;
const call = (s: FixtureServer, method: string, path: string, body?: unknown) =>
  s.handle({ method, path, query: new URLSearchParams(), headers: { ...H, 'idempotency-key': `s2-key-${++k}` }, body });
const get = (s: FixtureServer, path: string) => s.handle({ method: 'GET', path, query: new URLSearchParams(), headers: H, body: undefined });
const KEY = 'sk-or-v1-TYPEDinFIXTURE123';

describe('S2 fixture mode answers like the server', () => {
  it('its providers are the server\'s providers', () => {
    expect(FIXTURE_PROVIDERS).toEqual(PROVIDER_CHOICES);
  });
  it('the settings, every change and its refusals have the contract\'s shapes; a key never comes back', () => {
    const s = new FixtureServer('N00');
    const a = valid('/assistant', 'get', get(s, '/assistant')).body as AssistantSettings;
    expect(a).toMatchObject({ brain: { provider: 'openrouter', model: 'openai/gpt-6.1-sol', fixed: false }, style: 'guided', access: { preset: 'assistant' }, addFromNpm: { available: true } });
    const m = valid('/assistant/models', 'post', call(s, 'POST', '/assistant/models', { provider: 'openrouter' }));
    expect(m.body.models.find((x: any) => x.id === 'openai/gpt-6-luna').npmAfter).toBe(false);
    expect(valid('/assistant/models', 'post', call(s, 'POST', '/assistant/models', { provider: 'anthropic' })).body.models).toEqual([]); // no key, no list
    expect(valid('/assistant/models', 'post', call(s, 'POST', '/assistant/models', { provider: 'nope' })).body.error.code).toBe('bad_provider');
    const saved = valid('/assistant/brain', 'put', call(s, 'PUT', '/assistant/brain', { provider: 'anthropic', model: 'claude-sonnet-5', key: KEY }));
    expect(JSON.stringify(saved.body)).not.toContain(KEY);
    expect(saved.body.assistant.providers.find((p: any) => p.id === 'anthropic').keySaved).toBe(true);
    expect(JSON.stringify(get(s, '/assistant').body)).not.toContain(KEY);
    expect(valid('/assistant/brain', 'put', call(s, 'PUT', '/assistant/brain', { provider: 'openai', model: 'gpt-6.1' })).body.error.code).toBe('check_failed'); // no key saved for OpenAI
    const bad = valid('/assistant/brain', 'put', call(s, 'PUT', '/assistant/brain', { provider: 'openrouter', model: 'openai/gpt-6.1-sol', key: 'sk-bad-key-123' }));
    expect(bad.body.error.code).toBe('check_failed');
    expect(JSON.stringify(bad.body)).not.toContain('sk-bad-key-123');
    expect(valid('/assistant/brain', 'put', call(s, 'PUT', '/assistant/brain', { provider: 'openrouter', model: 'a b' })).body.error.code).toBe('bad_model');
    expect(valid('/assistant/image', 'put', call(s, 'PUT', '/assistant/image', { provider: 'openrouter', model: 'black-forest-labs/flux-2' })).body.assistant.image.on).toBe(true);
    expect(valid('/assistant/image', 'put', call(s, 'PUT', '/assistant/image', { provider: 'anthropic', model: 'x' })).body.error.code).toBe('bad_provider');
    expect(valid('/assistant/image', 'delete', call(s, 'DELETE', '/assistant/image')).body.assistant.image.on).toBe(false);
    expect(valid('/assistant/access', 'put', call(s, 'PUT', '/assistant/access', { preset: 'locked-down' })).body.assistant.access.preset).toBe('locked-down');
    expect(valid('/assistant/access', 'put', call(s, 'PUT', '/assistant/access', { preset: 'root' })).body.error.code).toBe('bad_preset');
    expect(valid('/assistant/folders', 'post', call(s, 'POST', '/assistant/folders', { path: '/Users/robert/Documents/Show results' })).body.message).toMatch(/Granted/);
    for (const [path, code] of [['Documents', 'bad_folder'], ['/', 'refused'], ['C:\\', 'refused'], ['\\\\nas\\share', 'refused'], ['/Users/robert', 'refused'], ['/Users/robert/mwa', 'refused'], ['/Users/robert/mwa/data/browser', 'refused'], ['/Users/robert/missing', 'not_found']]) {
      expect(valid('/assistant/folders', 'post', call(s, 'POST', '/assistant/folders', { path })).body.error.code, path).toBe(code);
    }
    expect(valid('/assistant/folders/remove', 'post', call(s, 'POST', '/assistant/folders/remove', { path: '/Users/robert/Old project' })).body.assistant.access.folders.map((f: any) => f.path))
      .toEqual(['/Users/robert/Documents/Barn', '/Users/robert/Documents/Show results']);
    expect(valid('/assistant/folders/remove', 'post', call(s, 'POST', '/assistant/folders/remove', { path: '/Users/robert/Old project' })).status).toBe(404);
    expect(valid('/assistant/style', 'put', call(s, 'PUT', '/assistant/style', { style: 'direct' })).body.assistant.style).toBe('direct');
    expect(valid('/assistant/style', 'put', call(s, 'PUT', '/assistant/style', { style: 'loud' })).body.error.code).toBe('bad_style');
  });
  it('a weak brain turns "add from npm" off on the Plug-ins page too, and a strong one back on', () => {
    const s = new FixtureServer('N00');
    const weak = valid('/assistant/brain', 'put', call(s, 'PUT', '/assistant/brain', { provider: 'openrouter', model: 'openai/gpt-6-luna' }));
    expect(weak.body.message).toMatch(/Adding plug-ins from npm is off now/);
    expect((get(s, '/plugins').body as any).addFromNpm).toMatchObject({ available: false, reviewer: 'openrouter:openai/gpt-6-luna' });
    expect(call(s, 'POST', '/plugins/review', { package: 'weather-mcp' }).body).toMatchObject({ error: { code: 'npm_unavailable' } });
    const strong = valid('/assistant/brain', 'put', call(s, 'PUT', '/assistant/brain', { provider: 'openrouter', model: 'anthropic/claude-sonnet-5' }));
    expect(strong.body.message).toMatch(/available now/);
    expect((get(s, '/plugins').body as any).addFromNpm.available).toBe(true);
  });
  it('a paired phone reads the settings but every change (and the model list) is 403', () => {
    const s = new FixtureServer('phone');
    expect(valid('/assistant', 'get', get(s, '/assistant')).status).toBe(200);
    for (const [m, p, b] of [['POST', '/assistant/models', { provider: 'openrouter' }], ['PUT', '/assistant/brain', { provider: 'openrouter', model: 'x' }], ['PUT', '/assistant/image', { provider: 'openrouter', model: 'x' }],
      ['DELETE', '/assistant/image'], ['PUT', '/assistant/access', { preset: 'developer' }], ['POST', '/assistant/folders', { path: '/Users/robert/x' }], ['POST', '/assistant/folders/remove', { path: '/Users/robert/Documents/Barn' }], ['PUT', '/assistant/style', { style: 'direct' }]] as const) {
      expect(call(s, m, p, b).status, `${m} ${p}`).toBe(403);
    }
  });
  it('model-fixed: the brain says so and a change is refused', () => {
    const s = new FixtureServer('model-fixed');
    expect((get(s, '/assistant').body as AssistantSettings).brain.fixed).toBe(true);
    expect(valid('/assistant/brain', 'put', call(s, 'PUT', '/assistant/brain', { provider: 'openrouter', model: 'openai/gpt-6.1-sol' })).body.error.code).toBe('fixed');
  });
});

describe('Your assistant\'s words', () => {
  const a = get(new FixtureServer('N00'), '/assistant').body as AssistantSettings;
  it('names the brain and the image model plainly', () => {
    expect(providerLabel(a, 'openrouter')).toBe('OpenRouter (many models, one key)');
    expect(providerLabel(a, 'azure')).toBe('Azure');
    expect(specOf(a.brain)).toBe('openrouter:openai/gpt-6.1-sol');
    expect(imageLine(a)).toMatch(/^Off\./);
    expect(imageLine({ ...a, image: { provider: 'openai', model: 'gpt-image-2', on: true, fixed: false } })).toBe('openai:gpt-image-2');
  });
  it('says what the brain does to plug-ins from npm', () => {
    expect(npmLine(a.addFromNpm)).toBe('On. openrouter:openai/gpt-6.1-sol checks each one before you decide.');
    expect(npmLine({ available: false, reason: 'Turned off.', reviewer: null })).toBe('Off. Turned off.');
    expect(npmAfterLine({ id: 'x', name: null, npmAfter: false }, a.addFromNpm)).toMatch(/turns off/);
    expect(npmAfterLine({ id: 'x', name: null, npmAfter: true }, a.addFromNpm)).toBeNull();
    expect(npmAfterLine({ id: 'x', name: null, npmAfter: true }, { available: false, reason: '', reviewer: null })).toMatch(/turns on/);
    expect(npmAfterLine({ id: 'x', name: null, npmAfter: null }, a.addFromNpm)).toBeNull();
  });
  it('keys, empty lists, levels, styles and the folder hint', () => {
    const by = (id: string) => a.providers.find((p) => p.id === id);
    expect(keyHint(by('openrouter'))).toMatch(/A key is saved/);
    expect(keyHint(by('openai'))).toMatch(/never show it again/);
    expect(keyHint(by('ollama'))).toBeNull();
    expect(noModelsLine(by('ollama'), 'chat')).toMatch(/Ollama running/);
    expect(noModelsLine(by('openai'), 'chat')).toMatch(/Paste your key first/);
    expect(noModelsLine(by('gemini'), 'image')).toMatch(/^Google Gemini doesn’t offer image models/);
    expect(PRESETS.map((p) => p.id)).toEqual(['locked-down', 'assistant', 'developer']);
    expect(PRESETS[2].detail).toMatch(/without asking/);
    expect(STYLES.map((s) => s.label)).toEqual(['Guided', 'Direct']);
    expect(folderPlaceholder(true)).toBe('/mnt/files');
    expect(folderPlaceholder(false, 'Mozilla/5.0 (Windows NT 10.0)')).toBe('C:\\Users\\you\\Documents');
    expect(folderPlaceholder(false, 'Mozilla/5.0 (iPhone)')).toBe('/Users/you/Documents');
  });
});
