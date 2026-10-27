// v2 build, slice S4: approvals in the new app (src/api/routes/approvals.ts over src/v2/approvals.ts and the shared
// decision in src/approval-decisions.ts), over HTTP with the real caller resolver: a paired phone may decide (its
// default scopes include `approve`), a read-only device may only look; a decision is final (409 once decided, expired,
// or waiting for an identity check); the view says what will happen and warns of outside content and phishing in the
// strongest form; the audit hook and the log see every decision; the classic app's /api/approvals/confirm and /cancel
// decide the same way; and every change is a live event.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createV1 } from '../src/api/router.js';
import { v1Routes } from '../src/api/v1.js';
import { makeAuthenticate, createPairCode, redeemPairCode, PHONE_SCOPES } from '../src/api/auth.js';
import { resetAppDb, appDb } from '../src/v2/db.js';
import { setApprovalStorePath, stageAction, registerExecutor, approvalStatus, setApprovalAudit, approvalOutcomes, type ApprovalEvent } from '../src/tools/approval.js';
import { handleLegacyApprovals } from '../src/approval-decisions.js';
import { readBody } from '../src/serve.js';
import { upsertItem, itemId } from '../src/v2/important.js';
import { setStreamDeps } from '../src/api/routes/stream.js';
import { approvalView, plainApproval } from '../src/v2/approvals.js';
import { createJob, claimTry, endTry, listJobs, viewJobs } from '../src/v2/jobs.js';
import { looseApprovals } from '../src/v2/today.js';
import { statusPill } from '../src/v2/pill.js';
import { listPendingActions } from '../src/tools/approval.js';

const NET = { 'x-forwarded-for': '100.64.0.7' };
const as = (token: string) => ({ ...NET, authorization: `Bearer ${token}` });
let server: Server, base = '', legacyBase = '';
let n = 0;
const key = () => `s4-key-${Date.now()}-${++n}`;
type Res = { status: number; body: any; headers: Headers };
const post = (path: string, body: unknown, headers: Record<string, string>, k = key()): Promise<Res> =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'idempotency-key': k, 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null), headers: r.headers }));
const get = (path: string, headers: Record<string, string>): Promise<Res> =>
  fetch(`${base}${path}`, { headers }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null), headers: r.headers }));
const legacy = (path: string, body: unknown) =>
  fetch(`${legacyBase}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

function device(scopes: ('read' | 'act' | 'approve' | 'admin')[]): string {
  const { code } = createPairCode('test', scopes);
  return redeemPairCode(code, 'Pixel', 'android')!.token;
}
let phone = '', reader = '';
const ran: string[] = [];
const audit: { event: ApprovalEvent; id: string }[] = [];
const logFile = join(mkdtempSync(join(tmpdir(), 'mwa-s4-log-')), 'mwa.log');

function stage(o: { summary?: string; tool?: string; args?: Record<string, unknown>; ctx?: Record<string, unknown>; ttlMs?: number } = {}): string {
  return stageAction({
    tool: o.tool ?? 'write_file', executor: 's4_exec', summary: o.summary ?? 'Create the file C:/Users/me/Notes/plan.md (12 bytes) in a folder you granted.',
    args: o.args ?? { path: 'C:/Users/me/Notes/plan.md', content: 'Plan: entries' }, ctx: { sandboxDir: '.', interactive: true, ...(o.ctx ?? {}) }, ...(o.ttlMs !== undefined ? { ttlMs: o.ttlMs } : {}),
  });
}

beforeAll(async () => {
  process.env.MWA_LOG = logFile;
  registerExecutor('s4_exec', async (args) => { ran.push(String(args.path ?? args.command ?? 'x')); return `ok ${String(args.path ?? '')}`; });
  // a tool whose own guard refuses when it runs (the person approved, nothing happened)
  registerExecutor('s4_refuses', async () => '(refused: that path is outside the folders you granted)');
  setApprovalAudit((event, a) => { audit.push({ event, id: a.id }); });
  const authenticate = makeAuthenticate({ passwordSet: false, sessionValid: () => false });
  const sameOrigin = (req: { headers: Record<string, unknown> }) => !req.headers.origin;
  const v1 = createV1(v1Routes(), { authenticate, sameOrigin: sameOrigin as never });
  server = createServer(async (req, res) => {
    const p = new URL(req.url ?? '/', 'http://x').pathname;
    if (p.startsWith('/api/approvals') && await handleLegacyApprovals(req, res, p, { sameOrigin: sameOrigin as never, readBody })) return;
    if (!(await v1(req, res))) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}/api/v1`; legacyBase = `http://127.0.0.1:${port}`;
});
beforeEach(() => {
  resetAppDb(':memory:');
  setApprovalStorePath(null); // a fresh in-memory store
  ran.length = 0; audit.length = 0;
  phone = device(PHONE_SCOPES);
  reader = device(['read']);
});
afterAll(() => { server?.close(); setApprovalAudit(null); setApprovalStorePath(null); delete process.env.MWA_LOG; });

