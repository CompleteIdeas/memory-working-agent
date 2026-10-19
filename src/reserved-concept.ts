/**
 * The concepts the lesson and skill stores own (BL-38). Auto-prime recognises a lesson or skill by its
 * `lesson:` / `skill:` concept, and the BL-35 gate guards only those stores — so a model-chosen write
 * (remember, auto-learn, an MCP memory tool) must not land under one, however it is spelled.
 *
 * DETECTION is on a normalised copy of what a reader sees: NFKC, invisible and filler characters removed,
 * markdown emphasis and leading list / bracket / quote marks removed, then "lesson" / "skill" (singular or
 * plural) followed by a colon of any kind or a dash WITH a space after it — so "Skills-based hiring rubric"
 * and "Lesson plan: Thursday" stay as they are. A look-alike LETTER (Cyrillic "е") still gets past: such a
 * note is an ordinary fact under the usual provenance rules, not a lesson — auto-prime's own check is the
 * exact store prefix (`isStoreConcept`).
 *
 * The REPLACEMENT keeps the writer's own characters (no folding: `deploy_prod.sh` stays), only the prefix
 * goes, and it lands as `note: …` — never the bare rest, which collided with a person's own fact.
 */
const COLONS = ':：∶꞉︓﹕ːꓽ᛬։׃᠄';
const DASHES = '\\-‐‑‒–—―−⸺⸻ー－﹘﹣';
const RESERVED = new RegExp(`^(?:lessons?|skills?)\\s*(?:[${COLONS}]|[${DASHES}]\\s)`, 'i');
const LEADING_MARKS = /^[\s"'“”‘’«»„「」『』>#~•·*_`\-–—\d.()[\]{}]+/;

function normalise(concept: string): string {
  return String(concept).normalize('NFKC')
    .replace(/[\p{Cf}͏︀-️ㅤ⠀ᅟᅠ]/gu, '') // soft hyphen, zero-width, LRM/RLM, joiners, variation selectors, fillers
    .replace(/[*_`()[\]"“”'‘’«»]/g, '') // emphasis, brackets, quotes: "*lesson*:", "(lesson):", '"Lesson": x'
    .replace(LEADING_MARKS, '')
    .trim();
}

export function isReservedConcept(concept: string): boolean {
  return RESERVED.test(normalise(concept));
}

/** Where a model-chosen write under a reserved concept goes instead: `note: <the rest, as written>`,
 *  however many prefixes were stacked. */
export function unreservedConcept(concept: string): string {
  let c = String(concept).trim();
  // Cut at the first separator of each reserved prefix in the ORIGINAL text, so the rest keeps its characters.
  // Whatever detection accepts (review 4: a fullwidth dash, or an invisible mark after it, matched there but
  // not here, so the cut ran on to a later colon and ate real text).
  const sep = new RegExp(`[${COLONS}]|[${DASHES}][\\s\\p{Cf}]`, 'u');
  for (let guard = 0; guard < 8 && isReservedConcept(c); guard++) {
    const m = sep.exec(c);
    if (!m) break;
    c = c.slice(m.index + m[0].length).trim();
  }
  return `note: ${c || 'untitled'}`.slice(0, 80);
}

/** A concept exactly as the lesson and skill stores write it (`lesson: …`, `skill: …` — saveFriction and
 *  saveSkill). Used where the question is "is this one of the stores' memories", not "does this text look
 *  like one": a person's own "Skills: React" fact is not (BL-38 review 3). */
export function isStoreConcept(concept: string): boolean {
  return /^(?:lesson|skill): /.test(String(concept));
}
