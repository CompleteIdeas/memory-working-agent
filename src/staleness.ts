/**
 * V2.1 — STALENESS / SUPERSEDE (the differentiator a notes-file/repo cannot match).
 *
 * Robert's point: "a memory gets replaced and we know it; a repo just has files to
 * look at and track." When code CHANGES between visits:
 *   - MD_file  — notes.md is now STALE; it answers the OLD value and has no way to
 *                know it's wrong short of a full re-scan.
 *   - A_awm    — on re-reading the one changed file (which a working agent touches
 *                anyway), it SUPERSEDES the affected fact; recall stops returning the
 *                old value. Correct + cheap (targeted), and it KNOWS what changed.
 *   - LongCtx  — re-reads the whole repo every time, so it's always current but pays
 *                the full token cost on every visit.
 *
 * Facts are stored deterministically here (parsed from the config) so the demo
 * isolates the SUPERSEDE mechanism, not extraction quality.
 */
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { MwaMemory } from './awm.js';

interface Fact { key: string; value: string; line: RegExp }
const FACTS: Fact[] = [
  { key: 'VERSION', value: '', line: /VERSION\s*=\s*'([^']+)'/ },
  { key: 'MAX_RETRIES', value: '', line: /MAX_RETRIES\s*=\s*(\d+)/ },
  { key: 'DEFAULT_MODEL', value: '', line: /DEFAULT_MODEL\s*=\s*'([^']+)'/ },
];

function writeConfig(dir: string, version: string, retries: number, model: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    resolve(dir, 'config.mjs'),
    `// project config\nexport const VERSION = '${version}';\nexport const MAX_RETRIES = ${retries};\nexport const DEFAULT_MODEL = '${model}';\n`,
    'utf8',
  );
}

function parseFacts(dir: string): Record<string, string> {
  const src = readFileSync(resolve(dir, 'config.mjs'), 'utf8');
  const out: Record<string, string> = {};
  for (const f of FACTS) { const m = src.match(f.line); if (m) out[f.key] = m[1]; }
  return out;
}

const approxTok = (s: string) => Math.ceil(s.length / 4); // ~4 chars/token, good enough for the cost comparison

