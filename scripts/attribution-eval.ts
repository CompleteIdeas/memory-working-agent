/**
 * Attribution-precision eval — the instrument LoCoMo recall@k can't be.
 *
 * Question (Robert, 2026-06-16): when you ask "what does Caroline think about the
 * trip", does CAROLINE's turn outrank Dave's/Mia's turn on the SAME topic? That's
 * attribution precision. LoCoMo only scores "is the gold turn in top-10" — it never
 * checks whether the *right speaker's* version ranked above the wrong one, so it is
 * structurally blind to what the query-conditioned bridge (AWM_QUERY_BRIDGE) does.
 *
 * Design (controlled, single IV = the bridge):
 *   - 3 speakers each state a first-person opinion on each of N topics. The speaker
 *     is ONLY a tag (no name in content/concept) — so the reranker is blind to who
 *     said it; only the speaker tag attributes it. This is the realistic case.
 *   - Per-speaker filler turns on misc topics create a realistic, noisy pool.
 *   - For each (speaker, topic) probe, query "What does {Speaker} think about {topic}?"
 *     and score:
 *       attrib-win : the queried speaker's topic-turn outranks BOTH other speakers'
 *                    same-topic turns (the pairwise attribution metric)
 *       correct@1  : the queried speaker's topic-turn is rank #1 overall
 *       MRR        : reciprocal rank of the correct turn
 *
 * Run BOTH and compare:
 *   baseline :                              tsx scripts/attribution-eval.ts
 *   bridge   : AWM_QUERY_BRIDGE=1 [AWM_AUTOTAG=1] tsx scripts/attribution-eval.ts
 */
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { MwaMemory } from '../src/awm.js';

const DB = resolve('./data/_attrib.db');
for (const e of ['', '-wal', '-shm']) { try { rmSync(DB + e); } catch { /* */ } }

const SPEAKERS = ['Caroline', 'Dave', 'Mia'];

// topic → per-speaker first-person opinion (NO speaker name in the text).
const TOPICS: Array<{ topic: string; views: [string, string, string] }> = [
  { topic: 'the trip', views: ['I think the trip should be relaxed with lots of downtime', 'I think the trip should be packed with activities and early starts', 'I think the trip should mix some structure with free time'] },
  { topic: 'dinner', views: ['I really want italian food for dinner tonight', 'I would much rather get sushi for dinner', 'I am craving thai food for dinner'] },
  { topic: 'the budget', views: ['I think we should keep the budget tight and save more', 'I think we can spend freely on this budget', 'I think the budget should leave room for a splurge'] },
  { topic: 'the movie', views: ['I want to watch a slow thoughtful drama', 'I want an action blockbuster with explosions', 'I want a light romantic comedy'] },
  { topic: 'the apartment', views: ['I prefer a quiet apartment away from downtown', 'I want an apartment right in the busy city center', 'I like an apartment near the park with green space'] },
  { topic: 'the gift', views: ['I think a handmade gift is the most meaningful', 'I think an expensive gadget makes the best gift', 'I think an experience like a concert is the ideal gift'] },
  { topic: 'the weekend', views: ['I want a calm weekend reading at home', 'I want an adventurous weekend hiking the mountains', 'I want a social weekend with friends and parties'] },
  { topic: 'the car', views: ['I think we should buy a reliable fuel efficient car', 'I think we should get a fast sporty car', 'I think a spacious family car is the right choice'] },
  { topic: 'the holiday', views: ['I want a beach holiday somewhere warm and sunny', 'I want a city holiday full of museums and culture', 'I want a countryside holiday surrounded by nature'] },
  { topic: 'the project', views: ['I think the project should ship a simple version first', 'I think the project needs every feature before launch', 'I think the project should focus on a niche audience'] },
  { topic: 'the wedding', views: ['I think the wedding should be small and intimate', 'I think the wedding should be a huge celebration', 'I think the wedding should be a destination event abroad'] },
  { topic: 'the diet', views: ['I believe a plant based diet is healthiest', 'I believe a high protein diet works best', 'I believe a balanced flexible diet is the way'] },
];

const FILLER = ['the weather has been lovely lately', 'I finished that book last night', 'work was busy this week', 'the garden is coming along nicely', 'I tried a new coffee shop', 'my phone needs an upgrade', 'traffic was terrible today', 'I started a new podcast'];

async function main() {
  const arm = [process.env.AWM_QUERY_BRIDGE === '1' ? 'query-bridge' : '', process.env.AWM_AUTOTAG === '1' ? 'autotag' : ''].filter(Boolean).join('+') || 'baseline';
  const m = new MwaMemory('attrib', DB);

  // correctId[topicIdx][speakerIdx] = engram id of that speaker's opinion on that topic.
  const correctId: string[][] = [];
  for (let ti = 0; ti < TOPICS.length; ti++) {
    correctId[ti] = [];
    for (let si = 0; si < SPEAKERS.length; si++) {
      const content = TOPICS[ti].views[si];
      const concept = content.split(/\s+/).slice(0, 6).join(' '); // unique-ish, no speaker name → no merge, no leak
      const id = await m.write(concept, content, [SPEAKERS[si].toLowerCase(), 'topic=chat']);
      correctId[ti][si] = id ?? '';
    }
  }
  // Filler turns per speaker (noise).
  for (let si = 0; si < SPEAKERS.length; si++) {
    for (let f = 0; f < FILLER.length; f++) {
      await m.write(`${FILLER[f].split(/\s+/).slice(0, 4).join(' ')} ${si}${f}`, `${FILLER[(f + si) % FILLER.length]}, honestly.`, [SPEAKERS[si].toLowerCase(), 'topic=chat']);
    }
  }
  await m.consolidate();

  let probes = 0, attribWins = 0, correctAt1 = 0, mrrSum = 0;
  for (let ti = 0; ti < TOPICS.length; ti++) {
    for (let si = 0; si < SPEAKERS.length; si++) {
      const rows = await m.recall(`What does ${SPEAKERS[si]} think about ${TOPICS[ti].topic}?`, { limit: 10 });
      const rankOf = (id: string) => { const r = rows.findIndex(x => x.id === id); return r < 0 ? Infinity : r + 1; };
      const myRank = rankOf(correctId[ti][si]);
      const otherRanks = SPEAKERS.map((_, sj) => sj === si ? Infinity : rankOf(correctId[ti][sj])).filter(r => r < Infinity);
      const bestOther = otherRanks.length ? Math.min(...otherRanks) : Infinity;

      probes++;
      if (myRank < bestOther) attribWins++;      // correct speaker outranks all other speakers on this topic
      if (myRank === 1) correctAt1++;
      if (myRank < Infinity) mrrSum += 1 / myRank;
    }
  }
  m.close();
  for (const e of ['', '-wal', '-shm']) { try { rmSync(DB + e); } catch { /* */ } }

  const pct = (n: number) => `${(100 * n / probes).toFixed(1)}%`;
  console.log(`\n=== ATTRIBUTION-PRECISION — arm=${arm}  (${probes} probes, ${SPEAKERS.length} speakers × ${TOPICS.length} topics) ===`);
  console.log(`  attrib-win (right speaker outranks others on topic): ${pct(attribWins)}  (${attribWins}/${probes})`);
  console.log(`  correct@1  (right speaker's turn is rank #1)        : ${pct(correctAt1)}  (${correctAt1}/${probes})`);
  console.log(`  MRR of the correctly-attributed turn               : ${(mrrSum / probes).toFixed(3)}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
