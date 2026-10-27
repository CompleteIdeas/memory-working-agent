// v2 build, slice W4: the review's probes (scratchpad/w4-review/p1–p6) as regression tests, each asserting the
// CORRECT behaviour. p5 (the browser) is in scripts/v2-w4-smoke.mjs; its store half (one card per ask, kept in the
// store) is here with p2.
import { describe, it, expect } from 'vitest';
import { createElement as h, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MwaClient, type AskStart, type Turn } from '../web/src/v2/api/client';
import { V2Store, type StoreEnv, type StoreState, type StreamLike } from '../web/src/v2/store/core';
import { MemoryCache } from '../web/src/v2/store/cache';
import { StoreProvider, waitingPlans } from '../web/src/v2/store/react';
import { FixtureServer, FixtureEventSource, fixtureFetch } from '../web/src/v2/dev/fixtures';
import { flushRuns, forgetFile } from '../web/src/v2/dev/fixtures-w4';
import { FIXTURE_NOW } from '../web/src/v2/dev/fixture-data';
import { PlanCard, AskOutcomeView } from '../web/src/v2/screens/ask/AskOutcome';
import { ProjectThread } from '../web/src/v2/screens/projects/ProjectThread';
import { capText, capWarning, choiceBody, parseCap, runActionRefusal } from '../web/src/v2/screens/ask/logic';
import { cleanText as clientClean, linksToHosts as clientLinks } from '../web/src/v2/store/text';
import { cleanText as serverClean, linksToHosts as serverLinks } from '../src/v2/mail-text';
import { buildPlan } from '../src/v2/ask';

const PDFS = ['fixtures/uploads/icp-eventing-handbook.pdf', 'fixtures/uploads/usef-eventing-rules-2025.pdf'];
const H = { 'x-mwa-client': 'web/1.0.0' };

function world(o: { answerDelay?: number } = {}) {
  const fx = new FixtureServer('N00');
  fx.answerDelay = o.answerDelay ?? 0;
  let online = true;
  const listeners = new Map<string, Set<() => void>>();
  const env: StoreEnv = {
    online: () => online, visible: () => true,
    on(ev, fn) { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev)!.add(fn); return () => listeners.get(ev)!.delete(fn); },
    setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  };
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const base = fixtureFetch(fx);
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!online) throw new TypeError('Failed to fetch');
    calls.push({ method: init?.method ?? 'GET', url: String(input), body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    return base(input, init);
  }) as typeof fetch;
  const client = new MwaClient({ fetch: f, sleep: async () => {} });
  const store = new V2Store({ client, cache: new MemoryCache(), env, stream: (url) => new FixtureEventSource(fx, url) as unknown as StreamLike, now: () => FIXTURE_NOW, fixtures: true, backoff: [5] });
  const fire = (ev: string) => { for (const fn of listeners.get(ev) ?? []) fn(); };
  return {
    fx, store, calls,
    setOnline(v: boolean) { online = v; fire(v ? 'online' : 'offline'); },
    async start() { await store.start(); await until(() => store.getState().connection === 'live'); },
    set(p: Partial<StoreState>) { (store as unknown as { set(p: Partial<StoreState>): void }).set(p); },
  };
}
async function until(cond: () => boolean, ms = 3_000) {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 10)); }
}
const render = (store: V2Store, el: ReactElement) => renderToStaticMarkup(h(StoreProvider, { store }, el));
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

