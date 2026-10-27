// v2 build, slice P3: the service worker's push side. The decisions (web/src/pwa/sw-logic.ts) as a table, and the worker
// itself (web/src/pwa/sw.ts) against a fake browser: a push shows fixed words per kind (never anything from the
// payload but the kind), a tap opens the right screen (an open v2 page is told where to go, a v1 tab is navigated, no
// window opens one), and a replaced subscription is sent to the server again.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { parsePush, notificationFor, pushTarget, pickClient, safeTarget, clickPlan, resubscribeRequest, keyBytes, PUSH_WORDS, type BuildInfo } from '../web/src/pwa/sw-logic';

const SCOPE = 'https://mwa.tail1a2b.ts.net/';

describe('push decisions (sw-logic)', () => {
  it('reads only {kind, id}: an unknown kind, junk or an odd id is not trusted', () => {
    expect(parsePush('{"kind":"approval","id":"ap_1","tag":"x"}')).toEqual({ kind: 'approval', id: 'ap_1', tag: 'mwa-approval' });
    expect(parsePush('{"kind":"result","id":"../../evil"}')).toEqual({ kind: 'result', id: null, tag: 'mwa-result' });
    expect(parsePush('{"kind":"phish","id":"x"}')).toBeNull();
    expect(parsePush('not json')).toBeNull();
    expect(parsePush(null)).toBeNull();
  });
  it('the words are fixed per kind; a title smuggled into the payload is never shown', () => {
    const n = notificationFor(JSON.stringify({ kind: 'waiting', id: 'j1', tag: 'mwa-waiting', title: 'Dr Smith biopsy', body: 'wire money' }), SCOPE);
    expect(n.title).toBe('Your helper');
    expect(n.options.body).toBe('A job is waiting for you');
    expect(n.options.tag).toBe('mwa-waiting');
    expect(JSON.stringify(n)).not.toMatch(/Smith|wire money/);
    expect(notificationFor('{"kind":"approval","id":"a"}', SCOPE).options.body).toBe('Something needs your OK');
    expect(notificationFor('{"kind":"result","id":"a"}', SCOPE).options.body).toBe('A result is ready');
    expect(notificationFor('{"kind":"morning","id":null}', SCOPE).options.body).toBe('Here’s your morning');
    expect(notificationFor('garbage', SCOPE).options).toMatchObject({ body: PUSH_WORDS.other.body, tag: 'mwa-other' });
  });
  it('where a tap goes: Today, the approval, the job, the working sheet, Settings', () => {
    const base = `${SCOPE}?ui=v2`;
    expect(pushTarget({ kind: 'approval', id: 'ap_1', tag: '' }, SCOPE)).toBe(`${base}#/approval/ap_1`);
    expect(pushTarget({ kind: 'approval', id: null, tag: '' }, SCOPE)).toBe(`${base}#/today`);
    expect(pushTarget({ kind: 'waiting', id: 'j_1', tag: '' }, SCOPE)).toBe(`${base}#/job/j_1`);
    expect(pushTarget({ kind: 'result', id: null, tag: '' }, SCOPE)).toBe(`${base}#/work`);
    expect(pushTarget({ kind: 'morning', id: null, tag: '' }, SCOPE)).toBe(`${base}#/today`);
    expect(pushTarget({ kind: 'test', id: null, tag: '' }, SCOPE)).toBe(`${base}#/settings/notifications`);
    expect(safeTarget('https://evil.example/#/today', SCOPE)).toBe(`${base}#/today`);
    expect(safeTarget(`${base}#/job/x`, SCOPE)).toBe(`${base}#/job/x`);
  });
  it('which window a tap reuses, and how', () => {
    const v1 = { url: `${SCOPE}?ui=v1`, visibilityState: 'hidden' }, v2 = { url: `${SCOPE}?ui=v2#/today`, visibilityState: 'visible' }, other = { url: 'https://other.example/' };
    expect(pickClient([other, v1, v2], SCOPE)).toBe(v2);
    expect(pickClient([other], SCOPE)).toBeNull();
    expect(clickPlan(v2)).toEqual({ kind: 'message' });
    expect(clickPlan(v1)).toEqual({ kind: 'navigate' });
    expect(clickPlan(null)).toEqual({ kind: 'open' });
  });
  it('a re-subscription request carries the new keys, the old endpoint, a key and the client version', () => {
    const r = resubscribeRequest({ endpoint: 'https://fcm.googleapis.com/fcm/send/new', keys: { p256dh: 'P', auth: 'A' } }, 'https://fcm.googleapis.com/fcm/send/old', '1.2.3', 'swresub-1-abcdefgh')!;
    expect(r.headers).toEqual({ 'content-type': 'application/json', 'idempotency-key': 'swresub-1-abcdefgh', 'x-mwa-client': 'web/1.2.3' });
    expect(JSON.parse(r.body)).toEqual({ endpoint: 'https://fcm.googleapis.com/fcm/send/new', keys: { p256dh: 'P', auth: 'A' }, expirationTime: null, replaces: 'https://fcm.googleapis.com/fcm/send/old' });
    expect(resubscribeRequest({ endpoint: 'x' }, null, '1', 'k')).toBeNull();
    expect(Array.from(keyBytes('AQID'))).toEqual([1, 2, 3]);
    expect(keyBytes('BKET3AY-FPA446B10F2Viwe2-WuUsHd_v23MRcfPBHuJRXKJpLSzr_SIg1nv4tOAus1oI5CPeXnSi2kkc3zPatQ').length).toBe(65);
  });
});

