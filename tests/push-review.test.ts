// P3 security review (2026-10-27): one test or more per fix. Fix 1 (phishing from the source) is
// tests/push-phishing-source.test.ts; fix 9 (per-device retries with backoff) is in tests/push-server.test.ts; fix 11
// (a tap from v1) also in tests/pwa-push-sw.test.ts.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createECDH, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetAppDb, appDb } from '../src/v2/db.js';
import { createV1 } from '../src/api/router.js';
import { v1Routes } from '../src/api/v1.js';
import { makeAuthenticate, createPairCode, redeemPairCode } from '../src/api/auth.js';
import { configureSessions, issueSession, sessionValid } from '../src/api/sessions.js';
import { inQuietWindow, parseQuietHours, isQuietNow } from '../src/quiet.js';
import { pushSubject, DEFAULT_PUSH_SUBJECT, vapidKeys, vapidReset, resetVapid, sendPush, verifyVapidJwt, readCapped, b64u } from '../src/v2/webpush.js';
import { saveSubscription, listSubscriptions, prunePushRecords, sentState, setLocalOwnerValid, MAX_SUBS, MAX_SUBS_PER_OWNER, PushStoreError } from '../src/v2/push-store.js';
import { pushTick, setPushDeps, payloadFor, liveSubscriptions, resetPushPrune } from '../src/v2/push.js';
import { createJob, claimTry, endTry, addTry } from '../src/v2/jobs.js';
import { readReceipts, jobDeliveries, deliveryLine, recordReceipt } from '../src/receipts.js';
import { chooseUi, uiToRemember } from '../web/src/v2/choose';
import { pushState, pushWords, type PushFacts } from '../web/src/pwa/push';

const T0 = Date.UTC(2020, 0, 1);
function browser(endpoint = `https://fcm.googleapis.com/fcm/send/${randomBytes(6).toString('hex')}`) {
  const ua = createECDH('prime256v1'); ua.generateKeys();
  return { endpoint, p256dh: b64u(ua.getPublicKey()), auth: b64u(randomBytes(16)) };
}

// ── 2. quiet hours on the PERSON's clock ────────────────────────────────────────────────────────────────────────
describe('fix 2: quiet hours in the person\'s zone, not the server\'s', () => {
  const w = parseQuietHours('22:00-07:00');
  it('a server in UTC (Railway) and a person in New York: 19:00 there is not quiet, 23:00 there is', () => {
    expect(inQuietWindow(w, new Date('2026-10-27T19:00:00-04:00'), 'America/New_York')).toBe(false); // 23:00 UTC
    expect(inQuietWindow(w, new Date('2026-10-27T23:00:00-04:00'), 'America/New_York')).toBe(true); // 03:00 UTC
    expect(inQuietWindow(w, new Date('2026-10-28T06:30:00-04:00'), 'America/New_York')).toBe(true);
    expect(inQuietWindow(w, new Date('2026-10-28T07:30:00-04:00'), 'America/New_York')).toBe(false);
    // the same instants on the UTC clock would say the opposite (what the review found)
    expect(inQuietWindow(w, new Date('2026-10-27T19:00:00-04:00'), 'UTC')).toBe(true);
    expect(inQuietWindow(w, new Date('2026-10-28T06:30:00-04:00'), 'UTC')).toBe(false); // 10:30 UTC
  });
  it('isQuietNow (Telegram) uses MWA_TZ, the calendar\'s zone, too', () => {
    const prev = { tz: process.env.MWA_TZ, q: process.env.MWA_QUIET_HOURS };
    process.env.MWA_TZ = 'America/New_York'; process.env.MWA_QUIET_HOURS = '22:00-07:00';
    try {
      expect(isQuietNow(new Date('2026-10-27T19:00:00-04:00'))).toBe(false);
      expect(isQuietNow(new Date('2026-10-27T23:00:00-04:00'))).toBe(true);
    } finally {
      if (prev.tz === undefined) delete process.env.MWA_TZ; else process.env.MWA_TZ = prev.tz;
      if (prev.q === undefined) delete process.env.MWA_QUIET_HOURS; else process.env.MWA_QUIET_HOURS = prev.q;
    }
  });
  it('the notifier holds at 23:00 New York and sends at 19:00 New York, whatever the server clock', async () => {
    resetAppDb(':memory:');
    process.env.MWA_RECEIPTS_DIR = mkdtempSync(join(tmpdir(), 'mwa-rv-q-'));
    const prev = process.env.MWA_QUIET_HOURS; process.env.MWA_QUIET_HOURS = '22:00-07:00';
    try {
      const b = browser();
      saveSubscription({ endpoint: b.endpoint, p256dh: b.p256dh, auth: b.auth, owner: 'local', vendor: 'google' }, T0);
      let now = Date.parse('2026-10-27T23:00:00-04:00');
      const seen: string[] = [];
      const ap = (id: string) => ({ id, tool: 't', summary: 's', expiresInSec: 9, expiresAt: Date.now() + 9e6, tainted: false, readLocal: false, kind: 'tool' as const, createdAt: Date.now() });
      let approvals = [ap('q_late')];
      setPushDeps({ transport: async (u) => { seen.push(u); return { status: 201 }; }, tz: () => 'America/New_York', now: () => now, pendingApprovals: () => approvals, morningNews: async () => false }); // default quiet
      let r = await pushTick();
      expect(r.held).toEqual(['approval:q_late']);
      now = Date.parse('2026-10-28T19:00:00-04:00'); approvals = [ap('q_late'), ap('q_evening')];
      r = await pushTick();
      expect(r.sent.map((x) => x.keys.sort())).toEqual([['approval:q_evening', 'approval:q_late']]);
      expect(seen).toHaveLength(1);
    } finally {
      if (prev === undefined) delete process.env.MWA_QUIET_HOURS; else process.env.MWA_QUIET_HOURS = prev;
      setPushDeps(null); delete process.env.MWA_RECEIPTS_DIR;
    }
  });
});

