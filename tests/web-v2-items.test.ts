// v2 build, slice W3: the Important list in the v2 web store (web/src/v2/store/core.ts + store/important.ts) — the
// `important` collection on /sync and the `item` entity on the stream keep the items live and on the device; the
// person's taps (Handled, Undo, Not important with a scope, This was important, a rule removed, a reply draft) go
// through the outbox with an Idempotency-Key, show at once, and go back by themselves with the server's own words when
// refused; made offline, they wait in the outbox (still shown) and are replayed with the same key. Plus the pure parts:
// the groups, the skipped line, the Not important choices, the rule lines.
import { describe, it, expect } from 'vitest';
import { MwaClient, type ImportantItem, type TriageRule } from '../web/src/v2/api/client';
import { V2Store, type StoreEnv, type StreamLike, type OutboxEntry } from '../web/src/v2/store/core';
import { MemoryCache } from '../web/src/v2/store/cache';
import { groupItems, handledItems, ruleEffectLine, ruleLine, scopeChoice, skipLine, withPending, skippedWithPending, rulesWithPending } from '../web/src/v2/store/important';
import { linksToHosts as clientLinksToHosts, showName } from '../web/src/v2/store/text';
import { linksToHosts as serverLinksToHosts, displayName as serverDisplayName } from '../src/v2/mail-text';
import { unshown } from '../web/src/v2/screens/ask/AskAbout';
import { AnswerText } from '../web/src/v2/screens/ask/answerText';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { rowAction } from '../web/src/v2/screens/important/ItemRow';
import type { Ask } from '../web/src/v2/api/client';

// ---------- fakes ----------
const NOW = Date.UTC(2026, 10, 9, 14, 10);
function item(id: string, extra: Partial<ImportantItem> = {}): ImportantItem {
  return {
    id, source: 'mail', sourceRef: `m_${id}`, group: 'today', day: '2026-11-09', ts: NOW - 60_000, from: 'Coach Ellen', fromAddress: 'ellen@willowcreekfarm.example',
    caution: null, title: `Item ${id}`, why: 'Asks you to confirm Saturday.', trust: 'untrusted', kind: 'personal', action: { kind: 'review-reply', label: 'Open' },
    state: 'open', handledAt: null, projectId: null, mailId: `m_${id}`, qa: [], updatedSeq: 1, ...extra,
  };
}
const SKIPPED = { today: { count: 5, kinds: { newsletter: 2, promotion: 2, receipt: 1 }, byYou: 0 }, week: { count: 0, kinds: {}, byYou: 0 }, earlier: { count: 4, kinds: { receipt: 2, promotion: 1 }, byYou: 1 } };
const SORTING = { mode: 'full', waiting: 0, olderUnsorted: 0, note: null, spentTodayUsd: 0, capUsd: 0.1, lastRunAt: null };
const list = (items: ImportantItem[], state = 'open') => ({
  status: 200, body: { state, groups: (['today', 'week', 'earlier'] as const).map((g) => ({ group: g, label: g, items: items.filter((i) => i.group === g) })), handledCount: 0, skipped: SKIPPED, sorting: SORTING },
});
const change = (it: ImportantItem, message = 'ok', extra: Record<string, unknown> = {}) => ({ status: 200, body: { item: it, message, ...extra } });
const refuse = (status: number, code: string, message: string) => ({ status, body: { error: { code, message } } });

class FakeES implements StreamLike {
  readyState = 0;
  onerror: ((e: Event) => void) | null = null;
  ls = new Map<string, ((e: MessageEvent) => void)[]>();
  constructor(public url: string) {}
  addEventListener(t: string, fn: (e: MessageEvent) => void) { this.ls.set(t, [...(this.ls.get(t) ?? []), fn]); }
  close() { this.readyState = 2; }
  emit(t: string, data: unknown, id?: number) {
    this.readyState = 1;
    for (const fn of this.ls.get(t) ?? []) fn(new MessageEvent(t, { data: JSON.stringify(data), lastEventId: id ? String(id) : '' }));
  }
}
interface Call { method: string; path: string; query: URLSearchParams; key?: string; body?: unknown }
type Reply = { status: number; body?: unknown } | 'network' | Promise<{ status: number; body?: unknown }>;

