/**
 * The web app's task model (interface slice of the usability review, 2026-10-25): one status per request, derived
 * from the run events and the conversation's turn kinds; cards placed in the task that raised them, de-duplicated
 * and in plain words; revisions kept under the task they revise; Telegram not mentioned where it is not connected.
 */
import { describe, it, expect } from 'vitest';
import { buildTasks, plainReply, plainCard, titleOf, withoutTelegram, parseRevision, revisionMessage, setGrantedNames, cardsFor, commandInWords } from '../web/src/tasks';
import type { ConversationTurn, PendingApproval, ScheduleRow } from '../web/src/api';

const S = 'web-abc1234';
const turn = (ts: number, message: string, reply: string, extra: Partial<ConversationTurn> = {}): ConversationTurn => ({ ts, session: S, message, reply, kind: 'chat', reason: 'done', ...extra });
const card = (id: string, createdAt: number, extra: Partial<PendingApproval> = {}): PendingApproval => ({ id, tool: 'run_command', summary: `Run this command in C:\\x\\serve\\${S}:\n  Copy-Item -LiteralPath 'C:\\g\\granted\\a.txt' -Destination 'C:\\g\\granted\\b.txt'\n(Needs approval because "Copy-Item" is not on the read-only list.)`, expiresInSec: 600, expiresAt: createdAt + 600_000, tainted: false, kind: 'tool', session: S, createdAt, ...extra });
const base = { session: S, pending: [] as PendingApproval[], recent: [], schedule: [] as ScheduleRow[], goals: [] };

describe('titles from the person\'s words', () => {
  it('takes the first sentence, drops please and full paths', () => {
    expect(titleOf('Please read C:\\Users\\me\\docs\\budget-2026.csv and tell me what is over. Thanks')).toBe('Read budget-2026.csv and tell me what is over.');
    expect(titleOf('x'.repeat(100)).length).toBeLessThanOrEqual(72);
  });
});

describe('status, one per task', () => {
  it('derives working, waiting for you, scheduled, done, stopped and failed', () => {
    const now = 1_000_000;
    const tasks = buildTasks({ ...base, turns: [
      turn(now, 'q1', 'a1'),
      turn(now + 10_000, 'q2', 'a2', { reason: 'stopped' }),
      turn(now + 20_000, 'q3', 'a3', { reason: 'max steps' }),
      turn(now + 30_000, 'Remind me at 9 to call Harbour Works', 'ok'),
      turn(now + 40_000, 'copy a to b', 'waits for you'),
      turn(now + 50_000, 'q6', '', { kind: 'running', runId: 'live_1' }),
    ], pending: [card('c1', now + 35_000)], schedule: [{ id: 'j1', kind: 'reminder', request: 'Remind me at 9 to call Harbour Works', instruction: 'x', due: now + 1e6, recur: null, when: 'tomorrow 9:00', paused: false, tainted: false, allow: null, session: S }] });
    expect(tasks.map((t) => t.status)).toEqual(['done', 'stopped', 'failed', 'scheduled', 'needs-you', 'working']);
    expect(tasks[4].cards.map((c) => c.id)).toEqual(['c1']);
    expect(tasks[3].jobs.map((j) => j.id)).toEqual(['j1']);
  });
  it('a running turn the server no longer has is failed, not working forever', () => {
    const tasks = buildTasks({ ...base, turns: [turn(1, 'q', '', { kind: 'running', runId: 'live_x' })], lost: new Set(['live_x']) });
    expect(tasks[0].status).toBe('failed');
  });
  it('an answered offer handed to the background is working until its result arrives, then done', () => {
    const offer = turn(1000, 'Write a board briefing', 'offer', { kind: 'offer', reason: 'offer' });
    const t1 = buildTasks({ ...base, turns: [offer], offers: { [`${S}:1000`]: { answered: 'background' } } });
    expect(t1[0].status).toBe('working');
    const t2 = buildTasks({ ...base, turns: [offer, turn(9000, 'Write a board briefing', 'Here it is', { kind: 'result' })], offers: { [`${S}:1000`]: { answered: 'background' } } });
    expect(t2).toHaveLength(1);
    expect(t2[0].status).toBe('done');
    expect(t2[0].results).toHaveLength(1);
    // the newest result says how it ended: a background run that got stuck is failed, not done
    const t3 = buildTasks({ ...base, turns: [offer, turn(9000, 'Write a board briefing', 'ready', { kind: 'result', reason: 'budget' }), turn(9500, 'Write a board briefing', 'cannot confirm', { kind: 'result', reason: 'stuck' })], offers: { [`${S}:1000`]: { answered: 'background' } } });
    expect(t3[0].status).toBe('failed');
  });
  it('an offer answered on another device shows as handed over, linked to its goal by words and time', () => {
    const offer = turn(1000, 'Research and write a one-page board briefing (save it as board-briefing.md) from my notes', 'offer', { kind: 'offer', reason: 'offer' });
    const goal = { id: 'g1', title: 'Research and write a one-page board briefing (save it as board-briefing.md) from my…', status: 'in_progress' as const, priority: 'normal', createdAt: 1500, jobs: 1, record: null, thought: null };
    const [t] = buildTasks({ ...base, turns: [offer], goals: [goal] });
    expect(t.offer?.answered).toBe('background');
    expect(t.status).toBe('working');
    expect(buildTasks({ ...base, turns: [offer], goals: [] })[0].status).toBe('needs-you');
  });
  it('reads a command verb from the command, not from a file name', () => {
    expect(commandInWords(`python -c "from pathlib import Path; p=Path('board-briefing.md'); print(p.is_file())"`).title).toBe('Run a small script on board-briefing.md');
    expect(commandInWords(`Rename-Item -LiteralPath 'C:\\g\\granted\\meeting-notes-oct.txt' -NewName 'meeting-notes-october.txt'`).title).toBe('Rename meeting-notes-oct.txt to meeting-notes-october.txt');
  });
});

