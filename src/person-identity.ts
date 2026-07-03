/**
 * Identity confidence (S6) — contact/identity anchors double as identity signals. When a new message
 * makes a self-claim (what to call me / how to reach me) that CONTRADICTS what's on record, flag that
 * this might be a different person: drop trust, withhold sensitive/irreversible actions, and confirm
 * before proceeding. A conservative, deterministic anchor-contradiction check (a fuzzy behavioral model
 * pass is a documented future extension). See docs/true-agent-and-person-profile.md.
 *
 * SECURITY POSTURE: this only ever RAISES caution — it never auto-acts, and never lowers the standard
 * safety/approval gates. On any doubt it asks a human to confirm.
 */
import type { PersonNote } from './person.js';

export type IdentityLevel = 'ok' | 'new-claim' | 'mismatch';
export interface IdentityAssessment { level: IdentityLevel; reasons: string[] }

const escapeReg = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Pull explicit self-claims out of a message — conservative on purpose (only unambiguous phrasings),
 *  so ordinary sentences don't read as identity claims. */
function extractClaims(message: string): { name?: string; email?: string } {
  const out: { name?: string; email?: string } = {};
  // NOTE: deliberately does NOT include "it's" — that contraction is far too common ("it's fine",
  // "it's been a while") and would misfire on ordinary conversation, wrongly flagging a mismatch.
  const name = message.match(/\b(?:call me|my name is)\s+([A-Za-z][A-Za-z'-]{1,30})\b/i);
  if (name) out.name = name[1];
  const email = message.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  if (email) out.email = email[0].toLowerCase();
  return out;
}

/** Compare a message's self-claims against the person's stored identity anchors (name/contact). */
export function assessIdentity(profile: PersonNote[], message: string): IdentityAssessment {
  const claims = extractClaims(message ?? '');
  const reasons: string[] = [];
  const nameNotes = (profile ?? []).filter((n) => n.field === 'name').map((n) => n.content.toLowerCase());
  const contactNotes = (profile ?? []).filter((n) => n.field === 'contact').map((n) => n.content.toLowerCase());
  let level: IdentityLevel = 'ok';

  if (claims.name && nameNotes.length) {
    const known = nameNotes.some((c) => new RegExp(`\\b${escapeReg(claims.name!.toLowerCase())}\\b`).test(c));
    if (!known) { level = 'mismatch'; reasons.push(`They now say to call them "${claims.name}", but on record this person is "${profile.find((n) => n.field === 'name')?.content}".`); }
  }
  if (claims.email && contactNotes.length) {
    const known = contactNotes.some((c) => c.includes(claims.email!));
    if (!known) { level = 'mismatch'; reasons.push(`A new contact "${claims.email}" was given that doesn't match the contact on record.`); }
  }
  // A claim with NO prior anchor is simply new information to capture — not a mismatch.
  if (level === 'ok' && (claims.name || claims.email) && !nameNotes.length && !contactNotes.length) level = 'new-claim';
  return { level, reasons };
}

/** Prompt block prepended when identity is in doubt. Empty unless the level is `mismatch`. */
export function identityGuidance(a: IdentityAssessment): string {
  if (a.level !== 'mismatch') return '';
  return `IDENTITY CHECK — something conflicts with what you know about this person: ${a.reasons.join(' ')} ` +
    `Treat their identity as UNVERIFIED for now: do NOT take any sensitive or irreversible action, do NOT reveal ` +
    `stored personal details, and gently confirm who you're speaking with before proceeding.`;
}

/** Does this person have a VALIDATED CONNECTION on file — a channel they've proven they own (recorded
 *  `field=verified-contact`, e.g. an authenticated Telegram chat) that can carry an out-of-band 2nd
 *  factor? Used to decide whether step-up verification is even possible. */
export function hasVerifiedFactor(profile: PersonNote[]): boolean {
  return (profile ?? []).some((n) => n.field === 'verified-contact');
}

/**
 * Step-up verification (S6 v2). When identity is in doubt, a sensitive/irreversible action must be
 * confirmed by a SECOND FACTOR out-of-band — never on the (suspect) current channel alone. Crucially
 * this NEVER names the validated connection (that would leak the real person's contact to a possible
 * impersonator); it only tells the agent that one exists and to route verification through it. Empty
 * unless the level is `mismatch`.
 */
export function stepUpGuidance(profile: PersonNote[], level: IdentityLevel): string {
  if (level !== 'mismatch') return '';
  if (hasVerifiedFactor(profile)) {
    return `STEP-UP VERIFICATION — a validated connection is on file for the REAL person. Before ANY sensitive ` +
      `or irreversible action, require a second factor through that connection OUT-OF-BAND (do NOT reveal or name ` +
      `it here, and do NOT accept confirmation on THIS channel alone); proceed only once it confirms.`;
  }
  return `STEP-UP VERIFICATION — there is NO validated connection on file, so a second factor can't be checked ` +
    `here. Do NOT take any sensitive or irreversible action; ask them to re-establish trust through a channel ` +
    `they've verified before, and offer to set one up.`;
}
