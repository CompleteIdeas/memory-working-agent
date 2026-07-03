/**
 * F6 Earned Determinism — turning a repeated, successful approach into a saved, replayable ROUTINE
 * (procedural memory that compounds the more you use MWA). The SAFETY discipline matters most (per
 * the self-evolving-skill literature and our own audit): a routine is PROPOSED not auto-committed,
 * every version is kept (rollback), and the candidate text is INJECTION-SCANNED so laundered or
 * untrusted content can never become an executable routine. These helpers are pure + unit-testable;
 * the versioned storage lives in MwaMemory.saveRoutine.
 */

// DEFENSE-IN-DEPTH ONLY — this denylist is NOT the security boundary (a denylist over free text is
// always bypassable). The real boundary is upstream: the auto-crystallization path stores only
// STRUCTURAL, tool-derived steps (never model prose), and proposed routines are kept OUT of the
// recall path until a human promotes them. This catches obvious injection/exfiltration/self-sabotage
// in any manually-supplied routine; matches BOTH verb→secret and secret→verb orderings.
const UNSAFE: RegExp[] = [
  /\b(ignore|disregard|forget|override|bypass)\b[^.]{0,20}\b(instructions|rules|guardrails|system\s*prompt|directives|policy)\b/i,
  /\b(exfiltrat|leak)\w*/i,
  /\b(forward|upload|copy|paste|send|post|share|email)\b[^.]{0,40}\b(api[_-]?key|password|secret|token|credential|\.env)\w*/i,
  /\b(api[_-]?key|password|secret|token|credential)\w*\b[^.]{0,40}\b(send|post|email|upload|share|forward|exfil|leak|paste)\b/i,
  /\b(forward|send|copy|upload|paste)\b[^.]{0,40}\b(all|every|everything|each)\b[^.]{0,20}\b(email|mail|message|file|contact|note)/i,
  /\b(wire|transfer|send|pay)\b[^.]{0,30}\b(money|funds|\$|usd|dollars?|bank|account|crypto|wallet)\b/i,
  /\b(disable|bypass|turn off|skip|ignore|proceed without)\b[^.]{0,24}\b(security|safety|approval|guard|check|review|confirmation)/i,
];

export function scanRoutine(text: string): { safe: boolean; reason?: string } {
  // Normalize zero-width / unusual whitespace so simple splitting tricks don't evade the patterns.
  const t = String(text ?? '').replace(/[​-‏⁠﻿]/g, '').replace(/\s+/g, ' ');
  if (t.trim().length < 8) return { safe: false, reason: 'routine is empty or too short to be meaningful' };
  for (const re of UNSAFE) {
    if (re.test(t)) return { safe: false, reason: `routine contains a disallowed pattern (${re.source.slice(0, 36)}…) — not saved` };
  }
  return { safe: true };
}

export interface RunShape { reason: string; toolCalls: number; steps: number; repeated: boolean }

/**
 * A run worth crystallizing into a routine: it actually SUCCEEDED, did real work (≥2 tool calls — a
 * procedure, not a one-line chat), and the approach is REPEATED (we've seen it before, so it's stable
 * enough to be worth saving — not a one-off). Conservative on purpose: better to under-offer than to
 * crystallize noise.
 */
export function isRoutineWorthy(r: RunShape): boolean {
  if (r.reason !== 'done') return false;
  // A REPEATED approach is worth saving even when short (≥2 tool calls); a first-time run must be
  // genuinely COMPLEX (≥5 tool calls, the LibreFang trigger) before it's worth crystallizing.
  return r.repeated ? r.toolCalls >= 2 : r.toolCalls >= 5;
}

/** Next version label (v1, v2, …) given the existing version strings for a routine. */
export function nextVersion(existing: string[]): string {
  const nums = existing.map((v) => Number(String(v).replace(/^v/i, ''))).filter((n) => Number.isFinite(n));
  return `v${(nums.length ? Math.max(...nums) : 0) + 1}`;
}
