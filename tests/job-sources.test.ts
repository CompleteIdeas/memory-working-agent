/**
 * BL-49 — a scheduled brief reads its sources every time. Measured in BL-40: with memory on, Sam's morning
 * plan searched email on 4 of 14 mornings (12 of 14 with memory off), so the failed-autopay email was never
 * mentioned; Maya's price watch answered 4 of 15 checks without opening the page.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unreadSources } from '../src/schedule-request.js';
import { jobContext } from '../src/agent.js';

const TOOLS = ['gmail__search_email', 'gmail__read_email', 'calendar__list_events', 'web__open_page'];
const SAM_PLAN = 'Check today\'s calendar appointments, bills due this week, and anything related to the kids\' school. Keep it to 5 bullets.';

describe('which sources a job depends on', () => {
  it('a plan that never says "email" still lives in the inbox (bills, school)', () => {
    expect(unreadSources(SAM_PLAN, TOOLS, new Set(['calendar__list_events']))).toEqual(['email']);
    expect(unreadSources(SAM_PLAN, TOOLS, new Set())).toEqual(['email', 'the calendar']);
    expect(unreadSources(SAM_PLAN, TOOLS, new Set(['calendar__list_events', 'gmail__search_email']))).toEqual([]);
  });

  it('a watch on a link needs the page opened', () => {
    const watch = 'Check the standard rose price at https://bloomfield-wholesale.example/prices';
    expect(unreadSources(watch, TOOLS, new Set(['recall']))).toEqual(['the page it watches']);
    expect(unreadSources(watch, TOOLS, new Set(['web__open_page']))).toEqual([]);
  });

  it('only sources a connected tool can read, and nothing for a job that reads none', () => {
    expect(unreadSources(SAM_PLAN, ['calendar__list_events'], new Set(['calendar__list_events']))).toEqual([]);
    expect(unreadSources('Write note-2.txt saying check 2 ran', TOOLS, new Set())).toEqual([]);
  });

  it('every fire is told to read its sources fresh and to date items against NOW', () => {
    const text = jobContext({ jobId: 'j1' }, Date.now(), (_l, t) => t).join('\n');
    expect(text).toMatch(/read its sources again on every run/);
    expect(text).toMatch(/today, tomorrow, in N days, or overdue/);
  });
});

describe('a fire that skipped its inbox is sent back once', () => {
  const run = async (actions: Record<string, unknown>[], extra: Record<string, unknown> = {}) => {
    const { runAgent } = await import('../src/agent.js');
    const dir = mkdtempSync(join(tmpdir(), 'mwa-bl49-'));
    let i = 0; const prompts: string[] = [];
    const brain = { id: 's', model: 's', price: [0, 0] as [number, number], chat: async (input: any) => {
      if (!String(input.system ?? '').includes('TRUST BOUNDARY')) return { text: '{}', usage: { input: 1, output: 1 } };
      prompts.push(String(input.messages?.[0]?.content ?? ''));
      return { text: JSON.stringify(actions[Math.min(i++, actions.length - 1)]), usage: { input: 1, output: 1 } };
    } };
    const tools = { defs: () => TOOLS.map((name) => ({ name, description: name, parameters: { type: 'object', properties: {} } })), has: (n: string) => TOOLS.includes(n), call: async (n: string) => `${n}: ok` };
    const prev = process.env.MWA_FAST_CHAT; process.env.MWA_FAST_CHAT = '0';
    try {
      const r = await runAgent({ instruction: SAM_PLAN, dir, memory: { enabled: false, async recall() { return []; }, async listPolicies() { return []; }, setSessionId() { /* */ }, async addScheduledTask() { return null; }, async logAction() { return null; } } as any, brain, worker: brain, interactive: false, plan: false, tools: tools as any, jobId: 'plan1234', dueNow: true, budget: { maxSteps: 8, maxWallMs: 20_000 }, ...extra } as any);
      return { r, prompts };
    } finally {
      if (prev === undefined) delete process.env.MWA_FAST_CHAT; else process.env.MWA_FAST_CHAT = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const DONE = { action: 'done', summary: '- No appointments today.\n- No bills found.', outcome: 'changed' };

  it('calendar only, then done: pushed to read email; reading it lets the run finish', async () => {
    const { r, prompts } = await run([{ action: 'calendar__list_events' }, DONE, { action: 'gmail__search_email' }, DONE]);
    expect(r.history.join('\n')).toMatch(/job sources not read: email — asked to read them/);
    expect(prompts.some((p) => /This job depends on email, and this run has not read it/.test(p))).toBe(true);
    expect(r.reason).toBe('done');
  }, 30_000);

  it('once only: a run that still will not read it is let finish', async () => {
    const { r } = await run([{ action: 'calendar__list_events' }, DONE, DONE]);
    expect(r.history.filter((h) => /job sources not read/.test(h))).toHaveLength(1);
    expect(r.reason).toBe('done');
  }, 30_000);

  it('a fire looping on the same read is pushed too, before the repeat ends it (BL-53 pilot)', async () => {
    const { r } = await run([{ action: 'calendar__list_events' }, { action: 'calendar__list_events' }, { action: 'calendar__list_events' }, { action: 'gmail__search_email' }, DONE]);
    expect(r.history.join('\n')).toMatch(/skipped redundant calendar__list_events[\s\S]*job sources not read: email/);
    expect(r.reason).toBe('done');
  }, 30_000);

  it('a chat run is never pushed', async () => {
    const { r } = await run([{ action: 'calendar__list_events' }, DONE], { jobId: undefined, dueNow: false, interactive: true });
    expect(r.history.join('\n')).not.toMatch(/job sources not read/);
  }, 30_000);
});