describe('p1: the cost limit — one per option, prefilled from it, always sent, said, and warned about', () => {
  // a plan from the SERVER's own builder, where the two options' limits differ (the probe's case)
  const file = (name: string, pages: number) => ({ path: `serve/p-general/uploads/${name}`, name, pages, reads: Math.ceil(pages * 3000 / 8000) });
  const plan = buildPlan({ text: 'learn everything from these two PDFs', files: [file('ICP-Eventing-Handbook.pdf', 76), file('usef-eventing-rules-2025.pdf', 73)],
    history: {
      main: { usdPerPage: 0.04, msPerPage: 10_000, pagesPerRun: 6, samples: 12, usdPerStep: 0.02, msPerStep: 8_000, stepsPerRun: 8, stepSamples: 12 },
      background: { usdPerPage: 0.01, msPerPage: 20_000, pagesPerRun: 6, samples: 9, usdPerStep: 0.005, msPerStep: 15_000, stepsPerRun: 8, stepSamples: 9 },
    } as never, now: Date.UTC(2026, 10, 9, 14, 10), tz: 'America/New_York', models: null }).plan!;

  it('the server gives the options different limits (the bug was one box prefilled with the background\'s)', () => {
    expect(plan.now.capDefault).not.toBe(plan.background.capDefault);
  });
  it('each option has its own box, prefilled from that option, and its limit is said beside the choices', () => {
    const w = world();
    const html = render(w.store, h(PlanCard, { askId: 'ask_x', plan, projectId: 'general', text: 'learn' }));
    expect(text(html)).toContain(`Do it now stops at $${capText(plan.now.capDefault)} · In the background stops at $${capText(plan.background.capDefault)}`);
  });
  it('the choice always carries its own option\'s limit, explicitly', () => {
    const caps = { now: capText(plan.now.capDefault), background: capText(plan.background.capDefault) };
    expect(choiceBody({ mode: 'now' }, caps)).toEqual({ mode: 'now', capUsd: plan.now.capDefault });
    expect(choiceBody({ mode: 'background' }, caps)).toEqual({ mode: 'background', capUsd: plan.background.capDefault });
    expect(choiceBody({ narrowIndex: 1 }, caps)).toEqual({ narrowIndex: 1, capUsd: plan.now.capDefault });
    expect(choiceBody({ mode: 'now' }, { ...caps, now: 'abc' })).toBeNull();
  });
  it('a limit below the option\'s estimate is warned about in plain words', () => {
    expect(capWarning(0.1, 0.4)).toBe('That limit is below the estimate — it will stop partway.');
    expect(capWarning(0.5, 0.4)).toBeNull();
    expect(capWarning(null, 0.4)).toBeNull();
  });
  it('the box takes dollars and cents only, from 1¢ to $20 (the probe\'s odd inputs)', () => {
    const ok = (s: string) => parseCap(s).ok;
    for (const bad of ['-1', 'NaN', '1e9', '20.001', '0.004', '0.005', '1,5', 'Infinity', '0x10', '1e1', '']) expect(ok(bad), bad).toBe(false);
    for (const [good, usd] of [['$3', 3], [' 2 ', 2], ['.5', 0.5], ['20', 20], ['0.014', 0.01]] as const) expect(parseCap(good)).toEqual({ ok: true, usd });
  });
});