function harness(o: { features?: string[]; online?: boolean; cache?: MemoryCache } = {}) {
  const calls: Call[] = [];
  const handlers: [string | RegExp, (c: Call) => Reply][] = [];
  let online = o.online ?? true;
  const on = (method: string, path: string | RegExp, h: (c: Call) => Reply) => handlers.unshift([typeof path === 'string' ? `${method} ${path}` : new RegExp(`^${method} ${path.source}$`), h]);
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x');
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers ?? {});
    const c: Call = { method, path: u.pathname.replace('/api/v1', ''), query: u.searchParams, key: headers.get('idempotency-key') ?? undefined, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined };
    if (!online) throw new TypeError('Failed to fetch');
    calls.push(c);
    const key = `${method} ${c.path}`;
    const h = handlers.find(([p]) => (typeof p === 'string' ? p === key : p.test(key)));
    const r = await (h ? h[1](c) : { status: 404, body: { error: { code: 'not_found', message: 'No such endpoint.' } } });
    if (r === 'network') throw new TypeError('Failed to fetch');
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  const listeners = new Map<string, Set<() => void>>();
  const env: StoreEnv = {
    online: () => online, visible: () => true,
    on(ev, fn) { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev)!.add(fn); return () => listeners.get(ev)!.delete(fn); },
    setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  };
  const streams: FakeES[] = [];
  const cache = o.cache ?? new MemoryCache();
  const store = new V2Store({ client: new MwaClient({ fetch: f, sleep: async () => {} }), cache, env, stream: (url) => { const s = new FakeES(url); streams.push(s); return s; }, backoff: [5], now: () => NOW });
  on('GET', '/meta', () => ({ status: 200, body: { api: 'v1', server: '0.9.1', minClient: '1.0.0', secure: true, features: o.features ?? ['jobs', 'calendar', 'mail', 'projects', 'important', 'ask'], importing: null } }));
  return {
    store, cache, calls, streams, on,
    setOnline(v: boolean) { online = v; for (const fn of listeners.get(v ? 'online' : 'offline') ?? []) fn(); },
    /** what useItems shows: the items with the pending taps applied */
    view: () => { const s = store.getState(); return withPending(s.items, [...s.inflight, ...s.outbox], NOW); },
    writes: () => calls.filter((c) => c.method !== 'GET'),
  };
}
const sync = (cursor: number, important: ImportantItem[] | undefined, o: { reset?: boolean; deletes?: string[] } = {}) => ({
  status: 200, body: { cursor, reset: !!o.reset, more: false, upserts: { jobs: [], calendar: [], projects: [], turns: [], ...(important ? { important } : {}) }, deletes: { jobs: [], calendar: [], projects: [], turns: [], important: o.deletes ?? [] } },
});
const deferred = <T,>() => { let resolve!: (v: T) => void; const p = new Promise<T>((r) => { resolve = r; }); return { p, resolve }; };

