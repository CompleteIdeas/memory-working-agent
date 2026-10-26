/**
 * The work note names only the goals a message is about (interface slice replay 2026-10-26, gap 5): told about every
 * open goal with "offer to continue it", a run answered "write me an informal note" by writing the board briefing.
 */
import { describe, it, expect } from 'vitest';
import { goalsMentioned, ASKS_ABOUT_WORK, WORK_NOTE_HEAD } from '../src/work-note.js';

const briefing = { id: 'g1', title: 'Research and write the board briefing on the venue quotes' };
const storage = { id: 'g2', title: 'Compare winter storage prices' };

describe('which goals a message is about', () => {
  it('an unrelated request mentions none', () => {
    expect(goalsMentioned('Write me an informal note to the coaches about the schedule change on 15 November', [briefing, storage])).toEqual([]);
    expect(goalsMentioned('What is the total in budget-2026.csv?', [briefing, storage])).toEqual([]);
  });
  it('a question about work in general mentions all; shared words mention one; this conversation\'s goal is kept', () => {
    expect(goalsMentioned('Where are we on the briefing?', [briefing, storage])).toEqual([briefing, storage]);
    expect(goalsMentioned('Is the board briefing done yet?', [briefing, storage])).toEqual([briefing, storage]);
    expect(goalsMentioned('Add the venue quotes to the board briefing as a table', [briefing, storage])).toEqual([briefing]);
    expect(goalsMentioned('Make it shorter', [{ ...briefing, fromHere: true }, storage])).toEqual([{ ...briefing, fromHere: true }]);
    expect(goalsMentioned('storage prices for the boats', [briefing, storage])).toEqual([storage]);
  });
  it('the note frames the goals as information, never as a request', () => {
    expect(ASKS_ABOUT_WORK.test('how is that coming along')).toBe(true);
    expect(ASKS_ABOUT_WORK.test('write a note')).toBe(false);
    expect(WORK_NOTE_HEAD).toMatch(/never continue or redo this work for an unrelated request/);
  });
});
