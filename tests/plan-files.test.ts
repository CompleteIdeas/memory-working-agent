/**
 * Pending list 2026-10-26, 3c: a planned task over a folder listed it again in every sub-run (experience pilot:
 * 50–80 list_files calls a question). The files the earlier steps found — the folder listing as they saw it and
 * the files they read — now go to the next step, which is told to go straight to read_file.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent } from '../src/agent.js';
import { MwaMemory } from '../src/awm.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { Provider, ChatInput, ChatResult } from '../src/provider.js';

const prevFast = process.env.MWA_FAST_CHAT;
beforeAll(() => { process.env.MWA_FAST_CHAT = '0'; });
afterAll(() => { if (prevFast === undefined) delete process.env.MWA_FAST_CHAT; else process.env.MWA_FAST_CHAT = prevFast; });

const LISTING = '== your working folder (C:/w) ==\n(empty)\n\n== the person\'s folder C:/notes (read_file takes C:/notes/<name>) ==\nboard-2026-09.md\nboard-2026-10.md\ntreasurer-q3.md';

describe('a planned task over a folder', () => {
  it('hands the next step the listing and the files already read, instead of listing the folder again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mwa-planfiles-'));
    const mem = new MwaMemory('plan-files-test', join(dir, 'm.db'));
    try {
      const reg = new ToolRegistry();
      let listCalls = 0;
      reg.registerAll([
        { def: { name: 'list_files', description: 'l', parameters: { type: 'object', properties: { dir: { type: 'string' }, search: { type: 'string' } } } }, handler: async () => { listCalls++; return LISTING; } },
        { def: { name: 'read_file', description: 'r', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
          handler: async (args) => (String(args.path).endsWith('missing.md') ? '(no such file yet: missing.md — nothing exists there.)' : `# ${String(args.path)}\nnotes`) },
      ]);
      const stepInstructions: string[] = []; // what each sub-run was told, in order
      const stepSystems: string[] = []; // each sub-run's whole system prompt (the fenced carried context is there too)
      let stepCalls = 0;
      const brain: Provider = { id: 'p', model: 'p', price: [0, 0], chat: async (input: ChatInput): Promise<ChatResult> => {
        const sys = String(input.system ?? '');
        if (sys.includes('You are the PLANNER')) return { text: JSON.stringify({ steps: [{ task: 'find the board minutes', done_when: 'files named' }, { task: 'summarise the decisions', done_when: 'summary written' }] }), usage: { input: 1, output: 1 } };
        if (!sys.includes('TRUST BOUNDARY')) return { text: '{}', usage: { input: 1, output: 1 } };
        const m = /INSTRUCTION: ([\s\S]*?)\n(?:Now|The time|Today|It is)/.exec(sys) ?? /INSTRUCTION: ([\s\S]*?)\nFENCE CODE/.exec(sys); // the step's instruction sits in the system prompt
        if (m && (stepInstructions.length === 0 || !stepInstructions[stepInstructions.length - 1].startsWith(m[1].slice(0, 40)))) { stepInstructions.push(m[1]); stepSystems.push(sys); }
        stepCalls++;
        // step 1: list the folder, read two files (one missing), done. step 2: done at once.
        if (stepInstructions.length === 1) {
          if (stepCalls === 1) return { text: JSON.stringify({ action: 'list_files' }), usage: { input: 1, output: 1 } };
          if (stepCalls === 2) return { text: JSON.stringify({ action: 'read_file', path: 'C:/notes/board-2026-10.md' }), usage: { input: 1, output: 1 } };
          if (stepCalls === 3) return { text: JSON.stringify({ action: 'read_file', path: 'C:/notes/missing.md' }), usage: { input: 1, output: 1 } };
          return { text: JSON.stringify({ action: 'done', summary: 'The minutes are board-2026-09.md and board-2026-10.md.', outcome: 'complete' }), usage: { input: 1, output: 1 } };
        }
        return { text: JSON.stringify({ action: 'done', summary: 'Decisions: approve the roof grant application.', outcome: 'complete' }), usage: { input: 1, output: 1 } };
      } };
      const r = await runAgent({ instruction: 'Go through my notes folder, find the board minutes and summarise the decisions', dir, memory: mem, brain, worker: brain, tools: reg,
        interactive: false, plan: true, session: 'web-notes', budget: { maxSteps: 12, maxWallMs: 60_000 } });
      expect(r.reason).toBe('done');
      expect(listCalls).toBe(1); // the folder was listed once, by the first step
      expect(stepInstructions).toHaveLength(2);
      expect(stepInstructions[0]).not.toContain('FILES THE EARLIER STEPS ALREADY FOUND');
      const second = stepInstructions[1];
      expect(second).toContain('FILES THE EARLIER STEPS ALREADY FOUND');
      expect(second).toContain('do not call list_files for the same folders again');
      expect(second).toContain('already read by an earlier step: C:/notes/board-2026-10.md');
      expect(second).not.toContain('missing.md'); // a read that found nothing is not a file found
      // the listing itself travels fenced (file names may have come off the web), not in the instruction
      expect(second).not.toContain('treasurer-q3.md');
      expect(stepSystems[1]).toMatch(/FOLDER LISTING the earlier steps saw \(file names only\): .*board-2026-09\.md board-2026-10\.md treasurer-q3\.md/);
      expect(stepSystems[0]).not.toContain('FOLDER LISTING the earlier steps saw');
    } finally { mem.close(); rmSync(dir, { recursive: true, force: true }); }
  }, 90_000);

  it('a direct run reports what it found, and nothing when it touched no files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mwa-planfiles2-'));
    const mem = new MwaMemory('plan-files-test-2', join(dir, 'm.db'));
    try {
      const reg = new ToolRegistry();
      reg.registerAll([
        { def: { name: 'list_files', description: 'l', parameters: { type: 'object', properties: { search: { type: 'string' } } } }, handler: async (args) => (args.search ? '/x/found.md · 2026-10-26 · 10 bytes' : LISTING) },
      ]);
      let n = 0;
      const brain: Provider = { id: 'p', model: 'p', price: [0, 0], chat: async (input: ChatInput): Promise<ChatResult> => {
        if (!String(input.system ?? '').includes('TRUST BOUNDARY')) return { text: '{}', usage: { input: 1, output: 1 } };
        n++;
        if (n === 1) return { text: JSON.stringify({ action: 'list_files', search: 'found' }), usage: { input: 1, output: 1 } }; // a search is not the folder
        return { text: JSON.stringify({ action: 'done', summary: 'ok', outcome: 'complete' }), usage: { input: 1, output: 1 } };
      } };
      const r = await runAgent({ instruction: 'find my file', dir, memory: mem, brain, worker: brain, tools: reg, interactive: false, plan: false, budget: { maxSteps: 6, maxWallMs: 30_000 } });
      expect(r.filesFound).toBeUndefined();
    } finally { mem.close(); rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);
});
