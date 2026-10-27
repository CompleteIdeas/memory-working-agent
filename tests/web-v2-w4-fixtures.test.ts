// v2 build, slice W4: fixture mode's projects, threads and Ask (web/src/v2/dev/fixtures-w4.ts) answer with the
// contract's shapes — every response here, success and refusal, is validated against api/openapi.yaml — and behave
// like the server where the screens rely on it (a plan's words, the choice made once, paging by position, the
// running turn retiring, the stream's `live` and `ask` events).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { FixtureServer, type StreamMessage } from '../web/src/v2/dev/fixtures';
import { flushRuns, forgetFile } from '../web/src/v2/dev/fixtures-w4';
import type { AskStart, AskChosen, Turn } from '../web/src/v2/api/client';

const spec = parse(readFileSync(new URL('../api/openapi.yaml', import.meta.url), 'utf8'));
const ajv = new (Ajv2020 as unknown as typeof Ajv2020.default)({ strict: false, allErrors: true });
(addFormats as unknown as typeof addFormats.default)(ajv);
ajv.addSchema({ $id: 'spec', components: spec.components });
function schemaFor(path: string, method: string, status: number): object {
  const op = spec.paths[path][method];
  const r = op.responses[String(status)] ?? op.responses.default;
  const resolved = r.$ref ? spec.components.responses[r.$ref.split('/').pop()] : r;
  return JSON.parse(JSON.stringify(resolved.content['application/json'].schema).replace(/"#\/components\//g, '"spec#/components/'));
}
function valid(path: string, method: string, res: { status: number; body: unknown }, status?: number) {
  const fn = ajv.compile(schemaFor(path, method, res.status));
  expect(fn(res.body) ? null : `${method.toUpperCase()} ${path} ${res.status}: ${ajv.errorsText(fn.errors)}`).toBeNull();
  if (status !== undefined) expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res;
}
const schema = (name: string) => ajv.compile({ $ref: `spec#/components/schemas/${name}` });
const H = { 'x-mwa-client': 'web/1.0.0' };
const get = (s: FixtureServer, path: string, q = '') => s.handle({ method: 'GET', path, query: new URLSearchParams(q), headers: H, body: undefined });
let k = 0;
const send = (s: FixtureServer, method: string, path: string, body?: unknown, key = `w4-key-${++k}`) => s.handle({ method, path, query: new URLSearchParams(), headers: { ...H, 'idempotency-key': key }, body });
const post = (s: FixtureServer, path: string, body?: unknown, key?: string) => send(s, 'POST', path, body, key);
const PDFS = ['fixtures/uploads/icp-eventing-handbook.pdf', 'fixtures/uploads/usef-eventing-rules-2025.pdf'];

function fresh(scenario = 'N00') { const s = new FixtureServer(scenario); s.answerDelay = -1; return s; }

describe('W4 fixture reads have the contract\'s shapes', () => {
  it('suggest, thread pages, files, work, asks about a thing, suggestions, an ask', () => {
    const s = fresh('thread-long');
    valid('/projects/suggest', 'get', get(s, '/projects/suggest', 'text=book fair for Riley'), 200);
    valid('/projects/suggest', 'get', get(s, '/projects/suggest', 'text=hello&from=eventing'), 200);
    valid('/projects/suggest', 'get', get(s, '/projects/suggest', 'text='), 400);
    const page = valid('/projects/{id}/thread', 'get', get(s, '/projects/eventing/thread', 'limit=50'), 200).body as { turns: Turn[]; next: string | null };
    expect(page.turns).toHaveLength(50);
    valid('/projects/{id}/thread', 'get', get(s, '/projects/eventing/thread', `before=${encodeURIComponent(page.next!)}&limit=30`), 200);
    valid('/projects/{id}/thread', 'get', get(s, '/projects/eventing/thread', 'before=nonsense'), 400);
    valid('/projects/{id}/thread', 'get', get(s, '/projects/nope/thread'), 404);
    valid('/projects/{id}/files', 'get', get(s, '/projects/eventing/files'), 200);
    valid('/projects/{id}/files', 'get', get(s, '/projects/health/files'), 200);
    valid('/projects/{id}/work', 'get', get(s, '/projects/ainews/work'), 200);
    valid('/projects/{id}/work', 'get', get(s, '/projects/general/work'), 200);
    for (const about of ['job:j_news', 'item:i-bookfair', 'item:i-quotes', 'mail:m_m1', 'event:google:e5', 'draft:cd_e9', 'conflict:google:e10|google:e11']) {
      valid('/ask/suggestions', 'get', get(s, '/ask/suggestions', `about=${encodeURIComponent(about)}`), 200);
      valid('/ask', 'get', get(s, '/ask', `about=${encodeURIComponent(about)}`), 200);
    }
    valid('/ask/suggestions', 'get', get(s, '/ask/suggestions', 'about=job:nope'), 404);
    valid('/ask', 'get', get(s, '/ask', 'about=bad'), 400);
    const a = post(s, '/ask', { text: 'Who else is going?', about: { kind: 'item', id: 'i-bookfair' } }).body as AskStart;
    valid('/ask/{id}', 'get', get(s, `/ask/${a.askId}`), 200);
    valid('/ask', 'get', get(s, '/ask', 'about=item:i-bookfair'), 200);
    valid('/ask/{id}', 'get', get(s, '/ask/nope'), 404);
  });

  it('a thread pages by position until its start, each turn once, oldest first', () => {
    const s = fresh('thread-long');
    const all: Turn[] = [];
    let before: string | null = null;
    for (let i = 0; i < 10; i++) {
      const r = get(s, '/projects/eventing/thread', `limit=30${before ? `&before=${encodeURIComponent(before)}` : ''}`).body as { turns: Turn[]; next: string | null };
      all.unshift(...r.turns);
      before = r.next;
      if (!before) break;
    }
    expect(before).toBeNull();
    expect(new Set(all.map((t) => t.id)).size).toBe(all.length);
    expect(all.length).toBe([...s.turns.values()].filter((t) => t.projectId === 'eventing').length);
    for (let i = 1; i < all.length; i++) expect(all[i].ts).toBeGreaterThanOrEqual(all[i - 1].ts);
  });
});

describe('W4 fixture writes have the contract\'s shapes', () => {
  it('projects: create, rename, archive, restore, and their refusals', () => {
    const s = fresh();
    const c = valid('/projects', 'post', post(s, '/projects', { name: 'Garden club', icon: 'leaf' }), 201).body as { project: { id: string } };
    valid('/projects', 'post', post(s, '/projects', { name: 'GARDEN CLUB' }), 409);
    valid('/projects', 'post', post(s, '/projects', { name: '' }), 400);
    valid('/projects/{id}', 'patch', send(s, 'PATCH', `/projects/${c.project.id}`, { name: 'Garden & allotment' }), 200);
    valid('/projects/{id}', 'patch', send(s, 'PATCH', `/projects/${c.project.id}`, { name: 'Eventing' }), 409);
    valid('/projects/{id}', 'patch', send(s, 'PATCH', '/projects/general', { archived: true }), 409);
    valid('/projects/{id}', 'patch', send(s, 'PATCH', `/projects/${c.project.id}`, { archived: true }), 200);
    valid('/projects/{id}', 'patch', send(s, 'PATCH', `/projects/${c.project.id}`, { archived: false, icon: null, sort: 9 }), 200);
    valid('/projects/{id}', 'patch', send(s, 'PATCH', '/projects/nope', { name: 'x' }), 404);
  });

  it('messages, Stop, Steer, the offer, moving a turn — and the running turn retiring for a new one', () => {
    const s = fresh();
    const live: StreamMessage[] = [];
    s.openStream(Number.MAX_SAFE_INTEGER, (m) => live.push(m));
    valid('/projects/{id}/stop', 'post', post(s, '/projects/house/stop'), 409);
    valid('/projects/{id}/steer', 'post', post(s, '/projects/house/steer', { text: 'x' }), 409);
    const m = valid('/projects/{id}/messages', 'post', post(s, '/projects/house/messages', { text: 'Compare the quotes' }), 202).body as { turnId: string; runId: string };
    valid('/projects/{id}/messages', 'post', post(s, '/projects/house/messages', { text: 'and again' }), 409);
    valid('/projects/{id}/steer', 'post', post(s, '/projects/house/steer', { text: 'only Hillside' }), 200);
    valid('/turns/{id}/move', 'post', post(s, `/turns/${m.turnId}/move`, { projectId: 'general' }), 409); // still running
    valid('/projects/{id}/stop', 'post', post(s, '/projects/house/stop'), 200);
    flushRuns(s);
    expect(s.turns.has(m.turnId)).toBe(false);
    const answer = [...s.turns.values()].find((t) => t.runId === m.runId)!;
    expect(answer).toMatchObject({ kind: 'chat', projectId: 'house' });
    expect(answer.reply).toMatch(/^Stopped by you\./);
    for (const e of live.filter((x) => x.event === 'live')) expect(e.data).toMatchObject({ session: 'p-house', type: expect.any(String), at: expect.any(Number) });
    expect(live.some((x) => x.event === 'change' && (x.data as { entity: string; op: string }).entity === 'turn' && (x.data as { op: string }).op === 'delete')).toBe(true);
    for (const e of live.filter((x) => x.event === 'change' && (x.data as { entity: string }).entity === 'turn' && (x.data as { op: string }).op === 'upsert')) {
      const v = schema('Turn'); expect(v((e.data as { data: unknown }).data) ? null : ajv.errorsText(v.errors)).toBeNull();
    }
    // moving: the answer goes to General, Undo brings it back
    const mv = valid('/turns/{id}/move', 'post', post(s, `/turns/${answer.id}/move`, { projectId: 'general' }), 200).body as { undo: { projectId: string } };
    expect(mv.undo.projectId).toBe('house');
    valid('/turns/{id}/move', 'post', post(s, `/turns/${answer.id}/move`, { projectId: mv.undo.projectId }), 200);
    valid('/turns/{id}/move', 'post', post(s, '/turns/nope/move', { projectId: 'general' }), 404);
    // the offer
    valid('/projects/{id}/offer/accept', 'post', post(s, '/projects/family/offer/accept', {}), 409);
    valid('/projects/{id}/messages', 'post', post(s, '/projects/family/messages', { text: 'research summer camps' }), 202);
    valid('/projects/{id}/offer/accept', 'post', post(s, '/projects/family/offer/accept', { message: 'research summer camps' }), 202);
  });

  it('POST /ask: an answer, an ask about one thing, a plan (N04), a job, the offer; and its refusals', () => {
    const s = fresh();
    const live: StreamMessage[] = [];
    s.openStream(Number.MAX_SAFE_INTEGER, (m) => live.push(m));
    const ans = valid('/ask', 'post', post(s, '/ask', { text: 'Can Riley go to the book fair?' }), 202).body as AskStart;
    expect(ans).toMatchObject({ kind: 'answer', state: 'started', route: { projectId: 'family', confidence: 'suggested' } });
    valid('/ask', 'post', post(s, '/ask', { text: 'and Sam?', projectId: 'family' }), 409); // busy
    flushRuns(s);
    const about = valid('/ask', 'post', post(s, '/ask', { text: 'What has it cost?', about: { kind: 'job', id: 'j_news' } }), 202).body as AskStart;
    expect(about).toMatchObject({ kind: 'answer', projectId: 'ainews', route: { confidence: 'about' }, about: { label: 'Gathering this week’s AI news' }, budget: { maxSteps: 8, maxUsd: 0.05 } });
    flushRuns(s);
    expect((get(s, `/ask/${about.askId}`).body as { ask: { answer: string } }).ask.answer).toBe('4¢ so far.');
    const plan = valid('/ask', 'post', post(s, '/ask', { text: 'learn everything from these two PDFs', files: PDFS }), 202).body as AskStart;
    expect(plan.plan).toMatchObject({ size: { pages: 149 }, capDefault: 0.3, basis: 'history', now: { label: 'Do it now · about 40¢' }, background: { label: 'In the background · about 15¢ · ready around 10:10 AM' } });
    const wording = valid('/ask', 'post', post(s, '/ask', { text: 'go through all my newsletters' }), 202).body as AskStart;
    expect(wording.plan).toMatchObject({ size: { sources: 12 }, basis: 'default', now: { firstGuess: true, label: 'Do it now · a first guess, about 60¢' }, narrow: [] });
    const job = valid('/ask', 'post', post(s, '/ask', { text: 'sort the barn receipts', mode: 'background', projectId: 'house', capUsd: 0.4 }), 202).body as AskStart;
    expect(job).toMatchObject({ kind: 'job', tier: 'background', capUsd: 0.4 });
    expect(s.jobs.get(job.jobId!)?.capUsd).toBe(0.4);
    const offer = valid('/ask', 'post', post(s, '/ask', { text: 'research summer camps', projectId: 'family' }), 202).body as AskStart;
    expect(offer).toMatchObject({ kind: 'answer', state: 'offer' });
    valid('/ask', 'post', post(s, '/ask', { text: '' }), 400);
    valid('/ask', 'post', post(s, '/ask', { text: 'x', mode: 'later' }), 400);
    valid('/ask', 'post', post(s, '/ask', { text: 'x', capUsd: 25 }), 400);
    valid('/ask', 'post', post(s, '/ask', { text: 'x', about: { kind: 'item', id: 'nope' } }), 404);
    valid('/ask', 'post', post(s, '/ask', { text: 'x', about: { kind: 'job', id: 'j_news' }, files: PDFS }), 400);
    valid('/ask', 'post', post(s, '/ask', { text: 'x', about: { kind: 'job', id: 'j_news' }, mode: 'background' }), 400);
    valid('/ask', 'post', post(s, '/ask', { text: 'x', projectId: 'nope' }), 404);
    send(s, 'PATCH', '/projects/health', { archived: true });
    valid('/ask', 'post', post(s, '/ask', { text: 'x', projectId: 'health' }), 409);
    // the stream says when an ask changes, with the ask as it is now
    const asks = live.filter((x) => x.event === 'change' && (x.data as { entity: string }).entity === 'ask');
    expect(asks.length).toBeGreaterThan(0);
    const v = schema('Ask');
    for (const e of asks) expect(v((e.data as { data: unknown }).data) ? null : ajv.errorsText(v.errors)).toBeNull();
  });

  it('POST /ask/{id}/choose: now, background, narrow; once only; 410 expired, 409 files_gone and archived', () => {
    const s = fresh();
    const plan = () => post(s, '/ask', { text: 'learn everything from these two PDFs', files: PDFS, projectId: 'eventing' }).body as AskStart;
    const a = plan();
    const now = valid('/ask/{id}/choose', 'post', post(s, `/ask/${a.askId}/choose`, { mode: 'now', capUsd: 0.6 }), 202).body as AskChosen;
    expect(now).toMatchObject({ chosen: 'now', kind: 'answer', state: 'started', capUsd: 0.6 });
    valid('/ask/{id}/choose', 'post', post(s, `/ask/${a.askId}/choose`, { mode: 'now', capUsd: 0.6 }), 200); // the same choice: what the first did
    valid('/ask/{id}/choose', 'post', post(s, `/ask/${a.askId}/choose`, { mode: 'background' }), 409); // already_chosen
    flushRuns(s);
    const b = plan();
    const bg = valid('/ask/{id}/choose', 'post', post(s, `/ask/${b.askId}/choose`, { mode: 'background' }), 202).body as AskChosen;
    expect(bg).toMatchObject({ chosen: 'background', kind: 'job', capUsd: 0.3, tier: 'background' });
    expect(s.jobs.get(bg.jobId!)).toMatchObject({ title: 'Learning your 2 eventing PDFs', progress: { done: 0, total: 149, unit: 'pages' } });
    const c = plan();
    const nr = valid('/ask/{id}/choose', 'post', post(s, `/ask/${c.askId}/choose`, { narrowIndex: 2 }), 202).body as AskChosen;
    expect(nr.narrowed).toMatchObject({ kind: 'answer', state: 'started' });
    expect((get(s, `/ask/${nr.narrowed!.askId}`).body as { ask: { parentId: string; focus: { note: string; suggested?: string } } }).ask).toMatchObject({ parentId: c.askId, focus: { suggested: 'Just the rules for moving up a level' } });
    valid('/ask/{id}/choose', 'post', post(s, `/ask/${plan().askId}/choose`, { narrowIndex: 5 }), 400);
    valid('/ask/{id}/choose', 'post', post(s, `/ask/${plan().askId}/choose`, { mode: 'now', narrowIndex: 0 }), 400);
    valid('/ask/{id}/choose', 'post', post(s, `/ask/${nr.narrowed!.askId}/choose`, { mode: 'now' }), 409); // not a plan
    valid('/ask/{id}/choose', 'post', post(s, '/ask/nope/choose', { mode: 'now' }), 404);
    flushRuns(s);
    const old = post(s, '/ask', { text: '[old] review all my mail' }).body as AskStart;
    valid('/ask/{id}/choose', 'post', post(s, `/ask/${old.askId}/choose`, { mode: 'now' }), 410);
    expect((get(s, `/ask/${old.askId}`).body as { ask: { state: string } }).ask.state).toBe('expired');
    const g = plan();
    forgetFile(s, PDFS[1]);
    valid('/ask/{id}/choose', 'post', post(s, `/ask/${g.askId}/choose`, { mode: 'background' }), 409);
    const ar = post(s, '/ask', { text: 'review all the house quotes', projectId: 'house' }).body as AskStart;
    send(s, 'PATCH', '/projects/house', { archived: true });
    const r = valid('/ask/{id}/choose', 'post', post(s, `/ask/${ar.askId}/choose`, { mode: 'now' }), 409);
    expect((r.body as { error: { code: string } }).error.code).toBe('archived');
  });
});
