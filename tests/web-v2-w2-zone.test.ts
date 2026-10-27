// v2 build, slice W2 — the review's zone and calendar-math probes (M4, calmath) as regression tests. This file sets
// the process time zone (Node applies a change of TZ at once) and puts it back afterwards:
//   - a device in London for a person in New York: the stale-day note and the person's day follow the Today's zone;
//     a New event's times go with the device's offset and zone, so the server reads them as entered;
//   - New York around the DST changes: weeks start on Monday and have seven distinct days; an event in the repeated
//     hour is on its own day; an overnight event ends the next morning; the ambiguous 1:30 AM still gets an offset.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { todayView, dateIn, type TodayState } from '../web/src/v2/store/today';
import { addDays, dayKey, draftInput, itemsOnDay, weekLabel, weekStart } from '../web/src/v2/store/calendar-ops';
import { FixtureServer } from '../web/src/v2/dev/fixtures';

const TZ0 = process.env.TZ;
const setTz = (tz: string | undefined) => { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; };
afterAll(() => setTz(TZ0));

describe('a device in London, a person in New York', () => {
  beforeAll(() => setTz('Europe/London'));

  it('the device zone really is London here', () => {
    expect(new Date(Date.UTC(2026, 10, 14, 15)).getHours()).toBe(15);
  });

  it('the stale-day note compares with the person\'s date (the Today\'s zone), not the device\'s', () => {
    const doc = new FixtureServer('N00').today.doc(); // tz America/New_York, date 2026-11-09
    const st = { doc, kept: [], checkinDoneFor: null, wrapDoneFor: null } as unknown as TodayState;
    const lateEvening = Date.UTC(2026, 10, 10, 2, 0); // 2 AM Tuesday in London, 9 PM Monday in New York
    expect(dateIn(lateEvening, 'America/New_York')).toBe('2026-11-09');
    expect(todayView({ ...st, doc: { ...doc, date: '2026-11-09', tz: 'America/New_York' } }, lateEvening)!.staleDay).toBe(false);
    expect(todayView({ ...st, doc: { ...doc, date: '2026-11-09', tz: 'America/New_York' } }, Date.UTC(2026, 10, 10, 6, 0))!.staleDay).toBe(true);
  });

  it('a New event goes with the device\'s offset and zone: 3 PM entered in London is 15:00 UTC', () => {
    const r = draftInput({ title: 'Call', date: '2026-11-14', allDay: false, start: '15:00', end: '16:00', location: '' });
    if (!r.ok) throw new Error(r.error);
    expect(r.body).toMatchObject({ start: '2026-11-14T15:00:00+00:00', end: '2026-11-14T16:00:00+00:00', tz: 'Europe/London' });
    const summer = draftInput({ title: 'Call', date: '2026-07-14', allDay: false, start: '15:00', end: '', location: '' });
    expect(summer.ok && summer.body.start).toBe('2026-07-14T15:00:00+01:00');
  });
});

describe('New York around the clock changes', () => {
  beforeAll(() => setTz('America/New_York'));

  it('weeks start on Monday with seven distinct days, across both changes', () => {
    for (const d of ['2026-11-01T12:00:00-05:00', '2026-11-02T00:30:00-05:00', '2026-03-08T12:00:00-04:00']) {
      const ws = weekStart(Date.parse(d));
      const days = Array.from({ length: 7 }, (_, k) => dayKey(addDays(ws, k)));
      expect(new Date(ws).getDay()).toBe(1);
      expect(new Set(days).size).toBe(7);
      expect(dayKey(addDays(ws, 7))).toBe(dayKey(addDays(addDays(ws, 6), 1)));
    }
    expect(weekLabel(weekStart(Date.parse('2026-11-01T12:00:00-05:00')))).toBe('October 26–November 1');
  });

  it('an event in the repeated hour (1:30–2:30 AM, Nov 1) is on Nov 1 only', () => {
    const day = new Date(2026, 10, 1).getTime();
    const ev = { allDay: false, start: '2026-11-01T05:30:00Z', end: '2026-11-01T07:30:00Z' };
    expect(itemsOnDay([ev], day)).toHaveLength(1);
    expect(itemsOnDay([ev], addDays(day, 1))).toHaveLength(0);
  });

  it('an overnight event ends the next morning; the ambiguous 1:30 AM still gets an offset', () => {
    const late = draftInput({ title: 'Late shift', date: '2026-11-14', allDay: false, start: '22:00', end: '01:00', location: '' });
    expect(late.ok && late.body).toMatchObject({ start: '2026-11-14T22:00:00-05:00', end: '2026-11-15T01:00:00-05:00', tz: 'America/New_York' });
    const amb = draftInput({ title: 'x', date: '2026-11-01', allDay: false, start: '01:30', end: '02:00', location: '' });
    expect(amb.ok && amb.body.start).toMatch(/^2026-11-01T01:30:00-0[45]:00$/);
    expect(amb.ok && Date.parse(amb.body.end!) > Date.parse(amb.body.start)).toBe(true);
  });
});
