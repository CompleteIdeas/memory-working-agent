/**
 * Detector dry run (BL-08). A scheduled job's `check` is a cheap change detector: when its output
 * hasn't changed since the last fire, the fire is skipped with no model call. A WRONG detector — one
 * that prints a constant, or watches the wrong file — silently suppresses the job forever, and
 * nobody can see that before it has skipped real work. So a new check starts in a DRY RUN:
 *
 * - it runs on every fire but never skips one; the job always runs;
 * - each fire scores what the check predicted against what the run actually found (BL-02's outcome):
 *   "would skip" + no-change, and "would run" + changed, AGREE; "would skip" + changed is a MISSED
 *   change — the evidence starts over and the person is told; "would run" + no-change is a false
 *   alarm (it costs a run, drops nothing) and is not counted either way; anything else is
 *   inconclusive. The first fire, with no baseline, is a bootstrap and never counts;
 * - only outcomes the run DECLARED count (an outcome derived from activity leans to "changed", which
 *   would score a correct detector as missing changes every quiet fire);
 * - when it has agreed at least READY_N times, at least READY_EACH of them "would skip" and READY_EACH
 *   "would run" (a detector that never saw a change hasn't shown it can see one), the person is told
 *   once. Arming is a PERSON's approval (a card, like a standing preference) — never automatic, and
 *   never the model's own call;
 * - arming or disarming clears the baseline, so no change is lost across the switch and a disarmed
 *   detector starts a genuinely fresh dry run;
 * - arming is bound to the exact command text, so a different command is never trusted on another's
 *   record.
 *
 * Checks that predate this (no `checkmode` tag) keep working as before: armed.
 */
import { createHash } from 'node:crypto';

export const READY_N = 4;
/** each side must be seen agreeing at least this often (BL-08 review: one rollover proves little). */
export const READY_EACH = 2;

export interface DetectorEvidence { n: number; skips: number; runs: number }
export type DryScore = 'agree-skip' | 'agree-run' | 'missed' | 'false-alarm' | 'inconclusive';

/** A short fingerprint of a check command, which arming is bound to. */
export function checkHash(cmd: string): string {
  return createHash('sha1').update(cmd.trim()).digest('hex').slice(0, 12);
}

/** Does this task's detector skip runs? Only when a person armed THIS command, or it predates dry runs. */
export function detectorArmed(t: { check?: string; checkMode?: 'dry' | 'armed'; checkArm?: string }): boolean {
  if (!t.check) return false;
  if (t.checkMode === undefined) return true; // a check from before BL-08: unchanged behavior
  return t.checkMode === 'armed' && t.checkArm === checkHash(t.check);
}

/** Score one dry-run fire: what the check predicted against the run's outcome. */
export function scoreDryRun(wouldSkip: boolean, outcome: string): DryScore {
  if (outcome === 'no-change') return wouldSkip ? 'agree-skip' : 'false-alarm';
  if (outcome === 'changed') return wouldSkip ? 'missed' : 'agree-run';
  return 'inconclusive'; // could-not, blocked, complete: the run can't say whether anything changed
}

export function evidenceAfter(ev: DetectorEvidence, score: DryScore): DetectorEvidence {
  if (score === 'missed') return { n: 0, skips: 0, runs: 0 };
  if (score === 'agree-skip') return { n: ev.n + 1, skips: ev.skips + 1, runs: ev.runs };
  if (score === 'agree-run') return { n: ev.n + 1, skips: ev.skips, runs: ev.runs + 1 };
  return ev;
}

export function readyToArm(ev: DetectorEvidence): boolean {
  return ev.n >= READY_N && ev.skips >= READY_EACH && ev.runs >= READY_EACH;
}

export function parseEvidence(tag: string | undefined): DetectorEvidence {
  const [n, skips, runs] = String(tag ?? '').split('.').map((x) => Number(x) || 0);
  return { n: n ?? 0, skips: skips ?? 0, runs: runs ?? 0 };
}
export function formatEvidence(ev: DetectorEvidence): string { return `${ev.n}.${ev.skips}.${ev.runs}`; }

/** One line for the person: where this detector stands. */
export function detectorLine(t: { check?: string; checkMode?: 'dry' | 'armed'; checkArm?: string; checkEv?: DetectorEvidence }): string {
  if (!t.check) return '';
  if (detectorArmed(t)) return 'detector armed: skips the run when the watched value is unchanged';
  const ev = t.checkEv ?? { n: 0, skips: 0, runs: 0 };
  return readyToArm(ev)
    ? `detector dry run: ready to arm (agreed ${ev.n}×: ${ev.skips} unchanged, ${ev.runs} changed) — not skipping until armed`
    : `detector dry run: ${ev.n} of ${READY_N} agreeing fires (${ev.skips} unchanged, ${ev.runs} changed; needs ${READY_EACH} of each) — not skipping yet`;
}
