/**
 * V2 multi-session "discover-then-reuse" scenario — where decision-continuity
 * should decisively win.
 *
 * A quirky `legacy` module (opaque: installed under node_modules so the worker
 * CANNOT read its source — it must learn the behavior by trial-and-error against
 * the fixed test). Its non-obvious contract:
 *   - get(key) returns { v: value }  (NOT the value directly)
 *   - keys are case-folded (lowercased) on put AND get
 *   - get(missing) throws Error('E_NOKEY')  (must be caught)
 *
 * Session 1 forces the agent to DISCOVER these (expensive: several dispatches).
 * Session 2 is a DIFFERENT task needing the SAME quirks. Arm A (AWM) recalls
 * them → cheap; arm B re-discovers; arm D carries the prior transcript instead.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SessionSpec {
  goal: string;
  testCmd: string;
  setup(dir: string): void; // writes the fixed test for this session
}
export interface Scenario {
  id: string;
  /** writes shared, opaque deps into the sandbox (re-run per session, fresh sandbox) */
  setupShared(dir: string): void;
  sessions: SessionSpec[];
}

function w(dir: string, file: string, content: string): void {
  mkdirSync(join(dir, file, '..'), { recursive: true });
  writeFileSync(join(dir, file), content, 'utf8');
}

const LEGACY_INDEX = String.raw`// Opaque legacy store. No docs. Discover behavior by probing.
const _m = new Map();
export function put(key, value) { _m.set(String(key).toLowerCase(), { v: value }); return 'OK'; }
export function get(key) {
  const e = _m.get(String(key).toLowerCase());
  if (!e) throw new Error('E_NOKEY');
  return e; // returns { v: value }
}
export function size() { return _m.size; }
`;

const LEGACY_DOC = String.raw`# legacy module (import { put, get, size } from 'legacy')
- put(key, value): stores value under key. Keys are CASE-FOLDED (lowercased).
- get(key): returns an OBJECT { v: value } — the value is wrapped, read \`.v\`.
  Throws Error with message 'E_NOKEY' if the key is absent (catch it).
- size(): number of distinct keys currently stored.
`;

const legacyStore: Scenario = {
  id: 'legacy-store',
  setupShared(dir) {
    // Opaque source (node_modules is skipped by the worker's file scan), so the
    // ONLY way to know the contract is the doc — which exists in session 1 only.
    w(dir, 'node_modules/legacy/package.json', JSON.stringify({ name: 'legacy', version: '1.0.0', type: 'module', main: 'index.mjs' }));
    w(dir, 'node_modules/legacy/index.mjs', LEGACY_INDEX);
  },
  sessions: [
    {
      // S1: contract doc PRESENT → solvable. Agent learns .v-unwrap + E_NOKEY-catch.
      goal:
        "A module 'legacy' is installed (import from 'legacy'); its contract is documented in LEGACY.md — read it. Create s1.mjs that, at import time, stores name→name.length for ['Alpha','Beta','Gamma'] via legacy.put, and exports lookup(name) returning the stored length for that name, or -1 if not present. The fixed test.mjs must pass via `node test.mjs`.",
      testCmd: 'node test.mjs',
      setup(dir) {
        w(dir, 'LEGACY.md', LEGACY_DOC); // contract doc — session 1 ONLY
        w(
          dir,
          'test.mjs',
          [
            "import { lookup } from './s1.mjs';",
            "import assert from 'node:assert';",
            "assert.equal(lookup('alpha'), 5);",
            "assert.equal(lookup('BETA'), 4);",
            "assert.equal(lookup('Gamma'), 5);",
            "assert.equal(lookup('delta'), -1);",
            "console.log('PASS');",
          ].join('\n'),
        );
      },
    },
    {
      // S2: DIFFERENT task, SAME quirks (.v-unwrap + case-fold)
      goal:
        "The same undocumented 'legacy' module is installed (import from 'legacy'). Create s2.mjs that stores ['X','Y','Z','x'] each → its uppercase via legacy.put, and exports tally() returning an object { count, sample } where count = number of distinct keys currently in the store and sample = the stored value for key 'x'. The fixed test.mjs must pass via `node test.mjs`.",
      testCmd: 'node test.mjs',
      setup(dir) {
        w(
          dir,
          'test.mjs',
          [
            "import { tally } from './s2.mjs';",
            "import assert from 'node:assert';",
            'const r = tally();',
            'assert.equal(r.count, 3);', // X,Y,Z,x case-fold → x,y,z = 3
            "assert.equal(r.sample, 'X');", // get('x').v, last put for 'x' was uppercase 'X'
            "console.log('PASS');",
          ].join('\n'),
        );
      },
    },
  ],
};

export const SCENARIOS: Scenario[] = [legacyStore];