// ── routes: 3, 6, 7 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('the routes', () => {
  let server: Server, base = '';
  let n = 0;
  const key = () => ({ 'idempotency-key': `rv-key-${++n}-xxxx`, 'content-type': 'application/json' });
  beforeAll(async () => {
    resetAppDb(':memory:');
    configureSessions({ password: 'pw-for-review' });
    const v1 = createV1(v1Routes(), { authenticate: makeAuthenticate({ passwordSet: true, sessionValid }), sameOrigin: () => true });
    server = createServer(async (req, res) => { if (!(await v1(req, res))) { res.writeHead(404); res.end(); } });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  });
  afterAll(() => { server?.close(); configureSessions({ password: '' }); });
  const device = () => { const { code } = createPairCode('t', ['read', 'act', 'approve']); const d = redeemPairCode(code, 'Pixel')!; return { id: d.deviceId, h: { authorization: `Bearer ${d.token}` } }; };
  const admin = () => { const s = issueSession(); return { h: { cookie: `mwa_session=${s.token}` } }; };
  const post = (h: Record<string, string>, b: ReturnType<typeof browser>) => fetch(`${base}/push/subscriptions`, { method: 'POST', headers: { ...h, ...key() }, body: JSON.stringify({ endpoint: b.endpoint, keys: { p256dh: b.p256dh, auth: b.auth } }) });

  it('fix 3: the shared settings (kinds, morning, quiet hours) need admin; a phone still turns its own notifications on and off', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mwa-rv-cfg-'));
    process.env.MWA_CONFIG_PATH = join(dir, 'mwa.config.json');
    try {
      const phone = device();
      const r = await fetch(`${base}/push/settings`, { method: 'PATCH', headers: { ...phone.h, ...key() }, body: JSON.stringify({ quietHours: '09:00-10:00', kinds: { approval: false } }) });
      expect(r.status).toBe(403);
      expect(existsSync(process.env.MWA_CONFIG_PATH)).toBe(false); // nothing written
      const ok = await fetch(`${base}/push/settings`, { method: 'PATCH', headers: { ...admin().h, ...key() }, body: JSON.stringify({ kinds: { approval: false } }) });
      expect(ok.status).toBe(200);
      const b = browser();
      const s = await post(phone.h, b);
      expect(s.status).toBe(201);
      const id = (await s.json()).subscription.id;
      expect((await fetch(`${base}/push/subscriptions/${id}`, { method: 'DELETE', headers: { ...phone.h, ...key() } })).status).toBe(200);
      // the phone still reads them (Settings shows them read-only)
      expect((await (await fetch(`${base}/push/subscriptions`, { headers: phone.h })).json()).settings.kinds.approval).toBe(false);
    } finally { delete process.env.MWA_CONFIG_PATH; }
  });

  it('fix 6: another device cannot take an endpoint (409); the same device can refresh it; a dead owner\'s is replaced', async () => {
    const a = device(), b = device();
    const e = browser();
    const ra = await post(a.h, e); expect(ra.status).toBe(201);
    const ida = (await ra.json()).subscription.id;
    const take = await post(b.h, { ...browser(), endpoint: e.endpoint });
    expect(take.status).toBe(409);
    expect((await take.json()).error.code).toBe('endpoint_taken');
    expect(listSubscriptions(`device:${a.id}`).map((s) => s.id)).toEqual([ida]);
    expect(listSubscriptions(`device:${b.id}`)).toHaveLength(0);
    // the same keys from b: still refused (it is not b's)
    expect((await post(b.h, e)).status).toBe(409);
    // a re-subscribe from a itself (new keys) refreshes its own row
    const again = await post(a.h, { ...browser(), endpoint: e.endpoint });
    expect(again.status).toBe(201);
    expect((await again.json()).subscription.id).toBe(ida);
    // a revoked: its endpoint can be taken by whoever holds it now
    appDb().prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(Date.now(), a.id);
    expect((await post(b.h, e)).status).toBe(201);
  });

  it('fix 7: a corrupt key file is moved aside and reported (log, keysReset); old subscriptions stop; never silent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mwa-rv-vapid-'));
    const prev = process.env.MWA_PUSH_VAPID;
    process.env.MWA_PUSH_VAPID = join(dir, 'push-vapid.json');
    resetVapid();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const k1 = vapidKeys();
      const phone = device();
      const b = browser();
      expect((await post(phone.h, b)).status).toBe(201);
      expect(listSubscriptions(`device:${phone.id}`)[0].vapid).toBe(k1.publicKey);
      writeFileSync(process.env.MWA_PUSH_VAPID, '{ this is not json');
      resetVapid(); // a restart
      const list = await (await fetch(`${base}/push/subscriptions`, { headers: phone.h })).json();
      expect(list.keysReset).toEqual(expect.any(Number));
      expect(list.vapidPublicKey).not.toBe(k1.publicKey);
      expect(err.mock.calls.flat().join(' ')).toMatch(/could not be read as keys .* every phone has to turn notifications on again/);
      expect(readdirSync(dir).some((f) => f.startsWith('push-vapid.json.corrupt-'))).toBe(true); // kept, not overwritten
      expect(vapidReset()).not.toBeNull();
      // the subscription made with the old key is never sent to again
      liveSubscriptions();
      expect(listSubscriptions(`device:${phone.id}`)).toHaveLength(0);
    } finally {
      err.mockRestore();
      if (prev === undefined) delete process.env.MWA_PUSH_VAPID; else process.env.MWA_PUSH_VAPID = prev;
      resetVapid();
    }
  });
});