describe('cards inside their task', () => {
  it('places a card staged early in a task in that task, not the one before it', () => {
    const tasks = buildTasks({ ...base, turns: [turn(10_000, 'first', 'a'), turn(40_000, 'second', 'b')], pending: [card('c2', 12_000)] });
    expect(tasks[0].cards).toHaveLength(0);
    expect(tasks[1].cards.map((c) => c.id)).toEqual(['c2']);
  });
  it('shows the same action once', () => {
    const cs = cardsFor(S, [card('a', 1), card('b', 2)], []);
    expect(cs).toHaveLength(1);
    expect(cs[0].dupes).toEqual(['b']);
  });
  it('treats the same file made two ways (write_file and a shell copy) as one decision', () => {
    const w = card('w', 3, { tool: 'write_file', summary: 'Create the file C:\\g\\granted\\b.txt (120 bytes) in a folder you granted.' });
    const cs = cardsFor(S, [card('a', 1), w], []);
    expect(cs).toHaveLength(1);
    expect(cs[0].dupes).toHaveLength(1);
  });
  it('puts a resume\'s result in the task with the same words, and lets it decide how that task ended', () => {
    const tasks = buildTasks({ ...base, turns: [turn(1000, 'From now on, keep answers short.', 'ok', { reason: 'stuck' }), turn(2000, 'rename a to b', 'waits'), turn(3000, 'From now on, keep answers short.', 'saved', { kind: 'result', reason: 'done' })] });
    expect(tasks).toHaveLength(2);
    expect(tasks[0].results).toHaveLength(1);
    expect(tasks[0].status).toBe('done');
  });
  it('words a copy plainly, with the folder and no full path', () => {
    setGrantedNames(['C:\\g\\granted']);
    const p = plainCard(card('a', 1));
    expect(p.title).toBe('Copy a.txt to b.txt');
    expect(p.rows.find(([k]) => k === 'Where')?.[1]).toBe('granted (a folder you granted)');
    expect(JSON.stringify(p.rows)).not.toMatch(/C:\\/);
    expect(p.exact).toContain('Copy-Item');
  });
  it('words a listing as a look, and a policy card by its rule', () => {
    expect(commandInWords(`powershell -NoProfile -Command "Get-ChildItem -LiteralPath 'C:\\g\\granted'"`).title).toBe('List the files in granted');
    const pol = plainCard({ tool: 'policy_save', kind: 'captured-policy', summary: 'Save a standing preference (it applies to every future task): "Keep answers under 120 words and use British spelling."' });
    expect(pol.title).toBe('Save a standing preference');
    expect(pol.rows[0][1]).toBe('Keep answers under 120 words and use British spelling.');
  });
});

describe('revise and copy', () => {
  it('a revision message names the task and quotes the answer, and sits under that task', () => {
    const [orig] = buildTasks({ ...base, turns: [turn(1000, 'Draft a note to members about the regatta.', 'Dear members, the regatta is on 15 Nov.')] });
    const msg = revisionMessage(orig, 'shorter, under 40 words');
    expect(parseRevision(msg)).toEqual({ title: orig.title, change: 'shorter, under 40 words' });
    const tasks = buildTasks({ ...base, turns: [turn(1000, 'Draft a note to members about the regatta.', 'Dear members…'), turn(5000, msg, 'Members: regatta 15 Nov.')] });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].revisions).toHaveLength(1);
    expect(tasks[0].revisions[0].reply).toBe('Members: regatta 15 Nov.');
  });
  it('shortens full drive paths in a reply, but not a link target', () => {
    const t = 'Waiting: Create the file C:\\Users\\x\\granted\\b.txt. See [b](C:\\Users\\b.txt).';
    expect(plainReply(t, false)).toBe('Waiting: Create the file b.txt. See [b](C:\\Users\\b.txt).');
  });
  it('drops Telegram from replies when it is not connected, and keeps it when it is', () => {
    const r = 'Approve it where you asked: the approvals panel in the app, or the button in Telegram.';
    expect(withoutTelegram(r, false)).toBe('Approve it where you asked: the card in this task.');
    expect(withoutTelegram(r, true)).toBe(r);
  });
});
