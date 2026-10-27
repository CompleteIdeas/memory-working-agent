// v2 build, slice W4: the Ask flow's and the Projects tab's words (screens/ask/logic.ts, screens/projects/logic.ts,
// screens/ask/upload.ts), and the components rendered in node (react-dom/server) from a store filled from fixture
// mode: the plan card (N04) before and after a choice and when it is old, an answer, a job, the offer, a project's
// thread (provenance, the About chip, the divider, Move…, the running answer's Stop and "Add to it", "Earlier
// messages"), the projects list's badges, "Ask about this" and the Ask sheet's accessible names.
// Interactions run in the browser: scripts/v2-w4-smoke.mjs.
import { describe, it, expect } from 'vitest';
import { createElement as h, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MwaClient, type AskStart, type Turn, type Job } from '../web/src/v2/api/client';
import { V2Store, type StoreState } from '../web/src/v2/store/core';
import { MemoryCache } from '../web/src/v2/store/cache';
import { StoreProvider } from '../web/src/v2/store/react';
import { FixtureServer, fixtureFetch } from '../web/src/v2/dev/fixtures';
import { flushRuns } from '../web/src/v2/dev/fixtures-w4';
import { FIXTURE_NOW } from '../web/src/v2/dev/fixture-data';
import * as askLogic from '../web/src/v2/screens/ask/logic';
import * as projLogic from '../web/src/v2/screens/projects/logic';
import { uploadFile } from '../web/src/v2/screens/ask/upload';
import { AskOutcomeView, PlanCard, findAnswer } from '../web/src/v2/screens/ask/AskOutcome';
import { AskAbout } from '../web/src/v2/screens/ask/AskAbout';
import { AskSheet } from '../web/src/v2/screens/ask/AskSheet';
import { ProjectThread } from '../web/src/v2/screens/projects/ProjectThread';
import { Projects } from '../web/src/v2/screens/projects/Projects';

const MIN = 60_000;
const at = (h: number, m = 0) => new Date(2026, 10, 9, h, m).getTime();

// ---------- a store filled from fixture mode, without a network ----------
const H = { 'x-mwa-client': 'web/1.0.0' };
function filled(scenario = 'N00', patch: Partial<StoreState> = {}) {
  const fx = new FixtureServer(scenario);
  fx.answerDelay = -1;
  const store = new V2Store({ client: new MwaClient({ fetch: fixtureFetch(fx) }), cache: new MemoryCache(), stream: () => { throw new Error('no stream in render tests'); }, now: () => FIXTURE_NOW, fixtures: true });
  const snap = fx.handle({ method: 'GET', path: '/sync', query: new URLSearchParams('collections=jobs,calendar,projects,turns'), headers: H, body: undefined });
  (store as unknown as { applySync(b: unknown): void }).applySync(snap.body);
  (store as unknown as { set(p: Partial<StoreState>): void }).set({ ready: true, connection: 'live', ...patch });
  return { fx, store, set: (p: Partial<StoreState>) => (store as unknown as { set(p: Partial<StoreState>): void }).set(p) };
}
const render = (store: V2Store, el: ReactElement) => renderToStaticMarkup(h(StoreProvider, { store }, el));
const post = (fx: FixtureServer, path: string, body: unknown) => fx.handle({ method: 'POST', path, query: new URLSearchParams(), headers: { ...H, 'idempotency-key': `k-${Math.random().toString(36).slice(2, 12)}` }, body });
const PDFS = ['fixtures/uploads/icp-eventing-handbook.pdf', 'fixtures/uploads/usef-eventing-rules-2025.pdf'];
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, '\'').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ');

