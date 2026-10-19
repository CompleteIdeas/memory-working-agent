/**
 * BL-41 — an MCP tool its server declares read-only (and not destructive) is classed a read, not an
 * outward action. Every MCP read used to count against an unattended run's three outward actions, so a
 * scheduled job reading mail through an MCP connector paused after three reads.
 */
import { describe, it, expect } from 'vitest';
import { resolve, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadMcpServers } from '../src/tools/mcp.js';
import { classifyTool, effectOf, markMcpReadOnly, readsUntrustedContent } from '../src/tools/governance.js';

describe('MCP read-only hints', () => {
  it('honors readOnlyHint only for the server’s own tools, never when destructive, never for a name MWA classifies', async () => {
    const h = await loadMcpServers({ hint: { command: process.execPath, args: [resolve('tests/fixtures/hint-mcp-server.mjs')] } });
    try {
      expect(h.tools.map((t) => t.def.name).sort()).toEqual(['hint__look', 'hint__poke', 'hint__read_file', 'hint__zap']);
      expect(classifyTool('hint__look')).toBe('read');
      expect(effectOf('hint__look')).toBe('read');
      expect(readsUntrustedContent('hint__look')).toBe(true); // still outside content: still fenced, still taints
      expect(classifyTool('hint__poke')).toBe('external');
      expect(classifyTool('hint__zap')).toBe('external');
      expect(classifyTool('hint__read_file')).toBe('read'); // its own namespaced name…
      expect(classifyTool('read_file')).toBe('read'); // …while MWA's read_file is MWA's own entry, untouched
    } finally { await h.close(); }
    expect(markMcpReadOnly('write_file')).toBe(false); // a built-in name is never reclassified
    expect(classifyTool('write_file')).not.toBe('read');
    expect(markMcpReadOnly('no_namespace')).toBe(false);
  }, 30_000);

  it('an unattended run reads through a read-only MCP tool more than three times without pausing', async () => {
    const { runAgent } = await import('../src/agent.js');
    const { NullMemory } = await import('../src/awm.js');
    const { ToolRegistry } = await import('../src/tools/registry.js');
    const h = await loadMcpServers({ hint: { command: process.execPath, args: [resolve('tests/fixtures/hint-mcp-server.mjs')] } });
    const dir = mkdtempSync(join(tmpdir(), 'mwa-bl41-'));
    const registry = new ToolRegistry();
    registry.registerAll(h.tools);
    const plan = [1, 2, 3, 4, 5].map((n) => ({ action: n % 2 ? 'hint__look' : 'hint__read_file', n }));
    let i = 0;
    const brain = { id: 's', model: 's', price: [0, 0] as [number, number], chat: async (input: any) => {
      if (!String(input.system ?? '').includes('TRUST BOUNDARY')) return { text: '{}', usage: { input: 1, output: 1 } };
      return { text: JSON.stringify(plan[i++] ?? { action: 'done', summary: 'read five things', outcome: 'no-change' }), usage: { input: 1, output: 1 } };
    } };
    const prev = { fast: process.env.MWA_FAST_CHAT, log: process.env.MWA_RUNLOG };
    process.env.MWA_FAST_CHAT = '0'; process.env.MWA_RUNLOG = join(dir, 'runs.jsonl');
    try {
      const r = await runAgent({ instruction: 'read five things', dir, memory: new NullMemory() as any, brain, worker: brain, tools: registry, interactive: false, plan: false, budget: { maxSteps: 10, maxWallMs: 20_000 } } as any);
      expect(r.reason).not.toBe('paused');
      expect(r.toolCalls).toBe(5);
    } finally {
      for (const [k, v] of [['MWA_FAST_CHAT', prev.fast], ['MWA_RUNLOG', prev.log]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      await h.close(); rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
