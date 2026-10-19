/**
 * What a request to set up later work asks for, read from the person's own words (BL-43).
 *
 * BL-40 measured three ways a scheduling request went wrong with nothing to catch it: the run ended at
 * its first `schedule` call, so the second of "two reminders" was never set; "Thursday at 7:00 PM" was
 * stored as 07:00; and the confirmation was a bare "2026-11-05 07:00", which nobody reads as wrong.
 * These helpers give the run something to check against. They are hints for a push or a read-back,
 * never a reason to refuse: the model can always say why a job differs from the words.
 */

const NUM: Record<string, number> = { two: 2, both: 2, three: 3, four: 4, five: 5 };

/** The number of jobs the message names outright ("Set two reminders", "2 alerts", "both checks"), or 0. */
export function expectedJobCount(message: string): number {
  const m = /\b(two|both|three|four|five|[2-9])\s+(?:[^\s.,;!?]+\s+){0,2}?(?:reminders|alerts|alarms|checks|jobs|tasks|notifications|watches)\b/i.exec(message);
  if (!m) return 0;
  return NUM[m[1].toLowerCase()] ?? Number(m[1]);
}

const WHEN_RE = /\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b|\btomorrow\b|\btonight\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\bthe \d{1,2}(?:st|nd|rd|th)\b|\b\d{1,2}(?::\d{2})?\s*[ap]\.?m\b\.?|\b\d{1,2}:\d{2}\b/gi;

/** How many distinct days, dates and clock times the message mentions. One job is usually a day and a
 *  time (2); three or more usually means more than one job. Used only to keep a run going after its
 *  first `schedule` — continuing costs one model call, stopping early loses a job. */
export function whenMentions(message: string): number {
  return new Set((message.match(WHEN_RE) ?? []).map((s) => s.toLowerCase().replace(/[\s.]+/g, ''))).size;
}

/** Clock times the person wrote with AM/PM, as 24-hour {h, m}. */
function statedTimes(message: string): { h: number; m: number; text: string }[] {
  const out: { h: number; m: number; text: string }[] = [];
  for (const x of message.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\b\.?/gi)) {
    const h12 = Number(x[1]); const mm = Number(x[2] ?? 0);
    if (h12 < 1 || h12 > 12 || mm > 59) continue;
    const pm = x[3].toLowerCase() === 'p';
    out.push({ h: (h12 % 12) + (pm ? 12 : 0), m: mm, text: x[0].trim() });
  }
  return out;
}

/**
 * The stated time a job's hour contradicts, or null. "Thursday at 7:00 PM" stored as 07:00 (BL-40, Sam)
 * is the shape: the same clock face, the other half of the day, and no stated time that matches exactly.
 * Only times the person wrote with AM/PM count — "at 7" says nothing about which half.
 */
export function ampmMismatch(message: string, hour: number, minute: number): string | null {
  const stated = statedTimes(message);
  if (!stated.length || stated.some((t) => t.h === hour && t.m === minute)) return null;
  const flipped = stated.find((t) => t.h % 12 === hour % 12 && t.m === minute);
  return flipped ? flipped.text : null;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** "7:00 PM" — the person's own clock, the way they wrote it. */
export function clock12(h: number, m: number): string {
  return `${h % 12 === 0 ? 12 : h % 12}:${pad2(m)} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "Thu 5 Nov 2026 at 7:00 PM" — the weekday is what lets a person see a wrong date at a glance. */
export function friendlyWhen(ms: number): string {
  const d = new Date(ms);
  const wd = d.toLocaleDateString('en-US', { weekday: 'short' });
  const mon = d.toLocaleDateString('en-US', { month: 'short' });
  return `${wd} ${d.getDate()} ${mon} ${d.getFullYear()} at ${clock12(d.getHours(), d.getMinutes())}`;
}

/** A job's timing as the person reads it: "daily at 8:00 AM, first Mon 2 Nov 2026 at 8:00 AM". */
export function friendlySchedule(dueMs: number, recur?: string): string {
  if (recur?.startsWith('daily:')) {
    const [h, m] = recur.slice(6).split(':').map(Number);
    return `daily at ${clock12(h || 0, m || 0)}, first ${friendlyWhen(dueMs)}`;
  }
  if (recur?.startsWith('every:')) return `every ${recur.slice(6)} minutes, first ${friendlyWhen(dueMs)}`;
  return friendlyWhen(dueMs);
}
