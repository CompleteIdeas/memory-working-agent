/**
 * BL-62 — a watch's run that read its source but gave no reading. USEA Jordan rerun: after the status turned Active,
 * every check said "ACTIVE … the watch is complete" with outcome changed and no value, and the scheduler could not see
 * that nothing had moved: six repeat alerts.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = async (script: Record<string, unknown>[], job: Record<string, unknown>) => {
  const { runAgent } = await import('../src/agent.js');
  const { MwaMemory } = await import('../src/awm.js');
  const dir = mkdtempSync(join(tmpdir(), 'mwa-watch-'));
  const mem = new MwaMemory('watch', join(dir, 'm.db'));
  let i = 0;
  const brain = { id: 's', model: 's', price: [0, 0] as [number, number], chat: async (input: { system?: string }) => {
    if (!String(input.system ?? '').includes('TRUST BOUNDARY')) return { text: '{}', usage: { input: 1, output: 1 } };
    const r = script[Math.min(i++, script.length - 1)];
    return { text: '', toolCalls: [{ name: String(r.action), args: Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'action')) }], usage: { input: 1, output: 1 } };
  } };
  const tools = { defs: () => [{ name: 'web__open_page', description: 'o', parameters: { type: 'object', properties: {} } }], has: (x: string) => x === 'web__open_page', call: async () => 'Member 48213 Tessa Morrow — Status: ACTIVE through 2027-11-30' } as never;
  const prev = process.env.MWA_FAST_CHAT; process.env.MWA_FAST_CHAT = '0';
  try {
    return await runAgent({ instruction: 'Check https://members.useventing.example/status/48213 and tell me when Tessa Morrow is Active', dir, memory: mem as never, brain, worker: brain, tools, interactive: false, plan: false, jobId: 'watch123', jobRecur: 'daily:09:00', budget: { maxSteps: 8, maxWallMs: 20_000 }, ...job } as never);
  } finally {
    if (prev === undefined) delete process.env.MWA_FAST_CHAT; else process.env.MWA_FAST_CHAT = prev;
    mem.close(); rmSync(dir, { recursive: true, force: true });
  }
};
const SUMMARY = 'Tessa Morrow’s membership shows ACTIVE through November 30, 2027.';

describe('a watch gives its reading', () => {
  it('asked once when it read the source and gave none; then the reading is kept', async () => {
    const r = await run([
      { action: 'web__open_page', url: 'https://members.useventing.example/status/48213' },
      { action: 'done', summary: SUMMARY, outcome: 'changed' },
      { action: 'done', summary: SUMMARY, outcome: 'complete', value: 'ACTIVE through 2027-11-30' },
    ], { jobDeliver: 'changed', jobUntil: 'her membership shows Active' });
    expect(r.history.join('\n')).toMatch(/a watch finished without its reading/);
    expect(r.watchValue).toBe('ACTIVE through 2027-11-30');
    expect(r.outcome).toBe('complete');
  }, 60_000);
  it('not asked of a report job, or of a run that could not read', async () => {
    const report = await run([{ action: 'web__open_page', url: 'https://x.example' }, { action: 'done', summary: 'Here is your brief.', outcome: 'changed' }], { jobDeliver: 'always', jobTask: 'Send me a morning brief of what came in' });
    expect(report.history.join('\n')).not.toMatch(/without its reading/);
    const failed = await run([{ action: 'web__open_page', url: 'https://x.example' }, { action: 'done', summary: 'The page would not load.', outcome: 'could-not' }], { jobDeliver: 'changed' });
    expect(failed.history.join('\n')).not.toMatch(/without its reading/);
  }, 60_000);
});
