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

/** The person asks to hear only about changes: "Only alert me if the price changes. No message if it doesn't." */
export function asksChangesOnly(message: string): boolean {
  // BL-54 review: "let me know if it changes", "tell me if the price changes", "alert me when it drops" are the same
  // ask; missed, the watch stayed on "every time" and a failing one messaged daily.
  if (/\b(?:let me know|tell me|alert me|notify me|ping me|text me|message me|email me|warn me)\s+(?:if|when|whenever|as soon as)\b[^.?!]{0,60}?\b(?:changes?|changed|drops?|dropped|rises?|goes (?:up|down)|falls?|moves?|is back|comes back|back in stock|becomes available|opens? up)\b/i.test(message)) return true;
  return /\bonly\s+(?:alert|tell|notify|message|ping|text|email|warn)\s+me\b|\b(?:alert|tell|notify|message|ping|text|email|warn)\s+me\s+only\b|\bno (?:message|alert|ping|text)s? (?:if|when|otherwise)\b|\bnothing otherwise\b|\b(?:don'?t|do not) (?:message|tell|ping|bother|alert) me (?:if|unless|otherwise)\b/i.test(message);
}

/**
 * The quiet window the person's words give, as "HH:MM-HH:MM", or null. "Don't message me before 7 AM or after 9 PM"
 * is 21:00-07:00; "not between 10pm and 6am" is 22:00-06:00. BL-53: MWA set 07:00-21:00 — the inverse — and held
 * Maya's messages all day.
 */
export function quietFromWords(message: string): string | null {
  const t = (x: string, ap?: string) => { const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(x); if (!m) return null; let h = Number(m[1]) % 12; if ((ap ?? '').toLowerCase().startsWith('p')) h += 12; else if (!ap && Number(m[1]) >= 13) h = Number(m[1]); return `${String(h).padStart(2, '0')}:${m[2] ?? '00'}`; };
  const T = String.raw`(\d{1,2}(?::\d{2})?)\s*([ap])\.?\s*m\.?`;
  const ba = new RegExp(`before\\s+${T}[^.?!]{0,40}?after\\s+${T}`, 'i').exec(message);
  if (ba) { const early = t(ba[1], ba[2]); const late = t(ba[3], ba[4]); return early && late ? `${late}-${early}` : null; }
  const ab = new RegExp(`after\\s+${T}[^.?!]{0,40}?before\\s+${T}`, 'i').exec(message);
  if (ab) { const late = t(ab[1], ab[2]); const early = t(ab[3], ab[4]); return early && late ? `${late}-${early}` : null; }
  const bw = new RegExp(`between\\s+${T}\\s+and\\s+${T}`, 'i').exec(message);
  if (bw && /\b(?:don['’]?t|do not|no|never|not)\b/i.test(message)) { const a = t(bw[1], bw[2]); const b = t(bw[3], bw[4]); return a && b ? `${a}-${b}` : null; }
  return null;
}

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

// ── What a job watches (BL-54) ───────────────────────────────────────────────────────────────────

/** What a check looks at, from its instruction: "Check the Atlantic Air flight 482 status page at <url> and message
 *  me only if it changed" is "the Atlantic Air flight 482 status page at <url>". Leads an observation, so recall
 *  meets the thing watched before the job's wording. */
export function subjectOf(instruction: string): string {
  let s = instruction.replace(/\s+/g, ' ').trim()
    .replace(/^(?:please\s+)?(?:check|watch|monitor|track|look at|open|keep an eye on|read)\s+/i, '')
    .replace(/\s+(?:every|each)\s+(?:day|morning|evening|night|week|weekday)\b[^.,;]*/i, '')
    .replace(/\s*(?:,|\band\b|\bthen\b)\s*(?:only\s+)?(?:message|alert|tell|notify|ping|text|email|let|warn)\b.*$/i, '');
  // The first sentence: a period ends one before a capital, but not after an initial or a short abbreviation
  // ("the U.S. Embassy", "Dr. Patel", "St. Mary's" — review).
  for (const m of s.matchAll(/\.\s+(?=[A-Z])/g)) {
    const before = /(\S+)$/.exec(s.slice(0, m.index))?.[1] ?? '';
    if (/^(?:[A-Za-z]|(?:[A-Za-z]\.)+[A-Za-z]|Dr|Mr|Mrs|Ms|Jr|Sr|St|Mt|Ave|No|vs|Inc|Co|Ltd)$/.test(before)) continue;
    s = s.slice(0, m.index); break;
  }
  s = s.replace(/[.;,:]+$/, '');
  return (s || instruction).slice(0, 120);
}

const READING_STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'what', 'when', 'where', 'which', 'who', 'how', 'does', 'did', 'has', 'have', 'any', 'are', 'was', 'were', 'will', 'would', 'can', 'could', 'should', 'you', 'your', 'our', 'its', 'about', 'from', 'into', 'then', 'than', 'there', 'here', 'today', 'tomorrow', 'yesterday', 'now', 'again', 'still', 'just', 'also', 'please', 'check', 'checks', 'checking', 'daily', 'day', 'days', 'every', 'each', 'morning', 'evening', 'night', 'week', 'weekly', 'weekday', 'weekdays', 'message', 'messages', 'alert', 'alerts', 'notify', 'tell', 'ping', 'text', 'only', 'change', 'changes', 'changed', 'set', 'time', 'times', 'minute', 'minutes', 'hour', 'hours', 'run', 'job', 'look', 'see', 'know', 'get', 'let', 'want', 'need', 'not', 'page', 'site', 'status', 'latest', 'new', 'old', 'last', 'next']);
const URL_PARTS = new Set(['https', 'http', 'www', 'com', 'org', 'net', 'example', 'html']);
const readingWords = (s: string) => new Set((s.toLowerCase().match(/[a-z0-9$]+/g) ?? [])
  .filter((w) => w.length >= 3 && !READING_STOP.has(w) && !URL_PARTS.has(w) && !/^(?:19|20)\d\d$/.test(w)));

/**
 * The latest reading of each recurring check whose subject the message is about, newest first: "<subject>: <value>
 * (read <when>)". BL-53 second pass: a flight watch told Sam three times that the flight moved to 8:40; asked "what
 * time does my flight leave tomorrow?", MWA answered 10:15 from the calendar. The watch's observation ranked 35th
 * in recall, under copies of run records and page snapshots. A check's latest reading is a fact MWA holds, not a
 * memory to rank, so a chat about the same thing is shown it. Matching is a content word shared with what the check
 * WATCHES (its subject), not its whole instruction or its reading: an invoice job's "draft a polite payment reminder"
 * would otherwise pull its reading into every chat about drafting.
 */
export function latestReadings(tasks: { instruction: string; task?: string; recur?: string; deliver?: string; until?: string; lastRun?: { at: number; value?: string; valueAt?: number } }[], message: string, max = 6): string[] {
  const asked = readingWords(message);
  if (!asked.size) return [];
  const when = (t: { lastRun?: { at: number; valueAt?: number } }) => t.lastRun?.valueAt ?? t.lastRun?.at ?? 0;
  return tasks
    .filter((t) => t.recur && isWatch(t) && t.lastRun?.value)
    .filter((t) => { const w = readingWords(subjectOf(t.task ?? t.instruction)); return [...asked].some((x) => w.has(x)); })
    .sort((a, b) => when(b) - when(a))
    .slice(0, max)
    .map((t) => `${subjectOf(t.task ?? t.instruction)}: ${String(t.lastRun!.value).replace(/\s+/g, ' ').slice(0, 200)} (read ${friendlyWhen(when(t))})`);
}

/** A job that opens a web page: "check Bloomfield Wholesale's price page", "watch the tracking page". */
export function namesWebPage(text: string): boolean {
  return /\b(?:web\s?pages?|webpages?|web\s?sites?|websites?|(?:status|price|prices|pricing|product|tracking|order|listing|results?|invoices?|billing|account|menu|stock|availability|booking|registration)\s+pages?)\b/i.test(text);
}

/** The text carries a link: http(s)://, www., or a host with a path ("bloomfield-wholesale.example/prices"). A bare
 *  domain is not one — "emails from dana@ledgerline.com" and "my Outlook.com inbox" made briefs watches (review). */
export function hasLink(text: string): boolean {
  const t = text.replace(/[a-z0-9._%+'-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi, ' ');
  return /\bhttps?:\/\/\S+|\bwww\.\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|co|example|gov|edu|us|uk|app|dev|ai|info|biz|shop|store)\/\S*/i.test(t);
}

/**
 * A WATCH: a job that tracks one thing's value — set to report only changes, to finish when something becomes true,
 * or checking a page it names by link. Only a watch keeps a reading (BL-54). A report job — a brief, a plan — gave
 * its whole digest as its "value", and each became a dated observation: Sam's plan restated a stale calendar's
 * dentist time every morning. (The link counts so a watch the person left on "tell me every time" keeps its readings.)
 */
export function isWatch(job: { deliver?: string; until?: string; instruction?: string; task?: string }): boolean {
  return job.deliver === 'changed' || Boolean(job.until) || hasLink(job.task ?? job.instruction ?? '');
}

/** A recurring spec that fires at most once a day: "daily:08:00", "daily:08:00@12345", "every:1440". */
export function atMostDaily(recur?: string): boolean {
  if (!recur) return false;
  if (recur.startsWith('daily:')) return true;
  return recur.startsWith('every:') && Number(recur.slice(6)) >= 1440;
}