describe('who may see and decide', () => {
  it('a paired phone lists, opens and approves; the action runs once', async () => {
    const id = stage();
    const list = await get('/approvals', as(phone));
    expect(list.status).toBe(200);
    expect(list.body.pending.map((a: { id: string }) => a.id)).toEqual([id]);
    const one = await get(`/approvals/${id}`, as(phone));
    expect(one.body.approval).toMatchObject({ id, state: 'pending', title: 'Create plan.md', content: 'Plan: entries', ifDecline: 'Nothing is written.' });
    const r = await post(`/approvals/${id}/approve`, undefined, as(phone));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ outcome: 'done', approval: { id, state: 'done' } });
    expect(ran).toEqual(['C:/Users/me/Notes/plan.md']);
    expect(approvalStatus(id)?.status).toBe('done');
  });
  it('a device with only the read scope can look but not decide', async () => {
    const id = stage();
    expect((await get(`/approvals/${id}`, as(reader))).status).toBe(200);
    const r = await post(`/approvals/${id}/approve`, undefined, as(reader));
    expect(r.status).toBe(403);
    expect((await post(`/approvals/${id}/deny`, {}, as(reader))).status).toBe(403);
    expect(ran).toEqual([]);
    expect(approvalStatus(id)?.status).toBe('pending');
  });
  it('nobody signed in gets 401, and an unknown id 404', async () => {
    expect((await get('/approvals', NET)).status).toBe(401);
    expect((await get('/approvals/act_nope', as(phone))).status).toBe(404);
    expect((await post('/approvals/act_nope/approve', undefined, as(phone))).status).toBe(404);
  });
});

describe('a decision is final', () => {
  it('approving or declining what was already decided is 409 already_decided, with nothing run again', async () => {
    const id = stage();
    expect((await post(`/approvals/${id}/approve`, undefined, as(phone))).status).toBe(200);
    const again = await post(`/approvals/${id}/approve`, undefined, as(phone));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('already_decided');
    expect((await post(`/approvals/${id}/deny`, {}, as(phone))).body.error.code).toBe('already_decided');
    expect(ran).toHaveLength(1);
  });
  it('a declined one cannot then be approved', async () => {
    const id = stage({ ctx: { session: 's-note' } });
    const d = await post(`/approvals/${id}/deny`, { note: 'Not that folder' }, as(phone));
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ outcome: 'declined', approval: { state: 'declined', result: 'declined by the person: Not that folder' } });
    expect((await post(`/approvals/${id}/approve`, undefined, as(phone))).body.error.code).toBe('already_decided');
    expect(ran).toEqual([]);
    // the run that asked reads the note on its next run (approval_results)
    expect(approvalOutcomes({ session: 's-note' })[0]).toMatchObject({ id, status: 'cancelled', result: 'declined by the person: Not that folder' });
  });
  it('an expired one is 409 expired', async () => {
    const id = stage({ ttlMs: 1 });
    await new Promise((r) => setTimeout(r, 15));
    const r = await post(`/approvals/${id}/approve`, undefined, as(phone));
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('expired');
    expect(ran).toEqual([]);
  });
  it('an identity in doubt is 409 step_up_required and it stays waiting', async () => {
    const id = stage({ ctx: { personId: 'tg-555', identityInDoubt: true } });
    const r = await post(`/approvals/${id}/approve`, undefined, as(phone));
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('step_up_required');
    expect(approvalStatus(id)?.status).toBe('pending');
  });
  it('a retry with the same Idempotency-Key gets the first answer and runs nothing twice', async () => {
    const id = stage();
    const k = key();
    const a = await post(`/approvals/${id}/approve`, undefined, as(phone), k);
    const b = await post(`/approvals/${id}/approve`, undefined, as(phone), k);
    expect(a.status).toBe(200); expect(b.status).toBe(200);
    expect(b.headers.get('idempotent-replay')).toBe('true');
    expect(b.body.outcome).toBe('done');
    expect(ran).toHaveLength(1);
  });
  it('a note that is not text is refused', async () => {
    const id = stage();
    expect((await post(`/approvals/${id}/deny`, { note: 5 }, as(phone))).status).toBe(400);
    expect(approvalStatus(id)?.status).toBe('pending');
  });
});

