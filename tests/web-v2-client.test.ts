// v2 build, slice W1: the web client (web/src/v2/api/client.ts) calls only what api/openapi.yaml defines, sends the
// client header and an Idempotency-Key on every write (the same one on a retry), and turns the server's errors into
// typed errors that carry its plain message.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { MwaClient, ApiError, Conflict, Forbidden, NetworkError, SignInRequired, UpdateRequired, newKey, WEB_VERSION } from '../web/src/v2/api/client';

const spec = parse(readFileSync(new URL('../api/openapi.yaml', import.meta.url), 'utf8')) as { paths: Record<string, Record<string, unknown>> };
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const OPS = Object.entries(spec.paths).flatMap(([path, item]) => METHODS.filter((m) => item[m]).map((m) => ({
  key: `${m.toUpperCase()} ${path}`,
  re: new RegExp('^/api/v1' + path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{\w+\\?\}/g, '[^/?]+') + '(\\?.*)?$'),
  method: m.toUpperCase(),
})));

interface Seen { method: string; url: string; headers: Record<string, string>; body: unknown }
function recorder(reply: (s: Seen) => { status: number; body?: unknown } = () => ({ status: 200, body: {} })) {
  const seen: Seen[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((v, k) => { headers[k] = v; });
    const s: Seen = { method: init?.method ?? 'GET', url: String(input), headers, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined };
    seen.push(s);
    const r = reply(s);
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { seen, fetch: f };
}

/** Every public method of the client, called once with plausible arguments. */
const CALLS: Record<string, (c: MwaClient) => unknown> = {
  getMeta: (c) => c.getMeta(),
  createPairCode: (c) => c.createPairCode(),
  pairDevice: (c) => c.pairDevice({ code: 'ABCD-EFGH', name: 'Phone' }),
  listDevices: (c) => c.listDevices(),
  revokeDevice: (c) => c.revokeDevice('dev_1'),
  signOutThisDevice: (c) => c.signOutThisDevice(),
  listJobs: (c) => c.listJobs({ state: 'working', limit: 10, before: 5, archived: '0' }),
  getJob: (c) => c.getJob('j 1'),
  estimateJob: (c) => c.estimateJob('j1'),
  stopJob: (c) => c.stopJob('j1'),
  continueJob: (c) => c.continueJob('j1', { capUsd: 0.5 }),
  startJobOver: (c) => c.startJobOver('j1'),
  openJob: (c) => c.openJob('j1'),
  pauseJob: (c) => c.pauseJob('j1'),
  resumeJob: (c) => c.resumeJob('j1'),
  cancelJob: (c) => c.cancelJob('j1'),
  streamUrl: (c) => c.streamUrl(42),
  sync: (c) => c.sync({ since: 7, collections: ['jobs', 'turns'] }),
  getCalendar: (c) => c.getCalendar({ from: '2026-11-09', to: '2026-11-15' }),
  getCalendarAccounts: (c) => c.getCalendarAccounts(),
  refreshCalendar: (c) => c.refreshCalendar(),
  createCalendarDraft: (c) => c.createCalendarDraft({ title: 'Book fair', start: '2026-11-14T15:00' }),
  confirmCalendarDraft: (c) => c.confirmCalendarDraft('cd_1'),
  removeCalendarDraft: (c) => c.removeCalendarDraft('cd_1'),
  calendarDraftIcsUrl: (c) => c.calendarDraftIcsUrl('cd_1'),
  listMail: (c) => c.listMail({ limit: 20 }),
  listMailAccounts: (c) => c.listMailAccounts(),
  refreshMail: (c) => c.refreshMail(),
  readMail: (c) => c.readMail('m_abc'),
  saveMailDraft: (c) => c.saveMailDraft('m_abc', { body: 'Yes please' }),
  listProjects: (c) => c.listProjects({ archived: '1' }),
  createProject: (c) => c.createProject({ name: 'Eventing' }),
  suggestProject: (c) => c.suggestProject({ text: 'book fair', from: 'family' }),
  updateProject: (c) => c.updateProject('p1', { name: 'Eventing' }),
  getProjectThread: (c) => c.getProjectThread('p1', { limit: 50 }),
  sendProjectMessage: (c) => c.sendProjectMessage('p1', { text: 'hi' }),
  getProjectWork: (c) => c.getProjectWork('p1'),
  getProjectFiles: (c) => c.getProjectFiles('p1'),
  moveTurn: (c) => c.moveTurn('t1', { projectId: 'p2' }),
  stopProjectRun: (c) => c.stopProjectRun('p1'),
  steerProjectRun: (c) => c.steerProjectRun('p1', { text: 'shorter' }),
  projectLiveUrl: (c) => c.projectLiveUrl('p1'),
  acceptProjectOffer: (c) => c.acceptProjectOffer('p1'),
  ask: (c) => c.ask({ text: 'What time is the book fair?' }),
  listAsksAbout: (c) => c.listAsksAbout('item:i1'),
  askSuggestions: (c) => c.askSuggestions('item:i1'),
  getAsk: (c) => c.getAsk('a1'),
  chooseAsk: (c) => c.chooseAsk('a1', { mode: 'background' }),
  listImportant: (c) => c.listImportant({ group: 'today' }),
  listSkipped: (c) => c.listSkipped(),
  markItemHandled: (c) => c.markItemHandled('i1'),
  unhandleItem: (c) => c.unhandleItem('i1'),
  markItemNotImportant: (c) => c.markItemNotImportant('i1', { scope: 'sender' }),
  markMailImportant: (c) => c.markMailImportant('m1'),
  runItemAction: (c) => c.runItemAction('i1'),
  refreshImportant: (c) => c.refreshImportant(),
  getToday: (c) => c.getToday(),
  markTodaySeen: (c) => c.markTodaySeen({ seenAt: 1_700_000_000_000 }),
  finishCheckin: (c) => c.finishCheckin({ day: '2026-11-09' }),
  finishWrap: (c) => c.finishWrap({ day: '2026-11-09' }),
  listTriageRules: (c) => c.listTriageRules(),
  deleteTriageRule: (c) => c.deleteTriageRule('r1'),
  // P3
  listPushSubscriptions: (c) => c.listPushSubscriptions(),
  addPushSubscription: (c) => c.addPushSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'p', auth: 'a' } }),
  removePushSubscription: (c) => c.removePushSubscription('ps_1'),
  updatePushSettings: (c) => c.updatePushSettings({ morning: '07:30' }),
  sendPushTest: (c) => c.sendPushTest(),
  // W5
  getMe: (c) => c.getMe(),
  signIn: (c) => c.signIn('pw'),
  signOut: (c) => c.signOut(),
  signOutEverywhere: (c) => c.signOutEverywhere(),
  renameDevice: (c) => c.renameDevice('dev_1', 'Kitchen tablet'),
  getSettings: (c) => c.getSettings(),
  updateSettings: (c) => c.updateSettings({ helperName: 'Juniper' }),
  getSpending: (c) => c.getSpending(),
  updateSpending: (c) => c.updateSpending({ monthlyUsd: 20 }),
  listAccounts: (c) => c.listAccounts(),
  connectAccount: (c) => c.connectAccount('google'),
  listVault: (c) => c.listVault(),
  forgetVaultEntry: (c) => c.forgetVaultEntry('Bank'),
  listFiles: (c) => c.listFiles({ projectId: 'general' }),
  uploadFile: (c) => c.uploadFile(new Blob(['x']), { name: 'a.txt', projectId: 'general' }),
};
const URL_ONLY = new Set(['streamUrl', 'calendarDraftIcsUrl', 'projectLiveUrl']); // GET links opened by EventSource or a download