// ---------- live: /sync and the stream ----------
describe('the items stay live and on the device', () => {
  it('asks /sync for the important collection only when the server has it, and keeps the snapshot', async () => {
    const h = harness();
    h.on('GET', '/sync', () => sync(10, [item('a'), item('b', { state: 'handled', handledAt: NOW - 1 })], { reset: true }));
    await h.store.start();
    await h.store.idle();
    expect(h.calls.find((c) => c.path === '/sync')!.query.get('collections')).toBe('jobs,calendar,projects,turns,important');
    expect(Object.keys(h.store.getState().items).sort()).toEqual(['a', 'b']);
    expect((await h.cache.all<ImportantItem>('items')).map((i) => i.id).sort()).toEqual(['a', 'b']);
    expect(groupItems(h.view()).find((g) => g.group === 'today')!.items.map((i) => i.id)).toEqual(['a']);
    expect(handledItems(h.view()).map((i) => i.id)).toEqual(['b']);

    const old = harness({ features: ['jobs', 'calendar', 'mail', 'projects'] });
    old.on('GET', '/sync', () => sync(3, undefined, { reset: true }));
    await old.store.start();
    expect(old.calls.find((c) => c.path === '/sync')!.query.get('collections')).toBe('jobs,calendar,projects,turns');
  });

  it('follows the stream: an item changing, a question answered under it, and one leaving the list', async () => {
    const h = harness();
    h.on('GET', '/sync', () => sync(10, [item('a')], { reset: true }));
    await h.store.start();
    const es = h.streams.at(-1)!;
    es.emit('hello', { cursor: 10, head: 10 });
    es.emit('change', { seq: 11, entity: 'item', id: 'a', op: 'upsert', data: item('a', { qa: [{ id: 'qa1', q: 'Why does this matter?', a: null, ts: NOW, tainted: false }], updatedSeq: 11 }) }, 11);
    expect(h.store.getState().items.a.qa[0].a).toBeNull();
    es.emit('change', { seq: 12, entity: 'item', id: 'a', op: 'upsert', data: item('a', { qa: [{ id: 'qa1', q: 'Why does this matter?', a: 'Saying yes keeps your spot.', ts: NOW, tainted: true }], updatedSeq: 12 }) }, 12);
    expect(h.store.getState().items.a.qa[0].a).toBe('Saying yes keeps your spot.');
    es.emit('change', { seq: 13, entity: 'item', id: 'c', op: 'upsert', data: item('c', { group: 'week', updatedSeq: 13 }) }, 13);
    expect(groupItems(h.view()).find((g) => g.group === 'week')!.items.map((i) => i.id)).toEqual(['c']);
    es.emit('change', { seq: 14, entity: 'item', id: 'a', op: 'delete' }, 14);
    await h.store.idle();
    expect(h.store.getState().items.a).toBeUndefined();
    expect(h.store.getState().cursor).toBe(14);
    expect((await h.cache.all<ImportantItem>('items')).map((i) => i.id)).toEqual(['c']);
  });

  it('GET /items replaces the held list (one gone from it has left), keeps a newer held copy, and brings the counts', async () => {
    const h = harness();
    h.on('GET', '/sync', () => sync(10, [item('a', { updatedSeq: 9 }), item('gone')], { reset: true }));
    await h.store.start();
    h.streams.at(-1)!.emit('change', { seq: 20, entity: 'item', id: 'a', op: 'upsert', data: item('a', { title: 'Newer', updatedSeq: 20 }) }, 20);
    h.on('GET', '/items', (c) => (c.query.get('state') === 'handled' ? list([], 'handled') : list([item('a', { updatedSeq: 15 }), item('new', { group: 'earlier' })])));
    await h.store.loadImportant();
    const s = h.store.getState();
    expect(Object.keys(s.items).sort()).toEqual(['a', 'new']);
    expect(s.items.a.title).toBe('Newer');
    expect(s.important.meta!.skipped.today.count).toBe(5);
    expect(skipLine('today', s.important.meta!.skipped.today)).toBe('I skipped 5 others today: newsletters, promotions, receipts');
  });
});

