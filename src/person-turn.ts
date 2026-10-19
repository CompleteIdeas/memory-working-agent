/**
 * Per-turn person plumbing shared by every surface (serve chat, Telegram, email) so the person-model
 * behaves identically everywhere. Two calls per turn:
 *   preparePersonTurn(memory, ref, message) → { personId, personContext, mismatch, ... }  (before runAgent)
 *   learnFromTurn(brain, memory, prepared, message, reply)                                (after runAgent)
 *
 * Composition = [identity guard?] + [who-I'm-talking-to primer] + [gentle intake hint], with the S6
 * REDACTION: on a suspected identity mismatch we prime ONLY the guard — never the stored dossier/PII —
 * and suppress learning so an impersonator can't rewrite the profile. See docs/true-agent-and-person-profile.md.
 */
import type { Provider } from './provider.js';
import type { MwaMemory } from './awm.js';
import { resolvePersonId, buildPersonPrimer, type PersonNote, type PersonRef } from './person.js';
import { intakeHint } from './person-intake.js';
import { assessIdentity, identityGuidance, stepUpGuidance, type IdentityAssessment } from './person-identity.js';
import { learnAboutPerson, compressPersonDossier } from './person-learn.js';
import { markSuspicious, isSuspicious } from './step-up.js';
import { MEMORY_OFF } from './memory-off.js';

export interface PersonContext { text?: string; identity: IdentityAssessment }

/** Build the per-person prompt block for a message. On an identity mismatch, REDACT: return only the
 *  guard + step-up-verification instruction (no stored details, and the validated connection is never
 *  named). Otherwise return the primer + a gentle intake hint. Pure + unit-testable. */
export function composePersonContext(profile: PersonNote[], message: string, name?: string): PersonContext {
  const identity = assessIdentity(profile, message);
  if (identity.level === 'mismatch') {
    const text = [identityGuidance(identity), stepUpGuidance(profile, identity.level)].filter(Boolean).join('\n\n') || undefined;
    return { text, identity }; // redacted — guard + step-up only, no PII, connection never named
  }
  const text = [buildPersonPrimer(profile, { name }), intakeHint(profile)].filter(Boolean).join('\n\n') || undefined;
  return { text, identity };
}

export interface PreparedPerson { personId: string; name?: string; personContext?: string; mismatch: boolean; reasons: string[]; notes: number }

/** Resolve who's talking + build their prompt context. Best-effort — never throws, never blocks a turn.
 *  When `channelVerified` (an authenticated channel like Telegram), records this channel as a VALIDATED
 *  CONNECTION for the person the first time — so a future out-of-band step-up (S6 v2) has a factor. */
export async function preparePersonTurn(memory: MwaMemory, ref: PersonRef, message: string, opts: { channelVerified?: boolean } = {}): Promise<PreparedPerson> {
  const personId = resolvePersonId(ref);
  const name = ref.name;
  // Off by switch, or with memory off: a person profile is memory (MWA_MEMORY=off, src/memory-off.ts).
  if (process.env.MWA_PERSON_PROFILE === '0' || MEMORY_OFF) return { personId, name, mismatch: false, reasons: [], notes: 0 };
  try {
    const profile = await memory.recallPersonProfile(personId);
    if (opts.channelVerified && personId !== 'unknown' && !profile.some((n) => n.field === 'verified-contact')) {
      const id = await memory.rememberAboutPerson(personId, `${ref.channel ?? 'this'} channel (identity-bearing, validated)`, 'fact', 'verified-contact');
      if (id) profile.push({ id, personId, kind: 'fact', content: `${ref.channel ?? 'this'} channel`, field: 'verified-contact' });
    }
    const c = composePersonContext(profile, message, name);
    const currentMismatch = c.identity.level === 'mismatch';
    if (currentMismatch) markSuspicious(personId); // STICKY: flag persists across turns until step-up clears it
    // Identity is "in doubt" on a fresh mismatch OR while a prior mismatch's suspicion window is still open —
    // this is what closes the split-claim bypass (claim on turn 1, sensitive request on turn 2).
    const inDoubt = currentMismatch || (personId !== 'unknown' && isSuspicious(personId));
    let text = c.text;
    if (inDoubt && !currentMismatch) {
      // Suspicion carried over from an earlier turn (no self-claim this turn) — still redact + arm step-up.
      text = [identityGuidance({ level: 'mismatch', reasons: ['Identity is unverified pending step-up from an earlier flag.'] }), stepUpGuidance(profile, 'mismatch')].filter(Boolean).join('\n\n') || undefined;
    }
    return { personId, name, personContext: text, mismatch: inDoubt, reasons: c.identity.reasons, notes: profile.length };
  } catch { return { personId, name, mismatch: false, reasons: [], notes: 0 }; }
}

/** After the reply: learn durable facts about the person + recompress the dossier. Suppressed for the
 *  shared 'unknown' profile and on an identity mismatch. Returns how many new notes were learned. */
export async function learnFromTurn(brain: Provider, memory: MwaMemory, p: PreparedPerson, message: string, reply: string): Promise<number> {
  if (process.env.MWA_PERSON_LEARN === '0' || p.personId === 'unknown' || p.mismatch) return 0;
  try {
    const l = await learnAboutPerson({ brain, memory, personId: p.personId, userMessage: message, agentReply: reply });
    // Only recompress the dossier when something NEW was actually learned — otherwise, once a person
    // passes the note cap, this would fire a full LLM recompression EVERY turn (unbounded cost/churn).
    if (l.learned > 0) await compressPersonDossier({ brain, memory, personId: p.personId, name: p.name });
    return l.learned;
  } catch { return 0; }
}
