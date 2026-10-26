// v2 slice A5: projects and their threads — the conversation import into General, conversations.ts on the table,
// moving a message (and undo), the routes' scopes, the jobs a project's thread makes, and the /sync collections.
// "Review:" cases are the regressions from the independent review of fd334f5 (probes p1–p7), asserting the fix.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appDb, resetAppDb } from '../src/v2/db.js';
import {
  GENERAL, createProject, updateProject, getTurn, threadPage, moveTurn, crossTalk, insertTurn, writeTurn, interruptStaleRunning, resultSessionFor,
  threadOfSession, runningIn, apiProvenance, apiTurn, MoveError, ProjectError,
} from '../src/v2/projects.js';
import { importConversations, importProgress } from '../src/v2/migrate-conversations.js';
import { appendTurn, readConversation, listConversations, answerOffer, retryBusy } from '../src/conversations.js';
import { createJob, queueContinuation, getJob, projectJobs } from '../src/v2/jobs.js';
import { createV1 } from '../src/api/router.js';
import { v1Routes } from '../src/api/v1.js';
import { ALL_SCOPES, type Caller, type Scope } from '../src/api/auth.js';
import { setJobRouteDeps } from '../src/api/routes/jobs.js';
import { setProjectRouteDeps, projectFiles } from '../src/api/routes/projects.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'mwa-a5-'));
const line = (o: object) => JSON.stringify(o) + '\n';
const T = Date.UTC(2026, 9, 20, 12);
const count = (sql: string, ...a: unknown[]) => (appDb().prepare(sql).get(...a) as { n: number }).n;
const general = () => threadPage(GENERAL, { limit: 200 }).turns;

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
    '{not json\n',
  ];
  const file = join(dir, 'conversations.jsonl');
  writeFileSync(file, rows.join(''));
  return file;
}
function fresh(dir: string, rows: object[]): string {
  const f = join(dir, `c${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(f, rows.map(line).join(''));
  return f;
}

describe('the conversation import (data-008-projects)', () => {
  let dir = '';
  beforeEach(() => { resetAppDb(':memory:'); dir = tmp(); });
  afterAll(() => { /* each test removes its own folder */ });

  it('moves every conversation into General under a dated divider, losslessly, and a second pass adds nothing', async () => {
    try {
      const file = oldLog(dir);
      const before = createHash('sha256').update(readFileSync(file)).digest('hex');
      const r = await importConversations({ file });
      expect(r).toMatchObject({ lines: 7, badLines: 1, conversations: 3, telegramSkipped: 1, inserted: 4, finished: 1, answersFolded: 1, existing: 0 });
      expect(general().map((t) => [t.kind, t.legacy_session])).toEqual([
        ['divider', 'web-a'], ['offer', 'web-a'], ['result', 'web-a'],
        ['divider', 'web-b'], ['chat', 'web-b'],
        ['divider', 'web-c'], ['running', 'web-c'],
      ]);
      expect(general()[0].message).toBe('Conversation from Oct 22: Research AI news and write a newsletter');
      expect(JSON.parse(general()[1].meta!)).toMatchObject({ offer: { answered: 'background', goal: 'a1b2c3d4' } });
      expect(general()[4]).toMatchObject({ reply: 'Thursday at 4.', run_id: 'live_1', tainted: 0 });
      expect(count(`SELECT COUNT(*) n FROM turns WHERE legacy_session LIKE 'tg-%'`)).toBe(0);
      // the older client still opens each conversation by its id
      expect(readConversation('web-a').map((t) => t.kind)).toEqual(['offer', 'result']);
      expect(readConversation('web-b')).toHaveLength(1);
      expect(listConversations().map((c) => c.session).sort()).toEqual(['web-a', 'web-b', 'web-c']);
      // incremental: nothing new, nothing done; read again from the start (state forgotten), nothing doubled
      expect(await importConversations({ file })).toMatchObject({ lines: 0, inserted: 0 });
      appDb().prepare('DELETE FROM conv_import_state').run();
      expect(await importConversations({ file })).toMatchObject({ inserted: 0, conversations: 0, existing: 6, telegramSkipped: 1 });
      expect(general()).toHaveLength(7);
      // lossless: the log is only read
      expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe(before);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('Review H1: two results posted in the same millisecond are two turns, not one "already there"', async () => {
    try {
      const f = fresh(dir, [
        { ts: T, session: 'web-a', message: 'hi', reply: 'hello', kind: 'chat' },
        { ts: T + 10, session: 'web-a', message: 'Job A done', reply: 'RESULT A: the flights', kind: 'result' },
        { ts: T + 10, session: 'web-a', message: 'Job B done', reply: 'RESULT B: the hotel', kind: 'result' },
      ]);
      expect(await importConversations({ file: f })).toMatchObject({ inserted: 3, existing: 0 });
      expect(readConversation('web-a').filter((t) => t.kind === 'result').map((t) => t.reply)).toEqual(['RESULT A: the flights', 'RESULT B: the hotel']);
      // two identical lines are two records too (the line number is part of the key)
      appendFileSync(f, line({ ts: T + 20, session: 'web-a', message: 'same', reply: 'same', kind: 'result' }) + line({ ts: T + 20, session: 'web-a', message: 'same', reply: 'same', kind: 'result' }));
      expect(await importConversations({ file: f })).toMatchObject({ inserted: 2, existing: 0 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('Review H2: lines an older build appends after an import (or after `mwa migrate-v2`) arrive at the next pass', async () => {
    try {
      const f = fresh(dir, [{ ts: T, session: 'web-c', message: 'first', reply: 'one', kind: 'chat' }]);
      await importConversations({ file: f }); // as the CLI does, before the server starts
      appendFileSync(f, line({ ts: T + 3_600_000, session: 'web-c', message: 'written by the old server afterwards', reply: 'two', kind: 'chat' }));
      appendFileSync(f, '{"ts":1,"session":"web-c","mess'); // a line still being written: left for next time
      const r = await importConversations({ file: f });
      expect(r).toMatchObject({ inserted: 1, conversations: 0, badLines: 0 });
      expect(readConversation('web-c').map((t) => t.message)).toEqual(['first', 'written by the old server afterwards']);
      expect(count(`SELECT COUNT(*) n FROM turns WHERE legacy_session = 'web-c' AND kind = 'divider'`)).toBe(1);
      appendFileSync(f, 'age":"third","reply":"3","kind":"chat"}\n');
      expect(await importConversations({ file: f })).toMatchObject({ inserted: 1, badLines: 0 });
      // a replaced log (a rollback restored an older copy) is read again from the start; what is here stays single
      writeFileSync(f, line({ ts: T, session: 'web-c', message: 'first', reply: 'one', kind: 'chat' }) + line({ ts: T + 9, session: 'web-z', message: 'new after rollback', reply: 'z', kind: 'chat' }));
      const again = await importConversations({ file: f });
      expect(again).toMatchObject({ restarted: true, existing: 1, inserted: 1 });
      expect(readConversation('web-c')).toHaveLength(3);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('Review M5: a running turn finished in a later pass is filled in, never doubled, and never gets a second divider', async () => {
    try {
      const f = fresh(dir, [{ ts: T, session: 'web-b', message: 'Write it', reply: '', kind: 'running', runId: 'live_9' }]);
      await importConversations({ file: f });
      appendFileSync(f, line({ ts: T + 60_000, session: 'web-b', message: 'Write it', reply: 'Done: brief.md', kind: 'chat', runId: 'live_9' }));
      expect(await importConversations({ file: f })).toMatchObject({ finished: 1, inserted: 0, conversations: 0 });
      expect(readConversation('web-b').map((t) => [t.kind, t.reply])).toEqual([['chat', 'Done: brief.md']]);
      expect(count(`SELECT COUNT(*) n FROM turns WHERE legacy_session = 'web-b'`)).toBe(2); // the divider and the turn
      // read again from the start: the running line and its end are the same turn
      appDb().prepare('DELETE FROM conv_import_state').run();
      expect(await importConversations({ file: f })).toMatchObject({ inserted: 0, existing: 2 });
      expect(count(`SELECT COUNT(*) n FROM turns WHERE legacy_session = 'web-b'`)).toBe(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('Review M5/D: two conversations starting in the same millisecond stay apart, each under its own divider', async () => {
    try {
      const f = fresh(dir, [
        { ts: T, session: 'web-x', message: 'X1', reply: 'x1', kind: 'chat' }, { ts: T + 5000, session: 'web-x', message: 'X2', reply: 'x2', kind: 'chat' },
        { ts: T, session: 'web-y', message: 'Y1', reply: 'y1', kind: 'result' }, { ts: T + 9000, session: 'web-y', message: 'Y2', reply: 'y2', kind: 'chat' },
      ]);
      await importConversations({ file: f });
      expect(general().map((t) => (t.kind === 'divider' ? `[${t.legacy_session}]` : t.message)).join(' ')).toBe('[web-x] X1 X2 [web-y] Y1 Y2');
      // a conversation that began with a result is titled by the first thing typed in it
      expect(general()[3].message).toBe('Conversation from Oct 20: Y2');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('Review H3: a big log is streamed and committed in batches, with progress, and memory stays flat', async () => {
    try {
      const f = join(dir, 'big.jsonl');
      const reply = 'x'.repeat(3500);
      const chunk: string[] = [];
      for (let i = 0; i < 8000; i++) chunk.push(line({ ts: T + i * 1000, session: `web-${i % 400}`, message: `question ${i}`, reply, kind: 'chat', tainted: false }));
      writeFileSync(f, chunk.join(''));
      const size = readFileSync(f).length;
      const rss0 = process.memoryUsage().rss;
      const t0 = Date.now();
      const p = importConversations({ file: f, batchLines: 500 });
      await new Promise((r) => setImmediate(r));
      expect(importProgress().running).toBe(true); // it yields between batches: a server keeps answering
      const r = await p;
      expect(r).toMatchObject({ inserted: 8000, conversations: 400, offset: size });
      expect(importProgress().running).toBe(false);
      expect(appDb().prepare('SELECT offset, line FROM conv_import_state').get()).toEqual({ offset: size, line: 8000 });
      expect(process.memoryUsage().rss - rss0).toBeLessThan(250 * 1024 * 1024);
      console.log(`[A5 import] ${(size / 1048576).toFixed(0)} MB, 8000 turns in ${Date.now() - t0} ms`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 120_000);

  it("an older conversation's files stay reachable from General, and from the project a turn of it moved to", async () => {
    try {
      await importConversations({ file: oldLog(dir) });
      const ws = join(dir, 'ws');
      mkdirSync(join(ws, 'serve', 'web-a'), { recursive: true });
      writeFileSync(join(ws, 'serve', 'web-a', 'draft.md'), '# Draft');
      mkdirSync(join(ws, 'serve', 'p-general'), { recursive: true });
      writeFileSync(join(ws, 'serve', 'p-general', 'notes.md'), 'notes');
      expect(projectFiles(GENERAL, ws).map((f) => f.path).sort()).toEqual(['serve/p-general/notes.md', 'serve/web-a/draft.md']);
      const ev = createProject({ name: 'Eventing' });
      moveTurn(readConversation('web-a')[1].id!, ev.id);
      expect(projectFiles(ev.id, ws).map((f) => f.path)).toEqual(['serve/web-a/draft.md']);
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
    expect(general().map((t) => t.legacy_session)).toEqual(['web-x']);
    expect(readConversation('web-x').map((t) => t.message)).toEqual(['What is the weather?']);
    expect(readConversation(`p-${eventing.id}`).map((t) => t.message)).toEqual(['Teach me the dressage test']);
    expect(appendTurn({ ts: 12, session: 'tg-1', message: 'hi', reply: 'hi', kind: 'chat' })).toBeUndefined();
    appendTurn({ ts: 13, session: 'p-nope', message: 'lost?', reply: 'no', kind: 'chat' });
    expect(readConversation('p-nope').map((t) => t.message)).toEqual(['lost?']);
  });

  it("Review M6: General's carried context is only what was sent in General, not other conversations shown there", () => {
    appendTurn({ ts: T, session: 'web-old-ui', message: 'SECRET from an old-UI conversation', reply: 'noted', kind: 'chat' });
    appendTurn({ ts: T + 1, session: 'p-general', message: 'General thread message', reply: 'ok', kind: 'chat' });
    expect(readConversation('p-general', 12).map((t) => t.message)).toEqual(['General thread message']);
    expect(general().map((t) => t.message)).toEqual(['SECRET from an old-UI conversation', 'General thread message']); // still shown in the thread
  });

  it('Review M6: one run at a time per project, whichever session alias started it', () => {
    const ev = createProject({ name: 'Eventing' });
    expect(threadOfSession('web-old')).toBe(GENERAL);
    expect(threadOfSession('p-general')).toBe(GENERAL);
    expect(runningIn(GENERAL, ['web-old'])).toBe('web-old'); // a run in an older conversation is General's
    expect(runningIn(ev.id, ['web-old'])).toBeNull();
    expect(runningIn(ev.id, [`p-${ev.id}`])).toBe(`p-${ev.id}`);
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

  it('Review LOW: two turns in the same millisecond keep the order they were written in', () => {
    for (const m of ['first', 'second', 'third']) appendTurn({ ts: 5000, session: 'p-general', message: m, reply: '', kind: 'chat' });
    expect(readConversation('p-general').map((t) => t.message)).toEqual(['first', 'second', 'third']);
  });

  it('Review LOW: a turn for an archived project is kept in General and says so', () => {
    const old = createProject({ name: 'Old' });
    updateProject(old.id, { archived: true });
    const id = appendTurn({ ts: T, session: `p-${old.id}`, message: 'still writing', reply: 'r', kind: 'result' })!;
    expect(getTurn(id)).toMatchObject({ project_id: GENERAL, legacy_session: null });
    expect(getTurn(id)!.reply).toMatch(/Kept in General: Old is archived/);
    expect(count('SELECT COUNT(*) n FROM turns WHERE project_id = ?', old.id)).toBe(0);
  });

  it('Review LOW: a write that meets a busy database is tried again, then fails loudly', () => {
    let n = 0;
    expect(retryBusy(() => { if (++n < 3) throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }); return 'ok'; }, 'test')).toBe('ok');
    expect(n).toBe(3);
    expect(() => retryBusy(() => { throw Object.assign(new Error('locked'), { code: 'SQLITE_BUSY' }); }, 'test')).toThrow('locked');
    expect(() => retryBusy(() => { throw Object.assign(new Error('other'), { code: 'SQLITE_CONSTRAINT' }); }, 'test')).toThrow('other');
  });

  it('answers an offer on the offer turn', () => {
    const a = createProject({ name: 'A' });
    const s = `p-${a.id}`;
    appendTurn({ ts: 1000, session: s, message: 'Research boats', reply: 'offer', kind: 'offer' });
    expect(answerOffer(s, 'now', undefined, undefined, 2000)).toBe(1000);
    expect(readConversation(s)[0].offer).toEqual({ answered: 'now', at: 2000 });
  });
});

describe('Review M9: the conversation functions on a big table (35k turns) each answer in under 50 ms', () => {
  it('listConversations, readConversation (thread and older), answerOffer', () => {
    resetAppDb(':memory:');
    const d = appDb();
    const ins = d.prepare(`INSERT INTO turns (id, n, project_id, session, legacy_session, origin_session, ts, ord, grp, kind, message, reply) VALUES (?, ?, 'general', 'p-general', ?, ?, ?, ?, 0, ?, ?, ?)`);
    const reply = 'r'.repeat(2000);
    d.transaction(() => {
      for (let i = 1; i <= 35_000; i++) {
        const legacy = i % 5 === 0 ? null : `web-${i % 3000}`;
        ins.run(`tu_${i.toString(16).padStart(12, '0')}`, i, legacy, legacy, T + i, T + i, i % 50 === 0 ? 'offer' : 'chat', `question ${i}`, reply);
      }
    })();
    d.exec('ANALYZE');
    const time = (f: () => unknown) => { f(); const t0 = performance.now(); f(); return performance.now() - t0; };
    const results = {
      list: time(() => listConversations(40)),
      readThread: time(() => readConversation('p-general', 12)),
      readOld: time(() => readConversation('web-17', 80)),
      offer: time(() => answerOffer('p-general', 'now', undefined, undefined, Date.now(), 'no such offer')),
      offerOld: time(() => answerOffer('web-17', 'now', undefined, undefined, Date.now(), 'no such offer')),
    };
    console.log('[A5 perf, 35k turns, ms]', JSON.stringify(Object.fromEntries(Object.entries(results).map(([k, v]) => [k, Math.round(v * 10) / 10]))));
    for (const [k, v] of Object.entries(results)) expect(`${k} ${v < 50 ? 'fast' : `${v} ms`}`).toBe(`${k} fast`);
    expect(listConversations(40)).toHaveLength(40);
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
    expect(turn).toMatchObject({ project_id: fam.id, session: `p-${fam.id}`, moved_from: GENERAL, reply: 'Yes, if Sam drives.' });
    expect(threadPage(GENERAL).turns).toHaveLength(0);
    expect(appDb().prepare(`SELECT entity, entity_id FROM events WHERE seq > ?`).all(seq0)).toEqual([{ entity: 'turn', entity_id: id }]);
    expect(moveTurn(id, from).turn).toMatchObject({ project_id: GENERAL, moved_from: fam.id });
  });

  it("Review LOW: a moved turn of an older conversation leaves that conversation too", () => {
    const ev = createProject({ name: 'Eventing' });
    const id = appendTurn({ ts: T, session: 'web-m', message: 'about the horse', reply: 'ok', kind: 'chat' })!;
    const { legacySession } = moveTurn(id, ev.id);
    expect(legacySession).toBe('web-m'); // the server forgets that conversation's carried context
    expect(readConversation('web-m')).toEqual([]);
    expect(readConversation(`p-${ev.id}`).map((t) => t.message)).toEqual(['about the horse']);
  });

  it('Review M7: paging still works when the turn the cursor came from is moved away', () => {
    const ev = createProject({ name: 'Eventing' });
    for (let i = 0; i < 10; i++) writeTurn({ projectId: GENERAL, ts: 1000 + i, kind: 'chat', message: `m${i}`, reply: 'r' });
    const p1 = threadPage(GENERAL, { limit: 5 });
    expect(p1.turns.map((t) => t.message)).toEqual(['m5', 'm6', 'm7', 'm8', 'm9']);
    moveTurn(p1.turns[0].id, ev.id); // the oldest message on screen
    const p2 = threadPage(GENERAL, { before: p1.next!, limit: 5 });
    expect(p2.turns.map((t) => t.message)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    expect(p2.next).toBeNull();
  });

  it('Review LOW: a turn left running by a crashed run becomes "interrupted", can be moved, and is still filled in by its end', () => {
    const ev = createProject({ name: 'Eventing' });
    const id = appendTurn({ ts: T, session: 'p-general', message: 'a run that crashed', reply: '', kind: 'running', runId: 'live_x' })!;
    const live = appendTurn({ ts: T + 10, session: 'p-general', message: 'a run still going', reply: '', kind: 'running', runId: 'live_y' })!;
    expect(interruptStaleRunning(T + 100, new Set(['live_y']))).toBe(1);
    expect(getTurn(id)).toMatchObject({ kind: 'chat', reason: 'interrupted' });
    expect(getTurn(live)).toMatchObject({ kind: 'running' });
    expect(moveTurn(id, ev.id).turn.project_id).toBe(ev.id);
    appendTurn({ ts: T + 500, session: 'p-general', message: 'a run that crashed', reply: 'It finished after all.', kind: 'chat', runId: 'live_x' });
    expect(getTurn(id)).toMatchObject({ reply: 'It finished after all.', project_id: ev.id, reason: null });
  });

  it('refuses a divider, a running answer, an archived or unknown project, and a move to where it is', () => {
    const fam = createProject({ name: 'Family' });
    const div = insertTurn({ projectId: GENERAL, ts: 1, kind: 'divider', message: 'Conversation from Oct 22: x', reply: '' });
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
  });
});

describe('cross-talk provenance (the mapping)', () => {
  beforeEach(() => resetAppDb(':memory:'));
  it("counts each other project's memories once; the current thread, unknown sessions and Telegram are left out", () => {
    const ev = createProject({ name: 'Eventing' });
    const fam = createProject({ name: 'Family & school' });
    const used = [
      { id: 'm1', session: `p-${ev.id}` }, { id: 'm2', session: `p-${ev.id}` }, { id: 'm1', session: `p-${ev.id}` },
      { id: 'm3', session: `p-${fam.id}` }, { id: 'm5', session: 'agent-123' }, { id: 'm6' }, { id: 'm7', session: 'tg-9' },
    ];
    expect(crossTalk(used, { projectId: fam.id, session: `p-${fam.id}` })).toEqual([{ projectId: ev.id, n: 2 }]);
    expect(crossTalk(used, { projectId: GENERAL })).toEqual([{ projectId: ev.id, n: 2 }, { projectId: fam.id, n: 1 }]);
  });

  it('Review LOW: an older conversation is "an earlier conversation" (long ids too), never "General"; archived and private projects are never named', () => {
    const fam = createProject({ name: 'Family & school' });
    const old = createProject({ name: 'Old' });
    const secret = createProject({ name: 'Health', private: true });
    const longId = `web-${'x'.repeat(120)}`;
    appendTurn({ ts: 1, session: longId, message: 'old chat', reply: 'x', kind: 'chat' });
    updateProject(old.id, { archived: true });
    const prov = crossTalk([{ id: 'a', session: 'web-l1fs27p' }, { id: 'b', session: longId }, { id: 'c', session: `p-${old.id}` }, { id: 'd', session: `p-${secret.id}` }], { projectId: fam.id });
    expect(prov).toEqual([{ earlier: true, n: 2 }]);
    expect(apiProvenance(prov)).toEqual([{ projectId: null, name: 'an earlier conversation', n: 2 }]);
    // inside that older conversation itself it is not cross-talk
    expect(crossTalk([{ id: 'b', session: longId }], { projectId: GENERAL, session: longId })).toEqual([]);
  });
});

describe('jobs made from a project thread', () => {
  beforeEach(() => resetAppDb(':memory:'));
  it('carry the project; a session naming no project makes it General\'s (review LOW); General lists the unclaimed ones', () => {
    const ev = createProject({ name: 'Eventing' });
    expect(createJob({ kind: 'background', title: 'Learn the rules', session: `p-${ev.id}` }).job.project_id).toBe(ev.id);
    const cont = queueContinuation({ dueAt: Date.now(), chat: { kind: 'live', title: 'Read the PDFs', request: 'Read the PDFs', session: `p-${ev.id}`, startedAt: Date.now() } })!;
    expect(getJob(cont.jobId)!.project_id).toBe(ev.id);
    expect(createJob({ kind: 'background', title: 'Old', session: 'web-x' }).job.project_id).toBeNull();
    expect(createJob({ kind: 'background', title: 'Orphan', session: 'p-doesnotexist' }).job.project_id).toBe(GENERAL);
    expect(projectJobs(GENERAL).map((j) => j.title).sort()).toEqual(['Old', 'Orphan']);
  });

  it('Review LOW: moving the offer that started a job (or the chat whose run made one) moves the job and where its results go', () => {
    const ev = createProject({ name: 'Eventing' });
    const fam = createProject({ name: 'Family' });
    const goal = 'a1b2c3d4-5555-6666-7777-888899990000';
    const job = createJob({ kind: 'background', title: 'saddles', session: `p-${ev.id}`, legacyGoalId: goal }).job;
    const offer = writeTurn({ projectId: ev.id, ts: 1, kind: 'offer', message: 'research saddles', reply: 'offer', meta: { offer: { answered: 'background', goal: goal.slice(0, 8), at: 2 } } });
    expect(moveTurn(offer.id, fam.id).job).toBe(job.id);
    expect(getJob(job.id)).toMatchObject({ project_id: fam.id, session: `p-${fam.id}` });
    expect(projectJobs(ev.id)).toEqual([]);
    expect(resultSessionFor(`p-${ev.id}`, getJob(job.id)!.project_id)).toBe(`p-${fam.id}`); // its next result lands in Family
    const job2 = createJob({ kind: 'live', title: 'read pdfs', session: `p-${ev.id}` }).job;
    const chat = appendTurn({ ts: 3, session: `p-${ev.id}`, message: 'read the pdfs', reply: 'continuing in the background', kind: 'chat', job: job2.id })!;
    moveTurn(chat, fam.id);
    expect(getJob(job2.id)!.project_id).toBe(fam.id);
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
  const moved: (string | null)[][] = [];
  beforeEach(() => {
    resetAppDb(':memory:');
    scopes = [...ALL_SCOPES];
    started.length = 0; moved.length = 0;
    setJobRouteDeps({ memory: () => ({}) as never, running: () => new Set(), stopLive: () => false, pendingApprovals: () => new Set(), scheduleControl: async () => ({ ok: true, message: '' }) });
    setProjectRouteDeps({ workspace: () => ws, startChat: async (projectId, text) => { started.push({ projectId, text }); return { state: 'started', runId: 'live_x' }; }, onTurnMoved: (a, b, c) => moved.push([a, b, c]),
      stop: () => true, steer: () => true, attach: () => null, acceptOffer: async () => ({ goal: 'g', message: 'On it.' }) });
  });

  it('a read-only device reads but cannot create, rename, send, move, stop, steer or accept', async () => {
    const ev = createProject({ name: 'Eventing' });
    const t = appendTurn({ ts: 1, session: `p-${ev.id}`, message: 'm', reply: 'r', kind: 'chat' })!;
    scopes = ['read'];
    for (const p of ['/projects', `/projects/${ev.id}/thread`, `/projects/${ev.id}/work`, `/projects/${ev.id}/files`]) expect(`${p} ${(await fetch(base + p)).status}`).toBe(`${p} 200`);
    for (const [m, p, b] of [['POST', '/projects', { name: 'X' }], ['PATCH', `/projects/${ev.id}`, { name: 'Y' }], ['POST', `/projects/${ev.id}/messages`, { text: 'hi' }], ['POST', `/turns/${t}/move`, { projectId: GENERAL }],
      ['POST', `/projects/${ev.id}/stop`, {}], ['POST', `/projects/${ev.id}/steer`, { text: 'x' }], ['POST', `/projects/${ev.id}/offer/accept`, {}]] as const) {
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
    const p2 = await (await fetch(`${base}/projects/${ev.id}/thread?limit=2&before=${encodeURIComponent(p1.next)}`)).json();
    expect(p2.turns.map((t: { message: string }) => t.message)).toEqual(['m2', 'm3']);
    const p3 = await (await fetch(`${base}/projects/${ev.id}/thread?limit=2&before=${encodeURIComponent(p2.next)}`)).json();
    expect(p3).toMatchObject({ next: null });
  });

  it('sends into the thread, refuses an archived project, and moves with undo (telling the server which older conversation it left)', async () => {
    const ev = createProject({ name: 'Eventing' });
    const fam = createProject({ name: 'Family & school' });
    const r = await send('POST', `/projects/${ev.id}/messages`, { text: 'Is Comet entered?' });
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ session: `p-${ev.id}`, state: 'started', runId: 'live_x' });
    const t = appendTurn({ ts: 1, session: 'web-old', message: 'Book fair Saturday?', reply: 'You are at Stable View until 1.', kind: 'chat' })!;
    const mv = await (await send('POST', `/turns/${t}/move`, { projectId: fam.id })).json();
    expect(mv).toMatchObject({ from: GENERAL, message: 'Moved to Family & school.', undo: { projectId: GENERAL }, turn: { id: t, projectId: fam.id, movedFrom: GENERAL } });
    expect(moved).toEqual([[GENERAL, fam.id, 'web-old']]);
    expect((await (await send('POST', `/turns/${t}/move`, mv.undo)).json()).turn).toMatchObject({ projectId: GENERAL });
    await send('PATCH', `/projects/${fam.id}`, { archived: true });
    expect((await send('POST', `/projects/${fam.id}/messages`, { text: 'x' })).status).toBe(409);
  });

  it("lists a project's jobs; another person's job is never listed", async () => {
    const ev = createProject({ name: 'Eventing' });
    createJob({ kind: 'background', title: 'Learn the rules', session: `p-${ev.id}` });
    createJob({ kind: 'background', title: 'Theirs', session: `p-${ev.id}`, person: 'tg-999' });
    expect((await (await fetch(`${base}/projects/${ev.id}/work`)).json()).jobs.map((j: { title: string }) => j.title)).toEqual(['Learn the rules']);
  });

  it('/sync carries projects and turns: a snapshot, then a delta with a moved turn and a renamed project', async () => {
    const ev = createProject({ name: 'Eventing' });
    const t = appendTurn({ ts: 1, session: `p-${ev.id}`, message: 'm', reply: 'r', kind: 'chat' })!;
    const snap = await (await fetch(`${base}/sync?collections=projects,turns`)).json();
    expect(snap).toMatchObject({ reset: true, more: false });
    expect(snap.upserts.turns.map((x: { id: string }) => x.id)).toEqual([t]);
    moveTurn(t, GENERAL);
    updateProject(ev.id, { name: 'Horses' });
    const delta = await (await fetch(`${base}/sync?collections=projects,turns&since=${snap.cursor}`)).json();
    expect(delta).toMatchObject({ reset: false, more: false });
    expect(delta.upserts.turns).toEqual([expect.objectContaining({ id: t, projectId: GENERAL, movedFrom: ev.id })]);
    expect(delta.upserts.projects).toEqual([expect.objectContaining({ id: ev.id, name: 'Horses' })]);
  });

  it('Review M8: a big /sync delta comes in pages of at most 500 changes, with turns as summaries', async () => {
    const snap = await (await fetch(`${base}/sync?collections=turns`)).json();
    const long = 'L'.repeat(3000);
    for (let i = 0; i < 1200; i++) appendTurn({ ts: T + i, session: 'p-general', message: `q${i}`, reply: long, kind: 'chat' });
    let cursor = snap.cursor, pages = 0;
    const seen = new Set<string>();
    for (;;) {
      const r = await fetch(`${base}/sync?collections=turns&since=${cursor}`);
      const text = await r.text();
      const page = JSON.parse(text);
      pages++;
      expect(text.length).toBeLessThan(5.5 * 1024 * 1024);
      expect(page.upserts.turns.length).toBeLessThanOrEqual(500);
      for (const x of page.upserts.turns) { seen.add(x.id); expect(x).toMatchObject({ truncated: true }); expect(x.reply).toHaveLength(500); }
      expect(page.cursor).toBeGreaterThan(cursor);
      cursor = page.cursor;
      if (!page.more) break;
    }
    expect(pages).toBe(3);
    expect(seen.size).toBe(1200);
    // the thread still has them whole
    const th = await (await fetch(`${base}/projects/general/thread?limit=1`)).json();
    expect(th.turns[0]).toMatchObject({ truncated: false });
    expect(th.turns[0].reply).toHaveLength(3000);
    expect(apiTurn(getTurn(th.turns[0].id)!, undefined, { summary: true }).truncated).toBe(true);
  });

  it('/meta and /projects say when older conversations are being imported', async () => {
    expect((await (await fetch(`${base}/meta`)).json()).importing).toBeNull();
    expect((await (await fetch(`${base}/projects`)).json()).importing).toBeNull();
  });
});
