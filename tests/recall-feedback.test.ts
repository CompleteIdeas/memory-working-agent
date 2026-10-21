import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MwaMemory } from '../src/awm.js';

/**
 * BL-67: a production recall is a real recall. Before, every MwaMemory.recall was internal, so AWM never
 * saw it: no touch (fade clock), no activation log, and nothing in recent recalls for implicit feedback
 * to credit — retrieval_feedback stayed empty on a live install. Benchmarks keep internal:true.
 */
describe('BL-67: recall feeds AWM implicit feedback', () => {
  let dir: string;
  let mem: MwaMemory;
  const store = (): any => (mem as any).store;
  const FACT = 'The Pinecrest boiler service contract number is PX-48213, renewing on 14 March.';

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mwa-bl67-'));
    mem = new MwaMemory('bl67-test', join(dir, 'bl67.db'));
    await mem.write('Pinecrest boiler service contract', FACT, ['topic=household'], { provenance: 'user' });
  });
  afterAll(() => {
    try { mem.close(); } catch { /* */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('an internal recall finds the fact but leaves nothing for feedback to credit', async () => {
    const hits = await mem.recall('boiler service contract number', { limit: 3, full: true, internal: true });
    expect(hits.some((h) => h.content.includes('PX-48213'))).toBe(true);
    expect(await mem.noteUse('Your boiler contract is PX-48213, renewing 14 March.', 'reply')).toBe(0);
  });

  it('a normal recall is credited when the reply uses the fact, and touches the engram', async () => {
    const hits = await mem.recall('boiler service contract number', { limit: 3, full: true });
    const hit = hits.find((h) => h.content.includes('PX-48213'));
    expect(hit).toBeDefined();
    expect(store().getEngram(hit!.id).accessCount).toBeGreaterThan(0);
    expect(await mem.noteUse('Your boiler contract is PX-48213, renewing 14 March.', 'reply')).toBe(1);
  });
});
