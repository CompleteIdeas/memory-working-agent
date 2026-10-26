// v2 slice A3a: one piece of work is one Job, however many runs it takes. A background hand-off that runs out of room
// twice (two automatic resumes) and is then continued by the person is ONE Job with FOUR Tries — and while a resume
// is queued its status is "continuing", never failed (SR-F02); after the last resume it is "partly done" with a
// Continue (SR-F05); the finished run makes it "result ready" until opened (SR-F03). Real agent loop, real memory
// store, real scheduler; only the model is scripted.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MwaMemory } from '../src/awm.js';
import { tickScheduler } from '../src/scheduler.js';
import { startBackgroundWork, continueGoal } from '../src/handoff.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { resetAppDb } from '../src/v2/db.js';
import { getJob, listJobs, triesOf, viewJob, updateJob } from '../src/v2/jobs.js';
import type { Provider, ChatInput, ChatResult } from '../src/provider.js';

const env = { fast: process.env.MWA_FAST_CHAT, steps: process.env.MWA_GOAL_JOB_STEPS, plan: process.env.MWA_PLAN };
beforeAll(() => { process.env.MWA_FAST_CHAT = '0'; process.env.MWA_GOAL_JOB_STEPS = '3'; process.env.MWA_PLAN = 'off'; });
afterAll(() => {
  for (const [k, v] of [['MWA_FAST_CHAT', env.fast], ['MWA_GOAL_JOB_STEPS', env.steps], ['MWA_PLAN', env.plan]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

let asked = 0;
describe('job and try lineage', () => {
  it('two automatic resumes plus one Continue = one Job with four Tries', async () => {
    resetAppDb(':memory:');
    const dir = mkdtempSync(join(tmpdir(), 'mwa-lineage-'));
    const mem = new MwaMemory('lineage-test', join(dir, 'm.db'));
    try {
      let finish = false; // the scripted model reads pages until told it may finish
      let pages = 0;
      const reg = new ToolRegistry();
      reg.registerAll([{ def: { name: 'portal__fetch', description: 'read a page', parameters: { type: 'object', properties: { page: { type: 'number' } } } }, handler: async () => `page ${++pages} of the rules` }]);
      const brain: Provider = { id: 'p', model: 'p', price: [0, 0], chat: async (input: ChatInput): Promise<ChatResult> => {
        const sys = String(input.system ?? '');
        if (!sys.includes('TRUST BOUNDARY')) return { text: 'Read the rules.', usage: { input: 1, output: 1 } };
        if (finish) return { text: JSON.stringify({ action: 'done', summary: 'I read all 12 pages and wrote the notes.', outcome: 'changed', progress: { done: 12, total: 12, unit: 'pages' } }), usage: { input: 1, output: 1 } };
        return { text: JSON.stringify({ action: 'portal__fetch', page: ++asked }), usage: { input: 1, output: 1 } };
      } };
      const started = await startBackgroundWork(mem, { message: 'Research the eventing rules and write me study notes with page numbers.', session: 'web-rules', personId: 'p1', workspace: dir });
      expect(started?.v2JobId).toMatch(/^j_/);
      const jobId = started!.v2JobId!;
      const status = () => viewJob(getJob(jobId)!, { running: new Set(), pending: new Set(), now: Date.now() + 10 * 60 * 60_000 }).status;
      expect(status().state).toBe('working'); // handed over, due now: "Starting now"

      let clock = Date.now();
      const tick = async () => {
        clock += 5 * 60_000; // past the 60 s resume delay
        return tickScheduler({ memory: mem, brain, worker: brain, tools: reg, outRoot: join(dir, 'scheduled'), now: () => clock, checksAllowed: false, watchGate: null, maxSteps: 3,
          budgetHold: () => ({ held: false, usedUsd: 0, budgetUsd: null }), onFire: async () => { /* */ } });
      };
      const seen: string[] = [];
      expect(await tick()).toBe(1); seen.push(status().state); // first run: out of room, resume 1 queued
      expect(await tick()).toBe(1); seen.push(status().state); // resume 1: out of room, resume 2 queued
      expect(await tick()).toBe(1); seen.push(status().state); // resume 2: out of room, no resumes left
      expect(seen).toEqual(['continuing', 'continuing', 'partly_done']);
      expect(status().primaryAction?.action).toBe('continue');

      // The person's Continue: a Try of the SAME Job.
      const c = await continueGoal(mem, { goalId: started!.goalId, personId: 'p1', workspace: dir });
      expect(c?.v2JobId).toBe(jobId);
      expect(status().state).toBe('working');
      finish = true;
      expect(await tick()).toBe(1);
      const st = status();
      expect(st).toMatchObject({ state: 'done', label: 'Result ready', resultReady: true });

      const tries = triesOf(jobId);
      expect(tries.map((t) => [t.n, t.trigger, t.state, t.reason])).toEqual([
        [1, 'first', 'ended', 'budget'], [2, 'auto-continue', 'ended', 'budget'], [3, 'auto-continue', 'ended', 'budget'], [4, 'continue', 'ended', 'done'],
      ]);
      expect(tries.slice(0, 3).every((t) => t.cap_hit === 'steps' && (t.tool_calls ?? 0) > 0)).toBe(true);
      expect(tries[3]).toMatchObject({ progress_done: 12, progress_total: 12, progress_unit: 'pages', outcome: 'changed' });
      expect(new Set(tries.map((t) => t.schedule_id)).size).toBe(4); // four scheduled tasks, one Job
      expect(listJobs().map((j) => j.id)).toEqual([jobId]); // no unlinked job for any resume
      expect(getJob(jobId)).toMatchObject({ kind: 'background', legacy_goal_id: started!.goalId, session: 'web-rules' });
      updateJob(jobId, { seen_at: Date.now() + 10 * 60 * 60_000 });
      expect(status()).toMatchObject({ state: 'done', label: 'Done', resultReady: false });
    } finally { mem.close(); rmSync(dir, { recursive: true, force: true }); }
  }, 120_000);

  it('a chat run that runs out of room becomes a Job of kind live: the chat is its first Try, the resume its second', async () => {
    resetAppDb(':memory:');
    const dir = mkdtempSync(join(tmpdir(), 'mwa-lineage-chat-'));
    const mem = new MwaMemory('lineage-chat', join(dir, 'm.db'));
    try {
      const { runAgent } = await import('../src/agent.js');
      const reg = new ToolRegistry();
      reg.registerAll([{ def: { name: 'portal__fetch', description: 'read a page', parameters: { type: 'object', properties: { page: { type: 'number' } } } }, handler: async () => 'a page' }]);
      const brain: Provider = { id: 'p', model: 'p', price: [0, 0], chat: async (input: ChatInput): Promise<ChatResult> =>
        String(input.system ?? '').includes('TRUST BOUNDARY') ? { text: JSON.stringify({ action: 'portal__fetch', page: ++asked }), usage: { input: 1, output: 1 } } : { text: 'Partial notes.', usage: { input: 1, output: 1 } } };
      // An ordinary quick answer is not a job.
      const quick: Provider = { id: 'q', model: 'q', price: [0, 0], chat: async () => ({ text: JSON.stringify({ action: 'done', summary: 'Four.', outcome: 'changed' }), usage: { input: 1, output: 1 } }) };
      await runAgent({ instruction: 'What is 2+2?', userMessage: 'What is 2+2?', dir, memory: mem, brain: quick, worker: quick, interactive: true, session: 'web-quick', plan: false, intent: null, budget: { maxSteps: 4, maxWallMs: 60_000 } });
      expect(listJobs()).toHaveLength(0);

      const r = await runAgent({ instruction: 'Read every page of the rules site and summarise it', userMessage: 'Read every page of the rules site and summarise it', dir, memory: mem, brain, worker: brain, tools: reg,
        interactive: true, session: 'web-chat', personId: 'p1', plan: false, intent: null, budget: { maxSteps: 3, maxWallMs: 60_000 } });
      expect(r).toMatchObject({ reason: 'budget', resumeQueued: true, capHit: 'steps' });
      expect(r.v2JobId).toMatch(/^j_/);
      const job = getJob(r.v2JobId!)!;
      expect(job).toMatchObject({ kind: 'live', session: 'web-chat', person: 'p1' });
      const tries = triesOf(job.id);
      expect(tries.map((t) => [t.n, t.trigger, t.state, t.reason])).toEqual([[1, 'first', 'ended', 'budget'], [2, 'auto-continue', 'queued', null]]);
      expect(tries[1].schedule_id).toBe((await mem.pendingScheduled()).find((t) => t.resumeAttempt === 1)!.id);
      expect(viewJob(job, { running: new Set(), pending: new Set(), now: Date.now() }).status.state).toBe('continuing');
    } finally { mem.close(); rmSync(dir, { recursive: true, force: true }); }
  }, 120_000);
});