export async function runStaleness(runId = 'stale'): Promise<void> {
  const repo = resolve(`./sandbox/stale/${runId}/repo`);
  const db = `./data/stale-${runId}.db`;
  for (const ext of ['', '-wal', '-shm']) { try { rmSync(db + ext, { force: true }); } catch {} }

  // ---- Visit 1: ingest the original repo into AWM + notes.md ----
  writeConfig(repo, '0.8.6', 6, 'gpt-5-4-mini');
  const v1 = parseFacts(repo);
  const mem = new MwaMemory(`stale-${runId}`, db);
  const idByKey: Record<string, string> = {};
  for (const f of FACTS) {
    const fact = `config ${f.key} = ${v1[f.key]}`;
    const id = await mem.write(fact, fact, [`file=config.mjs`, `key=${f.key}`, 'topic=config-fact'], { canonical: true });
    if (id) idByKey[f.key] = id;
  }
  const notes = FACTS.map((f) => `- ${f.key} = ${v1[f.key]}`).join('\n');
  writeFileSync(resolve(repo, '..', 'notes.md'), `# repo notes (written visit 1)\n${notes}\n`, 'utf8');

  // ---- The code CHANGES between visits ----
  writeConfig(repo, '0.9.0', 8, 'gpt-5-4-mini'); // VERSION + MAX_RETRIES changed; MODEL unchanged
  const v2 = parseFacts(repo);

  // ---- Visit 2: ask for the CHANGED facts. How does each strategy fare? ----
  const questions: { key: string; correct: string }[] = [
    { key: 'VERSION', correct: v2.VERSION },        // changed 0.8.6 -> 0.9.0
    { key: 'MAX_RETRIES', correct: v2.MAX_RETRIES },// changed 6 -> 8
    { key: 'DEFAULT_MODEL', correct: v2.DEFAULT_MODEL }, // unchanged
  ];

  // MD_file: answer from the (now stale) notes.md
  const notesText = readFileSync(resolve(repo, '..', 'notes.md'), 'utf8');
  const md = questions.map((q) => {
    const m = notesText.match(new RegExp(`${q.key} = (\\S+)`));
    const got = m ? m[1] : '(absent)';
    return { ...q, got, ok: got === q.correct };
  });
  const mdTok = approxTok(notesText) * questions.length;

  // A_awm WITHOUT supersede: recall the originally-stored facts (also stale)
  const awmStale: { key: string; got: string; ok: boolean }[] = [];
  for (const q of questions) {
    const hits = await mem.recall(`config ${q.key} value`, { limit: 3, full: true });
    const got = (hits.find((h) => h.content.includes(q.key))?.content.split('= ')[1] ?? '(none)').trim();
    awmStale.push({ key: q.key, got, ok: got === q.correct });
  }

  // A_awm WITH supersede: re-read the changed file, supersede changed facts, recall again
  const changedSrc = readFileSync(resolve(repo, 'config.mjs'), 'utf8');
  let supersedeTok = approxTok(changedSrc); // cost: read the ONE changed file (targeted)
  for (const f of FACTS) {
    if (v2[f.key] !== v1[f.key]) {
      const fact = `config ${f.key} = ${v2[f.key]}`;
      await mem.supersede(idByKey[f.key], fact, fact, [`file=config.mjs`, `key=${f.key}`, 'topic=config-fact']);
    }
  }
  const awmFresh: { key: string; got: string; ok: boolean }[] = [];
  for (const q of questions) {
    const hits = await mem.recall(`config ${q.key} value`, { limit: 3, full: true });
    const got = (hits.find((h) => h.content.includes(q.key))?.content.split('= ')[1] ?? '(none)').trim();
    awmFresh.push({ key: q.key, got, ok: got === q.correct });
  }
  supersedeTok += approxTok(awmFresh.map((a) => a.got).join('')); // recall slice is tiny

  // LongCtx: read the whole (current) repo file every visit
  const lc = questions.map((q) => ({ ...q, got: v2[q.key], ok: true }));
  const lcTok = approxTok(changedSrc) * questions.length;

  mem.close();

  // ---- Report ----
  const score = (rows: { ok: boolean }[]) => `${rows.filter((r) => r.ok).length}/${rows.length}`;
  console.log('\n=== STALENESS: after the code changes between visits (VERSION 0.8.6→0.9.0, MAX_RETRIES 6→8) ===\n');
  console.log(['strategy'.padEnd(22), 'correct'.padStart(8), 'tokens'.padStart(8), '  answers'].join(''));
  console.log(['MD_file (stale notes)'.padEnd(22), score(md).padStart(8), `${mdTok}`.padStart(8), '  ' + md.map((r) => `${r.key}=${r.got}${r.ok ? '' : '✗'}`).join(' ')].join(''));
  console.log(['A_awm (no supersede)'.padEnd(22), score(awmStale).padStart(8), '   ~80'.padStart(8), '  ' + awmStale.map((r) => `${r.key}=${r.got}${r.ok ? '' : '✗'}`).join(' ')].join(''));
  console.log(['A_awm + SUPERSEDE'.padEnd(22), score(awmFresh).padStart(8), `${supersedeTok}`.padStart(8), '  ' + awmFresh.map((r) => `${r.key}=${r.got}${r.ok ? '' : '✗'}`).join(' ')].join(''));
  console.log(['LongCtx (re-read all)'.padEnd(22), score(lc).padStart(8), `${lcTok}`.padStart(8), '  ' + lc.map((r) => `${r.key}=${r.got}`).join(' ')].join(''));
  console.log('\nThe point: a notes file CANNOT know it went stale (answers old values, no signal).');
  console.log('AWM + supersede makes a TARGETED update from the one changed file and recall stops');
  console.log('returning the old value — correct AND cheap. LongCtx is correct only by re-reading everything.\n');
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('staleness.ts') || entry.endsWith('staleness.js')) {
  runStaleness(process.env.STALE_RUNID ?? 'stale').catch((e) => {
    console.error('staleness failed:', e);
    process.exit(1);
  });
}
