// v2 build, slice A1: the OpenAPI contract (api/openapi.yaml) and the /api/v1 route table describe the same API,
// and real responses match the contract's schemas. Each slice that adds routes adds its spec operations and cases.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { parse } from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { v1Routes } from '../src/api/v1.js';
import { createV1 } from '../src/api/router.js';
import { ALL_SCOPES, type Caller } from '../src/api/auth.js';
const TEST_CALLER: Caller = { kind: 'session', id: 'session', scopes: new Set(ALL_SCOPES), viaCookie: true };
import { resetAppDb } from '../src/v2/db.js';
import { setJobRouteDeps } from '../src/api/routes/jobs.js';
import { createJob, addTry, claimTry, endTry } from '../src/v2/jobs.js';
import { addDraft, setDraftProviders } from '../src/sync/drafts.js';
import { setCalendarSyncDeps } from '../src/sync/calendar.js';
import { mailId } from '../src/v2/mail.js';
import { setMailProviders, syncMail } from '../src/sync/mail.js';
import { MessageGoneError } from '../src/sync/mail-types.js';

const spec = parse(readFileSync(new URL('../api/openapi.yaml', import.meta.url), 'utf8'));
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const ops = Object.entries(spec.paths as Record<string, Record<string, any>>).flatMap(([path, item]) =>
  METHODS.filter((m) => item[m]).map((m) => ({ key: `${m.toUpperCase()} ${path}`, op: item[m], path, method: m })));

