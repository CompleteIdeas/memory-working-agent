/**
 * An iCalendar file for one MWA-held draft (v2 build, slice A7): N01's "Just give me a file" and the fallback when
 * no calendar is connected. RFC 5545: CRLF line endings, lines folded at 75 octets (UTF-8, never inside a
 * character), TEXT values escaped, times in UTC, a stable UID and a DTSTAMP.
 */
import { addDays } from './tz.js';

export interface IcsEvent {
  uid: string;
  title: string;
  /** timed: UTC instants (ms). all day: dates ('YYYY-MM-DD'), end exclusive */
  start: number | string;
  end: number | string;
  allDay: boolean;
  location?: string | null;
  notes?: string | null;
  stamp?: number;
}

/** TEXT escaping (RFC 5545 3.3.11): backslash, semicolon, comma, and newlines as \n. Other control characters
 *  (CONTROL in 3.1: U+0000–U+0008, U+000A–U+001F except as \n, U+007F) are dropped; tab is kept. */
export function icsEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000A-\u001F\u007F]/g, '');
}

/** Fold one content line at 75 octets; continuation lines start with one space (which counts). */
export function icsFold(line: string): string {
  const out: string[] = [];
  let cur = '', curBytes = 0, limit = 75;
  for (const ch of line) { // iterates code points: a character is never split
    const b = Buffer.byteLength(ch, 'utf8');
    if (curBytes + b > limit) { out.push(cur); cur = ' '; curBytes = 1; limit = 75; }
    cur += ch; curBytes += b;
  }
  out.push(cur);
  return out.join('\r\n');
}

const utcStamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); // 20261114T200000Z
const dateStamp = (d: string) => d.replace(/-/g, '');

export function buildIcs(e: IcsEvent): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//MWA//Calendar draft//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${e.uid}`,
    `DTSTAMP:${utcStamp(e.stamp ?? Date.now())}`,
  ];
  if (e.allDay) {
    const s = String(e.start), en = e.end && String(e.end) > s ? String(e.end) : addDays(s, 1);
    lines.push(`DTSTART;VALUE=DATE:${dateStamp(s)}`, `DTEND;VALUE=DATE:${dateStamp(en)}`);
  } else {
    lines.push(`DTSTART:${utcStamp(Number(e.start))}`, `DTEND:${utcStamp(Number(e.end))}`);
  }
  lines.push(`SUMMARY:${icsEscape(e.title)}`);
  if (e.location) lines.push(`LOCATION:${icsEscape(e.location)}`);
  if (e.notes) lines.push(`DESCRIPTION:${icsEscape(e.notes)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.map(icsFold).join('\r\n') + '\r\n';
}

/** A file name from a title: 'Book fair' → 'book-fair.ics'. */
export function icsFileName(title: string): string {
  const base = title.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 60);
  return `${base || 'event'}.ics`;
}

/** Parse an iCalendar text back into its VEVENT properties (unfolded, unescaped) — for tests and checks. */
export function parseIcs(text: string): { lines: string[]; events: Record<string, { params: string; value: string }>[] } {
  const unfolded = text.replace(/\r\n[ \t]/g, '');
  const lines = unfolded.split('\r\n').filter((l, i, a) => l !== '' || i < a.length - 1);
  const events: Record<string, { params: string; value: string }>[] = [];
  let cur: Record<string, { params: string; value: string }> | null = null;
  for (const l of lines) {
    if (l === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (l === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const m = /^([A-Z-]+)((?:;[^:]*)?):(.*)$/.exec(l);
    if (!m) continue;
    const value = m[3].replace(/\\(.)/g, (_x, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
    cur[m[1]] = { params: m[2], value };
  }
  return { lines, events };
}
