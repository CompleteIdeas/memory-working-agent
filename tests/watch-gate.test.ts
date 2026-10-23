/**
 * BL-73 — Clef checks a change-only watch's message before it goes out (src/watch-gate.ts). Job bake-off, 2026-10-23:
 * the cheap models reworded the same reading each day ("FINAL (2026-11-06)", "RESULTS: FINAL (dated 2026-11-06)"),
 * or wrote "No change." with no reading and no outcome, and each reached the person as news.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tickScheduler } from '../src/scheduler.js';
import { clefWatchGate, configuredWatchGate, SAME_THRESHOLD, type WatchGate, type WatchGateInput } from '../src/watch-gate.js';

const fire = async (task: Record<string, unknown>, run: Record<string, unknown>, gate: WatchGate | null) => {
  const outRoot = mkdtempSync(join(tmpdir(), 'mwa-bl73-'));
  const fired: { summary: string; outcome?: string; completion?: string }[] = [];
  const asked: WatchGateInput[] = []; const logs: string[] = []; const done: string[] = [];
  const mem = {
    enabled: true,
    async pendingScheduled() { return [task]; }, async completeScheduled(id: string) { done.push(id); }, async rescheduleTask() { /* */ },
    async setJobLastRun() { /* */ }, async setJobFails() { /* */ }, async setPendingComplete() { /* */ },
  };
  const spy: WatchGate | null = gate ? async (i) => { asked.push(i); return gate(i); } : null;
  try {
    await tickScheduler({
      memory: mem as never, brain: {} as never, worker: {} as never, outRoot, now: () => 1_800_000_000_000, checksAllowed: false,
      onFire: async (_t, r) => { fired.push(r); }, onLog: (m) => logs.push(m), watchGate: spy,
      runAgent: (async () => ({ reason: 'done', steps: 2, toolCalls: 1, costUsd: 0, durationMs: 0, ...run })) as never,
    });
  } finally { rmSync(outRoot, { recursive: true, force: true }); }
  return { fired, asked, logs, done };
};

const RIVER = { id: 'river123', instruction: 'Check the Riverbend Fall HT results page', due: 1, recur: 'daily:10:00', deliver: 'changed',
  request: 'Only alert me when results are marked final. No updates otherwise.', until: 'the Riverbend results page marks the results final' };
const SAME: WatchGate = async () => 0.95;
const DIFFERENT: WatchGate = async () => 0.02;