// ---------- actions: optimistic, rolled back, offline ----------
describe('Handled, Undo, Not important: at once, with the server\'s answer, rolled back when refused', () => {
  async function started(items: ImportantItem[]) {
    const h = harness();
    h.on('GET', '/sync', () => sync(10, items, { reset: true }));
    await h.store.start();
    h.streams.at(-1)!.emit('hello', { cursor: 10, head: 10 });
    return h;
  }

  it('Handled shows at once, then holds the server\'s item; Undo is its own action with its own key', async () => {
    const h = await started([item('a')]);
    const gate = deferred<{ status: number; body?: unknown }>();
    h.on('POST', '/items/a/handled', () => gate.p);
    const p = h.store.act('item.handled', { id: 'a' }, 'Mark “Item a” handled');
    await Promise.resolve();
    expect(h.view().a.state).toBe('handled'); // in flight: shown done
    expect(groupItems(h.view())[0].items).toEqual([]);
    gate.resolve(change(item('a', { state: 'handled', handledAt: NOW, updatedSeq: 11 }), 'Marked handled: Item a'));
    const r = await p;
    expect(r).toMatchObject({ ok: true, message: 'Marked handled: Item a' });
    expect(h.store.getState().inflight).toEqual([]);
    expect(h.store.getState().items.a.state).toBe('handled');
    const key1 = h.writes().at(-1)!.key;
    h.on('POST', '/items/a/unhandle', () => change(item('a', { updatedSeq: 12 }), 'Back on your list: Item a'));
    await h.store.act('item.unhandle', { id: 'a' }, 'Undo');
    expect(h.store.getState().items.a.state).toBe('open');
    expect(h.writes().map((c) => c.path)).toEqual(['/items/a/handled', '/items/a/unhandle']);
    expect(h.writes()[1].key).not.toBe(key1);
    expect(h.writes().every((c) => /^[0-9A-Z]{26}$/.test(c.key ?? ''))).toBe(true);
  });

  it('a refusal rolls it back, with the server\'s plain message', async () => {
    const h = await started([item('a')]);
    h.on('POST', '/items/a/handled', () => refuse(500, 'internal', 'Something went wrong on your helper’s side. Try again in a moment.'));
    const r = await h.store.act('item.handled', { id: 'a' }, 'Mark handled');
    expect(r).toMatchObject({ ok: false, queued: false, message: 'Something went wrong on your helper’s side. Try again in a moment.' });
    expect(h.view().a.state).toBe('open');
    expect(groupItems(h.view())[0].items.map((i) => i.id)).toEqual(['a']);
    expect(h.store.getState().notices.at(-1)).toMatchObject({ tone: 'error', text: 'Something went wrong on your helper’s side. Try again in a moment.' });
  });

  it('Not important sends its scope; a scope the server refuses (400) comes back in its words, quietly, and changes nothing', async () => {
    const h = await started([item('a', { fromAddress: 'dana@gmail.com' })]);
    const msg = 'gmail.com is a free email service: skipping it would hide everyone who uses it, people you know included. Choose "messages from dana@gmail.com" instead.';
    h.on('POST', '/items/a/not-important', (c) => ((c.body as { scope?: string })?.scope === 'domain' ? refuse(400, 'freemail_domain', msg)
      : change(item('a', { state: 'not-important', updatedSeq: 11 }), "Got it. I'll skip messages like this from dana@gmail.com.", { rule: { id: 'tr_1', match: 'sender', value: 'dana@gmail.com' } })));
    const before = h.store.getState().notices.length;
    const r = await h.store.act('item.notImportant', { id: 'a', scope: 'domain' }, 'Not important', { quiet: true });
    expect(r).toMatchObject({ ok: false, queued: false, code: 'freemail_domain', message: msg });
    expect(h.writes().at(-1)!.body).toEqual({ scope: 'domain' });
    expect(h.store.getState().notices.length).toBe(before); // the sheet shows it, not a toast too
    expect(h.view().a.state).toBe('open');
    const ok = await h.store.act('item.notImportant', { id: 'a', scope: 'sender' }, 'Not important', { quiet: true });
    expect(ok).toMatchObject({ ok: true, message: "Got it. I'll skip messages like this from dana@gmail.com." });
    expect(h.writes().at(-1)!.body).toEqual({ scope: 'sender' });
    expect(groupItems(h.view())[0].items).toEqual([]);
    // no scope (not from an email): an empty body, the server's default
    h.on('POST', '/items/b/not-important', () => change(item('b', { state: 'not-important' }), "Got it. I've taken it off your list."));
    h.store.getState().items.b = item('b');
    await h.store.act('item.notImportant', { id: 'b' }, 'Not important');
    expect(h.writes().at(-1)!.body).toEqual({});
  });

  it('a rule taught or removed refreshes the counts beside the list', async () => {
    const h = await started([item('a')]);
    let lists = 0;
    h.on('GET', '/items', (c) => { if (!c.query.get('state')) lists++; return c.query.get('state') === 'handled' ? list([], 'handled') : list([item('a')]); });
    await h.store.loadImportant();
    h.on('POST', '/items/a/not-important', () => change(item('a', { state: 'not-important' }), 'Got it.'));
    await h.store.act('item.notImportant', { id: 'a', scope: 'sender' }, 'Not important');
    await h.store.idle();
    await new Promise((r) => setTimeout(r, 0));
    expect(lists).toBe(2);
  });

  it('made offline: kept in the outbox with its key and still shown; sent with the same key when back online', async () => {
    const cache = new MemoryCache();
    const h = harness({ cache });
    h.on('GET', '/sync', () => sync(10, [item('a'), item('b')], { reset: true }));
    await h.store.start();
    h.setOnline(false);
    const r = await h.store.act('item.handled', { id: 'a' }, 'Mark “Item a” handled');
    expect(r).toMatchObject({ ok: false, queued: true });
    expect(h.view().a.state).toBe('handled'); // waiting, but shown done
    await h.store.idle();
    const saved = await cache.all<OutboxEntry>('outbox');
    expect(saved.map((e) => e.kind)).toEqual(['item.handled']);
    const key = saved[0].key;
    let sentKey: string | undefined;
    h.on('POST', '/items/a/handled', (c) => { sentKey = c.key; return change(item('a', { state: 'handled', handledAt: NOW, updatedSeq: 11 }), 'Marked handled: Item a'); });
    h.setOnline(true);
    await new Promise((r) => setTimeout(r, 20));
    await h.store.idle();
    expect(sentKey).toBe(key);
    expect(h.store.getState().outbox).toEqual([]);
    expect(h.store.getState().items.a.state).toBe('handled');
  });

  it('a queued action the server then refuses for good is dropped, said, and the item shows as the server has it', async () => {
    const h = harness();
    h.on('GET', '/sync', () => sync(10, [item('a', { state: 'not-important' })], { reset: true }));
    await h.store.start();
    h.setOnline(false);
    await h.store.act('item.unhandle', { id: 'a' }, 'Undo “Item a”');
    expect(h.view().a.state).toBe('open');
    h.on('POST', '/items/a/unhandle', () => refuse(409, 'not_handled', 'That item was marked not important, not handled.'));
    h.setOnline(true);
    await new Promise((r) => setTimeout(r, 20));
    await h.store.idle();
    expect(h.store.getState().outbox).toEqual([]);
    expect(h.view().a.state).toBe('not-important');
    expect(h.store.getState().notices.at(-1)).toMatchObject({ tone: 'error', text: 'Undo “Item a”: That item was marked not important, not handled.' });
  });
});

