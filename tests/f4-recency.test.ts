import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MwaMemory } from '../src/awm.js';

/**
 * F4 (Honest Agent) — the stale-memory recency guard. When the same subject has changed value over
 * time and the agent NEVER explicitly superseded (the common case — it just learned newer info),
 * recall must prefer the FRESH fact, not let an older one that happens to embed well "silently win"
 * (the memweave book-club failure). This is what lets the agent answer "the latest X" honestly.
 *
 * Deterministic: no model calls. Writes compete on recency; we assert the newest ranks at the top.
 */
describe('F4 recency guard: the freshest competing fact wins recall', () => {
  let dir: string;
  let mem: MwaMemory;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'mwa-recency-')); mem = new MwaMemory('recency', join(dir, 'r.db')); });
  afterAll(() => { try { mem.close(); } catch { /* */ } try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

  it('among same-topic facts written over time (no supersede), the newest ranks top of recall', async () => {
    // Three book-club picks, same shape, written oldest → newest. They differ only in month+genre,
    // so query-relevance is ~equal and RECENCY is the tie-breaker. (Distinct enough not to merge.)
    await mem.write('book club pick October', 'In October the book club chose a fantasy novel.', ['topic=bookclub'], { canonical: true, provenance: 'user' });
    await mem.write('book club pick December', 'In December the book club chose a science fiction novel.', ['topic=bookclub'], { canonical: true, provenance: 'user' });
    await mem.write('book club pick March', 'In March the book club chose a mystery novel.', ['topic=bookclub'], { canonical: true, provenance: 'user' });

    const hits = await mem.recall('what did the book club most recently choose', { limit: 3, full: true });
    expect(hits.length).toBeGreaterThan(0);
    // The most-recently-written fact (March / mystery) should be the top hit — recency wins the tie.
    expect(hits[0].content).toContain('March');
    expect(hits[0].content).toContain('mystery');
    // And the stale October fact must NOT outrank the fresh one.
    const marchRank = hits.findIndex((h) => h.content.includes('March'));
    const octRank = hits.findIndex((h) => h.content.includes('October'));
    if (octRank !== -1) expect(marchRank).toBeLessThan(octRank);
  }, 60_000);
});