describe('the v2 web client and the contract', () => {
  it('the table above calls every public method of the client', () => {
    const methods = Object.getOwnPropertyNames(MwaClient.prototype).filter((m) => !['constructor', 'call', 'get', 'post', 'url'].includes(m));
    expect(methods.sort()).toEqual(Object.keys(CALLS).sort());
  });

  it('every URL the client can call is an operation in api/openapi.yaml, and it reaches every operation', async () => {
    const r = recorder();
    const c = new MwaClient({ fetch: r.fetch });
    const used = new Set<string>();
    for (const [name, call] of Object.entries(CALLS)) {
      const before = r.seen.length;
      const out = await call(c);
      const hits = URL_ONLY.has(name) ? [{ method: 'GET', url: String(out) }] : r.seen.slice(before);
      expect(hits.length, name).toBe(1);
      for (const h of hits) {
        const op = OPS.find((o) => o.method === h.method && o.re.test(h.url));
        expect(op, `${name}: ${h.method} ${h.url} is not in the spec`).toBeTruthy();
        used.add(op!.key);
      }
    }
    expect([...used].sort()).toEqual(OPS.map((o) => o.key).sort());
  });

  it('sends X-MWA-Client on every request and an Idempotency-Key on every write, not on reads', async () => {
    const r = recorder();
    const c = new MwaClient({ fetch: r.fetch });
    for (const call of Object.values(CALLS)) await call(c);
    for (const s of r.seen) {
      expect(s.headers['x-mwa-client']).toBe(`web/${WEB_VERSION}`);
      if (s.method === 'GET') expect(s.headers['idempotency-key']).toBeUndefined();
      else expect(s.headers['idempotency-key']).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
    }
    const keys = r.seen.filter((s) => s.method !== 'GET').map((s) => s.headers['idempotency-key']);
    expect(new Set(keys).size).toBe(keys.length); // one per action
  });

  it('keeps the key it is given, and retries a 409 in_progress with the same key', async () => {
    let n = 0;
    const r = recorder(() => (++n < 3 ? { status: 409, body: { error: { code: 'in_progress', message: 'Still handling that.' } } } : { status: 200, body: { job: { id: 'j1' }, tries: [] } }));
    const c = new MwaClient({ fetch: r.fetch, sleep: async () => {} });
    await c.stopJob('j1', { key: 'KEY-0001-abcdef' });
    expect(r.seen.map((s) => s.headers['idempotency-key'])).toEqual(['KEY-0001-abcdef', 'KEY-0001-abcdef', 'KEY-0001-abcdef']);
  });

  it('turns errors into typed errors with the server\'s plain message', async () => {
    const cases: [number, string, string, new (...a: never[]) => Error][] = [
      [401, 'locked', 'Sign in to continue.', SignInRequired],
      [403, 'forbidden', 'This device is not allowed to do that.', Forbidden],
      [409, 'running', 'It is already working.', Conflict],
      [426, 'client_too_old', 'A newer version of the app is needed. Reload to update.', UpdateRequired],
      [404, 'not_found', 'No such job.', ApiError],
    ];
    for (const [status, code, message, Type] of cases) {
      const c = new MwaClient({ fetch: recorder(() => ({ status, body: { error: { code, message } } })).fetch, inProgressRetries: 0 });
      const e = await c.getJob('j1').catch((x: unknown) => x);
      expect(e).toBeInstanceOf(Type);
      expect((e as ApiError).status).toBe(status);
      expect((e as ApiError).code).toBe(code);
      expect((e as ApiError).message).toBe(message);
    }
    // not JSON (a proxy's error page): still a typed error, with plain words
    const c = new MwaClient({ fetch: (async () => new Response('<html>bad gateway</html>', { status: 502 })) as typeof fetch });
    const e = await c.getMeta().catch((x: unknown) => x) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.message).toMatch(/Try again/);
    // no answer at all
    const off = new MwaClient({ fetch: (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch });
    expect(await off.getMeta().catch((x: unknown) => x)).toBeInstanceOf(NetworkError);
  });

  it('encodes ids in paths and drops empty query values', async () => {
    const r = recorder();
    const c = new MwaClient({ fetch: r.fetch });
    await c.getJob('a/b c');
    await c.listJobs({ state: undefined, limit: 5 });
    expect(r.seen.map((s) => s.url)).toEqual(['/api/v1/jobs/a%2Fb%20c', '/api/v1/jobs?limit=5']);
  });

  it('makes time-ordered keys the server accepts', () => {
    const a = newKey(1_000), b = newKey(2_000);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a < b).toBe(true);
  });
});