describe('Show them, This was important, rules and reply drafts', () => {
  it('This was important: the row leaves its skipped list and the item joins the list', async () => {
    const h = harness();
    h.on('GET', '/sync', () => sync(10, [], { reset: true }));
    await h.store.start();
    const row = (id: string) => ({ mail: { id, account: 'gmail', provider: 'gmail', threadId: null, from: { name: 'The Batch', addr: 'news@thebatch.example' }, subject: 'This week in AI', snippet: '', receivedAt: NOW, unread: false, labels: [], listId: 'x', hasUnsub: true, alsoIn: [], updatedSeq: 1 }, group: 'today', kind: 'newsletter', reason: 'A mailing list.', byYou: false });
    h.on('GET', '/items/skipped', () => ({ status: 200, body: { group: 'today', count: 2, skipped: [row('m_1'), row('m_2')] } }));
    await h.store.loadSkipped('today');
    expect(h.store.getState().skipped.today!.count).toBe(2);
    h.on('POST', '/mail/m_1/important', () => change(item('it_m1', { title: 'This week in AI' }), "Thanks — I'll show messages like this from The Batch."));
    const r = await h.store.act('mail.important', { id: 'm_1', group: 'today' }, 'This was important', { quiet: true });
    expect(r).toMatchObject({ ok: true, message: "Thanks — I'll show messages like this from The Batch." });
    expect(h.store.getState().skipped.today).toMatchObject({ count: 1 });
    expect(h.store.getState().skipped.today!.rows.map((x) => x.mail.id)).toEqual(['m_2']);
    expect(h.store.getState().items.it_m1.title).toBe('This week in AI');
    // pending (offline): the row is hidden already
    const pend = [{ id: 'x', key: 'k', kind: 'mail.important', args: { id: 'm_2' }, label: '', createdAt: 0, attempts: 0 }] as OutboxEntry[];
    expect(skippedWithPending(h.store.getState().skipped.today!.rows, pend)).toEqual([]);
  });

  it('rules: listed with their effect; Remove deletes it with a key and it leaves the list', async () => {
    const h = harness();
    h.on('GET', '/sync', () => sync(10, [], { reset: true }));
    await h.store.start();
    const rule: TriageRule = { id: 'tr_1', match: 'sender', value: 'news@medium.example', verdict: 'skip', createdAt: NOW, effect: { messages: 3, senders: 1 } };
    h.on('GET', '/triage/rules', () => ({ status: 200, body: { rules: [rule] } }));
    await h.store.loadRules();
    expect(h.store.getState().rules.list).toHaveLength(1);
    expect(rulesWithPending(h.store.getState().rules.list, [{ id: 'x', key: 'k', kind: 'rule.delete', args: { id: 'tr_1' }, label: '', createdAt: 0, attempts: 0 }])).toEqual([]);
    h.on('DELETE', '/triage/rules/tr_1', () => ({ status: 200, body: { removed: { id: 'tr_1', match: 'sender', value: 'news@medium.example', verdict: 'skip' }, message: "Undone. I'll sort messages from news@medium.example as usual again." } }));
    const r = await h.store.act('rule.delete', { id: 'tr_1' }, 'Remove a rule');
    expect(r).toMatchObject({ ok: true, message: "Undone. I'll sort messages from news@medium.example as usual again." });
    expect(h.writes().at(-1)).toMatchObject({ method: 'DELETE', path: '/triage/rules/tr_1' });
    expect(h.store.getState().rules.list).toEqual([]);
  });

  it('a reply draft is saved through the outbox (never sent); its refusal comes back quietly', async () => {
    const h = harness();
    h.on('GET', '/sync', () => sync(10, [], { reset: true }));
    await h.store.start();
    h.on('POST', '/mail/m_1/draft', (c) => ((c.body as { body: string }).body === 'no' ? refuse(409, 'read_only', 'This account was connected without drafting.')
      : { status: 201, body: { saved: true, sent: false, account: 'gmail', draftId: 'd1', alreadySaved: false, message: 'Saved to your drafts. Nothing was sent.', to: [], replyGoesElsewhere: false, replyNote: null } }));
    expect(await h.store.act('mail.draft', { id: 'm_1', body: 'Yes please.' }, 'Your reply draft', { quiet: true })).toMatchObject({ ok: true, message: 'Saved to your drafts. Nothing was sent.' });
    expect(h.writes().at(-1)!.body).toEqual({ body: 'Yes please.' });
    const n = h.store.getState().notices.length;
    // a refusal (read_only: drafting is not allowed on that account) comes back in the server's words, for the reader to show
    const r = await h.store.act('mail.draft', { id: 'm_1', body: 'no' }, 'Your reply draft', { quiet: true });
    expect(r).toMatchObject({ ok: false, message: 'This account was connected without drafting.' });
    expect(h.store.getState().notices.length).toBe(n);
  });
});

