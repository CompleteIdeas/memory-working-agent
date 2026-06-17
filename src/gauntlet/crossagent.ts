/**
 * Cross-agent shared-recall benchmark — the test AWM wins by construction.
 *
 * Agent A records decisions/facts; a DIFFERENT agent B (fresh identity, no shared context) is
 * then asked questions only answerable from A's writes. The single variable is the memory
 * substrate's ability to SHARE across agents:
 *   - awm: A+B on one store + workspace → B recalls A's decisions.
 *   - rag/notes/longctx: per-process stores → B sees nothing (a library can't share).
 *   - off: nothing remembered.
 * Seeds are written directly by A (deterministic, no LLM noise); probes run through B's real
 * conductor (runAgent), so we measure whether B's memory surfaces A's knowledge. Deterministic
 * scoring. Usage: tsx src/gauntlet/crossagent.ts [--arms awm,rag,notes,off] [--k 1]
 */
import { rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { getProvider } from '../provider.js';
import { RoutedProvider } from '../model-router.js';
import { buildRegistry } from '../tools/build.js';
import { loadConfig } from '../config.js';
import { runAgent } from '../agent.js';
import { makeCrossAgentPair, type ArmName } from './arms.js';

const ALL: ArmName[] = ['awm', 'rag', 'notes', 'off'];
const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };

// What agent A records (directly), and what agent B is later asked.
// Every fact is a SPECIFIC, UNGUESSABLE value that can ONLY come from A's memory — so a
// no-memory model can't pass by guessing a plausible default (the rag-33% false-positive fix).
const SEEDS: [string, string][] = [
  ['ledger database decision', 'We decided to use Postgres for the ledger, chosen over MongoDB for transactional integrity.'],
  ['email approval rule', 'All outbound email must be approved by Marcus Lee before it is sent.'],
  ['scheduler', 'Sarah Chen is the project scheduler and assistant.'],
];
const PROBES: { q: string; want: RegExp }[] = [
  { q: 'What database did we choose for the ledger? Reply in one short line.', want: /postgres/i },
  { q: 'Who must approve outbound email before it is sent? Reply with just the name.', want: /marcus/i },
  { q: 'Who is the project scheduler? Reply with just the name.', want: /sarah/i },
];

async function main() {
  const arms = arg('arms', ALL.join(',')).split(',').map((s) => s.trim()).filter(Boolean) as ArmName[];
  const k = Number(arg('k', '1'));
  const cfg = loadConfig();
  const { registry, close } = await buildRegistry(cfg);
  const brain = new RoutedProvider(getProvider('brain'), getProvider('high'));
  const worker = new RoutedProvider(getProvider('brain'), getProvider('high'));
  const root = resolve('./results/gauntlet-crossagent');
  rmSync(root, { recursive: true, force: true });

  console.log(`\nCROSS-AGENT SHARED-RECALL BENCHMARK — arms=[${arms.join(', ')}]  k=${k}  (A writes → B recalls)\n`);
  const pass: Record<string, number> = {};
  for (const armName of arms) pass[armName] = 0;

  for (let r = 0; r < k; r++) {
    for (const armName of arms) {
      const dir = resolve(root, armName, `r${r}`);
      const { a, b } = makeCrossAgentPair(armName, resolve(dir, 'store'));
      // Agent A records the decisions (direct, deterministic).
      for (const [concept, content] of SEEDS) await a.write(concept, content, ['topic=decision', 'intent=decision', 'confidence_level=verified'], { canonical: true, eventType: 'decision' });
      a.close();
      // Agent B (different identity) is probed through its real conductor.
      const work = resolve(dir, 'work'); mkdirSync(work, { recursive: true });
      process.stdout.write(`  [${armName} r${r}] `);
      for (const p of PROBES) {
        let ok = false;
        try {
          const res = await runAgent({ instruction: p.q, dir: work, memory: b, brain, worker, tools: registry, interactive: true, session: `xagent-${armName}-${r}`, budget: { maxSteps: 5, maxWallMs: 60_000, consolidateEvery: 50 } });
          ok = p.want.test(res.summary);
        } catch { ok = false; }
        if (ok) pass[armName]++;
        process.stdout.write(ok ? '✓' : '✗');
      }
      process.stdout.write('\n');
      b.close();
    }
  }
  close();

  const total = PROBES.length * k;
  console.log(`\n  cross-agent recall pass-rate (B recalls A's decisions), ${PROBES.length} probes × k=${k}:\n`);
  for (const armName of arms) {
    const pctv = Math.round((pass[armName] / total) * 100);
    console.log(`    ${armName.padStart(7)}:  ${String(pctv).padStart(3)}%   (${pass[armName]}/${total})`);
  }
  console.log(`\n  expected: awm high (shared substrate); rag/notes/off ~0 (per-process, can't share).`);
}
main().catch((e) => { console.error(e); process.exit(1); });
