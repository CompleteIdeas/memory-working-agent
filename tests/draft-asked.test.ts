/**
 * BL-62 — two misses from the USEA Casey run: "Draft a quick note to Carter…" got the note in the reply and nothing
 * in Drafts (D1), and schedule_update refused a new brief instruction seven times because the model also sent
 * every_minutes: 0 (the Officials heading, R5–R6).
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asksForDraft, withoutEmptyArgs } from '../src/agent.js';

describe('a request for a draft', () => {
  it('is read from the person\'s words', () => {
    for (const m of ['Draft a quick note to Carter at Riverbend: final results are due by Sunday, Nov 8.', 'Please draft a reply to the Nguyens with the package', 'draft an email to Records about the USEF ID'])
      expect([m, asksForDraft(m)]).toEqual([m, true]);
    for (const m of ['What did I quote the Nguyens?', "Don't draft anything, just tell me", 'Is the draft agenda ready?'])
      expect([m, asksForDraft(m)]).toEqual([m, false]);
  });
  it('a zero interval is "not given" for every tool, not only schedule', () => {
    expect(withoutEmptyArgs({ action: 'schedule_update', id: 'ab12cd', instruction: 'Morning brief with an Officials heading', daily_at: '', days: '', every_minutes: 0, at: '' }))
      .toEqual({ action: 'schedule_update', id: 'ab12cd', instruction: 'Morning brief with an Officials heading' });
  });
});

describe('a draft asked for and not made', () => {
  const run = async (replies: ({ text: string; tool?: undefined } | { tool: Record<string, unknown>; text?: string })[]) => {
    const { runAgent } = await import('../src/agent.js');
    const { MwaMemory } = await import('../src/awm.js');
    const dir = mkdtempSync(join(tmpdir(), 'mwa-draft-'));
    const mem = new MwaMemory('draft', join(dir, 'm.db'));
    let i = 0; const called: string[] = [];
    const brain = { id: 's', model: 's', price: [0, 0] as [number, number], chat: async (input: { system?: string }) => {
      if (!String(input.system ?? '').includes('TRUST BOUNDARY')) return { text: '{}', usage: { input: 1, output: 1 } };
      const r = replies[Math.min(i++, replies.length - 1)];
      return !r.tool ? { text: r.text, usage: { input: 1, output: 1 } }
        : { text: r.text ?? '', toolCalls: [{ name: String(r.tool.action), args: Object.fromEntries(Object.entries(r.tool).filter(([k]) => k !== 'action')) }], usage: { input: 1, output: 1 } };
    } };
    const defs = [{ name: 'gmail__search_email', description: 's', parameters: { type: 'object', properties: {} } }, { name: 'gmail__draft_email', description: 'd', parameters: { type: 'object', properties: {} } }];
    const tools = { defs: () => defs, has: (x: string) => defs.some((d) => d.name === x), call: async (n: string) => { called.push(n); return n.endsWith('search_email') ? 'From: Carter Lowe <carter@riverbendeventing.example> Subject: Riverbend results' : 'Draft saved.'; } } as never;
    const prev = process.env.MWA_FAST_CHAT; process.env.MWA_FAST_CHAT = '0';
    try {
      const msg = 'Draft a quick note to Carter at Riverbend: final results are due by Sunday, Nov 8.';
      const r = await runAgent({ instruction: msg, userMessage: msg, dir, memory: mem as never, brain, worker: brain, tools, interactive: true, plan: false, budget: { maxSteps: 8, maxWallMs: 20_000 } } as never);
      return { r, called };
    } finally {
      if (prev === undefined) delete process.env.MWA_FAST_CHAT; else process.env.MWA_FAST_CHAT = prev;
      mem.close(); rmSync(dir, { recursive: true, force: true });
    }
  };
  const NOTE = 'Hi Carter, final results for Riverbend are due Sunday, Nov 8 — 7 days after the event. Thanks!';

  it('is asked for once; made, it ends normally', async () => {
    const { r, called } = await run([
      { tool: { action: 'gmail__search_email', query: 'Carter Riverbend' } },
      { tool: { action: 'done', summary: NOTE, outcome: 'changed' } },
      { tool: { action: 'gmail__draft_email', to: 'carter@riverbendeventing.example', subject: 'Riverbend results due Nov 8', body: NOTE } },
      { tool: { action: 'done', summary: 'The note to Carter is in your Drafts.', outcome: 'changed' } },
    ]);
    expect(r.history.join('\n')).toMatch(/a draft was asked for and none was made/);
    expect(called).toContain('gmail__draft_email');
    expect(r.summary).toMatch(/in your Drafts/);
  }, 60_000);
});
