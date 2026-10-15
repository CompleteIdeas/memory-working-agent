/**
 * Tier-2 #8 proof — `awm import` must preserve STAGE and RETRACTED status (gap analysis 2026-07).
 * Before the fix, import minted every engram active + non-retracted, so `--include-retracted` RESURRECTED
 * retracted memories and every non-active stage flattened to active. This exercises the real export→import
 * CLI end-to-end on SQLite.
 *
 *   npx tsx scripts/_import-stage-retract.ts
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngramStore } from 'agent-working-memory/dist/storage/sqlite.js';

const CLI = 'vendor/agent-working-memory/dist/cli.js';
const dir = mkdtempSync(join(tmpdir(), 'awm-imp-'));
const src = join(dir, 'source.db');
const dst = join(dir, 'target.db');
const dump = join(dir, 'dump.json');
const checks: { name: string; pass: boolean; detail?: string }[] = [];
const ok = (n: string, p: boolean, d?: string) => checks.push({ name: n, pass: p, detail: d });

async function main() {
  // seed a source store: one active, one archived-stage, one retracted
  const s: any = new EngramStore(src);
  const active = s.createEngram({ agentId: 'A', concept: 'active one', content: 'the launch is Friday' });
  const arch = s.createEngram({ agentId: 'A', concept: 'archived one', content: 'old note to archive' });
  const gone = s.createEngram({ agentId: 'A', concept: 'retracted one', content: 'deliberately removed fact' });
  s.updateStage(arch.id, 'archived');
  s.retractEngram(gone.id, null);
  s.close();

  // export EVERYTHING, then import into a fresh store
  execFileSync(process.execPath, [CLI, 'export', '--db', src, '--agent', 'A', '--all-stages', '--include-retracted', '--output', dump], { stdio: 'pipe' });
  execFileSync(process.execPath, [CLI, 'import', dump, '--db', dst, '--remap-agent', 'A', '--include-retracted'], { stdio: 'pipe' });

  // read the target back, retracted included
  const t: any = new EngramStore(dst);
  const all: any[] = t.getEngramsByAgent('A', undefined, true) ?? [];
  const byContent = (frag: string) => all.find((e) => String(e.content).includes(frag));
  t.close();

  ok('all 3 engrams imported', all.length === 3, `got ${all.length}`);
  const a = byContent('launch is Friday'); const ar = byContent('old note to archive'); const g = byContent('deliberately removed');
  ok('active engram stays active + not retracted', !!a && a.stage === 'active' && !a.retracted, JSON.stringify({ stage: a?.stage, retracted: a?.retracted }));
  ok('archived stage is PRESERVED (not flattened to active)', !!ar && ar.stage === 'archived', `stage=${ar?.stage}`);
  ok('retracted memory stays RETRACTED (not resurrected as live)', !!g && !!g.retracted, `retracted=${g?.retracted}`);

  rmSync(dir, { recursive: true, force: true });
  const passed = checks.filter((c) => c.pass).length;
  console.log('\n=== awm import — stage + retracted preservation (Tier-2 #8) ===');
  for (const c of checks) console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : `  → ${c.detail ?? ''}`}`);
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed !== checks.length) process.exit(1);
  console.log('PASS — import preserves stage + retracted; retracted memories are no longer resurrected.');
}
main().catch((e) => { console.error('import-stage-retract failed:', e?.stack ?? e); try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } process.exit(1); });
