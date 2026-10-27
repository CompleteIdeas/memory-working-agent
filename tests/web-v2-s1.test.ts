// v2 build, slice S1: Settings › Plug-ins in fixture mode (web/src/v2/dev/fixtures-plugins.ts) answers with the
// contract's shapes and the server's rules (who may change what, keys never sent back, the review before an install),
// its library is the server's library, and the page's words (screens/settings/usePlugins.ts). The page itself runs in
// the browser: scripts/v2-s1-smoke.mjs.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { FixtureServer } from '../web/src/v2/dev/fixtures';
import { FIXTURE_LIBRARY } from '../web/src/v2/dev/fixtures-plugins';
import { CONNECTOR_LIBRARY } from '../src/connectors/registry';
import { groupPlugins, keyLine, verdictWords, scanLine, customTitle, needsTrust, installable } from '../web/src/v2/screens/settings/usePlugins';
import type { Plugin, PluginList, PluginReview } from '../web/src/v2/api/client';

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
  s.handle({ method, path, query: new URLSearchParams(), headers: { ...H, 'idempotency-key': `s1-key-${++k}` }, body });
const get = (s: FixtureServer, path: string) => s.handle({ method: 'GET', path, query: new URLSearchParams(), headers: H, body: undefined });

describe('S1 fixture mode answers like the server', () => {
  it('its library is the server\'s library (names, what each can touch, key names)', () => {
    expect(FIXTURE_LIBRARY.map((e) => ({ id: e.id, name: e.name, description: e.description, access: e.access, tier: e.tier, source: e.source, keys: e.keys })))
      .toEqual(CONNECTOR_LIBRARY.map((c) => ({ id: c.id, name: c.name, description: c.description, access: c.access, tier: c.tier, source: c.source ?? null,
        keys: (c.secrets ?? []).map((s) => ({ name: s.env, label: s.label, help: s.help ?? null, optional: !!s.optional })) })));
  });
  it('the list, every change and its refusals have the contract\'s shapes', () => {
    const s = new FixtureServer('N00');
    const list = valid('/plugins', 'get', get(s, '/plugins'));
    expect(list.body.addFromNpm.available).toBe(true);
    expect(valid('/plugins/{id}/enable', 'post', call(s, 'POST', '/plugins/browser/enable')).status).toBe(200);
    expect(valid('/plugins/{id}/enable', 'post', call(s, 'POST', '/plugins/github/enable')).body.error.code).toBe('needs_keys');
    expect(valid('/plugins/{id}/disable', 'post', call(s, 'POST', '/plugins/browser/disable')).body.plugin.on).toBe(false);
    const saved = valid('/plugins/{id}/keys', 'put', call(s, 'PUT', '/plugins/github/keys', { keys: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_typed' } }));
    expect(JSON.stringify(saved.body)).not.toContain('ghp_typed');
    expect(saved.body.plugin.keys[0]).toMatchObject({ saved: true });
    expect(JSON.stringify(get(s, '/plugins').body)).not.toContain('ghp_typed');
    expect(valid('/plugins/{id}/keys', 'put', call(s, 'PUT', '/plugins/github/keys', { keys: { PATH: 'x' } })).body.error.code).toBe('unknown_key');
    expect(valid('/plugins/{id}/enable', 'post', call(s, 'POST', '/plugins/github/enable')).status).toBe(200);
    expect(valid('/plugins/{id}', 'delete', call(s, 'DELETE', '/plugins/weather-mcp')).status).toBe(200);
    expect(valid('/plugins/{id}', 'delete', call(s, 'DELETE', '/plugins/search')).body.error.code).toBe('library_plugin');
    expect(valid('/plugins/approve', 'post', call(s, 'POST', '/plugins/approve', { package: 'weather-mcp' })).body.error.code).toBe('review_first');
    const rv = valid('/plugins/review', 'post', call(s, 'POST', '/plugins/review', { package: 'weather-mcp' }));
    expect(rv.body.review.verdict).toBe('safe');
    expect(valid('/plugins/approve', 'post', call(s, 'POST', '/plugins/approve', { package: 'weather-mcp' })).body.plugin).toMatchObject({ id: 'weather-mcp', package: 'weather-mcp@1.0.0' });
    valid('/plugins/review', 'post', call(s, 'POST', '/plugins/review', { package: 'shady-mcp' }));
    expect(valid('/plugins/approve', 'post', call(s, 'POST', '/plugins/approve', { package: 'shady-mcp' })).body.error.code).toBe('risky');
    expect(valid('/plugins/approve', 'post', call(s, 'POST', '/plugins/approve', { package: 'shady-mcp', acceptRisk: true })).status).toBe(200);
    expect(valid('/plugins/review', 'post', call(s, 'POST', '/plugins/review', { package: 'x@1.0.0' })).status).toBe(400);
  });
  it('a paired phone reads the list but every change is 403', () => {
    const s = new FixtureServer('phone');
    expect(valid('/plugins', 'get', get(s, '/plugins')).status).toBe(200);
    for (const [m, p, b] of [['POST', '/plugins/fetch/disable'], ['PUT', '/plugins/github/keys', { keys: { GITHUB_PERSONAL_ACCESS_TOKEN: 'x' } }], ['DELETE', '/plugins/weather-mcp'], ['POST', '/plugins/review', { package: 'x' }], ['POST', '/plugins/approve', { package: 'x' }]] as const) {
      expect(call(s, m, p, b).status, `${m} ${p}`).toBe(403);
    }
  });
  it('review of S1: a phone gets command names only; keys clear; no AI review needs acceptRisk; no overwriting', () => {
    const phone = new FixtureServer('phone');
    const custom = (valid('/plugins', 'get', get(phone, '/plugins')).body as PluginList).custom;
    expect(custom.find((c) => c.id === 'barn-notes')).toMatchObject({ command: 'node', argsHidden: true });
    expect(call(phone, 'DELETE', '/plugins/notion/keys/NOTION_TOKEN').status).toBe(403);
    const s = new FixtureServer('N00');
    expect(valid('/plugins/{id}/keys/{name}', 'delete', call(s, 'DELETE', '/plugins/notion/keys/PATH')).body.error.code).toBe('unknown_key');
    const cleared = valid('/plugins/{id}/keys/{name}', 'delete', call(s, 'DELETE', '/plugins/notion/keys/NOTION_TOKEN'));
    expect(cleared.body.plugin.missing).toEqual(['NOTION_TOKEN']);
    expect(valid('/plugins/{id}/keys/{name}', 'delete', call(s, 'DELETE', '/plugins/notion/keys/NOTION_TOKEN')).body.error.code).toBe('not_saved');
    const rv = valid('/plugins/review', 'post', call(s, 'POST', '/plugins/review', { package: 'offline-mcp' }));
    expect(rv.body.review).toMatchObject({ aiReviewed: false, verdict: 'caution' });
    expect(needsTrust(rv.body.review)).toBe(true);
    expect(valid('/plugins/approve', 'post', call(s, 'POST', '/plugins/approve', { package: 'offline-mcp' })).body.error.code).toBe('unreviewed');
    expect(valid('/plugins/approve', 'post', call(s, 'POST', '/plugins/approve', { package: 'offline-mcp', acceptRisk: true })).status).toBe(200);
    valid('/plugins/review', 'post', call(s, 'POST', '/plugins/review', { package: 'weather-mcp' })); // weather-mcp is already one of yours
    expect(valid('/plugins/approve', 'post', call(s, 'POST', '/plugins/approve', { package: 'weather-mcp' })).body.error.code).toBe('name_taken');
    expect(call(s, 'DELETE', '/plugins/__proto__').status).toBe(404);
  });
  it('npm-off: the list says why, and a review is refused with the same reason', () => {
    const s = new FixtureServer('npm-off');
    const l = get(s, '/plugins').body as PluginList;
    expect(l.addFromNpm).toMatchObject({ available: false, reason: expect.stringContaining('turned off') });
    const r = valid('/plugins/review', 'post', call(s, 'POST', '/plugins/review', { package: 'weather-mcp' }));
    expect(r.body.error).toMatchObject({ code: 'npm_unavailable', message: l.addFromNpm.reason });
  });
});

describe('Plug-ins\' words', () => {
  const s = new FixtureServer('N00');
  const list = get(s, '/plugins').body as PluginList;
  it('groups On, Available and Your own', () => {
    const g = groupPlugins(list);
    expect(g.on.map((p) => p.id)).toEqual(['search', 'fetch', 'thinking']);
    expect(g.available.map((p) => p.id)).toEqual(['docs', 'browser', 'github', 'notion', 'tavily', 'firecrawl']);
    expect(g.custom.map((c) => c.id)).toEqual(['weather-mcp', 'barn-notes']);
  });
  it('says what a plug-in needs, plainly', () => {
    const by = (id: string) => list.plugins.find((p) => p.id === id) as Plugin;
    expect(keyLine(by('fetch'))).toBeNull();
    expect(keyLine(by('github'))).toBe('Needs your GitHub personal access token before it can turn on.');
    expect(keyLine(by('notion'))).toBe('Notion integration token saved.');
    expect(keyLine(by('search'))).toBe('Brave Search API key: optional.');
    expect(customTitle(list.custom[0])).toBe('weather-mcp');
    expect(customTitle(list.custom[1])).toBe('barn-notes');
    expect(customTitle({ id: 'x', command: 'npx -y @scope/srv@2.0.0', package: '@scope/srv@2.0.0', envNames: [] })).toBe('@scope/srv');
  });
  it('says the review\'s verdict and scan plainly', () => {
    expect(verdictWords('safe')).toEqual({ title: 'Looks safe', tone: 'ok' });
    expect(verdictWords('caution').title).toBe('Be careful');
    expect(verdictWords('dangerous').tone).toBe('bad');
    const r = (scan: PluginReview['scan']) => ({ scan } as PluginReview);
    expect(scanLine(r({ ran: true, files: 14, checksum: 'verified', note: null }))).toBe('14 files checked. The download matches what npm lists.');
    expect(scanLine(r({ ran: true, files: 3, checksum: 'mismatch', note: null }))).toMatch(/don’t install it/);
    expect(scanLine(r({ ran: false, files: null, checksum: 'unknown', note: 'too big' }))).toBe('Its code wasn’t checked (too big).');
    const base = { verdict: 'safe', aiReviewed: true, version: '1.0.0' } as PluginReview;
    expect(needsTrust(base)).toBe(false);
    expect(needsTrust({ ...base, verdict: 'dangerous' })).toBe(true);
    expect(needsTrust({ ...base, aiReviewed: false })).toBe(true);
    expect(installable(base)).toBe(true);
    expect(installable({ ...base, version: null })).toBe(false);
  });
});
