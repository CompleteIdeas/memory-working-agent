/**
 * Step-up verification challenges (S6 v2 integration). When a person's identity is in doubt and a
 * SENSITIVE/irreversible action is requested, a one-time code is delivered OUT-OF-BAND to their
 * validated connection; the action stays BLOCKED (at the approval gate) until the code is verified.
 *
 * In-memory, single-use, expiring, attempt-capped. The `deliver` callback is the DI seam — the caller
 * routes the code to the person's validated connection (e.g. their authenticated Telegram chat); this
 * module never touches a channel itself, so it stays pure + testable. See docs/true-agent-and-person-profile.md.
 */
import { randomInt } from 'node:crypto';

interface Challenge { id: string; personId: string; purpose: string; code: string; expiresAt: number; attempts: number }
const challenges = new Map<string, Challenge>();
const satisfied = new Map<string, number>(); // personId → epoch ms of last successful step-up
const suspicious = new Map<string, number>(); // personId → epoch ms an identity mismatch was last seen

const CODE_TTL_MS = 5 * 60_000;
const SATISFIED_TTL_MS = 10 * 60_000; // a passed step-up covers sensitive actions for this window
const SUSPICION_TTL_MS = 30 * 60_000; // once flagged, a person stays "in doubt" until step-up (or this expires)
const MAX_ATTEMPTS = 3;
let seq = 0;

function prune(now = Date.now()): void {
  for (const [id, c] of challenges) if (c.expiresAt <= now) challenges.delete(id);
}

export interface IssueResult { ok: boolean; challengeId?: string; reason?: string }

/** Issue a step-up challenge and deliver the code OUT-OF-BAND via `deliver` (which must route to the
 *  person's validated connection — never the current/suspect channel). Fails if delivery fails, so a
 *  person with no reachable validated connection cannot be step-up-verified (→ the action stays blocked). */
export async function issueStepUp(opts: { personId: string; purpose?: string; deliver: (code: string) => Promise<boolean> }): Promise<IssueResult> {
  prune();
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const delivered = await opts.deliver(code).catch(() => false);
  if (!delivered) return { ok: false, reason: 'delivery-failed' };
  const id = `su_${Date.now().toString(36)}_${++seq}`;
  challenges.set(id, { id, personId: opts.personId, purpose: opts.purpose ?? 'sensitive-action', code, expiresAt: Date.now() + CODE_TTL_MS, attempts: 0 });
  return { ok: true, challengeId: id };
}

export interface VerifyResult { ok: boolean; reason?: string }

/** Verify a submitted code. Single-use; caps attempts; marks the person step-up-satisfied on success. */
export function verifyStepUp(challengeId: string, code: string): VerifyResult {
  prune();
  const c = challenges.get(challengeId);
  if (!c) return { ok: false, reason: 'not-found-or-expired' };
  if (c.attempts >= MAX_ATTEMPTS) { challenges.delete(challengeId); return { ok: false, reason: 'too-many-attempts' }; }
  c.attempts++;
  if (String(code ?? '').trim() !== c.code) {
    if (c.attempts >= MAX_ATTEMPTS) challenges.delete(challengeId); // burn the challenge after N wrong tries
    return { ok: false, reason: 'wrong-code' };
  }
  challenges.delete(challengeId); // single-use — a code can never be replayed
  satisfied.set(c.personId, Date.now());
  suspicious.delete(c.personId); // a passed 2nd factor clears the suspicion flag
  return { ok: true };
}

/** Flag a person as under identity suspicion (an assessIdentity mismatch was seen). STICKY: keeps them
 *  `identityInDoubt` across subsequent turns — even ones with no self-claim — until step-up clears it or
 *  the window expires. Without this, an impersonator evades the gate by splitting the false claim from
 *  the sensitive request across two turns. */
export function markSuspicious(personId: string): void { suspicious.set(personId, Date.now()); }

/** Is this person currently under identity suspicion (within the window)? */
export function isSuspicious(personId: string): boolean {
  const t = suspicious.get(personId);
  if (t == null) return false;
  if (Date.now() - t > SUSPICION_TTL_MS) { suspicious.delete(personId); return false; }
  return true;
}

/** Has this person completed a step-up within the satisfied window? Gates sensitive actions in confirmPending. */
export function isStepUpSatisfied(personId: string): boolean {
  const t = satisfied.get(personId);
  if (t == null) return false;
  if (Date.now() - t > SATISFIED_TTL_MS) { satisfied.delete(personId); return false; }
  return true;
}

/** Test/inspection helper — clears all challenge + satisfied + suspicion state. */
export function _resetStepUp(): void { challenges.clear(); satisfied.clear(); suspicious.clear(); }
