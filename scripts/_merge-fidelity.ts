/**
 * Tier-2 #7 proof — `awm merge` must preserve embeddings, memory_class, and BM25/FTS (gap analysis
 * 2026-07). The old hand-rolled merge dropped embedding/memory_class/type and never populated the FTS
 * index, silently killing both recall channels for merged rows. Exercises the real CLI on SQLite.
 *
 *   npx tsx scripts/_merge-fidelity.ts
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngramStore } from 'agent-working-memory/dist/storage/sqlite.js';

const CLI = 'vendor/agent-working-memory/dist/cli.js';
const dir = mkdtempSync(join(tmpdir(), 'awm-merge-'));
const A = join(dir, 'a.db'), B = join(dir, 'b.db'), T = join(dir, 'target.db');
const emb = (s: number) => Array.from({ length: 384 }, (_, i) => ((i + s) % 97) / 97);
const checks: { name: string; pass: boolean; detail?: string }[] = [];
const ok = (n: string, p: boolean, d?: string) => checks.push({ name: n, pass: p, detail: d });

async function main() {
  const sa: any = new EngramStore(A);
  sa.createEngram({ agentId: 'X', concept: 'launch date', content: 'the product launches on Friday', embedding: emb(1), memoryClass: 'canonical', tags: ['topic=launch'] });
  sa.createEngram({ agentId: 'X', concept: 'archived note', content: 'old stuff to keep', embedding: emb(2) });
  sa.close();
  const sb: any = new EngramStore(B);
  sb.createEngram({ agentId: 'Y', concept: 'greenery', content: 'the grass is green', embedding: emb(3) });
  sb.close();

  execFileSync(process.execPath, [CLI, 'merge', '--target', T, '--source', A, '--source', B], { stdio: 'pipe' });

  const t: any = new EngramStore(T);
  const all: any[] = [...(t.getEngramsByAgent('X', undefined, true) ?? []), ...(t.getEngramsByAgent('Y', undefined, true) ?? [])];
  ok('all 3 engrams merged (both agents)', all.length === 3, `got ${all.length}`);
  ok('embeddings PRESERVED (384-d) — vector recall survives', all.every((e) => Array.isArray(e.embedding) && e.embedding.length === 384));
  const canon = all.find((e) => String(e.content).includes('launches on Friday'));
  ok('memory_class PRESERVED (canonical, not defaulted to working)', !!canon && canon.memoryClass === 'canonical', canon?.memoryClass);
  const ftsCount = (t.db.prepare('SELECT count(*) AS c FROM engrams_fts').get() as { c: number }).c;
  ok('FTS/BM25 index POPULATED for merged rows (BM25 recall survives)', ftsCount === 3, `fts rows=${ftsCount}`);
  const bm25 = (t.db.prepare("SELECT count(*) AS c FROM engrams_fts WHERE engrams_fts MATCH 'green'").get() as { c: number }).c;
  ok('BM25 actually matches merged content', bm25 >= 1, `matches=${bm25}`);
  t.close();

  rmSync(dir, { recursive: true, force: true });
  const passed = checks.filter((c) => c.pass).length;
  console.log('\n=== awm merge — embedding + class + BM25 fidelity (Tier-2 #7) ===');
  for (const c of checks) console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : `  → ${c.detail ?? ''}`}`);
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed !== checks.length) process.exit(1);
  console.log('PASS — merge preserves embeddings, memory_class, and populates BM25; no silent recall loss.');
}
main().catch((e) => { console.error('merge-fidelity failed:', e?.stack ?? e); try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } process.exit(1); });
