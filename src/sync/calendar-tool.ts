/**
 * list_events (v2 build, slice A7): the helper reads the person's calendar from the synced cache — Google and Outlook
 * together, with MWA's own drafts marked — instead of calling a provider. src/calendar-check.ts already expected a
 * tool by this name (it checks each listed event against the inbox for "moved"/"cancelled" mail); until now none
 * existed. Read-only; an event title is someone else's text (an invitation), so the output is outside content.
 *
 * It never says a range is empty when it does not know (review of A7): an empty answer needs a successful sync of
 * every connected calendar covering that range. Otherwise it says what it doesn't know — never synced, the sign-in
 * needs renewing, or the range is outside what is kept — and every answer says how fresh it is ("as of 9:30 AM").
 */
import type { RegisteredTool } from '../tools/registry.js';
import { calendarItems, getSyncState } from '../v2/calendar.js';
import { findConflicts } from './conflicts.js';
import { calendarAccounts, calendarNow, calendarTz } from './calendar.js';
import { parseWhen, iso, localMidnight, addDays, localDate } from './tz.js';

const MAX_DAYS = 31;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function calendarTools(): RegisteredTool[] {
  return [{
    def: {
      name: 'list_events',
      description: 'List the person’s calendar (connected Google/Outlook calendars, synced every 30 minutes, plus drafts you proposed that are not confirmed yet) between two dates. Dates as YYYY-MM-DD (local) or ISO 8601. Default: today through 7 days ahead. Read-only. Covers yesterday to two weeks ahead, and says how fresh it is.',
      parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string', description: 'inclusive when a date' } } },
    },
    handler: async (args) => listEvents(args),
  }];
}

export function listEvents(args: Record<string, unknown>): string {
  const tz = calendarTz(), now = calendarNow();
  const today = localDate(now, tz);
  let fromMs: number, toMs: number;
  try {
    const from = args.from ? String(args.from) : today;
    fromMs = DATE.test(from) ? localMidnight(from, tz) : parseWhen(from, tz).ms;
    const to = args.to ? String(args.to) : '';
    // days are real calendar days in the person's zone (a clock change makes one 23 or 25 hours)
    toMs = DATE.test(to) ? localMidnight(addDays(to, 1), tz) : to ? parseWhen(to, tz).ms : localMidnight(addDays(localDate(fromMs, tz), 7), tz);
  } catch { return '(could not read those dates — use real dates as YYYY-MM-DD)'; }
  if (!(toMs > fromMs)) return '(the end date must be after the start date)';
  const capped = localMidnight(addDays(localDate(fromMs, tz), MAX_DAYS), tz);
  if (toMs > capped) toMs = capped;
  const from = iso(fromMs), to = iso(toMs);

  const t = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  const day = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' });
  const asOf = (ms: number) => (localDate(ms, tz) === today ? `as of ${t.format(ms)}` : `as of ${day.format(ms)}, ${t.format(ms)}`);

  // What each connected calendar can vouch for in this range.
  const notes: string[] = [];
  let trusted = 0;
  const connected = calendarAccounts().filter((a) => a.connected);
  for (const a of connected) {
    const st = getSyncState(a.account, 'calendar');
    if (a.needsReconnect) { notes.push(`${a.label}: the sign-in needs renewing (reconnect it in Settings), so I can't see changes${a.lastOk ? ` since ${asOf(a.lastOk).slice(6)}` : ''}.`); continue; }
    if (!a.lastOk) { notes.push(`${a.label} hasn't synced yet, so I can't tell what is on it. I can sync it now, or the person can check the connection in Settings.`); continue; }
    if (!st?.window_from || !st.window_to || st.window_from > fromMs || st.window_to < toMs) {
      notes.push(`${a.label}: I only keep yesterday through two weeks ahead, and this range isn't fully covered (${asOf(a.lastOk)}).`);
      continue;
    }
    trusted++;
    notes.push(`${a.label}: ${asOf(a.lastOk)}.`);
  }
  if (!connected.length) notes.push('No calendar is connected, so I can only see drafts kept in MWA. The person can connect Google Calendar or Outlook in Settings.');
  const allKnown = connected.length > 0 && trusted === connected.length;

  const items = calendarItems(from, to).filter((x) => x.kind === 'event' || x.state === 'draft');
  if (!items.length) {
    if (allKnown) return `No events in that range. (${notes.join(' ')})`;
    return `I can't confirm that range is empty. ${notes.join(' ')}`;
  }
  const lines = items.map((x) => {
    const when = x.allDay ? `${day.format(parseWhen(x.start, tz).ms)} | all day` : `${day.format(Date.parse(x.start))} | ${t.format(Date.parse(x.start))}–${t.format(Date.parse(x.end))}`;
    const tag = x.kind === 'draft' ? ' (draft, not confirmed)' : '';
    return `${when} | ${x.title}${tag}${x.location ? ` | ${x.location}` : ''}`;
  });
  const clashes = findConflicts(from, to);
  if (clashes.length) lines.push('', ...clashes.map((c) => `Double-booked: ${c.a.title} and ${c.b.title} overlap ${day.format(Date.parse(c.start))} ${t.format(Date.parse(c.start))}–${t.format(Date.parse(c.end))}`));
  lines.push('', allKnown ? notes.join(' ') : `This may be incomplete. ${notes.join(' ')}`);
  return lines.join('\n');
}
