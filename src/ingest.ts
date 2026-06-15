/**
 * `mwa ingest` — the deduped world-ingestion pass. Systematically pages the inbox for a
 * time window (skipping spam/trash), collapses duplicate copies by Message-ID, and learns
 * durable facts from each unique message in batches — building the knowledge base that
 * makes everyday questions instant. Unlike the agent's ad-hoc search loop, this gives
 * thorough, single-pass coverage. Re-running is safe: AWM reinforces duplicates instead
 * of piling them up.
 */
import { RoutedProvider } from './model-router.js';
import { getProvider } from './provider.js';
import { MwaMemory } from './awm.js';
import { listUniqueMessages, googleConfigured } from './connectors/google.js';
import { parseJsonLoose } from './util.js';
import { loadEnv } from './env.js';
import { resolve } from 'node:path';

const EXTRACT_SYSTEM = [
  'You are building a durable knowledge base from a person\'s email.',
  'From the messages below, extract facts worth remembering LONG-TERM: people (name → who they are / role / relationship), recurring topics & projects, commitments, and dates/deadlines.',
  'Skip marketing, receipts, notifications, security alerts, and one-off trivia.',
  'Output ONLY JSON: {"facts":[{"concept":"short title (3-8 words)","content":"the fact, lead with it; include names/dates/specifics"}]}. Return 0 to 10 facts.',
].join('\n');

export interface IngestResult { unique: number; learned: number; }

export async function runIngest(opts: { days?: number; max?: number; dbPath?: string; query?: string; onLog?: (m: string) => void } = {}): Promise<IngestResult> {
  loadEnv();
  const log = opts.onLog ?? ((m: string) => console.log(m));
  if (!googleConfigured()) throw new Error('Gmail is not connected yet — run `mwa connect gmail` first.');

  const days = opts.days ?? 30;
  const query = opts.query ?? `-in:spam -in:trash -in:chats -category:promotions newer_than:${days}d`;
  const dbPath = opts.dbPath ?? process.env.MWA_DB ?? resolve('./data/agent.db');

  log(`Scanning the last ${days} days (skipping spam, trash, promotions)…`);
  const msgs = await listUniqueMessages({
    query, max: opts.max ?? 400,
    onProgress: (scanned, unique) => { if (scanned % 25 === 0) log(`  scanned ${scanned} (${unique} unique so far)…`); },
  });
  log(`Found ${msgs.length} unique messages after collapsing duplicates. Learning from them…`);

  const memory = new MwaMemory('mwa-serve', dbPath);
  memory.setSessionId('ingest');
  const brain = new RoutedProvider(getProvider('brain'), getProvider('high'));

  let learned = 0;
  const BATCH = 12;
  const batches = Math.ceil(msgs.length / BATCH);
  for (let i = 0; i < msgs.length; i += BATCH) {
    const batch = msgs.slice(i, i + BATCH);
    const block = batch.map((m, j) => `${i + j + 1}. ${m.date} | ${m.from} | ${m.subject} | ${m.snippet}`).join('\n');
    try {
      const r = await brain.chat({ system: EXTRACT_SYSTEM, messages: [{ role: 'user', content: `EMAILS:\n${block}\n\nExtract the durable facts now.` }], maxTokens: 900 });
      const parsed = parseJsonLoose<{ facts?: { concept?: string; content?: string }[] }>(r.text);
      for (const f of parsed?.facts ?? []) {
        if (!f?.concept || !f?.content) continue;
        const id = await memory.write(String(f.concept).slice(0, 80), String(f.content), ['topic=world', 'intent=finding', 'confidence_level=observed', 'source=email-ingest'], { canonical: true, eventType: 'observation' });
        if (id) learned++;
      }
      log(`  batch ${Math.floor(i / BATCH) + 1}/${batches} → ${learned} facts learned so far`);
    } catch (e) {
      log(`  batch ${Math.floor(i / BATCH) + 1}/${batches} skipped: ${(e as Error).message.slice(0, 80)}`);
    }
  }

  log('Tidying up memory (consolidation)…');
  try { await memory.consolidate(); } catch { /* */ }
  memory.close();
  log(`Done — ${msgs.length} unique messages, ${learned} durable facts learned.`);
  return { unique: msgs.length, learned };
}
