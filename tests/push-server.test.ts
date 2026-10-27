// v2 build, slice P3: web push on the server. The wire (RFC 8291 against the RFC's own example, VAPID), which
// endpoints are accepted (SSRF), the routes with real auth and scopes, subscriptions going with a revoked device or
// session, the rules (each kind, one per thing, grouping, quiet hours, the hourly limit, phishing never, baseline),
// payloads that carry no personal content (over planted titles), 404/410 pruning and the receipts.
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createECDH, randomBytes } from 'node:crypto';
import { mkdtempSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetAppDb } from '../src/v2/db.js';
import { createV1 } from '../src/api/router.js';
import { v1Routes } from '../src/api/v1.js';
import { makeAuthenticate, createPairCode, redeemPairCode, revokeDevice } from '../src/api/auth.js';
import { configureSessions, issueSession, sessionValid, revokeAllSessions } from '../src/api/sessions.js';
import {
  encryptPayload, decryptPayload, checkEndpoint, checkKeys, vapidKeys, vapidJwt, verifyVapidJwt, resetVapid, sendPush, unb64u, b64u, type Transport,
} from '../src/v2/webpush.js';
import { saveSubscription, listSubscriptions, sentState, writePrefs, removeSubscriptionsOf, retryRows } from '../src/v2/push-store.js';
import { appDb } from '../src/v2/db.js';
import { pushTick, setPushDeps, resetPushTests, payloadFor, FAILING_REMOVE_MS } from '../src/v2/push.js';
import { createJob, claimTry, endTry, addTry, updateJob } from '../src/v2/jobs.js';
import { upsertItem, itemId } from '../src/v2/important.js';
import { readReceipts } from '../src/receipts.js';
import type { PendingView } from '../src/tools/approval.js';

const T0 = Date.UTC(2020, 0, 1); // subscriptions made "long ago", so things made in the test are new

// ── a browser: its keys, and a subscription for it ─────────────────────────────────────────────────────────────
function browser(endpoint = `https://fcm.googleapis.com/fcm/send/${randomBytes(6).toString('hex')}`) {
  const ua = createECDH('prime256v1'); ua.generateKeys();
  const auth = randomBytes(16);
  return { endpoint, p256dh: b64u(ua.getPublicKey()), auth: b64u(auth), priv: ua.getPrivateKey(), authBuf: auth };
}
type Seen = { url: string; headers: Record<string, string>; body: Buffer };
function fakeService(status: (url: string) => number = () => 201) {
  const seen: Seen[] = [];
  const t: Transport = async (url, init) => { seen.push({ url, headers: init.headers, body: init.body }); return { status: status(url), text: async () => '' }; };
  return { seen, t };
}

