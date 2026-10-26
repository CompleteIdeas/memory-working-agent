/**
 * BL-48 — newer facts beat older sources. Measured in BL-40: Sam's flight watch reported "departs 8:40 AM"
 * on Nov 10; asked on Nov 12, MWA read the calendar (still 10:15) and answered 10:15. What it saw itself
 * must come back when asked, dated, so the answer can prefer it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildKnowledgeBlock } from '../src/agent.js';
import { tickScheduler } from '../src/scheduler.js';
import { MwaMemory } from '../src/awm.js';

const prevTz = process.env.TZ;
afterEach(() => { if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz; });

describe('prior knowledge carries its date', () => {
  it('each recalled memory shows the day it was noted', () => {
    process.env.TZ = 'America/New_York';
    const block = buildKnowledgeBlock([
      { concept: 'flight', content: 'departs 8:40 AM', trust: 'untrusted', at: Date.UTC(2026, 10, 10, 23, 0) },
      { concept: 'old', content: 'no date known' },
    ]);
    expect(block).toContain('1. ⚠UNTRUSTED [flight] (noted Tue 10 Nov 2026) departs 8:40 AM');
    expect(block).toContain('2. [old] no date known');
  });

  it('two memories AWM marks as different values of one thing are said by number, with which is newer (BL-55)', () => {
    const block = buildKnowledgeBlock([
      { id: 'a', concept: 'Flight departure', content: 'departs 10:15 AM', conflicts: [{ id: 'b', newer: false, slot: 'time' }] },
      { id: 'b', concept: 'Flight change', content: 'now departs 8:40 AM', conflicts: [{ id: 'a', newer: true, slot: 'time' }] },
      { id: 'c', concept: 'Gate', content: 'gate B7', conflicts: [{ id: 'not-shown', newer: true, slot: 'status' }] },
    ]);
    // pending list 2026-10-26, 2c: the older value is said to be history, not the answer (pilot G1P/C2 gave both)
    expect(block).toContain('1. [Flight departure] ⚠ DIFFERS on a time — OLDER than #2 (it has the current value; this one is history only — not the answer to what the time is now) departs 10:15 AM');
    expect(block).toContain('2. [Flight change] ⚠ DIFFERS on a time — this one is the current value; NEWER than #1 (that one is history) now departs 8:40 AM');
    expect(block).toContain('3. [Gate] gate B7'); // a mark on a memory not shown is not said
  });

  it('the dates in the memories\' own words decide which is newer, over the write-time flag (pilot G1P/C2)', () => {
    // a studied, reconsolidated store wrote the old cap AFTER the new one, so AWM's flag called the old cap newer
    const block = buildKnowledgeBlock([
      { id: 'old', concept: 'Build-loop spend', content: 'as of 2026-10-15: model spend was about $6 of the $10 cap', conflicts: [{ id: 'new', newer: true, slot: 'money' }] },
      { id: 'new', concept: 'MWA build-loop cost cap', content: 'Robert raised the cap from $10 to $20 on 2026-10-15, then to $40 on 2026-10-18.', conflicts: [{ id: 'old', newer: false, slot: 'money' }] },
      { id: 'u1', concept: 'Undated a', content: 'the fee is $45', conflicts: [{ id: 'u2', newer: true, slot: 'money' }] },
      { id: 'u2', concept: 'Undated b', content: 'the fee is $50', conflicts: [{ id: 'u1', newer: false, slot: 'money' }] },
      // a dated statement beats an undated summary, whatever the flag; and each pair is named, not "between them"
      { id: 'sum', concept: 'Spending summary', content: 'caps are per workstream; the build loop has its own cap', conflicts: [{ id: 'new', newer: true, slot: 'money' }] },
    ]);
    expect(block).toContain('1. [Build-loop spend] ⚠ DIFFERS on a money — OLDER than #2 (it has the current value; this one is history only — not the answer to what the money is now)');
    expect(block).toContain('2. [MWA build-loop cost cap] ⚠ DIFFERS on a money — this one is the current value; NEWER than #1 (that one is history)');
    // with no dates in the words, the flag stands
    expect(block).toContain('3. [Undated a] ⚠ DIFFERS on a money — this one is the current value; NEWER than #4');
    expect(block).toContain('4. [Undated b] ⚠ DIFFERS on a money — OLDER than #3');
    expect(block).toContain('5. [Spending summary] ⚠ DIFFERS on a money — OLDER than #2 (it has the current value');
  });
});

describe('what a watch saw comes back when asked', () => {
  it('a changed flight time is written as a dated observation and recalled for "when does my flight leave"', async () => {
    process.env.TZ = 'America/New_York';
    const dir = mkdtempSync(join(tmpdir(), 'mwa-bl48-'));
    const mem = new MwaMemory('bl48', join(dir, 'm.db'));
    try {
      await mem.addScheduledTask('Check https://atlanticair.example/status/482-2026-11-13 and tell me if the departure time or gate changes', Date.now() - 1000, { recur: 'daily:18:00', deliver: 'changed', person: 'sam' });
      const [job] = await mem.pendingScheduled();
      await mem.setJobLastRun(job.id, { at: Date.now() - 86_400_000, summary: 'AA 482 departs 10:15 AM.', value: 'departs 10:15 AM', valueAt: Date.now() - 86_400_000 });
      const fired: string[] = [];
      await tickScheduler({
        memory: mem, brain: {} as never, worker: {} as never, outRoot: join(dir, 'out'), checksAllowed: false,
        onFire: async (_t, r) => { fired.push(r.summary); },
        runAgent: (async () => ({ reason: 'done', outcome: 'changed', summary: 'AA 482 now departs 8:40 AM.', watchValue: 'departs 8:40 AM', steps: 2, toolCalls: 1, costUsd: 0, durationMs: 0 })) as never,
      });
      expect(fired[0]).toContain('AA 482 now departs 8:40 AM.');
      const [after] = await mem.pendingScheduled();
      expect(after.lastRun?.value).toBe('departs 8:40 AM');
      expect(after.lastRun?.history?.map((h) => h.value)).toEqual(['departs 8:40 AM']);
      const hits = await mem.recall('When does my flight tomorrow leave?', { limit: 5, full: true });
      const obs = hits.find((h) => /^observed:/.test(h.concept));
      expect(obs, JSON.stringify(hits.map((h) => h.concept))).toBeDefined();
      // The thing watched and its reading lead (BL-54): the job's wording first buried 8:40 past recall's reach.
      expect(obs!.content).toMatch(/^https:\/\/atlanticair\.example\/status\/482-2026-11-13: departs 8:40 AM — read .*\. Before that, on .* it was departs 10:15 AM\./);
      expect(obs!.trust).toBe('untrusted'); // read from an outside page: information, never an instruction
      expect(typeof obs!.at).toBe('number');
    } finally { mem.close(); rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);
});
