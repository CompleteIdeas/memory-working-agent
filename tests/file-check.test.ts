/**
 * A summary that calls the work incomplete is checked against the files the run wrote (interface slice replay
 * 2026-10-26, F12): a background briefing's chat summary said "no verified BBC headlines, so the comparison may be
 * incomplete" while the file it linked had a full BBC section. The done step now sends the model back once to read
 * what it wrote before reporting on it.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const memoryOff = { enabled: false, async recall() { return []; }, async listPolicies() { return []; }, setSessionId() { /* */ }, async addScheduledTask() { return null; }, async logAction() { return null; } };
const HEDGE = 'I wrote headline-briefing.md. The recorded results include NPR headlines but no verified BBC headlines, so the comparison may be incomplete.';
const HONEST = 'headline-briefing.md compares three NPR and three BBC headlines; both sections are complete.';

const scripted = (actions: Record<string, unknown>[]) => {
  let i = 0; const steps: string[] = [];
  const p = { id: 's', model: 's', price: [0, 0] as [number, number], chat: async (input: { system?: string; messages?: { content: string }[] }) => {
    if (!String(input.system ?? '').includes('TRUST BOUNDARY')) return { text: '{}', usage: { input: 1, output: 1 } };
    steps.push(String(input.messages?.[0]?.content ?? ''));
    return { text: JSON.stringify(actions[Math.min(i++, actions.length - 1)]), usage: { input: 1, output: 1 } };
  } };
  return { p, steps };
};

describe('the file check at done', () => {
  it('sends a hedging summary back once to read the file it wrote, then accepts the honest one', async () => {
    const { runAgent } = await import('../src/agent.js');
    const dir = mkdtempSync(join(tmpdir(), 'mwa-filecheck-'));
    vi.stubEnv('MWA_FAST_CHAT', '0');
    const written: string[] = [];
    const tools = { defs: () => ['write_file', 'read_file'].map((name) => ({ name, description: name, parameters: { type: 'object', properties: {} } })), has: (x: string) => x === 'write_file' || x === 'read_file',
      callDetailed: async (name: string, args: Record<string, unknown>) => { if (name === 'write_file') { written.push(String(args.path)); return { text: `wrote ${args.path}`, failed: false }; } return { text: '# Briefing\n## NPR\n- a\n## BBC\n- b', failed: false }; }, call: async () => 'ok' } as never;
    const b = scripted([
      { action: 'write_file', path: 'headline-briefing.md', content: '# Briefing' },
      { action: 'done', summary: HEDGE, outcome: 'changed' },
      { action: 'read_file', path: 'headline-briefing.md' },
      { action: 'done', summary: HONEST, outcome: 'changed' },
    ]);
    try {
      const r = await runAgent({ instruction: 'Compare the NPR and BBC headlines and write me a briefing file', dir, memory: memoryOff as never, brain: b.p as never, worker: b.p as never, tools, interactive: true, plan: false, budget: { maxSteps: 8, maxWallMs: 30_000 } } as never);
      expect(r.reason).toBe('done');
      expect(r.summary).toBe(HONEST);
      expect(r.history.join('\n')).toMatch(/file check: the summary calls the work incomplete; asked once to read headline-briefing\.md first/);
      expect(b.steps.some((s) => /Before finishing: this run wrote headline-briefing\.md/.test(s))).toBe(true);
      expect(written).toEqual(['headline-briefing.md']);
    } finally { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);

  it('a summary with no hedge is not sent back', async () => {
    const { runAgent } = await import('../src/agent.js');
    const dir = mkdtempSync(join(tmpdir(), 'mwa-filecheck2-'));
    vi.stubEnv('MWA_FAST_CHAT', '0');
    const tools = { defs: () => [{ name: 'write_file', description: 'x', parameters: { type: 'object', properties: {} } }], has: (x: string) => x === 'write_file', callDetailed: async (_n: string, args: Record<string, unknown>) => ({ text: `wrote ${args.path}`, failed: false }), call: async () => 'ok' } as never;
    const b = scripted([{ action: 'write_file', path: 'briefing.md', content: '# B' }, { action: 'done', summary: HONEST, outcome: 'changed' }]);
    try {
      const r = await runAgent({ instruction: 'Write me a briefing file', dir, memory: memoryOff as never, brain: b.p as never, worker: b.p as never, tools, interactive: true, plan: false, budget: { maxSteps: 6, maxWallMs: 30_000 } } as never);
      expect(r.summary).toBe(HONEST);
      expect(r.history.join('\n')).not.toMatch(/file check/);
      void readFileSync;
    } finally { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);
});
