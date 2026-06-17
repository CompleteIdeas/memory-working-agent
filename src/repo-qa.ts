/**
 * V2.1 — RETURN-VISIT REPO QA (the realistic retention benchmark).
 *
 * Robert's design: scan a repo, extract key facts, WIPE context, then return
 * later to ask questions. The cost that matters is the RETURN visit — the first
 * visit pays the one-time extraction/storage cost, and the savings compound on
 * every subsequent visit. We compare three realistic strategies:
 *
 *   A_awm    — facts written to AWM; each question RECALLS just the relevant slice.
 *   MD_file  — same facts written to a notes.md; each question loads the WHOLE file
 *              (this is what real agents do today — CLAUDE.md / a notes file).
 *   LongCtx  — no extraction; every question re-loads the whole repo slice.
 *
 * Metrics per arm: answer accuracy (deterministic keyword grade) + input tokens
 * per visit + CUMULATIVE tokens across N visits (one-time extraction counted on
 * visit 1). The crossover — where AWM/MD overtake LongCtx — is the headline.
 *
 * Extraction is done ONCE and shared by A_awm and MD_file, so the comparison
 * isolates RETRIEVAL cost, not extraction quality.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { getProvider } from './provider.js';
import { MwaMemory } from './awm.js';

export interface QA { q: string; expect: string[] } // answer must contain ALL of expect (normalized)
export interface RepoSpec { id: string; root: string; keyFiles: string[]; qa: QA[] }

const MWA_ROOT = resolve('.');
const AWM_ROOT = resolve('vendor', 'agent-working-memory');

export const CORPUS: RepoSpec[] = [
  {
    id: 'mwa',
    root: MWA_ROOT,
    keyFiles: ['src/provider.ts', 'src/brain.ts', 'src/worker.ts', 'src/retention.ts', 'package.json'],
    qa: [
      { q: "Which model does the 'brain' provider role use?", expect: ['gpt-5-4-mini'] },
      { q: 'What action protocol does the brain use instead of native tool-calling?', expect: ['json'] },
      { q: 'Which fixed file does the worker protect from being overwritten?', expect: ['test.mjs'] },
      { q: 'What is the default distractor sweep in the retention benchmark?', expect: ['10', '50', '200'] },
      { q: 'What HTTP endpoint path does the Azure GPT provider POST to?', expect: ['/responses'] },
      { q: 'Which provider role maps to the Sonnet model?', expect: ['high'] },
      { q: 'What HTTP header does the Azure provider use for authentication?', expect: ['api-key'] },
      { q: 'How many retry attempts does the Azure provider make on transient failures?', expect: ['6'] },
    ],
  },
  {
    id: 'awm',
    root: AWM_ROOT,
    keyFiles: ['README.md', 'package.json', 'src/mcp.ts', 'src/storage/factory.ts'],
    qa: [
      { q: 'What version is the agent-working-memory package?', expect: ['0.9.0'] },
      { q: 'What is the AWM CLI binary name?', expect: ['awm'] },
      { q: 'What are the two storage backends AWM supports?', expect: ['sqlite', 'pglite'] },
      { q: 'What is the package main entry point file?', expect: ['dist/index.js'] },
      { q: 'Which MCP tool recalls memories?', expect: ['memory_recall'] },
      { q: 'Which MCP tool replaces a stale memory with a corrected version?', expect: ['memory_supersede'] },
    ],
  },
];

type Arm = 'A_awm' | 'MD_file' | 'LongCtx';

function readRepoSlice(spec: RepoSpec, capPerFile = 6000): string {
  const parts: string[] = [];
  for (const f of spec.keyFiles) {
    try {
      const body = readFileSync(resolve(spec.root, f), 'utf8').slice(0, capPerFile);
      parts.push(`--- ${f} ---\n${body}`);
    } catch { /* missing file — skip */ }
  }
  return parts.join('\n\n');
}

function normalize(s: string): string { return s.toLowerCase().replace(/\s+/g, ' '); }
function graded(answer: string, qa: QA): boolean {
  const a = normalize(answer);
  return qa.expect.every((e) => a.includes(normalize(e)));
}

