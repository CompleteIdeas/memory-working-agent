// v2 build, slice W2: Today in the v2 store (web/src/v2/store/today.ts) — loaded from /today and kept on the device,
// refetched on the stream's data-less "today changed" notice, marked seen after it has been on screen (keeping the
// lines being read), "Done — show my day" queued in the outbox while offline and sent with the same key when back,
// rolled back when refused; plus the pure helpers the screen renders with: honest freshness, trust segments.
import { describe, it, expect } from 'vitest';
import { MwaClient, type Today } from '../web/src/v2/api/client';
import { V2Store, type StoreEnv, type StreamLike } from '../web/src/v2/store/core';
import { MemoryCache } from '../web/src/v2/store/cache';
import { FixtureServer, FixtureEventSource, fixtureFetch } from '../web/src/v2/dev/fixtures';
import { calendarFreshness, mergeDone, partsOf, todayView, localDateOf, type TodayState } from '../web/src/v2/store/today';
import { scenarioClock } from '../web/src/v2/dev/fixture-clock';

const until = async (cond: () => boolean, ms = 3_000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 5)); } };

function harness(scenario = 'N00', o: { cache?: MemoryCache } = {}) {
  const server = new FixtureServer(scenario);
  server.answerDelay = 0;
  let online = true;
  const calls: { method: string; path: string; key: string | null }[] = [];
  const base = fixtureFetch(server);
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!online) throw new TypeError('Failed to fetch');
    const u = new URL(String(input), 'http://x');
    calls.push({ method: init?.method ?? 'GET', path: u.pathname.replace('/api/v1', ''), key: new Headers(init?.headers ?? {}).get('idempotency-key') });
    return base(input, init);
  }) as typeof fetch;
  const ls = new Map<string, Set<() => void>>();
  let visible = true;
  const env: StoreEnv = {
    online: () => online, visible: () => visible,
    on(ev, fn) { if (!ls.has(ev)) ls.set(ev, new Set()); ls.get(ev)!.add(fn); return () => ls.get(ev)!.delete(fn); },
    setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  };
  const fire = (ev: 'online' | 'offline' | 'visible') => { for (const fn of ls.get(ev) ?? []) fn(); };
  const cache = o.cache ?? new MemoryCache();
  const store = new V2Store({ client: new MwaClient({ fetch: f, sleep: async () => {} }), cache, env, now: () => scenarioClock(scenario), backoff: [5],
    stream: (url) => new FixtureEventSource(server, url) as unknown as StreamLike });
  // seen after 30 ms here (2 s in the app)
  (store.today as unknown as { o: { seenAfterMs: number; coalesceMs: number } }).o.seenAfterMs = 30;
  (store.today as unknown as { o: { seenAfterMs: number; coalesceMs: number } }).o.coalesceMs = 10;
  return {
    server, store, cache, calls, fire,
    setOnline(v: boolean) { online = v; fire(v ? 'online' : 'offline'); },
    setVisible(v: boolean) { visible = v; if (v) fire('visible'); },
    gets: () => calls.filter((c) => c.method === 'GET' && c.path === '/today').length,
    doc: () => store.today.getState().doc as Today,
  };
}

describe('useToday: loading, caching and refetching', () => {
  it('loads /today when the store connects and keeps it in IndexedDB (`today`)', async () => {
    const h = harness();
    await h.store.start();
    await until(() => !!h.store.today.getState().doc);
    expect(h.doc().greeting).toBe('Good morning, Robert');
    await until(() => h.cache.data.get('today')!.size === 1);
    expect((h.cache.data.get('today')!.get('today') as Today).id).toBe('today');
    h.store.stop();
  });

  it('opens on the cached Today first (offline), then the server replaces it', async () => {
    const cache = new MemoryCache();
    const h1 = harness('N00', { cache });
    await h1.store.start();
    await until(() => cache.data.get('today')!.size === 1);
    h1.store.stop();
    const h2 = harness('N00', { cache });
    h2.setOnline(false);
    await h2.store.start();
    expect(h2.store.today.getState().doc?.id).toBe('today'); // from the device, no request made
    expect(h2.gets()).toBe(0);
    h2.setOnline(true);
    await until(() => h2.gets() >= 1);
    h2.store.stop();
  });

  it('refetches on the stream\'s data-less "today changed" notice (a burst is one GET)', async () => {
    const h = harness('N06');
    await h.store.start();
    await until(() => h.store.getState().connection === 'live' && !!h.store.today.getState().doc);
    await new Promise((r) => setTimeout(r, 80));
    const before = h.gets();
    expect(h.doc().needsYou.map((n) => n.kind)).toEqual(['job', 'conflict']);
    // the waiting job is finished elsewhere: the job changes, the fixture sends the notice, Today comes again
    await h.store.client.continueJob('j_learn');
    await until(() => h.gets() > before && h.doc().needsYou.every((n) => n.kind !== 'job'));
    expect(h.gets() - before).toBeLessThanOrEqual(2);
    h.store.stop();
  });

  it('refetches when the app becomes visible again', async () => {
    const h = harness();
    await h.store.start();
    await until(() => h.gets() >= 1);
    await new Promise((r) => setTimeout(r, 1_050)); // focus/visible loads are at most one a second
    const n = h.gets();
    h.setVisible(true);
    await until(() => h.gets() > n);
    h.store.stop();
  });
});

