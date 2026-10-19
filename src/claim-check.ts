/**
 * A reply that says the work was done when the run did nothing of the kind (BL-36).
 *
 * Measured (BL-34): chat `e2e-k5ncb-3` answered "I've scheduled it to be written later" after a single
 * `schedule_list` call and no `schedule`, and MWA logged the run as a success. The person was told a job
 * existed that never would run. This is a RULE, not a model: Clef, asked the same question, flagged a
 * third of honest runs as well.
 *
 * Built for precision: a missed claim leaves today's behaviour, a false one tells the person a finished
 * job failed. Two isolated reviews proved that reading arbitrary replies has a long tail of false flags
 * (recaps, other people's actions, work approved earlier that ran outside the run, a cron job made with a
 * shell command, a code answer). So the rule only judges the case the measured failures share — total
 * evidence of absence (decided 2026-10-18, with a second-model challenge):
 *   - the PERSON's own message asked for that kind of work, and is not a question;
 *   - the run attempted no action of any kind (anything but reads: a write, a command, a send, a
 *     schedule, a memory save, a coding-worker file);
 *   - the reply says, of this run, "I scheduled / wrote / sent …": first person, no negation, no
 *     past-time anchor in the sentence ("Yesterday, I sent …"), and a write names a file.
 */

export type ClaimKind = 'schedule' | 'write' | 'send';

/** Sentences, minus quoted material (someone else's words, e.g. an email being summarized) and code
 *  blocks (an answer that shows code is not a file write). */
function sentences(text: string): string[] {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*>.*$/gm, ' ')
    .replace(/“[^”]*”|"[^"\n]*"/g, ' ')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
/** Clauses of a sentence: commas / semicolons / colons / dashes / "and" / "but", so "I scheduled it,
 *  and I did not create the file now" keeps its claim and drops the negated half. */
const clauses = (sentence: string) => sentence.split(/[;—–]|:\s+|,\s+|\s+(?:and|but|so|then)\s+/i).map((c) => c.trim()).filter(Boolean);