interface IngestResult { facts: string; mem: MwaMemory | null; oneTimeTok: number; rawSlice: string }

/** Phase 1 — extract key facts ONCE; store to AWM and to notes.md (shared facts). */
async function ingest(spec: RepoSpec, runId: string): Promise<IngestResult> {
  const gen = getProvider('brain');
  const rawSlice = readRepoSlice(spec);
  const ex = await gen.chat({
    system:
      'Extract ALL key, factual details from these repository files as terse bullet points: versions, file names, function/export names, commands, config values, defaults, API endpoints/headers, model names. One fact per line. No prose.',
    messages: [{ role: 'user', content: rawSlice }],
    maxTokens: 900,
  });
  const facts = ex.text.trim();
  const oneTimeTok = ex.usage.input + ex.usage.output;
  // store to AWM
  const db = `./data/repoqa-${runId}-${spec.id}.db`;
  for (const ext of ['', '-wal', '-shm']) { try { rmSync(db + ext, { force: true }); } catch {} }
  const mem = new MwaMemory(`repoqa-${runId}-${spec.id}`, db);
  // Storage guide (USEA AGENT.md / Claude AWM strategy): LEAD WITH THE FACT,
  // identifiers go in prefix tags — not a "repo X:" prefix that dilutes the head
  // of the body that BM25/embedding see most strongly.
  for (const line of facts.split('\n').map((l) => l.replace(/^[-*\d.\s]+/, '').trim()).filter((l) => l.length > 8)) {
    await mem.write(line.slice(0, 80), line, [`repo=${spec.id}`, `topic=${spec.id}-fact`, 'topic=repo-fact'], { canonical: true });
  }
  // store to notes.md (the realistic MD-file baseline)
  mkdirSync(resolve('./sandbox/repoqa'), { recursive: true });
  writeFileSync(resolve(`./sandbox/repoqa/notes-${spec.id}.md`), `# ${spec.id} repo notes\n\n${facts}\n`, 'utf8');
  return { facts, mem, oneTimeTok, rawSlice };
}

const ANSWER_SYS =
  'Answer the question about the repository using ONLY the provided context. ' +
  'If the answer is NOT present in the provided context, reply with EXACTLY: NOT_IN_CONTEXT. ' +
  'Otherwise reply with the answer only — terse, no explanation.';

/**
 * Answer from the arm's retrieval. If the retrieved context lacks the fact, the
 * agent FALLS BACK to scanning the full repo (Robert's point: notes/recall miss →
 * you still have to read the files, slow/expensive that way too). Fallback cost
 * is added to that visit. LongCtx never falls back (it already has everything).
 */
async function answer(arm: Arm, qa: QA, spec: RepoSpec, ing: IngestResult): Promise<{ ok: boolean; inTok: number; fellBack: boolean }> {
  const gen = getProvider('brain');
  let context = '';
  if (arm === 'A_awm') {
    const hits = await ing.mem!.recall(qa.q, { limit: 10, full: true }); // full content — precise values, not truncated summaries
    context = 'RECALLED FACTS:\n' + hits.map((h) => `- ${h.content}`).join('\n');
  } else if (arm === 'MD_file') {
    context = 'PROJECT NOTES (notes.md):\n' + ing.facts; // the whole notes file, every time
  } else {
    context = 'REPOSITORY FILES:\n' + ing.rawSlice; // the whole repo slice, every time
  }
  let out = await gen.chat({
    system: ANSWER_SYS,
    messages: [{ role: 'user', content: `${context}\n\nQUESTION: ${qa.q}\nANSWER:` }],
    maxTokens: 80,
  });
  let inTok = out.usage.input;
  let fellBack = false;
  // Miss → fall back to a full repo scan (only the notes/recall arms can miss).
  if (arm !== 'LongCtx' && /not_in_context/i.test(out.text)) {
    fellBack = true;
    out = await gen.chat({
      system: ANSWER_SYS,
      messages: [{ role: 'user', content: `REPOSITORY FILES:\n${ing.rawSlice}\n\nQUESTION: ${qa.q}\nANSWER:` }],
      maxTokens: 80,
    });
    inTok += out.usage.input; // pays retrieval cost PLUS the full scan
  }
  return { ok: graded(out.text, qa), inTok, fellBack };
}

