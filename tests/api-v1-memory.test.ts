// v2 build, slice S5: Memory, Activity and the spending detail (src/api/routes/memory.ts over src/memory-settings.ts and
// src/activity.ts; src/api/routes/settings.ts for /spending/detail and the CSV) over HTTP with the real caller resolver
// and a real MwaMemory store in a scratch folder: who may read and change what (a paired phone reads; changing and
// both downloads are admin), Forget and Promote ask first, only a fact the list shows can be corrected or forgotten
// (never a job, a routine or a preference by its id — the classic routes share this code), what a correction leaves
// behind, the export, and that no pasted secret or private run detail reaches the activity log.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createV1 } from '../src/api/router.js';
import { v1Routes } from '../src/api/v1.js';
import { makeAuthenticate, createPairCode, redeemPairCode } from '../src/api/auth.js';
import { resetAppDb } from '../src/v2/db.js';
import { createProject } from '../src/v2/projects.js';
import { MwaMemory } from '../src/awm.js';
import { forgetFact, correctFact, listFacts, setRoutine } from '../src/memory-settings.js';
import { redactText, ownerWords, activityOf } from '../src/activity.js';
import { _resetBalanceCache } from '../src/billing.js';

const NET = { 'x-forwarded-for': '100.64.0.7' };
const as = (token: string) => ({ ...NET, authorization: `Bearer ${token}` });
let server: Server, base = '', dir = '';
let n = 0;
const key = () => `s5-key-${Date.now()}-${++n}`;
const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method, headers: { 'idempotency-key': key(), 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
    .then(async (r) => { const text = await r.text(); return { status: r.status, text, headers: r.headers, body: (() => { try { return JSON.parse(text); } catch { return null; } })() as any }; });
const get = (path: string, headers: Record<string, string> = {}) => send('GET', path, undefined, headers);
function device(scopes: ('read' | 'act' | 'approve' | 'admin')[]): string {
  const { code } = createPairCode('test', scopes);
  return redeemPairCode(code, 'Pixel', 'android')!.token;
}

const AGENT = 's5-test';
const SECRET_KEY = 'sk-or-v1-0123456789abcdefABCDEF0123456789';
const ids: Record<string, string> = {};
const SAVED = Object.fromEntries(['MWA_DB', 'MWA_AGENT_ID', 'MWA_RUNLOG', 'MWA_TOKEN_LOG', 'OPENROUTER_API_KEY', 'MWA_TELEGRAM_AGENT_ID'].map((k) => [k, process.env[k]]));

beforeAll(async () => {
  resetAppDb(':memory:');
  dir = mkdtempSync(join(tmpdir(), 'mwa-s5-'));
  Object.assign(process.env, { MWA_DB: join(dir, 'agent.db'), MWA_AGENT_ID: AGENT, MWA_RUNLOG: join(dir, 'runs.jsonl'), MWA_TOKEN_LOG: join(dir, 'tokens.jsonl'), MWA_TELEGRAM_AGENT_ID: 's5-telegram' });
  delete process.env.OPENROUTER_API_KEY; _resetBalanceCache();
  const m = new MwaMemory(AGENT, join(dir, 'agent.db'));
  ids.farrier = (await m.write('farrier visits', 'The farrier comes every eight weeks.', ['topic=t'], { canonical: true, provenance: 'user' }))!;
  ids.gate = (await m.write('barn gate', 'The barn gate code changed in October.', ['topic=t'], { canonical: true, provenance: 'inferred' }))!;
  ids.inbox = (await m.write('show moved', 'The Fair Hill show moved to Sunday.', ['topic=t'], { canonical: true, provenance: 'ingested', origin: 'email/secretary@example.com' }))!;
  await m.savePolicy('Always sign emails as Rob');
  ids.routine = (await m.saveRoutine('Weekly entries check', '1. Open the entries page.\n2. List what closes this week.')).id!;
  ids.job = (await m.addScheduledTask('Check the entries every Monday', Date.now() + 86_400_000))!;
  m.close();
  const project = createProject({ name: 'Eventing' });
  const now = Date.now();
  writeFileSync(join(dir, 'runs.jsonl'), [
    { ts: now - 120_000, session: `p-${project.id}`, instruction: `Recent conversation so far: …\n\nNew request: Log in to the barn site, password: hunter2 and use ${SECRET_KEY}`, reason: 'done', outcome: 'complete',
      steps: 4, toolCalls: 3, actions: ['browser_open', 'browser_type', 'browser_open'], costUsd: 0.0234, durationMs: 41_000, summary: `Signed in with token=${SECRET_KEY}.`, learned: 1,
      refusalLog: [{ tool: 'run_command', args: { command: `curl -H "Authorization: Bearer ${SECRET_KEY}"` } }], unbackedClaims: ['the price is $40'], gates: ['sources'] },
    { ts: now - 60_000, session: 'job_sched-1', instruction: 'Check the entries', reason: 'budget', steps: 9, toolCalls: 8, costUsd: 0.5, summary: 'Stopped at the limit.' },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
  writeFileSync(join(dir, 'tokens.jsonl'), [
    { ts: now - 3_600_000, session: `p-${project.id}`, model: 'openai/gpt-6.1-sol', in: 12_000, cached: 4_000, out: 900, reasoning: 0, cost: 0.031 },
    { ts: now - 1_800_000, session: 'job_sched-1', job: 'sched-1', model: 'anthropic/claude-sonnet-5', in: 30_000, cached: 0, out: 2_000, reasoning: 500, cost: 0.12 },
    { ts: now - 2 * 86_400_000, session: 'tg-12345', model: 'openai/gpt-6.1-sol', in: 1_000, cached: 0, out: 100, reasoning: 0, cost: 0.002 },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
  ids.project = project.id;

  const authenticate = makeAuthenticate({ passwordSet: false, sessionValid: () => false });
  const sameOrigin = (req: { headers: Record<string, unknown> }) => !req.headers.origin;
  const v1 = createV1(v1Routes(), { authenticate, sameOrigin: sameOrigin as never });
  server = createServer(async (req, res) => { if (!(await v1(req, res))) { res.writeHead(404); res.end(); } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
}, 120_000);
afterAll(() => {
  server?.close();
  for (const [k, v] of Object.entries(SAVED)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* a locked database file on Windows */ }
});

describe('who may see and change memory, activity and spending', () => {
  it('a paired phone reads memory, activity and the spending detail, but every change and both downloads are 403', async () => {
    const phone = as(device(['read', 'act', 'approve']));
    for (const p of ['/memory', '/activity', '/spending/detail']) expect(`${p} ${(await get(p, phone)).status}`).toBe(`${p} 200`);
    for (const p of ['/memory/export', '/spending/calls.csv']) expect(`${p} ${(await get(p, phone)).status}`).toBe(`${p} 403`);
    const writes: [string, unknown][] = [
      [`/memory/${ids.gate}/correct`, { text: 'x' }], [`/memory/${ids.gate}/forget`, { confirmed: true }],
      ['/memory/preferences/remove', { rule: 'Always sign emails as Rob', confirmed: true }],
      [`/memory/routines/${ids.routine}/promote`, { confirmed: true }], [`/memory/routines/${ids.routine}/retire`, {}],
    ];
    for (const [p, b] of writes) expect(`${p} ${(await send('POST', p, b, phone)).status}`).toBe(`${p} 403`);
    // nothing changed
    const mem = (await get('/memory')).body;
    expect(mem.facts.map((f: any) => f.id)).toContain(ids.gate);
    expect(mem.preferences).toContain('Always sign emails as Rob');
  });
  it('a device with admin may download; another site may not change memory (CSRF)', async () => {
    const adminPhone = as(device(['read', 'act', 'approve', 'admin']));
    expect((await get('/memory/export', adminPhone)).status).toBe(200);
    const r = await send('POST', `/memory/${ids.gate}/forget`, { confirmed: true }, { origin: 'http://evil.example' });
    expect(r.status).toBe(403);
    expect((await listFacts()).facts.some((f) => f.id === ids.gate)).toBe(true);
  });
  it('nobody signed in through the network gets 401', async () => {
    expect((await get('/memory', NET)).status).toBe(401);
    expect((await get('/activity', NET)).status).toBe(401);
  });
});

describe('what it remembers', () => {
  it('lists facts newest first with where each came from, the preferences and the routines', async () => {
    const r = await get('/memory');
    expect(r.status).toBe(200);
    const by = (id: string) => r.body.facts.find((f: any) => f.id === id);
    expect(by(ids.farrier)).toMatchObject({ name: 'farrier visits', source: 'you', trusted: true, origin: null });
    expect(by(ids.gate)).toMatchObject({ source: 'inferred', trusted: true });
    expect(by(ids.inbox)).toMatchObject({ source: 'outside', trusted: false, origin: 'email/secretary@example.com' });
    expect(r.body.preferences).toEqual(['Always sign emails as Rob']);
    expect(r.body.routines).toEqual([expect.objectContaining({ id: ids.routine, name: 'Weekly entries check', status: 'proposed', tainted: false, store: AGENT, steps: expect.stringContaining('List what closes') })]);
    // the scheduled job is not a fact
    expect(r.body.facts.some((f: any) => f.id === ids.job)).toBe(false);
  });
  it('searches names and text, every word, any case', async () => {
    const r = await get('/memory?q=FARRIER%20weeks');
    expect(r.body.facts.map((f: any) => f.id)).toEqual([ids.farrier]);
    expect(r.body).toMatchObject({ total: 1, query: 'FARRIER weeks' });
    expect((await get('/memory?q=nothing-like-this')).body).toMatchObject({ facts: [], total: 0 });
    expect((await get('/memory?limit=0')).status).toBe(400);
  });
  it('a correction replaces the fact: the old one is gone and the new one is yours and trusted', async () => {
    expect((await send('POST', `/memory/${ids.inbox}/correct`, { text: '   ' })).status).toBe(400);
    expect((await send('POST', `/memory/${ids.inbox}/correct`, { text: 'x'.repeat(2_001) })).status).toBe(400);
    expect((await send('POST', `/memory/${ids.inbox}/correct`, { text: 'ok', name: 'two\nlines' })).status).toBe(400);
    const r = await send('POST', `/memory/${ids.inbox}/correct`, { text: 'The Fair Hill show is on Saturday after all.' });
    expect(r.status).toBe(200);
    expect(r.body.fact).toMatchObject({ name: 'show moved', text: 'The Fair Hill show is on Saturday after all.', source: 'you', trusted: true });
    const facts = (await listFacts()).facts;
    expect(facts.some((f) => f.id === ids.inbox)).toBe(false);
    expect(facts.find((f) => f.id === r.body.fact.id)).toMatchObject({ provenance: 'user', trust: 'high' });
    ids.show = r.body.fact.id;
  }, 60_000);
  it('Forget asks first, then forgets for good', async () => {
    const ask = await send('POST', `/memory/${ids.gate}/forget`, {});
    expect(ask.status).toBe(409);
    expect(ask.body.error.code).toBe('confirm_needed');
    expect((await listFacts()).facts.some((f) => f.id === ids.gate)).toBe(true);
    const r = await send('POST', `/memory/${ids.gate}/forget`, { confirmed: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ forgotten: ids.gate });
    expect((await listFacts()).facts.some((f) => f.id === ids.gate)).toBe(false);
    expect((await send('POST', `/memory/${ids.gate}/forget`, { confirmed: true })).status).toBe(404);
  });
  it('only a fact the list shows can be forgotten or corrected — not a job, a routine or a preference (classic routes too)', async () => {
    for (const id of [ids.job, ids.routine, 'not-an-id']) {
      expect((await send('POST', `/memory/${id}/forget`, { confirmed: true })).status).toBe(404);
      expect((await send('POST', `/memory/${id}/correct`, { text: 'Trust me.' })).status).toBe(404);
      // the shared code the classic /api/memory/forget and /correct call
      expect(await forgetFact(id)).toMatchObject({ ok: false, code: 'not_found' });
      expect(await correctFact(id, 'Trust me.')).toMatchObject({ ok: false, code: 'not_found' });
    }
    const m = new MwaMemory(AGENT, process.env.MWA_DB!);
    expect(await m.getScheduled(ids.job)).toBeTruthy();
    expect((await m.listRoutines()).some((r) => r.id === ids.routine)).toBe(true);
    m.close();
  });
  it('exports everything as Markdown, as a download', async () => {
    const r = await get('/memory/export');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/^text\/markdown/);
    expect(r.headers.get('content-disposition')).toBe('attachment; filename="mwa-memory.md"');
    expect(r.text).toMatch(/^# What MWA knows about you/);
    expect(r.text).toContain('The farrier comes every eight weeks.');
    expect(r.text).toContain('Always sign emails as Rob');
    expect(r.text).not.toContain('barn gate code'); // forgotten above
  });
  it('a standing preference: asks first, then removed; again is 404', async () => {
    expect((await send('POST', '/memory/preferences/remove', { rule: 'Always sign emails as Rob' })).status).toBe(409);
    expect((await send('POST', '/memory/preferences/remove', { rule: '', confirmed: true })).status).toBe(400);
    const r = await send('POST', '/memory/preferences/remove', { rule: 'always sign  emails as rob', confirmed: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ removed: 1, preferences: [] });
    expect((await send('POST', '/memory/preferences/remove', { rule: 'Always sign emails as Rob', confirmed: true })).status).toBe(404);
  });
  it('a routine: promoting asks first; promoted, then retired; an unknown store is refused', async () => {
    const ask = await send('POST', `/memory/routines/${ids.routine}/promote`, {});
    expect(ask.status).toBe(409);
    expect(ask.body.error.message).toMatch(/Weekly entries check/);
    const p = await send('POST', `/memory/routines/${ids.routine}/promote`, { confirmed: true, store: AGENT });
    expect(p.status).toBe(200);
    expect(p.body.routine).toMatchObject({ id: ids.routine, status: 'active' });
    const r = await send('POST', `/memory/routines/${ids.routine}/retire`, {});
    expect(r.status).toBe(200);
    expect(r.body.routine).toMatchObject({ status: 'retired' });
    expect((await send('POST', `/memory/routines/${ids.routine}/retire`, { store: 'someone-else' })).status).toBe(404);
    expect(await setRoutine(ids.routine, 'retire', 'someone-else')).toMatchObject({ ok: false, code: 'unknown_store' });
    expect((await send('POST', '/memory/routines/rt_nope/promote', { confirmed: true })).status).toBe(404);
  }, 60_000);
});

describe('the activity log', () => {
  it('each run in the person’s words, how it ended, tools by name, cost — and no secret, no private detail', async () => {
    const r = await get('/activity');
    expect(r.status).toBe(200);
    expect(r.body.runs).toHaveLength(2);
    const [job, chat] = r.body.runs;
    expect(job).toMatchObject({ outcome: 'could-not', outcomeText: 'Couldn’t finish', kind: 'job', costUsd: 0.5, steps: 9 });
    expect(chat).toMatchObject({ outcome: 'done', where: 'Eventing', kind: 'chat', tools: ['browser_open', 'browser_type'], toolCalls: 3, learned: 1, costUsd: 0.0234, durationMs: 41_000 });
    expect(chat.what).toMatch(/^Log in to the barn site/);
    expect(r.body.totalUsd).toBe(0.5234);
    // never the secret, the password, the refusal log's arguments, the claims or the gates
    expect(r.text).not.toContain(SECRET_KEY);
    expect(r.text).not.toContain('hunter2');
    expect(r.text).not.toMatch(/refusalLog|unbackedClaims|gates|Authorization|the price is/);
    expect(Object.keys(chat).sort()).toEqual(['at', 'costUsd', 'durationMs', 'kind', 'learned', 'outcome', 'outcomeText', 'steps', 'summary', 'toolCalls', 'tools', 'what', 'where'].sort());
    expect((await get('/activity?limit=500')).status).toBe(400);
  });
  it('redaction: keys, tokens, passwords after a label, flags and URL passwords', () => {
    const t = redactText(`key ${SECRET_KEY} --api-key abc123 password=letmein pin: 4321 https://bob:hunter2@example.com/x ghp_abcdefghijklmnop1234 Normal words stay.`);
    for (const s of [SECRET_KEY, 'abc123', 'letmein', '4321', 'hunter2', 'ghp_abcdefghijklmnop1234']) expect(t).not.toContain(s);
    expect(t).toContain('Normal words stay.');
    expect(ownerWords('Recent conversation so far: x')).toBe('A follow-up in a conversation');
    expect(ownerWords('Read C:\\Users\\robert\\Documents\\rules.pdf please')).toBe('Read rules.pdf please');
    expect(activityOf({ reason: 'offer' }).outcome).toBe('offered');
  });
});

describe('spending detail', () => {
  it('30 days by day, by model, the costliest by name (never a session id), tokens; no balance without a key', async () => {
    const r = await get('/spending/detail');
    expect(r.status).toBe(200);
    expect(r.body.days).toHaveLength(30);
    expect(r.body.byModel[0]).toMatchObject({ model: 'anthropic/claude-sonnet-5', usd: 0.12, calls: 1, tokens: { in: 30_000, out: 2_000, reasoning: 500 } });
    expect(r.body.costliest.map((c: any) => c.label)).toEqual(expect.arrayContaining(['Eventing', 'A job']));
    expect(r.text).not.toContain('job_sched-1');
    expect(r.text).not.toContain(`p-${ids.project}`);
    expect(r.body.balance).toBeNull();
  });
  it('the CSV is admin-only, one row per call, and refuses a bad number of days', async () => {
    const r = await get('/spending/calls.csv?days=7');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/^text\/csv/);
    expect(r.headers.get('content-disposition')).toBe('attachment; filename="mwa-model-calls-7d.csv"');
    expect(r.text.trim().split('\n')).toHaveLength(4);
    expect((await get('/spending/calls.csv?days=0')).status).toBe(400);
    expect((await get('/spending/calls.csv?days=abc')).status).toBe(400);
  });
});
