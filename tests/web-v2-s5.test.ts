// v2 build, slice S5: What I remember, Activity and Spending in fixture mode (web/src/v2/dev/fixtures-memory.ts) answer
// with the contract's shapes and the server's rules (a phone reads but cannot change or download; Forget, Remove and
// Promote ask first; only a listed fact can be corrected or forgotten; the downloads are files), the client hands a
// downloaded file over with its name, and the screens' words (screens/settings/useMemory.ts). The screens themselves
// run in the browser: scripts/v2-s5-smoke.mjs.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { FixtureServer, fixtureFetch } from '../web/src/v2/dev/fixtures';
import { MwaClient } from '../web/src/v2/api/client';
import {
  ageMarks, balanceLine, barHeights, chartSummary, countLine, dayLabel, durationLine, groupFacts, routineLine, runLine, sourceLabel, tokens, tokensLine, usd, whenLine,
} from '../web/src/v2/screens/settings/useMemory';
import type { ActivityRun, MemoryFact } from '../web/src/v2/api/client';

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
  return res as { status: number; body: any; text?: string; headers?: Record<string, string> };
}
const H = { 'x-mwa-client': 'web/1.0.0' };
let k = 0;
const call = (s: FixtureServer, method: string, path: string, body?: unknown) =>
  s.handle({ method, path, query: new URLSearchParams(), headers: { ...H, 'idempotency-key': `s5-key-${++k}` }, body });
const get = (s: FixtureServer, path: string) => {
  const u = new URL(path, 'http://x');
  return s.handle({ method: 'GET', path: u.pathname, query: u.searchParams, headers: H, body: undefined });
};

