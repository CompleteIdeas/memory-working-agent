// v2 build, slice W4: the store's Ask, plan and project paths, end to end against fixture mode (the real typed client
// and the real store, the FixtureServer standing in for the helper — its answers are validated against the spec in
// tests/web-v2-fixtures.test.ts): the routing suggestion, an answer followed live, a plan's choices and its refusals
// (410 expired, 409 files_gone / archived / already_chosen), a narrower ask, thread paging, moving a turn, Stop and
// Steer, the offer, projects, and asks made offline waiting in the outbox with their key.
import { describe, it, expect } from 'vitest';
import { MwaClient, type AskStart, type AskChosen } from '../web/src/v2/api/client';
import { V2Store, type StoreEnv, type StreamLike } from '../web/src/v2/store/core';
import { MemoryCache } from '../web/src/v2/store/cache';
import { FixtureServer, FixtureEventSource, fixtureFetch } from '../web/src/v2/dev/fixtures';
import { flushRuns, forgetFile } from '../web/src/v2/dev/fixtures-w4';
import { FIXTURE_NOW } from '../web/src/v2/dev/fixture-data';
import { findAnswer } from '../web/src/v2/screens/ask/AskOutcome';
import { refusalFor } from '../web/src/v2/screens/ask/logic';

const PDFS = ['fixtures/uploads/icp-eventing-handbook.pdf', 'fixtures/uploads/usef-eventing-rules-2025.pdf'];

function world(scenario = 'N00', o: { answerDelay?: number } = {}) {
  const fx = new FixtureServer(scenario);
  fx.answerDelay = o.answerDelay ?? 0;
  let online = true;
  const listeners = new Map<string, Set<() => void>>();
  const env: StoreEnv = {
    online: () => online, visible: () => true,
    on(ev, fn) { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev)!.add(fn); return () => listeners.get(ev)!.delete(fn); },
    setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  };
  const calls: { method: string; url: string; key: string | null }[] = [];
  const base = fixtureFetch(fx);
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!online) throw new TypeError('Failed to fetch');
    calls.push({ method: init?.method ?? 'GET', url: String(input), key: new Headers(init?.headers ?? {}).get('idempotency-key') });
    return base(input, init);
  }) as typeof fetch;
  const client = new MwaClient({ fetch: f, sleep: async () => {} });
  const store = new V2Store({ client, cache: new MemoryCache(), env, stream: (url) => new FixtureEventSource(fx, url) as unknown as StreamLike, now: () => FIXTURE_NOW, fixtures: true, backoff: [5] });
  const fire = (ev: string) => { for (const fn of listeners.get(ev) ?? []) fn(); };
  return {
    fx, store, client, calls,
    setOnline(v: boolean) { online = v; fire(v ? 'online' : 'offline'); },
    async start() { await store.start(); await until(() => store.getState().connection === 'live'); },
  };
}
async function until(cond: () => boolean, ms = 3_000) {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 10)); }
}

