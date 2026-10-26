/**
 * list_events (v2 build, slice A7): the helper reads the person's calendar from the synced cache — Google and Outlook
 * together, with MWA's own drafts marked — instead of calling a provider. src/calendar-check.ts already expected a
 * tool by this name (it checks each listed event against the inbox for "moved"/"cancelled" mail); until now none
 * existed. Read-only; an event title is someone else's text (an invitation), so the output is outside content.
 */
import type { RegisteredTool } from '../tools/registry.js';
import { calendarItems } from '../v2/calendar.js';
import { findConflicts } from './conflicts.js';
import { calendarWindow } from './calendar.js';
import { localTz, parseWhen, iso, localMidnight, addDays } from './tz.js';

const MAX_DAYS = 31;

export function calendarTools(): RegisteredTool[] {
  return [{
    def: {
      name: 'list_events',
      description: 'List the person’s calendar (connected Google/Outlook calendars, synced every 30 minutes, plus drafts you proposed that are not confirmed yet) between two dates. Dates as YYYY-MM-DD (local) or ISO 8601. Default: today through 7 days ahead. Read-only. Covers yesterday to two weeks ahead.',
      parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string', description: 'inclusive when a date' } } },
    },
    handler: async (args) => {
      const tz = localTz();
      const today = calendarWindow().from; // yesterday's midnight; today = +1 day
      let fromMs: number, toMs: number;
      try {
        fromMs = args.from ? parseWhen(String(args.from), tz).ms : Date.parse(today) + 86_400_000;
        const to = args.to ? String(args.to) : '';
        toMs = /^\d{4}-\d{2}-\d{2}$/.test(to) ? localMidnight(addDays(to, 1), tz) : to ? parseWhen(to, tz).ms : fromMs + 7 * 86_400_000;
      } catch { return '(could not read those dates — use YYYY-MM-DD)'; }
      if (!(toMs > fromMs)) return '(the end date must be after the start date)';
      if (toMs - fromMs > MAX_DAYS * 86_400_000) toMs = fromMs + MAX_DAYS * 86_400_000;
      const from = iso(fromMs), to = iso(toMs);
      const items = calendarItems(from, to).filter((x) => x.kind === 'event' || x.state === 'draft');
      if (!items.length) return 'No events in that range.';
      const day = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' });
      const t = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
      const lines = items.map((x) => {
        const when = x.allDay ? `${day.format(parseWhen(x.start, tz).ms)} | all day` : `${day.format(Date.parse(x.start))} | ${t.format(Date.parse(x.start))}–${t.format(Date.parse(x.end))}`;
        const tag = x.kind === 'draft' ? ' (draft, not confirmed)' : '';
        return `${when} | ${x.title}${tag}${x.location ? ` | ${x.location}` : ''}`;
      });
      const clashes = findConflicts(from, to);
      if (clashes.length) lines.push('', ...clashes.map((c) => `Double-booked: ${c.a.title} and ${c.b.title} overlap ${day.format(Date.parse(c.start))} ${t.format(Date.parse(c.start))}–${t.format(Date.parse(c.end))}`));
      return lines.join('\n');
    },
  }];
}