// ---------- the pure parts ----------
describe('what the screens show', () => {
  it('the skipped line', () => {
    expect(skipLine('today', { count: 5, kinds: { newsletter: 2, promotion: 2, receipt: 1 }, byYou: 0 })).toBe('I skipped 5 others today: newsletters, promotions, receipts');
    expect(skipLine('earlier', { count: 4, kinds: { receipt: 2, promotion: 1 }, byYou: 1 })).toBe('I skipped 4 others before that: what you marked not important, receipts, promotions');
    expect(skipLine('week', { count: 1, kinds: { notification: 1 }, byYou: 0 })).toBe('I skipped 1 other this week: notifications');
    expect(skipLine('week', { count: 0, kinds: {}, byYou: 0 })).toBeNull();
  });

  it('Not important offers only what the server can learn', () => {
    expect(scopeChoice(item('a', { fromAddress: 'orders@hillside.example', kind: 'receipt' })).options.map((o) => o.label)).toEqual(['Messages from orders@hillside.example', 'Everything from hillside.example', 'All receipts']);
    const free = scopeChoice(item('a', { fromAddress: 'Dana.Lee@Gmail.com', kind: 'work' }));
    expect(free.options.map((o) => o.scope)).toEqual(['sender']);
    expect(free.note).toMatch(/^gmail\.com is a free email service/);
    expect(scopeChoice(item('a', { source: 'calendar-conflict', fromAddress: null, mailId: null })).options).toEqual([]);
  });

  it('pending taps apply in order; a tap on an item no longer held is ignored', () => {
    const items = { a: item('a'), b: item('b') };
    const e = (kind: OutboxEntry['kind'], id: string): OutboxEntry => ({ id: `${kind}${id}`, key: 'k', kind, args: { id }, label: '', createdAt: 0, attempts: 0 });
    const v = withPending(items, [e('item.handled', 'a'), e('item.unhandle', 'a'), e('item.notImportant', 'b'), e('item.handled', 'zz')], NOW);
    expect(v.a.state).toBe('open');
    expect(v.b.state).toBe('not-important');
    expect(withPending(items, [], NOW)).toBe(items); // nothing pending: the same object (no re-render)
  });

  it('rule lines', () => {
    expect(ruleLine({ match: 'sender', value: 'x@y.example', verdict: 'skip' })).toBe('Skip messages from x@y.example');
    expect(ruleLine({ match: 'kind', value: 'newsletter', verdict: 'skip' })).toBe('Skip newsletters');
    expect(ruleLine({ match: 'domain', value: 'y.example', verdict: 'important' })).toBe('Show everything from y.example');
    expect(ruleEffectLine({ verdict: 'skip', effect: { messages: 14, senders: 3 } })).toBe('Hides 14 messages from 3 senders in your recent mail.');
    expect(ruleEffectLine({ verdict: 'important', effect: { messages: 1, senders: 1 } })).toBe('Shows 1 message in your recent mail.');
  });
});

