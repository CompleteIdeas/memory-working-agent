/**
 * BL-73 — a calendar listing comes with any email that moves one of its events (src/calendar-check.ts). Job bake-off,
 * 2026-10-23: the calendar kept a committee meeting at Nov 10, 2:00 pm after an email moved it to Nov 12, 3:00 pm,
 * and every model — gpt-6.1-sol too — reported the old time (0 of 12).
 */
import { describe, it, expect } from 'vitest';
import { isCalendarList, emailSearchTool, eventTitles, changeHits, calendarCheck } from '../src/calendar-check.js';

const LISTING = 'Tue 2026-11-10 14:00–15:00 | Member Services Committee meeting | Video call\nThu 2026-11-12 09:00 | Board prep call';
const MOVED = 'id: j13 (unread) | Fri 2026-11-06 15:20 | From: Laura Benning <committee@useventing.example> | Subject: Re: Member Services Committee meeting - MOVED to Thu Nov 12, 3:00 pm\n  All, two members can\'t make Tuesday, so the meeting is moved.';
const INVITE = 'id: j08 | Tue 2026-11-03 10:30 | From: Member Services Committee <committee@useventing.example> | Subject: Member Services Committee meeting - Tue Nov 10, 2:00 pm\n  The committee will meet by video call.';

describe('which tools', () => {
  it('lists of events, not proposals; an inbox search, quoted for Gmail-style tools', () => {
    for (const t of ['calendar__list_events', 'list_events', 'google_calendar_list_events', 'outlook_calendar_events']) expect(isCalendarList(t), t).toBe(true);
    for (const t of ['propose_event', 'calendar__propose_event', 'gmail__search_email', 'list_files']) expect(isCalendarList(t), t).toBe(false);
    expect(emailSearchTool(['calendar__list_events', 'gmail__search_email'])).toEqual({ name: 'gmail__search_email', quoted: true });
    expect(emailSearchTool(['search_outlook'])).toEqual({ name: 'search_outlook', quoted: false });
    expect(emailSearchTool(['read_email', 'web__open_page'])).toBeUndefined();
  });
});

describe('event titles', () => {
  it('from pipe-separated lines, bullet lines and JSON', () => {
    expect(eventTitles(LISTING)).toEqual(['Member Services Committee meeting', 'Board prep call']);
    expect(eventTitles('- 9:00 AM–10:00 AM Weekly staff sync\n- 2:00 PM Board prep call')).toEqual(['Weekly staff sync', 'Board prep call']);
    expect(eventTitles(JSON.stringify({ items: [{ summary: 'Dentist - Max', start: { dateTime: '2026-11-12T15:30' } }, { summary: 'Dentist - Max' }] }))).toEqual(['Dentist - Max']);
    expect(eventTitles('No events in that range.')).toEqual([]);
  });
});

describe('emails that change an event', () => {
  it('a moved, cancelled or rescheduled message counts; the original invitation does not', () => {
    expect(changeHits(`${INVITE}\n${MOVED}`)).toHaveLength(1);
    expect(changeHits(`${INVITE}\n${MOVED}`)[0]).toContain('MOVED to Thu Nov 12');
    expect(changeHits('id: 1 | Subject: Board prep call cancelled')).toHaveLength(1);
    expect(changeHits('id: 2 | Subject: Board prep call — agenda attached')).toHaveLength(0);
    expect(changeHits('No messages match.')).toHaveLength(0);
  });
});

describe('the note under a listing', () => {
  it('searches the inbox once per title and names the email that moved the meeting', async () => {
    const queries: string[] = [];
    const seen = new Map<string, string[]>();
    const search = async (_n: string, a: Record<string, unknown>) => { queries.push(String(a.query)); return String(a.query).includes('Committee') ? `${INVITE}\n${MOVED}` : 'No messages match.'; };
    const note = await calendarCheck('calendar__list_events', LISTING, ['calendar__list_events', 'gmail__search_email'], search, seen);
    expect(queries).toEqual(['"Member Services Committee meeting"', '"Board prep call"']);
    expect(note).toContain('calendar invitations are often not updated when a meeting moves');
    expect(note).toContain('"Member Services Committee meeting": id: j13');
    expect(note).not.toContain('j08');
    await calendarCheck('calendar__list_events', LISTING, ['calendar__list_events', 'gmail__search_email'], search, seen);
    expect(queries).toHaveLength(2); // each title once per run
  });
  it('is empty with no inbox tool, no change, a search error, or another tool', async () => {
    expect(await calendarCheck('calendar__list_events', LISTING, ['calendar__list_events'], async () => MOVED, new Map())).toBe('');
    expect(await calendarCheck('calendar__list_events', LISTING, ['gmail__search_email'], async () => INVITE, new Map())).toBe('');
    expect(await calendarCheck('calendar__list_events', LISTING, ['gmail__search_email'], async () => { throw new Error('down'); }, new Map())).toBe('');
    expect(await calendarCheck('gmail__search_email', LISTING, ['gmail__search_email'], async () => MOVED, new Map())).toBe('');
  });
});
