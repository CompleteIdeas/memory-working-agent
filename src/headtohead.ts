/**
 * V2.1 extension — EMPIRICAL head-to-head: AWM scoped recall (live `work` store)
 * vs grep+read against the real equihub-docs notes repo. Same EquiHub questions,
 * measure tokens carried to get the answer AND what each surfaces.
 *
 * AWM arm: recall top-k from the `work` agent snapshot (full content) → tokens =
 *   the recalled slice only.
 * DOCS arm: rank equihub-docs files by keyword hits, open the single best-matching
 *   doc (the OPTIMISTIC case for grep — a real agent often opens 2-3) → tokens =
 *   that whole file.
 */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { MwaMemory } from './awm.js';

const DOCS_ROOT = 'C:/Users/robert/project/equihub-docs';
const SNAPSHOT = './data/work-snapshot.db';
const tok = (s: string) => Math.ceil(s.length / 4);

const QUESTIONS: { q: string; kw: string[] }[] = [
  { q: 'How many active POC qualification rules are there and what do they cover?', kw: ['poc', 'qualification', 'rules', 'qualrules'] },
  { q: 'What are the fee services that must stay aligned, and what does each do?', kw: ['fee', 'fee-catalog', 'fee service', 'fee engine'] },
  { q: 'What is the AEC qualification engine and how does it work?', kw: ['aec', 'qualification engine'] },
  { q: 'How does post-show reconciliation work in EquiHub?', kw: ['reconciliation', 'post-show', 'post show'] },
  { q: 'What are the membership constraints and rules?', kw: ['membership', 'constraint'] },
  { q: 'How is horse registration and USEF data handled?', kw: ['horse', 'registration', 'usef'] },
];

// Build a doc index once.
function indexDocs(root: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string) => {
    let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(dir, e.name);
      if (/[\\/]\.git/.test(p)) continue;
      if (e.isDirectory()) walk(p);
      else if (['.md', '.txt'].includes(extname(e.name).toLowerCase())) {
        try { if (statSync(p).size < 2_000_000) out.push({ path: p, text: readFileSync(p, 'utf8') }); } catch { /* */ }
      }
    }
  };
  walk(root);
  return out;
}

export async function runHeadToHead(): Promise<void> {
  const mem = new MwaMemory('work', SNAPSHOT);
  const docs = indexDocs(DOCS_ROOT);
  console.error(`[h2h] indexed ${docs.length} equihub-docs files; recalling from work store...`);

  const rows: { q: string; awmTok: number; awmTop: string; docTok: number; docFile: string }[] = [];
  for (const { q, kw } of QUESTIONS) {
    // AWM arm
    const hits = await mem.recall(q, { limit: 5, full: true });
    const awmTok = hits.reduce((s, h) => s + tok(h.content), 0);
    const awmTop = hits[0] ? `${hits[0].concept} :: ${hits[0].content.slice(0, 90).replace(/\n/g, ' ')}` : '(none)';

    // DOCS arm — rank by keyword hits, open the single best file
    let best = { path: '(none)', text: '', hits: 0 };
    for (const d of docs) {
      const lc = d.text.toLowerCase();
      let h = 0; for (const k of kw) h += lc.split(k.toLowerCase()).length - 1;
      if (h > best.hits) best = { path: d.path, text: d.text, hits: h };
    }
    const docTok = tok(best.text);
    rows.push({ q, awmTok, awmTop, docTok, docFile: best.path.replace(/.*equihub-docs[\\/]/, '') });
    console.error(`[h2h] "${q.slice(0, 40)}..." AWM=${awmTok}tok docs=${docTok}tok (${best.path.replace(/.*[\\/]/, '')})`);
  }
  mem.close();

  console.log('\n=== EMPIRICAL: AWM scoped recall (work store) vs grep+read equihub-docs ===\n');
  let totAwm = 0, totDoc = 0;
  for (const r of rows) {
    totAwm += r.awmTok; totDoc += r.docTok;
    console.log(`Q: ${r.q}`);
    console.log(`   AWM recall : ${String(r.awmTok).padStart(6)} tok  | top: ${r.awmTop}`);
    console.log(`   grep+open  : ${String(r.docTok).padStart(6)} tok  | best doc: ${r.docFile}`);
    console.log(`   => AWM carried ${(r.docTok / Math.max(1, r.awmTok)).toFixed(1)}x fewer tokens for this answer\n`);
  }
  console.log(`TOTALS across ${rows.length} questions: AWM ${totAwm} tok vs grep+open ${totDoc} tok = ${(totDoc / Math.max(1, totAwm)).toFixed(1)}x`);
  console.log('(grep arm is the OPTIMISTIC lower bound — single best file; a real agent often opens 2-3 docs and still misses cross-file facts.)\n');
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('headtohead.ts') || entry.endsWith('headtohead.js')) {
  runHeadToHead().catch((e) => { console.error('h2h failed:', e); process.exit(1); });
}