// ---------- review of W3 ----------
describe('actions on the same item keep the order they were tapped in (review of W3)', () => {
  /** a server holding item a's real state */
  function serverModel(h: ReturnType<typeof harness>, gate?: Promise<void>) {
    let state: 'open' | 'handled' = 'open'; let seq = 10;
    const order: string[] = [];
    h.on('POST', '/items/a/handled', async () => { if (gate) await gate; order.push('handled'); state = 'handled'; return change(item('a', { state, handledAt: NOW, updatedSeq: ++seq }), 'Marked handled: Item a'); });
    h.on('POST', '/items/a/unhandle', async () => { order.push('unhandle'); state = 'open'; return change(item('a', { state, updatedSeq: ++seq }), 'Back on your list: Item a'); });
    return { get: () => state, order };
  }
  async function started() {
    const h = harness();
    h.on('GET', '/sync', () => sync(10, [item('a')], { reset: true }));
    await h.store.start();
    h.streams.at(-1)!.emit('hello', { cursor: 10, head: 10 });
    return h;
  }

  it('probe P1: Undo tapped while Handled is still on its way waits for it; the server ends open, as the person meant', async () => {
    const h = await started();
    const gate = deferred<void>();
    const srv = serverModel(h, gate.p);
    const p1 = h.store.act('item.handled', { id: 'a' }, 'Mark handled');
    await Promise.resolve();
    const p2 = h.store.act('item.unhandle', { id: 'a' }, 'Undo');
    await new Promise((r) => setTimeout(r, 5));
    expect(h.view().a.state).toBe('open'); // both shown at once, in order
    expect(h.writes().map((c) => c.path)).toEqual(['/items/a/handled']); // the Undo waits
    gate.resolve();
    expect((await p1).ok).toBe(true);
    expect((await p2).ok).toBe(true);
    await h.store.idle();
    expect(srv.order).toEqual(['handled', 'unhandle']);
    expect(srv.get()).toBe('open');
    expect(h.view().a.state).toBe('open');
    expect(h.store.getState().inflight).toEqual([]);
  });

  it('probe P2: Handled queued offline, the network back, Undo before the replay: it goes behind Handled; both reach the server in order', async () => {
    const h = await started();
    const srv = serverModel(h);
    h.setOnline(false);
    await h.store.act('item.handled', { id: 'a' }, 'Mark handled');
    // the network is back (the browser says online) but the store has not replayed yet: the person taps Undo now
    const env = (h.store as unknown as { env: { online: () => boolean } }).env;
    const was = env.online;
    env.online = () => true;
    const r = await h.store.act('item.unhandle', { id: 'a' }, 'Undo');
    env.online = was;
    expect(r).toMatchObject({ ok: false, queued: true });
    expect(h.view().a.state).toBe('open');
    h.setOnline(true);
    await new Promise((res) => setTimeout(res, 30));
    await h.store.idle();
    expect(srv.order).toEqual(['handled', 'unhandle']);
    expect(srv.get()).toBe('open');
    expect(h.store.getState().outbox).toEqual([]);
    expect(h.view().a.state).toBe('open');
  });

  it('both made offline: replayed in order', async () => {
    const h = await started();
    const srv = serverModel(h);
    h.setOnline(false);
    await h.store.act('item.handled', { id: 'a' }, 'Mark handled');
    await h.store.act('item.unhandle', { id: 'a' }, 'Undo');
    expect(h.view().a.state).toBe('open');
    h.setOnline(true);
    await new Promise((res) => setTimeout(res, 30));
    await h.store.idle();
    expect(srv.order).toEqual(['handled', 'unhandle']);
    expect(srv.get()).toBe('open');
  });

  it('probe P4: Handled lost to the network mid-flight (queued), then Undo online: Undo waits behind it in the outbox', async () => {
    const h = await started();
    const order: string[] = [];
    let first = true;
    h.on('POST', '/items/a/handled', () => { if (first) { first = false; return 'network'; } order.push('handled'); return change(item('a', { state: 'handled', handledAt: NOW, updatedSeq: 20 }), 'ok'); });
    h.on('POST', '/items/a/unhandle', () => { order.push('unhandle'); return change(item('a', { updatedSeq: 21 }), 'Back on your list: Item a'); });
    const r1 = await h.store.act('item.handled', { id: 'a' }, 'Mark handled');
    expect(r1.queued).toBe(true);
    const r2 = await h.store.act('item.unhandle', { id: 'a' }, 'Undo');
    expect(r2.queued).toBe(true);
    await h.store.replayOutbox();
    await h.store.idle();
    expect(order).toEqual(['handled', 'unhandle']);
    expect(h.store.getState().items.a.state).toBe('open');
    expect(h.store.getState().outbox).toEqual([]);
  });

  it('actions on different items do not wait for each other', async () => {
    const h = harness();
    h.on('GET', '/sync', () => sync(10, [item('a'), item('b')], { reset: true }));
    await h.store.start();
    const gate = deferred<{ status: number; body?: unknown }>();
    h.on('POST', '/items/a/handled', () => gate.p);
    h.on('POST', '/items/b/handled', () => change(item('b', { state: 'handled' }), 'ok'));
    const pa = h.store.act('item.handled', { id: 'a' }, 'a');
    expect((await h.store.act('item.handled', { id: 'b' }, 'b')).ok).toBe(true);
    gate.resolve(change(item('a', { state: 'handled' }), 'ok'));
    expect((await pa).ok).toBe(true);
  });
});