const NEGATED = /\b(not|never|no|nothing|none|unable|cannot|failed|without)\b|n['’]t\b/i;
// Earlier work, described — tested on the whole SENTENCE, since "Yesterday, I sent …" puts the anchor
// in another clause.
const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const PAST = new RegExp(String.raw`\b(yesterday|earlier|previously|already|ago|overnight|this (?:morning|afternoon)|last (?:night|week|month|time|mon|tues|wednes|thurs|fri|satur|sun)(?:day)?|on (?:mon|tues|wednes|thurs|fri|satur|sun)day|on \d{4}-\d{2}-\d{2}|on ${MONTH} \d{1,2}(?:st|nd|rd|th)?|on \d{1,2}(?:st|nd|rd|th)? ${MONTH}|on \d{1,2}/\d{1,2}|(?:after|once|when) you approved|in my (?:previous|last|earlier) (?:reply|message|answer))\b`, 'i');
// When a send or a write happened ("I sent the invoice at 9:14 today") — but a schedule claim names a
// time as a matter of course ("for tomorrow at 9am"), so these don't apply to it.
const PAST_WHEN = /\b(today|tonight|this evening|\d{1,2}:\d{2}|\d{1,2}\s*(?:am|pm))\b/i;
// Content shown in the reply itself: "I created a `useFetch` hook below".
const INLINE = /\b(below|above|following|in this (?:message|reply))\b/i;
const ME = String.raw`^I(?:['’]ve| have)?\s+(?:now\s+|also\s+|just\s+)?`;

const SCHEDULE = [
  new RegExp(`${ME}(?:scheduled|queued|rescheduled)\\b`, 'i'),
  new RegExp(`${ME}(?:created|added|set) (?:a |an |the |your )?(?:reminder|timer|(?:scheduled|recurring|one-time|daily|weekly|hourly) (?:job|task|run))\\b`, 'i'),
  // "I've set up a later run" (e2e-s5mf8-2) — but not "I've set up the project" or "the Gmail connector".
  new RegExp(`${ME}set up (?:a |an |the |your )?(?:(?:later|delayed|scheduled|timed|recurring|future|one-time|daily|weekly|hourly)\\s+)?(?:reminder|timer|run|job)\\b`, 'i'),
];
// A named file: a `backticked` name, or a name with a file extension (not a domain or an email address).
// A name with a file extension, backticked or not — not `useFetch`, a domain or an email address.
const NAMED_FILE = /\b[\w-]+\.(?:txt|md|markdown|csv|tsv|json|jsonl|ya?ml|xml|html?|css|m?js|cjs|tsx?|jsx|py|rb|go|rs|java|c|cpp|h|sh|ps1|bat|sql|ini|toml|cfg|conf|log|pdf|docx?|xlsx?|pptx?|png|jpe?g|gif|svg)\b/i;
const WRITE = new RegExp(`${ME}(?:wrote|written|created|saved|updated|edited|added|appended|overwrote|overwritten)\\b`, 'i');
const WROTE_FILE = /^(?:wrote|created|saved|updated)\s+\S/i; // "Wrote `notes.txt` …" — needs a named file too
const SEND = [
  new RegExp(`${ME}(?:emailed|e-mailed|messaged|forwarded|replied to|sent)\\b(?!\\s+you\\b)`, 'i'),
  /^(?:sent|emailed|forwarded)\s+(?!you\b)\S/i, // "Sent the agenda to Dana."
  /^(?:the )?(?:email|reply|message|invite|invitation)\s+sent\s+to\b/i, // "Email sent to Dana."
];

/** The kinds of work the reply says this run did. */
export function claimsIn(reply: string): Set<ClaimKind> {
  const found = new Set<ClaimKind>();
  for (const s of sentences(reply)) {
    if (PAST.test(s) || /\?\s*$/.test(s)) continue;
    const timed = PAST_WHEN.test(s);
    for (const c of clauses(s)) {
      if (NEGATED.test(c)) continue;
      if (SCHEDULE.some((r) => r.test(c))) found.add('schedule');
      if (timed) continue;
      if ((WRITE.test(c) || WROTE_FILE.test(c)) && NAMED_FILE.test(c) && !INLINE.test(c)) found.add('write');
      if (SEND.some((r) => r.test(c))) found.add('send');
    }
  }
  return found;
}

/** The person's message asks for work to be SET UP to happen later (BL-19). Only a request — the review
 *  of the first version proved "remind me what we decided", "the schedule for the conference",
 *  "schedule.md", a time inside a pasted email and "cancel the reminder for tomorrow at 9" all read as
 *  one. It is still only a hint: the push also needs the run's own evidence (it listed the schedule). */
export function asksForLater(message: string): boolean {
  // The person's own words only: quoted and pasted material (an email being summarized) is not a request.
  // Double quotes only: single quotes are apostrophes too ("I'd like … that's all" read as a quote).
  const own = message.replace(/^\s*>.*$/gm, ' ').replace(/“[^”]*”|"[^"\n]*"/g, ' ');
  if (asksOnly(own)) return false;
  // A request to cancel or stop a job LEADS with it; "Every day at 9, delete old files" is a job (review 2).
  if (/^\s*(?:please\s+)?(?:cancel|stop|delete|remove|turn off|disable|unschedule|pause)\b/i.test(own) || /\b(?:cancel|unschedule|turn off|stop) (?:the|my|that|this) (?:reminder|job|schedule|task)\b/i.test(own)) return false;
  // "schedule" as a verb: leading a sentence or after please / and / then / to / can you — not "the
  // schedule my coach made" or "my schedule this week" (review 2).
  return /(?:^|[.!;]\s*|\b(?:please|and|then|to|can you|could you|would you)\s+)schedule (?:it|this|that|them|a|an|one|two|three|\d+)\b/im.test(own)
    || /\b(?:remind me|set a reminder|add a reminder)\b(?= (?:to|at|in|on|for|tomorrow|tonight|every|next|before|this|the day|(?:mon|tues|wednes|thurs|fri|satur|sun)day))/i.test(own)
    || /\bin (?:\d+|an?|one|two|three)\s*(?:min|mins|minutes?|hours?|days?|weeks?)\b/i.test(own)
    || /\bevery (?:day|morning|evening|night|week|weekday|hour|\d+\s*(?:minutes?|hours?|days?)|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(own)
    || /\b(?:daily at|weekly on)\b/i.test(own)
    // BL-43, measured in BL-40: "Set two reminders for me: …", "Set a daily 9:00 AM check on …", "Set a
    // weekday 8:00 AM brief", "set me up with a short daily plan at 7:00" matched none of the above, so the
    // push never fired and four runs listed the schedule three times and gave up. Narrow on purpose (BL-43
    // review): only set/add/create, only time and kind words between the count and the noun, and not "a
    // summary of …", "a report template", "a plan for the board meeting". A reminder or alert is a request
    // on its own; a check, brief, plan or report needs a when-word somewhere in the message.
    || new RegExp(`${SET_UP}(?:reminders?|alerts?|alarms?)\\b`, 'i').test(own)
    || (new RegExp(`${SET_UP}(?:checks?|briefs?|briefings?|digests?|plans?|summar(?:y|ies)|reports?|watch(?:es)?|monitors?|updates?)\\b${NOT_AN_OBJECT}`, 'i').test(own) && WHEN_WORD.test(own))
    // A standing watch: "always warn me before anything auto-renews", "Only message me if the price changes".
    // "Tell me when you are done", "tell me if anything changed in this diff" and "email me before you send
    // anything" are not: "when"/"if" need a change still to come, and "before" only warns.
    || /\b(?:warn|notify|alert|remind)\s+me\s+(?:before|whenever|as soon as|the moment|any ?time)\b/i.test(own)
    || /\b(?:tell|warn|notify|alert|ping|text|message|email)\s+me\s+(?:only\s+)?(?:when|if|whenever|as soon as|the moment)\b[^.?!]{0,60}?\b(?:changes|drops|rises|goes (?:up|down)|moves|arrives|comes in|ships|is delivered|gets (?:delayed|cancell?ed)|is (?:delayed|cancell?ed)|goes on sale|is back)\b/i.test(own)
    || /\b(?:give|send) me a heads[- ]up\b/i.test(own);
}

/** Words that may sit between "set a" and the thing being set: when it runs and what kind it is. */
const FILLER = String.raw`(?:daily|weekly|weekday|weekdays|monthly|hourly|morning|evening|nightly|recurring|quick|short|new|separate|price|invoice|inbox|email|calendar|flight|renewal|bill|\d{1,2}(?::\d{2})?|[ap]\.?m\.?)`;
/** "Set (me up with) a / two / 2 <time and kind words> " — the opening of a request to create something. */
const SET_UP = String.raw`\b(?:set|add|create)\s+(?:me\s+)?(?:up\s+)?(?:with\s+)?(?:a|an|one|two|three|four|five|\d+|both|some)\s+(?:${FILLER}\s+){0,4}`;
/** The noun is the object of now-work: "a summary of …", "a report template", "a plan for the meeting" (but "for me" is fine). */
const NOT_AN_OBJECT = String.raw`(?!\s+(?:of|about|template|list|file|document|doc|draft|outline|section)\b)(?!\s+for\s+(?!me\b))`;
/** A word that places something in time — what turns "a brief" into a job. */
const WHEN_WORD = /\b(?:daily|weekly|monthly|hourly|weekdays?|every|mornings?|evenings?|nightly|tomorrow|tonight|(?:mon|tues|wednes|thurs|fri|satur|sun)day|\d{1,2}(?::\d{2})?\s*[ap]\.?m\b|\d{1,2}:\d{2})/i;

/** The kinds of work the person's message asks for. Loose on purpose: it only decides whether a claim
 *  is checked at all, and the other conditions carry the precision. */
export function requestedKinds(message: string): Set<ClaimKind> {
  const k = new Set<ClaimKind>();
  if (/\b(schedule|reschedule|remind|reminder|later|tomorrow|tonight|every|daily|weekly|hourly|monthly|recurring|in \d+\s*(?:min|mins|minutes?|hours?|days?|weeks?))\b/i.test(message)) k.add('schedule');
  if (/\b(e-?mail|send|reply|respond|forward|message|invite|notify)\b/i.test(message)) k.add('send');
  if (/\b(write|save|create|make|generate|put|store|export|update|edit|append|add)\b/i.test(message)) k.add('write');
  return k;
}

/** A request that only asks a question ("What do I have scheduled?", "What did you do overnight?"):
 *  the answer describes work, it doesn't claim to have done it now. "Can you schedule …?" asks for work. */
export function asksOnly(message: string): boolean {
  const t = message.trim();
  // "Can you check / confirm …?" asks about work; "Can you send …?" asks for it (confirmation review).
  if (/^(can|could|would) you (check|confirm|verify|see|tell me|let me know|find out)\b/i.test(t)) return true;
  if (/^(can|could|would|will|please)\b/i.test(t)) return false;
  // Yes/no questions too, with or without a "?" ("did you send dana the invoice"), and a "?" anywhere
  // ("Did you send it? She says she never got it.") — review 3.
  return /^(what|when|which|who|whom|whose|where|why|how|did|does|is|are|was|were|has|have|had)\b/i.test(t)
    || /^do (you|i|we|they|it|he|she)\b/i.test(t)
    || t.includes('?');
}

/**
 * The claims nothing in this run backs: only when the run attempted no action of any kind (`acted` —
 * the caller counts every tool that isn't a read, staged or refused ones too), the person's message
 * asked for that kind of work, and isn't a question.
 */
export function unbackedClaims(reply: string, acted: boolean, request: string): ClaimKind[] {
  if (acted || asksOnly(request)) return [];
  const asked = requestedKinds(request);
  return [...claimsIn(reply)].filter((k) => asked.has(k));
}

const VERB: Record<ClaimKind, [string, string]> = {
  schedule: ['scheduled', 'scheduled'],
  write: ['wrote', 'written'],
  send: ['sent', 'sent'],
};

/** The one re-prompt the loop gives before accepting `done` (shared with the substance gate, which
 *  passes any run that used a tool at all — `e2e-k5ncb-3` had listed the schedule). It asks for a
 *  CORRECT answer, not for the action: on a false alarm, an order to act would create work nobody
 *  asked for (review: "set up the project" once produced a real scheduled job). */
export function unbackedNudge(kinds: ClaimKind[]): string {
  const said = kinds.map((k) => VERB[k][0]).join(' / ');
  return `Your answer says you ${said} something in this run, but this run has not done that. Correct the answer: `
    + 'if it was not done, say so plainly; if it was done earlier, say when. Only take the action now if the request asks for it and it is still not done.';
}

/** The line appended to the reply, so the person sees the gap rather than only a log field. */
export function unbackedNote(kinds: ClaimKind[]): string {
  const said = kinds.map((k) => VERB[k][0]).join(' / ');
  const done = kinds.map((k) => VERB[k][1]).join(' or ');
  return `⚠ Not done: this reply says it ${said} something, but nothing was ${done} in this run.`;
}