describe('fix 7 (client): a stale or removed subscription is shown, not silently re-registered', () => {
  const f: PushFacts = { secure: true, hasWorker: true, hasPush: true, hasNotification: true, permission: 'granted', userAgent: 'Android', standalone: true, subscribed: false };
  it('the browser key differs from the server\'s: "need to be turned on again"; removed on the server: "Off on this device"', () => {
    expect(pushState({ ...f, subscribed: false, staleKey: true })).toBe('stale');
    expect(pushWords('stale', f, '').line).toMatch(/need to be turned on again/);
    expect(pushWords('stale', f, '').button).toBe('Turn on again');
    expect(pushState({ ...f, subscribed: false })).toBe('off');
    expect(pushWords('off', f, '').line).toMatch(/^Off on this device/);
  });
});

// ── 4. re-notify ────────────────────────────────────────────────────────────────────────────────────────────────
describe('fix 4: an unresolved item is notified once, however long it stays unresolved', () => {
  beforeEach(() => { resetAppDb(':memory:'); resetPushPrune(); process.env.MWA_RECEIPTS_DIR = mkdtempSync(join(tmpdir(), 'mwa-rv-4-')); });
  afterEach(() => { setPushDeps(null); delete process.env.MWA_RECEIPTS_DIR; });
  it('a result never opened: no second push after 31 or 62 days (the review\'s probe); a resolved one\'s record goes after a week', async () => {
    const b = browser();
    saveSubscription({ endpoint: b.endpoint, p256dh: b.p256dh, auth: b.auth, owner: 'local', vendor: 'google' }, T0);
    let sends = 0, now = Date.now();
    setPushDeps({ transport: async () => { sends++; return { status: 201 }; }, now: () => now, tz: () => 'UTC', quiet: () => false, pendingApprovals: () => [], morningNews: async () => false });
    const j = createJob({ kind: 'background', title: 'x', request: 'x' }, { trigger: 'first' });
    claimTry(j.try!.id, {}); endTry(j.try!.id, { reason: 'done', outcome: 'changed', summary: 's' });
    await pushTick(); expect(sends).toBe(1);
    for (const days of [31, 62, 200]) {
      now += days * 86_400_000; resetPushPrune();
      await pushTick();
      expect(sends, `after ${days} more days`).toBe(1);
    }
    // a key no longer standing (a resolved item), older than a week: pruned; a year-old record: pruned regardless
    appDb().prepare(`INSERT INTO push_sent (key, kind, state, at) VALUES ('approval:done_long_ago', 'approval', 'sent', ?)`).run(now - 8 * 86_400_000);
    appDb().prepare(`INSERT INTO push_sent (key, kind, state, at) VALUES ('approval:recent', 'approval', 'sent', ?)`).run(now - 2 * 86_400_000);
    prunePushRecords(now, new Set([`result:${j.job.id}:${j.try!.id}`]));
    expect(sentState('approval:done_long_ago')).toBeNull();
    expect(sentState('approval:recent')).toBe('sent');
    expect(sentState(`result:${j.job.id}:${j.try!.id}`)).toBe('sent'); // still unresolved: kept
    prunePushRecords(now + 400 * 86_400_000, new Set([`result:${j.job.id}:${j.try!.id}`]));
    expect(sentState(`result:${j.job.id}:${j.try!.id}`)).toBeNull();
    // without complete evidence (a source unreadable), only year-old records go
    appDb().prepare(`INSERT INTO push_sent (key, kind, state, at) VALUES ('approval:unknown', 'approval', 'sent', ?)`).run(now - 30 * 86_400_000);
    prunePushRecords(now);
    expect(sentState('approval:unknown')).toBe('sent');
  });
});