describe('answers about a thing (review of W3)', () => {
  const ask = (id: string, text: string, answer: string | null, extra: Partial<Ask> = {}): Ask => ({
    id, createdAt: NOW, text, projectId: 'general', route: null, kind: 'answer', mode: null, about: { kind: 'item', id: 'it_a' }, files: [], source: 'typed', plan: null,
    state: answer ? 'answered' : 'running', choice: null, jobId: null, runId: null, turnId: null, answer, tainted: true, capUsd: null, parentId: null, focus: null, updatedSeq: 1, ...extra,
  });
  it('asks are matched by id, not by their words: the same question asked twice keeps both (W4’s AskAbout, the one used everywhere)', () => {
    const mine = [{ q: 'Why does this matter?', askId: 'ask_1' }, { q: 'Why does this matter?', askId: 'ask_2' }, { q: 'Why does this matter?', askId: 'ask_2' }, { q: 'offline', askId: undefined }];
    expect(unshown([ask('ask_1', 'Why does this matter?', 'First answer.')], mine, (m) => m.askId).map((m) => m.askId)).toEqual(['ask_2', undefined]);
  });
  it('an answer that read the email says so, in the mail reader’s words, and its links show as hosts', () => {
    const html = renderToStaticMarkup(createElement(AnswerText, { text: 'Sign up at https://oakwoodpta.example/volunteer?ref=x.', tainted: true, note: 'Based on what the email says — check before acting' }));
    expect(html).toContain('Based on what the email says — check before acting');
    expect(html).toContain('Sign up at oakwoodpta.example.');
    expect(html).not.toMatch(/https?:/);
    expect(renderToStaticMarkup(createElement(AnswerText, { text: 'Fine.', tainted: false }))).not.toContain('check before acting');
  });
  it('links in an answer show as their host, by the same rule as the server sanitiser', () => {
    const samples = [
      'Sign in at https://evil.example/login?x=1 now.',
      'See hxxps://evil.example/path and www.evil.example/path and evil.example/login?x=1',
      'Go to <https://pay.example/a>, or //cdn.example/x.',
      'redirect url=https://evil.example/r and ftp://files.example/a',
      'Nothing to change here.',
    ];
    for (const t of samples) expect(clientLinksToHosts(t)).toBe(serverLinksToHosts(t));
    expect(clientLinksToHosts('Sign in at https://evil.example/login?x=1 now.')).toBe('Sign in at evil.example now.');
  });
});

describe('sender names never hide the address, client side too (review of W3)', () => {
  it('the probe cases, the same as the server', () => {
    const cases = [
      'Coach Ellen Park <ellen@willowcreekfarm.example> · Willow Creek Farm Office',
      'PayPal Service moc.lapyap@ecivres <service@paypal.com>',
      'PayPal Support Team (service@paypal.com) Account Security Department Notifications Center',
      'service@paypal.com', 'Coach Ellen',
    ];
    for (const c of cases) expect(showName(c)).toBe(serverDisplayName(c));
    expect(showName(cases[0])).toBe('Coach Ellen Park · Willow Creek Farm Office');
    expect(showName(cases[1])).toBe('PayPal Service');
    expect(showName(cases[2])!.length).toBeLessThanOrEqual(60);
  });
});

describe('a phishing item never offers its action; an unverified one keeps it (review of W3)', () => {
  it('rowAction', () => {
    const add = { kind: 'add-to-calendar' as const, label: 'Add to calendar' };
    expect(rowAction(item('a', { caution: 'phishing', action: add }))).toBeNull();
    expect(rowAction(item('a', { caution: 'unverified', action: add }))).toEqual(add);
    expect(rowAction(item('a', { action: { kind: 'review-reply', label: 'Open' } }))).toBeNull(); // the row itself opens it
  });
});
