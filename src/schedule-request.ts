/**
 * What a request to set up later work asks for, read from the person's own words (BL-43).
 *
 * BL-40 measured three ways a scheduling request went wrong with nothing to catch it: the run ended at
 * its first `schedule` call, so the second of "two reminders" was never set; "Thursday at 7:00 PM" was
 * stored as 07:00; and the confirmation was a bare "2026-11-05 07:00", which nobody reads as wrong.
 * These helpers give the run something to check against: a once-only push or a read-back. A push the
 * model disagrees with is answered by resending the same call — it is never refused twice.
 */

const NUM: Record<string, number> = { two: 2, both: 2, three: 3, four: 4, five: 5 };

/** The number of jobs the message names outright ("Set two reminders", "2 alerts"), or 0. Not "checks" or
 *  "tasks": "pay both checks", "two tasks for you" are not jobs (BL-43 review). */
export function expectedJobCount(message: string): number {
  const m = /\b(two|both|three|four|five|[2-9])\s+(?:[^\s.,;!?]+\s+){0,2}?(?:reminders|alerts|alarms|jobs|notifications|watches)\b/i.exec(message);
  if (!m) return 0;
  return NUM[m[1].toLowerCase()] ?? Number(m[1]);
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
 * Only times the person wrote with AM/PM count — "at 7" says nothing about which half — and a word for the
 * stored half ("Flight lands 6:30 PM. Remind me at 6:30 tomorrow morning") settles it (BL-43 review).
 */
export function ampmMismatch(message: string, hour: number, minute: number): string | null {
  const stated = statedTimes(message);
  if (!stated.length || stated.some((t) => t.h === hour && t.m === minute)) return null;
  // ...but only right after a mention of the stored hour (BL-52 review: "7:00 PM … and tomorrow morning" was let
  // through by a morning word about something else).
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const half = hour < 12 ? /^[^.!?;]{0,40}?\b(?:in the morning|morning|a\.m\.)/i : /^[^.!?;]{0,40}?\b(?:afternoon|evening|tonight|night|p\.m\.)/i;
  // The whole clock time ("7" or "7:00", never the "7" of "7:00 PM"), and not one written with AM/PM.
  for (const x of message.matchAll(new RegExp(`\\b${h12}(?::${String(minute).padStart(2, '0')})?(?![:\\d])(?!\\s*[ap]\\.?\\s*m\\b)`, 'gi'))) {
    if (half.test(message.slice((x.index ?? 0) + x[0].length))) return null;
  }
  const flipped = stated.find((t) => t.h % 12 === hour % 12 && t.m === minute);
  return flipped ? flipped.text : null;
}

/**
 * BL-49: the sources a scheduled job depends on that this run has not read — only sources a connected tool
 * can read. With memory on, BL-40's morning plan searched email on 4 of 14 mornings and missed the failed
 * autopay; a price watch answered 4 of 15 checks without opening the page. A brief or plan ("what came in",
 * "bills due this week", "anything that needs me") lives in the inbox even when the person never says "email".
 */
export function unreadSources(jobText: string, available: string[], used: Set<string>): string[] {
  const has = (re: RegExp) => available.some((t) => re.test(t));
  const did = (re: RegExp) => [...used].some((t) => re.test(t));
  const EMAIL = /mail|inbox/i;
  const CAL = /calendar|event/i;
  const PAGE = /open_page|fetch_url|http_request|read_document|browse/i;
  // Words outside links only: ".../events" in a URL is not a calendar (BL-52 review).
  const words = jobText.replace(/https?:\/\/\S+/gi, ' ');
  const briefLike = /\b(?:brief|briefing|plan|digest|catch me up|came in|needs? me|my attention|bills?|renew\w*|auto-?renew\w*|charges?|due this week)\b/i.test(words);
  const out: string[] = [];
  // Not "message": "send me a motivational message every morning" reads no inbox (BL-52 review).
  // Only reading: "draft a payment reminder email" writes one, it doesn't read the inbox (BL-53 pilot).
  if (has(EMAIL) && !did(EMAIL) && (/\b(?:inbox|unread|came in|new (?:e-?)?mails?|(?:e-?)?mails? (?:from|about|that|which|in|to me)|(?:read|check|search|scan|go through)\s+(?:my |the |new )?(?:e-?)?mails?)\b/i.test(words) || briefLike)) out.push('email');
  if (has(CAL) && !did(CAL) && /\b(?:calendar|appointments?|meetings?|events?|schedule today)\b/i.test(words)) out.push('the calendar');
  if (has(PAGE) && !did(PAGE) && /https?:\/\/\S+/i.test(jobText)) out.push('the page it watches');
  return out;
}

/**
 * BL-45: the person changes how a recurring job's output should look or what it covers — "From now on,
 * morning brief format should have a separate heading: Team", "keep the morning plan to 3 bullets". Both
 * BL-40 corrections were acknowledged and never reached the job. A standing change in the person's words,
 * about something a job produces.
 */
export function asksToChangeJob(message: string): boolean {
  const standing = /\b(?:from now on|going forward|in (?:the )?future|next time|each time|every time|starting tomorrow|from tomorrow)\b/i.test(message)
    || /\b(?:keep|make|limit|cap)\s+(?:it|them|the\s+[\w ]{1,30}?)\s+(?:to|under|at most|shorter|longer)\b/i.test(message)
    || /\b(?:add|include|use|put|move|drop|remove|skip|stop including)\b.{0,60}\b(?:heading|section|bullets?|format|at the top|first|last)\b/i.test(message);
  // Nouns for a job's output — not "check" or "watch" ("Next time, check with me before you send" is not a job
  // correction; BL-52 review).
  const aboutJob = /\b(?:brief|briefing|plan|summary|digest|report|reminder|alert|morning|daily|weekly|nightly|price check|daily check|price watch)\b/i.test(message);
  return standing && aboutJob;
}

/**
 * The text is the person's own words from their message (BL-53): every content word of it appears in the message,
 * and it carries no link, email address or long number the message does not. A reminder is delivered as written,
 * unfenced — after the conversation has read outside content, only text the person themselves wrote may be.
 */
export function groundedInMessage(text: string, message: string): boolean {
  const lc = message.toLowerCase();
  const words = (s: string) => (s.toLowerCase().match(/[a-z0-9']+/g) ?? []).map((w) => w.replace(/'s$/, '')).filter((w) => w.length > 2 && !GROUND_STOP.has(w));
  const msg = new Set(words(message));
  const content = words(text);
  if (!content.length || content.some((w) => !msg.has(w) && !msg.has(`${w}s`) && !msg.has(w.replace(/s$/, '')))) return false;
  const risky = text.match(/https?:\/\/\S+|www\.\S+|[\w.+-]+@[\w-]+\.[\w.]+|\d{4,}/gi) ?? [];
  return risky.every((r) => lc.includes(r.toLowerCase()));
}
const GROUND_STOP = new Set(['the', 'and', 'for', 'you', 'your', 'about', 'with', 'this', 'that', 'remind', 'reminder', 'remember', 'please', 'today', 'tomorrow', 'tonight', 'time', 'call', 'get', 'make', 'sure']);

/** How schedule_list marks a job set up after reading outside content. A listing with none of them shows only
 *  instructions the person's own clean chats wrote, so it does not taint the run that reads it (BL-52 review:
 *  listing first — as the push to schedule asks — turned every reminder after it into a task). */
export const TAINTED_JOB_MARK = 'set up after reading outside content';

/** "YYYY-MM-DD HH:MM" (or with a T) read as LOCAL time; null when it isn't a real date and time. */
export function parseLocalAt(text: string): number | null {
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})\s*$/.exec(String(text));
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const t = new Date(y, mo - 1, d, h, mi, 0, 0);
  return t.getFullYear() === y && t.getMonth() === mo - 1 && t.getDate() === d && t.getHours() === h && t.getMinutes() === mi ? t.getTime() : null;
}

