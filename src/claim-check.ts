/**
 * A reply that says the work was done when the run did nothing of the kind (BL-36).
 *
 * Measured (BL-34): chat `e2e-k5ncb-3` answered "I've scheduled it to be written later" after a single
 * `schedule_list` call and no `schedule`, and MWA logged the run as a success. The person was told a job
 * existed that never would run. This is a RULE, not a model: Clef, asked the same question, flagged a
 * third of honest runs as well.
 *
 * Built for precision: a missed claim leaves today's behaviour, a false one tells the person a finished
 * job failed. The first version read passive sentences ("the reminder is scheduled for 9", "the file
 * was updated by the nightly export") and "I've set up the project" as claims; the review proved each
 * one end to end. So now:
 *   - only the agent speaking of itself, in the past: "I scheduled / wrote / sent …";
 *   - not a clause anchored in the past ("yesterday", "on Oct 16", "already"), which is earlier work;
 *   - a file claim names a file (a known extension or a `backticked` name), so "dana@acme.com" isn't one;
 *   - the caller skips requests that only ask a question, plan steps and resumes (see `claimsApply`).
 */

export type ClaimKind = 'schedule' | 'write' | 'send';

/** Clauses: sentences, then commas / semicolons / colons / dashes / "and" / "but", so "I scheduled it,
 *  and I did not create the file now" keeps its claim and drops the negated half. */
function clauses(text: string): string[] {
  return text
    // Quoted material is someone else's words (an email being summarized), not the agent's claim.
    .replace(/^\s*>.*$/gm, ' ')
    .replace(/“[^”]*”|"[^"\n]*"/g, ' ')
    .split(/(?<=[.!?])\s+|\n+|[;—–]|:\s+|,\s+|\s+(?:and|but|so|then)\s+/i)
    .map((c) => c.trim())
    .filter(Boolean);
}

const NEGATED = /\b(not|never|no|nothing|none|unable|cannot|failed|without)\b|n['’]t\b/i;
// Earlier work, described: "I created `report.md` yesterday", "I've already scheduled the digest".
const PAST = /\b(yesterday|earlier|previously|already|ago|overnight|last (?:night|week|month|time)|on (?:mon|tues|wednes|thurs|fri|satur|sun)day|on \d{4}-\d{2}-\d{2}|on (?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2})\b/i;
const ME = String.raw`^I(?:['’]ve| have)?\s+(?:now\s+|also\s+|just\s+)?`;

const SCHEDULE = [
  new RegExp(`${ME}(?:scheduled|queued|rescheduled)\\b`, 'i'),
  new RegExp(`${ME}(?:created|added|set) (?:a |an |the |your )?(?:reminder|timer|(?:scheduled|recurring|one-time|daily|weekly|hourly) (?:job|task|run))\\b`, 'i'),
  // "I've set up a later run" (e2e-s5mf8-2) — but not "I've set up the project" or "the Gmail connector".
  new RegExp(`${ME}set up (?:a |an |the |your )?(?:(?:later|delayed|scheduled|timed|recurring|future|one-time|daily|weekly|hourly)\\s+)?(?:reminder|timer|run|job)\\b`, 'i'),
];
// A named file: a `backticked` name, or a name with a file extension (not a domain or an email address).
const NAMED_FILE = /`[^`]+`|\b[\w-]+\.(?:txt|md|markdown|csv|tsv|json|jsonl|ya?ml|xml|html?|css|m?js|cjs|tsx?|jsx|py|rb|go|rs|java|c|cpp|h|sh|ps1|bat|sql|ini|toml|cfg|conf|log|pdf|docx?|xlsx?|pptx?|png|jpe?g|gif|svg)\b/i;
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
  for (const c of clauses(reply)) {
    if (NEGATED.test(c) || PAST.test(c) || /\?\s*$/.test(c)) continue;
    if (SCHEDULE.some((r) => r.test(c))) found.add('schedule');
    if ((WRITE.test(c) || WROTE_FILE.test(c)) && NAMED_FILE.test(c)) found.add('write');
    if (SEND.some((r) => r.test(c))) found.add('send');
  }
  return found;
}

/** A request that only asks a question ("What do I have scheduled?", "What did you do overnight?"):
 *  the answer describes work, it doesn't claim to have done it now. "Can you schedule …?" asks for work. */
export function asksOnly(instruction: string): boolean {
  const t = instruction.trim();
  if (/^(can|could|would|will|please)\b/i.test(t)) return false;
  return /^(what|when|which|who|whom|whose|where|why|how)\b/i.test(t) || /\?\s*$/.test(t);
}

/**
 * The claims this run's own record does not back. A write is backed by any change at all (a command
 * that wrote a file, a memory save); a schedule by a schedule or an outside action (a calendar tool's
 * event); a send only by an outside action.
 */
export function unbackedClaims(reply: string, did: ReadonlySet<ClaimKind>): ClaimKind[] {
  const out: ClaimKind[] = [];
  for (const k of claimsIn(reply)) {
    const backed = k === 'write' ? did.size > 0 : k === 'schedule' ? did.has('schedule') || did.has('send') : did.has('send');
    if (!backed) out.push(k);
  }
  return out;
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