describe('W4: Ask through the store', () => {
  it('routing: a suggestion while typing; inside a project, "this project"', async () => {
    const w = world();
    expect(await w.client.suggestProject({ text: 'Can Riley go to the book fair?' })).toMatchObject({ projectId: 'family', confidence: 'suggested' });
    expect(await w.client.suggestProject({ text: 'what is for dinner' })).toMatchObject({ projectId: 'general', confidence: 'not sure' });
    expect(await w.client.suggestProject({ text: 'riley and willow' })).toMatchObject({ projectId: 'general', confidence: 'not sure' });
    expect(await w.client.suggestProject({ text: 'the book fair', from: 'eventing' })).toMatchObject({ projectId: 'eventing', confidence: 'this project', alternatives: [{ projectId: 'family' }] });
  });

  it('an answer: kept by entry id, its progress on the stream, then the answer as a new turn with the same run', async () => {
    const w = world('N00', { answerDelay: -1 });
    await w.start();
    const r = await w.store.act('ask', { payload: { text: 'Can Riley go to the book fair?' } }, 'ask');
    expect(r.ok).toBe(true);
    const out = w.store.getState().askOutcomes[r.entryId!];
    expect(out.start).toMatchObject({ kind: 'answer', state: 'started', projectId: 'family', route: { name: 'Family & school', confidence: 'suggested' } });
    await until(() => (w.store.getState().threads.family ?? []).some((t) => t.kind === 'running'));
    let found = findAnswer(w.store.getState().threads.family, out.start);
    expect(found.running?.message).toBe('Can Riley go to the book fair?');
    expect(found.done).toBeUndefined();
    flushRuns(w.fx);
    await until(() => !!findAnswer(w.store.getState().threads.family, out.start).done);
    found = findAnswer(w.store.getState().threads.family, out.start);
    expect(found.done!.runId).toBe(out.start.runId);
    expect(found.done!.id).not.toBe(out.start.turnId); // the running turn retired
    expect(w.store.getState().threads.family.some((t) => t.id === out.start.turnId)).toBe(false);
    expect(w.store.getState().live['p-family']).toMatchObject({ type: 'step' });
    await until(() => w.store.getState().asks[out.start.askId]?.state === 'answered');
    w.store.stop();
  });

  it('a plan (N04): its words, then background → a job with the limit, kept by ask id; the same choice again replays', async () => {
    const w = world();
    await w.start();
    const r = await w.store.act('ask', { payload: { text: 'learn everything from these two PDFs', files: PDFS } }, 'ask');
    const start = w.store.getState().askOutcomes[r.entryId!].start as AskStart;
    expect(start.kind).toBe('plan');
    expect(start.plan!.message).toBe('This is a big read — 149 pages, about 20 minutes. Do it now, or in the background for less and I’ll tell you when it’s done?');
    expect(start.plan!.now.label).toBe('Do it now · about 40¢');
    expect(start.plan!.background.label).toBe('In the background · about 15¢ · ready around 10:10 AM');
    expect(start.plan!.narrow.map((n) => n.label)).toEqual(['Only icp eventing handbook · 76 pages, about 8¢', 'Only usef eventing rules 2025 · 73 pages, about 8¢', 'Just the rules for moving up a level']);
    expect(start.plan!.narrow[2]).not.toHaveProperty('usd'); // a model's narrower ask claims no price
    const c = await w.store.act('ask.choose', { id: start.askId, payload: { mode: 'background', capUsd: 0.5 } }, 'choose', { quiet: true });
    expect(c.ok).toBe(true);
    const chosen = w.store.getState().askChoices[start.askId] as AskChosen;
    expect(chosen).toMatchObject({ chosen: 'background', kind: 'job', capUsd: 0.5, readyAt: FIXTURE_NOW + 60 * 60_000 });
    await until(() => !!w.store.getState().jobs[chosen.jobId!]);
    expect(w.store.getState().jobs[chosen.jobId!]).toMatchObject({ title: 'Learning your 2 eventing PDFs', capUsd: 0.5, status: { state: 'working' } });
    // the same choice again: what the first did (no second job)
    const again = await w.client.chooseAsk(start.askId, { mode: 'background', capUsd: 0.5 });
    expect(again.jobId).toBe(chosen.jobId);
    // another choice: refused, quietly (the card says it in place, no notice)
    const before = w.store.getState().notices.length;
    const other = await w.store.act('ask.choose', { id: start.askId, payload: { mode: 'now' } }, 'choose', { quiet: true });
    expect(other).toMatchObject({ ok: false, code: 'already_chosen' });
    expect(w.store.getState().notices.length).toBe(before);
    w.store.stop();
  });

  it('a plan\'s refusals in plain words: 410 expired, 409 files_gone, 409 archived', async () => {
    const w = world();
    await w.start();
    const plan = async (text: string, files?: string[]) => {
      const r = await w.store.act('ask', { payload: { text, ...(files ? { files } : {}) } }, 'ask');
      return w.store.getState().askOutcomes[r.entryId!].start;
    };
    const old = await plan('[old] go through all my newsletters');
    expect(old.plan!.now.label).toBe('Do it now · a first guess, about 60¢');
    const e = await w.store.act('ask.choose', { id: old.askId, payload: { mode: 'now' } }, 'c', { quiet: true });
    expect(e).toMatchObject({ ok: false, code: 'expired' });
    expect(refusalFor(e.ok ? undefined : (e as { code?: string }).code, e.message ?? '')).toMatchObject({ text: 'This plan is old — ask again.', again: true });

    const gone = await plan('learn everything from these two PDFs', PDFS);
    forgetFile(w.fx, PDFS[0]);
    const g = await w.store.act('ask.choose', { id: gone.askId, payload: { mode: 'background' } }, 'c', { quiet: true });
    expect(g).toMatchObject({ ok: false, code: 'files_gone' });
    expect(refusalFor('files_gone', '').text).toBe('A file this plan reads isn’t there any more. Add it again and ask again.');

    const a2 = await w.client.ask({ text: 'review all the eventing rules', projectId: 'house' });
    await w.store.act('project.update', { id: 'house', payload: { archived: true } }, 'archive');
    const ar = await w.store.act('ask.choose', { id: a2.askId, payload: { mode: 'now' } }, 'c', { quiet: true });
    expect(ar).toMatchObject({ ok: false, code: 'archived' });
    expect(refusalFor('archived', (ar as { message: string }).message)).toMatchObject({ text: 'House & garden is archived. Restore it, or ask again somewhere else.', restore: true });
    w.store.stop();
  });

  it('a narrower ask is asked in turn and answered', async () => {
    const w = world();
    await w.start();
    const r = await w.store.act('ask', { payload: { text: 'learn everything from these two PDFs', files: PDFS, projectId: 'eventing' } }, 'ask');
    const start = w.store.getState().askOutcomes[r.entryId!].start;
    await w.store.act('ask.choose', { id: start.askId, payload: { narrowIndex: 0 } }, 'c', { quiet: true });
    const chosen = w.store.getState().askChoices[start.askId];
    expect(chosen.chosen).toBe('narrow');
    expect(chosen.narrowed).toMatchObject({ kind: 'answer', state: 'started', projectId: 'eventing' });
    await until(() => !!findAnswer(w.store.getState().threads.eventing ?? [], chosen.narrowed!).done);
    expect(findAnswer(w.store.getState().threads.eventing, chosen.narrowed!).done!.reply).toContain('76 pages');
    w.store.stop();
  });

  it('the older offer: offered, then accepted into a background job', async () => {
    const w = world();
    await w.start();
    const r = await w.store.act('ask', { payload: { text: 'research summer camps for Riley', projectId: 'family' } }, 'ask');
    const start = w.store.getState().askOutcomes[r.entryId!].start;
    expect(start).toMatchObject({ kind: 'answer', state: 'offer' });
    await until(() => (w.store.getState().threads.family ?? []).some((t) => t.kind === 'offer' && !t.offer));
    const acc = await w.store.act('project.offer', { id: 'family', text: 'research summer camps for Riley' }, 'offer');
    expect(acc.ok).toBe(true);
    await until(() => (w.store.getState().threads.family ?? []).some((t) => t.kind === 'offer' && t.offer?.answered === 'background'));
    expect(Object.values(w.store.getState().jobs).some((j) => j.title === 'Research summer camps for Riley')).toBe(true);
    expect(await w.store.act('project.offer', { id: 'family' }, 'offer', { quiet: true })).toMatchObject({ ok: false, code: 'no_offer' });
    w.store.stop();
  });
});