// ── 5. the VAPID sub ────────────────────────────────────────────────────────────────────────────────────────────
describe('fix 5: the VAPID contact never names the helper\'s address', () => {
  it('a generic mailto by default, MWA_PUSH_SUBJECT when set, never MWA_PUBLIC_URL; and that is what a send signs', async () => {
    expect(pushSubject({} as NodeJS.ProcessEnv)).toBe(DEFAULT_PUSH_SUBJECT);
    expect(pushSubject({ MWA_PUBLIC_URL: 'https://mwa.tail1a2b.ts.net' } as NodeJS.ProcessEnv)).toBe(DEFAULT_PUSH_SUBJECT);
    expect(pushSubject({ MWA_PUSH_SUBJECT: 'mailto:me@example.org' } as NodeJS.ProcessEnv)).toBe('mailto:me@example.org');
    expect(pushSubject({ MWA_PUSH_SUBJECT: 'not a contact' } as NodeJS.ProcessEnv)).toBe(DEFAULT_PUSH_SUBJECT);
    resetVapid();
    let auth = '';
    const env = { VITEST: '1', MWA_PUBLIC_URL: 'https://mwa.tail1a2b.ts.net' } as NodeJS.ProcessEnv;
    await sendPush(browser(), payloadFor('test', null), {}, async (_u, init) => { auth = init.headers.authorization; return { status: 201 }; }, env);
    const jwt = /vapid t=([^,]+),/.exec(auth)![1];
    const claims = verifyVapidJwt(jwt, vapidKeys(env).publicKey)!;
    expect(claims.sub).toBe(DEFAULT_PUSH_SUBJECT);
    expect(auth).not.toContain('ts.net');
  });
});

