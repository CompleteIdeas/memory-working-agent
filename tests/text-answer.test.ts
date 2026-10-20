/**
 * BL-57 — a model that answers in plain text has finished. Sam's morning plan, replayed on Claude Haiku 5.5 and
 * Sonnet 5.5 through OpenRouter, gathered everything (it even read the email moving the dentist), wrote the plan as
 * text, and was told to "call exactly ONE tool" until the run ended "no tool calls".
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PLAN = "Today: nothing on the calendar. Thursday: Max's dentist cleaning, moved from Wednesday 3:30 to Thursday 4:00 PM. Pay Ocean State Power $142.37 today.";

const run = async (replies: ({ text: string; tool?: undefined } | { tool: Record<string, unknown>; text?: string })[]) => {
  const { runAgent } = await import('../src/agent.js');
  const { MwaMemory } = await import('../src/awm.js');
  const dir = mkdtempSync(join(tmpdir(), 'mwa-bl57-'));
  const mem = new MwaMemory('bl57', join(dir, 'm.db'));
  let i = 0;
  const brain = { id: 's', model: 's', price: [0, 0] as [number, number], chat: async (input: { system?: string }) => {
    if (!String(input.system ?? '').includes('TRUST BOUNDARY')) return { text: '{}', usage: { input: 1, output: 1 } };
    const r = replies[Math.min(i++, replies.length - 1)];
    return !r.tool
      ? { text: r.text, usage: { input: 1, output: 1 } }
      : { text: r.text ?? '', toolCalls: [{ name: String(r.tool.action), args: Object.fromEntries(Object.entries(r.tool).filter(([k]) => k !== 'action')) }], usage: { input: 1, output: 1 } };
  } };
  const tools = { defs: () => [{ name: 'calendar__list_events', description: 'list', parameters: { type: 'object', properties: {} } }], has: (x: string) => x === 'calendar__list_events', call: async () => 'Wed 2026-11-11 15:30 Max - dentist cleaning' } as never;
  const prev = process.env.MWA_FAST_CHAT; process.env.MWA_FAST_CHAT = '0';
  try {
    return await runAgent({ instruction: 'Create a daily morning plan', dir, memory: mem as never, brain, worker: brain, tools, interactive: false, plan: false, jobId: 'plan1234', jobRecur: 'daily:07:00', budget: { maxSteps: 8, maxWallMs: 20_000 } } as never);
  } finally {
    if (prev === undefined) delete process.env.MWA_FAST_CHAT; else process.env.MWA_FAST_CHAT = prev;
    mem.close(); rmSync(dir, { recursive: true, force: true });
  }
};

describe('a plain-text answer', () => {
  it('given twice in a row is the final answer', async () => {
    const r = await run([{ tool: { action: 'calendar__list_events' } }, { text: PLAN }, { text: PLAN }]);
    expect(r.reason).toBe('done');
    expect(r.summary).toContain('moved from Wednesday 3:30 to Thursday 4:00 PM');
    expect(r.history.join('\n')).toMatch(/a plain-text reply taken as the final answer/);
  }, 60_000);
  it('once, then a tool call, is just a step — the run goes on', async () => {
    const r = await run([{ text: 'Let me look at the calendar first, then the inbox, before I write the plan.' }, { tool: { action: 'calendar__list_events' } }, { tool: { action: 'done', summary: 'Plan sent.' } }]);
    expect(r.history.join('\n')).not.toMatch(/taken as the final answer/);
    expect(r.history.join('\n')).toMatch(/tool calendar__list_events/);
  }, 60_000);
  it('done with an empty or stub summary takes the answer from the reply text', async () => {
    const r = await run([{ tool: { action: 'calendar__list_events' } }, { tool: { action: 'done' }, text: PLAN }]);
    expect(r.summary).toContain('moved from Wednesday 3:30 to Thursday 4:00 PM');
    const s = await run([{ tool: { action: 'calendar__list_events' } }, { tool: { action: 'done', summary: 'Here' }, text: PLAN }]);
    expect(s.summary).toContain('Pay Ocean State Power');
  }, 60_000);
  it('a short or empty reply is not an answer', async () => {
    const r = await run([{ text: 'ok' }, { text: 'ok' }, { text: '' }, { text: 'ok' }, { text: 'ok' }]);
    expect(r.reason).toBe('stuck');
  }, 60_000);
  it('a job run that writes its outcome into the text has that outcome, and the words leave the message (BL-62)', async () => {
    const said = "Tessa Morrow's membership shows **ACTIVE** through November 30, 2027. outcome complete";
    const r = await run([{ tool: { action: 'calendar__list_events' } }, { text: said }, { text: said }]);
    expect(r.outcome).toBe('complete');
    expect(r.summary).not.toMatch(/outcome complete/);
    expect(r.summary).toContain('ACTIVE');
  }, 60_000);
});
