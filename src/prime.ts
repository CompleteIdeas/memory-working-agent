/**
 * Whether a recalled memory may be AUTO-primed into the prompt. An untrusted skill or lesson is
 * procedure-shaped text from a run that read external content: it stays in memory (inspectable,
 * returned flagged by an explicit recall) but never volunteers itself as "how to do this". (BL-17,
 * from the coworker challenge: untrusted procedures are evidence, not instructions.) Its own module
 * so every runner — the agent, the coding brain (BL-16) — applies the same rule without an import cycle.
 */
import type { TrustTier } from './awm.js';

export function primeable(m: { concept: string; trust?: TrustTier }): boolean {
  // A ROUTINE engram is never primed itself — proposed, active or retired (BL-12). A probe showed a
  // PROPOSED routine came back from a relevance recall and would have been primed as an instruction
  // before anyone approved it. Promoting one (a person, in the Memory tab) writes its steps as a
  // trusted skill, and THAT is what is primed.
  if (/^routine:/i.test(m.concept)) return false;
  return !(m.trust === 'untrusted' && /^(skill|lesson):/i.test(m.concept));
}
