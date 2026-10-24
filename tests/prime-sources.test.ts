/**
 * BL-75 — a primed insight brings the memories it rests on (experience pilot, 2026-10-24: an insight about Claude
 * Haiku was primed at #1 while the memory holding its numbers, 0/16 and 4/16, sat at #16, outside the prime).
 * Reconsolidation links an insight to its sources with `causal` associations; sourcesOf reads them back, live ones only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MwaMemory, NullMemory } from '../src/awm.js';

describe('sourcesOf', () => {
  let dir: string; let mem: MwaMemory;
  let insight: string; let numbers: string; let retired: string; let hebbian: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mwa-sources-'));
    mem = new MwaMemory('sources-test', join(dir, 'a.db'));
    insight = (await mem.write('insight: Claude Haiku 5.5, cost and safety trade-off', 'Haiku is a seventh of the price but failed the safety bar, so it stays off the default.', ['topic=insight'], { canonical: true, eventType: 'causal' }))!;
    numbers = (await mem.write('Claude Haiku 5.5, MWA OpenRouter completion decision', 'Claude Haiku 5.5 scored 0/16 for following planted instructions but 4/16 for repeating planted code words (2026-10-19).', ['topic=models'], { canonical: true }))!;
    retired = (await mem.write('Claude Haiku pricing, old', 'Haiku was $0.08 per million input tokens.', ['topic=models'], { canonical: true }))!;
    hebbian = (await mem.write('Unrelated: the recital is on Friday', 'The spring recital is Friday at 6.', ['topic=family'], { canonical: true }))!;
    const store = (mem as unknown as { store: any }).store;
    store.upsertAssociation(insight, numbers, 0.6, 'causal', 0.7);
    store.upsertAssociation(numbers, insight, 0.6, 'causal', 0.7);
    store.upsertAssociation(insight, retired, 0.9, 'causal', 0.7);
    store.upsertAssociation(insight, hebbian, 0.9, 'hebbian', 0.7); // recalled together once; not a source
    await mem.supersede(retired, 'Claude Haiku pricing', 'Haiku is $0.10 per million input tokens.', ['topic=models']);
  });
  afterAll(() => { mem.close(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

  it('returns the live memories a causal link points at, not hebbian neighbours or superseded ones', async () => {
    const out = await mem.sourcesOf(insight);
    expect(out.map((m) => m.concept)).toEqual(['Claude Haiku 5.5, MWA OpenRouter completion decision']);
    expect(out[0].content).toContain('4/16');
    expect(out[0].id).toBe(numbers);
    expect(out[0].trust).toBeDefined();
  });
  it('is empty for a memory with no links, and for the null memory', async () => {
    expect(await mem.sourcesOf(hebbian)).toEqual([]);
    expect(await new NullMemory().sourcesOf()).toEqual([]);
  });
});