describe('the Ask flow\'s words', () => {
  it('a plan option says its ready time in this device\'s time, in the server\'s words', () => {
    const o = { usd: 0.15, ms: 60 * MIN, label: 'In the background · about 15¢ · ready around 3:10 PM', firstGuess: false, capDefault: 0.3, readyAt: at(10, 10) };
    expect(askLogic.optionLabel(o, at(9, 10))).toBe('In the background · about 15¢ · ready around 10:10 AM');
    expect(askLogic.optionLabel({ ...o, readyAt: at(10, 10) + 86_400_000 }, at(9, 10))).toBe('In the background · about 15¢ · ready around tomorrow 10:10 AM');
    expect(askLogic.optionLabel({ ...o, readyAt: at(10, 10) + 3 * 86_400_000 }, at(9, 10))).toBe('In the background · about 15¢ · ready around Thu 10:10 AM');
    expect(askLogic.optionLabel({ usd: 0.4, ms: 1, label: 'Do it now · a first guess, about 40¢', firstGuess: true, capDefault: 0.5 }, at(9))).toBe('Do it now · a first guess, about 40¢');
  });
  it('the limit: a dollar amount from 1¢ to $20, said plainly when it is not', () => {
    expect(askLogic.parseCap('0.50')).toEqual({ ok: true, usd: 0.5 });
    expect(askLogic.parseCap('$1.234')).toEqual({ ok: true, usd: 1.23 });
    expect(askLogic.parseCap('20')).toEqual({ ok: true, usd: 20 });
    expect(askLogic.parseCap('20.01')).toEqual({ ok: false, message: 'The most is $20.' });
    expect(askLogic.parseCap('0')).toEqual({ ok: false, message: 'The least is 1¢.' });
    expect(askLogic.parseCap('')).toMatchObject({ ok: false });
    expect(askLogic.parseCap('abc')).toMatchObject({ ok: false });
  });
  it('refusals in plain words, with what to do', () => {
    expect(askLogic.refusalFor('expired', 'That plan is more than a day old.')).toEqual({ text: 'This plan is old — ask again.', again: true });
    expect(askLogic.refusalFor('files_gone', 'x')).toMatchObject({ again: true, text: 'A file this plan reads isn’t there any more. Add it again and ask again.' });
    expect(askLogic.refusalFor('archived', 'Eventing is archived. Restore it first.')).toEqual({ text: 'Eventing is archived. Restore it, or ask again somewhere else.', again: true, restore: true });
    expect(askLogic.refusalFor('archived', '')).toMatchObject({ text: 'That project is archived. Restore it, or ask again somewhere else.' });
    expect(askLogic.refusalFor('already_chosen', '')).toMatchObject({ again: false });
    expect(askLogic.refusalFor('busy', 'I’m still writing an answer in Eventing.')).toMatchObject({ text: 'I’m still writing an answer in Eventing.', again: false });
    expect(askLogic.refusalFor(undefined, 'Something went wrong.')).toMatchObject({ text: 'Something went wrong.', again: true });
  });
  it('where it goes: the person\'s choice wins; the sheet\'s words', () => {
    const s = { projectId: 'family', name: 'Family & school', confidence: 'suggested' };
    const c = { projectId: 'eventing', name: 'Eventing', confidence: 'given' };
    expect(askLogic.routeFor(null, s)).toBe(s);
    expect(askLogic.routeFor(c, s)).toBe(c);
    expect(askLogic.routeLine(s)).toBe('Family & school · suggested');
    expect(askLogic.routeLine({ name: 'General', confidence: 'not sure' })).toBe('General · not sure');
    expect(askLogic.routeLine(c)).toBe('Eventing');
    expect(askLogic.routeLine({ name: 'Eventing', confidence: 'this project' })).toBe('Eventing · this project');
  });
  it('provenance: other projects only, and "an earlier conversation" for one from before projects', () => {
    const t = (p: Turn['provenance']) => ({ projectId: 'family', provenance: p });
    expect(askLogic.provenanceLine(t([]))).toBeNull();
    expect(askLogic.provenanceLine(t([{ projectId: 'family', name: 'Family & school', n: 2 }]))).toBeNull();
    expect(askLogic.provenanceLine(t([{ projectId: 'eventing', name: 'Eventing', n: 2 }]))).toBe('using what I know from Eventing');
    expect(askLogic.provenanceLine(t([{ projectId: 'eventing', name: 'Eventing', n: 1 }, { projectId: null, name: 'x', n: 1 }]))).toBe('using what I know from Eventing and an earlier conversation');
    expect(askLogic.provenanceLine(t([{ projectId: 'a', name: 'A', n: 1 }, { projectId: 'b', name: 'B', n: 1 }, { projectId: 'c', name: 'C', n: 1 }]))).toBe('using what I know from A, B and C');
  });
  it('a run\'s progress line from the stream', () => {
    expect(askLogic.stageLine({ n: 3, of: 40, tool: 'read_document' }, 'step')).toBe('Reading · step 3 of 40');
    expect(askLogic.stageLine({ n: 1, of: 8, tool: 'web_search' }, 'step')).toBe('Looking it up · step 1 of 8');
    expect(askLogic.stageLine({ n: 2, total: 5, task: 'Read the rules' }, 'plan_step')).toBe('Part 2 of 5: Read the rules');
    expect(askLogic.stageLine({}, 'stopping')).toBe('Stopping after this step…');
    expect(askLogic.stageLine(undefined)).toBe('Working on it…');
  });
  it('a job handed over: "I’ll let you know · ready around …"', () => {
    expect(askLogic.jobNote({ readyAt: at(10, 10) }, at(9, 10))).toBe('I’ll let you know · ready around 10:10 AM');
    expect(askLogic.jobNote({}, at(9, 10))).toBe('I’ll let you know when it’s done.');
  });
  it('an answer is found by its run: the running turn while it writes, the new turn once written', () => {
    const base = { projectId: 'p', ts: 1, message: 'q', reply: '', truncated: false, reason: null, tainted: false, tryId: null, about: null, provenance: [], offer: null, legacySession: null, movedFrom: null, updatedSeq: 1, source: 'typed' as const };
    const running: Turn = { ...base, id: 't1', kind: 'running', runId: 'r1' };
    const done: Turn = { ...base, id: 't2', kind: 'chat', runId: 'r1', reply: 'a' };
    expect(findAnswer([running], { runId: 'r1', turnId: 't1' })).toEqual({ done: undefined, running });
    expect(findAnswer([done], { runId: 'r1', turnId: 't1' })).toEqual({ done, running: undefined });
    expect(findAnswer([{ ...done, runId: null }], { turnId: 't1', finalTurnId: 't2' }).done?.id).toBe('t2');
  });
});

