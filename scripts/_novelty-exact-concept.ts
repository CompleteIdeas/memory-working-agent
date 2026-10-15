/**
 * Tier-2 #12 (H1) proof — the R1 duplicate leak. computeNoveltyWithMatch must point at an EXACT
 * same-concept engram (so the write-pipeline REINFORCES it) even when a DIFFERENT-concept engram wins
 * the cosine channel. Before the fix it returned the highest-scoring match, so a channel disagreement
 * (semantic top ≠ the concept-duplicate) fell through to createNewEngram and duplicate concepts piled up.
 *
 *   npx tsx scripts/_novelty-exact-concept.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngramStore } from 'agent-working-memory/dist/storage/sqlite.js';
import { computeNoveltyWithMatch } from 'agent-working-memory/dist/core/salience.js';

const dir = mkdtempSync(join(tmpdir(), 'awm-nov-'));
const db = join(dir, 'a.db');
const vec = (s: number) => Array.from({ length: 384 }, (_, i) => Math.sin((i + 1) * (s + 1) * 0.013));
const checks: { name: string; pass: boolean; detail?: string }[] = [];
const ok = (n: string, p: boolean, d?: string) => checks.push({ name: n, pass: p, detail: d });

async function main() {
  const s: any = new EngramStore(db);
  const dupEmb = vec(1);   // the exact-concept engram — deliberately FAR from the query vector
  const queryEmb = vec(50); // the different-concept engram shares THIS vector → it wins cosine

  const dupConcept = 'user email signoff';
  const dup = s.createEngram({ agentId: 'A', concept: dupConcept, content: 'sign my emails as Rob', embedding: dupEmb });
  const other = s.createEngram({ agentId: 'A', concept: 'quarterly finance note', content: 'sign the emails and forms by Friday', embedding: queryEmb });

  // sanity: the COSINE winner for the query vector is the DIFFERENT-concept engram (the disagreement)
  const hits: any[] = await s.searchByVector('A', queryEmb, 3);
  ok('cosine top is the DIFFERENT-concept engram (channel disagreement set up)', hits[0]?.engram?.id === other.id, `top=${hits[0]?.engram?.concept}`);

  // now write the SAME concept again, with the query embedding (closest to `other`, not `dup`)
  const r = await computeNoveltyWithMatch(s, 'A', dupConcept, 'sign my emails as Robert now', null, queryEmb);
  ok('matchedEngramId points at the EXACT-concept engram (reinforce, not duplicate)', r.matchedEngramId === dup.id, `matched=${r.matchedEngramId === other.id ? 'the-different-concept-engram (BUG)' : r.matchedEngramId}`);
  ok('novelty is dampened (recognized as a near-duplicate)', r.novelty < 0.8, `novelty=${r.novelty}`);

  s.close();
  rmSync(dir, { recursive: true, force: true });
  const passed = checks.filter((c) => c.pass).length;
  console.log('\n=== write-pipeline R1 duplicate leak (Tier-2 #12 / H1) ===');
  for (const c of checks) console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : `  → ${c.detail ?? ''}`}`);
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed !== checks.length) process.exit(1);
  console.log('PASS — an exact-concept duplicate reinforces the existing engram even when cosine points elsewhere.');
}
main().catch((e) => { console.error('novelty-exact-concept failed:', e?.stack ?? e); try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } process.exit(1); });