describe('the wire: RFC 8291 and VAPID', () => {
  it('encrypts the RFC 8291 Appendix A example byte for byte, and decrypts it back', () => {
    const out = encryptPayload(Buffer.from('When I grow up, I want to be a watermelon'),
      unb64u('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'), unb64u('BTBZMqHH6r4Tts7J_aSIgg'),
      { salt: unb64u('DGv6ra1nlYgDCS1FRnbzlw'), asPrivate: unb64u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw') });
    expect(b64u(out)).toBe('DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
    expect(decryptPayload(out, unb64u('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94'), unb64u('BTBZMqHH6r4Tts7J_aSIgg')).toString()).toBe('When I grow up, I want to be a watermelon');
  });
  it('a fresh message each time (new salt and key), and only the right browser can read it', () => {
    const b = browser(), other = browser();
    const a1 = encryptPayload(Buffer.from('{"kind":"test"}'), unb64u(b.p256dh), b.authBuf);
    const a2 = encryptPayload(Buffer.from('{"kind":"test"}'), unb64u(b.p256dh), b.authBuf);
    expect(a1.equals(a2)).toBe(false);
    expect(decryptPayload(a1, b.priv, b.authBuf).toString()).toBe('{"kind":"test"}');
    expect(() => decryptPayload(a1, other.priv, other.authBuf)).toThrow();
  });
  it('VAPID keys are made once, saved 0600 beside the data, and reused; the JWT is ES256 for the service origin', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mwa-vapid-'));
    const env = { ...process.env, MWA_PUSH_VAPID: join(dir, 'push-vapid.json') };
    resetVapid();
    const k = vapidKeys(env);
    expect(existsSync(env.MWA_PUSH_VAPID)).toBe(true);
    if (process.platform !== 'win32') expect(statSync(env.MWA_PUSH_VAPID).mode & 0o777).toBe(0o600);
    resetVapid();
    expect(vapidKeys(env)).toEqual(k);
    expect(unb64u(k.publicKey).length).toBe(65);
    const jwt = vapidJwt('https://fcm.googleapis.com', 'mailto:owner@example.com', k, Date.UTC(2026, 9, 27));
    expect(verifyVapidJwt(jwt, k.publicKey)).toEqual({ aud: 'https://fcm.googleapis.com', exp: Date.UTC(2026, 9, 27) / 1000 + 12 * 3600, sub: 'mailto:owner@example.com' });
    expect(verifyVapidJwt(jwt, browser().p256dh)).toBeNull();
    resetVapid();
  });
});

describe('which endpoints are accepted (SSRF)', () => {
  const test = { VITEST: '1' } as NodeJS.ProcessEnv;
  it('accepts https on the four push services', () => {
    for (const u of ['https://fcm.googleapis.com/fcm/send/abc', 'https://web.push.apple.com/QGx', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://wns2-par02p.notify.windows.com/w/?token=x']) {
      expect(checkEndpoint(u, test).ok, u).toBe(true);
    }
    expect(checkEndpoint('https://web.push.apple.com/x', test)).toMatchObject({ vendor: 'apple' });
  });
  it('refuses non-https, other hosts, look-alikes, ports, credentials and the local network', () => {
    for (const u of ['http://fcm.googleapis.com/fcm/send/abc', 'https://fcm.googleapis.com.evil.example/x', 'https://evil.example/fcm.googleapis.com', 'https://push.apple.com/x',
      'https://fcm.googleapis.com:8443/x', 'https://user:pw@fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://169.254.169.254/latest', 'http://localhost:7788/api/v1/jobs',
      'file:///etc/passwd', 'javascript:alert(1)', '', 'https://notify.windows.com/x', 'https://xnotify.windows.com/x']) {
      expect(checkEndpoint(u, test).ok, u).toBe(false);
    }
    expect(checkEndpoint(42, test).ok).toBe(false);
  });
  it('a local mock push service only in a test run, only at the named loopback origin', () => {
    const named = { VITEST: '1', MWA_PUSH_TEST_ORIGIN: 'http://127.0.0.1:9911' } as NodeJS.ProcessEnv;
    expect(checkEndpoint('http://127.0.0.1:9911/push/abc', named)).toMatchObject({ ok: true, vendor: 'test' });
    expect(checkEndpoint('http://127.0.0.1:9912/push/abc', named).ok).toBe(false);
    expect(checkEndpoint('http://127.0.0.1:9911/push/abc', { MWA_PUSH_TEST_ORIGIN: 'http://127.0.0.1:9911' } as NodeJS.ProcessEnv).ok).toBe(false); // not a test run
    expect(checkEndpoint('http://127.0.0.1:9911/push/abc', { NODE_ENV: 'test', MWA_PUSH_TEST_ORIGIN: 'http://127.0.0.1:9911' } as NodeJS.ProcessEnv).ok).toBe(true);
    expect(checkEndpoint('http://10.0.0.5:9911/x', { VITEST: '1', MWA_PUSH_TEST_ORIGIN: 'http://10.0.0.5:9911' } as NodeJS.ProcessEnv).ok).toBe(false); // never off loopback
  });
  it('keys must be a real P-256 point and a 16-byte secret', () => {
    const b = browser();
    expect(checkKeys(b.p256dh, b.auth)).not.toBeNull();
    expect(checkKeys(b.p256dh, b64u(randomBytes(8)))).toBeNull();
    expect(checkKeys(b64u(Buffer.concat([Buffer.from([4]), randomBytes(64)])), b.auth)).toBeNull(); // not on the curve
    expect(checkKeys('not base64!', b.auth)).toBeNull();
  });
  it('a send re-checks the endpoint: a stored foreign address is never contacted', async () => {
    const s = fakeService();
    const b = browser('https://evil.example/x');
    const r = await sendPush(b, payloadFor('test', null), {}, s.t, { VITEST: '1' } as NodeJS.ProcessEnv);
    expect(r.outcome).toBe('failed');
    expect(s.seen).toHaveLength(0);
  });
});

// ── the routes, with real auth ───────────────────────────────────────────────────────────────────────────────────
describe('the routes: auth, scopes, ownership, revocation', () => {
  let server: Server, base = '';
  let n = 0;
  const key = () => ({ 'idempotency-key': `push-key-${++n}-xxxx` });
  beforeAll(async () => {
    resetAppDb(':memory:');
    configureSessions({ password: 'pw-for-push-tests' });
    process.env.MWA_RECEIPTS_DIR = mkdtempSync(join(tmpdir(), 'mwa-push-rc-'));
    const v1 = createV1(v1Routes(), { authenticate: makeAuthenticate({ passwordSet: true, sessionValid }), sameOrigin: () => true });
    server = createServer(async (req, res) => { if (!(await v1(req, res))) { res.writeHead(404); res.end(); } });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  });
  afterAll(() => { server?.close(); configureSessions({ password: '' }); setPushDeps(null); delete process.env.MWA_RECEIPTS_DIR; });
  const device = (scopes: ('read' | 'act' | 'approve' | 'admin')[] = ['read', 'act', 'approve']) => {
    const { code } = createPairCode('t', scopes);
    const d = redeemPairCode(code, 'Pixel', 'android')!;
    return { id: d.deviceId, h: { authorization: `Bearer ${d.token}` } };
  };
  const session = () => { const s = issueSession(); return { id: s.id, h: { cookie: `mwa_session=${s.token}` } }; };
  const sub = (h: Record<string, string>, b = browser()) => fetch(`${base}/push/subscriptions`, { method: 'POST', headers: { ...h, ...key(), 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: b.endpoint, keys: { p256dh: b.p256dh, auth: b.auth }, platform: 'android' }) });

  it('nobody signed in: 401; a read-only device can list but not subscribe (403)', async () => {
    expect((await fetch(`${base}/push/subscriptions`)).status).toBe(401);
    const ro = device(['read']);
    expect((await fetch(`${base}/push/subscriptions`, { headers: ro.h })).status).toBe(200);
    expect((await sub(ro.h)).status).toBe(403);
    expect((await fetch(`${base}/push/test`, { method: 'POST', headers: { ...ro.h, ...key() } })).status).toBe(403);
  });
  it('refuses non-https and foreign endpoints, and malformed keys', async () => {
    const d = device();
    for (const endpoint of ['http://fcm.googleapis.com/fcm/send/x', 'https://evil.example/push', 'https://169.254.169.254/latest/meta-data']) {
      const r = await sub(d.h, { ...browser(), endpoint });
      expect(r.status, endpoint).toBe(400);
      expect((await r.json()).error.code).toBe('bad_endpoint');
    }
    const r = await fetch(`${base}/push/subscriptions`, { method: 'POST', headers: { ...d.h, ...key(), 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/y', keys: { p256dh: 'AAAA', auth: 'BBBB' } }) });
    expect((await r.json()).error.code).toBe('bad_keys');
    expect(listSubscriptions(`device:${d.id}`)).toHaveLength(0);
  });
  it('a device sees and removes only its own; an admin session sees all; the endpoint only to its owner', async () => {
    const a = device(), b = device(), admin = session();
    const ra = await sub(a.h); expect(ra.status).toBe(201);
    const sa = (await ra.json()).subscription;
    expect(sa).toMatchObject({ mine: true, vendor: 'google', owner: 'device' });
    expect(sa.endpoint).toMatch(/^https:\/\/fcm\.googleapis\.com/);
    const sb = (await (await sub(b.h)).json()).subscription;
    const la = await (await fetch(`${base}/push/subscriptions`, { headers: a.h })).json();
    expect(la.subscriptions.map((s: { id: string }) => s.id)).toEqual([sa.id]);
    expect(unb64u(la.vapidPublicKey).length).toBe(65);
    const all = await (await fetch(`${base}/push/subscriptions`, { headers: admin.h })).json();
    expect(all.subscriptions.length).toBeGreaterThanOrEqual(2);
    expect(all.subscriptions.every((s: { endpoint?: string; mine: boolean }) => !s.mine && s.endpoint === undefined)).toBe(true);
    // b cannot remove a's (looks like no such thing); a can; the admin can remove b's
    expect((await fetch(`${base}/push/subscriptions/${sa.id}`, { method: 'DELETE', headers: { ...b.h, ...key() } })).status).toBe(404);
    expect((await fetch(`${base}/push/subscriptions/${sa.id}`, { method: 'DELETE', headers: { ...a.h, ...key() } })).status).toBe(200);
    expect((await fetch(`${base}/push/subscriptions/${sb.id}`, { method: 'DELETE', headers: { ...admin.h, ...key() } })).status).toBe(200);
  });
  it('revoking a device removes its subscriptions; signing a session out, and "sign out everywhere", remove theirs', async () => {
    const d = device(), s1 = session(), s2 = session();
    await sub(d.h); await sub(s1.h); await sub(s2.h);
    expect(listSubscriptions(`device:${d.id}`)).toHaveLength(1);
    revokeDevice(d.id);
    expect(listSubscriptions(`device:${d.id}`)).toHaveLength(0);
    // this browser signs out
    expect((await fetch(`${base}/session`, { method: 'DELETE', headers: { ...s1.h, ...key() } })).status).toBe(200);
    expect(listSubscriptions(`session:${s1.id}`)).toHaveLength(0);
    expect(listSubscriptions(`session:${s2.id}`)).toHaveLength(1);
    const other = device(); await sub(other.h);
    revokeAllSessions();
    expect(listSubscriptions().filter((x) => x.owner.startsWith('session:'))).toHaveLength(0);
    expect(listSubscriptions(`device:${other.id}`)).toHaveLength(1); // devices are removed one by one, not here
  });
  it('a re-subscription (pushsubscriptionchange) replaces the old endpoint of the same caller only', async () => {
    const d = device(), e = device();
    const old = browser(), fresh = browser(), notMine = browser();
    await sub(d.h, old); await sub(e.h, notMine);
    const r = await fetch(`${base}/push/subscriptions`, { method: 'POST', headers: { ...d.h, ...key(), 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: fresh.endpoint, keys: { p256dh: fresh.p256dh, auth: fresh.auth }, replaces: old.endpoint }) });
    expect(r.status).toBe(201);
    expect(listSubscriptions(`device:${d.id}`).map((s) => s.endpoint)).toEqual([fresh.endpoint]);
    await fetch(`${base}/push/subscriptions`, { method: 'POST', headers: { ...d.h, ...key(), 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: browser().endpoint, keys: { p256dh: fresh.p256dh, auth: fresh.auth }, replaces: notMine.endpoint }) });
    expect(listSubscriptions(`device:${e.id}`)).toHaveLength(1); // another caller's is never touched
  });
  it('POST /push/test: sent at once to the caller\'s own subscriptions, honest words, limited to 5 per 10 minutes', async () => {
    resetPushTests();
    const svc = fakeService();
    setPushDeps({ transport: svc.t, quiet: () => true }); // quiet hours do not stop a test the person asked for
    const d = device();
    const nosub = await fetch(`${base}/push/test`, { method: 'POST', headers: { ...d.h, ...key() } });
    expect(nosub.status).toBe(409);
    await sub(d.h);
    const r = await (await fetch(`${base}/push/test`, { method: 'POST', headers: { ...d.h, ...key() } })).json();
    expect(r).toMatchObject({ accepted: 1, gone: 0, failed: 0 });
    expect(r.message).toMatch(/Google’s push service/);
    expect(r.message).not.toMatch(/delivered/i);
    expect(svc.seen).toHaveLength(1);
    expect(svc.seen[0].headers.authorization).toMatch(/^vapid t=.+, k=/);
    expect(svc.seen[0].headers['content-encoding']).toBe('aes128gcm');
    for (let i = 0; i < 4; i++) await fetch(`${base}/push/test`, { method: 'POST', headers: { ...d.h, ...key() } });
    expect((await fetch(`${base}/push/test`, { method: 'POST', headers: { ...d.h, ...key() } })).status).toBe(429);
    expect(readReceipts().some((x) => x.channel === 'push' && x.job.startsWith('push-tes') && x.status === 'accepted')).toBe(true);
    setPushDeps(null);
  });
  it('PATCH /push/settings: kinds, the morning time and quiet hours are checked before anything is saved', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mwa-push-cfg-'));
    process.env.MWA_CONFIG_PATH = join(dir, 'mwa.config.json');
    try {
      const d = session(); // an admin (the password session): these are shared settings
      const patch = (b: unknown) => fetch(`${base}/push/settings`, { method: 'PATCH', headers: { ...d.h, ...key(), 'content-type': 'application/json' }, body: JSON.stringify(b) });
      expect((await (await patch({ morning: '04:00' })).json()).error.code).toBe('bad_time');
      expect((await (await patch({ kinds: { spam: true } })).json()).error.code).toBe('bad_kinds');
      expect((await (await patch({ quietHours: '22:00-21:00' })).json()).error.code).toBe('bad_quiet'); // 23 hours
      expect((await (await patch({ morning: '08:15', quietHours: 'nonsense' })).json()).error.code).toBe('bad_quiet');
      expect((await (await fetch(`${base}/push/subscriptions`, { headers: d.h })).json()).settings.morning).toBe('07:30'); // nothing saved
      const ok = await (await patch({ morning: '08:15', kinds: { result: false }, quietHours: '22:00-07:00' })).json();
      expect(ok).toMatchObject({ morning: '08:15', kinds: { approval: true, waiting: true, result: false, morning: true }, quietHours: { value: '22:00-07:00', fixed: false } });
      expect(JSON.parse(readFileSync(process.env.MWA_CONFIG_PATH, 'utf8')).notify.quietHours).toBe('22:00-07:00');
      expect((await (await patch({ quietHours: null })).json()).quietHours.value).toBeNull();
    } finally { delete process.env.MWA_CONFIG_PATH; }
  });
});

// ── the rules ──────────────────────────────────────────────────────────────────────────────────────────────────
const PLANTED = ['PLANTED-JOB-TITLE Dr Smith biopsy', 'PLANTED-SUMMARY wire $9,000 to account', 'PLANTED-RESULT diagnosis', 'Coach Ellen', 'ellen@example.com'];

describe('what notifies, and what is sent', () => {
  let svc: ReturnType<typeof fakeService>;
  let b: ReturnType<typeof browser>;
  let approvals: PendingView[];
  let quiet = false;
  let news = false;
  let now = Date.now();
  let perHour = 6;
  const approval = (id: string, summary = PLANTED[1], over: Partial<PendingView> = {}): PendingView => ({ id, tool: 'send_email', summary, expiresInSec: 3600, expiresAt: Date.now() + 3_600_000, tainted: false, readLocal: false, kind: 'tool', createdAt: Date.now(), ...over });
  const payloads = () => svc.seen.map((s) => JSON.parse(decryptPayload(s.body, b.priv, b.authBuf).toString('utf8')));
  beforeEach(() => {
    resetAppDb(':memory:');
    process.env.MWA_RECEIPTS_DIR = mkdtempSync(join(tmpdir(), 'mwa-push-rules-'));
    svc = fakeService(); b = browser(); approvals = []; quiet = false; news = false; now = Date.now(); perHour = 6;
    setPushDeps({ transport: svc.t, pendingApprovals: () => approvals, quiet: () => quiet, morningNews: async () => news, now: () => now, tz: () => 'UTC', perHour: () => perHour });
    writePrefs({ kinds: { morning: false } }); // the morning has its own test
    saveSubscription({ endpoint: b.endpoint, p256dh: b.p256dh, auth: b.auth, owner: 'local', vendor: 'google' }, T0);
  });
  afterEach(() => { setPushDeps(null); delete process.env.MWA_RECEIPTS_DIR; });

  const doneJob = (title = PLANTED[0]) => {
    const j = createJob({ kind: 'background', title, request: title }, { trigger: 'first' });
    claimTry(j.try!.id, {}); endTry(j.try!.id, { reason: 'done', outcome: 'changed', summary: PLANTED[2] });
    return j;
  };

  it('an approval waiting: one push {kind, id, tag}, nothing else — and never again for the same approval', async () => {
    approvals = [approval('ap_1')];
    const r = await pushTick();
    expect(r.sent.map((s) => s.kind)).toEqual(['approval']);
    expect(payloads()).toEqual([{ kind: 'approval', id: 'ap_1', tag: 'mwa-approval' }]);
    expect(svc.seen[0].headers.topic).toBe('approval');
    expect(svc.seen[0].headers.urgency).toBe('high');
    await pushTick();
    expect(svc.seen).toHaveLength(1);
    expect(sentState('approval:ap_1')).toBe('sent');
  });

  it('payloads carry no personal content: planted titles, summaries and senders appear nowhere in what leaves', async () => {
    approvals = [approval('ap_2', `${PLANTED[1]} from ${PLANTED[3]} <${PLANTED[4]}>`)];
    doneJob();
    const w = createJob({ kind: 'background', title: PLANTED[0], capUsd: 0.5 }, { trigger: 'first' });
    claimTry(w.try!.id, {}); endTry(w.try!.id, { reason: 'budget', outcome: 'changed', capHit: 'usd', summary: PLANTED[2], progress: { done: 3, total: 10, unit: 'pages' } });
    await pushTick();
    expect(svc.seen.length).toBe(3);
    for (const s of svc.seen) {
      const clear = decryptPayload(s.body, b.priv, b.authBuf).toString('utf8');
      expect(Object.keys(JSON.parse(clear)).sort()).toEqual(['id', 'kind', 'tag']);
      const everything = `${s.url}\n${JSON.stringify(s.headers)}\n${clear}\n${s.body.toString('latin1')}`;
      for (const p of PLANTED) expect(everything, p).not.toContain(p);
    }
  });

  it('a job entering "waiting for you" (its dollar limit) and a result ready each notify once, opening that job', async () => {
    const w = createJob({ kind: 'background', title: PLANTED[0], capUsd: 0.5 }, { trigger: 'first' });
    claimTry(w.try!.id, {}); endTry(w.try!.id, { reason: 'budget', outcome: 'changed', capHit: 'usd', summary: 'x' });
    const d = doneJob();
    await pushTick();
    expect(payloads()).toEqual([{ kind: 'waiting', id: w.job.id, tag: 'mwa-waiting' }, { kind: 'result', id: d.job.id, tag: 'mwa-result' }]);
    // opened: no longer "result ready"; nothing more
    updateJob(d.job.id, { seen_at: Date.now() + 1000 });
    await pushTick();
    expect(svc.seen).toHaveLength(2);
  });

  it('a repeating job: each new result is its own notification', async () => {
    const r = createJob({ kind: 'recurring', title: PLANTED[0], scheduleId: 'watch-1' });
    const t1 = addTry(r.job.id, { trigger: 'fire' });
    claimTry(t1.id, {}); endTry(t1.id, { reason: 'done', outcome: 'changed', summary: 'Price 10' });
    await pushTick();
    const t2 = addTry(r.job.id, { trigger: 'fire' });
    claimTry(t2.id, {}); endTry(t2.id, { reason: 'done', outcome: 'changed', summary: 'Price 12', endedAt: Date.now() + 5 });
    await pushTick();
    expect(payloads()).toEqual([{ kind: 'result', id: r.job.id, tag: 'mwa-result' }, { kind: 'result', id: r.job.id, tag: 'mwa-result' }]);
    // a quiet fire (nothing new) is not news
    const t3 = addTry(r.job.id, { trigger: 'fire' });
    claimTry(t3.id, {}); endTry(t3.id, { reason: 'done', outcome: 'unchanged', summary: 'same', delivered: false, endedAt: Date.now() + 10 });
    await pushTick();
    expect(svc.seen).toHaveLength(2);
  });

  it('a job waiting on an approval is the approval\'s notification, not a second one', async () => {
    const j = createJob({ kind: 'background', title: PLANTED[0] }, { trigger: 'first' });
    claimTry(j.try!.id, {}); endTry(j.try!.id, { reason: 'done', outcome: 'changed', staged: ['ap_9'], summary: 'staged' });
    approvals = [approval('ap_9')];
    await pushTick();
    expect(payloads().map((p) => p.kind)).toEqual(['approval']);
  });

  it('several new things of a kind are ONE notification (no id: it opens the list)', async () => {
    approvals = [approval('ap_a'), approval('ap_b'), approval('ap_c')];
    await pushTick();
    expect(payloads()).toEqual([{ kind: 'approval', id: null, tag: 'mwa-approval' }]);
    expect(['ap_a', 'ap_b', 'ap_c'].map((x) => sentState(`approval:${x}`))).toEqual(['sent', 'sent', 'sent']);
  });

  it('never for a phishing-flagged approval', async () => {
    upsertItem({ source: 'approval', dedupeKey: 'approval:ap_phish', ts: Date.now(), title: 'Pay this invoice', trust: 'untrusted', caution: 'phishing' }, 'UTC');
    expect(itemId('approval:ap_phish')).toBeTruthy();
    approvals = [approval('ap_phish')];
    await pushTick(); await pushTick();
    expect(svc.seen).toHaveLength(0);
  });

  it('what was there before notifications were turned on is not announced', async () => {
    approvals = [approval('ap_old', 'x', { createdAt: T0 - 1000 })];
    const r = await pushTick();
    expect(r.baseline).toEqual(['approval:ap_old']);
    expect(svc.seen).toHaveLength(0);
  });

  it('quiet hours hold it (receipt "held"); afterwards what still needs the person is sent, the rest let go', async () => {
    quiet = true;
    approvals = [approval('ap_q1'), approval('ap_q2')];
    let r = await pushTick();
    expect(r.held.sort()).toEqual(['approval:ap_q1', 'approval:ap_q2']);
    expect(svc.seen).toHaveLength(0);
    await pushTick(); // still quiet: one "held" receipt each, not one per tick
    expect(readReceipts().filter((x) => x.channel === 'push' && x.status === 'held')).toHaveLength(2);
    quiet = false;
    approvals = [approval('ap_q2')]; // ap_q1 was answered overnight
    r = await pushTick();
    expect(payloads()).toEqual([{ kind: 'approval', id: 'ap_q2', tag: 'mwa-approval' }]);
    expect(sentState('approval:ap_q1')).toBe('skipped');
    const rc = readReceipts().filter((x) => x.channel === 'push');
    expect(rc.find((x) => x.fire === 'approval:ap_q1' && x.status === 'not-sent')).toBeTruthy();
    expect(rc.find((x) => x.fire === 'approval:ap_q2' && x.status === 'accepted')).toBeTruthy();
  });

  it('at most N an hour: the rest waits for the next hour', async () => {
    perHour = 2;
    approvals = [approval('ap_r')];
    const w = createJob({ kind: 'background', title: 't', capUsd: 0.5 }, { trigger: 'first' });
    claimTry(w.try!.id, {}); endTry(w.try!.id, { reason: 'budget', outcome: 'changed', capHit: 'usd', summary: 'x' });
    const d = doneJob();
    const r = await pushTick();
    expect(r.sent.map((s) => s.kind)).toEqual(['approval', 'waiting']);
    expect(r.held).toEqual([`result:${d.job.id}:${d.try!.id}`]);
    now += 61 * 60_000;
    await pushTick();
    expect(payloads().map((p) => p.kind)).toEqual(['approval', 'waiting', 'result']);
  });

  it('a kind turned off is not sent', async () => {
    writePrefs({ kinds: { approval: false } });
    approvals = [approval('ap_off')];
    await pushTick();
    expect(svc.seen).toHaveLength(0);
  });

  it('the morning check-in: once, at the person\'s time, only with something to say', async () => {
    writePrefs({ kinds: { morning: true }, morning: '07:30' });
    now = Date.UTC(2026, 10, 9, 7, 0); // before the time
    news = true;
    await pushTick();
    expect(svc.seen).toHaveLength(0);
    now = Date.UTC(2026, 10, 9, 7, 45);
    await pushTick(); await pushTick();
    expect(payloads()).toEqual([{ kind: 'morning', id: null, tag: 'mwa-morning' }]);
    // the next day, nothing to say: nothing sent, and it is not asked again that day
    now = Date.UTC(2026, 10, 10, 7, 31); news = false;
    const r = await pushTick();
    expect(r.skipped).toEqual(['morning:2026-11-10']);
    news = true; await pushTick();
    expect(svc.seen).toHaveLength(1);
    // after noon: no check-in
    now = Date.UTC(2026, 10, 11, 12, 5);
    await pushTick();
    expect(svc.seen).toHaveLength(1);
  });

  it('notifications turned on after this morning\'s time: today\'s check-in is not announced, and Today is not built', async () => {
    writePrefs({ kinds: { morning: true }, morning: '07:30' });
    removeSubscriptionsOf('local');
    now = Date.UTC(2026, 10, 9, 9, 0);
    saveSubscription({ endpoint: b.endpoint, p256dh: b.p256dh, auth: b.auth, owner: 'local', vendor: 'google' }, Date.UTC(2026, 10, 9, 8, 55));
    let built = 0;
    setPushDeps({ transport: svc.t, pendingApprovals: () => [], quiet: () => false, now: () => now, tz: () => 'UTC', morningNews: async () => { built++; return true; } });
    const r = await pushTick(); await pushTick();
    expect(r.baseline).toEqual(['morning:2026-11-09']);
    expect(built).toBe(0);
    expect(svc.seen).toHaveLength(0);
  });

  it('404/410 from the push service: the subscription is removed and the receipt says dropped', async () => {
    svc = fakeService(() => 410);
    setPushDeps({ transport: svc.t, pendingApprovals: () => approvals, quiet: () => false, now: () => now, tz: () => 'UTC', morningNews: async () => false });
    approvals = [approval('ap_gone')];
    await pushTick();
    expect(listSubscriptions()).toHaveLength(0);
    expect(readReceipts().find((x) => x.fire === 'approval:ap_gone')).toMatchObject({ channel: 'push', status: 'dropped' });
  });

  it('review fix 9: "try later" (429/5xx) is retried for THAT device with backoff; the other device is not sent it twice', async () => {
    const other = browser();
    saveSubscription({ endpoint: other.endpoint, p256dh: other.p256dh, auth: other.auth, owner: 'local', vendor: 'google' }, T0);
    let down = true;
    svc = fakeService((url) => (url === b.endpoint && down ? 503 : 201));
    setPushDeps({ transport: svc.t, pendingApprovals: () => approvals, quiet: () => false, now: () => now, tz: () => 'UTC', morningNews: async () => false });
    approvals = [approval('ap_retry')];
    await pushTick();
    expect(sentState('approval:ap_retry')).toBe('sent');
    expect(svc.seen.map((x) => x.url).sort()).toEqual([b.endpoint, other.endpoint].sort());
    expect(retryRows().map((r) => [r.sub_id === listSubscriptions().find((x) => x.endpoint === b.endpoint)!.id, r.key, r.tries])).toEqual([[true, 'approval:ap_retry', 1]]);
    // not due yet: nothing
    now += 10_000; await pushTick();
    expect(svc.seen).toHaveLength(2);
    // due (30 s), still down: the delay doubles
    now += 25_000; let r = await pushTick();
    expect(r.retried.map((x) => x.outcome)).toEqual(['retry']);
    expect(retryRows()[0].tries).toBe(2);
    expect(retryRows()[0].next_at - now).toBe(60_000);
    // up again: this device gets it; the other one never got a second copy
    down = false; now += 61_000; r = await pushTick();
    expect(r.retried.map((x) => x.outcome)).toEqual(['accepted']);
    expect(svc.seen.filter((x) => x.url === other.endpoint)).toHaveLength(1);
    expect(svc.seen.filter((x) => x.url === b.endpoint)).toHaveLength(3);
    const last = svc.seen.filter((x) => x.url === b.endpoint).pop()!;
    expect(JSON.parse(decryptPayload(last.body, b.priv, b.authBuf).toString('utf8'))).toEqual({ kind: 'approval', id: 'ap_retry', tag: 'mwa-approval' });
    expect(retryRows()).toHaveLength(0);
  });

  it('review fix 9: a retry for an item answered meanwhile is dropped; a device failing for days is removed', async () => {
    svc = fakeService(() => 503);
    setPushDeps({ transport: svc.t, pendingApprovals: () => approvals, quiet: () => false, now: () => now, tz: () => 'UTC', morningNews: async () => false });
    approvals = [approval('ap_gone_meanwhile')];
    await pushTick();
    expect(retryRows()).toHaveLength(1);
    approvals = []; // answered on the computer
    now += 31_000; await pushTick();
    expect(retryRows()).toHaveLength(0);
    expect(svc.seen).toHaveLength(1);
    // the subscription has been failing since the first try: after FAILING_REMOVE_MS it goes
    const s = listSubscriptions()[0];
    expect(s.failing_since).not.toBeNull();
    appDb().prepare('UPDATE push_subs SET failing_since = ? WHERE id = ?').run(Date.now() - FAILING_REMOVE_MS - 1000, s.id);
    approvals = [approval('ap_next')];
    const r = await pushTick();
    expect(r.note).toBe('no subscriptions');
    expect(listSubscriptions()).toHaveLength(0);
  });

  it('receipts: "accepted" (the service took it, not proof it was shown), never "sent"/"delivered"', async () => {
    approvals = [approval('ap_rc')];
    await pushTick();
    const r = readReceipts().filter((x) => x.channel === 'push');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ status: 'accepted', fire: 'approval:ap_rc' });
    expect(r[0].detail).toMatch(/accepted by Google’s push service for 1 of 1 device/);
  });

  it('a revoked owner gets nothing, and its subscriptions are cleaned up at send time', async () => {
    removeSubscriptionsOf('local');
    saveSubscription({ endpoint: b.endpoint, p256dh: b.p256dh, auth: b.auth, owner: 'device:dev_gone', vendor: 'google' }, T0);
    approvals = [approval('ap_dead')];
    const r = await pushTick();
    expect(r.note).toBe('no subscriptions');
    expect(svc.seen).toHaveLength(0);
    expect(listSubscriptions()).toHaveLength(0);
  });
});