describe('W4: threads and projects through the store', () => {
  it('pages a long thread with `before` until the start, and keeps earlier pages apart from the latest 50', async () => {
    const w = world('thread-long');
    await w.start();
    await w.store.loadThread('eventing');
    const s0 = w.store.getState();
    expect(s0.threads.eventing).toHaveLength(50);
    expect(s0.threadNext.eventing).toMatch(/^ts:/);
    expect(await w.store.loadEarlier('eventing')).toBe(true);
    expect(w.store.getState().threadOlder.eventing).toHaveLength(30);
    expect(await w.store.loadEarlier('eventing')).toBe(true);
    const s = w.store.getState();
    expect(s.threadNext.eventing).toBeNull();
    expect(await w.store.loadEarlier('eventing')).toBe(false);
    const all = [...s.threadOlder.eventing, ...s.threads.eventing];
    expect(new Set(all.map((t) => t.id)).size).toBe(all.length);
    expect(all).toHaveLength([...w.fx.turns.values()].filter((t) => t.projectId === 'eventing').length);
    expect(all[0].message).toBe('Old question 1');
    for (let i = 1; i < all.length; i++) expect(all[i].ts).toBeGreaterThanOrEqual(all[i - 1].ts);
    w.store.stop();
  });

  it('a turn pushed out of the latest 50 by a new one stays on the open thread’s earlier page', async () => {
    const w = world('thread-long', { answerDelay: 0 });
    await w.start();
    await w.store.loadThread('eventing');
    const oldest = w.store.getState().threads.eventing[0];
    await w.store.act('ask', { payload: { text: 'what should I bring?', projectId: 'eventing' } }, 'ask');
    await until(() => (w.store.getState().threads.eventing ?? []).some((t) => t.message === 'what should I bring?' && t.kind === 'chat'));
    const s = w.store.getState();
    expect(s.threads.eventing).toHaveLength(50);
    expect(s.threads.eventing.some((t) => t.id === oldest.id)).toBe(false);
    expect(s.threadOlder.eventing.some((t) => t.id === oldest.id)).toBe(true);
    w.store.stop();
  });

  it('moves a turn to another project (even from an earlier page) and back', async () => {
    const w = world('thread-long');
    await w.start();
    await w.store.loadThread('eventing');
    await w.store.loadEarlier('eventing');
    const older = w.store.getState().threadOlder.eventing[0];
    const r = await w.store.act('turn.move', { id: older.id, payload: { projectId: 'house' } }, 'move');
    expect(r).toMatchObject({ ok: true, data: { from: 'eventing', undo: { projectId: 'eventing' }, message: 'Moved to House & garden.' } });
    const s = w.store.getState();
    expect(s.threadOlder.eventing.some((t) => t.id === older.id)).toBe(false);
    expect(s.threads.house.find((t) => t.id === older.id)).toMatchObject({ projectId: 'house', movedFrom: 'eventing' });
    await w.store.act('turn.move', { id: older.id, payload: { projectId: 'eventing' } }, 'undo');
    // back where it was: older than the latest 50, so on the earlier page the person had open (not lost to the 50)
    expect(w.store.getState().threadOlder.eventing.some((t) => t.id === older.id)).toBe(true);
    expect(w.store.getState().threads.eventing.some((t) => t.id === older.id)).toBe(false);
    // a running answer can't move yet
    w.fx.answerDelay = -1;
    const run = await w.store.act('ask', { payload: { text: 'what next?', projectId: 'health' } }, 'ask');
    const turnId = w.store.getState().askOutcomes[run.entryId!].start.turnId!;
    expect(await w.store.act('turn.move', { id: turnId, payload: { projectId: 'general' } }, 'move', { quiet: true })).toMatchObject({ ok: false, code: 'running' });
    w.store.stop();
  });

  it('Stop and Steer the answer being written; a second message meanwhile is 409 busy', async () => {
    const w = world('N00', { answerDelay: -1 });
    await w.start();
    expect(await w.store.act('project.stop', { id: 'house' }, 'stop', { quiet: true })).toMatchObject({ ok: false, code: 'nothing_running' });
    await w.store.act('ask', { payload: { text: 'Compare the gutter quotes', projectId: 'house' } }, 'ask');
    const busy = await w.store.act('ask', { payload: { text: 'And the roof?', projectId: 'house' } }, 'ask', { quiet: true });
    expect(busy).toMatchObject({ ok: false, queued: false, code: 'busy' });
    expect(await w.store.act('project.steer', { id: 'house', text: 'only the Hillside one' }, 'steer')).toMatchObject({ ok: true });
    flushRuns(w.fx);
    await until(() => (w.store.getState().threads.house ?? []).some((t) => t.message === 'Compare the gutter quotes' && t.kind === 'chat'));
    expect(w.store.getState().threads.house.find((t) => t.message === 'Compare the gutter quotes' && t.kind === 'chat')!.reply).toContain('You added: only the Hillside one');
    await w.store.act('ask', { payload: { text: 'Find a roofer', projectId: 'house' } }, 'ask');
    expect(await w.store.act('project.stop', { id: 'house' }, 'stop')).toMatchObject({ ok: true });
    flushRuns(w.fx);
    await until(() => (w.store.getState().threads.house ?? []).some((t) => t.message === 'Find a roofer' && t.kind === 'chat'));
    expect(w.store.getState().threads.house.find((t) => t.message === 'Find a roofer' && t.kind === 'chat')!.reply).toMatch(/^Stopped by you\./);
    w.store.stop();
  });

  it('projects: create (409 name_taken), rename, archive (not General), restore', async () => {
    const w = world();
    await w.start();
    const c = await w.store.act('project.create', { payload: { name: 'Garden club', icon: 'leaf' } }, 'create');
    const p = (c as { data: { project: { id: string } } }).data.project;
    expect(w.store.getState().projects[p.id]).toMatchObject({ name: 'Garden club', icon: 'leaf', archived: false });
    expect(await w.store.act('project.create', { payload: { name: 'garden club' } }, 'create', { quiet: true })).toMatchObject({ ok: false, code: 'name_taken' });
    await w.store.act('project.update', { id: p.id, payload: { name: 'Garden & allotment' } }, 'rename');
    expect(w.store.getState().projects[p.id].name).toBe('Garden & allotment');
    expect(await w.store.act('project.update', { id: 'general', payload: { archived: true } }, 'archive', { quiet: true })).toMatchObject({ ok: false, code: 'general' });
    await w.store.act('project.update', { id: p.id, payload: { archived: true } }, 'archive');
    expect(w.store.getState().projects[p.id].archived).toBe(true);
    await w.store.act('project.update', { id: p.id, payload: { archived: false } }, 'restore');
    expect(w.store.getState().projects[p.id].archived).toBe(false);
    w.store.stop();
  });

  it('the Work tab\'s jobs join the store', async () => {
    const w = world('N06');
    await w.start();
    expect(await w.store.loadProjectWork('eventing')).toEqual(['j_learn']);
    expect(w.store.getState().jobs.j_learn.status.state).toBe('waiting');
    w.store.stop();
  });
});

