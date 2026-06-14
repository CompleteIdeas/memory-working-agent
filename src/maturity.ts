/**
 * V2.1 — MEMORY MATURITY: does sleep consolidation make recall better?
 *
 * Robert's reframe of "cluster B": the brain wasn't mis-judging memory — the memory
 * was a BABY. MWA never ran consolidation, so it recalled a handful of raw,
 * unconsolidated, weakly-linked notes. AWM's premise is that memory MATURES over
 * time: overlapping engrams cluster, intra-cluster edges strengthen, cross-topic
 * bridges form, noise decays. This seeds a realistic store with deliberate
 * overlapping clusters + noise, then measures the sleep cycle's effect.
 *
 * Reports: (1) the ConsolidationResult (clusters found, edges strengthened/created/
 * bridged, memories faded) — the mechanism; (2) recall before vs after on probes —
 * the downstream effect (cluster precision@k + how many cluster-mates co-activate).
 */
import { rmSync } from 'node:fs';
import { MwaMemory } from './awm.js';

// Each cluster = several OVERLAPPING memories (shared entities) → should cluster.
const CLUSTERS: Record<string, string[]> = {
  auth: [
    'Authentication uses JWT bearer tokens issued at login.',
    'The login endpoint issues a JWT valid for one hour.',
    'JWT tokens are signed with the AUTH_SECRET environment variable.',
    'Auth middleware rejects any request carrying an expired JWT.',
    'JWT claims carry the userId and the role for authorization.',
    'Refresh tokens rotate the JWT without forcing a re-login.',
  ],
  payments: [
    'Payments are processed through Stripe.',
    'Stripe webhooks confirm whether a charge succeeded.',
    'The Stripe customer id is stored on the user record.',
    'Refunds are issued via the Stripe refunds API.',
    'Stripe charge amounts are always integer cents, never floats.',
    'Failed Stripe charges trigger a dunning email.',
  ],
  database: [
    'The primary database is PostgreSQL.',
    'Schema migrations run via node migrate.js.',
    'The Postgres connection pool is capped at 20 connections.',
    'Soft deletes use a deleted_at timestamp column.',
    'Read replicas serve heavy analytics queries.',
  ],
  caching: [
    'The caching layer is Redis.',
    'Redis keys default to a 300 second TTL.',
    'User sessions are stored in Redis, not Postgres.',
    'Cache invalidation is keyed by entity id on write.',
  ],
  deploy: [
    'The deploy target is Railway.',
    'Railway builds the image from the Dockerfile.',
    'The health check endpoint is /health.',
    'Environment secrets are injected by Railway at runtime.',
  ],
};
const NOISE = [
  'The team standup is at 9:30am on Tuesdays.',
  'The office plants are watered on Fridays.',
  'The logo color is teal.',
  'Quarterly review decks use the slate template.',
  'The wifi password rotates monthly.',
  'Parking is on level 3.',
  'Coffee orders are tracked in a shared sheet.',
  'The all-hands is the last Thursday of the month.',
];

const PROBES: { cluster: string; q: string }[] = [
  { cluster: 'auth', q: 'How does the system verify who a user is and protect endpoints?' },
  { cluster: 'payments', q: 'How is money taken from customers and refunded?' },
  { cluster: 'database', q: 'Where and how is persistent data stored?' },
];

const TOPK = 8;

function clusterOf(concept: string): string {
  const m = /^\[(\w+)\]/.exec(concept);
  return m ? m[1] : '?';
}

async function probe(mem: MwaMemory, label: string): Promise<number> {
  let totalPrec = 0;
  console.log(`\n  [${label}]`);
  for (const { cluster, q } of PROBES) {
    const hits = await mem.recall(q, { limit: TOPK });
    const mates = hits.filter((h) => clusterOf(h.concept) === cluster).length;
    const prec = mates / Math.max(1, hits.length);
    totalPrec += prec;
    const top = hits.slice(0, 4).map((h) => `${clusterOf(h.concept)}:${h.score.toFixed(2)}`).join(' ');
    console.log(`    "${q.slice(0, 40)}..." → ${mates}/${hits.length} ${cluster}-mates in top-${TOPK} (prec ${(prec * 100).toFixed(0)}%)  [${top}]`);
  }
  return totalPrec / PROBES.length;
}

/** One "day": use the memory (recall + positive feedback = co-activation), then sleep (consolidate). */
async function useThenSleep(mem: MwaMemory, cycle: number): Promise<void> {
  for (const { cluster, q } of PROBES) {
    const hits = await mem.recall(q, { limit: TOPK });
    // positive feedback on the correct cluster-mates = the co-activation signal consolidation reinforces
    for (const h of hits.filter((h) => clusterOf(h.concept) === cluster)) await mem.feedback(h.id, true);
  }
  const r = await mem.consolidate();
  const pick = (k: string) => r[k] ?? 0;
  console.log(`  sleep cycle ${cycle}: clusters=${pick('clustersFound')} edgesStrengthened=${pick('edgesStrengthened')} edgesCreated=${pick('edgesCreated')} bridges=${pick('bridgesCreated')} faded=${pick('memoriesFaded')}`);
}

export async function runMaturity(runId = 'mat'): Promise<void> {
  const db = `./data/maturity-${runId}.db`;
  for (const ext of ['', '-wal', '-shm']) { try { rmSync(db + ext, { force: true }); } catch { /* */ } }
  const mem = new MwaMemory(`maturity-${runId}`, db);
  mem.setSessionId('seed-session'); // session linking on every write (entity-bridge boost)

  let n = 0;
  for (const [cluster, facts] of Object.entries(CLUSTERS)) {
    for (const f of facts) { await mem.write(`[${cluster}] ${f.slice(0, 60)}`, f, [`cluster=${cluster}`], { canonical: true }); n++; }
  }
  for (let i = 0; i < NOISE.length; i++) { await mem.write(`[noise] ${NOISE[i].slice(0, 50)}`, NOISE[i], ['cluster=noise']); n++; }
  console.log(`\n=== MEMORY MATURITY: seeded ${n} memories (${Object.keys(CLUSTERS).length} overlapping clusters + ${NOISE.length} noise) ===`);
  console.log('Proper test: alternate USE (recall + feedback = co-activation) and SLEEP (consolidate), like real maturation —');
  console.log('not one cold cycle. Hebbian strengthening needs co-activation history to reinforce.');

  const cold = await probe(mem, 'cold / "baby" (no usage, no sleep)');

  const CYCLES = 3;
  console.log(`\n  …${CYCLES} use→sleep cycles…`);
  for (let c = 1; c <= CYCLES; c++) await useThenSleep(mem, c);

  const matured = await probe(mem, `matured (after ${CYCLES} use→sleep cycles)`);
  mem.close();

  console.log(`\n--- recall cluster-precision@${TOPK} (avg over ${PROBES.length} probes) ---`);
  console.log(`  cold: ${(cold * 100).toFixed(0)}%   matured: ${(matured * 100).toFixed(0)}%   Δ ${((matured - cold) * 100).toFixed(0)} pts`);
  console.log('Watch edgesStrengthened climb across cycles as co-activation accrues — the maturation MWA never ran.\n');
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('maturity.ts') || entry.endsWith('maturity.js')) {
  runMaturity(process.env.MAT_RUNID ?? 'mat').catch((e) => { console.error('maturity failed:', e); process.exit(1); });
}
