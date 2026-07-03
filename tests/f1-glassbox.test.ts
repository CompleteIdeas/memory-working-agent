import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MwaMemory } from '../src/awm.js';

/**
 * F1 Glass Box — the transparency surface the UI renders: every fact shows where it came from
 * + how trusted it is, you can forget it, and you can export everything as portable Markdown.
 */
describe('F1 Glass Box: memory transparency surface', () => {
  let dir: string;
  let mem: MwaMemory;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'mwa-f1-')); mem = new MwaMemory('f1-test', join(dir, 'f1.db')); });
  afterAll(() => { try { mem.close(); } catch { /* */ } try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

  it('recentMemories surfaces provenance, trust, and origin per fact', async () => {
    await mem.write('user pref', 'sign emails as Rob', ['topic=t'], { canonical: true, provenance: 'user' });
    await mem.write('inbox claim', 'meeting moved to Friday', ['topic=t'], { canonical: true, provenance: 'ingested', origin: 'email/jane@x.test' });
    const mems = await mem.recentMemories(50);
    const u = mems.find((m) => m.concept === 'user pref');
    const e = mems.find((m) => m.concept === 'inbox claim');
    expect(u?.trust).toBe('high'); expect(u?.provenance).toBe('user');
    expect(e?.trust).toBe('untrusted'); expect(e?.provenance).toBe('ingested'); expect(e?.origin).toBe('email/jane@x.test');
  }, 60_000);

  it('exportMarkdown produces portable, provenance-annotated Markdown', async () => {
    const md = await mem.exportMarkdown();
    expect(md).toContain('# What MWA knows about you');
    expect(md).toContain('## Learned facts');
    expect(md).toContain('sign emails as Rob');
    expect(md).toContain('you told me');
    expect(md).toContain('from email/jane@x.test');
    expect(md).toMatch(/trust: (high|untrusted)/);
  });

  it('correctFact replaces a fact deterministically — old gone, corrected version trusted', async () => {
    const before = (await mem.recentMemories(50)).find((m) => m.concept === 'inbox claim')!;
    expect(before).toBeDefined();
    expect(before.trust).toBe('untrusted'); // started as an inbox-mined claim
    await mem.correctFact(before.id, 'inbox claim', 'meeting moved to MONDAY (corrected by user)');
    const after = await mem.recentMemories(50);
    expect(after.some((m) => m.id === before.id)).toBe(false); // stale original removed
    const fixed = after.find((m) => m.content.includes('MONDAY'));
    expect(fixed).toBeDefined();
    expect(fixed!.trust).toBe('high'); // a user correction is authoritative
  }, 60_000);

  it('correctFact refuses a non-existent id — no high-trust memory minted from a forged/blind id', async () => {
    const before = (await mem.recentMemories(200)).length;
    const r = await mem.correctFact('totally-made-up-id-xyz', 'attacker concept', 'attacker-controlled content');
    expect(r).toBeNull();
    expect((await mem.recentMemories(200)).length).toBe(before); // nothing created
  }, 60_000);

  it('forget removes a fact from the transparency surface (privacy)', async () => {
    const target = (await mem.recentMemories(50)).find((m) => m.concept === 'user pref')!;
    expect(await mem.forget(target.id)).toBe(true);
    expect((await mem.recentMemories(50)).some((m) => m.id === target.id)).toBe(false);
  });
});
