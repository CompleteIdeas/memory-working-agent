/**
 * Live runs (usability review 2026-10-24, F06 Stop and stages, F08 a message during a run, F09 a reload).
 * The server keeps one live run per conversation with an id, an abort handle, a ring of events and an inbox; the
 * agent stops at its next step when asked, reads the inbox at the top of each step, and names each tool step; the
 * conversation log keeps a `running` turn until the finished one retires it.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiveRuns, FINAL_EVENTS } from '../src/live-runs.js';
import { runAgent } from '../src/agent.js';
import { appendTurn, readConversation } from '../src/conversations.js';

describe('the registry', () => {
  it('one run per conversation; events are kept and replayed to a late reader; stop and steer reach the run; finish forgets it', () => {
    const live = new LiveRuns();
    const r = live.start('web-a', 'write the brief', 1000);
    expect(() => live.start('web-a', 'again')).toThrow(/already live/);
    expect(live.describe('web-a')).toMatchObject({ runId: r.runId, message: 'write the brief', startedAt: 1000, stopping: false });
    const early: string[] = [];
    const off = live.attach('web-a', (e) => early.push(e.type))!;
    live.record('web-a', 'step', { n: 1, tool: 'read_file', detail: 'notes.md' });
    live.record('web-a', 'step', { n: 2, tool: 'search_files', detail: 'dock' });
    expect(live.describe('web-a')?.stage).toMatchObject({ n: 2, tool: 'search_files' });
    const late: string[] = [];
    live.attach('web-a', (e) => late.push(e.type));
    expect(late).toEqual(['step', 'step']); // replayed
    expect(live.steer('web-a', 'make it shorter')).toBe(true);
    expect(live.takeInbox('web-a')).toEqual(['make it shorter']);
    expect(live.takeInbox('web-a')).toEqual([]);
    expect(live.stop('web-a')).toBe(true);
    expect(r.controller.signal.aborted).toBe(true);
    expect(live.describe('web-a')?.stopping).toBe(true);
    off();
    live.record('web-a', 'result', { reason: 'stopped' });
    expect(early).toEqual(['step', 'step', 'steer', 'stopping']); // detached before the result
    expect(late).toEqual(['step', 'step', 'steer', 'stopping', 'result']);
    expect(FINAL_EVENTS.has('result')).toBe(true);
    live.finish('web-a');
    expect(live.describe('web-a')).toBeNull();
    expect(live.attach('web-a', () => { /* */ })).toBeNull();
    expect(live.stop('web-b')).toBe(false);
    expect(live.steer('web-b', 'x')).toBe(false);
  });
  it('a reader whose socket is gone is dropped, not fatal', () => {
    const live = new LiveRuns();
    live.start('web-a', 'x');
    live.attach('web-a', () => { throw new Error('closed'); });
    const ok: string[] = [];
    live.attach('web-a', (e) => ok.push(e.type));
    live.record('web-a', 'step', {});
    live.record('web-a', 'step', {});
    expect(ok).toEqual(['step', 'step']);
  });
});

const memoryOff = { enabled: false, async recall() { return []; }, async listPolicies() { return []; }, setSessionId() { /* */ }, async addScheduledTask() { return null; }, async logAction() { return null; } };
const tools = (answer = 'ok') => ({ defs: () => [{ name: 'write_file', description: 'w', parameters: { type: 'object', properties: {} } }, { name: 'read_file', description: 'r', parameters: { type: 'object', properties: {} } }], has: (x: string) => x === 'write_file' || x === 'read_file', callDetailed: async () => ({ text: answer, failed: false }), call: async () => answer }) as never;