export async function runRepoQA(opts: { repoIds?: string[]; runId?: string; visits?: number[] } = {}): Promise<void> {
  const runId = opts.runId ?? 'rq';
  const repos = CORPUS.filter((r) => !opts.repoIds || opts.repoIds.includes(r.id));
  const visitPoints = opts.visits ?? [1, 3, 10];
  const arms: Arm[] = ['A_awm', 'MD_file', 'LongCtx'];

  for (const spec of repos) {
    console.error(`\n[repoqa] ingesting ${spec.id} (${spec.keyFiles.length} files)...`);
    const ing = await ingest(spec, runId);
    const perArm: Record<Arm, { correct: number; total: number; perVisitTok: number; fallbacks: number }> = {
      A_awm: { correct: 0, total: 0, perVisitTok: 0, fallbacks: 0 },
      MD_file: { correct: 0, total: 0, perVisitTok: 0, fallbacks: 0 },
      LongCtx: { correct: 0, total: 0, perVisitTok: 0, fallbacks: 0 },
    };
    for (const arm of arms) {
      for (const qa of spec.qa) {
        const r = await answer(arm, qa, spec, ing);
        perArm[arm].correct += r.ok ? 1 : 0;
        perArm[arm].total += 1;
        perArm[arm].perVisitTok += r.inTok;
        perArm[arm].fallbacks += r.fellBack ? 1 : 0;
      }
      console.error(`[repoqa] ${spec.id} ${arm}: ${perArm[arm].correct}/${perArm[arm].total} correct, ${perArm[arm].perVisitTok} tok/visit, ${perArm[arm].fallbacks} fallback-scans`);
    }
    ing.mem?.close();

    // Report
    console.log(`\n=== REPO QA: ${spec.id} (${spec.qa.length} questions) ===`);
    console.log(`one-time extraction cost (A_awm & MD_file share it): ${ing.oneTimeTok} tok\n`);
    console.log(['arm'.padEnd(10), 'accuracy'.padStart(9), 'fallbk'.padStart(7), 'tok/vis'.padStart(8), ...visitPoints.map((v) => `cum@${v}`.padStart(9))].join(''));
    for (const arm of arms) {
      const a = perArm[arm];
      const oneTime = arm === 'LongCtx' ? 0 : ing.oneTimeTok; // LongCtx does no extraction
      const cum = visitPoints.map((v) => oneTime + v * a.perVisitTok);
      console.log([
        arm.padEnd(10),
        `${a.correct}/${a.total}`.padStart(9),
        `${a.fallbacks}`.padStart(7),
        `${a.perVisitTok}`.padStart(8),
        ...cum.map((c) => `${c}`.padStart(9)),
      ].join(''));
    }
    // crossover vs LongCtx
    const aw = perArm.A_awm, lc = perArm.LongCtx;
    if (lc.perVisitTok > aw.perVisitTok) {
      const v = ing.oneTimeTok / (lc.perVisitTok - aw.perVisitTok);
      console.log(`\nA_awm overtakes LongCtx after ~${Math.ceil(v)} visit(s): one-time ${ing.oneTimeTok} tok amortizes against ${lc.perVisitTok - aw.perVisitTok} tok/visit saved.`);
    }
    console.log('Savings compound on EVERY return visit; LongCtx re-pays the full repo each time, AWM recalls only the slice.\n');
  }
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('repo-qa.ts') || entry.endsWith('repo-qa.js')) {
  const ids = process.env.RQ_REPOS ? process.env.RQ_REPOS.split(',') : undefined;
  runRepoQA({ repoIds: ids, runId: process.env.RQ_RUNID ?? 'rq' }).catch((e) => {
    console.error('repo-qa failed:', e);
    process.exit(1);
  });
}