// ── 8. caps ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('fix 8: caps never cut off another live device; local subscriptions end with "this machine" trust', () => {
  beforeEach(() => { resetAppDb(':memory:'); setLocalOwnerValid(true); });
  afterEach(() => setLocalOwnerValid(true));
  const devices = (k: number) => Array.from({ length: k }, (_, i) => { const { code } = createPairCode('t'); return redeemPairCode(code, `P${i}`)!.deviceId; });
  it('per owner: its own oldest goes', () => {
    const [d] = devices(1);
    for (let i = 0; i < MAX_SUBS_PER_OWNER + 2; i++) { const b = browser(); saveSubscription({ ...b, owner: `device:${d}`, vendor: 'google' }, T0 + i); }
    const mine = listSubscriptions(`device:${d}`);
    expect(mine).toHaveLength(MAX_SUBS_PER_OWNER);
    expect(Math.min(...mine.map((s) => s.created_at))).toBe(T0 + 2);
  });
  it('past the overall cap: a gone owner\'s first, then the saver\'s own older ones, never another live owner\'s newest; else refused', () => {
    const ds = devices(MAX_SUBS);
    ds.forEach((d, i) => { const b = browser(); saveSubscription({ ...b, owner: `device:${d}`, vendor: 'google' }, T0 + i); });
    expect(listSubscriptions()).toHaveLength(MAX_SUBS);
    // every live device has exactly one (its newest): a new device cannot push anyone out
    const [extra] = devices(1);
    expect(() => saveSubscription({ ...browser(), owner: `device:${extra}`, vendor: 'google' }, T0 + 999)).toThrow(PushStoreError);
    expect(listSubscriptions()).toHaveLength(MAX_SUBS);
    // a device revoked: its subscription is the one that goes
    appDb().prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(Date.now(), ds[10]);
    saveSubscription({ ...browser(), owner: `device:${extra}`, vendor: 'google' }, T0 + 1000);
    expect(listSubscriptions(`device:${ds[10]}`)).toHaveLength(0);
    expect(ds.filter((d, i) => i !== 10).every((d) => listSubscriptions(`device:${d}`).length === 1)).toBe(true);
    // a device with two: when it adds a third past the cap, its own oldest goes first
    const [d0] = ds;
    saveSubscription({ ...browser(), owner: `device:${d0}`, vendor: 'google' }, T0 + 2000);
    expect(listSubscriptions(`device:${d0}`)).toHaveLength(1);
    expect(listSubscriptions()).toHaveLength(MAX_SUBS);
  });
  it('subscriptions made as "this machine" are removed when a password is set (or a relay serves it)', () => {
    saveSubscription({ ...browser(), owner: 'local', vendor: 'google' }, T0);
    expect(liveSubscriptions()).toHaveLength(1);
    setLocalOwnerValid(false);
    expect(listSubscriptions('local')).toHaveLength(0);
    saveSubscription({ ...browser(), owner: 'local', vendor: 'google' }, T0);
    expect(liveSubscriptions()).toHaveLength(0); // and one made later is never sent to
  });
});

