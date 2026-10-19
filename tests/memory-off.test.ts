/**
 * MWA_MEMORY=off (src/memory-off.ts) — the promise assessment's arm B. A run keeps scheduling, planning
 * and the action log with its tripwire, and loses only what memory knows.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { SchedulesOnlyMemory, KNOWLEDGE_TOOLS } from '../src/memory-off.js';

describe('memory off', () => {
  it('keeps jobs in the real store and nothing else', async () => {
    const { MwaMemory } = await import('../src/awm.js');
    const dir = mkdtempSync(join(tmpdir(), 'mwa-memoff-'));
    const real = new MwaMemory('memoff', join(dir, 'm.db'));
    try {
      const off = new SchedulesOnlyMemory(real);
      expect(off.enabled).toBe(false);
      expect(off.keepsSchedules).toBe(true);
      const id = await off.addScheduledTask('Brief the person on their inbox.', Date.now() + 3_600_000, { recur: 'daily:08:00' });
      expect(id).toBeTruthy();
      expect((await real.pendingScheduled()).map((t) => t.id)).toContain(id);
      expect(await off.write('fact', 'the plumber quoted $240')).toBeNull();
      expect(await off.savePolicy('never message me after 9pm')).toBeNull();
      expect(await off.listPolicies()).toEqual([]);
      expect(await off.recall('plumber')).toEqual([]);
    } finally { real.close(); rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);

  it('a run with memory off still schedules and still pauses unattended at the outward-action limit', async () => {
    const { runAgent } = await import('../src/agent.js');
    const { MwaMemory } = await import('../src/awm.js');
    const { ToolRegistry } = await import('../src/tools/registry.js');
    const dir = mkdtempSync(join(tmpdir(), 'mwa-memoff-run-'));
    const real = new MwaMemory('memoff2', join(dir, 'm.db'));
    const fake = (actions: Record<string, unknown>[]) => { let i = 0; const systems: string[] = []; return { systems, brain: { id: 's', model: 's', price: [0, 0] as [number, number], chat: async (input: any) => {
      if (!String(input.system ?? '').includes('TRUST BOUNDARY')) return { text: '{}', usage: { input: 1, output: 1 } };
      systems.push(String(input.system));
      return { text: JSON.stringify(actions[i++] ?? { action: 'done', summary: 'ok', outcome: 'no-change' }), usage: { input: 1, output: 1 } };
    } } }; };
    const prev = { fast: process.env.MWA_FAST_CHAT, log: process.env.MWA_RUNLOG };
    process.env.MWA_FAST_CHAT = '0'; process.env.MWA_RUNLOG = join(dir, 'runs.jsonl');
    try {
      const s = fake([{ action: 'schedule', instruction: 'Brief the person on their inbox.', daily_at: '08:00' }]);
      const r1 = await runAgent({ instruction: 'brief me daily at 8', userMessage: 'brief me daily at 8', dir, memory: new SchedulesOnlyMemory(real), brain: s.brain, worker: s.brain, interactive: true, plan: false, budget: { maxSteps: 4, maxWallMs: 20_000 } } as any);
      expect(r1.summary).toMatch(/Scheduled for/);
      expect(await real.pendingScheduled()).toHaveLength(1);
      expect(s.systems[0]).toMatch(/MEMORY IS OFF/);

      const tools = new ToolRegistry();
      tools.register({ def: { name: 'post_note', description: 'post', parameters: { type: 'object', properties: { n: { type: 'number' } } } } as any, handler: async () => 'posted' });
      const t = fake([1, 2, 3, 4, 5].map((n) => ({ action: 'post_note', n })));
      const r2 = await runAgent({ instruction: 'post five notes', dir, memory: new SchedulesOnlyMemory(real), brain: t.brain, worker: t.brain, tools, interactive: false, plan: false, budget: { maxSteps: 8, maxWallMs: 20_000 } } as any);
      expect(r2.reason).toBe('paused'); // the tripwire is harness, not memory
      expect(r2.toolCalls).toBe(3);
    } finally {
      for (const [k, v] of [['MWA_FAST_CHAT', prev.fast], ['MWA_RUNLOG', prev.log]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      real.close(); rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('MWA_MEMORY=off drops the memory and preference tools from the registry', () => {
    const names = (off: boolean) => {
      const env = { ...process.env, MWA_DB: join(tmpdir(), `mwa-memoff-reg-${off}-${process.pid}.db`) } as Record<string, string>;
      if (off) env.MWA_MEMORY = 'off'; else delete env.MWA_MEMORY;
      const code = "Promise.all([import('./src/tools/build.ts'), import('./src/config.ts'), import('./src/awm.ts')]).then(async ([b, c, a]) => { const m = new a.MwaMemory('reg', process.env.MWA_DB); const { registry, close } = await b.buildRegistry({ ...c.loadConfig(), tools: { ...c.loadConfig().tools, mcpServers: {} } }, m); console.log('T=' + JSON.stringify(registry.defs().map((d) => d.name))); await close(); m.close(); process.exit(0); })";
      const out = execFileSync(process.execPath, ['--import', 'tsx', '-e', code], { env, encoding: 'utf8', timeout: 90_000 });
      return JSON.parse(/T=(.*)/.exec(out)![1]) as string[];
    };
    const on = names(false), off = names(true);
    for (const k of KNOWLEDGE_TOOLS) { expect(on, k).toContain(k); expect(off, k).not.toContain(k); }
    for (const keep of ['schedule_list', 'schedule_cancel', 'goal_add', 'quiet_hours']) expect(off).toContain(keep);
  }, 180_000);
});