const ajv = new (Ajv2020 as unknown as typeof Ajv2020.default)({ strict: false, allErrors: true });
(addFormats as unknown as typeof addFormats.default)(ajv);
ajv.addSchema({ $id: 'spec', components: spec.components });
const validate = (schema: object, data: unknown) => {
  const fn = ajv.compile({ ...JSON.parse(JSON.stringify(schema).replace(/"#\/components\//g, '"spec#/components/')) });
  return fn(data) ? null : ajv.errorsText(fn.errors);
};
const responseSchema = (op: any, status: number): object | undefined => {
  const r = op.responses[String(status)] ?? op.responses.default;
  const resolved = r?.$ref ? spec.components.responses[r.$ref.split('/').pop()] : r;
  return resolved?.content?.['application/json']?.schema;
};

describe('the contract and the route table agree', () => {
  const routes = v1Routes().map((r) => ({ key: `${r.method} ${r.path}`, scope: r.scope }));
  it('every route is in the spec and every spec operation has a route', () => {
    expect(routes.map((r) => r.key).sort()).toEqual(ops.map((o) => o.key).sort());
  });
  it('a route is public exactly when its operation needs no sign-in', () => {
    for (const r of routes) {
      const op = ops.find((o) => o.key === r.key)!.op;
      expect(`${r.key} public=${r.scope === 'public'}`).toBe(`${r.key} public=${Array.isArray(op.security) && op.security.length === 0}`);
    }
  });
  it('every operation has an operationId, a summary, a success response and the error response', () => {
    for (const o of ops) {
      expect(o.op.operationId, o.key).toBeTruthy();
      expect(o.op.summary, o.key).toBeTruthy();
      expect(Object.keys(o.op.responses).some((s) => /^2\d\d$/.test(s)), o.key).toBe(true);
      expect(o.op.responses.default, o.key).toBeTruthy();
    }
  });
  it('every write operation requires an Idempotency-Key', () => {
    for (const o of ops.filter((x) => x.method !== 'get' && !(Array.isArray(x.op.security) && !x.op.security.length))) {
      expect((o.op.parameters ?? []).some((p: any) => p.$ref === '#/components/parameters/IdempotencyKey'), o.key).toBe(true);
    }
  });
});

// Real responses against the schemas, over HTTP.
let server: Server, base = '';
beforeAll(async () => {
  resetAppDb(':memory:');
  // A3a: jobs in each state an action needs, and fake server parts (no model, no memory store).
  let n = 0;
  setJobRouteDeps({
    memory: () => ({ addScheduledTask: async () => `sched-${++n}-xxxxxxxx`, cancelScheduled: async () => {}, getGoal: async () => null, setGoalStatus: async () => {} }) as never,
    running: () => new Set(['live-running']), stopLive: (k) => k === 'live-running', pendingApprovals: () => new Set(),
    scheduleControl: async () => ({ ok: true, message: 'Done.' }),
  });
  const partly = createJob({ kind: 'background', title: 'Read the rules', request: 'Read the rules' }, { trigger: 'first' });
  claimTry(partly.try!.id, {}); endTry(partly.try!.id, { reason: 'done', outcome: 'changed', summary: 'Read 63 pages.', progress: { done: 63, total: 73, unit: 'pages' }, remaining: 'pages 64-73', costUsd: 0.15 });
  const done = createJob({ kind: 'background', title: 'Done thing' }, { trigger: 'first' });
  claimTry(done.try!.id, {}); endTry(done.try!.id, { reason: 'done', outcome: 'changed', summary: 'All done.' });
  const running = createJob({ kind: 'live', title: 'Running thing' }, { trigger: 'first', state: 'running', liveKey: 'live-running' });
  const failed = createJob({ kind: 'background', title: 'Failed thing' }, { trigger: 'first' });
  claimTry(failed.try!.id, {}); endTry(failed.try!.id, { reason: 'done', outcome: 'could-not', summary: 'The site was down.' });
  const watch = createJob({ kind: 'recurring', title: 'Watch the price', scheduleId: 'watch-task-1' });
  addTry(watch.job.id, { trigger: 'fire' });
  // A7: drafts to act on; Confirm goes to a stub calendar here (the fakes are in tests/calendar-*.test.ts), and no
  // real account is ever consulted
  setDraftProviders({ connected: () => true, insert: async () => 'stub-event-1' });
  setCalendarSyncDeps({ connected: () => false });
  const fair = addDraft({ title: 'Book fair', start: '2026-11-14T15:00:00-05:00', end: '2026-11-14T18:00:00-05:00', location: 'Oakwood Elementary' }).draft;
  const spare = addDraft({ title: 'Spare', start: '2026-11-15T15:00:00-05:00', end: '2026-11-15T16:00:00-05:00' }).draft;
  Object.assign(ids, { fair: fair.id, spare: spare.id });
  Object.assign(ids, { partly: partly.job.id, done: done.job.id, running: running.job.id, failed: failed.job.id, watch: watch.job.id });
  // A8: one fake mail account (in memory) with two messages, one of which is gone by the time it is opened
  const header = (providerId: string, subject: string, at: number) => ({
    providerId, threadId: `t-${providerId}`, fromName: 'Coach Ellen', fromAddr: 'ellen@example.com', subject, snippet: 'Can you confirm by Wednesday?',
    receivedAt: at, unread: true, labels: ['INBOX', 'UNREAD'], listId: null, hasUnsub: false, messageId: `<${providerId}@example.com>`,
  });
  setMailProviders(() => [{
    prefix: 'google', provider: 'gmail', label: 'Gmail', resolveAccount: async () => 'google:me@example.com',
    sync: async (_s, o) => ({ full: true, upserts: [header('c1', 'Saturday schooling', o.now - 60_000), header('c2', 'Old news', o.now - 120_000)], deletes: [], cursor: '1', windowFrom: o.now - 14 * 86_400_000, windowTo: o.now }),
    fetchBody: async (id) => { if (id === 'c2') throw new MessageGoneError(); return { html: '<p>Hi Robert, <a href="https://x.example/a">see this</a></p>', text: null, from: [{ name: 'Coach Ellen', addr: 'ellen@example.com' }], replyTo: [], to: [{ name: null, addr: 'robert@example.com' }] }; },
    saveReplyDraft: async () => ({ draftId: 'd-1', to: [{ name: 'Coach Ellen', addr: 'ellen@example.com' }], already: false }),
  }], { inlineSanitize: true });
  await syncMail();
  Object.assign(ids, { mail: mailId('google:me@example.com', 'c1'), mailGone: mailId('google:me@example.com', 'c2') });
  const v1 = createV1(v1Routes(), { authenticate: () => TEST_CALLER, sameOrigin: () => true });
  server = createServer(async (req, res) => { if (!(await v1(req, res))) { res.writeHead(404); res.end(); } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
});
afterAll(() => { server?.close(); setCalendarSyncDeps(null); setMailProviders(null); });

/** One request per operation (and a few error cases). Slices append theirs. */
const ids: Record<string, string> = {};
let keyN = 0;
const post = (): RequestInit => ({ method: 'POST', headers: { 'idempotency-key': `contract-key-${++keyN}`, 'content-type': 'application/json' }, body: '{}' });
const CASES: { op: string; path: string | (() => string); init?: RequestInit | (() => RequestInit); status: number }[] = [
  { op: 'GET /meta', path: '/meta', status: 200 },
  { op: 'GET /meta', path: '/meta', init: { method: 'POST' }, status: 405 },
  { op: 'POST /pair/codes', path: '/pair/codes', init: { method: 'POST', headers: { 'idempotency-key': 'contract-pair-01' } }, status: 201 },
  { op: 'POST /pair', path: '/pair', init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'AAAA-AAAA' }) }, status: 400 },
  { op: 'GET /devices', path: '/devices', status: 200 },
  { op: 'DELETE /devices/{id}', path: '/devices/dev_nope', init: { method: 'DELETE', headers: { 'idempotency-key': 'contract-del-001' } }, status: 404 },
  { op: 'POST /devices/me/sign-out', path: '/devices/me/sign-out', init: { method: 'POST', headers: { 'idempotency-key': 'contract-out-001' } }, status: 400 },
  { op: 'GET /stream', path: '/stream', status: 200 },
  { op: 'GET /stream', path: '/stream?cursor=abc', status: 400 },
  { op: 'GET /sync', path: '/sync', status: 200 },
  { op: 'GET /sync', path: '/sync?since=1', status: 200 },
  { op: 'GET /sync', path: '/sync?collections=nope', status: 400 },
  { op: 'GET /sync', path: '/sync?collections=jobs,mail', status: 200 },
  // A8: mail, with an in-memory fake provider (no network)
  { op: 'GET /mail', path: '/mail', status: 200 },
  { op: 'GET /mail', path: '/mail?limit=1', status: 200 },
  { op: 'GET /mail', path: '/mail?before=nonsense', status: 400 },
  { op: 'GET /mail/accounts', path: '/mail/accounts', status: 200 },
  { op: 'POST /mail/refresh', path: '/mail/refresh', init: post, status: 200 },
  { op: 'GET /mail/{id}', path: () => `/mail/${ids.mail}`, status: 200 },
  { op: 'GET /mail/{id}', path: () => `/mail/${ids.mailGone}`, status: 404 },
  { op: 'GET /mail/{id}', path: '/mail/m_bm9wZQpub3Bl', status: 404 },
  { op: 'POST /mail/{id}/draft', path: () => `/mail/${ids.mail}/draft`, init: () => ({ ...post(), body: JSON.stringify({ body: 'Yes, count me in.' }) }), status: 201 },
  { op: 'POST /mail/{id}/draft', path: () => `/mail/${ids.mail}/draft`, init: post, status: 400 },
  { op: 'GET /jobs', path: '/jobs', status: 200 },
  { op: 'GET /jobs', path: '/jobs?state=partly_done', status: 200 },
  { op: 'GET /jobs', path: '/jobs?state=nonsense', status: 400 },
  { op: 'GET /jobs/{id}', path: () => `/jobs/${ids.partly}`, status: 200 },
  { op: 'GET /jobs/{id}', path: '/jobs/j_nope', status: 404 },
  { op: 'POST /jobs/{id}/stop', path: () => `/jobs/${ids.running}/stop`, init: post, status: 200 },
  { op: 'POST /jobs/{id}/stop', path: () => `/jobs/${ids.done}/stop`, init: post, status: 409 },
  { op: 'POST /jobs/{id}/continue', path: () => `/jobs/${ids.done}/continue`, init: post, status: 409 },
  { op: 'POST /jobs/{id}/continue', path: () => `/jobs/${ids.partly}/continue`, init: post, status: 202 },
  { op: 'POST /jobs/{id}/start-over', path: () => `/jobs/${ids.failed}/start-over`, init: post, status: 202 },
  { op: 'POST /jobs/{id}/open', path: () => `/jobs/${ids.done}/open`, init: post, status: 200 },
  { op: 'POST /jobs/{id}/pause', path: () => `/jobs/${ids.watch}/pause`, init: post, status: 200 },
  { op: 'POST /jobs/{id}/pause', path: () => `/jobs/${ids.done}/pause`, init: post, status: 409 },
  { op: 'POST /jobs/{id}/resume', path: () => `/jobs/${ids.watch}/resume`, init: post, status: 200 },
  { op: 'POST /jobs/{id}/cancel', path: () => `/jobs/${ids.watch}/cancel`, init: post, status: 200 },
  // A7 calendar
  { op: 'GET /calendar', path: '/calendar?from=2026-11-14&to=2026-11-15', status: 200 },
  { op: 'GET /calendar', path: '/calendar', status: 200 },
  { op: 'GET /calendar', path: '/calendar?from=yesterday', status: 400 },
  { op: 'GET /calendar/accounts', path: '/calendar/accounts', status: 200 },
  { op: 'POST /calendar/refresh', path: '/calendar/refresh', init: post, status: 200 },
  { op: 'POST /calendar/drafts', path: '/calendar/drafts', init: () => ({ ...post(), body: JSON.stringify({ title: 'Lunch with Sam', start: '2026-11-11T12:00', end: '2026-11-11T13:00' }) }), status: 201 },
  { op: 'POST /calendar/drafts', path: '/calendar/drafts', init: () => ({ ...post(), body: JSON.stringify({ title: 'No start' }) }), status: 400 },
  { op: 'GET /calendar/drafts/{id}.ics', path: () => `/calendar/drafts/${ids.fair}.ics`, status: 200 },
  { op: 'GET /calendar/drafts/{id}.ics', path: '/calendar/drafts/cd_nope.ics', status: 404 },
  { op: 'POST /calendar/drafts/{id}/confirm', path: () => `/calendar/drafts/${ids.fair}/confirm`, init: post, status: 200 },
  { op: 'POST /calendar/drafts/{id}/confirm', path: '/calendar/drafts/cd_nope/confirm', init: post, status: 404 },
  { op: 'POST /calendar/drafts/{id}/remove', path: () => `/calendar/drafts/${ids.spare}/remove`, init: post, status: 200 },
  { op: 'POST /calendar/drafts/{id}/remove', path: () => `/calendar/drafts/${ids.fair}/remove`, init: post, status: 409 },
  { op: 'GET /sync', path: '/sync?collections=jobs,calendar', status: 200 },
  { op: 'GET /sync', path: '/sync?since=1&collections=calendar', status: 200 },
];

describe('responses match the contract', () => {
  it('the schema check rejects a wrong response (it is not vacuous)', () => {
    expect(validate(spec.components.schemas.Meta, { api: 'v1' })).toMatch(/required/);
    expect(validate(spec.components.schemas.Meta, { api: 'v2', server: '1', minClient: '1', secure: true, features: [] })).toMatch(/const/);
    expect(validate(spec.components.schemas.Error, { error: { code: 'x' } })).toMatch(/message/);
  });
  it('every operation has at least one case', () => {
    for (const o of ops) expect(CASES.some((c) => c.op === o.key), o.key).toBe(true);
  });
  for (const c of CASES) {
    it(`${c.op} (${typeof c.path === 'string' ? c.path : 'job'}) → ${c.status}`, async () => {
      const r = await fetch(base + (typeof c.path === 'function' ? c.path() : c.path), typeof c.init === 'function' ? c.init() : c.init);
      expect(r.status).toBe(c.status);
      const op = ops.find((o) => o.key === c.op)!.op;
      if (/text\/event-stream/.test(r.headers.get('content-type') ?? '')) { // a stream: the spec must say so; don't read it
        expect(op.responses[String(r.status)]?.content?.['text/event-stream']).toBeTruthy();
        await r.body?.cancel();
        return;
      }
      if (/text\/calendar/.test(r.headers.get('content-type') ?? '')) { // a file: the spec must say so
        expect(op.responses[String(r.status)]?.content?.['text/calendar']).toBeTruthy();
        expect(await r.text()).toMatch(/^BEGIN:VCALENDAR\r\n/);
        return;
      }
      const schema = r.status === 405 ? spec.components.schemas.Error : responseSchema(op, r.status);
      expect(schema, 'a schema for this status').toBeTruthy();
      expect(validate(schema!, await r.json())).toBeNull();
    });
  }
});