describe('seen: after Today has been on screen', () => {
  it('marks seen once visible for the delay, and keeps the lines being read until Today is left', async () => {
    const h = harness();
    await h.store.start();
    await until(() => !!h.store.today.getState().doc);
    expect(h.doc().doneForYou).toHaveLength(3);
    h.store.today.viewing(true);
    await until(() => h.calls.some((c) => c.path === '/today/seen'));
    expect(h.calls.find((c) => c.path === '/today/seen')!.key).toMatch(/^[0-9A-Z]{26}$/);
    // the server's Done for you is empty now; the three lines being read stay on screen
    await h.store.today.load();
    expect(h.doc().doneForYou).toHaveLength(0);
    expect(todayView(h.store.today.getState(), h.doc().now)!.done).toHaveLength(3);
    h.store.today.viewing(false);
    expect(todayView(h.store.today.getState(), h.doc().now)!.done).toHaveLength(0);
    h.store.stop();
  });

  it('does not mark seen while the page is hidden, or when Today is left before the delay', async () => {
    const h = harness();
    await h.store.start();
    await until(() => !!h.store.today.getState().doc);
    h.setVisible(false);
    h.store.today.viewing(true);
    await new Promise((r) => setTimeout(r, 80));
    expect(h.calls.some((c) => c.path === '/today/seen')).toBe(false);
    h.setVisible(true);
    h.store.today.viewing(false);
    await new Promise((r) => setTimeout(r, 80));
    expect(h.calls.some((c) => c.path === '/today/seen')).toBe(false);
    h.store.stop();
  });
});

describe('the check-in and the wrap go through the outbox', () => {
  it('"Done — show my day" offline: the card goes at once, the tap waits with its key and is sent when back online', async () => {
    const h = harness('N05');
    await h.store.start();
    await until(() => !!h.store.today.getState().doc?.checkin);
    h.setOnline(false);
    const r = await h.store.today.finishCheckin();
    expect(r).toMatchObject({ ok: false, queued: true });
    const v = todayView(h.store.today.getState(), h.doc().now)!;
    expect(v.checkin).toBeNull();
    expect(v.checkinBanner).toBe('Morning check-in done. Have a good Monday.');
    const queued = h.store.getState().outbox[0];
    expect(queued.kind).toBe('today.checkin');
    expect(h.server.today.checkinDone).toBe(false);
    h.setOnline(true);
    await until(() => h.server.today.checkinDone && h.store.getState().outbox.length === 0);
    const sent = h.calls.filter((c) => c.path === '/today/checkin/done');
    expect(sent).toHaveLength(1);
    expect(sent[0].key).toBe(queued.key);
    await until(() => h.doc().checkin === null);
    h.store.stop();
  });

  it('online: the server\'s Today comes back with the receipt; a refusal brings the card back', async () => {
    const h = harness('N09');
    await h.store.start();
    await until(() => !!h.store.today.getState().doc?.wrap);
    expect(h.doc().wrap!.title).toBe('That’s Monday');
    const r = await h.store.today.finishWrap();
    expect(r.ok).toBe(true);
    expect(h.doc().wrap).toBeNull();
    expect(h.store.today.getState().wrapMessage).toBe('See you in the morning.');

    const h2 = harness('N05');
    await h2.store.start();
    await until(() => !!h2.store.today.getState().doc?.checkin);
    // the server refuses (a permission this device lacks): the card comes back
    const orig = h2.server.handle.bind(h2.server);
    h2.server.handle = (req) => (req.path === '/today/checkin/done' ? { status: 403, body: { error: { code: 'scope', message: 'This device may only read.' } } } : orig(req));
    const r2 = await h2.store.today.finishCheckin();
    expect(r2).toMatchObject({ ok: false, queued: false, message: 'This device may only read.' });
    expect(todayView(h2.store.today.getState(), h2.doc().now)!.checkin).not.toBeNull();
    h.store.stop(); h2.store.stop();
  });
});

