/**
 * BL-09 — MWA_HIST_WINDOW overrides the history window (default 12), clamped to 4..200, for measuring
 * the no-compaction bet. It is read when the agent module loads, so each case runs in its own process.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';

const windowWith = (value: string | undefined): number => {
  const env = { ...process.env };
  if (value === undefined) delete env.MWA_HIST_WINDOW; else env.MWA_HIST_WINDOW = value;
  const out = execFileSync(process.execPath, ['--import', 'tsx', '-e', "import('./src/agent.ts').then((m) => { console.log('W=' + m.HIST_WINDOW); process.exit(0); })"], { env, encoding: 'utf8', timeout: 60_000 });
  return Number(/W=(\d+)/.exec(out)?.[1]);
};

describe('the history window', () => {
  it('defaults to 12, takes MWA_HIST_WINDOW, and is clamped to 4..200; junk falls back to 12', () => {
    expect(windowWith(undefined)).toBe(12);
    expect(windowWith('30')).toBe(30);
    expect(windowWith('1')).toBe(4);
    expect(windowWith('5000')).toBe(200);
    expect(windowWith('lots')).toBe(12);
  }, 120_000);
});

describe('a run without memory is not offered memory tools (BL-09 review)', () => {
  it('no remember, recall or supersede, and no "recall it" hint, when memory is off; all present when on', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { runAgent } = await import('../src/agent.js');
    const { MwaMemory, NullMemory } = await import('../src/awm.js');
    const offered = async (memOn: boolean) => {
      const dir = mkdtempSync(join(tmpdir(), 'mwa-nomem-'));
      const mem = memOn ? new MwaMemory('nomem-test', join(dir, 'm.db')) : new NullMemory();
      const seen: { tools: string[]; prompt: string; system: string }[] = [];
      let n = 0;
      const brain = { id: 's', model: 's', price: [0, 0] as [number, number], chat: async (input: any) => {
        if (!String(input.system ?? '').includes('TRUST BOUNDARY')) return { text: '{}', usage: { input: 1, output: 1 } };
        seen.push({ tools: (input.tools ?? []).map((t: any) => t.name), prompt: String(input.messages?.[0]?.content ?? ''), system: String(input.system ?? '') });
        return { text: JSON.stringify(n++ < 1 ? { action: 'list_files' } : { action: 'done', summary: 'ok', outcome: 'no-change' }), usage: { input: 1, output: 1 } };
      } };
      const prev = process.env.MWA_FAST_CHAT; process.env.MWA_FAST_CHAT = '0';
      try { await runAgent({ instruction: 'look around', dir, memory: mem as any, brain, worker: brain, interactive: false, plan: false, budget: { maxSteps: 4, maxWallMs: 20_000 } } as any); }
      finally { if (prev === undefined) delete process.env.MWA_FAST_CHAT; else process.env.MWA_FAST_CHAT = prev; mem.close(); rmSync(dir, { recursive: true, force: true }); }
      return seen;
    };
    const off = await offered(false);
    expect(off[0].tools).not.toContain('remember');
    expect(off[0].tools).not.toContain('recall');
    expect(off[0].tools).not.toContain('supersede');
    expect(off.map((s) => s.prompt).join(' ')).not.toMatch(/recall it if needed/);
    expect(off[0].system).toMatch(/MEMORY IS OFF in this run/);
    const on = await offered(true);
    expect(on[0].tools).toEqual(expect.arrayContaining(['remember', 'recall', 'supersede']));
    expect(on[0].system).not.toMatch(/MEMORY IS OFF/);
  }, 60_000);
});
