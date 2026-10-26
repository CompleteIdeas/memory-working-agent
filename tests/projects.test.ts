// v2 slice A5: projects and their threads — the conversation migration into General, conversations.ts on the table,
// moving a message (and undo), the routes' scopes, the jobs a project's thread makes, and the /sync collections.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appDb, resetAppDb } from '../src/v2/db.js';
import { GENERAL, createProject, updateProject, getTurn, threadPage, moveTurn, crossTalk, projectOfMemorySession, insertTurn, MoveError, ProjectError } from '../src/v2/projects.js';
import { migrateConversations, migrateConversationsOnce } from '../src/v2/migrate-conversations.js';
import { appendTurn, readConversation, listConversations, answerOffer } from '../src/conversations.js';
import { createJob, queueContinuation, getJob } from '../src/v2/jobs.js';
import { createV1 } from '../src/api/router.js';
import { v1Routes } from '../src/api/v1.js';
import { ALL_SCOPES, type Caller, type Scope } from '../src/api/auth.js';
import { setJobRouteDeps } from '../src/api/routes/jobs.js';
import { setProjectRouteDeps, projectFiles } from '../src/api/routes/projects.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'mwa-a5-'));
const line = (o: object) => JSON.stringify(o);

/** A conversations.jsonl as the app wrote it before projects: two web conversations, a Telegram chat, an offer and its
 *  answer, a running turn retired by its finished turn, one that never finished, a background result, a bad line. */
function oldLog(dir: string): string {
  const day = (d: number, h: number) => Date.UTC(2026, 9, d, h);
  const rows = [
    line({ ts: day(22, 14), session: 'web-a', message: 'Research AI news and write a newsletter', reply: 'I can work on this in the background.', kind: 'offer' }),
    line({ ts: day(22, 15), session: 'web-a', message: 'Research AI news and write a newsletter', reply: '', kind: 'offer-answer', answers: day(22, 14), offer: { answered: 'background', goal: 'a1b2c3d4', at: day(22, 15) } }),
    line({ ts: day(22, 16), session: 'web-a', message: 'Newsletter draft', reply: 'Here it is: [draft](draft.md)', kind: 'result' }),
    line({ ts: day(23, 9), session: 'web-b', message: 'What time is the farrier coming?', reply: '', kind: 'running', runId: 'live_1' }),
    line({ ts: day(23, 9) + 5000, session: 'web-b', message: 'What time is the farrier coming?', reply: 'Thursday at 4.', kind: 'chat', runId: 'live_1', tainted: false }),
    line({ ts: day(22, 20), session: 'tg-12345', message: 'hello from telegram', reply: 'hi', kind: 'chat' }),
    line({ ts: day(24, 8), session: 'web-c', message: 'Write the brief', reply: '', kind: 'running', runId: 'live_2' }),
    '{not json',
  ];
  const file = join(dir, 'conversations.jsonl');
  writeFileSync(file, rows.join('\n') + '\n');
  return file;
}

