/**
 * One-time RETROFIT — backfill the SPINE provenance/trust tags onto memories written before the
 * spine shipped. Idempotent (skips engrams that already carry src=). Evidence-based + conservative:
 *
 *   source=email-ingest / has origin=  → provenance=ingested, trust=untrusted  (inbox-mined: keep low)
 *   topic=policy                        → provenance=user,     trust=high       (you stated these rules)
 *   everything else                     → provenance=inferred, trust=medium     (the agent's own knowledge)
 *
 * It NEVER up-trusts inbox-mined content (the safe direction) and never deletes/moves anything — it
 * only ADDS the two missing tags. Safe to run while the app is up (AWM SQLite is WAL multi-process
 * safe) and safe to re-run.
 *
 * Usage:  npx tsx scripts/retrofit-memory.ts "<path-to-agent.db>"   (defaults to MWA_DB or ./data/agent.db)
 */
import { EngramStore } from 'agent-working-memory/dist/storage/sqlite.js';
import { resolve } from 'node:path';

const dbPath = process.argv[2] || process.env.MWA_DB || resolve('./data/agent.db');
const dryRun = process.argv.includes('--dry-run');

function parseTags(t: unknown): string[] {
  if (Array.isArray(t)) return t as string[];
  if (typeof t === 'string') { try { const p = JSON.parse(t); return Array.isArray(p) ? p : t.split(','); } catch { return t.split(','); } }
  return [];
}

const store = new EngramStore(dbPath) as unknown as { db: any; updateTags: (id: string, tags: string[]) => void; close?: () => void };
const rows: { id: string; tags: unknown }[] = store.db.prepare('SELECT id, tags FROM engrams').all();

let stamped = 0, already = 0;
const tiers: Record<string, number> = { high: 0, medium: 0, untrusted: 0 };
for (const r of rows) {
  const tags = parseTags(r.tags).map((x) => String(x));
  if (tags.some((t) => t.toLowerCase().startsWith('src='))) { already++; continue; }
  let prov: string, trust: string;
  if (tags.some((t) => t === 'source=email-ingest' || t.toLowerCase().startsWith('origin='))) { prov = 'ingested'; trust = 'untrusted'; }
  else if (tags.includes('topic=policy')) { prov = 'user'; trust = 'high'; }
  else { prov = 'inferred'; trust = 'medium'; }
  if (!dryRun) store.updateTags(r.id, [...tags, `src=${prov}`, `trust=${trust}`]);
  stamped++; tiers[trust]++;
}

console.log(`[retrofit] db=${dbPath}${dryRun ? ' (DRY RUN)' : ''}`);
console.log(`[retrofit] ${rows.length} engrams total — ${stamped} stamped, ${already} already had src=`);
console.log(`[retrofit] tiers stamped: high=${tiers.high} (your policies)  medium=${tiers.medium} (agent knowledge)  untrusted=${tiers.untrusted} (inbox-mined)`);
store.close?.();
