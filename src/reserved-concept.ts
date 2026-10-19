/**
 * The concepts the lesson and skill stores own (BL-38). Auto-prime recognises a lesson or skill by its
 * `lesson:` / `skill:` concept, and the BL-35 gate guards only those stores — so a model-chosen write
 * (remember, auto-learn, a recorded change, an MCP memory tool) must not land under one.
 *
 * Matching is on the text a reader sees: NFKC, invisible format characters removed, leading markdown or
 * quote marks dropped, then "lesson" / "skill" (singular or plural) followed by a colon of any kind, or a
 * dash with a space after it — so "Skills-based hiring rubric" and "Lesson plan: Thursday" stay as they
 * are (review). A look-alike letter (Cyrillic "е") still gets past; such a note is an ordinary fact under
 * the usual provenance rules, not a lesson — auto-prime's own check is the exact store prefix.
 */
const RESERVED = /^(?:lessons?|skills?)\s*(?:[:：∶꞉︓﹕]|[-‐‑‒–—―−]\s)/i;

function normalise(concept: string): string {
  return String(concept).normalize('NFKC')
    .replace(/[\p{Cf}͏︀-️]/gu, '') // soft hyphen, zero-width, LRM/RLM, joiners, variation selectors
    .replace(/[*_`]/g, '') // markdown emphasis: "*lesson*:" reads as "lesson:"
    .replace(/^[\s"'“”‘’>#~]+/, '')
    .trim();
}

export function isReservedConcept(concept: string): boolean {
  return RESERVED.test(normalise(concept));
}

/** Where a model-chosen write under a reserved concept goes instead: `note: <rest>`, however many prefixes
 *  were stacked. Never the bare rest — that collided with, and superseded, a person's own fact (review). */
export function unreservedConcept(concept: string): string {
  let c = normalise(concept);
  while (RESERVED.test(c)) c = normalise(c.replace(RESERVED, ''));
  return `note: ${c || 'untitled'}`.slice(0, 80);
}
