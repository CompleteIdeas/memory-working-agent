/**
 * What an email draft may be addressed to, and how many one run may make (BL-54).
 *
 * BL-53 second pass: "Can you ask my accountant when they need the Q3 receipts by?" left eight drafts to Dana in
 * one run, and the first pass drafted the Harbor Hotel reply eleven times; in a watched run the tripwire only
 * nudges, and a new subject line each time is not an exact repeat. The Nguyen quote went to "Aisha Nguyen", then
 * to "aisha.nguyen@example.com" — neither in anything the run had read. A draft goes to an address the run saw or
 * the person wrote, once per recipient per run unless they ask for more than one.
 */

/** The email tools these rules cover, under any connector's prefix (`gmail__draft_email`). */
export const EMAIL_DRAFT_TOOL = /(?:^|__)(?:draft_email|send_email|draft_outlook)$/;

const ADDRESS = /[a-z0-9._%+'-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;

/** Every email address in a text, lower-cased. */
export function addressesIn(text: string): string[] {
  return (String(text ?? '').match(ADDRESS) ?? []).map((a) => a.toLowerCase());
}

/** A recipient field as text, whatever shape a model gave it: "a@b.c", ["a@b.c"], [{ email: "a@b.c" }]. */
function field(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.map(field).join(', ');
  if (typeof v === 'object') return Object.values(v as Record<string, unknown>).map(field).join(' ');
  return String(v);
}

/** "Draft two versions", "another email", "separate emails": the person asked for more than one. The word must be
 *  about the draft — "a second reminder" or "on a separate note" lifted the limit (review). */
export function asksForVersions(message?: string): boolean {
  const DRAFT = String.raw`(?:drafts?|emails?|e-mails?|versions?|messages?|replies|reply|ones?)`;
  return new RegExp(String.raw`\b(?:versions|variations|alternatives|options for|(?:another|a second|second|a separate|separate|a new|new|a different|two|three|several|a few|multiple|different)\s+${DRAFT}|redo|rewrite|re-?draft|try again)\b`, 'i').test(message ?? '');
}

/** Drafting and sending are different acts: a send after its draft is not a second draft. */
const actOf = (tool?: string) => (/send_/.test(tool ?? '') ? 'send' : 'draft');

/** The recipients a draft goes to, as one key: the same people twice, by the same act, is the same draft. */
export function draftKey(args: Record<string, unknown>, tool?: string): string {
  return `${actOf(tool)}:${[...new Set(addressesIn(field(args.to)))].sort().join(',')}`;
}

const REPEAT = '(refused: you already saved a draft to ';

/** Whether a refusal is the once-per-recipient one: the work is done, nothing failed. */
export function repeatDraftOf(refusal: string): boolean { return refusal.startsWith(REPEAT); }

/**
 * Why this draft must not be made, or null. `seen` is every address the run has met: the person's words, the
 * carried conversation, memory and each tool result. `drafted` holds the recipient sets already drafted to.
 */
export function draftRefusal(args: Record<string, unknown>, seen: Set<string>, drafted: Set<string>, personMessage?: string, tool?: string): string | null {
  const to = field(args.to).trim();
  if (!addressesIn(to).length) {
    return `(refused: the draft needs the recipient's email ADDRESS${to ? `, and "${to.slice(0, 60)}" is not one` : ''}. Find it in their email (search_email / read_email) or ask the person. Never guess an address.)`;
  }
  const unseen = [...new Set(addressesIn(`${to} ${field(args.cc)} ${field(args.bcc)}`))].filter((a) => !seen.has(a));
  if (unseen.length) {
    return `(refused: ${unseen.join(', ')} does not appear in anything you read this run or in the person's words — never guess or build an address. Find it in their email (search_email / read_email) or ask the person.)`;
  }
  if (drafted.has(draftKey(args, tool)) && !asksForVersions(personMessage)) {
    return `${REPEAT}${[...new Set(addressesIn(to))].sort().join(', ')} in this run — it is in Drafts for the person to review. Do not make another: say it is in Drafts and finish.)`;
  }
  return null;
}
