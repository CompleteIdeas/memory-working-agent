// v2 build, slice W3: fixture mode for the Important list, the mail reader and "Ask about this"
// (web/src/v2/dev/fixtures-important.ts) answers with the contract's shapes — every response is validated against
// api/openapi.yaml — and behaves like the server where the screens rely on it: the receipts, the refusals in the
// server's words (a free email domain, a kind the headers cannot establish), rules and their effect, the skipped
// lists, answers kept under the item, and the `important` collection on /sync and the stream.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { FixtureServer, type StreamMessage } from '../web/src/v2/dev/fixtures';
import type { Ask, ImportantItem, ImportantList, ItemChange } from '../web/src/v2/api/client';

const spec = parse(readFileSync(new URL('../api/openapi.yaml', import.meta.url), 'utf8'));
const ajv = new (Ajv2020 as unknown as typeof Ajv2020.default)({ strict: false, allErrors: true });
(addFormats as unknown as typeof addFormats.default)(ajv);
ajv.addSchema({ $id: 'spec', components: spec.components });
const compiled = new Map<string, ReturnType<typeof ajv.compile>>();
function validator(path: string, method: string, status: number) {
  const k = `${method} ${path} ${status}`;
  if (!compiled.has(k)) {
    const op = spec.paths[path][method];
    const r = op.responses[String(status)] ?? op.responses.default;
    const resolved = r.$ref ? spec.components.responses[r.$ref.split('/').pop()] : r;
    compiled.set(k, ajv.compile(JSON.parse(JSON.stringify(resolved.content['application/json'].schema).replace(/"#\/components\//g, '"spec#/components/'))));
  }
  return compiled.get(k)!;
}
function valid(path: string, method: string, res: { status: number; body: unknown }) {
  const fn = validator(path, method, res.status);
  expect(fn(res.body) ? null : `${method.toUpperCase()} ${path} ${res.status}: ${ajv.errorsText(fn.errors)}`).toBeNull();
  return res;
}
const H = { 'x-mwa-client': 'web/1.0.0' };
const get = (s: FixtureServer, path: string, q = '') => s.handle({ method: 'GET', path, query: new URLSearchParams(q), headers: H, body: undefined });
let k = 0;
const send = (s: FixtureServer, method: string, path: string, body?: unknown, key = `w3-key-${++k}`) => s.handle({ method, path, query: new URLSearchParams(), headers: { ...H, 'idempotency-key': key }, body });
const post = (s: FixtureServer, path: string, body?: unknown, key?: string) => send(s, 'POST', path, body, key);
const world = (scenario = 'N00') => { const s = new FixtureServer(scenario); s.answerDelay = 0; return s; };
const openItems = (s: FixtureServer) => (get(s, '/items').body as ImportantList).groups.flatMap((g) => g.items);
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('W3 fixture mode answers with the contract\'s shapes', () => {
  it('every read the Important screen, the reader and Ask about this use', () => {
    for (const scenario of ['N00', 'sorting']) {
      const s = world(scenario);
      expect((get(s, '/meta').body as { features: string[] }).features).toEqual(expect.arrayContaining(['important', 'ask']));
      valid('/items', 'get', get(s, '/items'));
      valid('/items', 'get', get(s, '/items', 'state=handled'));
      valid('/items', 'get', get(s, '/items', 'group=week'));
      valid('/items', 'get', get(s, '/items', 'state=nope')); // 400 bad_state, the error shape
      valid('/items/skipped', 'get', get(s, '/items/skipped'));
      valid('/items/skipped', 'get', get(s, '/items/skipped', 'group=today'));
      valid('/triage/rules', 'get', get(s, '/triage/rules'));
      for (const id of ['m_m1', 'm_m2', 'm_px1', 'm_px2', 'm_sk_today_0']) valid('/mail/{id}', 'get', get(s, `/mail/${id}`));
      valid('/sync', 'get', get(s, '/sync', 'collections=jobs,calendar,projects,turns,important'));
      valid('/ask/suggestions', 'get', get(s, '/ask/suggestions', 'about=item:it_bookfair'));
      valid('/ask/suggestions', 'get', get(s, '/ask/suggestions', 'about=mail:m_m1'));
      valid('/ask', 'get', get(s, '/ask', 'about=mail:m_m1'));
    }
  });

  it('every write it acts on', async () => {
    const s = world();
    valid('/items/{id}/handled', 'post', post(s, '/items/it_board/handled'));
    valid('/items/{id}/unhandle', 'post', post(s, '/items/it_board/unhandle'));
    valid('/items/{id}/not-important', 'post', post(s, '/items/it_hillside/not-important', { scope: 'kind' })); // 400
    valid('/items/{id}/not-important', 'post', post(s, '/items/it_dana/not-important', { scope: 'domain' })); // 400
    valid('/items/{id}/not-important', 'post', post(s, '/items/it_hillside/not-important', { scope: 'sender' }));
    valid('/items/{id}/not-important', 'post', post(s, '/items/it_entries/not-important', { scope: 'kind' }));
    valid('/items/{id}/not-important', 'post', post(s, '/items/it_quotes/not-important'));
    valid('/items/{id}/action', 'post', post(s, '/items/it_clash/action'));
    valid('/items/{id}/action', 'post', post(s, '/items/it_ellen/action'));
    valid('/items/{id}/action', 'post', post(s, '/items/it_quotes/action')); // 409 not_open (not important now)
    const s2 = world();
    valid('/items/{id}/action', 'post', post(s2, '/items/it_bookfair/action')); // 201 a draft
    valid('/items/{id}/action', 'post', post(s2, '/items/it_entries/action')); // a reminder
    valid('/mail/{id}/important', 'post', post(s2, '/mail/m_sk_today_0/important'));
    valid('/mail/{id}/draft', 'post', post(s2, '/mail/m_m1/draft', { body: 'Yes please.' }));
    valid('/mail/{id}/draft', 'post', post(s2, '/mail/m_m1/draft', { body: ' ' })); // 400
    valid('/important/refresh', 'post', post(s2, '/important/refresh'));
    valid('/triage/rules/{id}', 'delete', send(s2, 'DELETE', '/triage/rules/tr_seed_medium'));
    valid('/triage/rules/{id}', 'delete', send(s2, 'DELETE', '/triage/rules/tr_seed_medium')); // 404
    const a = valid('/ask', 'post', post(s2, '/ask', { text: 'Who else is going?', about: { kind: 'item', id: 'it_bookfair' } }));
    valid('/ask', 'post', post(s2, '/ask', { text: 'Why does this matter?', about: { kind: 'mail', id: 'm_m3' } }));
    await tick();
    valid('/ask/{id}', 'get', get(s2, `/ask/${(a.body as { askId: string }).askId}`));
    valid('/ask', 'get', get(s2, '/ask', 'about=item:it_bookfair'));
    valid('/items', 'get', get(s2, '/items'));
  });
});

describe('W3 fixture mode behaves like the server', () => {
  it('the list: groups, the phishing and unverified items, the sender address on outside items, the skipped counts', () => {
    const s = world();
    const l = get(s, '/items').body as ImportantList;
    expect(l.groups.map((g) => `${g.label}:${g.items.length}`)).toEqual(['Today:6', 'This week:3', 'Earlier:2']);
    const all = l.groups.flatMap((g) => g.items);
    expect(all.find((i) => i.id === 'it_phish')).toMatchObject({ caution: 'phishing', trust: 'untrusted', fromAddress: 'service@paypa1-security.example' });
    expect(all.find((i) => i.id === 'it_unverified')).toMatchObject({ caution: 'unverified', group: 'week' });
    expect(all.filter((i) => i.trust === 'untrusted').every((i) => !!i.fromAddress)).toBe(true);
    expect(l.skipped.today).toEqual({ count: 5, kinds: { newsletter: 2, receipt: 1, promotion: 2 }, byYou: 0 });
    expect(l.skipped.earlier.byYou).toBe(1); // Medium, by last week's rule
    expect(l.sorting).toMatchObject({ mode: 'full', waiting: 0, olderUnsorted: 0, note: null });
    expect((get(world('sorting'), '/items').body as ImportantList).sorting.note).toMatch(/3 messages are waiting to be sorted\. Older mail \(120 messages more than 2 days old\) wasn't sorted yet\./);
  });

  it('handled and its undo; an item marked not important cannot be un-handled', () => {
    const s = world();
    const h = post(s, '/items/it_board/handled');
    expect(h.body).toMatchObject({ message: 'Marked handled: Board call moved to Wednesday 2pm', already: false, item: { state: 'handled' } });
    expect((get(s, '/items').body as ImportantList).handledCount).toBe(1);
    expect(post(s, '/items/it_board/unhandle').body).toMatchObject({ message: 'Back on your list: Board call moved to Wednesday 2pm', item: { state: 'open' } });
    expect(post(s, '/items/it_board/unhandle').body).toMatchObject({ already: true, message: 'It is already on your list.' });
    post(s, '/items/it_quotes/not-important');
    expect(post(s, '/items/it_quotes/unhandle')).toMatchObject({ status: 409, body: { error: { code: 'not_handled' } } });
  });

  it('not important: sender, the refusals in the server\'s words, a kind with its effect, and the rule applied now', () => {
    const s = world();
    const freemail = post(s, '/items/it_dana/not-important', { scope: 'domain' });
    expect(freemail).toMatchObject({ status: 400, body: { error: { code: 'freemail_domain' } } });
    expect((freemail.body as { error: { message: string } }).error.message).toBe('gmail.com is a free email service: skipping it would hide everyone who uses it, people you know included. Choose "messages from dana.lee.news@gmail.com" instead.');
    const kind = post(s, '/items/it_hillside/not-important', { scope: 'kind' });
    expect(kind).toMatchObject({ status: 400, body: { error: { code: 'kind_not_available' } } });
    expect(openItems(s).some((i) => i.id === 'it_hillside')).toBe(true); // a refusal changes nothing
    const ok = post(s, '/items/it_hillside/not-important', { scope: 'sender' }).body as ItemChange;
    expect(ok).toMatchObject({ message: "Got it. I'll skip messages like this from orders@hillside.example.", rule: { match: 'sender', value: 'orders@hillside.example' }, item: { state: 'not-important' } });
    expect(openItems(s).some((i) => i.id === 'it_hillside')).toBe(false);
    const news = post(s, '/items/it_entries/not-important', { scope: 'kind' }).body as ItemChange;
    expect(news.message).toMatch(/^Got it\. I'll skip newsletters\. This will hide mail from \d+ senders \(\d+ messages now\)\.$/);
    expect(news.effect!.senders).toBeGreaterThan(1);
    // the newsletter rule decides the book fair's newsletter too: it leaves, skipped "by you"
    expect(openItems(s).some((i) => i.id === 'it_bookfair')).toBe(false);
    expect((get(s, '/items').body as ImportantList).skipped.today.byYou).toBeGreaterThan(0);
    expect((get(s, '/triage/rules').body as { rules: { value: string }[] }).rules.map((r) => r.value)).toEqual(['news@medium.example', 'orders@hillside.example', 'newsletter']);
    expect(post(s, '/items/it_clash/not-important').body).toMatchObject({ rule: null, message: "Got it. I've taken it off your list." });
  });

  it('this was important; a rule removed is sorted as usual again', () => {
    const s = world();
    const r = post(s, '/mail/m_sk_today_0/important').body as ItemChange;
    expect(r).toMatchObject({ message: "Thanks — I'll show messages like this from The Batch.", rule: { match: 'sender', value: 'news@thebatch.example' }, item: { title: 'This week in AI', state: 'open', group: 'today' } });
    expect((get(s, '/items/skipped', 'group=today').body as { count: number }).count).toBe(4);
    const d = send(s, 'DELETE', '/triage/rules/tr_seed_medium').body as { message: string };
    expect(d.message).toBe("Undone. I'll sort messages from news@medium.example as usual again.");
    expect((get(s, '/items').body as ImportantList).skipped.earlier.byYou).toBe(0);
  });

  it('the item\'s action: a calendar DRAFT, a reminder, or where to go', () => {
    const s = world();
    const add = post(s, '/items/it_bookfair/action');
    expect(add).toMatchObject({ status: 201, body: { done: true, message: 'Added to your calendar as a draft. Confirm it in MWA.', draft: { kind: 'draft', state: 'draft', origin: 'helper-after-reading' }, item: { action: null } } });
    expect(post(s, '/items/it_bookfair/action')).toMatchObject({ status: 409, body: { error: { code: 'no_action' } } });
    expect(post(s, '/items/it_entries/action').body).toMatchObject({ done: true, message: "I'll remind you Fri Nov 13 at 9am." });
    expect(post(s, '/items/it_ellen/action').body).toMatchObject({ done: false, route: { view: 'mail', mailId: 'm_m1' } });
    expect(post(s, '/items/it_clash/action').body).toMatchObject({ done: false, route: { view: 'ask', item: 'it_clash', about: { kind: 'conflict' } } });
  });

  it('the reader: a reply that would go elsewhere says so; a draft is saved and never sent', () => {
    const s = world();
    expect(get(s, '/mail/m_px1').body).toMatchObject({ replyGoesElsewhere: true, replyNote: 'Your reply will go to resolve-team@protonmail.com (not the sender).', trust: 'untrusted', imagesHidden: 2, trackersRemoved: 1 });
    expect(get(s, '/mail/m_m1').body).toMatchObject({ replyGoesElsewhere: false, replyNote: null });
    expect(post(s, '/mail/m_m1/draft', { body: 'Yes please.' })).toMatchObject({ status: 201, body: { saved: true, sent: false, message: 'Saved to your drafts. Nothing was sent.' } });
  });

  it('ask about an item: the question appears under it at once, the answer when written, and it is kept in the project', async () => {
    const s = world();
    const got: StreamMessage[] = [];
    const head = (get(s, '/sync').body as { cursor: number }).cursor;
    const off = s.openStream(head, (m) => got.push(m));
    expect(get(s, '/ask/suggestions', 'about=item:it_bookfair').body).toMatchObject({ about: { label: 'Book fair · Sat Nov 14' }, suggestions: ['Who else is going?', 'Remind me the day before', 'What did the newsletter say about it?'] });
    const a = post(s, '/ask', { text: 'Who else is going?', about: { kind: 'item', id: 'it_bookfair' } });
    expect(a).toMatchObject({ status: 202, body: { kind: 'answer', about: { kind: 'item', id: 'it_bookfair' }, route: { projectId: 'family', confidence: 'about' }, tainted: true } });
    const items = () => got.filter((m) => m.event === 'change' && (m.data as { entity: string }).entity === 'item').map((m) => (m.data as { data: ImportantItem }).data);
    expect(items().at(-1)!.qa).toMatchObject([{ q: 'Who else is going?', a: null }]);
    await tick();
    expect(items().at(-1)!.qa[0].a).toMatch(/^Sam’s family is going/);
    const v = get(s, `/ask/${(a.body as { askId: string }).askId}`).body as { ask: Ask; turn: { provenance: { name: string }[]; message: string } };
    expect(v.ask.state).toBe('answered');
    expect(v.turn).toMatchObject({ message: 'About Book fair · Sat Nov 14: Who else is going?', provenance: [{ name: 'Eventing' }] });
    expect((get(s, '/ask', 'about=item:it_bookfair').body as { asks: Ask[] }).asks).toHaveLength(1);
    expect(post(s, '/ask', { text: 'x', about: { kind: 'item', id: 'it_nope' } }).status).toBe(404);
    off();
  });

  it('the important collection: a snapshot holds open and handled items; a delta deletes what left the list', () => {
    const s = world();
    post(s, '/items/it_board/handled');
    const snap = get(s, '/sync', 'collections=important').body as { reset: boolean; cursor: number; upserts: { important: ImportantItem[] } };
    expect(snap.reset).toBe(true);
    expect(snap.upserts.important.find((i) => i.id === 'it_board')?.state).toBe('handled');
    post(s, '/items/it_quotes/not-important');
    const d = get(s, '/sync', `since=${snap.cursor}&collections=important`).body as { upserts: { important: ImportantItem[] }; deletes: { important: string[] } };
    expect(d.deletes.important).toEqual(['it_quotes']);
    expect(d.upserts.important).toEqual([]);
    expect(get(s, '/sync', 'collections=bogus').status).toBe(400);
  });
});