describe('the conversation migration (data-008-projects)', () => {
  beforeEach(() => resetAppDb(':memory:'));

  it('moves every conversation into General under a dated divider, losslessly and once', () => {
    const dir = tmp();
    try {
      const file = oldLog(dir);
      const before = createHash('sha256').update(readFileSync(file)).digest('hex');
      const r = migrateConversationsOnce({ file })!;
      expect(r).toMatchObject({ lines: 7, badLines: 1, conversations: 3, telegramSkipped: 1, dividers: 3, inserted: 4, superseded: 1, answersFolded: 1, existing: 0 });
      const general = threadPage(GENERAL, { limit: 200 }).turns;
      expect(general.map((t) => [t.kind, t.legacy_session])).toEqual([
        ['divider', 'web-a'], ['offer', 'web-a'], ['result', 'web-a'],
        ['divider', 'web-b'], ['chat', 'web-b'],
        ['divider', 'web-c'], ['running', 'web-c'],
      ]);
      expect(general[0].message).toBe('Conversation from Oct 22: Research AI news and write a newsletter');
      expect(general[3].message).toMatch(/^Conversation from Oct 2[23]: What time is the farrier coming\?$/);
      // the offer keeps its answer; the finished turn replaced its running one; nothing from Telegram
      expect(JSON.parse(general[1].meta!)).toMatchObject({ offer: { answered: 'background', goal: 'a1b2c3d4' } });
      expect(general[4]).toMatchObject({ reply: 'Thursday at 4.', run_id: 'live_1', tainted: 0 });
      expect(appDb().prepare(`SELECT COUNT(*) n FROM turns WHERE legacy_session LIKE 'tg-%'`).get()).toEqual({ n: 0 });
      // the older client still opens each conversation by its id
      expect(readConversation('web-a').map((t) => t.kind)).toEqual(['offer', 'result']);
      expect(readConversation('web-a')[0].offer).toMatchObject({ answered: 'background' });
      expect(readConversation('web-b')).toHaveLength(1);
      expect(listConversations().map((c) => c.session).sort()).toEqual(['web-a', 'web-b', 'web-c']);
      // once: recorded; and a forced re-run writes nothing
      expect(migrateConversationsOnce({ file })).toBeNull();
      const again = migrateConversations({ file, record: false });
      expect(again).toMatchObject({ inserted: 0, dividers: 0, existing: 4 });
      expect(threadPage(GENERAL, { limit: 200 }).turns).toHaveLength(7);
      // lossless: the log is only read
      expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe(before);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a dry run writes nothing; no log is fine', () => {
    const dir = tmp();
    try {
      const file = oldLog(dir);
      expect(migrateConversations({ file, dryRun: true })).toMatchObject({ inserted: 4, dividers: 3 });
      expect(threadPage(GENERAL).turns).toHaveLength(0);
      expect(migrateConversationsOnce({ file: join(dir, 'missing.jsonl') })).toMatchObject({ lines: 0, inserted: 0 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("an older conversation's files stay reachable from General", () => {
    const dir = tmp();
    try {
      const file = oldLog(dir);
      migrateConversationsOnce({ file });
      const ws = join(dir, 'ws');
      mkdirSync(join(ws, 'serve', 'web-a'), { recursive: true });
      writeFileSync(join(ws, 'serve', 'web-a', 'draft.md'), '# Draft');
      mkdirSync(join(ws, 'serve', 'p-general'), { recursive: true });
      writeFileSync(join(ws, 'serve', 'p-general', 'notes.md'), 'notes');
      expect(projectFiles(GENERAL, ws).map((f) => f.path).sort()).toEqual(['serve/p-general/notes.md', 'serve/web-a/draft.md']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('conversations.ts on the turns table', () => {
  beforeEach(() => resetAppDb(':memory:'));

  it("a project's session is its thread; anything else is kept in General under its own id; Telegram is not kept", () => {
    const eventing = createProject({ name: 'Eventing' });
    const id = appendTurn({ ts: 10, session: `p-${eventing.id}`, message: 'Teach me the dressage test', reply: 'Here it is.', kind: 'chat' });
    expect(getTurn(id!)).toMatchObject({ project_id: eventing.id, session: `p-${eventing.id}`, legacy_session: null });
    appendTurn({ ts: 11, session: 'web-x', message: 'What is the weather?', reply: 'Sunny.', kind: 'chat' });
    expect(threadPage(GENERAL).turns.map((t) => t.legacy_session)).toEqual(['web-x']);
    expect(readConversation('web-x').map((t) => t.message)).toEqual(['What is the weather?']);
    expect(readConversation(`p-${eventing.id}`).map((t) => t.message)).toEqual(['Teach me the dressage test']);
    expect(appendTurn({ ts: 12, session: 'tg-1', message: 'hi', reply: 'hi', kind: 'chat' })).toBeUndefined();
    expect(readConversation('tg-1')).toEqual([]);
    // a session naming no project (deleted, or made up) is kept in General, never lost
    appendTurn({ ts: 13, session: 'p-nope', message: 'lost?', reply: 'no', kind: 'chat' });
    expect(readConversation('p-nope').map((t) => t.message)).toEqual(['lost?']);
  });

  it('a running turn is filled in by its finished turn: same id, same place, and a move made meanwhile is kept', () => {
    const a = createProject({ name: 'A' });
    const s = `p-${a.id}`;
    const running = appendTurn({ ts: 100, session: s, message: 'write the brief', reply: '', kind: 'running', runId: 'live_9' })!;
    appendTurn({ ts: 150, session: s, message: 'and another thing', reply: 'ok', kind: 'chat' });
    const done = appendTurn({ ts: 200, session: s, message: 'write the brief', reply: 'Here it is.', kind: 'chat', runId: 'live_9', provenance: [{ projectId: GENERAL, n: 2 }] })!;
    expect(done).toBe(running);
    const turns = readConversation(s);
    expect(turns.map((t) => [t.message, t.kind, t.ts])).toEqual([['write the brief', 'chat', 200], ['and another thing', 'chat', 150]]);
    expect(turns[0].provenance).toEqual([{ projectId: GENERAL, n: 2 }]);
  });

  it('answers an offer on the offer turn', () => {
    const a = createProject({ name: 'A' });
    const s = `p-${a.id}`;
    appendTurn({ ts: 1000, session: s, message: 'Research boats', reply: 'offer', kind: 'offer' });
    expect(answerOffer(s, 'now', undefined, undefined, 2000)).toBe(1000);
    expect(readConversation(s)[0].offer).toEqual({ answered: 'now', at: 2000 });
  });
});

describe('moving a message, and undo', () => {
  beforeEach(() => resetAppDb(':memory:'));

  it('moves the message and its answer together, records the change, and moves back', () => {
    const fam = createProject({ name: 'Family & school' });
    const id = appendTurn({ ts: 5, session: 'p-general', message: 'Can Riley go to the library trip?', reply: 'Yes, if Sam drives.', kind: 'chat' })!;
    const seq0 = (appDb().prepare('SELECT MAX(seq) s FROM events').get() as { s: number }).s;
    const { turn, from } = moveTurn(id, fam.id);
    expect(from).toBe(GENERAL);
    expect(turn).toMatchObject({ project_id: fam.id, session: `p-${fam.id}`, moved_from: GENERAL, message: 'Can Riley go to the library trip?', reply: 'Yes, if Sam drives.' });
    expect(threadPage(GENERAL).turns).toHaveLength(0);
    expect(readConversation(`p-${fam.id}`).map((t) => t.reply)).toEqual(['Yes, if Sam drives.']);
    expect(appDb().prepare(`SELECT entity, entity_id FROM events WHERE seq > ?`).all(seq0)).toEqual([{ entity: 'turn', entity_id: id }]);
    // undo: back where it was
    expect(moveTurn(id, from).turn).toMatchObject({ project_id: GENERAL, moved_from: fam.id });
    expect(threadPage(fam.id).turns).toHaveLength(0);
  });

  it('refuses a divider, a running answer, an archived or unknown project, and a move to where it is', () => {
    const fam = createProject({ name: 'Family' });
    const div = insertTurn({ projectId: GENERAL, ts: 1, kind: 'divider', message: 'Conversation from Oct 22: x', reply: '' })!;
    const run = appendTurn({ ts: 2, session: 'p-general', message: 'x', reply: '', kind: 'running', runId: 'live_3' })!;
    const chat = appendTurn({ ts: 3, session: 'p-general', message: 'y', reply: 'z', kind: 'chat' })!;
    const code = (f: () => unknown) => { try { f(); return null; } catch (e) { return (e as MoveError).code; } };
    expect(code(() => moveTurn(div.id, fam.id))).toBe('not_movable');
    expect(code(() => moveTurn(run, fam.id))).toBe('running');
    expect(code(() => moveTurn(chat, GENERAL))).toBe('same');
    expect(code(() => moveTurn(chat, 'pr_nope'))).toBe('not_found');
    updateProject(fam.id, { archived: true });
    expect(code(() => moveTurn(chat, fam.id))).toBe('archived');
  });

  it('projects: names are unique among active ones, General is never archived', () => {
    createProject({ name: 'Eventing' });
    const code = (f: () => unknown) => { try { f(); return null; } catch (e) { return (e as ProjectError).code; } };
    expect(code(() => createProject({ name: ' eventing ' }))).toBe('name_taken');
    expect(code(() => createProject({ name: '' }))).toBe('bad_name');
    expect(code(() => updateProject(GENERAL, { archived: true }))).toBe('general');
    expect(updateProject(GENERAL, { name: 'Everything else' }).name).toBe('Everything else');
  });
});

describe('cross-talk provenance (the mapping)', () => {
  beforeEach(() => resetAppDb(':memory:'));
  it("counts each other project's memories once; the current project, unknown sessions and Telegram are left out", () => {
    const ev = createProject({ name: 'Eventing' });
    const fam = createProject({ name: 'Family & school' });
    appendTurn({ ts: 1, session: 'web-old', message: 'old chat', reply: 'x', kind: 'chat' }); // an older conversation: General
    const used = [
      { id: 'm1', session: `p-${ev.id}` }, { id: 'm2', session: `p-${ev.id}` }, { id: 'm1', session: `p-${ev.id}` },
      { id: 'm3', session: `p-${fam.id}` }, { id: 'm4', session: 'web-old' }, { id: 'm5', session: 'agent-123' }, { id: 'm6' }, { id: 'm7', session: 'tg-9' },
    ];
    expect(crossTalk(used, fam.id)).toEqual([{ projectId: ev.id, n: 2 }, { projectId: GENERAL, n: 1 }]);
    expect(crossTalk(used, GENERAL)).toEqual([{ projectId: ev.id, n: 2 }, { projectId: fam.id, n: 1 }]);
    expect(projectOfMemorySession('p-pr_gone')).toBeNull();
  });
});

describe('jobs made from a project thread', () => {
  beforeEach(() => resetAppDb(':memory:'));
  it('carry the project; General lists the jobs no project claims', () => {
    const ev = createProject({ name: 'Eventing' });
    const a = createJob({ kind: 'background', title: 'Learn the rules', session: `p-${ev.id}` }).job;
    expect(a.project_id).toBe(ev.id);
    const cont = queueContinuation({ dueAt: Date.now(), chat: { kind: 'live', title: 'Read the PDFs', request: 'Read the PDFs', session: `p-${ev.id}`, startedAt: Date.now() } })!;
    expect(getJob(cont.jobId)!.project_id).toBe(ev.id);
    expect(createJob({ kind: 'background', title: 'Old', session: 'web-x' }).job.project_id).toBeNull();
  });
});

// ── Over HTTP: scopes, the thread, work, move, sync ─────────────────────────────────────────────────────────────

let server: Server, base = '';
let scopes: Scope[] = [...ALL_SCOPES];
const ws = tmp();
beforeAll(async () => {
  const v1 = createV1(v1Routes(), { authenticate: (): Caller => ({ kind: 'device', id: 'dev_1', scopes: new Set(scopes), viaCookie: false }), sameOrigin: () => true });
  server = createServer(async (req, res) => { if (!(await v1(req, res))) { res.writeHead(404); res.end(); } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
});
afterAll(() => { server?.close(); setProjectRouteDeps(null); setJobRouteDeps(null); rmSync(ws, { recursive: true, force: true }); });
let k = 0;
const send = (method: string, path: string, body?: unknown) => fetch(base + path, { method, headers: { 'idempotency-key': `a5-test-key-${++k}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

describe('/api/v1 projects', () => {
  const started: { projectId: string; text: string }[] = [];
  const moved: string[][] = [];
  beforeEach(() => {
    resetAppDb(':memory:');
    scopes = [...ALL_SCOPES];
    started.length = 0; moved.length = 0;
    setJobRouteDeps({ memory: () => ({}) as never, running: () => new Set(), stopLive: () => false, pendingApprovals: () => new Set(), scheduleControl: async () => ({ ok: true, message: '' }) });
    setProjectRouteDeps({ workspace: () => ws, startChat: async (projectId, text) => { started.push({ projectId, text }); return { state: 'started', runId: 'live_x' }; }, onTurnMoved: (a, b) => moved.push([a, b]) });
  });

  it('a read-only device reads but cannot create, rename, send or move', async () => {
    const ev = createProject({ name: 'Eventing' });
    const t = appendTurn({ ts: 1, session: `p-${ev.id}`, message: 'm', reply: 'r', kind: 'chat' })!;
    scopes = ['read'];
    expect((await fetch(`${base}/projects`)).status).toBe(200);
    expect((await fetch(`${base}/projects/${ev.id}/thread`)).status).toBe(200);
    expect((await fetch(`${base}/projects/${ev.id}/work`)).status).toBe(200);
    expect((await fetch(`${base}/projects/${ev.id}/files`)).status).toBe(200);
    for (const [m, p, b] of [['POST', '/projects', { name: 'X' }], ['PATCH', `/projects/${ev.id}`, { name: 'Y' }], ['POST', `/projects/${ev.id}/messages`, { text: 'hi' }], ['POST', `/turns/${t}/move`, { projectId: GENERAL }]] as const) {
      const r = await send(m, p, b);
      expect(`${m} ${p} ${r.status}`).toBe(`${m} ${p} 403`);
    }
    expect(started).toHaveLength(0);
  });

  it('pages a thread back with `next`', async () => {
    const ev = createProject({ name: 'Eventing' });
    for (let i = 1; i <= 5; i++) appendTurn({ ts: i, session: `p-${ev.id}`, message: `m${i}`, reply: 'r', kind: 'chat' });
    const p1 = await (await fetch(`${base}/projects/${ev.id}/thread?limit=2`)).json();
    expect(p1.turns.map((t: { message: string }) => t.message)).toEqual(['m4', 'm5']);
    const p2 = await (await fetch(`${base}/projects/${ev.id}/thread?limit=2&before=${p1.next}`)).json();
    expect(p2.turns.map((t: { message: string }) => t.message)).toEqual(['m2', 'm3']);
    const p3 = await (await fetch(`${base}/projects/${ev.id}/thread?limit=2&before=${p2.next}`)).json();
    expect(p3).toMatchObject({ next: null });
    expect(p3.turns.map((t: { message: string }) => t.message)).toEqual(['m1']);
  });

  it('sends into the thread, refuses an archived project, and moves with undo', async () => {
    const ev = createProject({ name: 'Eventing' });
    const fam = createProject({ name: 'Family & school' });
    const r = await send('POST', `/projects/${ev.id}/messages`, { text: 'Is Comet entered?' });
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ session: `p-${ev.id}`, state: 'started', runId: 'live_x' });
    expect(started).toEqual([{ projectId: ev.id, text: 'Is Comet entered?' }]);

    const t = appendTurn({ ts: 1, session: `p-${ev.id}`, message: 'Book fair Saturday?', reply: 'You are at Stable View until 1.', kind: 'chat' })!;
    const mv = await (await send('POST', `/turns/${t}/move`, { projectId: fam.id })).json();
    expect(mv).toMatchObject({ from: ev.id, message: 'Moved to Family & school.', undo: { projectId: ev.id }, turn: { id: t, projectId: fam.id, movedFrom: ev.id } });
    expect(moved).toEqual([[ev.id, fam.id]]);
    const undo = await (await send('POST', `/turns/${t}/move`, mv.undo)).json();
    expect(undo.turn).toMatchObject({ projectId: ev.id });

    await send('PATCH', `/projects/${fam.id}`, { archived: true });
    expect((await send('POST', `/projects/${fam.id}/messages`, { text: 'x' })).status).toBe(409);
    const list = await (await fetch(`${base}/projects`)).json();
    expect(list.projects.map((p: { name: string }) => p.name)).toEqual(['General', 'Eventing']);
  });

  it("lists a project's jobs; General also gets the ones no project claims; another person's job is never listed", async () => {
    const ev = createProject({ name: 'Eventing' });
    createJob({ kind: 'background', title: 'Learn the rules', session: `p-${ev.id}` });
    createJob({ kind: 'background', title: 'Unclaimed', session: 'web-x' });
    createJob({ kind: 'background', title: 'Theirs', session: `p-${ev.id}`, person: 'tg-999' });
    const evWork = await (await fetch(`${base}/projects/${ev.id}/work`)).json();
    expect(evWork.jobs.map((j: { title: string }) => j.title)).toEqual(['Learn the rules']);
    const gen = await (await fetch(`${base}/projects/general/work`)).json();
    expect(gen.jobs.map((j: { title: string }) => j.title)).toEqual(['Unclaimed']);
  });

  it('/sync carries projects and turns: a snapshot, then a delta with a moved turn and a renamed project', async () => {
    const ev = createProject({ name: 'Eventing' });
    const t = appendTurn({ ts: 1, session: `p-${ev.id}`, message: 'm', reply: 'r', kind: 'chat' })!;
    const snap = await (await fetch(`${base}/sync?collections=projects,turns`)).json();
    expect(snap.reset).toBe(true);
    expect(snap.upserts.projects.map((p: { name: string }) => p.name)).toEqual(['General', 'Eventing']);
    expect(snap.upserts.turns.map((x: { id: string }) => x.id)).toEqual([t]);
    moveTurn(t, GENERAL);
    updateProject(ev.id, { name: 'Horses' });
    const delta = await (await fetch(`${base}/sync?collections=projects,turns&since=${snap.cursor}`)).json();
    expect(delta.reset).toBe(false);
    expect(delta.upserts.turns).toEqual([expect.objectContaining({ id: t, projectId: GENERAL, movedFrom: ev.id })]);
    expect(delta.upserts.projects).toEqual([expect.objectContaining({ id: ev.id, name: 'Horses' })]);
    // nothing new: an empty delta
    const none = await (await fetch(`${base}/sync?collections=projects,turns&since=${delta.cursor}`)).json();
    expect(none.upserts).toEqual({ projects: [], turns: [] });
  });
});
