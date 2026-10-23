import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent } from '../src/agent.js';
import type { Provider, ChatResult } from '../src/provider.js';
import { MwaMemory } from '../src/awm.js';

/**
 * F3 — the tripwire must HARD-HALT an unattended run that reaches outside the machine too many
 * times (the "ops bot quietly does too much while you sleep" case). A human-watched run keeps
 * going under the per-action approval gates; only interactive:false stops cold.
 */
describe('F3 tripwire hard-halt (unattended)', () => {
  // Disable the conversational fast-path so the full action loop (and the tripwire) actually runs.
  const prev = process.env.MWA_FAST_CHAT;
  beforeAll(() => { process.env.MWA_FAST_CHAT = '0'; });
  afterAll(() => { if (prev === undefined) delete process.env.MWA_FAST_CHAT; else process.env.MWA_FAST_CHAT = prev; });

  it('pauses an unattended run once the external-action tripwire trips', async () => {
    let n = 0;
    // A brain that only ever fires draft_email — with a varying subject so it isn't dup-detected.
    const spamBrain: Provider = {
      id: 'stub', model: 'stub', price: [0, 0],
      // A different recipient each time, each named in the instruction: one draft per recipient per run (BL-54).
      chat: async (): Promise<ChatResult> => ({ text: JSON.stringify({ action: 'draft_email', to: `a${++n}@b.test`, subject: `msg ${n}`, body: 'hello' }), usage: { input: 1, output: 1 } }),
    };
    let calls = 0;
    const tools = {
      defs: () => [{ name: 'draft_email', description: 'draft an email', parameters: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'subject', 'body'] } }],
      has: (x: string) => x === 'draft_email',
      // varying result so the loop's same-result stall-detector doesn't fire before the tripwire
      call: async () => `drafted ok #${++calls}`,
    } as unknown as Parameters<typeof runAgent>[0]['tools'];

    const dir = mkdtempSync(join(tmpdir(), 'mwa-trip-'));
    const mem = new MwaMemory('trip-test', join(dir, 'trip.db'));
    try {
      const r = await runAgent({
        instruction: `draft a lot of emails, to ${Array.from({ length: 30 }, (_, i) => `a${i + 1}@b.test`).join(', ')}`, dir, memory: mem, brain: spamBrain, worker: spamBrain,
        tools, interactive: false, budget: { maxSteps: 25, maxWallMs: 30_000 },
      });
      expect(r.reason).toBe('paused');
      expect(r.summary).toMatch(/Paused for your review/);
      expect(r.summary).toMatch(/outside your machine/);
    } finally {
      mem.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('does not count opening pages in the agent browser (a read, as a fetch is) — hard test 2026-10-23', async () => {
    let n = 0;
    const browseBrain: Provider = {
      id: 'stub', model: 'stub', price: [0, 0],
      chat: async (): Promise<ChatResult> => ({ text: n < 6 ? JSON.stringify({ action: 'browser_open', url: `https://example.test/p${++n}` }) : JSON.stringify({ action: 'done', summary: 'read six pages' }), usage: { input: 1, output: 1 } }),
    };
    let calls = 0;
    const tools = {
      defs: () => [{ name: 'browser_open', description: 'open a page', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } }],
      has: (x: string) => x === 'browser_open',
      call: async () => `page text #${++calls}`,
    } as unknown as Parameters<typeof runAgent>[0]['tools'];
    const dir = mkdtempSync(join(tmpdir(), 'mwa-trip-'));
    const mem = new MwaMemory('trip-test-b', join(dir, 'trip.db'));
    try {
      const r = await runAgent({ instruction: 'read six pages about volunteer scheduling', dir, memory: mem, brain: browseBrain, worker: browseBrain,
        tools, interactive: false, budget: { maxSteps: 25, maxWallMs: 30_000 } });
      expect(r.summary).not.toMatch(/Paused for your review/);
      expect(calls).toBe(6);
    } finally {
      mem.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