describe('W4: asks made offline wait in the outbox', () => {
  it('a message and a big ask sent offline are kept with their keys, replayed once back online, and their outcomes kept', async () => {
    const w = world();
    await w.start();
    w.setOnline(false);
    const a = await w.store.act('ask', { payload: { text: 'When is my next checkup?', projectId: 'health' } }, 'When is my next checkup?');
    const b = await w.store.act('ask', { payload: { text: 'go through all my receipts', projectId: 'house' } }, 'receipts');
    expect(a).toMatchObject({ ok: false, queued: true });
    expect(b.queued).toBe(true);
    const keys = w.store.getState().outbox.map((x) => x.key);
    expect(keys).toHaveLength(2);
    expect(w.store.getState().askOutcomes[a.entryId!]).toBeUndefined();
    w.setOnline(true);
    await until(() => w.store.getState().outbox.length === 0 && !!w.store.getState().askOutcomes[b.entryId!]);
    const posts = w.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/ask'));
    expect(posts.map((p) => p.key)).toEqual(keys);
    expect(w.store.getState().askOutcomes[a.entryId!]).toMatchObject({ replayed: true, start: { kind: 'answer', projectId: 'health' } });
    expect(w.store.getState().askOutcomes[b.entryId!]).toMatchObject({ replayed: true, start: { kind: 'plan' } });
    // the plan sent from the outbox waits for a choice: the person is told where to make it
    expect(w.store.getState().notices.map((n) => n.text)).toContain('Something you asked while offline needs a choice before I start. Open Ask to choose.');
    await until(() => (w.store.getState().threads.health ?? []).filter((t) => t.message === 'When is my next checkup?' && t.kind === 'chat').length === 1);
    w.store.stop();
  });

  it('an ask refused when it is replayed leaves the outbox with no outcome (the screen says it didn’t go through)', async () => {
    const w = world();
    await w.start();
    w.setOnline(false);
    const r = await w.store.act('ask', { payload: { text: 'When is my next checkup?', projectId: 'health' } }, 'checkup');
    expect(w.store.getState().outbox.map((x) => x.id)).toEqual([r.entryId]);
    w.fx.projects.set('health', { ...w.fx.projects.get('health')!, archived: true }); // archived meanwhile, elsewhere
    w.setOnline(true);
    await until(() => w.store.getState().outbox.length === 0);
    expect(w.store.getState().askOutcomes[r.entryId!]).toBeUndefined();
    await until(() => w.store.getState().notices.some((n) => n.text === 'checkup: Health is archived. Restore it first.'));
    w.store.stop();
  });

  it('a choice made offline waits too, and is sent with the same key', async () => {
    const w = world();
    await w.start();
    const r = await w.store.act('ask', { payload: { text: 'learn everything from these two PDFs', files: PDFS } }, 'ask');
    const start = w.store.getState().askOutcomes[r.entryId!].start;
    w.setOnline(false);
    const c = await w.store.act('ask.choose', { id: start.askId, payload: { mode: 'background' } }, 'choose', { quiet: true });
    expect(c.queued).toBe(true);
    w.setOnline(true);
    await until(() => !!w.store.getState().askChoices[start.askId]);
    expect(w.store.getState().askChoices[start.askId]).toMatchObject({ chosen: 'background', kind: 'job' });
    w.store.stop();
  });
});