describe('S5 fixture mode answers like the server', () => {
  it('memory, activity and the spending detail have the contract’s shapes', () => {
    const s = new FixtureServer('N00');
    const mem = valid('/memory', 'get', get(s, '/memory'));
    expect(mem.body.facts.length).toBeGreaterThan(4);
    expect(mem.body.routines.some((r: any) => r.tainted)).toBe(true);
    valid('/memory', 'get', get(s, '/memory?q=farrier'));
    expect(get(s, '/memory?q=farrier').body).toMatchObject({ total: 1, query: 'farrier' });
    valid('/activity', 'get', get(s, '/activity'));
    const d = valid('/spending/detail', 'get', get(s, '/spending/detail'));
    expect(d.body.days).toHaveLength(30);
    expect(get(s, '/memory?limit=0').status).toBe(400);
  });
  it('a correction, Forget (after asking), Remove (after asking), Promote (after asking) and Retire', () => {
    const s = new FixtureServer('N00');
    expect(call(s, 'POST', '/memory/mem_1/forget', {}).status).toBe(409);
    valid('/memory/{id}/forget', 'post', call(s, 'POST', '/memory/mem_1/forget', { confirmed: true }));
    expect(call(s, 'POST', '/memory/mem_1/forget', { confirmed: true }).status).toBe(404);
    expect(call(s, 'POST', '/memory/mem_2/correct', { text: ' ' }).status).toBe(400);
    // mem_4 came from an email: it asks first, and the outside words can't just be kept
    expect(call(s, 'POST', '/memory/mem_4/correct', { text: 'Entries close Thursday.' }).status).toBe(409);
    expect(call(s, 'POST', '/memory/mem_4/correct', { text: 'Entries for the Fair Hill horse trials close Friday at 5 PM. OK', confirmed: true }).status).toBe(400);
    expect((call(s, 'POST', '/memory/mem_2/correct', { text: 'x', name: 'goal: y' }).body as any).error.code).toBe('bad_name');
    const c = valid('/memory/{id}/correct', 'post', call(s, 'POST', '/memory/mem_4/correct', { text: 'Entries close Thursday.', confirmed: true }));
    expect(c.body.fact).toMatchObject({ text: 'Entries close Thursday.', source: 'you', trusted: true });
    expect(call(s, 'POST', '/memory/rt_entries_v2/forget', { confirmed: true }).status).toBe(404); // a routine is not a fact
    const rule = get(s, '/memory').body.preferences[0];
    expect(call(s, 'POST', '/memory/preferences/remove', { rule }).status).toBe(409);
    valid('/memory/preferences/remove', 'post', call(s, 'POST', '/memory/preferences/remove', { rule, confirmed: true }));
    expect(call(s, 'POST', '/memory/routines/rt_entries_v2/promote', {}).status).toBe(409);
    const p = valid('/memory/routines/{id}/promote', 'post', call(s, 'POST', '/memory/routines/rt_entries_v2/promote', { confirmed: true, store: 'mwa-serve' }));
    expect(p.body.routine.status).toBe('active');
    expect(valid('/memory/routines/{id}/retire', 'post', call(s, 'POST', '/memory/routines/rt_entries_v2/retire', { store: 'mwa-serve' })).body.routine.status).toBe('retired');
  });
  it('a long fact: a marked preview with the whole text; a correction made from the preview is refused', () => {
    const s = new FixtureServer('N00');
    const long = get(s, '/memory').body.facts.find((f: any) => f.name === 'Barn rules');
    expect(long).toMatchObject({ truncated: true });
    expect(long.full.length).toBeGreaterThan(240);
    expect(long.text.endsWith('…')).toBe(true);
    expect(get(s, '/memory?q=lessons%20priority').body.facts.map((f: any) => f.name)).toEqual(['Barn rules']);
    expect((call(s, 'POST', `/memory/${long.id}/correct`, { text: long.text }).body as any).error.code).toBe('truncated');
    const ok = valid('/memory/{id}/correct', 'post', call(s, 'POST', `/memory/${long.id}/correct`, { text: long.full.replace('7 AM', '6:30 AM') }));
    expect(ok.body.fact.full).toContain('lessons have priority');
  });
  it('a paired phone reads but cannot change memory or download either file', () => {
    const s = new FixtureServer('phone');
    expect(get(s, '/memory').status).toBe(200);
    expect(get(s, '/activity').status).toBe(200);
    expect(get(s, '/spending/detail').status).toBe(200);
    expect(get(s, '/memory/export').status).toBe(403);
    expect(get(s, '/spending/calls.csv').status).toBe(403);
    for (const p of ['/memory/mem_1/forget', '/memory/mem_1/correct', '/memory/preferences/remove', '/memory/routines/rt_entries_v2/promote', '/memory/routines/rt_news_v1/retire']) {
      expect(`${p} ${call(s, 'POST', p, { confirmed: true, text: 'x', rule: 'x' }).status}`).toBe(`${p} 403`);
    }
  });
  it('the downloads are files, and the client hands them over with their names', async () => {
    const s = new FixtureServer('N00');
    const c = new MwaClient({ fetch: fixtureFetch(s) });
    const md = await c.exportMemory();
    expect(md).toMatchObject({ filename: 'mwa-memory.md', type: 'text/markdown' });
    expect(md.text).toMatch(/^# What MWA knows about you/);
    const csv = await c.downloadSpendingCsv(30);
    expect(csv).toMatchObject({ filename: 'mwa-model-calls-30d.csv', type: 'text/csv' });
    expect(csv.text).toMatch(/^time,session,job,model/);
    const phone = new MwaClient({ fetch: fixtureFetch(new FixtureServer('phone')) });
    await expect(phone.exportMemory()).rejects.toMatchObject({ status: 403 });
  });
  it('memory-empty: nothing learned, no runs', () => {
    const s = new FixtureServer('memory-empty');
    expect(get(s, '/memory').body).toMatchObject({ facts: [], total: 0, preferences: [], routines: [] });
    expect(get(s, '/activity').body).toMatchObject({ runs: [], totalUsd: 0 });
  });
});

describe('S5 words', () => {
  const fact = (o: Partial<MemoryFact>): MemoryFact => ({ id: 'm', name: 'x', text: 't', about: false, source: 'you', origin: null, trusted: true, ...o });
  it('where a fact came from, and the groups', () => {
    expect(sourceLabel(fact({}))).toBe('You told me');
    expect(sourceLabel(fact({ about: true }))).toBe('About you');
    expect(sourceLabel(fact({ source: 'inferred' }))).toBe('I worked this out');
    expect(sourceLabel(fact({ source: 'outside', origin: 'email/jane@x.example', trusted: false }))).toBe('From an email from jane@x.example');
    expect(sourceLabel(fact({ source: 'outside', trusted: false }))).toBe('From a file, an email or the web');
    const g = groupFacts([fact({ id: 'a' }), fact({ id: 'b', source: 'inferred' }), fact({ id: 'c', source: 'outside' })]);
    expect([g.you.length, g.inferred.length, g.outside.length]).toEqual([1, 1, 1]);
  });
  it('the same thing noted twice: newest and older', () => {
    const m = ageMarks([fact({ id: 'a', name: 'School pickup' }), fact({ id: 'b', name: 'Farrier' }), fact({ id: 'c', name: 'school  pickup!' })]);
    expect([m.get('a'), m.get('b'), m.get('c')]).toEqual(['newest', undefined, 'older']);
  });
  it('counts, routines', () => {
    expect(countLine({ total: 0, query: '' }, 0)).toBe('Nothing learned yet.');
    expect(countLine({ total: 50, query: '' }, 40)).toBe('50 things I’ve learned, the newest 40 shown.');
    expect(countLine({ total: 1, query: 'farrier' }, 1)).toBe('1 thing matches “farrier”.');
    expect(countLine({ total: 0, query: 'zz' }, 0)).toBe('Nothing matches “zz”.');
    expect(routineLine({ id: 'r', name: 'n', version: 'v1', status: 'proposed', steps: '', tainted: true, store: 's' })).toMatch(/outside content/);
    expect(routineLine({ id: 'r', name: 'n', version: 'v1', status: 'active', steps: '', tainted: false, store: 's' })).toMatch(/^In use/);
  });
  it('money, tokens, time and a run', () => {
    expect([usd(0), usd(0.0041), usd(0.38), usd(12.5)]).toEqual(['$0', '$0.0041', '$0.38', '$12.50']);
    expect([tokens(900), tokens(12_345), tokens(250_000), tokens(2_400_000)]).toEqual(['900', '12.3k', '250k', '2.4M']);
    const now = new Date(2026, 10, 9, 9, 10).getTime();
    expect(whenLine(new Date(2026, 10, 9, 8, 45).getTime(), now)).toBe('Today 8:45 AM');
    expect(whenLine(new Date(2026, 10, 8, 18, 10).getTime(), now)).toBe('Yesterday 6:10 PM');
    expect(whenLine(new Date(2026, 10, 3, 14, 15).getTime(), now)).toBe('Nov 3, 2:15 PM');
    expect([durationLine(9_000), durationLine(360_000), durationLine(null)]).toEqual(['9 seconds', '6 minutes', null]);
    const r: ActivityRun = { at: now, what: 'x', outcome: 'done', outcomeText: 'Done', where: 'Eventing', kind: 'chat', steps: 2, toolCalls: 1, tools: [], learned: 1, costUsd: 0.0041, durationMs: 9_000, summary: null };
    expect(runLine(r)).toBe('Done · Eventing · 2 steps · 9 seconds · $0.0041 · learned 1 thing');
  });
  it('the chart: heights, its text alternative, day names, tokens and the balance', () => {
    const days = [{ day: '2026-11-07', usd: 0, calls: 0 }, { day: '2026-11-08', usd: 0.01, calls: 2 }, { day: '2026-11-09', usd: 0.5, calls: 40 }];
    expect(barHeights(days)).toEqual([0, 4, 100]);
    expect(chartSummary(days)).toBe('$0.51 over the last 3 days, on 2 days. The most was $0.50 on Nov 9.');
    expect(chartSummary([{ day: '2026-11-09', usd: 0, calls: 0 }])).toBe('Nothing spent from Nov 9 to Nov 9.');
    expect(dayLabel('2026-11-01')).toBe('Nov 1');
    expect(tokensLine({ in: 1_840_000, cached: 610_000, out: 96_400, reasoning: 0 })).toBe('1.8M in (610k reused), 96.4k out');
    const now = new Date(2026, 10, 9, 9, 10).getTime();
    expect(balanceLine({ provider: 'openrouter', label: 'OpenRouter', remainingUsd: 18.71, at: now - 240_000 }, now)).toBe('$18.71 left on OpenRouter (checked 9:06 AM).');
    expect(balanceLine(null)).toBeNull();
  });
});
