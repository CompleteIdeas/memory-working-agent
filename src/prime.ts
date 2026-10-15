/**
 * Whether a recalled memory may be AUTO-primed into the prompt. An untrusted skill or lesson is
 * procedure-shaped text from a run that read external content: it stays in memory (inspectable,
 * returned flagged by an explicit recall) but never volunteers itself as "how to do this". (BL-17,
 * from the coworker challenge: untrusted procedures are evidence, not instructions.) Its own module
 * so every runner — the agent, the coding brain (BL-16) — applies the same rule without an import cycle.
 */
import type { TrustTier } from './awm.js';

export function primeable(m: { concept: string; trust?: TrustTier }): boolean {
  return !(m.trust === 'untrusted' && /^(skill|lesson):/i.test(m.concept));
}