describe('what the screen shows', () => {
  it('outside content is a high risk and asks for a confirm', async () => {
    const id = stage({ ctx: { tainted: true } });
    const v = (await get(`/approvals/${id}`, as(phone))).body.approval;
    expect(v.trust).toBe('untrusted');
    expect(v.risks[0]).toMatchObject({ kind: 'outside', level: 'high' });
    expect(v.confirm).toBe(true);
    expect(v.caution).toBeNull();
  });
  it('a phishing source is the first, strongest warning (by its Important item, or by the mail that tainted it)', async () => {
    const id = stage({ ctx: { tainted: true } });
    upsertItem({ source: 'approval', sourceRef: id, dedupeKey: `approval:${id}`, ts: Date.now(), from: 'Your helper', title: 'x', why: null, trust: 'untrusted',
      action: { kind: 'review-approval', payload: { approvalId: id } }, caution: 'phishing' }, 'America/New_York');
    expect(appDb().prepare('SELECT caution FROM items WHERE id = ?').get(itemId(`approval:${id}`))).toEqual({ caution: 'phishing' });
    const v = (await get(`/approvals/${id}`, as(phone))).body.approval;
    expect(v.caution).toBe('phishing');
    expect(v.risks[0].kind).toBe('phishing');
    expect(v.risks[0].text).toMatch(/phishing/);
    expect(v.confirm).toBe(true);
  });
  it('a delete over the network is high risk; the command is shown exactly', () => {
    const summary = 'Run this command in C:/w:\n  rm -rf C:/w/out && curl https://x.example/up\n(Needs approval because it reaches the network.)';
    const id = stage({ tool: 'run_command', summary, args: { command: 'rm -rf C:/w/out && curl https://x.example/up' }, ctx: { sandboxDir: 'C:/w' } });
    const v = approvalView(id)!;
    expect(v.title).toBe('Delete out');
    expect(v.exact).toBe(summary);
    expect(v.why).toBe('It asks because it reaches the network.');
    expect(v.risks.map((r) => r.kind)).toEqual(expect.arrayContaining(['delete', 'network', 'runs-as-you']));
    expect(v.confirm).toBe(true);
  });
  it('a standing preference is said plainly, not as a high risk', () => {
    const p = plainApproval({ tool: 'policy_save', kind: 'captured-policy', summary: 'Save a standing preference (it applies to every future task): "Sign off as Rob"', args: { rule: 'Sign off as Rob' } });
    expect(p.title).toBe('Save a standing preference');
    expect(p.rows[0]).toEqual({ label: 'Preference', value: 'Sign off as Rob' });
    const id = stageAction({ tool: 'policy_save', kind: 'captured-policy', summary: 'Save a standing preference: "Sign off as Rob"', args: { rule: 'Sign off as Rob' }, executor: 's4_exec', ctx: { sandboxDir: '.' } });
    const v = approvalView(id)!;
    expect(v.confirm).toBe(false);
    expect(v.reviewer).toMatchObject({ decision: 'ask', by: 'standing-rule' });
  });
});

