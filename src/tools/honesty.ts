import type { TrustTier } from '../awm.js';

/**
 * F4 (Honest Agent) — the agent's epistemic state for an answer, derived from the memory it is
 * grounded in. Lets MWA distinguish what it KNOWS from what it is inferring vs guessing, so it can
 * hedge or offer to verify instead of stating a weak recall as fact. This leans on the SPINE trust
 * tier (a flat-memory agent can't do this): a high-trust (user-told / verified) grounding earns
 * "sure"; an untrusted (inbox/web-mined) one never does on its own; a medium (agent-inference) one
 * is "likely" only when the recall was actually strong. Pure + dependency-free → unit-testable.
 */
export type Confidence = 'sure' | 'likely' | 'unsure';

const RELEVANT = 0.3; // a grounding below this recall score is too weak to lean on
const STRONG = 0.5;   // a medium-trust grounding needs at least this to be "likely"

export function answerConfidence(grounding: { trust?: TrustTier; score?: number }[]): Confidence {
  if (!grounding.length) return 'unsure';
  // Confidence is judged ONLY over grounding that's actually relevant (cleared the recall floor) —
  // a barely-recalled high-trust memory must NOT be asserted as "sure" (that's the exact "state a
  // weak recall as fact" failure F4 exists to prevent). Nothing relevant → unsure.
  const relevant = grounding.filter((g) => (g.score ?? 0) >= RELEVANT);
  if (relevant.some((g) => g.trust === 'high')) return 'sure';
  if (relevant.some((g) => g.trust === 'medium' && (g.score ?? 0) >= STRONG)) return 'likely';
  return 'unsure';
}

/**
 * A plain-language hedge to prepend to an answer when the agent isn't confident — so it never fakes
 * certainty. Empty for "sure" (state it plainly). "unsure" also signals the answer path should
 * prefer offering to verify over asserting.
 */
export function hedgePrefix(c: Confidence): string {
  if (c === 'sure') return '';
  if (c === 'likely') return 'I think ';
  return "I'm not certain, but ";
}
