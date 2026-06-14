/** Smoke test: prove MWA's MwaMemory works against the from-source AWM submodule build.
 * Resolves agent-working-memory via the workspace symlink -> vendor/agent-working-memory/dist. */
import { MwaMemory } from '../src/awm.js';
import { rmSync } from 'node:fs';

const db = './data/_smoke.db';
try { rmSync(db, { force: true }); } catch { /* */ }
const mem = new MwaMemory('smoke-agent', db);
const id = await mem.write('submodule smoke fact', 'AWM is vendored as a git submodule at vendor/agent-working-memory in MWA.', ['topic=submodule-smoke']);
console.log(`write -> ${id ? 'OK ' + id : 'FAILED'}`);
const hits = await mem.recall('where is AWM vendored in MWA', { limit: 3, full: true });
console.log(`recall -> ${hits.length} hit(s)`);
for (const h of hits) console.log(`   [${h.score.toFixed(2)}] ${h.concept}: ${h.content.slice(0, 70)}`);
mem.close();
try { rmSync(db, { force: true }); } catch { /* */ }
console.log(hits.some((h) => h.content.includes('submodule')) ? 'SMOKE PASS' : 'SMOKE FAIL');