/** The person's own words in a message: quoted lines ("> …") and fenced blocks are pasted material, someone
 *  else's text — not what a job keeps as the person's request (BL-43 review). */
export function ownWords(message: string): string {
  return message.replace(/```[\s\S]*?```/g, ' ').replace(/^\s*>.*$/gm, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 2000);
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

// ── Days of the week (BL-51) ─────────────────────────────────────────────────────────────────────
// A daily job may run on some days only: "daily:08:00@12345" is 08:00 Monday to Friday (JS getDay digits,
// 0 = Sunday). BL-40: "a weekday 8:00 AM brief" could only be stored as every day, so it arrived on Saturday
// and Sunday — four of Maya's unwanted messages.

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** "weekdays" | "weekends" | "mon,wed,fri" (any day spelling) → "135"-style digits, sorted; null if unreadable. */
export function parseDaysArg(arg: string): string | null {
  const t = arg.trim().toLowerCase();
  if (!t || /^(?:every ?day|daily|all|all days)$/.test(t)) return '';
  if (/^(?:weekdays?|work ?days?|mon(?:day)?\s*(?:-|to|through|–)\s*fri(?:day)?)$/.test(t)) return '12345';
  if (/^weekends?$/.test(t)) return '06';
  const set = new Set<number>();
  for (const part of t.split(/[\s,;/&]+|\band\b/).filter(Boolean)) {
    const i = DAY_NAMES.findIndex((d) => part.startsWith(d));
    if (i < 0) return null;
    set.add(i);
  }
  return set.size ? [...set].sort().join('') : null;
}

/** A daily spec's time and days (days absent = every day). */
export function parseDaily(recur: string): { h: number; m: number; days?: Set<number> } | null {
  const m = /^daily:(\d{1,2}):(\d{2})(?:@([0-6]+))?$/.exec(recur);
  if (!m) return null;
  return { h: Number(m[1]), m: Number(m[2]), ...(m[3] ? { days: new Set([...m[3]].map(Number)) } : {}) };
}

/** The next time a daily spec is due after `fromMs`, on one of its days. */
export function nextDailyDue(recur: string, fromMs: number): number {
  const p = parseDaily(recur) ?? { h: 0, m: 0 };
  const d = new Date(fromMs); d.setHours(p.h, p.m, 0, 0);
  if (d.getTime() <= fromMs) d.setDate(d.getDate() + 1);
  for (let i = 0; i < 7 && p.days && !p.days.has(d.getDay()); i++) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** "weekdays", "weekends", "Mon, Wed and Fri" — or "" for every day. */
export function daysLabel(days?: Set<number>): string {
  if (!days || days.size === 7) return '';
  const k = [...days].sort().join('');
  if (k === '12345') return 'weekdays';
  if (k === '06') return 'weekends';
  const names = [...days].sort().map((i) => DAY_NAMES[i][0].toUpperCase() + DAY_NAMES[i].slice(1));
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
}

/** "daily at 8:00 AM" / "weekdays at 8:00 AM" — a recurring spec in words. */
export function recurWords(recur?: string): string {
  if (!recur) return 'once';
  const d = parseDaily(recur);
  if (d) return `${daysLabel(d.days) || 'daily'} at ${clock12(d.h, d.m)}`;
  if (recur.startsWith('every:')) return `every ${recur.slice(6)} minutes`;
  return recur;
}

/** A job's timing as the person reads it: "daily at 8:00 AM, first Mon 2 Nov 2026 at 8:00 AM". */
export function friendlySchedule(dueMs: number, recur?: string): string {
  if (recur?.startsWith('daily:')) return `${recurWords(recur)}, first ${friendlyWhen(dueMs)}`;
  if (recur?.startsWith('every:')) return `every ${recur.slice(6)} minutes, first ${friendlyWhen(dueMs)}`;
  return friendlyWhen(dueMs);
}