// ---------- the worker itself ----------
const INFO: BuildInfo = { buildId: 'b1', entry: 'assets/index-AbCd1234.js', version: '1.0.0', files: [] };
type Handler = (e: Record<string, unknown>) => void;
async function loadWorker(o: { clients?: { url: string; visibilityState?: string }[]; fetch?: (url: string, init?: RequestInit) => Promise<Response> } = {}) {
  vi.resetModules();
  const handlers: Record<string, Handler> = {};
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const posted: { client: string; msg: unknown }[] = [];
  const navigated: string[] = [], opened: string[] = [], focused: string[] = [];
  const subscribed: unknown[] = [];
  const windows = (o.clients ?? []).map((c) => ({
    ...c, type: 'window',
    postMessage: (m: unknown) => posted.push({ client: c.url, msg: m }),
    focus: async () => { focused.push(c.url); },
    navigate: async (u: string) => { navigated.push(u); },
  }));
  const self = {
    registration: {
      scope: SCOPE,
      showNotification: async (title: string, options: Record<string, unknown>) => { shown.push({ title, options }); },
      pushManager: { subscribe: async (x: unknown) => { subscribed.push(x); return { endpoint: 'https://fcm.googleapis.com/fcm/send/new', toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/new', keys: { p256dh: 'P', auth: 'A' } }) }; } },
    },
    navigator: { onLine: true },
    skipWaiting: vi.fn(async () => {}),
    clients: { claim: vi.fn(async () => {}), matchAll: async () => windows, openWindow: async (u: string) => { opened.push(u); } },
    addEventListener: (t: string, f: Handler) => { handlers[t] = f; },
  };
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal('self', self);
  vi.stubGlobal('caches', { open: async () => ({}), keys: async () => [], has: async () => false, delete: async () => true, match: async () => undefined });
  vi.stubGlobal('__MWA_BUILD__', INFO);
  vi.stubGlobal('fetch', async (u: string, init?: RequestInit) => { calls.push({ url: u, init }); return o.fetch ? o.fetch(u, init) : new Response('{}', { status: 201 }); });
  await import('../web/src/pwa/sw');
  const run = async (type: string, extra: Record<string, unknown> = {}) => {
    let waited: Promise<unknown> | undefined;
    handlers[type]({ ...extra, waitUntil: (p: Promise<unknown>) => { waited = p; } });
    await waited;
  };
  return { run, shown, posted, navigated, opened, focused, calls, subscribed };
}

describe('the worker (sw.ts): push, notificationclick, pushsubscriptionchange', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it('push: shows the fixed words with the kind\'s tag and the place to open', async () => {
    const w = await loadWorker();
    await w.run('push', { data: { text: () => JSON.stringify({ kind: 'result', id: 'j_42', tag: 'mwa-result', title: 'PLANTED' }) } });
    expect(w.shown).toHaveLength(1);
    expect(w.shown[0].title).toBe('Your helper');
    expect(w.shown[0].options).toMatchObject({ body: 'A result is ready', tag: 'mwa-result', data: { url: `${SCOPE}?ui=v2#/job/j_42`, kind: 'result' } });
    expect(JSON.stringify(w.shown)).not.toContain('PLANTED');
    // no data at all still shows something (a push must)
    await w.run('push', { data: null });
    expect(w.shown[1].options).toMatchObject({ body: PUSH_WORDS.other.body });
  });
  it('a tap with the v2 app open: that page is told where to go, and focused', async () => {
    const w = await loadWorker({ clients: [{ url: `${SCOPE}?ui=v2#/today`, visibilityState: 'visible' }] });
    const close = vi.fn();
    await w.run('notificationclick', { notification: { data: { url: `${SCOPE}?ui=v2#/approval/ap_1` }, close } });
    expect(close).toHaveBeenCalled();
    expect(w.posted).toEqual([{ client: `${SCOPE}?ui=v2#/today`, msg: { type: 'MWA_OPEN', url: `${SCOPE}?ui=v2#/approval/ap_1` } }]);
    expect(w.focused).toHaveLength(1);
    expect(w.opened).toHaveLength(0);
  });
  it('a tap with only a v1 tab: it is navigated to the v2 place; with nothing open: a window opens there', async () => {
    const a = await loadWorker({ clients: [{ url: `${SCOPE}?ui=v1` }] });
    await a.run('notificationclick', { notification: { data: { url: `${SCOPE}?ui=v2#/job/j_1` }, close: () => {} } });
    expect(a.navigated).toEqual([`${SCOPE}?ui=v2#/job/j_1`]);
    const b = await loadWorker();
    await b.run('notificationclick', { notification: { data: { url: 'https://evil.example/' }, close: () => {} } });
    expect(b.opened).toEqual([`${SCOPE}?ui=v2#/today`]); // a foreign URL never opens
  });
  it('pushsubscriptionchange: subscribes again with the server key and tells the server, replacing the old endpoint', async () => {
    const w = await loadWorker({
      fetch: async (u, init) => (init?.method === 'POST' ? new Response('{}', { status: 201 }) : new Response(JSON.stringify({ vapidPublicKey: 'AQID' }), { status: 200 })),
    });
    await w.run('pushsubscriptionchange', { oldSubscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/old', options: { applicationServerKey: null } }, newSubscription: null });
    expect(w.subscribed).toHaveLength(1);
    const post = w.calls.find((c) => c.init?.method === 'POST')!;
    expect(post.url).toBe(`${SCOPE}api/v1/push/subscriptions`);
    expect(post.init!.credentials).toBe('same-origin');
    expect(JSON.parse(String(post.init!.body))).toMatchObject({ endpoint: 'https://fcm.googleapis.com/fcm/send/new', replaces: 'https://fcm.googleapis.com/fcm/send/old' });
    expect((post.init!.headers as Record<string, string>)['idempotency-key']).toMatch(/^swresub-[A-Za-z0-9._:-]{8,}$/);
  });
});