// ── 10. responses ───────────────────────────────────────────────────────────────────────────────────────────────
describe('fix 10: a push service\'s answer is never read whole', () => {
  let srv: Server, origin = '';
  const env = () => ({ VITEST: '1', MWA_PUSH_TEST_ORIGIN: origin } as NodeJS.ProcessEnv);
  beforeAll(async () => {
    // answers with a body that never ends: a 201 and a 400
    srv = createServer((req, res) => {
      req.resume();
      res.writeHead(req.url?.startsWith('/ok') ? 201 : 400, { 'content-type': 'text/plain' });
      const t = setInterval(() => { if (!res.write('x'.repeat(16_384))) { /* backpressure: keep trying */ } }, 1);
      res.on('close', () => clearInterval(t));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  });
  afterAll(() => { srv.closeAllConnections?.(); srv.close(); });
  it('a 2xx body is not read (the send returns at once); a 4xx body is read at most 2 KB', async () => {
    const t0 = Date.now();
    const ok = await sendPush(browser(`${origin}/ok`), payloadFor('test', null), {}, undefined, env());
    expect(ok.outcome).toBe('accepted');
    const bad = await sendPush(browser(`${origin}/bad`), payloadFor('test', null), {}, undefined, env());
    expect(bad.outcome).toBe('failed');
    expect((bad.detail ?? '').length).toBeLessThanOrEqual(120);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });
  it('readCapped stops at the cap and cancels the stream', async () => {
    let cancelled = false;
    const s = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(1000).fill(65)); }, cancel() { cancelled = true; } });
    const text = await readCapped(s, 2048);
    expect(text.length).toBe(2048);
    expect(cancelled).toBe(true);
  });
});

// ── 11. a tap from v1 ───────────────────────────────────────────────────────────────────────────────────────────
describe('fix 11: a notification tap opens v2 for that visit only', () => {
  it('?ui=v2&from=notification is not remembered; ?ui=v2 by choice is', () => {
    expect(uiToRemember('?ui=v2&from=notification')).toBeNull();
    expect(uiToRemember('?ui=v2')).toBe('v2');
    expect(uiToRemember('?ui=v1')).toBeNull(); // W6: a link into the classic app is that visit only
    expect(uiToRemember('?view=settings')).toBeNull();
  });
});

describe('W6: the new app is the default', () => {
  it('the installed app’s start URL does not undo a classic choice; ?ui=v1 is never remembered', () => {
    expect(uiToRemember('?ui=v2&source=pwa')).toBeNull();
    expect(chooseUi('?ui=v2&source=pwa', 'v1')).toBe('v2'); // that launch is v2 …
    expect(chooseUi('', 'v1')).toBe('v1');                  // … and the classic choice still holds afterwards
    expect(chooseUi('', null)).toBe('v2');
    expect(chooseUi('', 'v2')).toBe('v2');
    expect(chooseUi('?ui=v1', null)).toBe('v1');
  });
});

// ── 12. receipts that join ──────────────────────────────────────────────────────────────────────────────────────
describe('fix 12: a push receipt joins its job\'s delivery line', () => {
  beforeEach(() => { resetAppDb(':memory:'); process.env.MWA_RECEIPTS_DIR = mkdtempSync(join(tmpdir(), 'mwa-rv-12-')); });
  afterEach(() => { setPushDeps(null); delete process.env.MWA_RECEIPTS_DIR; });
  it('a repeating job\'s fire: the push receipt has the scheduler\'s job and fire keys, and the line says "sent to your phone"', async () => {
    const b = browser();
    saveSubscription({ ...b, owner: 'local', vendor: 'google' }, T0);
    setPushDeps({ transport: async () => ({ status: 201 }), tz: () => 'UTC', quiet: () => false, pendingApprovals: () => [], morningNews: async () => false });
    const r = createJob({ kind: 'recurring', title: 'Watch the price', scheduleId: 'sched-price-1' });
    const t = addTry(r.job.id, { trigger: 'fire', scheduleId: 'sched-price-1' });
    claimTry(t.id, {});
    const fire = 'sched-pr-1761600000000';
    endTry(t.id, { reason: 'done', outcome: 'changed', summary: 'Price 12', fireId: fire });
    recordReceipt({ job: 'sched-price-1', fire, channel: 'app', status: 'stored' }); // what the scheduler records itself
    await pushTick();
    const push = readReceipts().filter((x) => x.channel === 'push');
    expect(push).toHaveLength(1);
    expect(push[0]).toMatchObject({ fire, status: 'accepted' });
    const fires = jobDeliveries('sched-price-1');
    expect(fires).toHaveLength(1); // one fire, both channels
    expect(Object.keys(fires[0].channels).sort()).toEqual(['app', 'push']);
    expect(deliveryLine('sched-price-1')).toMatch(/sent to your phone .*accepted by Google’s push service.*not proof it was shown/);
  });
});
