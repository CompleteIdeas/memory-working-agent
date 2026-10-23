// BL-72: how the reviewer's shadow decisions compare with what the person actually did.
//   node scripts/approval-shadow-report.mjs [approval-reviews.jsonl] [approvals.db]
// Defaults: ./data/approval-reviews.jsonl and ./data/approvals.db (on Railway: /data/...). The bar to turn
// MWA_AUTO_APPROVE=on: no action the person cancelled (or let expire after reading) that the reviewer would
// have run. Rows older than a week have left approvals.db; their outcome shows as "gone".
import { readFileSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';

const logPath = process.argv[2] ?? './data/approval-reviews.jsonl';
const dbPath = process.argv[3] ?? './data/approvals.db';
if (!existsSync(logPath)) { console.log(`no review log at ${logPath}`); process.exit(0); }
const reviews = readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const db = existsSync(dbPath) ? new Database(dbPath, { readonly: true }) : null;
const status = (id) => db?.prepare('SELECT status FROM approvals WHERE id = ?').get(id)?.status ?? 'gone';

// approved = done/failed/executing/approved; declined = cancelled; expired = nobody answered
const bucket = (s) => (['done', 'failed', 'executing', 'approved'].includes(s) ? 'approved' : s === 'cancelled' ? 'declined' : s);
const table = {};
const worrying = [];
for (const r of reviews) {
  const out = bucket(status(r.id));
  const key = `${r.decision.padEnd(4)} → person ${out}`;
  table[key] = (table[key] ?? 0) + 1;
  if (r.decision === 'auto' && out === 'declined') worrying.push(r);
}
console.log(`${reviews.length} reviewed actions (${logPath})`);
for (const [k, n] of Object.entries(table).sort()) console.log(`  reviewer ${k}: ${n}`);
const by = {};
for (const r of reviews) by[r.by] = (by[r.by] ?? 0) + 1;
console.log(`decided by: ${Object.entries(by).map(([k, n]) => `${k} ${n}`).join(', ')}`);
const ms = reviews.map((r) => r.ms).sort((a, b) => a - b);
if (ms.length) console.log(`median review time: ${ms[Math.floor(ms.length / 2)]} ms`);
console.log(worrying.length ? `\n⚠ the reviewer would have RUN ${worrying.length} action(s) the person declined:` : '\nno action the person declined would have run.');
for (const r of worrying) console.log(`  ${new Date(r.at).toISOString()} ${r.tool}: ${String(r.action).split('\n').slice(-2).join(' ').slice(0, 140)}`);