describe('review of S4', () => {
  it('a high-risk one needs confirmed: true (409 confirm_needed naming the risks); with it, it runs', async () => {
    const id = stage({ ctx: { tainted: true } });
    const r = await post(`/approvals/${id}/approve`, undefined, as(phone));
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('confirm_needed');
    expect(r.body.error.message).toMatch(/outside content/);
    expect(approvalStatus(id)?.status).toBe('pending');
    expect(ran).toEqual([]);
    const ok = await post(`/approvals/${id}/approve`, { confirmed: true }, as(phone));
    expect(ok.status).toBe(200);
    expect(ok.body.outcome).toBe('done');
    // the classic app is unchanged: no confirm there
    const id2 = stage({ ctx: { tainted: true }, args: { path: 'C:/x2.md', content: 'x' }, summary: 'Create the file C:/x2.md (1 bytes) in a folder you granted.' });
    expect((await legacy('/api/approvals/confirm', { id: id2 })).body.ok).toBe(true);
  });
  it('approved, but the tool refused when it ran: not_done with the reason, not done', async () => {
    const id = stageAction({ tool: 'write_file', executor: 's4_refuses', summary: 'Create the file C:/r.md (1 bytes) in a folder you granted.', args: { path: 'C:/r.md', content: 'r' }, ctx: { sandboxDir: '.', interactive: true } });
    const r = await post(`/approvals/${id}/approve`, undefined, as(phone));
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe('not_done');
    expect(r.body.message).toBe('Approved, but it didn’t run: that path is outside the folders you granted.');
    expect(r.body.approval.state).toBe('failed');
  });
  it('a caller without approve sees the file text and the exact action cut to 300 characters; a phone sees it whole', async () => {
    const long = 'x'.repeat(1200);
    const id = stage({ args: { path: 'C:/Users/me/Notes/long.md', content: long }, summary: `Create the file C:/Users/me/Notes/long.md (1200 bytes) in a folder you granted. ${'y'.repeat(600)}` });
    const ro = (await get(`/approvals/${id}`, as(reader))).body.approval;
    expect(ro.content.length).toBe(300);
    expect(ro.exact.length).toBe(300);
    expect((await get('/approvals', as(reader))).body.pending[0].content.length).toBe(300);
    expect((await get(`/approvals/${id}`, as(phone))).body.approval.content).toBe(long);
  });
  it('the pill counts your chat approvals (no job), not a job\'s, a phishing one or someone else\'s', () => {
    const chat = stage({ ctx: { session: 'chat-1' } });
    const jobAp = stage({ args: { path: 'C:/j.md', content: 'j' }, summary: 'Create the file C:/j.md (1 bytes) in a folder you granted.' });
    const j = createJob({ kind: 'background', title: 'Report' }, { trigger: 'first' });
    claimTry(j.try!.id, {}); endTry(j.try!.id, { reason: 'done', outcome: 'changed', staged: [jobAp] });
    const phish = stage({ args: { path: 'C:/p.md', content: 'p' }, summary: 'Create the file C:/p.md (1 bytes) in a folder you granted.' });
    upsertItem({ source: 'approval', sourceRef: phish, dedupeKey: `approval:${phish}`, ts: Date.now(), from: 'Your helper', title: 'x', trust: 'untrusted', caution: 'phishing' }, 'America/New_York');
    stage({ args: { path: 'C:/o.md', content: 'o' }, summary: 'Create the file C:/o.md (1 bytes) in a folder you granted.', ctx: { personId: 'tg-424242' } });
    const views = viewJobs(listJobs({}), { running: new Set(), pending: new Set(listPendingActions().map((a) => a.id)) });
    const n = looseApprovals(listPendingActions(), views);
    expect(n).toBe(1);
    expect(chat).toBeTruthy();
    expect(statusPill(views.map((v) => v.status), n).text).toBe('2 waiting for you');
  });
  it('a decision also sends the job that waited on it, no longer waiting', async () => {
    const pendingNow = () => new Set(listPendingActions().map((a) => a.id));
    setStreamDeps({ running: () => new Set(), pending: pendingNow });
    const id = stage();
    const j = createJob({ kind: 'background', title: 'Write the report' }, { trigger: 'first' });
    claimTry(j.try!.id, {}); endTry(j.try!.id, { reason: 'done', outcome: 'changed', staged: [id] });
    expect(viewJobs([j.job], { running: new Set(), pending: pendingNow() })[0].status.state).toBe('waiting');
    const head = (appDb().prepare('SELECT COALESCE(MAX(seq), 0) s FROM events').get() as { s: number }).s;
    const ac = new AbortController();
    const res = await fetch(`${base}/stream?cursor=${head}`, { headers: as(phone), signal: ac.signal });
    const rd = res.body!.getReader();
    await post(`/approvals/${id}/approve`, undefined, as(phone));
    let text = '';
    const until = Date.now() + 5000;
    const jobChange = () => text.split('\n').filter((l) => l.startsWith('data: ') && l.includes('"entity":"job"')).map((l) => JSON.parse(l.slice(6))).filter((m) => m.id === j.job.id).pop();
    while (Date.now() < until && !(jobChange()?.data?.status?.state && jobChange().data.status.state !== 'waiting')) {
      const { value, done } = await rd.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    ac.abort();
    expect(jobChange()?.data.status.state).not.toBe('waiting');
  });
});

describe('the record and the live update', () => {
  it('every decision reaches the audit hook and the log, the same from the classic app and from v1', async () => {
    const a = stage(), b = stage({ args: { path: 'C:/Users/me/Notes/other.md', content: 'x' }, summary: 'Create the file C:/Users/me/Notes/other.md (1 bytes) in a folder you granted.' });
    const c = stage({ args: { path: 'C:/c.md', content: 'c' }, summary: 'Create the file C:/c.md (1 bytes) in a folder you granted.' });
    const d = stage({ args: { path: 'C:/d.md', content: 'd' }, summary: 'Create the file C:/d.md (1 bytes) in a folder you granted.' });
    const since = Date.now() - 1;
    const v1 = await post(`/approvals/${a}/approve`, undefined, as(phone));
    const old = await legacy('/api/approvals/confirm', { id: b });
    expect(v1.body.outcome).toBe('done');
    // the classic reply is unchanged: { ok, message } with the store's own words
    expect(old.body).toEqual({ ok: true, message: '[CONFIRMED write_file]\nok C:/Users/me/Notes/other.md' });
    expect([approvalStatus(a)?.status, approvalStatus(b)?.status]).toEqual(['done', 'done']);
    expect(ran).toEqual(['C:/Users/me/Notes/plan.md', 'C:/Users/me/Notes/other.md']);
    await post(`/approvals/${c}/deny`, {}, as(phone));
    expect((await legacy('/api/approvals/cancel', { id: d })).body).toEqual({ message: `cancelled "${d}" (write_file) — not executed` });
    expect([approvalStatus(c)?.status, approvalStatus(d)?.status]).toEqual(['cancelled', 'cancelled']);
    expect(audit.filter((x) => x.event !== 'dryrun')).toEqual([{ event: 'confirm', id: a }, { event: 'confirm', id: b }, { event: 'cancel', id: c }, { event: 'cancel', id: d }]);
    const lines = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.category === 'approvals' && e.ts >= since);
    expect(lines.map((e) => [e.msg, e.data.id, e.data.outcome, e.data.via])).toEqual([
      ['approve', a, 'done', 'api-v1'], ['approve', b, 'done', 'classic'], ['decline', c, 'declined', 'api-v1'], ['decline', d, 'declined', 'classic']]);
    // the classic app's second confirm says what the store says; v1 says 409
    expect((await legacy('/api/approvals/confirm', { id: a })).body).toEqual({ ok: false, message: `(no pending action with id "${a}" — it was already done)` });
  });
  it('a decision is a live event on /stream, with the approval as it now stands', async () => {
    setStreamDeps({ running: () => new Set(), pending: () => new Set() });
    const id = stage();
    const head = (appDb().prepare('SELECT COALESCE(MAX(seq), 0) s FROM events').get() as { s: number }).s;
    const ac = new AbortController();
    const res = await fetch(`${base}/stream?cursor=${head}`, { headers: as(phone), signal: ac.signal });
    const reader = res.body!.getReader();
    await post(`/approvals/${id}/approve`, undefined, as(phone));
    let text = '';
    const until = Date.now() + 5000;
    while (Date.now() < until && !/"state":"done"/.test(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    ac.abort();
    const change = text.split('\n').filter((l) => l.startsWith('data: ') && l.includes('"entity":"approval"')).map((l) => JSON.parse(l.slice(6))).pop();
    expect(change).toMatchObject({ entity: 'approval', id, op: 'upsert', data: { id, state: 'done' } });
  });
});
