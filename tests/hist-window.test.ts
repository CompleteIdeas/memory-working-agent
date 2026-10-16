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

describe('the experiment-only compaction hook (BL-30)', () => {
  it('folds all but the last window of history once it passes twice the window, and shows the block above RECENT STEPS', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { runAgent, HIST_WINDOW } = await import('../src/agent.js');
    const { NullMemory } = await import('../src/awm.js');
    const { ToolRegistry } = await import('../src/tools/registry.js');
    const tools = new ToolRegistry();
    // Ten names, so no one tool passes the 5-uses no-progress rule.
    for (let i = 0; i < 10; i++) tools.register({ def: { name: `tick${i}`, description: 'count', parameters: { type: 'object', properties: { n: { type: 'number' } } } } as any, handler: async (a) => `TICK-RESULT-${a.n}` });
    const dir = mkdtempSync(join(tmpdir(), 'mwa-compact-'));
    const folds: string[][] = [];
    const prompts: string[] = [];
    let n = 0;
    const brain = { id: 's', model: 's', price: [0, 0] as [number, number], chat: async (input: any) => {
      if (!String(input.system ?? '').includes('TRUST BOUNDARY')) return { text: '{}', usage: { input: 1, output: 1 } };
      prompts.push(String(input.messages?.[0]?.content ?? ''));
      n++;
      return { text: JSON.stringify(n <= 40 ? { action: `tick${n % 10}`, n } : { action: 'done', summary: 'ok', outcome: 'no-change' }), usage: { input: 1, output: 1 } };
    } };
    const prev = process.env.MWA_FAST_CHAT; process.env.MWA_FAST_CHAT = '0';
    try {
      await runAgent({ instruction: 'count', dir, memory: new NullMemory() as any, brain, worker: brain, tools, interactive: false, plan: false, budget: { maxSteps: 45, maxWallMs: 30_000 },
        compaction: { fold: async (lines: string[]) => { folds.push(lines); }, block: () => (folds.length ? `SUMMARY-BLOCK-${folds.length}` : '') } } as any);
    } finally { if (prev === undefined) delete process.env.MWA_FAST_CHAT; else process.env.MWA_FAST_CHAT = prev; rmSync(dir, { recursive: true, force: true }); }

    expect(folds.length).toBeGreaterThanOrEqual(1);
    // The first fold starts at the very first line and hands over everything but the last window.
    expect(folds[0].join('\n')).toMatch(/TICK-RESULT-1\b/);
    expect(new Set(folds.flat()).size).toBe(folds.flat().length); // no line is folded twice
    expect(prompts[1]).toMatch(/older steps are not kept/); // before the first fold, nothing is summarized yet
    const after = prompts.find((p) => p.includes('SUMMARY-BLOCK-1'))!;
    expect(after).toBeDefined();
    expect(after.indexOf('SUMMARY-BLOCK-1')).toBeLessThan(after.indexOf('RECENT STEPS'));
    expect(after).toMatch(/older steps are summarized above\)/);
    const recent = after.slice(after.indexOf('RECENT STEPS'));
    expect(recent).not.toMatch(/TICK-RESULT-1\b/); // folded lines leave the prompt
    for (const p of prompts) {
      const r = p.slice(Math.max(0, p.indexOf('RECENT STEPS')));
      expect((r.match(/TICK-RESULT-\d+/g) ?? []).length).toBeLessThanOrEqual(2 * HIST_WINDOW + 1);
    }
  }, 60_000);
});

describe('the 5-uses no-progress rule (BL-30)', () => {
  const runWith = async (toolName: string, calls: number) => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { runAgent } = await import('../src/agent.js');
    const { NullMemory } = await import('../src/awm.js');
    const { ToolRegistry } = await import('../src/tools/registry.js');
    const tools = new ToolRegistry();
    tools.register({ def: { name: toolName, description: 'x', parameters: { type: 'object', properties: { path: { type: 'string' } } } } as any, handler: async (a) => `contents of ${a.path}` });
    const dir = mkdtempSync(join(tmpdir(), 'mwa-uses-'));
    const prompts: string[] = [];
    let n = 0;
    const brain = { id: 's', model: 's', price: [0, 0] as [number, number], chat: async (input: any) => {
      if (!String(input.system ?? '').includes('TRUST BOUNDARY')) return { text: '{}', usage: { input: 1, output: 1 } };
      prompts.push(String(input.messages?.[0]?.content ?? ''));
      n++;
      return { text: JSON.stringify(n <= calls ? { action: toolName, path: `file-${n}.txt` } : { action: 'done', summary: 'ok', outcome: 'no-change' }), usage: { input: 1, output: 1 } };
    } };
    const prev = process.env.MWA_FAST_CHAT; process.env.MWA_FAST_CHAT = '0';
    try {
      const r = await runAgent({ instruction: 'go through the files', dir, memory: new NullMemory() as any, brain, worker: brain, tools, interactive: false, plan: false, budget: { maxSteps: 30, maxWallMs: 30_000 } } as any);
      return { reason: String(r.reason), prompts };
    } finally { if (prev === undefined) delete process.env.MWA_FAST_CHAT; else process.env.MWA_FAST_CHAT = prev; rmSync(dir, { recursive: true, force: true }); }
  };

  it('reading twelve different files is not "stuck", and gets no stop nudge', async () => {
    const { reason, prompts } = await runWith('read_file', 12);
    expect(reason).not.toBe('stuck');
    expect(prompts.length).toBeGreaterThan(12); // all twelve reads happened, then done
    expect(prompts.join('\n')).not.toMatch(/You've used "read_file"/);
  }, 60_000);

  it('any other tool still gets the stop nudge from its fifth use, and twelve calls end the run as stuck', async () => {
    const { reason, prompts } = await runWith('web_search', 12);
    expect(prompts.join('\n')).toMatch(/You've used "web_search" 5 times/);
    expect(reason).toBe('stuck');
  }, 60_000);
});
