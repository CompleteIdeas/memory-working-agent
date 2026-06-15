/* Build-time model warm-up: drive one write + one recall so AWM downloads its recall
 * models (embedding, reranker, query expander) into TRANSFORMERS_CACHE during `docker
 * build` — baked into the image so the FIRST real reply isn't a silent ~hundreds-of-MB
 * download, and the agent works offline. Run with MWA_DB pointed at a throwaway db. */
import { MwaMemory } from '../src/awm.js';

const m = new MwaMemory('prewarm', process.env.MWA_DB ?? '/tmp/prewarm.db');
await m.write('prewarm', 'Warming the recall models so the first real query is fast.', ['topic=prewarm']);
await m.recall('warm up the embedding and reranker models', { limit: 3 });
try { await m.consolidate(); } catch { /* optional */ }
m.close();
console.log('✅ prewarm complete — recall models cached at', process.env.TRANSFORMERS_CACHE ?? '(default)');