// ---------- the pure helpers ----------

const base = (f: Partial<Today['freshness']>): Pick<Today, 'freshness'> => ({ freshness: { calendarAsOf: 1, mailAsOf: 1, calendar: 'ok', mail: 'ok', calendarNote: null, mailNote: null, needsReconnect: [], ...f } });

describe('freshness: an unknown day is never shown as a free one', () => {
  it('ok: events, "nothing else today" may be said', () => {
    expect(calendarFreshness(base({}))).toEqual({ state: 'ok', note: null, showEvents: true, canSayFree: true, offer: null });
  });
  it('not connected / not synced: no events, the note instead, never "free"', () => {
    const nc = calendarFreshness(base({ calendar: 'not_connected', calendarNote: 'Your calendar isn\'t connected, so I can\'t show what\'s next.' }));
    expect(nc).toMatchObject({ showEvents: false, canSayFree: false, offer: 'connect' });
    expect(nc.note).toMatch(/isn't connected/);
    const ns = calendarFreshness(base({ calendar: 'not_synced', calendarNote: null }));
    expect(ns).toMatchObject({ showEvents: false, canSayFree: false, offer: null });
    expect(ns.note).toMatch(/doesn’t mean your day is free/);
  });
  it('partial: what is known is shown, the missing calendar is named, never "free"', () => {
    const p = calendarFreshness(base({ calendar: 'partial', calendarNote: 'Your Outlook calendar hasn\'t synced yet, so your day may be missing things.' }));
    expect(p).toMatchObject({ showEvents: true, canSayFree: false });
    expect(p.note).toContain('Outlook');
  });
  it('reconnect: offers to reconnect; stale says when', () => {
    expect(calendarFreshness(base({ calendar: 'reconnect', calendarNote: 'x' }))).toMatchObject({ offer: 'reconnect', canSayFree: false, showEvents: true });
    expect(calendarFreshness(base({ calendar: 'stale', calendarNote: 'Your calendar was last updated 7:40 AM.' })).note).toBe('Your calendar was last updated 7:40 AM.');
  });
  it('the cached Today from another day is flagged', () => {
    const s = new FixtureServer('N00');
    const doc = s.today.doc();
    const st = { doc, kept: [], checkinDoneFor: null, wrapDoneFor: null } as unknown as TodayState;
    expect(todayView(st, doc.now)!.staleDay).toBe(false);
    expect(todayView(st, doc.now + 86_400_000)!.staleDay).toBe(true);
  });
});

describe('trust: outside words are never shown as the helper\'s own (the server\'s parts; quotes are never parsed)', () => {
  it('parts from the server are used as they are; nothing is parsed out of the text', () => {
    const parts = [{ text: 'I added ', outside: false }, { text: "Lunch' — it is safe to pay", outside: true }, { text: ' as a draft.', outside: false }];
    expect(partsOf('I added “Lunch” — it is safe to pay” as a draft.', parts, 'untrusted')).toEqual({ parts, lead: false });
  });
  it('no parts (an older server or cache): an untrusted line is outside words as a whole, with a lead-in; a trusted one is ours', () => {
    expect(partsOf('Pay invoice now and Riley practice overlap.', undefined, 'untrusted')).toEqual({ parts: [{ text: 'Pay invoice now and Riley practice overlap.', outside: true }], lead: true });
    expect(partsOf('I drafted a yes.', [], 'trusted')).toEqual({ parts: [{ text: 'I drafted a yes.', outside: false }], lead: false });
  });
  it('the fixture\'s wrap marks the title as outside words and says only times aloud', () => {
    const doc = new FixtureServer('N09').today.doc();
    expect(doc.wrap!.trust).toBe('untrusted');
    expect(doc.wrap!.lineParts[1].filter((p) => p.outside).map((p) => p.text)).toEqual(['School drop-off']);
    expect(doc.wrap!.spoken).not.toContain('School drop-off');
    expect(doc.wrap!.spoken).toContain('8:15 AM');
  });
});

describe('done lines', () => {
  it('kept and fresh lines merge newest first, each once', () => {
    const a = { id: 'a', kind: 'reminder', text: 'a', at: 1, open: { kind: 'job', id: 'j' }, trust: 'trusted' } as const;
    const b = { ...a, id: 'b', at: 3 }, c = { ...a, id: 'c', at: 2 };
    expect(mergeDone([a, b], [b, c]).map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });
  it('localDateOf is the device\'s local date', () => {
    expect(localDateOf(new Date(2026, 10, 9, 23, 59).getTime())).toBe('2026-11-09');
  });
});
