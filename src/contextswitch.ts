/**
 * V2.1 — CONTEXT SWITCHING benchmark (controlled, deterministic).
 *
 * The crux of context switching: the SAME question shape asked about DIFFERENT
 * projects must return DIFFERENT, project-correct answers. We store facts for N
 * projects that share the SAME attribute set but with DIFFERENT values, then
 * interleave queries that jump between projects. Recall must use the project
 * identity to disambiguate — returning another project's value is a switch
 * failure ("bleed"), the exact thing that breaks when context isn't isolated.
 *
 * Deterministic scoring (known ground truth):
 *   - top1: the correct project's value is the first hit
 *   - found@5: it's anywhere in the top 5
 *   - bleed: a DIFFERENT project's value for that attribute appears in top1
 *            while the correct one does not (cross-project contamination)
 *
 * Token contrast: recall is flat; a notes file must carry ALL projects' facts on
 * every switch.
 */
import { rmSync } from 'node:fs';
import { MwaMemory } from './awm.js';

const tok = (s: string) => Math.ceil(s.length / 4);

const PROJECTS = ['Aurora', 'Beacon', 'Cinder', 'Delta'] as const;
const ATTRS = ['database', 'cache', 'language', 'auth method', 'deploy target'] as const;
// values[attrIndex][projectIndex] — same attribute set, distinct values per project
const VALUES: Record<(typeof ATTRS)[number], string[]> = {
  database: ['PostgreSQL', 'MongoDB', 'MySQL', 'SQLite'],
  cache: ['Redis', 'Memcached', 'Hazelcast', 'DragonflyDB'],
  language: ['TypeScript', 'Go', 'Python', 'Rust'],
  'auth method': ['JWT', 'OAuth2', 'SAML', 'API keys'],
  'deploy target': ['Railway', 'AWS ECS', 'Fly.io', 'Vercel'],
};

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ');

// Interleaved switch queries: rotate the project every step so each query is a switch.
const QUERIES: { p: number; attr: (typeof ATTRS)[number] }[] = [];
for (let a = 0; a < ATTRS.length; a++) for (let i = 0; i < PROJECTS.length; i++) QUERIES.push({ p: (a + i) % PROJECTS.length, attr: ATTRS[a] });

const NOISE_ATTRS = ['queue', 'logging', 'cdn', 'search', 'monitoring', 'orm', 'bundler', 'testing'];
const NOISE_VALS = ['Kafka', 'Datadog', 'Cloudflare', 'Elastic', 'Grafana', 'Prisma', 'esbuild', 'Vitest', 'RabbitMQ', 'Sentry'];

interface Metrics { D: number; top1: number; found5: number; bleed: number; recallTok: number; carryTok: number; n: number }

async function runOnce(D: number, verbose: boolean): Promise<Metrics> {
  const db = `./data/ctxswitch-${D}.db`;
  for (const ext of ['', '-wal', '-shm']) { try { rmSync(db + ext, { force: true }); } catch { /* */ } }
  const mem = new MwaMemory(`ctxswitch-${D}`, db);

  let allChars = 0;
  // the 4 real projects (ground truth)
  for (let p = 0; p < PROJECTS.length; p++) for (const attr of ATTRS) {
    const fact = `Project ${PROJECTS[p]} uses ${VALUES[attr][p]} for its ${attr}.`;
    allChars += fact.length;
    await mem.write(`${PROJECTS[p]} ${attr}`, fact, [`project=${PROJECTS[p].toLowerCase()}`, `attr=${attr.replace(' ', '-')}`], { canonical: true });
  }
  // D distractor facts (other projects / other attributes) — noise that must NOT bleed in
  for (let i = 0; i < D; i++) {
    const name = `Noise${i}`, attr = NOISE_ATTRS[i % NOISE_ATTRS.length], val = `${NOISE_VALS[i % NOISE_VALS.length]}-${i}`;
    const fact = `Project ${name} uses ${val} for its ${attr}.`;
    allChars += fact.length;
    await mem.write(`${name} ${attr}`, fact, [`project=${name.toLowerCase()}`, `attr=${attr}`], { canonical: true });
  }
  const carryTok = tok('x'.repeat(allChars));

  let top1 = 0, found5 = 0, bleed = 0, totTok = 0;
  for (const { p, attr } of QUERIES) {
    const correct = VALUES[attr][p];
    const others = VALUES[attr].filter((_, i) => i !== p);
    const hits = await mem.recall(`What ${attr} does project ${PROJECTS[p]} use?`, { limit: 5, full: true });
    const conts = hits.map((h) => norm(h.content));
    const inTop1 = conts[0]?.includes(norm(correct)) ?? false;
    const inAny = conts.some((c) => c.includes(norm(correct)));
    const top1Wrong = !inTop1 && conts[0] ? others.some((o) => conts[0].includes(norm(o))) : false;
    if (inTop1) top1++; if (inAny) found5++; if (top1Wrong) bleed++;
    totTok += hits.reduce((s, h) => s + tok(h.content), 0);
    if (verbose) {
      const mark = inTop1 ? 'OK  ' : inAny ? 'top5' : top1Wrong ? 'BLEED' : 'miss';
      console.log(`  ${PROJECTS[p].padEnd(7)} ${attr.padEnd(13)} → want "${correct}"  [${mark}]  top1: "${(hits[0]?.content ?? '(none)').slice(0, 50)}"`);
    }
  }
  mem.close();
  return { D, top1, found5, bleed, recallTok: Math.round(totTok / QUERIES.length), carryTok, n: QUERIES.length };
}

export async function runContextSwitch(): Promise<void> {
  const sweep = (process.env.CS_DISTRACTORS ? process.env.CS_DISTRACTORS.split(',').map(Number) : [0, 200, 800]);
  console.log(`\n=== CONTEXT SWITCHING: ${PROJECTS.length} projects, same ${ATTRS.length} attributes, distinct values, interleaved ===`);
  console.log(`(distractor sweep adds unrelated 'Noise' projects so carry-all grows; switching accuracy should hold, recall stay flat)\n`);
  const rows: Metrics[] = [];
  for (let i = 0; i < sweep.length; i++) {
    const D = sweep[i];
    console.log(`--- store = 20 real facts + ${D} distractors (${20 + D} total) ${i === sweep.length - 1 ? '[verbose]' : ''} ---`);
    rows.push(await runOnce(D, i === sweep.length - 1));
  }
  console.log(`\n${'distractors'.padEnd(12)}${'top-1'.padStart(8)}${'found@5'.padStart(9)}${'bleed'.padStart(7)}${'recall tok'.padStart(12)}${'carry-all tok'.padStart(14)}`);
  for (const r of rows) {
    console.log(`${String(r.D).padEnd(12)}${`${r.top1}/${r.n}`.padStart(8)}${`${r.found5}/${r.n}`.padStart(9)}${`${r.bleed}`.padStart(7)}${String(r.recallTok).padStart(12)}${String(r.carryTok).padStart(14)}`);
  }
  console.log(`\nClean switching = high top-1 + zero bleed, INVARIANT to store size. Recall stays flat (~60 tok);`);
  console.log(`a notes file's carry-all cost grows with every fact added across every project.\n`);
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('contextswitch.ts') || entry.endsWith('contextswitch.js')) {
  runContextSwitch().catch((e) => { console.error('contextswitch failed:', e); process.exit(1); });
}