describe('a change-only watch about to speak', () => {
  it('stays quiet when Clef reads it as the same situation in other words (Luna: "No change." with no reading)', async () => {
    const r = await fire({ ...RIVER, lastRun: { at: 1, summary: '', value: 'PROVISIONAL' } }, { summary: 'No change.', outcome: 'changed' }, SAME);
    expect(r.fired).toHaveLength(0);
    expect(r.asked[0]).toMatchObject({ previous: 'PROVISIONAL', message: 'No change.', request: RIVER.request, until: RIVER.until });
    expect(r.logs.some((l) => l.includes('watch gate: the same situation'))).toBe(true);
  });

  it('a reworded reading that is still not what they wait for stays quiet (Haiku: PROVISIONAL → "PROVISIONAL (scores corrected)")', async () => {
    const r = await fire({ ...RIVER, lastRun: { at: 1, summary: '', value: 'PROVISIONAL' } },
      { summary: 'It still says PROVISIONAL; scores were corrected Nov 5.', outcome: 'changed', watchValue: 'PROVISIONAL (scores corrected 2026-11-05)' }, SAME);
    expect(r.fired).toHaveLength(0);
    expect(r.asked[0].reading).toBe('PROVISIONAL (scores corrected 2026-11-05)');
  });

  it('the confirming check stops quietly when the reading only changed its wording (MiniMax, Haiku)', async () => {
    const r = await fire({ ...RIVER, pendingComplete: true, lastRun: { at: 1, summary: '', value: 'FINAL (2026-11-06)' } },
      { summary: 'Results are marked FINAL.', outcome: 'complete', outcomeDeclared: true, watchValue: 'RESULTS: FINAL (dated 2026-11-06)' }, SAME);
    expect(r.done).toEqual(['river123']); // the job still stops
    expect(r.fired).toHaveLength(0);
  });

  it('opening the watched page is not acting: the gate still reads the message (round 2: every page watch skipped it)', async () => {
    const r = await fire({ ...RIVER, lastRun: { at: 1, summary: '', value: 'PROVISIONAL' } }, { summary: 'No update: still PROVISIONAL.', outcome: 'changed', actionsTaken: 1 }, SAME);
    expect(r.asked).toHaveLength(1);
    expect(r.fired).toHaveLength(0);
    const local = await fire({ ...RIVER, lastRun: { at: 1, summary: '', value: 'PROVISIONAL' } }, { summary: 'Saved notes.txt.', outcome: 'changed', actionsTaken: 1, localActions: 1 }, SAME);
    expect(local.asked).toHaveLength(0);
  });

  it('real news is sent', async () => {
    const r = await fire({ ...RIVER, lastRun: { at: 1, summary: '', value: 'PROVISIONAL (scores corrected 2026-11-05)' } },
      { summary: 'Results are now final.', outcome: 'complete', outcomeDeclared: true, watchValue: 'FINAL (2026-11-06)' }, DIFFERENT);
    expect(r.fired).toHaveLength(1);
  });

  it('a "changed" Clef reads as different is sent; no answer, or an answer under the threshold, changes nothing', async () => {
    const task = { ...RIVER, lastRun: { at: 1, summary: '', value: 'PROVISIONAL' } };
    expect((await fire(task, { summary: 'Results are final.', outcome: 'changed' }, DIFFERENT)).fired).toHaveLength(1);
    expect((await fire(task, { summary: 'No change.', outcome: 'changed' }, async () => null)).fired).toHaveLength(1);
    expect((await fire(task, { summary: 'No change.', outcome: 'changed' }, async () => SAME_THRESHOLD - 0.01)).fired).toHaveLength(1);
    expect((await fire(task, { summary: 'No change.', outcome: 'changed' }, null)).fired).toHaveLength(1);
  });

  it('is not asked about a failure, a staged action, a job told to report every time, or a watch with nothing said before', async () => {
    const task = { ...RIVER, lastRun: { at: 1, summary: '', value: 'PROVISIONAL' } };
    const failed = await fire(task, { summary: "I couldn't open the page.", outcome: 'could-not' }, SAME);
    expect(failed.asked).toHaveLength(0); expect(failed.fired).toHaveLength(1);
    const staged = await fire(task, { summary: 'Drafted a note to Carter.', outcome: 'changed', staged: ['d1'] }, SAME);
    expect(staged.asked).toHaveLength(0); expect(staged.fired).toHaveLength(1);
    const brief = await fire({ id: 'brief123', instruction: 'Morning brief', due: 1, recur: 'daily:08:00', lastRun: { at: 1, summary: 'Yesterday’s brief.' } }, { summary: 'Today’s brief.', outcome: 'changed' }, SAME);
    expect(brief.asked).toHaveLength(0); expect(brief.fired).toHaveLength(1);
    const first = await fire({ ...RIVER }, { summary: 'Results are provisional; watching.', outcome: 'changed' }, SAME);
    expect(first.asked).toHaveLength(0);
  });
});

describe('the Clef call', () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  it('asks one question with the request, the condition, what was said last and this check', async () => {
    const bodies: Record<string, unknown>[] = [];
    const gate = clefWatchGate({ token: 't', account: 'acct', fetchImpl: (async (_u: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ success: true, result: { answers: { same: { noul: 0.91 } } } }), { status: 200 });
    }) as never });
    expect(await gate({ request: 'Tell me when final', until: 'final', previous: 'PROVISIONAL', reading: 'PROVISIONAL', message: 'Still provisional.' })).toBe(0.91);
    expect(Object.keys(bodies[0].questions as object)).toEqual(['same']);
    expect(bodies[0].state).toEqual({ request: 'Tell me when final', until: 'final', previous: 'PROVISIONAL', now: 'Reading: PROVISIONAL\nMessage: Still provisional.' });
  });
  it('answers null on an error, a refusal or a malformed reply', async () => {
    for (const res of [new Response('no', { status: 500 }), new Response(JSON.stringify({ success: false }), { status: 200 }), new Response(JSON.stringify({ success: true, result: { answers: {} } }), { status: 200 })]) {
      expect(await clefWatchGate({ token: 't', account: 'a', fetchImpl: (async () => res) as never })({ request: 'r', previous: 'p', message: 'm' })).toBeNull();
    }
    expect(await clefWatchGate({ token: 't', account: 'a', fetchImpl: (async () => { throw new Error('down'); }) as never })({ request: 'r', previous: 'p', message: 'm' })).toBeNull();
  });
  it('is configured by MWA_CLEF_TOKEN and MWA_CLEF_ACCOUNT only, and MWA_WATCH_GATE=off turns it off', () => {
    expect(configuredWatchGate({ CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'a' })).toBeNull();
    expect(configuredWatchGate({ MWA_CLEF_TOKEN: 't', MWA_CLEF_ACCOUNT: 'a' })).toBeTypeOf('function');
    expect(configuredWatchGate({ MWA_CLEF_TOKEN: 't', MWA_CLEF_ACCOUNT: 'a', MWA_WATCH_GATE: 'off' })).toBeNull();
  });
});
