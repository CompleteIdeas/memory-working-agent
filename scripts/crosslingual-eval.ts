/**
 * Cross-lingual recall probe — the test that justifies a MULTILINGUAL embedder.
 *
 * English-only evals (4-suite, LoCoMo) can only show the COST of going multilingual
 * (a slight English-quality dip), never the BENEFIT. The benefit is: store a memory in
 * English, then RECALL it with a query in another language. bge-small-en cannot do this
 * (cross-language pairs land in different regions of meaning-space); a multilingual
 * embedder (e.g. multilingual-e5-small, 384d drop-in) should.
 *
 * Design (single IV = the embedder):
 *   - Store N facts in ENGLISH (each a distinct topic) + English distractors.
 *   - For each fact, issue the equivalent query in es / fr / de.
 *   - Score recall@1 / recall@5 / MRR of the correct English fact for the foreign query.
 *
 * Run (needs the model downloaded; HF reachable):
 *   bge-small (baseline, expect ~chance cross-lingual):
 *     tsx scripts/crosslingual-eval.ts
 *   multilingual-e5-small (candidate, 384d drop-in):
 *     AWM_EMBED_MODEL=Xenova/multilingual-e5-small AWM_EMBED_DIMS=384 tsx scripts/crosslingual-eval.ts
 */
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { MwaMemory } from '../src/awm.js';

const DB = resolve('./data/_xling.db');
for (const e of ['', '-wal', '-shm']) { try { rmSync(DB + e); } catch { /* */ } }

// Each item: an English fact + the same question in 3 languages. Topics are distinct
// so the correct fact is unambiguous; distractors share vocabulary to make it non-trivial.
const ITEMS: Array<{ concept: string; fact: string; q: { en: string; es: string; fr: string; de: string } }> = [
  { concept: 'atlas deadline', fact: 'The Atlas project deadline is August 15.',
    q: { en: 'When is the Atlas project due?', es: '¿Cuándo vence el proyecto Atlas?', fr: 'Quand le projet Atlas est-il dû ?', de: 'Wann ist das Atlas-Projekt fällig?' } },
  { concept: 'office location', fact: 'The new office is located in downtown Portland.',
    q: { en: 'Where is the new office?', es: '¿Dónde está la nueva oficina?', fr: 'Où se trouve le nouveau bureau ?', de: 'Wo befindet sich das neue Büro?' } },
  { concept: 'team lead', fact: 'Marcus Lee leads the engineering team.',
    q: { en: 'Who leads the engineering team?', es: '¿Quién dirige el equipo de ingeniería?', fr: "Qui dirige l'équipe d'ingénierie ?", de: 'Wer leitet das Engineering-Team?' } },
  { concept: 'budget amount', fact: 'The marketing budget for this quarter is forty thousand dollars.',
    q: { en: 'What is the marketing budget this quarter?', es: '¿Cuál es el presupuesto de marketing este trimestre?', fr: 'Quel est le budget marketing ce trimestre ?', de: 'Wie hoch ist das Marketingbudget dieses Quartal?' } },
  { concept: 'launch date', fact: 'The product launches on the first Monday of March.',
    q: { en: 'When does the product launch?', es: '¿Cuándo se lanza el producto?', fr: 'Quand le produit est-il lancé ?', de: 'Wann wird das Produkt eingeführt?' } },
  { concept: 'favorite cuisine', fact: 'The client prefers Italian food for working dinners.',
    q: { en: 'What food does the client prefer?', es: '¿Qué comida prefiere el cliente?', fr: 'Quelle nourriture le client préfère-t-il ?', de: 'Welches Essen bevorzugt der Kunde?' } },
  { concept: 'server region', fact: 'Production servers run in the Frankfurt data center.',
    q: { en: 'Where do the production servers run?', es: '¿Dónde se ejecutan los servidores de producción?', fr: 'Où fonctionnent les serveurs de production ?', de: 'Wo laufen die Produktionsserver?' } },
  { concept: 'meeting day', fact: 'The weekly standup happens every Wednesday morning.',
    q: { en: 'When is the weekly standup?', es: '¿Cuándo es la reunión semanal?', fr: "Quand a lieu la réunion hebdomadaire ?", de: 'Wann ist das wöchentliche Standup?' } },
];

const DISTRACTORS = [
  'The quarterly report covers revenue and expenses.', 'The conference room has a new projector.',
  'Remember to renew the software licenses.', 'The parking garage closes at midnight.',
  'The annual review process starts in November.', 'Coffee supplies are restocked on Fridays.',
  'The VPN requires two-factor authentication.', 'The holiday schedule was posted last week.',
];

async function main() {
  const model = process.env.AWM_EMBED_MODEL ?? 'Xenova/bge-small-en-v1.5 (default)';
  const m = new MwaMemory('xling', DB);
  const idOf: Record<string, string> = {};
  for (const it of ITEMS) idOf[it.concept] = (await m.write(it.concept, it.fact, ['topic=facts'])) ?? '';
  for (let i = 0; i < DISTRACTORS.length; i++) await m.write(`distractor ${i}`, DISTRACTORS[i], ['topic=facts']);
  await m.consolidate();

  const langs: Array<'en' | 'es' | 'fr' | 'de'> = ['en', 'es', 'fr', 'de'];
  const agg: Record<string, { r1: number; r5: number; mrr: number; n: number }> = {};
  for (const l of langs) agg[l] = { r1: 0, r5: 0, mrr: 0, n: 0 };

  for (const it of ITEMS) {
    for (const l of langs) {
      const rows = await m.recall(it.q[l], { limit: 5, rerank: process.env.AWM_XLING_NORERANK !== '1' });
      const rank = rows.findIndex(r => r.id === idOf[it.concept]) + 1;
      agg[l].n++;
      if (rank === 1) agg[l].r1++;
      if (rank >= 1 && rank <= 5) agg[l].r5++;
      if (rank >= 1) agg[l].mrr += 1 / rank;
    }
  }
  m.close();
  for (const e of ['', '-wal', '-shm']) { try { rmSync(DB + e); } catch { /* */ } }

  console.log(`\n=== CROSS-LINGUAL RECALL — model=${model}  (${ITEMS.length} facts) ===`);
  console.log('  lang   recall@1   recall@5   MRR');
  for (const l of langs) {
    const a = agg[l];
    const p = (x: number) => `${(100 * x / a.n).toFixed(0)}%`.padStart(7);
    console.log(`   ${l}   ${p(a.r1)}   ${p(a.r5)}    ${(a.mrr / a.n).toFixed(3)}`);
  }
  console.log('  (en = sanity check; es/fr/de = cross-lingual. bge-small-en should crater on es/fr/de;');
  console.log('   a multilingual model should hold up — that is the capability being tested.)');
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
