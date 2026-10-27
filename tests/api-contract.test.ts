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
import { refreshImportant, factItem, setTriageDeps } from '../src/v2/triage.js';
import { itemId, upsertItem, ruleIdFor } from '../src/v2/important.js';
import { setImportantRouteDeps } from '../src/api/routes/important.js';
import { localDate, addDays } from '../src/sync/tz.js';
import { setProjectRouteDeps } from '../src/api/routes/projects.js';
import { createProject, setEmbedder } from '../src/v2/projects.js';
import { appendTurn } from '../src/conversations.js';
import { setTodayDeps } from '../src/v2/today.js';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { setAskRouteDeps } from '../src/api/routes/ask.js';
import { insertAsk, buildPlan } from '../src/v2/ask.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setSettingsRouteDeps } from '../src/api/routes/settings.js';
import { createECDH, randomBytes } from 'node:crypto';
import { configureSessions, issueSession } from '../src/api/sessions.js';
import { saveSubscription } from '../src/v2/push-store.js';
import { setPushDeps } from '../src/v2/push.js';
import { setPluginRouteDeps } from '../src/api/routes/plugins.js';
import { addMcpServer } from '../src/connectors/registry.js';
import { loadConfig } from '../src/config.js';
import { setAssistantDeps } from '../src/assistant-settings.js';
import { setConnectionDeps } from '../src/connection-settings.js';

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
    sync: async (_s, o) => ({ full: true, upserts: [header('c1', 'Saturday schooling', o.now - 60_000), header('c2', 'Old news', o.now - 120_000),
      { ...header('c3', 'This week in AI', o.now - 180_000), fromName: 'The Batch', fromAddr: 'news@thebatch.example', listId: 'thebatch.example', hasUnsub: true },
      // review of W3: a phishing message whose display name carries an address of its own
      { ...header('c4', 'Your account has been limited', o.now - 240_000), fromName: 'PayPal Service <service@paypal.com>', fromAddr: 'x@evil.example' }], deletes: [], cursor: '1', windowFrom: o.now - 14 * 86_400_000, windowTo: o.now }),
    fetchBody: async (id) => { if (id === 'c2') throw new MessageGoneError(); return { html: '<p>Hi Robert, <a href="https://x.example/a">see this</a></p>', text: null, from: [{ name: 'Coach Ellen', addr: 'ellen@example.com' }], replyTo: [], to: [{ name: null, addr: 'robert@example.com' }] }; },
    saveReplyDraft: async () => ({ draftId: 'd-1', to: [{ name: 'Coach Ellen', addr: 'ellen@example.com' }], already: false }),
  }], { inlineSanitize: true });
  await syncMail();
  Object.assign(ids, { mail: mailId('google:me@example.com', 'c1'), mailGone: mailId('google:me@example.com', 'c2') });
  // A9: the Important list (no model under tests: rules and bulk-mail signs only), and one dated fact to add
  setTriageDeps({ tz: () => 'America/New_York' });
  setImportantRouteDeps({ remind: async () => 'rem-1' });
  await refreshImportant();
  const day = addDays(localDate(Date.now(), 'America/New_York'), 20);
  const fact = upsertItem(factItem({ kind: 'event', title: 'Book fair', date: day, start: '15:00', end: '18:00', place: 'Oakwood Elementary' },
    { from_name: 'Oakwood school newsletter', from_addr: 'news@oakwood.example', received_at: Date.now() - 60_000 }, ids.mailGone, Date.now(), 'America/New_York'), 'America/New_York');
  Object.assign(ids, { item: itemId(`mail:${ids.mail}`), item2: itemId(`mail:${ids.mailGone}`), fact: fact.id, skippedMail: mailId('google:me@example.com', 'c3') });
  // A5: two projects with a turn each; a stub embedder (the routing model is exercised in tests/projects-routing) and a
  // fake chat start (no model)
  setEmbedder(async (t) => [t.length % 7, 1, t.includes('horse') ? 3 : 0]);
  setProjectRouteDeps({
    workspace: () => mkdtempSync(join(tmpdir(), 'mwa-a5-ws-')), startChat: async () => ({ state: 'started', runId: 'live_contract' }),
    stop: (id) => id === ids.eventing, steer: (id) => id === ids.eventing, attach: () => null,
    live: (id) => (id === ids.eventing ? { session: `p-${id}`, run: { runId: 'live_contract' } } : null),
    acceptOffer: async (id) => (id === ids.eventing ? { goal: 'abcd1234', message: 'On it.' } : null),
  });
  const eventing = createProject({ name: 'Eventing', icon: 'horse' });
  const family = createProject({ name: 'Family & school' });
  const turn = appendTurn({ ts: Date.now(), session: `p-${eventing.id}`, message: 'When do entries close?', reply: 'Friday at 5pm.', kind: 'chat' })!;
  Object.assign(ids, { eventing: eventing.id, family: family.id, turn });
  // A10: Today reads everything above; no approvals store and no token log here
  setTodayDeps({ pendingApprovals: () => [], month: () => ({ usedUsd: 1.29, limitUsd: 20, state: 'ok' }), greetingName: () => 'Robert' });
  // A6: asks — a workspace with one long uploaded file, a fake background hand-off, no history (the default rate)
  const askWs = mkdtempSync(join(tmpdir(), 'mwa-a6-ws-'));
  mkdirSync(join(askWs, 'serve', 'p-general', 'uploads'), { recursive: true });
  writeFileSync(join(askWs, 'serve', 'p-general', 'uploads', 'rules.txt'), 'The rules. '.repeat(15_000));
  let jobs = 0;
  setAskRouteDeps({
    workspace: () => askWs, startBackground: async () => ({ jobId: `j_contract_${++jobs}` }),
    history: () => ({ main: null, background: null }), now: () => Date.UTC(2026, 10, 9, 14, 10), tz: () => 'America/New_York',
  });
  const askRoute = { projectId: eventing.id, name: 'Eventing', confidence: 'given' as const, alternatives: [] };
  const built = buildPlan({ text: 'Learn everything about the rules', files: [], history: { main: null, background: null } });
  const planned = insertAsk({ text: 'Learn everything about the rules', projectId: eventing.id, route: askRoute, kind: 'plan', mode: 'auto', plan: built.plan!, state: 'planned', createdAt: Date.UTC(2026, 10, 9, 14, 0) });
  const answered = insertAsk({ text: 'When do entries close?', projectId: eventing.id, route: askRoute, kind: 'answer', mode: 'auto', state: 'answered' });
  Object.assign(ids, { plannedAsk: planned.id, answeredAsk: answered.id });
  // W5: settings, spending and saved logins in a scratch folder; a fake password and fake sign-in flows (no network)
  const w5 = mkdtempSync(join(tmpdir(), 'mwa-w5-contract-'));
  Object.assign(process.env, { MWA_CONFIG_PATH: join(w5, 'mwa.config.json'), MWA_TOKEN_LOG: join(w5, 'tokens.jsonl'), MWA_VAULT_PATH: join(w5, 'vault.json') });
  setSettingsRouteDeps({
    passwordSet: () => true, checkPassword: (pw) => pw === 'right-password',
    connections: () => ({ googleClient: true, gmailAppPassword: false, googleConnected: false, outlookDeviceCode: true, microsoftClient: false, outlookConnected: false }),
    startGoogle: () => 'https://accounts.google.example/consent', startOutlook: () => 'https://login.microsoft.example/consent',
    startOutlookDeviceCode: async () => ({ user_code: 'ABCD-1234', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900 }),
  });
  // S1: plug-ins in the scratch config; keys go to a map, the reviewer is a stub that passes (no network, no model)
  const savedKeys = new Set<string>();
  setPluginRouteDeps({ saveEnv: (kv) => { for (const k of Object.keys(kv)) { savedKeys.add(k); process.env[k] = kv[k]; } }, hasEnv: (n) => savedKeys.has(n), logInstall: () => {},
    removeEnv: (names) => { for (const n of names) { savedKeys.delete(n); delete process.env[n]; } },
    config: () => { const c = loadConfig(); return { ...c, models: { ...c.models, installer: 'anthropic:claude-sonnet-5' } }; },
    review: async (pkg) => ({ source: pkg, verdict: 'safe', summary: 'A small, well-known server.', capabilities: ['reads web pages'], redFlags: [], analysis: { ok: true, findings: [] }, deepScan: { ran: true, integrityOk: true, filesScanned: 3, findings: [] }, integrity: 'sha512-x', pinnedVersion: '1.2.3', model: 'anthropic:claude-sonnet-5' }) });
  addMcpServer('my-tool', { command: 'node', args: ['tool.mjs', '--api-key', 'abc123'], env: { MY_TOOL_TOKEN: 'secret-value' } });
  // S2: the assistant's settings in the same scratch config; the live check passes unless the key says bad, keys go to a set
  const s2Keys = new Set<string>();
  setAssistantDeps({ testProvider: async (_p, m, k) => (k?.includes('bad') ? { ok: false, message: 'failed: 401' } : { ok: true, message: `${m} works` }),
    listModels: async () => [{ id: 'openai/gpt-6.1-sol', name: 'GPT-6.1 Sol' }], saveEnv: (kv) => { for (const k of Object.keys(kv)) s2Keys.add(k); }, hasEnv: (n) => s2Keys.has(n) });
  ids.folder = mkdtempSync(join(tmpdir(), 'mwa-s2-contract-'));
  // S3: connections over a map instead of the .env; Gmail's and Telegram's checks pass unless the input says bad
  const s3Env = new Map<string, string>();
  setConnectionDeps({ checkGmail: async (_a, p) => (p.includes('bad') ? { ok: false, message: 'Sign-in failed' } : { ok: true, message: 'ok' }),
    checkTelegram: async (t) => (t.includes('bad') ? { ok: false, message: 'Telegram failed: Unauthorized' } : { ok: true, message: 'Bot @x_bot works ✓' }),
    saveEnv: (kv) => { for (const [k, v] of Object.entries(kv)) s3Env.set(k, v); }, removeEnv: (ns) => { for (const k of ns) s3Env.delete(k); },
    forgetGoogle: () => {}, forgetMicrosoft: () => {}, env: (n) => s3Env.get(n), googleSignedIn: () => false, outlookSignedIn: () => false, outlookCodeReady: () => true, cancelGoogle: () => false, cancelOutlook: () => false, fromHost: () => false });
  // P3: a password (so a session cookie names its subscriptions' owner) and a push service that always accepts
  configureSessions({ password: 'contract-push-pw' });
  setPushDeps({ transport: async () => ({ status: 201 }) });
  const v1 = createV1(v1Routes(), { authenticate: () => TEST_CALLER, sameOrigin: () => true });
  server = createServer(async (req, res) => { if (!(await v1(req, res))) { res.writeHead(404); res.end(); } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
});
afterAll(() => { server?.close(); setSettingsRouteDeps(null); setPluginRouteDeps(null); delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN; delete process.env.TAVILY_API_KEY; configureSessions({ password: '' }); setPushDeps(null); for (const k of ['MWA_CONFIG_PATH', 'MWA_TOKEN_LOG', 'MWA_VAULT_PATH']) delete process.env[k]; setCalendarSyncDeps(null); setMailProviders(null); setProjectRouteDeps(null); setEmbedder(null); setTriageDeps(null); setImportantRouteDeps(null); setAskRouteDeps(null); setTodayDeps(null); setAssistantDeps(null); setConnectionDeps(null); });

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
  { op: 'GET /mail/{id}', path: () => `/mail/${mailId('google:me@example.com', 'c4')}`, status: 200 },
  { op: 'GET /mail/{id}', path: '/mail/m_bm9wZQpub3Bl', status: 404 },
  { op: 'POST /mail/{id}/draft', path: () => `/mail/${ids.mail}/draft`, init: () => ({ ...post(), body: JSON.stringify({ body: 'Yes, count me in.' }) }), status: 201 },
  { op: 'POST /mail/{id}/draft', path: () => `/mail/${ids.mail}/draft`, init: post, status: 400 },
  { op: 'GET /jobs', path: '/jobs', status: 200 },
  { op: 'GET /jobs', path: '/jobs?state=partly_done', status: 200 },
  { op: 'GET /jobs', path: '/jobs?state=nonsense', status: 400 },
  { op: 'GET /jobs/{id}', path: () => `/jobs/${ids.partly}`, status: 200 },
  { op: 'GET /jobs/{id}', path: '/jobs/j_nope', status: 404 },
  { op: 'GET /jobs/{id}/estimate', path: () => `/jobs/${ids.partly}/estimate`, status: 200 },
  { op: 'GET /jobs/{id}/estimate', path: () => `/jobs/${ids.done}/estimate`, status: 200 },
  { op: 'GET /jobs/{id}/estimate', path: () => `/jobs/${ids.watch}/estimate`, status: 409 },
  { op: 'GET /jobs/{id}/estimate', path: '/jobs/j_nope/estimate', status: 404 },
  { op: 'POST /jobs/{id}/continue', path: () => `/jobs/${ids.partly}/continue`, init: () => ({ ...post(), body: JSON.stringify({ capUsd: 0 }) }), status: 400 },
  { op: 'POST /jobs/{id}/start-over', path: () => `/jobs/${ids.failed}/start-over`, init: () => ({ ...post(), body: JSON.stringify({ capUsd: 21 }) }), status: 400 },
  { op: 'POST /jobs/{id}/stop', path: () => `/jobs/${ids.running}/stop`, init: post, status: 200 },
  { op: 'POST /jobs/{id}/stop', path: () => `/jobs/${ids.done}/stop`, init: post, status: 409 },
  { op: 'POST /jobs/{id}/continue', path: () => `/jobs/${ids.done}/continue`, init: post, status: 409 },
  { op: 'POST /jobs/{id}/continue', path: () => `/jobs/${ids.partly}/continue`, init: post, status: 202 },
  { op: 'POST /jobs/{id}/start-over', path: () => `/jobs/${ids.failed}/start-over`, init: () => ({ ...post(), body: JSON.stringify({ capUsd: 0.5 }) }), status: 202 },
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
  // A9 Important
  { op: 'GET /items', path: '/items', status: 200 },
  { op: 'GET /items', path: '/items?state=handled&group=today', status: 200 },
  { op: 'GET /items', path: '/items?group=tomorrow', status: 400 },
  { op: 'GET /items/skipped', path: '/items/skipped', status: 200 },
  { op: 'GET /items/skipped', path: '/items/skipped?group=today', status: 200 },
  { op: 'GET /items/skipped', path: '/items/skipped?group=nope', status: 400 },
  { op: 'POST /items/{id}/handled', path: () => `/items/${ids.item}/handled`, init: post, status: 200 },
  { op: 'POST /items/{id}/handled', path: '/items/it_nopenopenope/handled', init: post, status: 404 },
  { op: 'POST /items/{id}/unhandle', path: () => `/items/${ids.item}/unhandle`, init: post, status: 200 },
  { op: 'POST /items/{id}/action', path: () => `/items/${ids.item}/action`, init: post, status: 200 },
  { op: 'POST /items/{id}/action', path: () => `/items/${ids.fact}/action`, init: post, status: 201 },
  { op: 'POST /items/{id}/not-important', path: () => `/items/${ids.item2}/not-important`, init: () => ({ ...post(), body: JSON.stringify({ scope: 'everything' }) }), status: 400 },
  { op: 'POST /items/{id}/not-important', path: () => `/items/${ids.item2}/not-important`, init: () => ({ ...post(), body: JSON.stringify({ scope: 'sender' }) }), status: 200 },
  { op: 'POST /mail/{id}/important', path: () => `/mail/${ids.skippedMail}/important`, init: post, status: 200 },
  { op: 'POST /mail/{id}/important', path: '/mail/m_bm9wZQpub3Bl/important', init: post, status: 404 },
  { op: 'POST /important/refresh', path: '/important/refresh', init: post, status: 200 },
  { op: 'GET /sync', path: '/sync?collections=important', status: 200 },
  { op: 'GET /sync', path: '/sync?since=1&collections=important,mail', status: 200 },
  { op: 'GET /triage/rules', path: '/triage/rules', status: 200 },
  { op: 'DELETE /triage/rules/{id}', path: () => `/triage/rules/${ruleIdFor('sender', 'ellen@example.com')}`, init: () => ({ method: 'DELETE', headers: { 'idempotency-key': `contract-key-${++keyN}` } }), status: 200 },
  { op: 'DELETE /triage/rules/{id}', path: '/triage/rules/tr_nopenopenope', init: () => ({ method: 'DELETE', headers: { 'idempotency-key': `contract-key-${++keyN}` } }), status: 404 },
  { op: 'GET /sync', path: '/sync?since=1&collections=calendar', status: 200 },
  // A5 projects and threads
  { op: 'GET /projects', path: '/projects', status: 200 },
  { op: 'GET /projects', path: '/projects?archived=1', status: 200 },
  { op: 'POST /projects', path: '/projects', init: () => ({ ...post(), body: JSON.stringify({ name: 'AI newsletter', icon: 'spark' }) }), status: 201 },
  { op: 'POST /projects', path: '/projects', init: () => ({ ...post(), body: JSON.stringify({ name: 'eventing' }) }), status: 409 },
  { op: 'POST /projects', path: '/projects', init: () => ({ ...post(), body: JSON.stringify({ name: '  ' }) }), status: 400 },
  { op: 'GET /projects/suggest', path: '/projects/suggest?text=Is%20the%20horse%20sound%3F', status: 200 },
  { op: 'GET /projects/suggest', path: () => `/projects/suggest?text=Is%20the%20horse%20sound%3F&from=${ids.family}`, status: 200 },
  { op: 'GET /projects/suggest', path: '/projects/suggest', status: 400 },
  { op: 'PATCH /projects/{id}', path: () => `/projects/${ids.family}`, init: () => ({ ...post(), method: 'PATCH', body: JSON.stringify({ name: 'Family and school', icon: 'home' }) }), status: 200 },
  { op: 'PATCH /projects/{id}', path: '/projects/general', init: () => ({ ...post(), method: 'PATCH', body: JSON.stringify({ archived: true }) }), status: 409 },
  { op: 'PATCH /projects/{id}', path: '/projects/pr_nope', init: () => ({ ...post(), method: 'PATCH', body: JSON.stringify({ name: 'x' }) }), status: 404 },
  { op: 'GET /projects/{id}/thread', path: () => `/projects/${ids.eventing}/thread`, status: 200 },
  { op: 'GET /projects/{id}/thread', path: () => `/projects/${ids.eventing}/thread?before=nonsense`, status: 400 },
  { op: 'GET /projects/{id}/thread', path: '/projects/pr_nope/thread', status: 404 },
  { op: 'POST /projects/{id}/messages', path: () => `/projects/${ids.eventing}/messages`, init: () => ({ ...post(), body: JSON.stringify({ text: 'Is Comet entered?' }) }), status: 202 },
  { op: 'POST /projects/{id}/messages', path: () => `/projects/${ids.eventing}/messages`, init: post, status: 400 },
  { op: 'GET /projects/{id}/work', path: () => `/projects/${ids.eventing}/work`, status: 200 },
  { op: 'GET /projects/{id}/work', path: '/projects/general/work', status: 200 },
  { op: 'GET /projects/{id}/files', path: '/projects/general/files', status: 200 },
  { op: 'POST /turns/{id}/move', path: () => `/turns/${ids.turn}/move`, init: () => ({ ...post(), body: JSON.stringify({ projectId: ids.family }) }), status: 200 },
  { op: 'POST /turns/{id}/move', path: () => `/turns/${ids.turn}/move`, init: () => ({ ...post(), body: JSON.stringify({ projectId: ids.family }) }), status: 409 },
  { op: 'POST /turns/{id}/move', path: '/turns/tu_000000000000/move', init: () => ({ ...post(), body: JSON.stringify({ projectId: 'general' }) }), status: 404 },
  { op: 'POST /projects/{id}/stop', path: () => `/projects/${ids.eventing}/stop`, init: post, status: 200 },
  { op: 'POST /projects/{id}/stop', path: () => `/projects/${ids.family}/stop`, init: post, status: 409 },
  { op: 'POST /projects/{id}/stop', path: () => `/projects/${ids.eventing}/stop`, init: () => ({ ...post(), body: JSON.stringify({ runId: 'live_contract' }) }), status: 200 },
  { op: 'POST /projects/{id}/stop', path: () => `/projects/${ids.eventing}/stop`, init: () => ({ ...post(), body: JSON.stringify({ runId: 'an_earlier_run' }) }), status: 409 },
  { op: 'POST /projects/{id}/steer', path: () => `/projects/${ids.eventing}/steer`, init: () => ({ ...post(), body: JSON.stringify({ text: 'Also the ride times' }) }), status: 200 },
  { op: 'POST /projects/{id}/steer', path: () => `/projects/${ids.family}/steer`, init: () => ({ ...post(), body: JSON.stringify({ text: 'x' }) }), status: 409 },
  { op: 'POST /projects/{id}/steer', path: () => `/projects/${ids.eventing}/steer`, init: () => ({ ...post(), body: JSON.stringify({ text: 'and the ride times', runId: 'an_earlier_run' }) }), status: 409 },
  { op: 'GET /projects/{id}/live', path: () => `/projects/${ids.eventing}/live`, status: 200 },
  { op: 'POST /projects/{id}/offer/accept', path: () => `/projects/${ids.eventing}/offer/accept`, init: post, status: 202 },
  { op: 'POST /projects/{id}/offer/accept', path: () => `/projects/${ids.family}/offer/accept`, init: post, status: 409 },
  // A6 asks
  { op: 'POST /ask', path: '/ask', init: () => ({ ...post(), body: JSON.stringify({ text: 'When do entries close?', projectId: ids.eventing }) }), status: 202 },
  { op: 'POST /ask', path: '/ask', init: () => ({ ...post(), body: JSON.stringify({ text: 'Go through all the rules and tell me what changed', projectId: ids.eventing }) }), status: 202 },
  { op: 'POST /ask', path: '/ask', init: () => ({ ...post(), body: JSON.stringify({ text: 'What do these say?', files: ['serve/p-general/uploads/rules.txt'], source: 'voice' }) }), status: 202 },
  { op: 'POST /ask', path: '/ask', init: () => ({ ...post(), body: JSON.stringify({ text: 'Read these later', projectId: ids.eventing, mode: 'background', capUsd: 0.4 }) }), status: 202 },
  { op: 'POST /ask', path: '/ask', init: () => ({ ...post(), body: JSON.stringify({ text: 'Is this right?', about: { kind: 'draft', id: ids.fair } }) }), status: 202 },
  { op: 'POST /ask', path: '/ask', init: () => ({ ...post(), body: JSON.stringify({ text: 'Why?', about: { kind: 'item', id: 'it_nothing' } }) }), status: 404 },
  { op: 'POST /ask', path: '/ask', init: () => ({ ...post(), body: JSON.stringify({ text: 'x', files: ['../outside.txt'] }) }), status: 400 },
  { op: 'POST /ask', path: '/ask', init: post, status: 400 },
  { op: 'GET /ask', path: () => `/ask?about=draft:${ids.fair}`, status: 200 },
  { op: 'GET /ask', path: '/ask', status: 400 },
  { op: 'GET /ask/suggestions', path: () => `/ask/suggestions?about=draft:${ids.fair}`, status: 200 },
  { op: 'GET /ask/suggestions', path: '/ask/suggestions?about=job:j_nope', status: 404 },
  { op: 'GET /ask/{id}', path: () => `/ask/${ids.plannedAsk}`, status: 200 },
  { op: 'GET /ask/{id}', path: '/ask/ak_nope', status: 404 },
  { op: 'POST /ask/{id}/choose', path: () => `/ask/${ids.plannedAsk}/choose`, init: () => ({ ...post(), body: JSON.stringify({ mode: 'background' }) }), status: 202 },
  { op: 'POST /ask/{id}/choose', path: () => `/ask/${ids.plannedAsk}/choose`, init: () => ({ ...post(), body: JSON.stringify({ mode: 'background' }) }), status: 200 },
  { op: 'POST /ask/{id}/choose', path: () => `/ask/${ids.plannedAsk}/choose`, init: () => ({ ...post(), body: JSON.stringify({ mode: 'now' }) }), status: 409 },
  { op: 'POST /ask/{id}/choose', path: () => `/ask/${ids.answeredAsk}/choose`, init: () => ({ ...post(), body: JSON.stringify({ mode: 'now' }) }), status: 409 },
  { op: 'POST /ask/{id}/choose', path: () => `/ask/${ids.plannedAsk}/choose`, init: post, status: 400 },
  { op: 'GET /sync', path: '/sync?collections=projects,turns', status: 200 },
  { op: 'GET /sync', path: '/sync?since=1&collections=projects,turns,jobs', status: 200 },
  // A10 Today
  { op: 'GET /today', path: '/today', status: 200 },
  { op: 'POST /today/seen', path: '/today/seen', init: post, status: 200 },
  { op: 'POST /today/seen', path: '/today/seen', init: () => ({ ...post(), body: '[1]' }), status: 400 },
  { op: 'GET /today', path: '/today', status: 200 },
  { op: 'POST /today/checkin/done', path: '/today/checkin/done', init: post, status: 200 },
  { op: 'POST /today/wrap/done', path: '/today/wrap/done', init: post, status: 200 },
  { op: 'GET /sync', path: '/sync?collections=today', status: 200 },
  { op: 'GET /sync', path: '/sync?since=1&collections=today,jobs,important', status: 200 },
  // W5 settings, sign-in, accounts, saved logins, files
  { op: 'GET /me', path: '/me', status: 200 },
  { op: 'POST /session', path: '/session', init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'right-password' }) }, status: 200 },
  { op: 'POST /session', path: '/session', init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'wrong' }) }, status: 401 },
  { op: 'DELETE /session', path: '/session', init: () => ({ method: 'DELETE', headers: { 'idempotency-key': `contract-key-${++keyN}` } }), status: 200 },
  { op: 'POST /session/sign-out-everywhere', path: '/session/sign-out-everywhere', init: post, status: 200 },
  { op: 'PATCH /settings', path: '/settings', init: () => ({ ...post(), method: 'PATCH', body: JSON.stringify({ publicUrl: 'mwa.tail1a2b.ts.net' }) }), status: 200 },
  { op: 'PATCH /settings', path: '/settings', init: () => ({ ...post(), method: 'PATCH', body: JSON.stringify({ publicUrl: 'ftp://x' }) }), status: 400 },
  { op: 'PATCH /settings', path: '/settings', init: () => ({ ...post(), method: 'PATCH', body: JSON.stringify({ helperName: ['a'] }) }), status: 400 },
  { op: 'PATCH /devices/{id}', path: '/devices/dev_nope', init: () => ({ ...post(), method: 'PATCH', body: JSON.stringify({ name: 'Kitchen tablet' }) }), status: 404 },
  { op: 'PATCH /devices/{id}', path: '/devices/dev_nope', init: () => ({ ...post(), method: 'PATCH', body: JSON.stringify({ name: '' }) }), status: 400 },
  { op: 'GET /settings', path: '/settings', status: 200 },
  { op: 'PATCH /settings', path: '/settings', init: () => ({ ...post(), method: 'PATCH', body: JSON.stringify({ helperName: 'Juniper', ownerName: 'Robert', timeZone: 'America/New_York', firstRunDone: true, features: { sorting: false } }) }), status: 200 },
  { op: 'PATCH /settings', path: '/settings', init: () => ({ ...post(), method: 'PATCH', body: JSON.stringify({ timeZone: 'Mars/Olympus' }) }), status: 400 },
  { op: 'PATCH /settings', path: '/settings', init: () => ({ ...post(), method: 'PATCH', body: JSON.stringify({ color: 'red' }) }), status: 400 },
  { op: 'GET /spending', path: '/spending', status: 200 },
  { op: 'PATCH /spending', path: '/spending', init: () => ({ ...post(), method: 'PATCH', body: JSON.stringify({ monthlyUsd: 20, perFireUsd: 0.3 }) }), status: 200 },
  { op: 'PATCH /spending', path: '/spending', init: () => ({ ...post(), method: 'PATCH', body: JSON.stringify({ monthlyUsd: null, perFireUsd: null }) }), status: 200 },
  { op: 'PATCH /spending', path: '/spending', init: () => ({ ...post(), method: 'PATCH', body: JSON.stringify({ perFireUsd: 50 }) }), status: 400 },
  { op: 'GET /accounts', path: '/accounts', status: 200 },
  { op: 'POST /accounts/{provider}/connect', path: '/accounts/google/connect', init: post, status: 200 },
  { op: 'POST /accounts/{provider}/connect', path: '/accounts/outlook/connect', init: post, status: 200 },
  { op: 'POST /accounts/{provider}/connect', path: '/accounts/yahoo/connect', init: post, status: 404 },
  { op: 'GET /vault', path: '/vault', status: 200 },
  { op: 'POST /vault/forget', path: '/vault/forget', init: () => ({ ...post(), body: JSON.stringify({ name: 'nothing saved' }) }), status: 404 },
  // S1: plug-ins
  { op: 'GET /plugins', path: '/plugins', status: 200 },
  { op: 'POST /plugins/{id}/enable', path: '/plugins/fetch/enable', init: post, status: 200 },
  { op: 'POST /plugins/{id}/enable', path: '/plugins/github/enable', init: post, status: 409 },
  { op: 'POST /plugins/{id}/enable', path: '/plugins/nope/enable', init: post, status: 404 },
  { op: 'POST /plugins/{id}/disable', path: '/plugins/fetch/disable', init: post, status: 200 },
  { op: 'PUT /plugins/{id}/keys', path: '/plugins/github/keys', init: () => ({ ...post(), method: 'PUT', body: JSON.stringify({ keys: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_example' } }) }), status: 200 },
  { op: 'PUT /plugins/{id}/keys', path: '/plugins/github/keys', init: () => ({ ...post(), method: 'PUT', body: JSON.stringify({ keys: { PATH: 'x' } }) }), status: 400 },
  { op: 'POST /plugins/{id}/enable', path: '/plugins/github/enable', init: post, status: 200 },
  { op: 'DELETE /plugins/{id}', path: '/plugins/my-tool', init: () => ({ method: 'DELETE', headers: { 'idempotency-key': `contract-key-${++keyN}` } }), status: 200 },
  { op: 'DELETE /plugins/{id}', path: '/plugins/github', init: () => ({ method: 'DELETE', headers: { 'idempotency-key': `contract-key-${++keyN}` } }), status: 400 },
  { op: 'DELETE /plugins/{id}', path: '/plugins/__proto__', init: () => ({ method: 'DELETE', headers: { 'idempotency-key': `contract-key-${++keyN}` } }), status: 404 },
  { op: 'DELETE /plugins/{id}/keys/{name}', path: '/plugins/github/keys/GITHUB_PERSONAL_ACCESS_TOKEN', init: () => ({ method: 'DELETE', headers: { 'idempotency-key': `contract-key-${++keyN}` } }), status: 409 },
  { op: 'DELETE /plugins/{id}/keys/{name}', path: '/plugins/github/keys/PATH', init: () => ({ method: 'DELETE', headers: { 'idempotency-key': `contract-key-${++keyN}` } }), status: 400 },
  { op: 'PUT /plugins/{id}/keys', path: '/plugins/tavily/keys', init: () => ({ ...post(), method: 'PUT', body: JSON.stringify({ keys: { TAVILY_API_KEY: 'tvly-example' } }) }), status: 200 },
  { op: 'DELETE /plugins/{id}/keys/{name}', path: '/plugins/tavily/keys/TAVILY_API_KEY', init: () => ({ method: 'DELETE', headers: { 'idempotency-key': `contract-key-${++keyN}` } }), status: 200 },
  { op: 'POST /plugins/approve', path: '/plugins/approve', init: () => ({ ...post(), body: JSON.stringify({ package: 'example-mcp' }) }), status: 409 },
  { op: 'POST /plugins/review', path: '/plugins/review', init: () => ({ ...post(), body: JSON.stringify({ package: 'example-mcp' }) }), status: 200 },
  { op: 'POST /plugins/review', path: '/plugins/review', init: () => ({ ...post(), body: JSON.stringify({ package: 'not a package' }) }), status: 400 },
  { op: 'POST /plugins/approve', path: '/plugins/approve', init: () => ({ ...post(), body: JSON.stringify({ package: 'example-mcp' }) }), status: 200 },
  // S2: the assistant itself
  { op: 'GET /assistant', path: '/assistant', status: 200 },
  { op: 'POST /assistant/models', path: '/assistant/models', init: () => ({ ...post(), body: JSON.stringify({ provider: 'openrouter' }) }), status: 200 },
  { op: 'POST /assistant/models', path: '/assistant/models', init: () => ({ ...post(), body: JSON.stringify({ provider: 'nope' }) }), status: 400 },
  { op: 'PUT /assistant/brain', path: '/assistant/brain', init: () => ({ ...post(), method: 'PUT', body: JSON.stringify({ provider: 'openrouter', model: 'openai/gpt-6.1-sol', key: 'sk-or-example' }) }), status: 200 },
  { op: 'PUT /assistant/brain', path: '/assistant/brain', init: () => ({ ...post(), method: 'PUT', body: JSON.stringify({ provider: 'openrouter', model: 'openai/gpt-6.1-sol', key: 'sk-or-bad' }) }), status: 400 },
  { op: 'PUT /assistant/image', path: '/assistant/image', init: () => ({ ...post(), method: 'PUT', body: JSON.stringify({ provider: 'openrouter', model: 'black-forest-labs/flux-2' }) }), status: 200 },
  { op: 'PUT /assistant/image', path: '/assistant/image', init: () => ({ ...post(), method: 'PUT', body: JSON.stringify({ provider: 'anthropic', model: 'claude' }) }), status: 400 },
  { op: 'DELETE /assistant/image', path: '/assistant/image', init: () => ({ method: 'DELETE', headers: { 'idempotency-key': `contract-key-${++keyN}` } }), status: 200 },
  { op: 'PUT /assistant/access', path: '/assistant/access', init: () => ({ ...post(), method: 'PUT', body: JSON.stringify({ preset: 'assistant' }) }), status: 200 },
  { op: 'PUT /assistant/access', path: '/assistant/access', init: () => ({ ...post(), method: 'PUT', body: JSON.stringify({ preset: 'root' }) }), status: 400 },
  { op: 'POST /assistant/folders', path: '/assistant/folders', init: () => ({ ...post(), body: JSON.stringify({ path: ids.folder }) }), status: 200 },
  { op: 'POST /assistant/folders', path: '/assistant/folders', init: () => ({ ...post(), body: JSON.stringify({ path: 'relative/folder' }) }), status: 400 },
  { op: 'POST /assistant/folders/remove', path: '/assistant/folders/remove', init: () => ({ ...post(), body: JSON.stringify({ path: ids.folder }) }), status: 200 },
  { op: 'POST /assistant/folders/remove', path: '/assistant/folders/remove', init: () => ({ ...post(), body: JSON.stringify({ path: ids.folder }) }), status: 404 },
  { op: 'PUT /assistant/style', path: '/assistant/style', init: () => ({ ...post(), method: 'PUT', body: JSON.stringify({ style: 'direct' }) }), status: 200 },
  { op: 'PUT /assistant/style', path: '/assistant/style', init: () => ({ ...post(), method: 'PUT', body: JSON.stringify({ style: 'loud' }) }), status: 400 },
  // S3: connections
  { op: 'GET /connections', path: '/connections', status: 200 },
  { op: 'POST /connections/gmail/app-password', path: '/connections/gmail/app-password', init: () => ({ ...post(), body: JSON.stringify({ address: 'me@gmail.com', appPassword: 'abcd efgh ijkl mnop' }) }), status: 200 },
  { op: 'POST /connections/gmail/app-password', path: '/connections/gmail/app-password', init: () => ({ ...post(), body: JSON.stringify({ address: 'me@gmail.com', appPassword: 'badbadbadbadbadx' }) }), status: 400 },
  { op: 'PUT /connections/google/app', path: '/connections/google/app', init: () => ({ ...post(), method: 'PUT', body: JSON.stringify({ clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-example' }) }), status: 200 },
  { op: 'PUT /connections/google/app', path: '/connections/google/app', init: () => ({ ...post(), method: 'PUT', body: JSON.stringify({ clientId: 'nope', clientSecret: 'x' }) }), status: 400 },
  { op: 'PUT /connections/outlook/app', path: '/connections/outlook/app', init: () => ({ ...post(), method: 'PUT', body: JSON.stringify({ clientId: '11111111-2222-3333-4444-555555555555' }) }), status: 200 },
  { op: 'PUT /connections/outlook/app', path: '/connections/outlook/app', init: () => ({ ...post(), method: 'PUT', body: JSON.stringify({ clientId: 'nope' }) }), status: 400 },
  { op: 'PUT /connections/telegram', path: '/connections/telegram', init: () => ({ ...post(), method: 'PUT', body: JSON.stringify({ token: '123456789:AAHexampleTOKENexampleTOKEN0123456' }) }), status: 200 },
  { op: 'PUT /connections/telegram', path: '/connections/telegram', init: () => ({ ...post(), method: 'PUT', body: JSON.stringify({ token: 'nope' }) }), status: 400 },
  { op: 'PUT /connections/tailscale', path: '/connections/tailscale', init: () => ({ ...post(), method: 'PUT', body: JSON.stringify({ authKey: 'tskey-auth-example', hostname: 'mwa' }) }), status: 200 },
  { op: 'PUT /connections/tailscale', path: '/connections/tailscale', init: () => ({ ...post(), method: 'PUT', body: JSON.stringify({ authKey: 'tskey-api-example' }) }), status: 400 },
  { op: 'DELETE /connections/{service}', path: '/connections/telegram', init: () => ({ method: 'DELETE', headers: { 'idempotency-key': `contract-key-${++keyN}` } }), status: 200 },
  { op: 'POST /accounts/{provider}/cancel', path: '/accounts/outlook/cancel', init: post, status: 200 },
  { op: 'POST /accounts/{provider}/cancel', path: '/accounts/nope/cancel', init: post, status: 404 },
  { op: 'DELETE /connections/{service}', path: '/connections/everything', init: () => ({ method: 'DELETE', headers: { 'idempotency-key': `contract-key-${++keyN}` } }), status: 404 },
  { op: 'POST /files', path: () => `/files?projectId=${ids.eventing}&name=notes.txt`, init: () => ({ method: 'POST', headers: { 'idempotency-key': `contract-key-${++keyN}`, 'content-type': 'text/plain' }, body: 'Entries close Friday.' }), status: 201 },
  { op: 'POST /files', path: '/files?projectId=pr_nope&name=notes.txt', init: () => ({ method: 'POST', headers: { 'idempotency-key': `contract-key-${++keyN}`, 'content-type': 'text/plain' }, body: 'x' }), status: 404 },
  { op: 'GET /files', path: () => `/files?projectId=${ids.eventing}`, status: 200 },
  { op: 'GET /files', path: '/files', status: 200 },
  // P3: web push (a fake push service; the subscriptions belong to a fresh password session each)
  { op: 'GET /push/subscriptions', path: '/push/subscriptions', status: 200 },
  { op: 'POST /push/subscriptions', path: '/push/subscriptions', init: () => ({ ...post(), headers: { ...(post().headers as Record<string, string>), cookie: pushSession().cookie }, body: JSON.stringify(pushBrowser()) }), status: 201 },
  { op: 'POST /push/subscriptions', path: '/push/subscriptions', init: () => ({ ...post(), headers: { ...(post().headers as Record<string, string>), cookie: pushSession().cookie }, body: JSON.stringify({ ...pushBrowser(), endpoint: 'http://evil.example/push' }) }), status: 400 },
  { op: 'PATCH /push/settings', path: '/push/settings', init: () => ({ ...post(), method: 'PATCH', body: JSON.stringify({ morning: '08:00', kinds: { result: true } }) }), status: 200 },
  { op: 'PATCH /push/settings', path: '/push/settings', init: () => ({ ...post(), method: 'PATCH', body: JSON.stringify({ morning: '13:00' }) }), status: 400 },
  { op: 'POST /push/test', path: '/push/test', init: () => { const s = pushSession(); const b = pushBrowser(); saveSubscription({ endpoint: b.endpoint, p256dh: b.keys.p256dh, auth: b.keys.auth, owner: `session:${s.id}`, vendor: 'google' }); return { ...post(), headers: { ...(post().headers as Record<string, string>), cookie: s.cookie } }; }, status: 200 },
  { op: 'POST /push/test', path: '/push/test', init: () => ({ ...post(), headers: { ...(post().headers as Record<string, string>), cookie: pushSession().cookie } }), status: 409 },
  { op: 'DELETE /push/subscriptions/{id}', path: () => { const b = pushBrowser(); return `/push/subscriptions/${saveSubscription({ endpoint: b.endpoint, p256dh: b.keys.p256dh, auth: b.keys.auth, owner: 'local', vendor: 'google' }).id}`; }, init: () => ({ method: 'DELETE', headers: { 'idempotency-key': `contract-key-${++keyN}` } }), status: 200 },
  { op: 'DELETE /push/subscriptions/{id}', path: '/push/subscriptions/ps_nope', init: () => ({ method: 'DELETE', headers: { 'idempotency-key': `contract-key-${++keyN}` } }), status: 404 },
];
function pushSession() { const s = issueSession(); return { id: s.id, cookie: `mwa_session=${s.token}` }; }
function pushBrowser() {
  const e = createECDH('prime256v1'); e.generateKeys();
  return { endpoint: `https://fcm.googleapis.com/fcm/send/${randomBytes(6).toString('hex')}`, keys: { p256dh: e.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
}

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
  // review of W3: the caution travels with the message wherever it is shown, and a display name never holds an address
  it('GET /mail/{id} and /mail carry the message caution; names never hold an address', async () => {
    const phish = await (await fetch(`${base}/mail/${mailId('google:me@example.com', 'c4')}`)).json() as { caution: string | null; trust: string; from: { name: string | null; addr: string } };
    expect(phish).toMatchObject({ caution: 'phishing', trust: 'untrusted', from: { name: 'PayPal Service', addr: 'x@evil.example' } });
    const ok = await (await fetch(`${base}/mail/${ids.mail}`)).json() as { caution: string | null };
    expect(ok.caution).toBeNull();
    const list = await (await fetch(`${base}/mail`)).json() as { mail: { id: string; caution: string | null; from: { name: string | null } }[] };
    expect(list.mail.find((m) => m.id === mailId('google:me@example.com', 'c4'))).toMatchObject({ caution: 'phishing', from: { name: 'PayPal Service' } });
    expect(list.mail.every((m) => !(m.from.name ?? '').includes('@'))).toBe(true);
  });
});
