/**
 * Intake schema (S5) — the small canonical set of highest-value things to know to help ANYONE. The
 * agent tracks which fields it already has vs is still missing, so it can ask ONE gently, over time
 * (never an interrogation), and knows when it has enough. See docs/true-agent-and-person-profile.md.
 *
 * Fields are stored as person notes carrying a `field=<key>` marker (MwaMemory.rememberAboutPerson's
 * 4th arg), so status is exact — not keyword-guessed.
 */
import type { PersonNote } from './person.js';

export interface IntakeField { key: string; label: string; question: string; kind: 'fact' | 'style' | 'preference' }

/** Ordered by priority — the agent asks for earlier ones first when they haven't come up naturally. */
export const INTAKE_FIELDS: IntakeField[] = [
  { key: 'name', label: 'what to call them', question: 'What should I call you?', kind: 'fact' },
  { key: 'contact', label: 'how to reach them', question: "What's the best way to reach you if I need to follow up?", kind: 'fact' },
  { key: 'role', label: 'their role / context', question: 'What do you do, or what are you working on that I can help with?', kind: 'fact' },
  { key: 'style', label: 'how they like to work', question: 'Do you prefer short answers and options, or more detail and explanation?', kind: 'style' },
];

export interface IntakeStatus { filled: string[]; missing: IntakeField[]; complete: boolean }

/** Which canonical fields this person's profile already covers vs still lacks. */
export function intakeStatus(profile: PersonNote[]): IntakeStatus {
  const have = new Set((profile ?? []).map((n) => n.field).filter(Boolean) as string[]);
  const missing = INTAKE_FIELDS.filter((f) => !have.has(f.key));
  return { filled: INTAKE_FIELDS.filter((f) => have.has(f.key)).map((f) => f.key), missing, complete: missing.length === 0 };
}

/** The single highest-priority field still unknown (or null if the intake is complete). */
export function nextIntakeField(profile: PersonNote[]): IntakeField | null {
  return intakeStatus(profile).missing[0] ?? null;
}

/**
 * A ONE-LINE, low-pressure prompt addition telling the agent the next useful thing it doesn't yet know
 * — explicitly "only if it comes up naturally," so it never turns into an interrogation. Empty when the
 * intake is complete or priming is for the shared/unknown person.
 */
export function intakeHint(profile: PersonNote[]): string {
  const next = nextIntakeField(profile);
  if (!next) return '';
  return `(You don't yet know ${next.label}. If it comes up naturally — never as an interrogation — you may ask: "${next.question}")`;
}