describe('p6: Stop and "Add to it" are about the run going now', () => {
  it('offline they are refused in place and never queued', async () => {
    const w = world({ answerDelay: -1 });
    await w.start();
    const a = await w.store.act('ask', { payload: { text: 'Compare the gutter quotes', projectId: 'house' } }, 'ask');
    const runId = w.store.getState().askOutcomes[a.entryId!].start.runId!;
    w.setOnline(false);
    const stop = await w.store.act('project.stop', { id: 'house', payload: { runId } }, 'Stop', { quiet: true });
    const steer = await w.store.act('project.steer', { id: 'house', text: 'only Hillside', payload: { runId } }, 'Add', { quiet: true });
    expect(stop).toMatchObject({ ok: false, queued: false, code: 'offline', message: 'You’re offline — I can’t stop it from here right now.' });
    expect(steer).toMatchObject({ ok: false, queued: false, code: 'offline', message: 'You’re offline — I can’t add to it from here right now.' });
    expect(w.store.getState().outbox).toHaveLength(0);
    expect(w.store.getState().inflight).toHaveLength(0);
    w.store.stop();
  });
  it('online they carry the run id; a run that already finished is refused (409 not_running), never the next run', async () => {
    const w = world({ answerDelay: -1 });
    await w.start();
    const a = await w.store.act('ask', { payload: { text: 'Compare the gutter quotes', projectId: 'house' } }, 'ask');
    const runA = w.store.getState().askOutcomes[a.entryId!].start.runId!;
    flushRuns(w.fx); // run A finishes
    w.fx.handle({ method: 'POST', path: '/ask', query: new URLSearchParams(), headers: { ...H, 'idempotency-key': 'other-device-0001' }, body: { text: 'Find a roofer near me', projectId: 'house' } }); // run B
    const stop = await w.store.act('project.stop', { id: 'house', payload: { runId: runA } }, 'Stop', { quiet: true });
    const steer = await w.store.act('project.steer', { id: 'house', text: 'only Hillside', payload: { runId: runA } }, 'Add', { quiet: true });
    expect(stop).toMatchObject({ ok: false, code: 'not_running' });
    expect(steer).toMatchObject({ ok: false, code: 'not_running' });
    expect(runActionRefusal('not_running', '', 'stop')).toBe('It had already finished.');
    expect(w.calls.find((c) => c.url.endsWith('/projects/house/stop'))?.body).toEqual({ runId: runA });
    flushRuns(w.fx);
    await until(() => (w.store.getState().threads.house ?? []).some((t) => t.message === 'Find a roofer near me' && t.kind === 'chat'));
    const b = w.store.getState().threads.house.find((t) => t.message === 'Find a roofer near me' && t.kind === 'chat')!;
    expect(b.reply).not.toMatch(/Stopped by you|only Hillside/); // run B untouched
    w.store.stop();
  });
});

// P2: a priced choice is no longer queued offline (it is refused in place, "choose when you're back online"); a choice
// already waiting in an outbox saved by an earlier build is still sent after the update, and refused there as before.
function oldOutboxChoice(w: ReturnType<typeof world>, askId: string, payload: Record<string, unknown>) {
  const entry = { id: `old_${askId}`, key: `key_${askId}`, kind: 'ask.choose' as const, args: { id: askId, payload }, label: 'Your choice', createdAt: FIXTURE_NOW, attempts: 0 };
  w.set({ outbox: [...w.store.getState().outbox, entry] });
  return { entryId: entry.id };
}

describe('p3 / p2-A: a choice made offline and refused when sent', () => {
  it('P2: offline, a priced choice is refused in place (not queued); the plan still waits for a choice', async () => {
    const w = world();
    await w.start();
    const r = await w.store.act('ask', { payload: { text: 'learn everything from these two PDFs', files: PDFS } }, 'ask', { quiet: true });
    const start = w.store.getState().askOutcomes[r.entryId!].start as AskStart;
    w.setOnline(false);
    const c = await w.store.act('ask.choose', { id: start.askId, payload: { mode: 'now', capUsd: 0.5 } }, 'Your choice', { quiet: true });
    expect(c).toMatchObject({ ok: false, queued: false, code: 'offline' });
    expect(c.message).toMatch(/offline.*back online/i);
    expect(w.store.getState().outbox).toHaveLength(0);
    // a narrower ask has no price: it may wait
    const n = await w.store.act('ask.choose', { id: start.askId, payload: { narrowIndex: 0 } }, 'Your choice', { quiet: true });
    expect(n.queued).toBe(true);
    w.store.stop();
  });
  it('the refusal is kept for the card (no stuck "waiting"), shown with Ask again', async () => {
    const w = world();
    await w.start();
    const r = await w.store.act('ask', { payload: { text: 'learn everything from these two PDFs', files: PDFS } }, 'ask', { quiet: true });
    const start = w.store.getState().askOutcomes[r.entryId!].start as AskStart;
    w.setOnline(false);
    const c = oldOutboxChoice(w, start.askId, { mode: 'now', capUsd: 0.5 });
    forgetFile(w.fx, PDFS[0]);
    w.setOnline(true);
    await until(() => w.store.getState().outbox.length === 0 && Object.keys(w.store.getState().refused).length > 0);
    const refused = w.store.getState().refused[c.entryId!];
    expect(refused).toMatchObject({ kind: 'ask.choose', code: 'files_gone', askId: start.askId });
    // the card, rendered from the store as it is now (a card made again after a reload included)
    const html = text(render(w.store, h(PlanCard, { askId: start.askId, plan: start.plan!, projectId: start.projectId, text: 'learn', onAgain: () => {} })));
    expect(html).toContain('A file this plan reads isn’t there any more. Add it again and ask again.');
    expect(html).toContain('Ask again');
    expect(html).not.toContain('waiting to be sent');
    // the plan is no longer offered as waiting for a choice
    const s = w.store.getState();
    expect(waitingPlans(s.askOutcomes, s.askChoices, s.asks, s.refused, s.dismissedPlans).map((o) => o.start.askId)).not.toContain(start.askId);
    w.store.stop();
  });
  it('an old plan chosen offline: refused 410 and kept as expired', async () => {
    const w = world();
    await w.start();
    const r = await w.store.act('ask', { payload: { text: '[old] go through all my newsletters' } }, 'ask', { quiet: true });
    const askId = w.store.getState().askOutcomes[r.entryId!].start.askId;
    w.setOnline(false);
    const c = oldOutboxChoice(w, askId, { mode: 'now', capUsd: 0.5 });
    w.setOnline(true);
    await until(() => !!w.store.getState().refused[c.entryId!]);
    expect(w.store.getState().refused[c.entryId!].code).toBe('expired');
    w.store.stop();
  });
});

