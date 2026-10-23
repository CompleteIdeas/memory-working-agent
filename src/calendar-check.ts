/**
 * BL-73 — a calendar listing, checked against the inbox before the model reads it. An invitation is often not
 * updated when a meeting moves: the email says so, the calendar keeps the old time.
 *
 * Measured in the job bake-off (2026-10-23, Jordan's Nov 10 brief): the calendar showed the Member Services
 * Committee at 2:00 pm that day; an email of Nov 6 ("MOVED to Thu Nov 12, 3:00 pm … I haven't updated the calendar
 * invite yet") came before the previous brief, so "email since the last brief" never met it. All six models,
 * gpt-6.1-sol included, reported the meeting as today at 2:00 pm — 0 of 12. BL-40 and BL-54 saw the same thing with
 * a dentist appointment and a flight. It is not a model problem, so it is not left to the model: MWA searches the
 * inbox for each listed event's title and puts any email that moves, cancels or changes it under the listing.
 *
 * Reads only, with the run's own email search tool; the note is part of the calendar tool's output, so it is fenced
 * and tainted like the rest of it. At most MAX_TITLES searches per listing, each title once per run.
 */

const MAX_TITLES = 6;
const MAX_HITS = 3;

/** A tool that lists calendar events (not one that proposes or creates them). */
export function isCalendarList(tool: string): boolean {
  return /(^|_)(list_events|events_list|list_calendar|calendar_list|calendar_events|list_calendar_events)$/i.test(tool);
}

/** The run's inbox search tool, if it has one; gmail-style tools take a quoted phrase. */
export function emailSearchTool(names: string[]): { name: string; quoted: boolean } | undefined {
  const name = names.find((n) => /(^|_)search_(email|emails|mail|gmail|outlook|inbox)$/i.test(n));
  return name ? { name, quoted: !/outlook/i.test(name) } : undefined;
}

const DATEISH = /^(?:\s*(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?|\s*\d{1,4}[-/.:]\d{1,2}(?:[-/.:]\d{1,4})?|\s*\d{1,2}(?:st|nd|rd|th)?|\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?,?|\s*(?:am|pm)|\s*[–—-]|\s*(?:all[- ]day|to|until))+/i;

/** The events' titles in a listing: JSON summary/title fields, else each line's first part that is not a date or time. */
export function eventTitles(listing: string): string[] {
  const out: string[] = [];
  const add = (t: string) => {
    const s = t.replace(/\s+/g, ' ').trim().replace(/^[-•*]\s*/, '');
    if (s.length >= 6 && /[a-z]{3}/i.test(s) && !out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s.slice(0, 80));
  };
  try {
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) { v.forEach(walk); return; }
      if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (/^(summary|title|subject)$/i.test(k) && typeof x === 'string') add(x); else walk(x); }
    };
    const j = JSON.parse(listing);
    walk(j);
    return out.slice(0, MAX_TITLES);
  } catch { /* not JSON */ }
  for (const line of listing.split('\n')) {
    if (/^no events/i.test(line.trim())) continue;
    const parts = line.split('|').map((p) => p.trim()).filter(Boolean);
    const title = parts.map((p) => p.replace(DATEISH, '').trim()).find((p) => /[a-z]{3}/i.test(p));
    if (title) add(title);
    if (out.length >= MAX_TITLES) break;
  }
  return out;
}

const CHANGE = /\b(?:moved?|moving|resched\w*|postpon\w*|cancel\w*|called off|new (?:time|date|day|location|room|link)|changed?|push(?:ed)? (?:back|to)|delay\w*|instead|updated? (?:time|invite|invitation))\b/i;

/** The search result's messages (a header line and the lines under it) that say an event changed. */
export function changeHits(searchText: string): string[] {
  const msgs: string[] = [];
  for (const line of searchText.split('\n')) {
    if (/^\s/.test(line) && msgs.length) msgs[msgs.length - 1] += ` ${line.trim()}`;
    else if (line.trim()) msgs.push(line.trim());
  }
  return msgs.filter((m) => CHANGE.test(m)).slice(0, MAX_HITS).map((m) => m.slice(0, 240));
}

/** The note to add under a calendar listing, or '' when no email changes a listed event. */
export async function calendarCheck(
  tool: string, listing: string, toolNames: string[],
  search: (name: string, args: Record<string, unknown>) => Promise<string>,
  seen: Map<string, string[]>,
): Promise<string> {
  if (!isCalendarList(tool)) return '';
  const s = emailSearchTool(toolNames);
  if (!s) return '';
  const found: string[] = [];
  for (const title of eventTitles(listing)) {
    let hits = seen.get(title.toLowerCase());
    if (!hits) {
      const q = s.quoted ? `"${title.replace(/"/g, '')}"` : title;
      try { hits = changeHits(await search(s.name, { query: q, max: 10 })); } catch { hits = []; }
      seen.set(title.toLowerCase(), hits);
    }
    for (const h of hits) found.push(`  "${title}": ${h}`);
  }
  if (!found.length) return '';
  return `\n\n(MWA checked these events against the inbox: calendar invitations are often not updated when a meeting moves. These emails may move, cancel or change an event listed above — read them before giving its day or time:\n${found.join('\n')})`;
}