describe('the Projects tab\'s words', () => {
  const job = (id: string, state: Job['status']['state'], projectId: string | null, title = `Job ${id}`) => ({ id, title, projectId, archived: false, status: { state, label: state, detail: '' } }) as Job;
  it('what a project is doing: waiting first, then working, then an answer being written', () => {
    const p = { id: 'eventing', general: false };
    expect(projLogic.projectStatus(p, [job('a', 'working', 'eventing', 'Gathering this week’s AI news')])).toEqual({ line: 'Working: gathering this week’s AI news', badge: { text: 'Working', tone: 'working' } });
    expect(projLogic.projectStatus(p, [job('a', 'working', 'eventing'), job('b', 'waiting', 'eventing', 'Learning the rules')])).toMatchObject({ line: 'Waiting for you: learning the rules', badge: { text: 'Waiting', tone: 'needs' } });
    expect(projLogic.projectStatus(p, [job('a', 'working', 'eventing'), job('b', 'continuing', 'eventing')]).badge).toEqual({ text: '2 working', tone: 'working' });
    expect(projLogic.projectStatus(p, [job('a', 'working', 'house')])).toEqual({ line: null, badge: null });
    expect(projLogic.projectStatus(p, [], { kind: 'running' })).toEqual({ line: 'Writing an answer…', badge: { text: 'Answering', tone: 'working' } });
    // General also holds the jobs no project claims
    expect(projLogic.projectStatus({ id: 'general', general: true }, [job('a', 'working', null)]).badge?.text).toBe('Working');
  });
  it('last activity', () => {
    expect(projLogic.activityText(null, at(9))).toBe('Nothing here yet');
    expect(projLogic.activityText(at(7, 5), at(9))).toBe('Last: today 7:05 AM');
    expect(projLogic.activityText(at(7) - 86_400_000, at(9))).toBe('Last: yesterday');
    expect(projLogic.activityText(at(7) - 3 * 86_400_000, at(9))).toBe('Last: Friday');
    expect(projLogic.activityText(new Date(2026, 9, 22).getTime(), at(9))).toBe('Last: Oct 22');
  });
  it('files, notes on turns, and thread order', () => {
    expect(projLogic.sizeText(900)).toBe('900 bytes');
    expect(projLogic.sizeText(2_140)).toBe('2 KB');
    expect(projLogic.sizeText(3_500_000)).toBe('3.3 MB');
    expect(projLogic.baseName('serve/p-x/uploads/a b.pdf')).toBe('a b.pdf');
    expect(projLogic.turnNotes({ movedFrom: 'family', source: 'voice' }, { family: { name: 'Family & school' } })).toEqual(['Moved here from Family & school', 'Spoken']);
    const t = (id: string, ts: number) => ({ id, ts }) as Turn;
    expect(projLogic.mergeTurns([t('a', 1), t('b', 2)], [t('b', 2), t('c', 3)]).map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('adding files (POST /api/v1/files)', () => {
  const file = (name: string, size = 10) => new File([new Uint8Array(size)], name);
  it('fixture mode never touches the network', async () => {
    let called = false;
    const r = await uploadFile(file('icp-eventing-handbook.pdf'), { projectId: 'eventing', fixtures: true, fetch: (async () => { called = true; return new Response('{}'); }) as typeof fetch });
    expect(r).toEqual({ ok: true, file: { name: 'icp-eventing-handbook.pdf', path: 'fixtures/uploads/icp-eventing-handbook.pdf' } });
    expect(called).toBe(false);
  });
  it('posts the file to the v1 upload with an Idempotency-Key and returns its workspace path', async () => {
    let url = '', init: RequestInit | undefined;
    const r = await uploadFile(file('notes.pdf'), { projectId: 'eventing', fixtures: false, fetch: (async (u: RequestInfo | URL, i?: RequestInit) => { url = String(u); init = i; return new Response(JSON.stringify({ id: 'serve/p-eventing/uploads/notes.pdf', path: 'serve/p-eventing/uploads/notes.pdf', name: 'notes.pdf', size: 10, projectId: 'eventing', pages: 2 }), { status: 201 }); }) as typeof fetch });
    expect(url).toBe('/api/v1/files?name=notes.pdf&projectId=eventing');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('idempotency-key')).toMatch(/^[0-9A-Z]{26}$/);
    expect(new Headers(init?.headers).get('content-type')).toBe('application/octet-stream');
    expect(r).toEqual({ ok: true, file: { name: 'notes.pdf', path: 'serve/p-eventing/uploads/notes.pdf' } });
  });
  it('a device that may not add files, too big, refused, signed out, offline: each told plainly', async () => {
    const f403 = (async () => new Response(JSON.stringify({ error: { code: 'forbidden', message: 'This device is not allowed to do that.' } }), { status: 403 })) as typeof fetch;
    expect(await uploadFile(file('a.pdf'), { projectId: null, fixtures: false, fetch: f403 })).toEqual({ ok: false, message: 'a.pdf: This device is not allowed to do that.' });
    const f401 = (async () => new Response(JSON.stringify({ error: { code: 'locked', message: 'Sign in to continue.' } }), { status: 401 })) as typeof fetch;
    expect(await uploadFile(file('a.pdf'), { projectId: null, fixtures: false, fetch: f401 })).toEqual({ ok: false, message: 'Sign in again to add files.' });
    expect(await uploadFile(file('big.pdf', 26 * 1024 * 1024), { projectId: null, fixtures: false })).toMatchObject({ ok: false, message: 'big.pdf is too big to add here: the limit is 25 MB.' });
    const f400 = (async () => new Response(JSON.stringify({ error: { code: 'empty_file', message: 'That file is empty.' } }), { status: 400 })) as typeof fetch;
    expect(await uploadFile(file('x.txt'), { projectId: null, fixtures: false, fetch: f400 })).toEqual({ ok: false, message: 'x.txt: That file is empty.' });
    const off = (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch;
    expect(await uploadFile(file('a.pdf'), { projectId: null, fixtures: false, fetch: off })).toMatchObject({ ok: false, message: 'Can’t reach your helper to add files right now.' });
  });
});

describe('the components, rendered', () => {
  function plan() {
    const w = filled();
    const start = post(w.fx, '/ask', { text: 'learn everything from these two PDFs', files: PDFS }).body as AskStart;
    return { ...w, start };
  }
  it('the plan card (N04): the message, both choices with price and local ready time, Or narrow it… and Details', () => {
    const { store, start } = plan();
    const out = text(render(store, h(PlanCard, { askId: start.askId, plan: start.plan!, projectId: start.projectId, text: 'learn everything' })));
    expect(out).toContain('This is a big read — 149 pages, about 20 minutes. Do it now, or in the background for less and I’ll tell you when it’s done?');
    expect(out).toContain('Do it now · about 40¢');
    expect(out).toContain('In the background · about 15¢ · ready around 10:10 AM');
    expect(out).toContain('Or narrow it…');
    expect(out).toContain('Details');
    expect(out).not.toContain('You chose');
  });
  it('after background: "You chose", the job line with its limit, the way to the working sheet', () => {
    const { store, fx, start, set } = plan();
    const chosen = post(fx, `/ask/${start.askId}/choose`, { mode: 'background', capUsd: 0.5 }).body as never;
    set({ askChoices: { [start.askId]: chosen } });
    const out = text(render(store, h(PlanCard, { askId: start.askId, plan: start.plan!, projectId: start.projectId, text: 'x', onShowWork: () => {} })));
    expect(out).toContain('You chose: In the background · about 15¢ · ready around 10:10 AM');
    expect(out).toContain('I’ll let you know · ready around 10:10 AM · stops at $0.50');
    expect(out).toContain('See what I’m working on');
    expect(out).not.toContain('Or narrow it…');
  });
  it('a plan the server says is old: "This plan is old — ask again"', () => {
    const { store, fx, start, set } = plan();
    set({ asks: { [start.askId]: { ...fx.asks.get(start.askId)!, state: 'expired' } } });
    const out = text(render(store, h(PlanCard, { askId: start.askId, plan: start.plan!, projectId: start.projectId, text: 'x', onAgain: () => {} })));
    expect(out).toContain('This plan is old — ask again.');
    expect(out).toContain('Ask again');
    expect(out).not.toContain('Do it now ·');
  });
  it('an answer being written, then written (with provenance); a job; the offer', () => {
    const w = filled();
    const start = post(w.fx, '/ask', { text: 'What should I bring Saturday?', projectId: 'family' }).body as AskStart;
    const snap = () => (w.fx.handle({ method: 'GET', path: '/projects/family/thread', query: new URLSearchParams(), headers: H, body: undefined }).body as { turns: Turn[] }).turns;
    w.set({ threads: { ...w.store.getState().threads, family: snap() }, threadLoaded: { family: true } });
    const running = render(w.store, h(AskOutcomeView, { start, text: 'Who else is going?' }));
    expect(running).toContain('aria-label="Your helper is answering"');
    expect(text(running)).toContain('Stop');
    let out: string;
    // the run finishes: the answer is a new turn with the same run
    flushRuns(w.fx);
    w.set({ threads: { ...w.store.getState().threads, family: snap() } });
    out = text(render(w.store, h(AskOutcomeView, { start, text: 'Who else is going?' })));
    expect(out).toContain('Willow’s studs and the cross-country vest');
    expect(out).toContain('using what I know from Eventing');
    const job = post(w.fx, '/ask', { text: 'sort the barn receipts', mode: 'background', projectId: 'house' }).body as AskStart;
    expect(text(render(w.store, h(AskOutcomeView, { start: job, text: 'x', onShowWork: () => {} })))).toContain('I’ll let you know · ready around 10:10 AM · stops at $0.30');
    const offer = post(w.fx, '/ask', { text: 'research summer camps', projectId: 'family' }).body as AskStart;
    const o = text(render(w.store, h(AskOutcomeView, { start: offer, text: 'research summer camps' })));
    expect(o).toContain('Want me to work on it in the background');
    expect(o).toContain('Work on it in the background');
    expect(o).toContain('Do it here now');
    // inside the project's own thread only a plan shows (the rest are turns there)
    expect(render(w.store, h(AskOutcomeView, { start: offer, text: 'x', inThread: true }))).toBe('');
  });
  it('a project\'s thread: provenance, the About chip, the divider, Move…, the offer, the running answer, Earlier messages', () => {
    const w = filled('N00');
    post(w.fx, '/ask', { text: 'research summer camps', projectId: 'family' });
    post(w.fx, '/projects/eventing/messages', { text: 'what should I bring Saturday?' });
    const thread = (id: string) => w.fx.handle({ method: 'GET', path: `/projects/${id}/thread`, query: new URLSearchParams(), headers: H, body: undefined }).body as { turns: Turn[]; project: never };
    w.set({ threads: { ...w.store.getState().threads, family: thread('family').turns, eventing: thread('eventing').turns }, threadLoaded: { family: true, eventing: true }, threadNext: { eventing: 'ts:1:x' } });
    const fam = text(render(w.store, h(ProjectThread, { p: w.fx.projects.get('family')! })));
    expect(fam).toContain('using what I know from Eventing');
    expect(fam).toContain('About an item on your list');
    expect(fam).toContain('Who else is going?');
    expect(fam).toContain('Work on it in the background');
    const html = render(w.store, h(ProjectThread, { p: w.fx.projects.get('family')! }));
    expect(html).toContain('aria-label="Move to another project: Can Riley go on the Saturday morning library trip?"');
    expect(html).toContain('>Message Family &amp; school</label>');
    const ev = text(render(w.store, h(ProjectThread, { p: w.fx.projects.get('eventing')! })));
    expect(ev).toContain('Conversation from Oct 22: Willow’s lessons');
    expect(ev).toContain('Earlier messages');
    expect(ev).toContain('Stop');
    expect(ev).toContain('Add to it');
  });
  it('the projects list: what each is doing, badges, last activity, New project', () => {
    const w = filled('N06');
    const out = text(render(w.store, h(Projects, { desk: false, wide: false, go: () => {}, ask: () => {} })));
    expect(out).toContain('Eventing Waiting for you: learning the USEF eventing rules Waiting');
    expect(out).toContain('AI newsletter Working: gathering this week’s AI news Working');
    expect(out).toContain('Health Nothing here yet');
    expect(out).toContain('New project');
  });
  it('"Ask about this": the button; open, the chip and a box named for the thing', () => {
    const w = filled();
    expect(text(render(w.store, h(AskAbout, { kind: 'job', id: 'j_news', label: 'Gathering this week’s AI news' })))).toContain('Ask about this');
    const open = render(w.store, h(AskAbout, { kind: 'job', id: 'j_news', label: 'Gathering this week’s AI news', open: true }));
    expect(text(open)).toContain('About: Gathering this week’s AI news');
    expect(open).toContain('Ask about Gathering this week’s AI news');
  });
  it('the Ask sheet keeps the prototype\'s names; about one thing, the chip and no files', () => {
    const w = filled();
    const plain = render(w.store, h(AskSheet, { open: false, about: null, onClose: () => {} }));
    for (const name of ['Message your helper', 'aria-label="Hold to talk"', 'aria-label="Add files"', 'aria-label="Close"', 'id="ask-dlg"', 'id="ask-file"']) expect(plain).toContain(name);
    const about = render(w.store, h(AskSheet, { open: false, about: { label: 'Gathering this week’s AI news', projectId: 'ainews', kind: 'job', id: 'j_news' }, onClose: () => {} }));
    expect(text(about)).toContain('About: Gathering this week’s AI news');
    expect(about).not.toContain('aria-label="Add files"');
  });
});