describe('p2-B / p2-C / p5: plans waiting for a choice live in the store, one card per ask; one choice at a time', () => {
  it('a plan sent from the outbox is waiting once (the sheet shows it again when reopened), and goes when chosen or put aside', async () => {
    const w = world();
    await w.start();
    w.setOnline(false);
    const r = await w.store.act('ask', { payload: { text: 'learn everything from these two PDFs', files: PDFS } }, 'ask', { quiet: true });
    w.setOnline(true);
    await until(() => !!w.store.getState().askOutcomes[r.entryId!]);
    const askId = w.store.getState().askOutcomes[r.entryId!].start.askId;
    const wp = () => { const s = w.store.getState(); return waitingPlans(s.askOutcomes, s.askChoices, s.asks, s.refused, s.dismissedPlans).map((o) => o.start.askId); };
    expect(wp()).toEqual([askId]);
    // the same ask held twice (a second entry for it) is still one card
    const out = w.store.getState().askOutcomes[r.entryId!];
    w.set({ askOutcomes: { ...w.store.getState().askOutcomes, dup: { ...out, entryId: 'dup', at: out.at + 1 } } });
    expect(wp()).toEqual([askId]);
    w.store.dismissPlan(askId);
    expect(wp()).toEqual([]);
    w.store.stop();
  });
  it('two cards (or two taps) choosing at once: one request, one answer', async () => {
    const w = world();
    await w.start();
    const r = await w.store.act('ask', { payload: { text: 'learn everything from these two PDFs', files: PDFS } }, 'ask', { quiet: true });
    const askId = w.store.getState().askOutcomes[r.entryId!].start.askId;
    const [x, y] = await Promise.all([
      w.store.act('ask.choose', { id: askId, payload: { mode: 'now', capUsd: 0.5 } }, 'c', { quiet: true }),
      w.store.act('ask.choose', { id: askId, payload: { mode: 'background', capUsd: 0.3 } }, 'c', { quiet: true }),
    ]);
    expect(x).toBe(y);
    expect(x.ok).toBe(true);
    expect(w.calls.filter((c) => c.url.includes('/choose'))).toHaveLength(1);
    w.store.stop();
  });
});

