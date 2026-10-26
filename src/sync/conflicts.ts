/**
 * Double-bookings (v2 build, slice A7): timed things in a window that overlap. They become Important items in slice
 * A9 ("Thursday at 4 is double-booked"); here they are computed, deterministically, from the cache.
 *
 * Counted: timed events and open drafts. Not counted: all-day events (a birthday does not clash with a meeting),
 * events the person declined, cancelled ones, removed drafts, and a meeting that sits in two connected calendars
 * at the same times with the same title (one meeting, not two). Touching (one ends at 4, the next starts at 4) is not
 * an overlap. Each pair is reported once, with the part of the overlap inside the window.
 */
import { eventsBetween, draftsBetween, eventItemId } from '../v2/calendar.js';

export interface Timed { id: string; kind: 'event' | 'draft'; title: string; start: string; end: string; allDay?: boolean; status?: string }
export interface Conflict { id: string; a: Timed; b: Timed; start: string; end: string }

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Pure: the overlapping pairs among `items` within [from, to), sorted by overlap start, then ids. */
export function detectConflicts(items: Timed[], from: string, to: string): Conflict[] {
  const timed = items
    .filter((x) => !x.allDay && x.status !== 'declined' && x.status !== 'cancelled' && x.status !== 'removed' && x.end > x.start && x.start < to && x.end > from)
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.end < b.end ? -1 : a.end > b.end ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out: Conflict[] = [];
  for (let i = 0; i < timed.length; i++) {
    const a = timed[i];
    for (let j = i + 1; j < timed.length && timed[j].start < a.end; j++) {
      const b = timed[j];
      if (!(b.start < a.end && a.start < b.end)) continue;
      if (a.start === b.start && a.end === b.end && norm(a.title) === norm(b.title)) continue; // the same meeting, twice
      const [x, y] = a.id < b.id ? [a, b] : [b, a];
      const start = [a.start, b.start, from].sort()[2];
      const end = [a.end, b.end, to].sort()[0];
      out.push({ id: `conflict:${x.id}|${y.id}`, a: x, b: y, start, end });
    }
  }
  return out.sort((p, q) => (p.start < q.start ? -1 : p.start > q.start ? 1 : p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
}

/** The conflicts in the cache (events and open drafts) within [from, to) — UTC ISO strings. */
export function findConflicts(from: string, to: string): Conflict[] {
  const items: Timed[] = [
    ...eventsBetween(from, to).map((e) => ({ id: eventItemId(e.account, e.provider_id), kind: 'event' as const, title: e.title, start: e.start_utc, end: e.end_utc, allDay: e.all_day === 1, status: e.status })),
    ...draftsBetween(from, to).filter((d) => d.state === 'draft').map((d) => ({ id: d.id, kind: 'draft' as const, title: d.title, start: d.start_utc, end: d.end_utc, allDay: d.all_day === 1, status: d.state })),
  ];
  return detectConflicts(items, from, to);
}