describe('in the agent', () => {
  const withDir = async <T>(fn: (dir: string) => Promise<T>) => {
    const dir = mkdtempSync(join(tmpdir(), 'mwa-live-'));
    const prev = process.env.MWA_FAST_CHAT; process.env.MWA_FAST_CHAT = '0';
    try { return await fn(dir); } finally { if (prev === undefined) delete process.env.MWA_FAST_CHAT; else process.env.MWA_FAST_CHAT = prev; rmSync(dir, { recursive: true, force: true }); }
  };
  const scripted = (actions: Record<string, unknown>[], onStep?: (i: number) => void) => {
    let i = 0; const prompts: string[] = [];
    return { prompts, brain: { id: 's', model: 's', price: [0, 0] as [number, number], chat: async (input: { system?: string; messages?: { content: string }[] }) => {
      if (!String(input.system ?? '').includes('TRUST BOUNDARY')) return { text: '{}', usage: { input: 1, output: 1 } };
      prompts.push(String(input.messages?.[0]?.content ?? ''));
      onStep?.(i);
      return { text: JSON.stringify(actions[Math.min(i++, actions.length - 1)]), usage: { input: 1, output: 1 } };
    } } };
  };

  it('Stop ends the run at the next step with what it kept, and the tool steps were named on the way', async () => {
    await withDir(async (dir) => {
      const ctl = new AbortController();
      const events: Record<string, unknown>[] = [];
      // step 1 reads, step 2 writes; the person presses Stop while step 2 is running; step 3 never starts
      const s = scripted([{ action: 'read_file', path: 'notes.md' }, { action: 'write_file', path: 'draft.md', content: 'x' }, { action: 'done', summary: 'never' }], (i) => { if (i === 1) ctl.abort(); });
      const r = await runAgent({ instruction: 'Write the brief.', dir, memory: memoryOff as never, brain: s.brain, worker: s.brain, tools: tools(), interactive: true, signal: ctl.signal, budget: { maxSteps: 8, maxWallMs: 30_000 }, onEvent: (type, d) => events.push({ type, ...d }) });
      expect(r.reason).toBe('stopped');
      expect(r.steps).toBe(2);
      expect(r.summary).toMatch(/^Stopped after step 2\. Kept: draft\.md\. Nothing was sent or changed outside this folder\.$/);
      expect(s.prompts).toHaveLength(2);
      expect(events.filter((e) => e.type === 'step').map((e) => [e.n, e.tool, e.detail])).toEqual([[1, 'read_file', 'notes.md'], [2, 'write_file', 'draft.md']]);
      expect(events.some((e) => e.type === 'stopped')).toBe(true);
    });
  }, 30_000);

  it('a message sent during the run reaches the next step as the person\'s own words', async () => {
    await withDir(async (dir) => {
      const inbox: string[] = [];
      const s = scripted([{ action: 'read_file', path: 'notes.md' }, { action: 'done', summary: 'A shorter brief.' }], (i) => { if (i === 0) inbox.push('Keep it under 80 words and mention the regatta.'); });
      const events: string[] = [];
      const r = await runAgent({ instruction: 'Write the brief.', dir, memory: memoryOff as never, brain: s.brain, worker: s.brain, tools: tools(), interactive: true, inbox: () => inbox.splice(0), budget: { maxSteps: 8, maxWallMs: 30_000 }, onEvent: (t) => events.push(t) });
      expect(r.reason).toBe('done');
      expect(s.prompts[1]).toContain('THE PERSON ADDS');
      expect(s.prompts[1]).toContain('Keep it under 80 words and mention the regatta.');
      expect(s.prompts[0]).not.toContain('THE PERSON ADDS');
      expect(r.history.join('\n')).toMatch(/the person added: Keep it under 80 words/);
      expect(events).toContain('steered');
    });
  }, 30_000);
});

describe('the conversation log', () => {
  it('keeps a running turn until its finished turn retires it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mwa-conv-'));
    const path = join(dir, 'conversations.jsonl');
    try {
      appendTurn({ ts: 1, session: 'web-a', message: 'hello', reply: 'hi', kind: 'chat' }, path);
      appendTurn({ ts: 2, session: 'web-a', message: 'write the brief', reply: '', kind: 'running', runId: 'live_1' }, path);
      expect(readConversation('web-a', 60, path).map((t) => t.kind)).toEqual(['chat', 'running']);
      appendTurn({ ts: 3, session: 'web-a', message: 'write the brief', reply: 'Here it is.', kind: 'chat', runId: 'live_1' }, path);
      const turns = readConversation('web-a', 60, path);
      expect(turns.map((t) => t.kind)).toEqual(['chat', 'chat']);
      expect(turns[1].reply).toBe('Here it is.');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
