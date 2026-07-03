/**
 * Promote the highest-value standalone proof scripts into the vitest suite so CI actually runs them
 * (previously the scripts/_*.ts corpus ran NOWHERE automatically — gap analysis 2026-07, coverage H3).
 * Each runs as a child process; a non-zero exit (a failed assertion inside the script) fails the test.
 *
 * Included: the security/privacy-critical + this-session proofs that need no external service (SQLite
 * only). The Postgres/PGlite proofs (_postgres-verify, _io-roundtrip, _migrate-direct) are intentionally
 * excluded here — they require a live database and belong in a separate integration job.
 */
import { describe, it } from 'vitest';
import { execSync } from 'node:child_process';

const PROOFS = [
  '_person-scope',            // S1 — per-person privacy hard-isolation invariant
  '_person-prime',            // S2 — primer reaches the model + name-injection sanitization
  '_person-learn',            // S3 — learn trigger + self-recompressing dossier
  '_person-intake-identity',  // S5/S6 — intake schema + identity mismatch + step-up (no PII leak)
  '_stepup',                  // S6 v2 — challenge lifecycle + approval-gate enforcement
  '_scheduler-gate',          // scheduler change-detection gate
  '_import-stage-retract',    // Tier-2 #8 — awm import preserves stage + retracted (no resurrection)
  '_merge-fidelity',          // Tier-2 #7 — awm merge preserves embeddings + class + BM25
  '_novelty-exact-concept',   // Tier-2 #12 — write-pipeline reinforces exact-concept dup (no R1 leak)
  '_person-suspicion',        // code-review — sticky suspicion (split-claim bypass) + anchor preservation
];

describe('proof scripts (CI-promoted)', () => {
  for (const name of PROOFS) {
    it(`${name} passes`, () => {
      // stdio 'pipe' keeps the child quiet unless it fails; execSync throws on non-zero exit → test fails.
      execSync(`npx tsx scripts/${name}.ts`, { stdio: 'pipe', timeout: 180_000 });
    }, 180_000);
  }
});