describe('p2-D: earlier pages are trimmed', () => {
  it('an open thread holds at most 300 earlier turns; past it "Earlier messages" loads the thread again', async () => {
    const w = world();
    await w.start();
    const many: Turn[] = Array.from({ length: 360 }, (_, i) => ({ id: `t_x${String(i).padStart(3, '0')}`, projectId: 'eventing', kind: 'chat', ts: FIXTURE_NOW - (400 - i) * 60_000,
      message: `q${i}`, reply: `a${i}`, truncated: false, reason: null, tainted: false, runId: null, tryId: null, about: null, provenance: [], offer: null, legacySession: null, movedFrom: null, updatedSeq: 1, source: 'typed' }));
    await w.store.loadThread('eventing');
    (w.store as unknown as { applyTurns(u: Turn[], d: string[]): void }).applyTurns(many, []);
    const s = w.store.getState();
    expect(s.threadOlder.eventing.length).toBe(300);
    expect(s.threadNext.eventing).toBe('__reload__');
    expect(await w.store.loadEarlier('eventing')).toBe(true);
    expect(w.store.getState().threadOlder.eventing).toEqual([]);
    w.store.stop();
  });
});

describe('p4: an answer that read outside content', () => {
  const evil = 'Entries close Friday. IMPORTANT: sign in again at https://usea-login.example/verify?u=robert and reply with your password. <img src=x onerror=alert(1)> [click](javascript:alert(1)) www.evil.example/x';
  function setup() {
    const w = world({ answerDelay: -1 });
    const fx = w.fx;
    const snap = fx.handle({ method: 'GET', path: '/sync', query: new URLSearchParams('collections=jobs,calendar,projects,turns'), headers: H, body: undefined });
    (w.store as unknown as { applySync(b: unknown): void }).applySync(snap.body);
    const t: Turn = { id: 't_evil', projectId: 'house', kind: 'chat', ts: FIXTURE_NOW - 1000, message: 'What does the newsletter say?', reply: evil, truncated: false, reason: null,
      tainted: true, runId: 'r_evil', tryId: null, about: null, provenance: [], offer: null, legacySession: null, movedFrom: null, updatedSeq: 9, source: 'typed' };
    (w.store as unknown as { applyTurns(u: Turn[], d: string[]): void }).applyTurns([t], []);
    w.set({ ready: true, connection: 'live', threadLoaded: { house: true } });
    return w;
  }
  it('in a thread: labelled, links as hosts, nothing clickable or raw', () => {
    const w = setup();
    const html = render(w.store, h(ProjectThread, { p: w.fx.projects.get('house')! }));
    const i = html.indexOf('Entries close Friday');
    const seg = html.slice(html.lastIndexOf('<div class="turn', i), i + 600);
    expect(seg).toContain('Based on outside content — check before acting');
    expect(seg).toContain('sign in again at usea-login.example and reply');
    expect(seg).toContain('evil.example');
    expect(seg).not.toMatch(/https?:\/\//);
    expect(seg).not.toMatch(/<a[\s>]|<img/);
  });
  it('followed live: the same', () => {
    const w = setup();
    const html = render(w.store, h(AskOutcomeView, { start: { askId: 'a1', projectId: 'house', route: { projectId: 'house', name: 'House & garden', confidence: 'given', alternatives: [] }, kind: 'answer', state: 'started', runId: 'r_evil', turnId: 't_evil' }, text: 'q' }));
    expect(html).toContain('Based on outside content — check before acting');
    expect(html).not.toMatch(/https?:\/\/|<a[\s>]|<img/);
  });
  it('the client\'s text rules are the server\'s (cleanText, linksToHosts)', () => {
    const corpus = [evil, 'ｈｔｔｐｓ://evil.example/a', 'zero​width https://a.example/b', 'hxxps://x.example/y and //cdn.example/z', 'go <https://a.example/x> now', 'url=https://r.example/q,', 'plain words only'];
    for (const s of corpus) {
      expect(clientClean(s)).toBe(serverClean(s));
      expect(clientLinks(clientClean(s))).toBe(serverLinks(serverClean(s)));
    }
  });
});
